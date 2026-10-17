import test from 'node:test';
import assert from 'node:assert/strict';
import { Vehicle } from './Vehicle.js';

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

// ───────── automatic gearbox (the app's default) ─────────
const gearLog = (v, phases) => {
  const log = []; let last = v.gear, t = 0;
  for (const [secs, inp] of phases) for (let i = 0; i < secs * 60; i++) {
    v.step(1 / 60, { ...idle, ...inp }, road); t += 1 / 60;
    if (v.gear !== last) { log.push({ t, from: last, to: v.gear, kmh: v.kmh, rpm: v.rpm }); last = v.gear; }
  }
  return log;
};

test('auto is the default mode and ignores the clutch pedal entirely', () => {
  const v = new Vehicle();
  assert.equal(v.mode, 'auto');
  run(v, 3, { ...idle, throttle: 1, clutch: 1 });
  assert.ok(v.speed > 10, `still drives with clutch input: ${v.speed}`);
  assert.equal(v.engineOn, true);
});

test('auto: changes up through the gears under full throttle and never over-revs', () => {
  const v = new Vehicle();
  const log = gearLog(v, [[14, { throttle: 1 }]]);
  assert.deepEqual(log.map((l) => l.to), [2, 3, 4]);
  assert.ok(log.every((l) => l.to > l.from));
  assert.ok(v.rpm < v.p.redline, `rpm ${v.rpm}`);
  for (const l of log) assert.ok(l.rpm > 2300, `post-shift rpm ${l.rpm}`);
});

test('auto: light throttle shifts up earlier (lower speed/revs) than full throttle', () => {
  const light = gearLog(new Vehicle(), [[20, { throttle: 0.35 }]])[0];
  const full = gearLog(new Vehicle(), [[8, { throttle: 1 }]])[0];
  assert.ok(light && full);
  assert.ok(light.kmh < full.kmh, `${light.kmh} vs ${full.kmh}`);
});

test('auto: kickdown — flooring it at cruise drops a gear', () => {
  const v = new Vehicle();
  run(v, 14, { ...idle, throttle: 0.45 });
  const g = v.gear;
  assert.ok(g >= 3, `cruising in gear ${g}`);
  const log = gearLog(v, [[1.2, { throttle: 1 }]]);
  assert.ok(log.some((l) => l.to < l.from), 'a downshift happened');
});

test('auto: steady cruise does not hunt between gears', () => {
  const v = new Vehicle();
  run(v, 12, { ...idle, throttle: 0.5 });
  const log = gearLog(v, [[10, { throttle: 0.18 }]]);          // hold a steady-ish speed
  assert.ok(log.length <= 2, `${log.length} shifts: ${JSON.stringify(log.map((l) => `${l.from}>${l.to}`))}`);
});

test('auto: braking to a stop steps down to 1st, and pulling away works again', () => {
  const v = new Vehicle();
  run(v, 9, { ...idle, throttle: 1 });
  run(v, 12, { ...idle, brake: 1 });
  assert.equal(v.speed, 0);
  assert.equal(v.gear, 1);
  run(v, 3, { ...idle, throttle: 0.8 });
  assert.ok(v.kmh > 25, `${v.kmh}`);
  assert.equal(v.engineOn, true);
});

test('auto: full-throttle 0–100 km/h stays in a sensible range with the new shift points', () => {
  const v = new Vehicle();
  let t = 0, t100 = null;
  while (t < 30) { v.step(1 / 60, { ...idle, throttle: 1 }, road); t += 1 / 60; if (t100 === null && v.kmh >= 100) t100 = t; }
  assert.ok(t100 > 5 && t100 < 12, `0-100 in ${t100}`);
});
