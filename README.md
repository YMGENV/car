# Body Drive

A 3D driving simulator you control with your body. Hands steer, feet work the pedals. Pose tracking is a standalone, reusable library (`BodyTracker.js`) built on MediaPipe Pose; the simulator is Three.js.

```
BodyTracker.js   Camera manager + MediaPipe estimator + smoothing + analyzer + events  (no rendering/UI code)
Vehicle.js       Physics: engine, clutch, gearbox, drag, brakes, bicycle-model steering
World.js         Infinite procedural road, sunset sky, trees, posts, mountains
Models.js        Car, steering wheel, pedals, cockpit (all procedural)
Controls.js      poseData / keyboard → steer, throttle, brake, clutch (the only place with mapping logic)
Simulator.js     Scene, cameras, per-frame loop, 3D wheel + pedal HUD
main.js          Wiring and DOM UI
index.html         Page, styles, on-screen instructions, camera error handling
*.test.mjs         Unit tests for the analyzer and physics (node --test)
```

## Run it

You need a modern browser and an internet connection (Three.js, the MediaPipe runtime and the pose model load from CDNs on first start).

**Option A, no install** (desktop; `localhost` counts as a secure context so the camera works):
```bash
cd car
python3 -m http.server 8080        # or: npx serve .
# open http://localhost:8080
```

**Option B, Vite:**
```bash
npm install
npm run dev                        # http://localhost:5173
```

**Phone as the camera/screen:** phones only allow camera access over HTTPS.
```bash
npm run dev:phone                  # self-signed HTTPS on your LAN
# on the phone (same Wi-Fi): https://<computer-LAN-IP>:5173  → accept the certificate warning once
```
Prop the phone ~2–3 m away at hip height, in landscape, so your whole body is in view.

**Tests:** `npm test` (no dependencies needed beyond Node 20+).

## Setup & controls

1. Get your whole body (hands to feet) into the camera view, 2–3 m away.
2. Click **Start with camera**, allow access, then press **C** and hold your driving pose for the countdown: hands as if gripping a wheel, both feet flat. Calibration is saved in the browser; redo it whenever you move.

| Input | Body | Keyboard |
|---|---|---|
| Steer | Tilt your hands like turning a wheel, and/or slide them left/right | ← → / A D |
| Throttle | Lift right foot (knee up) | ↑ / W |
| Brake | Lift right foot **and sweep it toward your body centre** (the brake sits left of the throttle) | ↓ / S |
| Clutch | Lift left foot | Shift / Z / Space |

Other keys: **V** cockpit/chase view · **T** gearbox mode · **Q/E** shift (manual mode) · **C** calibrate · **R** reset · **H** debug panel · **Y** toggle stalling.

**Gearbox modes** (T): *assisted* (default: press the clutch and the box picks the right gear for your speed), *manual* (clutch + Q/E, otherwise it grinds), *auto* (clutch ignored). Letting the clutch out gradually launches smoothly; dumping it is abrupt. With stalling on (Y), dumping it at a standstill in a high gear stalls the engine and the clutch restarts it. There is no reverse gear.

## Using the tracker on its own

```js
import { BodyTracker } from './BodyTracker.js';

const tracker = new BodyTracker({ video: document.querySelector('video') });
const stop = tracker.onPose((p) => {
  p.gestures.handsPosition;          // 'wheel' | 'raised' | 'lowered' | 'free' | 'partial' | 'lost'
  p.gestures.hands.wheelAngleDeg;    // + = clockwise (steer right)
  p.gestures.pedalState;             // { accelerator, brake, clutch, active: [...], left, right }
  p.angles.rightKnee;                // degrees; also elbows, hips, shoulderTilt
  p.landmarks.rightAnkle;            // {x,y,z,visibility}, mirrored "user space"
});
await tracker.start();               // throws CameraError (.code) on permission/camera problems
await tracker.calibrate();           // → { ok, calibration }
```

- **`poseData`** is plain JSON (`schema: 'bodytracker/1'`). To use a phone as a remote sensor, send it over a WebRTC data channel (`onPose(p => channel.send(JSON.stringify(p)))`) and call `tracker.injectPose(JSON.parse(msg))` on the receiving side.
- **Headless:** `new BodyTracker({ camera: null, estimator: null })` and feed landmarks with `tracker.processFrame(...)`. This is how the tests work.
- **Swap the estimator:** anything with `init()`, `detect(video, ts)` and `dispose()` returning 33 `landmarks` + `worldLandmarks` works.
- **Events:** `'pose'`, `'status'`, `'error'`, `'calibration'` via `tracker.on(name, cb)`.

## Tuning

Mapping gains (full-lock angle, deadzones, expo, pedal gain) are in `DEFAULT_MAPPING` in `Controls.js`. Pedal thresholds and ranges are in `DEFAULT_ANALYZER_CONFIG` in `BodyTracker.js`; pass overrides with `new BodyTracker({ analyzer: { pedalKneeRange: 40 } })`. Press **H** to watch the live values.

## Troubleshooting

- **Camera blocked / not found / in use:** the start screen shows what happened and how to fix it. Keyboard-only mode always works.
- **"Camera needs a secure page":** use `localhost` or HTTPS (see the phone instructions).
- **Pose model failed to load:** the runtime comes from `cdn.jsdelivr.net` and the model from `storage.googleapis.com`; check your connection or any content blocker.
- **Pedals twitch or stick on:** recalibrate (C), make sure feet are visible, and keep lighting even. Camera at hip height works best; a camera looking steeply down shortens the legs and hides foot lift.
- **Low frame rate:** the lite model with the GPU delegate is the default; MediaPipe falls back to CPU automatically.

## Known limits

Single front-on camera depth is estimated, so foot/knee motion toward the camera is the least precise signal; calibration and the knee-angle + ankle-lift blend compensate for it. No traffic, collisions or reverse gear.
