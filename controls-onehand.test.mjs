import test from 'node:test';
import assert from 'node:assert/strict';
import { InputMapper } from './Controls.js';
import { PoseAnalyzer, LM } from './BodyTracker.js';
import { makeSkeleton } from './skeleton.mjs';
import { slimPose } from './Link.js';

const pose = (o) => slimPose(new PoseAnalyzer().analyze({ ...makeSkeleton(o), timestamp: 0 }));
const steerFor = (o) => { const m = new InputMapper(); m.setPose(pose(o)); let r; for (let i = 0; i < 90; i++) r = m.read(1 / 60); return r; };

test('one hand: moving it right steers right, left steers left, centre is straight', () => {
  const hid = [LM.leftWrist];
  assert.ok(steerFor({ hidden: hid, handsShift: 0.08 }).steer > 0.4);
  assert.ok(steerFor({ hidden: hid, handsShift: -0.08 }).steer < -0.4);
  assert.ok(Math.abs(steerFor({ hidden: hid }).steer) < 0.35);
  assert.equal(steerFor({ hidden: hid, handsShift: 0.15 }).sources.steer, 'body (1 hand)');
});

test('the other hand never matters, whichever one is shown', () => {
  assert.ok(steerFor({ hidden: [LM.rightWrist], handsShift: 0.08 }).steer > 0.4);
  assert.ok(steerFor({ hidden: [LM.rightWrist], handsShift: -0.08 }).steer < -0.4);
});

test('both hands still steer exactly as before', () => {
  assert.ok(steerFor({ handsTiltDeg: 30 }).steer > 0.5);
  assert.equal(steerFor({ handsTiltDeg: 30 }).sources.steer, 'body');
});

test('P key maps to the auto-pilot action', () => {
  const m = new InputMapper(); const seen = [];
  m.onAction = (a) => seen.push(a);
  globalThis.performance ??= { now: () => Date.now() };
  m._down({ code: 'KeyP', repeat: false, target: {}, preventDefault() {} });
  assert.deepEqual(seen, ['autopilot']);
});
