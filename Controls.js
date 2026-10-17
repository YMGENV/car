/**
 * Controls.js — maps poseData (from BodyTracker) and the keyboard onto driving inputs.
 *
 * This is the ONLY place that knows how body measurements become steer/throttle/brake/clutch, so you can
 * retune or replace the mapping without touching the tracker or the physics.
 *
 *   Steering  = sum of  (a) wheel tilt of your two wrists   (b) hands shifted left/right of your body centre
 *   Throttle  = right foot raised / knee bent, foot kept at its own side
 *   Brake     = right foot raised AND swept toward your body centre (the brake pedal sits left of the throttle)
 *   (Automatic gearbox: there is no clutch. Only the right foot is needed, so the left leg may be out of view.)
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export const DEFAULT_MAPPING = {
  steerTiltDeg: 35,        // wrist-line tilt that equals full lock
  steerLateral: 0.55,      // hand-centre shift (in shoulder widths) that equals full lock
  steerDeadzone: 0.04,
  steerExpo: 1.35,         // >1 = finer control near centre
  steerRate: 14,           // smoothing (1/s)
  pedalDeadzone: 0.08,
  pedalGain: 1.15,
  pedalRate: 22,
  bodyTimeoutMs: 500,      // poses older than this are ignored (tracker stalled)
  dropoutHoldMs: 250,      // keep the last good inputs this long when tracking blips out (a few lost frames)
};

const shape = (v, dz, expo) => {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz)) ** expo;
};

export class InputMapper {
  constructor(mapping = {}) {
    this.m = { ...DEFAULT_MAPPING, ...mapping };
    this.keys = new Set();
    this.pose = null; this.poseAt = 0;
    this.out = { steer: 0, throttle: 0, brake: 0, clutch: 0 };
    this._lastBody = null; this._lastBodyAt = 0;
    this._key = { steer: 0 };
    this.sources = { steer: 'none', pedals: 'none' };
    this.onAction = null;     // (name) => void for one-shot keys

    this._down = (e) => {
      if (e.repeat) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;   // typing the join code, etc.
      if (e.ctrlKey || e.metaKey || e.altKey) return;   // leave browser shortcuts (Ctrl+R, Ctrl+C, Cmd+V...) alone
      this.keys.add(e.code);
      const act = { KeyV: 'camera', KeyC: 'calibrate', KeyR: 'reset', KeyH: 'debug' }[e.code];
      if (act) this.onAction?.(act);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();   // stop the page scrolling
    };
    this._up = (e) => this.keys.delete(e.code);
    this._blur = () => this.keys.clear();
  }

  attachKeyboard(target = window) {
    target.addEventListener('keydown', this._down);
    target.addEventListener('keyup', this._up);
    target.addEventListener('blur', this._blur);
  }
  detachKeyboard(target = window) {
    target.removeEventListener('keydown', this._down);
    target.removeEventListener('keyup', this._up);
    target.removeEventListener('blur', this._blur);
  }

  /** Subscribe this to tracker.onPose(). */
  setPose(p) { this.pose = p; this.poseAt = performance.now(); }

  /** Raw (unsmoothed) body targets from the latest pose, or null if the body isn't driving. */
  _bodyTargets() {
    const p = this.pose, m = this.m, now = performance.now();
    if (!p || now - this.poseAt > m.bodyTimeoutMs) return null;
    if (!p.valid) {                                           // person briefly lost: ride through short dropouts
      return this._lastBody && now - this._lastBodyAt < m.dropoutHoldMs ? this._lastBody : null;
    }
    const h = p.gestures.hands, ped = p.gestures.pedalState;
    let steer = 0;
    const handsUsable = h.visible && (h.state === 'wheel' || h.state === 'free');
    if (handsUsable) {
      const tilt = clamp(h.wheelAngleDeg / m.steerTiltDeg, -1, 1);
      const lat = clamp(h.lateral / m.steerLateral, -1, 1);
      steer = shape(clamp(tilt + lat, -1, 1), m.steerDeadzone, m.steerExpo);   // either gesture alone reaches full lock; together they add
    }
    const feet = p.quality.rightLeg ?? p.quality.lowerBody;                   // only the right foot drives the pedals
    const pedal = (v) => (feet ? clamp(shape(v * m.pedalGain, m.pedalDeadzone, 1), 0, 1) : 0);
    const t = { steer, hands: handsUsable, throttle: pedal(ped.accelerator), brake: pedal(ped.brake), clutch: 0, feet };
    this._lastBody = t; this._lastBodyAt = now;
    return t;
  }

  /** Call once per frame; returns {steer, throttle, brake, clutch, sources}. */
  read(dt) {
    const k = this.keys, m = this.m;
    // keyboard
    const kSteerTarget = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    this._key.steer = kSteerTarget
      ? clamp(this._key.steer + kSteerTarget * 2.6 * dt, -1, 1)
      : Math.sign(this._key.steer) * Math.max(0, Math.abs(this._key.steer) - 4 * dt);
    const kThr = k.has('ArrowUp') || k.has('KeyW') ? 1 : 0;
    const kBrk = k.has('ArrowDown') || k.has('KeyS') ? 1 : 0;

    const body = this._bodyTargets();
    // steer: keyboard wins when used, else body
    const steerTarget = Math.abs(this._key.steer) > 0.001 ? this._key.steer : (body?.steer ?? 0);
    this.sources.steer = Math.abs(this._key.steer) > 0.001 ? 'keys' : body?.hands ? 'body' : 'none';
    // pedals: whichever is pressed harder
    const thr = Math.max(kThr, body?.throttle ?? 0);
    const brk = Math.max(kBrk, body?.brake ?? 0);
    const clu = 0;                                          // automatic gearbox: no clutch
    this.sources.pedals = (kThr || kBrk) ? 'keys' : body?.feet ? 'body' : 'none';

    const o = this.out;
    o.steer = smooth(o.steer, steerTarget, m.steerRate, dt);
    o.throttle = smooth(o.throttle, thr, m.pedalRate, dt);
    o.brake = smooth(o.brake, brk, m.pedalRate, dt);
    o.clutch = smooth(o.clutch, clu, m.pedalRate, dt);
    if (Math.abs(o.steer) < 0.002) o.steer = 0;
    return { ...o, sources: this.sources };
  }
}
