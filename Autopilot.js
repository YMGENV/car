/**
 * Autopilot.js — lane keeping + speed control. No rendering, no Three.js.
 *
 *   Steering  = pure-pursuit toward a point on the road centre-line a little way ahead
 *   Speed     = no speed limit: it accelerates as fast as the car can go and only brakes when a bend
 *               ahead needs it (it looks far enough ahead to brake in time)
 *
 * Usage (once per frame, instead of the body/keyboard inputs):
 *   const ap = new Autopilot();
 *   ap.engage(vehicle);
 *   const { steer, throttle, brake, clutch } = ap.drive(vehicle, road, dt);
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const AUTOPILOT = {
  brakePlan: 5,        // m/s² it plans to brake at when a bend is coming
  lookaheadSec: 1.3,   // how far ahead (in seconds of driving) it aims
  lookaheadMin: 6,     // m
  lookaheadMax: 45,    // m
  yawGain: 2.2,        // 1/s — how hard it corrects heading error
  lateralG: 2.5,       // m/s² it is willing to pull in a bend (sets the bend speed limit)
  maxThrottle: 1.0,
};

export class Autopilot {
  constructor(cfg = {}) {
    this.c = { ...AUTOPILOT, ...cfg };
    this.on = false;
    this._i = 0;           // integral term of the speed controller
  }

  engage(v) {
    this._i = 0;
    this.on = true;
  }

  disengage() { this.on = false; this._i = 0; }

  /**
   * The fastest speed that is still safe right now: for every bend up to a braking distance ahead, how fast
   * could we be going here and still slow down to that bend's limit in time? No bend ahead → no limit.
   */
  targetSpeed(v, road) {
    const c = this.c;
    const reach = (v.speed * v.speed) / (2 * c.brakePlan) + 40;
    let allowed = Infinity;
    for (let d = 0; d <= reach; d += 12) {
      const curv = Math.abs(road.heading(v.s + d + 25) - road.heading(v.s + d)) / 25;     // rad per metre
      const bendLimit = Math.max(Math.sqrt(c.lateralG / Math.max(curv, 1e-4)), 8);
      allowed = Math.min(allowed, Math.sqrt(bendLimit * bendLimit + 2 * c.brakePlan * d));
    }
    return allowed;
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
    const err = Math.min(this.targetSpeed(v, road) - v.speed, 60);                  // m/s
    this._i = clamp(this._i + err * dt * 0.08, 0, 0.6);
    const throttle = err > 0 ? clamp(0.25 * err + this._i, 0, c.maxThrottle) : 0;
    const brake = err < -1.5 ? clamp((-err - 1.5) * 0.15, 0, 0.6) : 0;
    if (err < 0) this._i *= 0.98;

    return { steer, throttle, brake, clutch: 0 };
  }
}
