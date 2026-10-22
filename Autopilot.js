/**
 * Autopilot.js — lane keeping + cruise control. No rendering, no Three.js.
 *
 *   Steering  = pure-pursuit toward a point on the road centre-line a little way ahead
 *   Speed     = cruise at the speed you were doing when you switched it on (40–100 km/h),
 *               slowed automatically for tighter bends
 *
 * Usage (once per frame, instead of the body/keyboard inputs):
 *   const ap = new Autopilot();
 *   ap.engage(vehicle);
 *   const { steer, throttle, brake, clutch } = ap.drive(vehicle, road, dt);
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const AUTOPILOT = {
  minKmh: 40,          // cruise speed when engaged from a standstill / very slow
  maxKmh: 100,
  lookaheadSec: 1.3,   // how far ahead (in seconds of driving) it aims
  lookaheadMin: 6,     // m
  lookaheadMax: 45,    // m
  yawGain: 2.2,        // 1/s — how hard it corrects heading error
  lateralG: 2.5,       // m/s² it is willing to pull in a bend (sets the bend speed limit)
  maxThrottle: 0.8,    // gentle acceleration
};

export class Autopilot {
  constructor(cfg = {}) {
    this.c = { ...AUTOPILOT, ...cfg };
    this.on = false;
    this.cruise = 0;       // m/s
    this._i = 0;           // integral term of the speed controller
  }

  get cruiseKmh() { return Math.round(this.cruise * 3.6); }

  engage(v) {
    const kmh = clamp(Math.round(v.kmh / 5) * 5, this.c.minKmh, this.c.maxKmh);
    this.cruise = kmh / 3.6;
    this._i = 0;
    this.on = true;
  }

  disengage() { this.on = false; this._i = 0; }

  /** The speed the car should do right now: cruise, reduced for the bend ahead. */
  targetSpeed(v, road) {
    const ahead = 25;
    const curv = Math.abs(road.heading(v.s + ahead) - road.heading(v.s)) / ahead;   // rad per metre
    const bendLimit = Math.sqrt(this.c.lateralG / Math.max(curv, 1e-4));
    return Math.min(this.cruise, Math.max(bendLimit, 8));
  }

  drive(v, road, dt) {
    const c = this.c;
    // ── steering ──
    let steer = 0;
    const speed = Math.max(v.speed, 0);
    if (speed > 1) {
      const look = clamp(speed * c.lookaheadSec, c.lookaheadMin, c.lookaheadMax);
      const targetX = road.center(v.s + look);
      const wantYaw = Math.atan2(targetX - v.x, look);                              // heading that points at the target
      const feedForward = ((road.heading(v.s + 5) - road.heading(v.s)) / 5) * speed; // follow the bend itself
      const wantYawRate = c.yawGain * (wantYaw - v.yaw) + feedForward;
      const wantAngle = Math.atan((wantYawRate * v.p.wheelBase) / speed);
      const maxSteer = 0.45 / (1 + (speed / 8) ** 2);                               // same law as Vehicle.step
      steer = clamp(wantAngle / maxSteer, -1, 1);
    }

    // ── speed ──
    const err = this.targetSpeed(v, road) - v.speed;                                // m/s
    this._i = clamp(this._i + err * dt * 0.08, 0, 0.6);
    const throttle = err > 0 ? clamp(0.25 * err + this._i, 0, c.maxThrottle) : 0;
    const brake = err < -1.5 ? clamp((-err - 1.5) * 0.15, 0, 0.6) : 0;
    if (err < 0) this._i *= 0.98;

    return { steer, throttle, brake, clutch: 0 };
  }
}
