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
  let maxErr = 0, offRoadTime = 0, sumErr = 0, n = 0;
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    v.step(dt, ap.drive(v, road, dt), road);
    const e = Math.abs(v.x - road.center(v.s));
    if (t > 10) { maxErr = Math.max(maxErr, e); sumErr += e; n++; }
    if (v.offRoad) offRoadTime += dt;
  }
  return { v, ap, maxErr, meanErr: sumErr / n, offRoadTime };
}

test('auto-pilot from a standstill reaches cruise speed and holds the lane', () => {
  const r = drive({ startKmh: 0 });
  assert.equal(r.ap.cruiseKmh, 40);
  assert.equal(r.offRoadTime, 0);
  assert.ok(r.maxErr < 1.5, `max lane error ${r.maxErr.toFixed(2)} m`);
  assert.ok(Math.abs(r.v.kmh - 40) < 3, `speed ${r.v.kmh.toFixed(1)}`);
});

test('auto-pilot at 80 km/h stays on the road for 5 minutes', () => {
  const r = drive({ startKmh: 80 });
  assert.equal(r.ap.cruiseKmh, 80);
  assert.equal(r.offRoadTime, 0);
  assert.ok(r.maxErr < 2.0, `max lane error ${r.maxErr.toFixed(2)} m`);
  assert.ok(r.v.slide < 0.01, 'never loses grip');
});

test('auto-pilot at 100 km/h stays on the road', () => {
  const r = drive({ startKmh: 100 });
  assert.equal(r.offRoadTime, 0);
  assert.ok(r.maxErr < 2.5, `max lane error ${r.maxErr.toFixed(2)} m`);
});

test('auto-pilot recovers from being thrown off the centre-line', () => {
  for (const [x0, yaw0] of [[3, -0.3], [-3, 0.3], [3.5, 0.5]]) {
    const r = drive({ startKmh: 60, x0, yaw0, seconds: 60 });
    assert.ok(r.maxErr < 2.5, `start x ${x0}, yaw ${yaw0}: ${r.maxErr.toFixed(2)} m`);
  }
});

test('auto-pilot works from different places along the road', () => {
  for (const s0 of [0, 400, 1300, 2600, 5000]) {
    const r = drive({ startKmh: 70, s0, seconds: 120 });
    assert.equal(r.offRoadTime, 0, `s0=${s0}`);
  }
});

test('engage clamps the cruise speed to 40–100 km/h and disengage turns it off', () => {
  const v = new Vehicle(), ap = new Autopilot();
  v.speed = 150 / 3.6; ap.engage(v); assert.equal(ap.cruiseKmh, 100);
  v.speed = 10 / 3.6; ap.engage(v); assert.equal(ap.cruiseKmh, 40);
  ap.disengage(); assert.equal(ap.on, false);
});
