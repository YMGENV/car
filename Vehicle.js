/**
 * Vehicle.js — driving physics (no rendering, no Three.js).
 *
 * Longitudinal: engine torque curve → clutch → gearbox → wheels, minus drag / rolling resistance / brakes.
 * Lateral: kinematic bicycle model with a grip limit (understeer + speed scrub when you exceed it).
 *
 * World convention used by the renderer:
 *   s    distance travelled along the road (m)         — the car always drives toward −z in the scene
 *   x    lateral position (m), + = right
 *   yaw  heading relative to straight ahead (rad), + = turning toward +x (right)
 *
 * Transmission modes (the app always runs 'auto'; the others remain for tests / experiments):
 *   'assisted'  DEFAULT. Press the clutch and the box picks the right gear for your speed. Body-friendly.
 *   'manual'    You choose gears (Q/E). A shift only succeeds with the clutch pressed, otherwise: GRIND.
 *   'auto'      DEFAULT. Clutch ignored, gearbox shifts itself (throttle-dependent shift points + kickdown).
 */
const TAU = Math.PI * 2;
const G = 9.81;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

export const TRANSMISSION_MODES = ['assisted', 'manual', 'auto'];

export class Vehicle {
  constructor(params = {}) {
    this.p = {
      mass: 1250, wheelBase: 2.7, wheelRadius: 0.32, finalDrive: 3.9, driveEff: 0.9,
      gears: [3.55, 2.10, 1.45, 1.08, 0.83],
      idle: 900, redline: 6500, peakTorque: 190, engineBrake: 45,   // Nm
      dragCoef: 0.42,        // 0.5·ρ·CdA
      rolling: 0.015,
      brakeForce: 11500,     // N at full pedal (≈ 0.94 g)
      tractionLimit: 6800,   // N the driven wheels can put down
      gripG: 0.95,
      ...params,
    };
    this.mode = 'auto';             // the game plays as an automatic: no clutch or gear keys needed
    this.stallEnabled = false;
    this.events = [];
    this.reset();
  }

  reset({ x = 0, yaw = 0 } = {}) {
    Object.assign(this, {
      s: 0, x, yaw, speed: 0, gear: 1, rpm: this.p.idle, freeRpm: this.p.idle, engineOn: true,
      steerState: 0, steerAngle: 0, longAcc: 0, latAcc: 0, slide: 0, offRoad: false,
      wheelSpin: 0, engagement: 1, limiter: false, _shiftTimer: 0,
    });
    this.events.length = 0;
  }

  get kmh() { return this.speed * 3.6; }
  setMode(m) { this.mode = m; }
  cycleMode() { this.mode = TRANSMISSION_MODES[(TRANSMISSION_MODES.indexOf(this.mode) + 1) % TRANSMISSION_MODES.length]; return this.mode; }

  /** Engine rpm the given gear would have at this road speed. */
  rpmAt(speed, gear) {
    const p = this.p;
    return (speed / (TAU * p.wheelRadius)) * 60 * p.gears[gear - 1] * p.finalDrive;
  }

  /** Highest gear that keeps the engine above ~1900 rpm. */
  bestGear(speed = this.speed) {
    for (let g = this.p.gears.length; g > 1; g--) if (this.rpmAt(speed, g) >= 1900) return g;
    return 1;
  }

  /** Manual shift request (+1 / −1). Needs the clutch pressed. */
  requestShift(dir, clutch) {
    if (this.mode !== 'manual') return false;
    if (clutch < 0.5) { this.events.push('grind'); return false; }
    const g = clamp(this.gear + dir, 1, this.p.gears.length);
    if (g !== this.gear) { this.gear = g; this.events.push('shift'); }
    return true;
  }

  /**
   * Automatic gearbox. Light throttle shifts up early (quiet, efficient); hard throttle holds each gear longer;
   * a floored pedal below the power band kicks down. Up/down thresholds are kept apart so it never hunts.
   */
  _autoShift(thr, brk) {
    const p = this.p, top = p.gears.length, g = this.gear;
    const up = 2800 + thr * 3000;                                   // rpm at which we change up (2800 … 5800)
    const downLimit = 1250 + thr * 900;                            // below this rpm in the current gear, change down
    const rpmNow = this.rpmAt(this.speed, g);
    const change = (dir) => { this.gear = g + dir; this._shiftTimer = dir > 0 ? 0.5 : 0.35; this.events.push('shift'); };

    if (g < top && rpmNow > up && this.rpmAt(this.speed, g + 1) > 1700 && brk < 0.3) return change(+1);
    if (g > 1) {
      const lower = this.rpmAt(this.speed, g - 1);
      if (thr > 0.85 && rpmNow < 3600 && lower < 6000) return change(-1);                          // kickdown
      if (rpmNow < downLimit && lower < up - 400) return change(-1);                                // lugging / slowing down
      if (brk > 0.6 && lower < 4200 && rpmNow < 2400) return change(-1);                            // braking: engine-brake and be ready
    }
  }

  _torqueCurve(rpm) {
    const x = (rpm - 4300) / 4300;
    return this.p.peakTorque * clamp(1 - 0.8 * x * x, 0.35, 1);
  }

  /**
   * @param {number} dt seconds
   * @param {{steer:number, throttle:number, brake:number, clutch:number}} input  steer −1..1, others 0..1 (clutch 1 = pedal pressed)
   * @param {{center:(s:number)=>number, halfWidth:number}} road
   */
  step(dt, input, road) {
    const p = this.p;
    this.events.length = 0;
    const steer = clamp(input.steer, -1, 1);
    const thr = clamp(input.throttle, 0, 1);
    const brk = clamp(input.brake, 0, 1);
    const clu = clamp(input.clutch, 0, 1);
    this._shiftTimer = Math.max(0, this._shiftTimer - dt);

    // ── Transmission logic ──
    if (this.mode === 'assisted' && clu > 0.6) {
      const g = this.bestGear();
      if (g !== this.gear) { this.gear = g; this.events.push('shift'); }
    } else if (this.mode === 'auto' && this._shiftTimer === 0) {
      this._autoShift(thr, brk);
    }

    // Clutch bite: fully engaged below 30 % pedal, fully open above 80 %.
    let engagement = this.mode === 'auto' ? 1 : clamp((0.8 - clu) / 0.5, 0, 1);
    this.engagement = engagement;

    // Engine restart after a stall
    if (!this.engineOn && clu > 0.7) { this.engineOn = true; this.rpm = this.freeRpm = p.idle; this.events.push('restart'); }

    // ── Engine & drivetrain ──
    const ratio = p.gears[this.gear - 1] * p.finalDrive;
    const coupledRpm = (this.speed / (TAU * p.wheelRadius)) * 60 * ratio;
    const freeTarget = p.idle + thr * (p.redline - p.idle) * 0.95;

    if (this.stallEnabled && this.engineOn && engagement > 0.9 && coupledRpm < 450 && thr < 0.6 && this.mode !== 'auto') {
      this.engineOn = false; this.events.push('stall');
    }

    let driveForce = 0;
    this.limiter = false;
    if (!this.engineOn) {
      this.rpm = lerp(this.rpm, 0, Math.min(1, dt * 6));
    } else if (engagement > 0.02) {
      this.rpm = Math.max(lerp(this.freeRpm, coupledRpm, engagement), p.idle * 0.85);
      let tq = this._torqueCurve(this.rpm) * thr;
      if (this.rpm > p.redline) { tq = 0; this.limiter = true; this.events.push('limiter'); }
      if (thr < 0.04) tq = -p.engineBrake * (this.rpm / p.redline);           // engine braking
      driveForce = ((tq * ratio * p.driveEff) / p.wheelRadius) * engagement;
      driveForce = Math.min(driveForce, p.tractionLimit);
      this.freeRpm = engagement > 0.9 ? this.rpm : lerp(this.freeRpm, freeTarget, Math.min(1, dt * 5));
    } else {                                                                  // clutch fully in: engine free-revs
      this.freeRpm = lerp(this.freeRpm, freeTarget, Math.min(1, dt * 6));
      this.rpm = Math.max(this.freeRpm, p.idle);
    }

    // ── Longitudinal dynamics ──
    const v = this.speed;
    this.offRoad = Math.abs(this.x - road.center(this.s)) > road.halfWidth + 1.4;
    const roll = p.rolling * p.mass * G * (this.offRoad ? 5 : 1) * (v > 0.05 ? 1 : 0);
    const drag = p.dragCoef * v * v;
    const brakeF = brk * p.brakeForce;
    let force = driveForce - drag - roll - brakeF;
    let acc = force / p.mass;
    let nv = v + acc * dt;
    if (nv < 0) { nv = 0; acc = -v / dt; }
    this.longAcc = acc;
    this.speed = nv;

    // ── Lateral dynamics (bicycle model) ──
    this.steerState += (steer - this.steerState) * Math.min(1, dt * 12);
    const maxSteer = 0.45 / (1 + (this.speed / 8) ** 2);                      // steering gets less sensitive with speed
    this.steerAngle = this.steerState * maxSteer;
    let yawRate = (this.speed / p.wheelBase) * Math.tan(this.steerAngle);
    const grip = p.gripG * G * (this.offRoad ? 0.65 : 1);
    const latAcc = this.speed * yawRate;
    this.slide = 0;
    if (Math.abs(latAcc) > grip) {                                            // understeer + scrub speed
      this.slide = clamp((Math.abs(latAcc) - grip) / grip, 0, 1);
      yawRate = (Math.sign(yawRate) * grip) / Math.max(this.speed, 0.1);
      this.speed = Math.max(0, this.speed - this.slide * 7 * dt);
    }
    this.latAcc = this.speed * yawRate;
    this.yaw = clamp(this.yaw + yawRate * dt, -1.45, 1.45);

    this.x += this.speed * Math.sin(this.yaw) * dt;
    this.s += this.speed * Math.cos(this.yaw) * dt;
    this.wheelSpin += (this.speed * dt) / p.wheelRadius;
  }
}
