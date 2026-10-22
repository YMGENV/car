import test from 'node:test';
import assert from 'node:assert/strict';
import { Vehicle } from './Vehicle.js';
import { RoadPath } from './RoadPath.js';
import { Autopilot } from './Autopilot.js';

const road = new RoadPath();

function drive({ startKmh = 0, seconds = 300, x0 = 0, yaw0 = null, s0 = 0 } = {}) {
  const v = new Vehicle(), ap = new Autopilot();
  v.reset({ x: road.center(s0) + x0, yaw: yaw0 ?? road.heading(s0) });
  v.s = s0; v.speed = startKmh / 3.6;
  ap.engage(v);
  let maxErr = 0, offRoadTime = 0, top = 0, slowest = Infinity;
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    v.step(dt, ap.drive(v, road, dt), road);
    if (t > 5) maxErr = Math.max(maxErr, Math.abs(v.x - road.center(v.s)));
    if (t > 30) slowest = Math.min(slowest, v.kmh);
    top = Math.max(top, v.kmh);
    if (v.offRoad) offRoadTime += dt;
  }
  return { v, ap, maxErr, offRoadTime, top, slowest };
}

test('auto-pilot has no speed cap: it goes as fast as the car can, from a standstill', () => {
  const r = drive({ startKmh: 0 });
  assert.ok(r.top > 150, `top speed ${r.top.toFixed(0)} km/h`);
  assert.equal(r.offRoadTime, 0);
  assert.ok(r.maxErr < 3.4, `max lane error ${r.maxErr.toFixed(2)} m (road half-width 4 m)`);
});

test('auto-pilot only slows down for bends, and never loses grip', () => {
  const r = drive({ startKmh: 100 });
  assert.ok(r.slowest < r.top - 30, 'brakes for the sharpest bends');
  assert.ok(r.slowest > 60, `never crawls (slowest ${r.slowest.toFixed(0)} km/h)`);
  assert.ok(r.v.slide < 0.01);
});

test('auto-pilot recovers from being thrown off the centre-line', () => {
  for (const [x0, yaw0] of [[3, -0.3], [-3, 0.3], [3.5, 0.5]]) {
    const r = drive({ startKmh: 60, x0, yaw0, seconds: 60 });
    assert.ok(r.maxErr < 3.5, `start x ${x0}, yaw ${yaw0}: ${r.maxErr.toFixed(2)} m`);
  }
});

test('auto-pilot works from different places along the road', () => {
  for (const s0 of [0, 400, 1300, 2600, 5000]) {
    const r = drive({ startKmh: 70, s0, seconds: 120 });
    assert.equal(r.offRoadTime, 0, `s0=${s0}`);
  }
});

test('engage turns it on, disengage turns it off', () => {
  const v = new Vehicle(), ap = new Autopilot();
  ap.engage(v); assert.equal(ap.on, true);
  ap.disengage(); assert.equal(ap.on, false);
});
