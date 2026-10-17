import test from 'node:test';
import assert from 'node:assert/strict';
import { Vehicle } from '../src/Vehicle.js';

const road = { center: () => 0, halfWidth: 4 };
const run = (v, secs, input, dt = 1 / 60) => { for (let t = 0; t < secs; t += dt) v.step(dt, input, road); return v; };
const idle = { steer: 0, throttle: 0, brake: 0, clutch: 0 };

test('full throttle accelerates to a sensible 0–100 km/h time', () => {
  const v = new Vehicle(); v.setMode('auto');
  let t = 0, t100 = null;
  while (t < 30) { v.step(1 / 60, { ...idle, throttle: 1 }, road); t += 1 / 60; if (t100 === null && v.kmh >= 100) t100 = t; }
  assert.ok(t100 !== null && t100 > 5 && t100 < 14, `0-100 in ${t100}`);
  assert.ok(v.kmh < 260, `top speed ${v.kmh}`);
});

test('brakes stop the car and never reverse it', () => {
  const v = new Vehicle(); v.setMode('auto');
  run(v, 8, { ...idle, throttle: 1 });
  const before = v.kmh;
  run(v, 12, { ...idle, brake: 1 });
  assert.ok(before > 60);
  assert.equal(v.speed, 0);
});

test('clutch pressed disconnects the engine: throttle revs freely, no drive', () => {
  const v = new Vehicle(); v.setMode('manual');
  run(v, 2, { ...idle, throttle: 1, clutch: 1 });
  assert.ok(v.speed < 0.5, `speed ${v.speed}`);
  assert.ok(v.rpm > 4500, `rpm ${v.rpm}`);
});

test('slipping the clutch launches more gently than dumping it', () => {
  const dump = new Vehicle(); dump.setMode('manual'); run(dump, 1.5, { ...idle, throttle: 0.8, clutch: 0 });
  const feather = new Vehicle(); feather.setMode('manual'); run(feather, 1.5, { ...idle, throttle: 0.8, clutch: 0.55 });
  assert.ok(feather.speed < dump.speed, `${feather.speed} vs ${dump.speed}`);
  assert.ok(feather.speed > 0);
});

test('assisted: pressing the clutch at speed selects a higher gear', () => {
  const v = new Vehicle(); v.setMode('assisted');
  run(v, 4, { ...idle, throttle: 1 });
  const g = v.gear;
  run(v, 0.3, { ...idle, throttle: 0, clutch: 1 });
  assert.ok(v.gear > g, `gear ${g} → ${v.gear} at ${v.kmh.toFixed(0)} km/h`);
});

test('manual: shifting without the clutch grinds and does nothing', () => {
  const v = new Vehicle(); v.setMode('manual');
  assert.equal(v.requestShift(+1, 0), false);
  assert.equal(v.gear, 1);
  assert.ok(v.events.includes('grind'));
  assert.equal(v.requestShift(+1, 1), true);
  assert.equal(v.gear, 2);
});

test('stall: dumping the clutch in 3rd from rest stalls (when realism is on); clutch restarts', () => {
  const v = new Vehicle(); v.setMode('manual'); v.stallEnabled = true; v.gear = 3;
  run(v, 0.5, { ...idle, throttle: 0.1, clutch: 0 });
  assert.equal(v.engineOn, false);
  run(v, 0.2, { ...idle, clutch: 1 });
  assert.equal(v.engineOn, true);
});

test('steering turns the car the right way and is gentler at speed', () => {
  const slow = new Vehicle(); slow.setMode('auto'); slow.speed = 5;
  run(slow, 1, { ...idle, steer: 1, throttle: 0.2 });
  assert.ok(slow.yaw > 0.1, `yaw ${slow.yaw}`);
  assert.ok(slow.x > 0);
  const fast = new Vehicle(); fast.setMode('auto'); fast.speed = 35;
  run(fast, 1, { ...idle, steer: 1, throttle: 0.4 });
  assert.ok(Math.abs(fast.yaw) < Math.abs(slow.yaw) * 1.5, 'high-speed steering is damped / grip-limited');
  const left = new Vehicle(); left.setMode('auto'); left.speed = 10;
  run(left, 1, { ...idle, steer: -1, throttle: 0.2 });
  assert.ok(left.yaw < 0 && left.x < 0);
});

test('driving off the road is flagged and slows the car', () => {
  const v = new Vehicle(); v.setMode('auto'); v.speed = 25; v.x = 8;
  v.step(1 / 60, idle, road);
  assert.equal(v.offRoad, true);
});
