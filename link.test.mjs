import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewerLink, PlayerLink, LinkError, makeCode, normalizeCode, slimPose, CODE_LEN, PEER_PREFIX } from './Link.js';
import { BodyTracker } from './BodyTracker.js';
import { InputMapper } from './Controls.js';
import { makeSkeleton } from './skeleton.mjs';

// ── in-memory stand-in for PeerJS ──
class Ev {
  constructor() { this.h = {}; }
  on(e, f) { (this.h[e] ??= []).push(f); return this; }
  emit(e, ...a) { for (const f of this.h[e] ?? []) f(...a); }
}
function makeNet() {
  const peers = new Map();
  class Conn extends Ev {
    constructor() { super(); this.open = false; this.other = null; this.sent = []; this.dataChannel = { bufferedAmount: 0 }; }
    send(m) { this.sent.push(m); const o = this.other; queueMicrotask(() => o?.emit('data', JSON.parse(JSON.stringify(m)))); }
    close() { if (!this.open) return; this.open = false; const o = this.other; this.other = null; queueMicrotask(() => { this.emit('close'); if (o) { o.open = false; o.other = null; o.emit('close'); } }); }
  }
  class Peer extends Ev {
    constructor(id) {
      super(); this.destroyed = false;
      this.id = id ?? 'anon-' + Math.random().toString(36).slice(2);
      queueMicrotask(() => {
        if (peers.has(this.id)) return this.emit('error', { type: 'unavailable-id' });
        peers.set(this.id, this); this.emit('open', this.id);
      });
    }
    connect(id) {
      const a = new Conn();
      queueMicrotask(() => {
        const target = peers.get(id);
        if (!target) return this.emit('error', { type: 'peer-unavailable' });
        const b = new Conn(); a.other = b; b.other = a;
        target.emit('connection', b);
        a.open = b.open = true; b.emit('open'); a.emit('open');
      });
      return a;
    }
    destroy() { this.destroyed = true; if (peers.get(this.id) === this) peers.delete(this.id); }
  }
  return { Peer, peers };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('codes: right length/alphabet, normalize strips junk and shortens', () => {
  const c = makeCode();
  assert.equal(c.length, CODE_LEN);
  assert.match(c, /^[A-HJ-NP-Z2-9]+$/);
  assert.equal(normalizeCode(' k7-m2q99 '), 'K7M2Q');
  assert.equal(normalizeCode('o0i1'), '');
  assert.equal(normalizeCode(null), '');
});

test('slimPose is small and the Viewer drives the car exactly like the full pose would', () => {
  const t = new BodyTracker({ camera: null, estimator: null });
  const s = makeSkeleton({ handsTiltDeg: 20, rightKneeFlex: 25, leftKneeFlex: 15 });
  const full = t.processFrame(s.landmarks, s.worldLandmarks, 1000, s.aspect);
  const slim = slimPose(full);
  assert.ok(JSON.stringify(slim).length < 1200, `slim pose is ${JSON.stringify(slim).length} bytes`);
  assert.ok(JSON.stringify(full).length > 4 * JSON.stringify(slim).length);
  const targets = (p) => { const m = new InputMapper(); m.setPose(p); return m._bodyTargets(); };
  assert.deepEqual(targets(JSON.parse(JSON.stringify(slim))), targets(full));
  assert.equal(slimPose(null), null);
});

test('pairing: player connects with the code, poses and commands flow both ways', async () => {
  const { Peer } = makeNet();
  const got = [], viewerMsgs = [], playerMsgs = [], vs = [], ps = [];
  const viewer = new ViewerLink({ Peer, onStatus: (s) => vs.push(s.state), onPose: (p) => got.push(p), onMessage: (m) => viewerMsgs.push(m) });
  const code = await viewer.open();
  assert.equal(vs.at(-1), 'waiting');
  const player = new PlayerLink({ Peer, code, onStatus: (s) => ps.push(s.state), onMessage: (m) => playerMsgs.push(m) });
  await player.connect();
  await tick();
  assert.equal(viewer.state, 'connected'); assert.equal(player.state, 'connected');

  const t = new BodyTracker({ camera: null, estimator: null });
  const s = makeSkeleton({ rightKneeFlex: 30 });
  assert.equal(player.sendPose(t.processFrame(s.landmarks, s.worldLandmarks, 1000, s.aspect)), true);
  player.send({ t: 'calib', n: 3 });
  viewer.send({ t: 'cmd', c: 'calibrate' });
  await tick();
  assert.equal(got.length, 1); assert.equal(got[0].valid, true); assert.ok(got[0].gestures.pedalState.accelerator > 0.5);
  assert.deepEqual(viewerMsgs, [{ t: 'calib', n: 3 }]);
  assert.deepEqual(playerMsgs, [{ t: 'cmd', c: 'calibrate' }]);

  // backed-up channel → frame dropped, not queued
  player.conn.dataChannel.bufferedAmount = 1e6;
  assert.equal(player.sendPose({ valid: false }), false);
});

test('wrong code → friendly LinkError, nothing left open', async () => {
  const { Peer, peers } = makeNet();
  const player = new PlayerLink({ Peer, code: 'ZZZZZ' });
  await assert.rejects(player.connect(), (e) => e instanceof LinkError && e.code === 'no-viewer' && /ZZZZZ/.test(e.message));
  assert.equal(peers.size, 0);
});

test('timeout when the viewer never answers', async () => {
  class Silent extends Ev { constructor() { super(); } connect() { return new Ev(); } destroy() {} }
  const p = new PlayerLink({ Peer: Silent, code: 'ABCDE', connectTimeoutMs: 30 });
  const peerInstance = () => p.peer;
  const pr = p.connect();
  peerInstance().emit('open');
  await assert.rejects(pr, (e) => e.code === 'timeout');
});

test('code collision on the pairing server → viewer picks another code', async () => {
  const { Peer, peers } = makeNet();
  const first = new ViewerLink({ Peer });
  const c1 = await first.open();
  // force the second viewer's first guess to collide
  const orig = Math.random; let n = 0;
  const seq = [...c1].map((ch) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.indexOf(ch) / 32 + 0.001);
  Math.random = () => (n < CODE_LEN ? seq[n++] : orig());
  const second = new ViewerLink({ Peer });
  const c2 = await second.open();
  Math.random = orig;
  assert.notEqual(c1, c2);
  assert.ok(peers.has(PEER_PREFIX + c1) && peers.has(PEER_PREFIX + c2));
});

test('a second player replaces the first; dropping the player puts the viewer back to waiting', async () => {
  const { Peer } = makeNet();
  const vs = [];
  const viewer = new ViewerLink({ Peer, onStatus: (s) => vs.push(s.state) });
  const code = await viewer.open();
  const p1 = new PlayerLink({ Peer, code }); await p1.connect();
  const p2 = new PlayerLink({ Peer, code }); await p2.connect(); await tick();
  assert.equal(viewer.state, 'connected');
  assert.equal(viewer.connected, true);
  p2.close(); await tick();
  assert.equal(viewer.state, 'waiting');
  assert.equal(viewer.connected, false);
});

test('player auto-reconnects when the viewer connection drops', async () => {
  const { Peer } = makeNet();
  const viewer = new ViewerLink({ Peer });
  const code = await viewer.open();
  const ps = [];
  const player = new PlayerLink({ Peer, code, retryMs: 10, onStatus: (s) => ps.push(s.state) });
  await player.connect(); await tick();
  viewer.conn.close();                       // viewer-side drop
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(ps.includes('disconnected'));
  assert.equal(ps.at(-1), 'connected');
  assert.equal(viewer.state, 'connected');
});

test('controls: short tracking dropouts are ridden through, long ones are not; left leg is not needed', async () => {
  const t = new BodyTracker({ camera: null, estimator: null });
  const s = makeSkeleton({ rightKneeFlex: 30, hidden: [25, 27, 31] });
  const full = t.processFrame(s.landmarks, s.worldLandmarks, 1000, s.aspect);
  const m = new InputMapper();
  m.setPose(slimPose(full));
  const live = m._bodyTargets();
  assert.ok(live.throttle > 0.5 && live.feet, 'throttle with left leg hidden');
  m.setPose({ ...slimPose(full), valid: false });
  assert.equal(m._bodyTargets().throttle, live.throttle, 'held during a blip');
  m._lastBodyAt -= 400;
  assert.equal(m._bodyTargets(), null, 'dropped after the hold window');
});
