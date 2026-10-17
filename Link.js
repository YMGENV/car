/**
 * Link.js — two-device mode. The PLAYER phone runs the camera + pose tracking and streams its (slimmed-down)
 * poseData to the VIEWER, which runs the simulator. Transport is a WebRTC data channel set up with PeerJS
 * (the free PeerJS cloud server is only used to introduce the two devices; pose data goes device-to-device).
 *
 * Pairing: the Viewer opens a short code (e.g. K7M2Q); the Player types it in (or opens ?join=K7M2Q).
 *
 * Messages (JSON):
 *   Player → Viewer   { t: 'pose', p: slimPose }
 *                     { t: 'calib', n?: 3|2|1, hold?: true, progress?: 0..1, end?: true, ok?: bool, reason?: string }
 *   Viewer → Player   { t: 'cmd', c: 'calibrate' }
 *
 * The Peer constructor is injected so the logic can be unit-tested without a browser.
 */

export const PEER_PREFIX = 'bodydrive-';
export const CODE_LEN = 5;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I so codes are easy to read out and type

export class LinkError extends Error {
  constructor(code, message) { super(message); this.name = 'LinkError'; this.code = code; }
}

export function makeCode(len = CODE_LEN, rand = Math.random) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

/** Upper-case and drop anything that can't appear in a code (spaces, dashes, 0/O/1/I...). */
export function normalizeCode(input) {
  return [...String(input ?? '').toUpperCase()].filter((c) => ALPHABET.includes(c)).join('').slice(0, CODE_LEN);
}

export function joinUrl(code, loc = globalThis.location) {
  return `${loc.origin}${loc.pathname}?join=${code}`;
}

/** Only what the Viewer needs (steering, pedals, hints, debug panel) — about 1 KB instead of ~10 KB per frame. */
export function slimPose(p) {
  if (!p) return null;
  const g = p.gestures ?? {}, h = g.hands ?? {}, ped = g.pedalState ?? {};
  return {
    valid: !!p.valid, calibrated: !!p.calibrated, fps: p.fps ?? 0,
    quality: { upperBody: !!p.quality?.upperBody, lowerBody: !!p.quality?.lowerBody, rightLeg: !!p.quality?.rightLeg },
    angles: { leftKnee: p.angles?.leftKnee ?? null, rightKnee: p.angles?.rightKnee ?? null },
    gestures: {
      handsPosition: g.handsPosition ?? 'lost',
      hands: { state: h.state ?? 'lost', visible: !!h.visible, wheelAngleDeg: h.wheelAngleDeg ?? 0, lateral: h.lateral ?? 0, separation: h.separation ?? 0 },
      pedalState: {
        accelerator: ped.accelerator ?? 0, brake: ped.brake ?? 0, clutch: ped.clutch ?? 0,
        rightFootZone: ped.rightFootZone ?? 'accelerator',
      },
    },
  };
}

const PEER_OPTIONS = { debug: 1 };

// ───────────────────────────── Viewer (hosts the code, receives poses) ─────────────────────────────
export class ViewerLink {
  constructor({ Peer, onStatus, onPose, onMessage, peerOptions = PEER_OPTIONS, openTimeoutMs = 12000 } = {}) {
    Object.assign(this, { Peer, onStatus, onPose, onMessage, peerOptions, openTimeoutMs });
    this.peer = null; this.conn = null; this.code = null; this.state = 'idle'; this.closed = false;
  }

  _set(state, extra = {}) { this.state = state; this.onStatus?.({ state, code: this.code, ...extra }); }

  get connected() { return !!this.conn?.open; }

  /** Opens a fresh code. Resolves with it once the pairing server has registered us. */
  open() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const attempt = () => {
        attempts++;
        this.code = makeCode();
        const peer = this.peer = new this.Peer(PEER_PREFIX + this.code, this.peerOptions);
        let opened = false;
        const timer = setTimeout(() => {
          if (opened) return;
          peer.destroy?.();
          reject(new LinkError('timeout', 'Could not reach the pairing server. Check your internet connection and try again.'));
        }, this.openTimeoutMs);
        peer.on('open', () => { opened = true; clearTimeout(timer); this._set('waiting'); resolve(this.code); });
        peer.on('connection', (c) => this._accept(c));
        peer.on('disconnected', () => { if (opened && !this.closed) { try { peer.reconnect(); } catch { /* retried on next event */ } } });
        peer.on('error', (e) => {
          if (!opened) {
            clearTimeout(timer);
            peer.destroy?.();
            if (e?.type === 'unavailable-id' && attempts < 5) return attempt();      // code collision: pick another
            return reject(new LinkError('server', 'Could not reach the pairing server. Check your internet connection and try again.'));
          }
          this.onStatus?.({ state: this.state, code: this.code, warning: e?.type ?? 'error' });
        });
      };
      attempt();
    });
  }

  _accept(conn) {
    if (this.conn && this.conn !== conn) { const old = this.conn; this.conn = null; try { old.close(); } catch { /* already closed */ } }
    this.conn = conn;
    const live = () => this.conn === conn;
    const up = () => { if (live()) this._set('connected'); };
    conn.on('open', up);
    if (conn.open) up();
    conn.on('data', (d) => {
      if (!live() || !d || typeof d !== 'object') return;
      if (d.t === 'pose') this.onPose?.(d.p); else this.onMessage?.(d);
    });
    const lost = () => { if (live()) { this.conn = null; this._set('waiting', { lost: true }); } };
    conn.on('close', lost);
    conn.on('error', lost);
  }

  send(msg) { if (!this.conn?.open) return false; this.conn.send(msg); return true; }

  close() {
    this.closed = true;
    try { this.conn?.close(); } catch { /* ignore */ }
    try { this.peer?.destroy(); } catch { /* ignore */ }
    this.conn = null; this.peer = null; this.state = 'idle';
  }
}

// ───────────────────────────── Player (dials the code, sends poses) ─────────────────────────────
export class PlayerLink {
  constructor({ Peer, code, onStatus, onMessage, peerOptions = PEER_OPTIONS, connectTimeoutMs = 15000, retryMs = 1500 } = {}) {
    Object.assign(this, { Peer, code, onStatus, onMessage, peerOptions, connectTimeoutMs, retryMs });
    this.peer = null; this.conn = null; this.state = 'idle'; this.closed = false; this._retry = null;
  }

  _set(state, extra = {}) { this.state = state; this.onStatus?.({ state, code: this.code, ...extra }); }

  get connected() { return !!this.conn?.open; }

  _explain(e) {
    switch (e?.type) {
      case 'peer-unavailable': return new LinkError('no-viewer', `No viewer found with code ${this.code}. Open the Viewer first and check the code.`);
      case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
        return new LinkError('server', 'Could not reach the pairing server. Check your internet connection and try again.');
      case 'webrtc': return new LinkError('webrtc', 'A direct connection to the viewer could not be made. Put both devices on the same Wi-Fi and retry.');
      default: return new LinkError('unknown', `Connection problem: ${e?.message ?? e?.type ?? e}`);
    }
  }

  /** Resolves once the data channel to the viewer is open; rejects with a LinkError otherwise. */
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (err) { this.close(); reject(err); } else resolve();
      };
      const timer = setTimeout(() => done(new LinkError('timeout', `Could not connect to viewer ${this.code} in time. Make sure the Viewer is open and both devices are online.`)), this.connectTimeoutMs);
      const peer = this.peer = new this.Peer(undefined, this.peerOptions);
      peer.on('open', () => this._dial(() => done()));
      peer.on('disconnected', () => { if (!this.closed) { try { peer.reconnect(); } catch { /* retried later */ } } });
      peer.on('error', (e) => {
        if (!settled) return done(this._explain(e));
        if (e?.type === 'peer-unavailable') { this.conn = null; this._set('disconnected'); this._scheduleRetry(); }
      });
    });
  }

  _dial(onOpen) {
    if (this.closed || !this.peer) return;
    const conn = this.conn = this.peer.connect(PEER_PREFIX + this.code, { serialization: 'json', reliable: true });
    const up = () => { if (this.conn === conn) { this._set('connected'); onOpen?.(); } };
    conn.on('open', up);
    if (conn.open) up();
    conn.on('data', (d) => { if (this.conn === conn && d && typeof d === 'object') this.onMessage?.(d); });
    const lost = () => {
      if (this.conn !== conn || this.closed) return;
      this.conn = null; this._set('disconnected'); this._scheduleRetry();
    };
    conn.on('close', lost);
    conn.on('error', lost);
  }

  _scheduleRetry() {
    clearTimeout(this._retry);
    this._retry = setTimeout(() => { if (!this.closed && this.peer && !this.peer.destroyed) this._dial(); }, this.retryMs);
  }

  /** Streams one pose. Drops the frame when the channel is backed up so latency never builds. */
  sendPose(p) {
    const c = this.conn;
    if (!c?.open) return false;
    if ((c.dataChannel?.bufferedAmount ?? 0) > 65536) return false;
    c.send({ t: 'pose', p: slimPose(p) });
    return true;
  }

  send(msg) { if (!this.conn?.open) return false; this.conn.send(msg); return true; }

  close() {
    this.closed = true;
    clearTimeout(this._retry);
    try { this.conn?.close(); } catch { /* ignore */ }
    try { this.peer?.destroy(); } catch { /* ignore */ }
    this.conn = null; this.peer = null; this.state = 'idle';
  }
}
