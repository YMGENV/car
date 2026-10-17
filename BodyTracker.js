/**
 * BodyTracker.js — modular, render-agnostic body tracking
 * ========================================================
 * Pipeline (each stage is independent and replaceable):
 *
 *   CameraManager ──► <video> ──► PoseEstimator ──► LandmarkSmoother ──► PoseAnalyzer ──► poseData
 *   (getUserMedia)               (MediaPipe Pose)   (One-Euro filter)    (angles/gestures)   │
 *                                                                                            ▼
 *                                                              tracker.onPose(cb)  (game loop, WebRTC, UI…)
 *
 * Nothing in this file touches Three.js, the DOM layout or any game logic.
 * The only DOM objects used are <video> and MediaDevices (camera).
 *
 * COORDINATE CONVENTION ("user space")
 *   x: 0..1, increases toward the USER'S RIGHT as seen on a mirrored preview
 *   y: 0..1, increases downward
 *   z: roughly same scale as x, negative = toward the camera
 *   Landmarks are mirrored internally (cfg.mirror) so that "left hand" is on the left of a mirrored preview.
 *
 * Quick start:
 *   const tracker = new BodyTracker({ video: document.querySelector('video') });
 *   tracker.onPose(p => console.log(p.gestures.handsPosition, p.gestures.pedalState.active));
 *   await tracker.start();           // asks for camera permission, loads the model
 *   await tracker.calibrate();       // hold your driving pose for ~2.5 s
 *
 * Headless use (tests, remote/WebRTC input):
 *   const tracker = new BodyTracker({ camera: null, estimator: null });
 *   tracker.processFrame(landmarks33, worldLandmarks33, performance.now(), 4/3);
 */

// ───────────────────────────── small utilities ─────────────────────────────
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toDeg = (r) => (r * 180) / Math.PI;
const round = (v, d = 4) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const median = (arr) => {
  const a = arr.filter((v) => v != null && !Number.isNaN(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Angle (degrees) at point b formed by a-b-c, in 3D. Returns null if degenerate. */
export function angle3(a, b, c) {
  const v1 = [a.x - b.x, a.y - b.y, a.z - b.z];
  const v2 = [c.x - b.x, c.y - b.y, c.z - b.z];
  const n1 = Math.hypot(...v1), n2 = Math.hypot(...v2);
  if (n1 < 1e-6 || n2 < 1e-6) return null;
  const cos = (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (n1 * n2);
  return toDeg(Math.acos(clamp(cos, -1, 1)));
}

/** MediaPipe Pose landmark indices we use. */
export const LM = Object.freeze({
  nose: 0, leftEar: 7, rightEar: 8,
  leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16, leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28,
  leftFoot: 31, rightFoot: 32,
});

/** Names exported in the poseData payload (nose is exported as "head"). */
const PAYLOAD_NAMES = { head: LM.nose, ...Object.fromEntries(Object.entries(LM).filter(([k]) => k !== 'nose')) };

class Emitter {
  constructor() { this._h = new Map(); }
  on(evt, fn) {
    if (!this._h.has(evt)) this._h.set(evt, new Set());
    this._h.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { this._h.get(evt)?.delete(fn); }
  emit(evt, payload) {
    for (const fn of this._h.get(evt) ?? []) {
      try { fn(payload); } catch (e) { console.error(`[BodyTracker] "${evt}" listener threw`, e); }
    }
  }
}

// ───────────────────────────── 1. CAMERA MANAGER ─────────────────────────────

export class CameraError extends Error {
  /** @param {'insecure-context'|'unsupported'|'permission-denied'|'not-found'|'in-use'|'timeout'|'unknown'} code */
  constructor(code, message, cause) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Webcam / phone-camera helper: permissions, device selection, resolution fallback ladder,
 * front/back switching. It owns the MediaStream and attaches it to a <video> element.
 */
export class CameraManager {
  constructor({ video = null, facingMode = 'user', width = 640, height = 480, frameRate = 30, deviceId = null } = {}) {
    this.video = video || document.createElement('video');
    this.video.setAttribute('playsinline', '');   // iOS Safari: don't go fullscreen
    this.video.muted = true;
    this.video.autoplay = true;
    this.facingMode = facingMode;
    this.deviceId = deviceId;
    this.target = { width, height, frameRate };
    this.stream = null;
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  /** Labels are empty until permission has been granted once. */
  static async listVideoDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  }

  /** Try the requested resolution first, then relax: pose models don't need HD. */
  _constraintLadder() {
    const base = this.deviceId ? { deviceId: { exact: this.deviceId } } : { facingMode: this.facingMode };
    const t = this.target;
    return [
      { video: { ...base, width: { ideal: t.width }, height: { ideal: t.height }, frameRate: { ideal: t.frameRate } }, audio: false },
      { video: { ...base }, audio: false },
      { video: true, audio: false },
    ];
  }

  async start() {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      throw new CameraError('insecure-context',
        'Camera access needs a secure page. Open the app via https:// or http://localhost (see README for phone use).');
    }
    if (!CameraManager.isSupported()) {
      throw new CameraError('unsupported', 'This browser does not support camera access (getUserMedia).');
    }
    this.stop();
    let lastErr;
    for (const constraints of this._constraintLadder()) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (e) {
        lastErr = e;
        // Permission / hardware problems won't be fixed by relaxing constraints.
        if (['NotAllowedError', 'SecurityError', 'NotReadableError', 'AbortError'].includes(e.name)) break;
      }
    }
    if (!this.stream) throw this._translate(lastErr);

    this.video.srcObject = this.stream;
    await new Promise((resolve, reject) => {
      if (this.video.readyState >= 2) return resolve();
      const t = setTimeout(() => reject(new CameraError('timeout', 'Camera opened but produced no frames.')), 8000);
      this.video.onloadeddata = () => { clearTimeout(t); resolve(); };
    });
    try { await this.video.play(); } catch { /* autoplay policies: user gesture already happened in practice */ }
    return this.info;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  /** Flip front/back camera (phones). */
  async switchCamera() {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    this.deviceId = null;
    return this.start();
  }

  /** Re-scale the live stream without re-prompting for permission. */
  async setResolution(width, height) {
    this.target.width = width; this.target.height = height;
    const track = this.stream?.getVideoTracks()[0];
    if (track) await track.applyConstraints({ width: { ideal: width }, height: { ideal: height } });
    return this.info;
  }

  get info() {
    const track = this.stream?.getVideoTracks()[0];
    const s = track?.getSettings?.() ?? {};
    return {
      width: this.video.videoWidth, height: this.video.videoHeight,
      frameRate: s.frameRate, facingMode: s.facingMode ?? this.facingMode, label: track?.label ?? '',
    };
  }

  _translate(e) {
    const n = e?.name;
    if (n === 'NotAllowedError' || n === 'SecurityError')
      return new CameraError('permission-denied', 'Camera permission was blocked. Allow camera access in the browser address bar and retry.', e);
    if (n === 'NotFoundError' || n === 'OverconstrainedError')
      return new CameraError('not-found', 'No camera was found on this device.', e);
    if (n === 'NotReadableError' || n === 'AbortError')
      return new CameraError('in-use', 'The camera is in use by another app or tab. Close it and retry.', e);
    return new CameraError('unknown', `Could not start the camera: ${e?.message ?? e}`, e);
  }
}

// ───────────────────────────── 2. POSE ESTIMATOR (MediaPipe) ─────────────────────────────

const VISION_VERSION = '0.10.14';
const VISION_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';

/**
 * Wraps MediaPipe's PoseLandmarker. Any object with { init(), detect(video, tsMs), dispose() }
 * returning { landmarks, worldLandmarks } (33 points each) can replace this class.
 */
export class MediaPipePoseEstimator {
  constructor({ variant = 'lite', modelUrl = null, delegate = 'GPU', visionUrl = VISION_CDN } = {}) {
    this.modelUrl = modelUrl ?? `${MODEL_BASE}/pose_landmarker_${variant}/float16/1/pose_landmarker_${variant}.task`;
    this.delegate = delegate;
    this.visionUrl = visionUrl;
    this.landmarker = null;
  }

  async init() {
    if (this.landmarker) return;
    const vision = await import(/* @vite-ignore */ `${this.visionUrl}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${this.visionUrl}/wasm`);
    const make = (delegate) => vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: this.modelUrl, delegate },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try { this.landmarker = await make(this.delegate); }
    catch (e) {                                   // GPU delegate unavailable (older phones, headless…)
      console.warn('[BodyTracker] GPU delegate failed, falling back to CPU', e);
      this.delegate = 'CPU';
      this.landmarker = await make('CPU');
    }
  }

  detect(video, timestampMs) {
    const r = this.landmarker.detectForVideo(video, timestampMs);
    const landmarks = r.landmarks?.[0];
    if (!landmarks) return null;
    return { landmarks, worldLandmarks: r.worldLandmarks?.[0] ?? null };
  }

  dispose() { this.landmarker?.close?.(); this.landmarker = null; }
}

// ───────────────────────────── 3. SMOOTHING (One-Euro filter) ─────────────────────────────

const alphaOf = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff) / dt);

/** Adaptive low-pass: heavy smoothing when still (kills jitter), light when moving fast (low latency). */
class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: 0 });
  }
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max(t - this.t, 1e-3);
    this.t = t;
    this.dx += alphaOf(this.dCutoff, dt) * ((v - this.x) / dt - this.dx);
    this.x += alphaOf(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (v - this.x);
    return this.x;
  }
}

class LandmarkSmoother {
  constructor({ minCutoff = 1.0, beta = 8 } = {}) { this.opts = { minCutoff, beta }; this.f = []; }
  reset() { this.f = []; }
  smooth(points, t) {
    return points.map((p, i) => {
      const f = (this.f[i] ??= [0, 1, 2].map(() => new OneEuro(this.opts.minCutoff, this.opts.beta)));
      return { x: f[0].filter(p.x, t), y: f[1].filter(p.y, t), z: f[2].filter(p.z ?? 0, t), visibility: p.visibility ?? 1 };
    });
  }
}

// ───────────────────────────── 4. POSE ANALYZER (pure math) ─────────────────────────────

export const DEFAULT_ANALYZER_CONFIG = Object.freeze({
  mirror: true,
  minVisibility: 0.5,
  // Pedals — fallbacks used until calibrate() has recorded your personal rest pose
  restKneeAngle: 172,        // deg; knee angle with foot resting on the floor (straight leg ≈ 170–178)
  restLegDrop: 1.5,          // (ankleY - hipY) / torsoLength with foot resting
  pedalKneeRange: 30,        // deg of extra knee flexion = pedal fully pressed
  pedalLiftRange: 0.30,      // torso-lengths of foot lift = pedal fully pressed
  pedalPressThreshold: 0.12, // press >= this → "pressing"
  pedalDownThreshold: 0.65,  // press >= this → "down"
  brakeSweep: 0.35,          // right foot moving this many hip-widths toward the body centre selects BRAKE
  restFootLateral: 0.0,
  // Hands
  wheelTiltDeadband: 0,      // deg
  handsRaisedMargin: 0.15,   // wrists this many torso-lengths above shoulders = "raised"
  handsLoweredMargin: 0.75,  // wrists this many torso-lengths below shoulders = "lowered"
});

/**
 * Turns one frame of landmarks into the structured poseData payload.
 * Stateless apart from the calibration and the brake-zone latch, so it's trivially unit-testable.
 */
export class PoseAnalyzer {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_ANALYZER_CONFIG, ...config };
    this.calibration = null;
    this._brakeLatched = false;
  }

  setCalibration(c) { this.calibration = c; }

  /**
   * @param {{landmarks:Array, worldLandmarks?:Array, timestamp?:number, aspect?:number}} frame
   *   landmarks: 33 × {x,y,z,visibility} in the camera's NATIVE (un-mirrored) normalized space.
   *   aspect: videoWidth / videoHeight, used to make x and y distances comparable.
   */
  analyze({ landmarks, worldLandmarks = null, timestamp = 0, aspect = 4 / 3 }) {
    const cfg = this.cfg, cal = this.calibration ?? {};
    const sx = cfg.mirror ? -1 : 1;

    // User-space copies (x mirrored so "right" really is the user's right on a mirrored preview).
    const u = landmarks.map((p) => ({ x: cfg.mirror ? 1 - p.x : p.x, y: p.y, z: p.z ?? 0, visibility: p.visibility ?? 1 }));
    // Metric 3D for angles. Fall back to aspect-corrected normalized coords if world landmarks are missing.
    const w = worldLandmarks
      ? worldLandmarks.map((p) => ({ x: sx * p.x, y: p.y, z: p.z ?? 0 }))
      : landmarks.map((p) => ({ x: sx * p.x * aspect, y: p.y, z: (p.z ?? 0) * aspect }));

    const ok = (...ids) => ids.every((i) => u[i].visibility >= cfg.minVisibility);
    const dist2 = (a, b) => Math.hypot((u[b].x - u[a].x) * aspect, u[b].y - u[a].y);
    const { leftShoulder: LS, rightShoulder: RS, leftElbow: LE, rightElbow: RE, leftWrist: LW, rightWrist: RW,
      leftHip: LH, rightHip: RH, leftKnee: LK, rightKnee: RK, leftAnkle: LA, rightAnkle: RA } = LM;

    // Body-relative scale references (so results don't depend on how far you stand from the camera)
    const shoulderMidX = (u[LS].x + u[RS].x) / 2;
    const shoulderY = (u[LS].y + u[RS].y) / 2;
    const hipY = (u[LH].y + u[RH].y) / 2;
    const shoulderW = Math.max(dist2(LS, RS), 0.05);
    const hipW = Math.max(dist2(LH, RH), 0.03);
    const torso = Math.max(hipY - shoulderY, 0.08);

    const upperBody = ok(LS, RS, LW, RW);
    const lowerBody = ok(LH, RH, LK, RK, LA, RA);
    const vis = [LS, RS, LW, RW, LH, RH, LK, RK, LA, RA].map((i) => u[i].visibility);

    // ── Joint angles (3D, degrees) ──
    const ang = (a, b, c) => (ok(a, b, c) ? round(angle3(w[a], w[b], w[c]), 1) : null);
    const angles = {
      leftElbow: ang(LS, LE, LW), rightElbow: ang(RS, RE, RW),
      leftKnee: ang(LH, LK, LA), rightKnee: ang(RH, RK, RA),
      leftHip: ang(LS, LH, LK), rightHip: ang(RS, RH, RK),
      shoulderTilt: ok(LS, RS) ? round(toDeg(Math.atan2(u[RS].y - u[LS].y, (u[RS].x - u[LS].x) * aspect)), 1) : null,
      wristLine: null,   // filled below (the "steering wheel" angle)
    };

    // ── Hands / steering ──
    const meas = { handAngleDeg: null, handOffset: null, kneeAngle: {}, legDrop: {}, footLateral: {} };
    const hands = { state: 'lost', visible: false, wheelAngleDeg: 0, lateral: 0, separation: 0, turn: 'center', center: null };
    const lw = ok(LW), rw = ok(RW);
    if (lw && rw) {
      const dx = (u[RW].x - u[LW].x) * aspect, dy = u[RW].y - u[LW].y;
      let a = toDeg(Math.atan2(dy, dx));                  // 0 = level; + = right hand lower = clockwise = steer right
      if (a > 90) a -= 180; else if (a < -90) a += 180;   // hands crossed over: fold back into ±90°
      const cx = (u[LW].x + u[RW].x) / 2, cy = (u[LW].y + u[RW].y) / 2;
      const rawOffset = ((cx - shoulderMidX) * aspect) / shoulderW;       // hand-centre vs body-centre, in shoulder widths
      meas.handAngleDeg = a; meas.handOffset = rawOffset;
      angles.wristLine = round(a - (cal.wheelAngleRest ?? 0), 1);

      const rel = (cy - shoulderY) / torso;               // 0 at shoulders, 1 at hips
      const separation = Math.hypot(dx, dy) / shoulderW;
      let state = 'free';
      if (rel < -cfg.handsRaisedMargin) state = 'raised';
      else if (rel > cfg.handsLoweredMargin) state = 'lowered';
      else if (separation > 0.45 && separation < 2.6) state = 'wheel';

      const angle = a - (cal.wheelAngleRest ?? 0);
      Object.assign(hands, {
        state, visible: true, wheelAngleDeg: round(angle, 1), lateral: round(rawOffset - (cal.handOffset ?? 0), 3),
        separation: round(separation, 2), center: { x: round(cx), y: round(cy) },
        turn: angle > 12 ? 'right' : angle < -12 ? 'left' : 'center',
      });
    } else if (lw || rw) {
      hands.state = 'partial';
    }

    // ── Legs / pedals ──
    const leg = (side) => {
      const [H, K, A] = side === 'left' ? [LH, LK, LA] : [RH, RK, RA];
      if (!ok(H, K, A)) return { visible: false, press: 0, state: 'unknown', kneeAngle: null, lateral: 0 };
      const knee = angle3(w[H], w[K], w[A]);
      const drop = (u[A].y - u[H].y) / torso;
      const lateral = ((u[A].x - u[H].x) * aspect) / hipW;       // + = foot outward on its own side for the right leg is +, see brake logic
      meas.kneeAngle[side] = knee; meas.legDrop[side] = drop; meas.footLateral[side] = lateral;
      const restK = cal.restKnee?.[side] ?? cfg.restKneeAngle;
      const restD = cal.restDrop?.[side] ?? cfg.restLegDrop;
      const flex = clamp((restK - knee) / cfg.pedalKneeRange, 0, 1);   // knee bends as the foot comes up/forward
      const lift = clamp((restD - drop) / cfg.pedalLiftRange, 0, 1);   // ankle rises toward the hip
      const press = Math.max(flex, lift);
      return {
        visible: true, press: round(press, 3), flex: round(flex, 3), lift: round(lift, 3),
        state: press >= cfg.pedalDownThreshold ? 'down' : press >= cfg.pedalPressThreshold ? 'pressing' : 'up',
        kneeAngle: round(knee, 1), lateral: round(lateral, 3),
      };
    };
    const L = leg('left'), R = leg('right');

    // Right foot picks BRAKE vs ACCELERATOR by sweeping toward the body centre (brake pedal sits left of the throttle).
    const restLat = cal.restLateral ?? cfg.restFootLateral;
    if (R.visible) {
      if (R.press < cfg.pedalPressThreshold) this._brakeLatched = false;
      else if (R.lateral < restLat - cfg.brakeSweep) this._brakeLatched = true;
      else if (R.lateral > restLat - cfg.brakeSweep * 0.4) this._brakeLatched = false;
    } else this._brakeLatched = false;

    const accelerator = R.visible && !this._brakeLatched ? R.press : 0;
    const brake = R.visible && this._brakeLatched ? R.press : 0;
    const clutch = L.visible ? L.press : 0;
    const active = [];
    if (accelerator >= cfg.pedalPressThreshold) active.push('accelerator');
    if (brake >= cfg.pedalPressThreshold) active.push('brake');
    if (clutch >= cfg.pedalPressThreshold) active.push('clutch');

    const named = (arr, withVis) => Object.fromEntries(Object.entries(PAYLOAD_NAMES).map(([n, i]) => [n, {
      x: round(arr[i].x), y: round(arr[i].y), z: round(arr[i].z), ...(withVis ? { visibility: round(arr[i].visibility, 2) } : {}),
    }]));

    return {
      schema: 'bodytracker/1',
      timestamp, valid: true, aspect: round(aspect, 3),
      quality: { score: round(vis.reduce((s, v) => s + v, 0) / vis.length, 2), upperBody, lowerBody },
      calibrated: !!this.calibration,
      landmarks: named(u, true),
      world: named(w, false),
      angles,
      gestures: {
        handsPosition: hands.state,                   // 'wheel' | 'raised' | 'lowered' | 'free' | 'partial' | 'lost'
        hands,
        pedalState: {
          left: L, right: R,
          rightFootZone: this._brakeLatched ? 'brake' : 'accelerator',
          accelerator: round(accelerator, 3), brake: round(brake, 3), clutch: round(clutch, 3),
          active,                                     // e.g. ['clutch', 'accelerator']
        },
      },
      measurements: meas,                             // raw, uncalibrated — used by calibrate()
    };
  }

  /** Same shape as analyze() but "nobody there"; lets consumers skip null checks. */
  emptyPose(timestamp = 0) {
    const z = { visible: false, press: 0, state: 'unknown', kneeAngle: null, lateral: 0 };
    return {
      schema: 'bodytracker/1', timestamp, valid: false, aspect: null,
      quality: { score: 0, upperBody: false, lowerBody: false }, calibrated: !!this.calibration,
      landmarks: null, world: null,
      angles: { leftElbow: null, rightElbow: null, leftKnee: null, rightKnee: null, leftHip: null, rightHip: null, shoulderTilt: null, wristLine: null },
      gestures: {
        handsPosition: 'lost',
        hands: { state: 'lost', visible: false, wheelAngleDeg: 0, lateral: 0, separation: 0, turn: 'center', center: null },
        pedalState: { left: z, right: z, rightFootZone: 'accelerator', accelerator: 0, brake: 0, clutch: 0, active: [] },
      },
      measurements: null,
    };
  }
}

// ───────────────────────────── 5. BODY TRACKER (orchestrator) ─────────────────────────────

/**
 * Events: 'pose' (poseData), 'status' ({status, detail}), 'error' (Error), 'calibration' ({phase, progress}).
 * status: 'idle' → 'starting' → 'running' → 'stopped' | 'error'
 */
export class BodyTracker {
  /**
   * @param {object} o
   * @param {HTMLVideoElement} [o.video]            existing <video>; created by CameraManager if omitted
   * @param {CameraManager|null} [o.camera]         pass null to feed frames yourself (file, remote stream, tests)
   * @param {object|null} [o.estimator]             pass null for headless use with processFrame()
   * @param {number} [o.maxFps=30]
   * @param {{minCutoff:number,beta:number}} [o.smoothing]
   * @param {object} [o.analyzer]                   PoseAnalyzer config overrides
   */
  constructor({ video = null, camera, estimator, maxFps = 30, smoothing = {}, analyzer = {} } = {}) {
    this.events = new Emitter();
    this.camera = camera === undefined ? (typeof document !== 'undefined' ? new CameraManager({ video }) : null) : camera;
    this.video = this.camera?.video ?? video;
    this.estimator = estimator === undefined ? new MediaPipePoseEstimator() : estimator;
    this.analyzer = new PoseAnalyzer(analyzer);
    this.smoother = new LandmarkSmoother(smoothing);
    this.worldSmoother = new LandmarkSmoother(smoothing);
    this.maxFps = maxFps;
    this.status = 'idle';
    this.lastPose = null;
    this.fps = 0;
    this._frame = 0;
    this._running = false;
    this._calibrating = false;
    this._lastRun = 0;
    this._lastVideoTime = -1;
    this._lostSince = null;
  }

  // ── subscription API ──
  /** Subscribe to live pose data. Returns an unsubscribe function. */
  onPose(cb) { return this.events.on('pose', cb); }
  on(evt, cb) { return this.events.on(evt, cb); }
  off(evt, cb) { this.events.off(evt, cb); }

  // ── lifecycle ──
  async start() {
    if (this._running) return;
    this._setStatus('starting');
    try {
      // Camera permission prompt and model download run in parallel to shorten the wait.
      const jobs = await Promise.allSettled([this.camera?.start(), this.estimator?.init()]);
      const failed = jobs.find((j) => j.status === 'rejected');
      if (failed) throw failed.reason;
    } catch (err) {
      this.camera?.stop();
      this._setStatus('error', err);
      this.events.emit('error', err);
      throw err;
    }
    this._running = true;
    this._setStatus('running');
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.camera?.stop();
    this.smoother.reset(); this.worldSmoother.reset();
    this._setStatus('stopped');
  }

  async switchCamera() { return this.camera?.switchCamera(); }

  _setStatus(status, detail = null) {
    this.status = status;
    this.events.emit('status', { status, detail });
  }

  _tick = (t) => {
    if (!this._running) return;
    this._raf = requestAnimationFrame(this._tick);
    const v = this.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    if (t - this._lastRun < 1000 / this.maxFps - 1) return;
    if (v.currentTime === this._lastVideoTime) return;            // no new camera frame yet
    this._lastVideoTime = v.currentTime;
    this._lastRun = t;
    let det = null;
    try { det = this.estimator.detect(v, t); }
    catch (e) { this.events.emit('error', e); return; }
    this.processFrame(det?.landmarks ?? null, det?.worldLandmarks ?? null, t, v.videoWidth / v.videoHeight);
  };

  /**
   * Feed one frame of landmarks (or null when nobody was detected). Used by the internal loop,
   * but public so you can drive the tracker from tests, recorded data, or another estimator.
   */
  processFrame(landmarks, worldLandmarks, timestampMs, aspect = 4 / 3) {
    const dt = this._prevTs ? timestampMs - this._prevTs : 0;
    this._prevTs = timestampMs;
    if (dt > 0) this.fps = this.fps ? this.fps * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;

    let pose;
    if (!landmarks) {
      if (this._lostSince == null) this._lostSince = timestampMs;
      if (timestampMs - this._lostSince > 500) { this.smoother.reset(); this.worldSmoother.reset(); }
      pose = this.analyzer.emptyPose(timestampMs);
    } else {
      this._lostSince = null;
      const t = timestampMs / 1000;
      pose = this.analyzer.analyze({
        landmarks: this.smoother.smooth(landmarks, t),
        worldLandmarks: worldLandmarks ? this.worldSmoother.smooth(worldLandmarks, t) : null,
        timestamp: timestampMs, aspect,
      });
    }
    pose.frame = ++this._frame;
    pose.fps = round(this.fps, 1) ?? 0;
    pose.calibrating = this._calibrating;
    this.lastPose = pose;
    this.events.emit('pose', pose);
    return pose;
  }

  /** Re-broadcast a poseData object that was produced elsewhere (e.g. received over a WebRTC data channel). */
  injectPose(poseData) { this.lastPose = poseData; this.events.emit('pose', poseData); }

  // ── calibration ──
  getCalibration() { return this.analyzer.calibration; }
  setCalibration(c) { this.analyzer.setCalibration(c); }
  resetCalibration() { this.analyzer.setCalibration(null); }

  /**
   * Record the user's neutral driving pose: both feet resting on the floor, hands in the wheel position.
   * Needs the whole body in view. Resolves { ok, calibration? , reason? }.
   */
  calibrate({ durationMs = 2500, minSamples = 15 } = {}) {
    if (this._calibrating) return Promise.resolve({ ok: false, reason: 'Calibration already running.' });
    this._calibrating = true;
    const samples = [];
    const t0 = now();
    this.events.emit('calibration', { phase: 'start', progress: 0 });

    return new Promise((resolve) => {
      let off, timer;
      const finish = () => {
        off(); clearTimeout(timer);
        this._calibrating = false;
        const m = (pick) => median(samples.map(pick));
        const ok = samples.length >= minSamples;
        if (!ok) {
          const reason = `Only ${samples.length} clear frames captured. Make sure your whole body (hands to feet) is visible and hold still.`;
          this.events.emit('calibration', { phase: 'failed', progress: 1, reason });
          return resolve({ ok: false, reason });
        }
        const calibration = {
          version: 1, createdAt: Date.now(),
          restKnee: { left: m((s) => s.kneeAngle.left), right: m((s) => s.kneeAngle.right) },
          restDrop: { left: m((s) => s.legDrop.left), right: m((s) => s.legDrop.right) },
          restLateral: m((s) => s.footLateral.right),
          handOffset: m((s) => s.handOffset),
          wheelAngleRest: m((s) => s.handAngleDeg),
        };
        this.analyzer.setCalibration(calibration);
        this.events.emit('calibration', { phase: 'done', progress: 1, calibration });
        resolve({ ok: true, calibration });
      };
      off = this.onPose((p) => {
        const elapsed = now() - t0;
        const m = p.measurements;
        if (p.valid && p.quality.upperBody && p.quality.lowerBody && m
          && m.kneeAngle.left != null && m.kneeAngle.right != null && m.handAngleDeg != null) samples.push(m);
        this.events.emit('calibration', { phase: 'progress', progress: Math.min(1, elapsed / durationMs), samples: samples.length });
        if (elapsed >= durationMs) finish();
      });
      timer = setTimeout(finish, durationMs + 4000);     // safety net if frames stop arriving
    });
  }
}

export default BodyTracker;
