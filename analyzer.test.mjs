import test from 'node:test';
import assert from 'node:assert/strict';
import { BodyTracker, PoseAnalyzer, LM } from './BodyTracker.js';
import { makeSkeleton } from './skeleton.mjs';

const analyze = (opts, analyzer = new PoseAnalyzer()) => analyzer.analyze({ ...makeSkeleton(opts), timestamp: 0 });

test('neutral pose: wheel grip, level hands, no pedals', () => {
  const p = analyze({});
  assert.equal(p.valid, true);
  assert.equal(p.gestures.handsPosition, 'wheel');
  assert.ok(Math.abs(p.gestures.hands.wheelAngleDeg) < 0.5);
  assert.ok(Math.abs(p.gestures.hands.lateral) < 0.01);
  assert.deepEqual(p.gestures.pedalState.active, []);
  assert.ok(p.quality.upperBody && p.quality.lowerBody);
});

test('steering: right hand lower → positive angle / "right"; left hand lower → negative', () => {
  const r = analyze({ handsTiltDeg: 30 });
  assert.ok(Math.abs(r.gestures.hands.wheelAngleDeg - 30) < 1, `got ${r.gestures.hands.wheelAngleDeg}`);
  assert.equal(r.gestures.hands.turn, 'right');
  const l = analyze({ handsTiltDeg: -30 });
  assert.ok(Math.abs(l.gestures.hands.wheelAngleDeg + 30) < 1);
  assert.equal(l.gestures.hands.turn, 'left');
});

test('steering: shifting hands toward user right gives positive lateral', () => {
  assert.ok(analyze({ handsShift: 0.1 }).gestures.hands.lateral > 0.3);
  assert.ok(analyze({ handsShift: -0.1 }).gestures.hands.lateral < -0.3);
});

test('mirroring: landmark x is flipped so user-right is larger x', () => {
  const p = analyze({});
  assert.ok(p.landmarks.rightShoulder.x > p.landmarks.leftShoulder.x);
});

test('elbow angle is reported and sane', () => {
  const p = analyze({});
  assert.ok(p.angles.leftElbow > 60 && p.angles.leftElbow < 180);
});

test('right knee flex presses accelerator; clutch stays up', () => {
  const p = analyze({ rightKneeFlex: 50 });
  assert.ok(p.gestures.pedalState.accelerator > 0.9, `acc ${p.gestures.pedalState.accelerator}`);
  assert.equal(p.gestures.pedalState.brake, 0);
  assert.equal(p.gestures.pedalState.clutch, 0);
  assert.deepEqual(p.gestures.pedalState.active, ['accelerator']);
  assert.equal(p.gestures.pedalState.right.state, 'down');
});

test('left knee flex presses clutch', () => {
  const p = analyze({ leftKneeFlex: 50 });
  assert.ok(p.gestures.pedalState.clutch > 0.9);
  assert.deepEqual(p.gestures.pedalState.active, ['clutch']);
});

test('right foot raised while swept toward body centre selects brake', () => {
  const p = analyze({ rightKneeFlex: 50, rightFootSweep: 0.1 });
  assert.equal(p.gestures.pedalState.rightFootZone, 'brake');
  assert.ok(p.gestures.pedalState.brake > 0.9);
  assert.equal(p.gestures.pedalState.accelerator, 0);
});

test('partial flex is analog', () => {
  const half = analyze({ rightKneeFlex: 24 }).gestures.pedalState.accelerator;
  assert.ok(half > 0.3 && half < 0.8, `got ${half}`);
});

test('hidden feet → lowerBody false, pedals zero', () => {
  const p = analyze({ hidden: [LM.leftAnkle, LM.rightAnkle] });
  assert.equal(p.quality.lowerBody, false);
  assert.equal(p.gestures.pedalState.accelerator, 0);
});

test('hidden wrist → handsPosition partial; both → lost', () => {
  assert.equal(analyze({ hidden: [LM.leftWrist] }).gestures.handsPosition, 'partial');
  assert.equal(analyze({ hidden: [LM.leftWrist, LM.rightWrist] }).gestures.handsPosition, 'lost');
});

test('payload is JSON-serialisable (WebRTC-ready)', () => {
  const p = analyze({ handsTiltDeg: 10, rightKneeFlex: 20 });
  const round = JSON.parse(JSON.stringify(p));
  assert.equal(round.schema, 'bodytracker/1');
  assert.ok('head' in round.landmarks && 'rightAnkle' in round.landmarks);
});

test('tracker: onPose fires, unsubscribe works, lost person gives empty pose', () => {
  const t = new BodyTracker({ camera: null, estimator: null });
  const seen = [];
  const off = t.onPose((p) => seen.push(p));
  const s = makeSkeleton({});
  t.processFrame(s.landmarks, s.worldLandmarks, 0, s.aspect);
  t.processFrame(null, null, 33, s.aspect);
  off();
  t.processFrame(s.landmarks, s.worldLandmarks, 66, s.aspect);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].valid, true);
  assert.equal(seen[1].valid, false);
  assert.equal(seen[1].gestures.handsPosition, 'lost');
});

test('tracker: calibration removes personal rest offsets', async () => {
  const t = new BodyTracker({ camera: null, estimator: null });
  // A "seated" person: legs rest with knees already bent 60°, hands tilted 8° and shifted
  const rest = { rightKneeFlex: 60, leftKneeFlex: 60, handsTiltDeg: 8, handsShift: 0.03 };
  let ts = 0;
  const feed = (opts) => { const s = makeSkeleton(opts); return t.processFrame(s.landmarks, s.worldLandmarks, (ts += 33), s.aspect); };
  const before = feed(rest);
  assert.ok(before.gestures.pedalState.accelerator > 0.9, 'uncalibrated, bent knees look like pressed pedals');

  const pending = t.calibrate({ durationMs: 400, minSamples: 5 });
  const start = Date.now();
  while (Date.now() - start < 600) { feed(rest); await new Promise((r) => setTimeout(r, 10)); }
  const res = await pending;
  assert.equal(res.ok, true, res.reason);

  const neutral = feed(rest);
  assert.ok(neutral.gestures.pedalState.accelerator < 0.1, `acc ${neutral.gestures.pedalState.accelerator}`);
  assert.ok(Math.abs(neutral.gestures.hands.wheelAngleDeg) < 1.5);
  assert.ok(Math.abs(neutral.gestures.hands.lateral) < 0.1);
  let pressed;
  for (let i = 0; i < 8; i++) pressed = feed({ ...rest, rightKneeFlex: 90 });   // smoother needs a few frames to follow a step
  assert.ok(pressed.gestures.pedalState.accelerator > 0.8, `acc ${pressed.gestures.pedalState.accelerator}`);
});

test('tracker: calibration fails clearly when feet are not visible', async () => {
  const t = new BodyTracker({ camera: null, estimator: null });
  const pending = t.calibrate({ durationMs: 200, minSamples: 5 });
  let ts = 0; const start = Date.now();
  while (Date.now() - start < 350) {
    const s = makeSkeleton({ hidden: [LM.leftAnkle, LM.rightAnkle] });
    t.processFrame(s.landmarks, s.worldLandmarks, (ts += 33), s.aspect);
    await new Promise((r) => setTimeout(r, 10));
  }
  const res = await pending;
  assert.equal(res.ok, false);
  assert.match(res.reason, /visible/i);
});

// ───────── tracking robustness ─────────
test('right leg is enough: hiding the whole left leg still gives pedals and a valid calibration sample', () => {
  const hiddenLeft = [LM.leftKnee, LM.leftAnkle, LM.leftFoot];
  const p = analyze({ rightKneeFlex: 30, hidden: hiddenLeft });
  assert.equal(p.quality.lowerBody, false);
  assert.equal(p.quality.rightLeg, true);
  const both = analyze({ rightKneeFlex: 30 });
  assert.equal(p.gestures.pedalState.accelerator, both.gestures.pedalState.accelerator, 'same pedal value as with both legs visible');
  assert.ok(p.gestures.pedalState.accelerator > 0.5, `accelerator ${p.gestures.pedalState.accelerator}`);
  const none = analyze({ rightKneeFlex: 30, hidden: [LM.rightAnkle] });
  assert.equal(none.quality.rightLeg, false);
});

test('calibration succeeds with only the right leg visible', async () => {
  const t = new BodyTracker({ camera: null, estimator: null });
  const s = makeSkeleton({ hidden: [LM.leftKnee, LM.leftAnkle, LM.leftFoot] });
  let ts = 0;
  const feed = setInterval(() => t.processFrame(s.landmarks, s.worldLandmarks, (ts += 33), s.aspect), 1);
  const res = await t.calibrate({ durationMs: 60, minSamples: 5 });
  clearInterval(feed);
  assert.equal(res.ok, true, res.reason);
});

test('a one-frame ankle spike does not reach the accelerator (median filter)', () => {
  const a = new PoseAnalyzer();
  const press = (flex) => analyze({ rightKneeFlex: flex }, a).gestures.pedalState.accelerator;
  press(0); press(0);
  assert.equal(press(50), 0, 'single spike suppressed');
  press(0);
  press(50); press(50);
  assert.ok(press(50) > 0.95, 'sustained lift passes through');
});

test('a point with low confidence is held, not fed into the smoothing filter', () => {
  const t = new BodyTracker({ camera: null, estimator: null });
  const good = makeSkeleton({});
  t.processFrame(good.landmarks, good.worldLandmarks, 1000, good.aspect);
  const before = t.lastPose.landmarks.rightAnkle;
  const bad = makeSkeleton({});
  bad.landmarks[LM.rightAnkle] = { x: 0.9, y: 0.1, z: 0, visibility: 0.05 };    // wild guess
  t.processFrame(bad.landmarks, bad.worldLandmarks, 1033, bad.aspect);
  const during = t.lastPose.landmarks.rightAnkle;
  assert.ok(Math.abs(during.x - before.x) < 1e-3 && Math.abs(during.y - before.y) < 1e-3, 'held');
  t.processFrame(good.landmarks, good.worldLandmarks, 1066, good.aspect);
  const after = t.lastPose.landmarks.rightAnkle;
  assert.ok(Math.abs(after.x - before.x) < 0.01 && Math.abs(after.y - before.y) < 0.01, 'no jump when it comes back');
});

test('tracker: full model failing to load falls back to lite; slow detection steps down to lite', async () => {
  globalThis.requestAnimationFrame ??= () => 0;
  const mk = (variant, { failInit = false, slow = false } = {}) => ({
    variant, disposed: false,
    async init() { if (failInit) throw new Error('download failed'); },
    detect() { if (slow) { const e = performance.now() + 50; while (performance.now() < e); } return null; },
    dispose() { this.disposed = true; },
  });
  // 1. init fallback
  const made = [];
  const t1 = new BodyTracker({ camera: null, estimatorFactory: (v) => { const e = mk(v, { failInit: v === 'full' }); made.push(e); return e; } });
  await t1._initEstimator();
  assert.equal(t1.estimator.variant, 'lite');
  assert.equal(made[0].disposed, true);
  // 2. perf downgrade
  const t2 = new BodyTracker({ camera: null, estimatorFactory: (v) => mk(v, { slow: v === 'full' }) });
  t2._running = true;
  t2.video = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0 };
  for (let i = 1; i <= 75; i++) { t2.video.currentTime = i; t2._lastRun = 0; t2._tick(i * 100); }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t2.estimator.variant, 'lite');
  t2._running = false;
  // 3. custom estimators are never swapped
  const custom = mk('full', { slow: true });
  const t3 = new BodyTracker({ camera: null, estimator: custom });
  t3._running = true; t3.video = { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 0 };
  for (let i = 1; i <= 75; i++) { t3.video.currentTime = i; t3._lastRun = 0; t3._tick(i * 100); }
  assert.equal(t3.estimator, custom);
  t3._running = false;
});
