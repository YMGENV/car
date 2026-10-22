# Body Drive

A 3D driving simulator you control with your body. Hands steer, feet work the pedals. Pose tracking is a standalone, reusable library (`BodyTracker.js`) built on MediaPipe Pose; the simulator is Three.js.

```
BodyTracker.js   Camera manager + MediaPipe estimator + smoothing + analyzer + events  (no rendering/UI code)
Vehicle.js       Physics: engine, automatic gearbox, drag, brakes, bicycle-model steering
World.js         Infinite procedural road, sunset sky, trees, posts, mountains
Models.js        Car, steering wheel, pedals, cockpit (all procedural)
Link.js          Player ↔ Viewer link (PeerJS / WebRTC data channel, pairing codes)
Controls.js      poseData / keyboard → steer, throttle, brake (the only place with mapping logic)
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
Prop the phone ~2–3 m away at hip height, in landscape, so your hands, hips and right foot are in view.

**Tests:** `npm test` (no dependencies needed beyond Node 20+).

## Two-device mode: Player + Viewer

On the start screen pick one of three modes:

- **Solo**: one device runs the camera and the game (original behaviour).
- **Viewer**: this screen shows the gameplay. Start it first; it shows a 5-letter code and a *Copy link* button.
- **Player**: the phone that watches your body. Prop it 2–3 m away, choose *Player*, enter the Viewer's code (or open the copied `?join=CODE` link) and press *Connect & start camera*.

The Player runs the camera + MediaPipe tracking and streams only small pose numbers (steering, pedals; no video) to the Viewer over a WebRTC data channel. Calibration is triggered with **C** on the Viewer (the countdown shows on both screens) and is saved on the Player phone. If the connection drops the Player reconnects automatically. A free public PeerJS server is used only to introduce the two devices; use the same Wi-Fi for the most reliable connection. Both screens are kept awake while connected (where the browser supports it).

## Setup & controls

1. Get your hands, hips and right foot into the camera view, 2–3 m away (the left foot is not needed).
2. Click **Start with camera**, allow access, then press **C** and hold your driving pose for the countdown: hands as if gripping a wheel, right foot flat. Calibration is saved in the browser; redo it whenever you move.

| Input | Body | Keyboard |
|---|---|---|
| Steer | Tilt your hands like turning a wheel, and/or slide them left/right | ← → / A D |
| Throttle | Lift right foot (knee up) | ↑ / W |
| Brake | Lift right foot **and sweep it toward your body centre** (the brake sits left of the throttle) | ↓ / S |

Other keys: **V** cockpit/chase view · **C** calibrate · **R** reset · **H** debug panel.

**Gearbox:** automatic. Light throttle shifts up early, hard throttle holds each gear longer, flooring the pedal at cruise kicks down, and braking steps the gearbox down so you can pull away again. There is no clutch and no reverse gear.

## Using the tracker on its own

```js
import { BodyTracker } from './BodyTracker.js';

const tracker = new BodyTracker({ video: document.querySelector('video') });
const stop = tracker.onPose((p) => {
  p.gestures.handsPosition;          // 'wheel' | 'raised' | 'lowered' | 'free' | 'partial' | 'lost'
  p.gestures.hands.wheelAngleDeg;    // + = clockwise (steer right)
  p.gestures.pedalState;             // { accelerator, brake, clutch, active: [...], left, right } (the game ignores clutch)
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
- **Pedals twitch or stick on:** recalibrate (C), make sure your right foot is visible, and keep lighting even. Camera at hip height works best; a camera looking steeply down shortens the legs and hides foot lift.
- **Low frame rate:** the more accurate *full* pose model is the default. If detection can't keep up it switches to the *lite* model by itself (and uses lite if the full model can't be downloaded). MediaPipe also falls back from GPU to CPU automatically.

**Tracking robustness:** pedals use a median filter (one-frame spikes are ignored), landmarks MediaPipe isn't confident about are held instead of jittering, short tracking dropouts (≤ 0.25 s) are ridden through, and only the right leg is required.

## Known limits

Single front-on camera depth is estimated, so foot/knee motion toward the camera is the least precise signal; calibration and the knee-angle + ankle-lift blend compensate for it. No traffic, collisions or reverse gear.

## Auto-pilot, one-hand driving, trip distance

- **Auto-pilot** — lane keeping + cruise control. Tap the big **Auto-pilot** button on the Player phone (or the button / `P` on the game screen). It has no speed limit: it accelerates as fast as the car can go (about 160 km/h) and only brakes when a bend ahead needs it. **Brake** (foot or `↓`) or tap the button again to take over. While it is on the scene gets a blue tint. Code: `Autopilot.js` (tests: `autopilot.test.mjs`).
- **One-hand driving** — show only one hand (held out as if gripping the wheel) and the steering follows it: move it outward to steer toward that side, inward to steer the other way. The hidden hand is ignored. An arm hanging at your side doesn't steer. Code: `hands.single` in `BodyTracker.js`, mapping in `Controls.js`.
- **Trip distance** — top-centre of the game screen; tap it to switch km ⇄ miles. Resets with `R`.
