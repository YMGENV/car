/**
 * main.js — wires BodyTracker → InputMapper → Simulator and drives the DOM UI.
 * (The tracker never sees the simulator and the simulator never sees the tracker.)
 */
import { BodyTracker, CameraError } from './BodyTracker.js';
import { Simulator } from './Simulator.js';
import { InputMapper } from './Controls.js';

const $ = (id) => document.getElementById(id);
const CAL_KEY = 'bodydrive.calibration.v1';
const store = {
  get() { try { return JSON.parse(localStorage.getItem(CAL_KEY)); } catch { return null; } },
  set(v) { try { localStorage.setItem(CAL_KEY, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ───────────────────────────── core objects ─────────────────────────────
let sim;
try { sim = new Simulator($('scene')); }
catch (e) {
  console.error(e);
  document.body.innerHTML = '<div style="position:fixed;inset:0;display:grid;place-items:center;padding:24px;text-align:center;background:#0b0d12;color:#fff;font:18px/1.5 system-ui,sans-serif"><div><h1>3D graphics unavailable</h1><p>Body Drive needs WebGL. Enable hardware acceleration in your browser settings, or try a current version of Chrome, Edge, Safari or Firefox.</p></div></div>';
  throw e;
}
const mapper = new InputMapper();
mapper.attachKeyboard();
let tracker = null;
let lastPose = null;
let calibrating = false;
window.app = { sim, mapper, get tracker() { return tracker; }, set tracker(t) { tracker = t; } };   // handy in devtools

// ───────────────────────────── toasts ─────────────────────────────
let toastTimer;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg; el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2200);
}

// ───────────────────────────── start screen & camera errors ─────────────────────────────
function showError(err) {
  const box = $('camError');
  let title = 'Could not start tracking', tip = err?.message ?? String(err);
  if (err instanceof CameraError) {
    const tips = {
      'permission-denied': 'Click the camera icon in the address bar, allow access, then press Retry.',
      'insecure-context': 'Browsers only allow cameras on https:// or http://localhost. On a phone, use the HTTPS dev server (see README).',
      'not-found': 'Plug in a webcam, or use the keyboard instead.',
      'in-use': 'Close other apps/tabs that are using the camera.',
      'unsupported': 'Try a current version of Chrome, Edge, Safari or Firefox.',
    };
    title = 'Camera problem';
    tip = `${err.message} ${tips[err.code] ?? ''}`.trim();
  } else {
    title = 'Pose model failed to load';
    tip = `${tip} — the model and MediaPipe runtime download from cdn.jsdelivr.net and storage.googleapis.com, so an internet connection is required.`;
  }
  box.innerHTML = '';
  const h = document.createElement('strong'); h.textContent = title;
  const p = document.createElement('span'); p.textContent = tip;
  box.append(h, p);
  box.hidden = false;
}

function closeStart() { $('start').classList.add('gone'); }

$('btnCamera').addEventListener('click', async () => {
  $('camError').hidden = true;
  const btn = $('btnCamera');
  btn.disabled = true; btn.textContent = 'Starting camera…';
  tracker?.stop();
  tracker = new BodyTracker({ video: $('camVideo') });
  tracker.onPose(onPose);
  tracker.on('status', ({ status }) => { $('trackState').dataset.state = status; });
  tracker.on('calibration', onCalibrationEvent);
  const saved = store.get();
  if (saved) tracker.setCalibration(saved);
  try {
    await tracker.start();
    $('camBox').hidden = false;
    closeStart();
    toast(saved ? 'Camera ready — saved calibration loaded (C to redo)' : 'Camera ready — press C to calibrate', 'ok');
  } catch (err) {
    console.error(err);
    tracker = null;
    showError(err);
  } finally {
    btn.disabled = false; btn.textContent = 'Retry with camera';
  }
});
$('btnKeys').addEventListener('click', () => { closeStart(); toast('Keyboard mode — arrows/WASD, Shift = clutch'); });
$('btnSwitch').addEventListener('click', async () => {
  try { await tracker?.switchCamera(); } catch (e) { toast(e.message, 'warn'); }
});
$('btnCalibrate').addEventListener('click', () => runCalibration());
function toggleView() { const m = sim.toggleCamera(); document.body.dataset.view = m; toast(`${m} view`); }
$('btnCamView').addEventListener('click', toggleView);
$('btnHelp').addEventListener('click', () => $('start').classList.remove('gone'));

// ───────────────────────────── pose → mapper + overlay ─────────────────────────────
const BONES = [
  ['leftShoulder', 'rightShoulder'], ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
  ['leftShoulder', 'leftHip'], ['rightShoulder', 'rightHip'], ['leftHip', 'rightHip'],
  ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'], ['leftAnkle', 'leftFoot'],
  ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'], ['rightAnkle', 'rightFoot'],
];
const overlay = $('camOverlay'), octx = overlay.getContext('2d');

function onPose(p) {
  lastPose = p;
  mapper.setPose(p);
  drawPose(p);
}

function drawPose(p) {
  const vid = $('camVideo');
  const W = overlay.width = vid.clientWidth || 200, H = overlay.height = vid.clientHeight || 150;
  octx.clearRect(0, 0, W, H);
  if (!p.valid) return;
  const ped = p.gestures.pedalState, L = p.landmarks;
  const colour = (a, b) => {
    if (a.startsWith('left') && ['Hip', 'Knee', 'Ankle', 'Foot'].some((s) => a.includes(s)) && ped.clutch > 0.15) return '#4d8dff';
    if (a.startsWith('right') && ['Knee', 'Ankle', 'Foot'].some((s) => a.includes(s)) && (ped.brake > 0.15 || ped.accelerator > 0.15)) return ped.brake > ped.accelerator ? '#ff4d4d' : '#3ddc84';
    return 'rgba(255,230,190,0.85)';
  };
  octx.lineWidth = 3; octx.lineCap = 'round';
  for (const [a, b] of BONES) {
    if (L[a].visibility < 0.5 || L[b].visibility < 0.5) continue;
    octx.strokeStyle = colour(a, b);
    octx.beginPath(); octx.moveTo(L[a].x * W, L[a].y * H); octx.lineTo(L[b].x * W, L[b].y * H); octx.stroke();
  }
  for (const k of ['leftWrist', 'rightWrist']) {
    if (L[k].visibility < 0.5) continue;
    octx.fillStyle = '#ffb454'; octx.beginPath(); octx.arc(L[k].x * W, L[k].y * H, 6, 0, 7); octx.fill();
  }
  const h = p.gestures.hands;
  if (h.visible) {                                          // the virtual wheel line between the wrists
    octx.strokeStyle = '#ffb454'; octx.lineWidth = 2; octx.setLineDash([5, 4]);
    octx.beginPath(); octx.moveTo(L.leftWrist.x * W, L.leftWrist.y * H); octx.lineTo(L.rightWrist.x * W, L.rightWrist.y * H); octx.stroke();
    octx.setLineDash([]);
  }
}

function hints(p) {
  if (!tracker) return [];
  if (!p) return ['Starting…'];
  if (!p.valid) return ['No person detected — step into view'];
  const out = [];
  if (!p.quality.lowerBody) out.push('Feet not visible — step back or tilt the camera down');
  if (!p.quality.upperBody) out.push('Show both hands');
  else if (p.gestures.handsPosition !== 'wheel') out.push('Hold both hands out as if gripping a wheel');
  if (!p.calibrated) out.push('Press C to calibrate your driving pose');
  return out;
}

// ───────────────────────────── calibration ─────────────────────────────
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCalibration() {
  if (!tracker) { toast('Calibration needs the camera — click "Start with camera" first', 'warn'); return; }
  if (calibrating) return;
  calibrating = true;
  const ov = $('calib'), txt = $('calibText'), bar = $('calibBar');
  ov.classList.add('show'); bar.style.width = '0%';
  txt.innerHTML = 'Sit or stand in your driving pose.<br><b>Hands as on a wheel, both feet flat on the floor.</b>';
  for (let n = 3; n >= 1; n--) { $('calibCount').textContent = n; await wait(1000); }
  $('calibCount').textContent = '●';
  txt.innerHTML = '<b>Hold still…</b>';
  const res = await tracker.calibrate({ durationMs: 2500 });
  ov.classList.remove('show');
  calibrating = false;
  if (res.ok) { store.set(res.calibration); toast('Calibrated — your rest pose is now zero', 'ok'); }
  else toast(res.reason, 'warn');
}
function onCalibrationEvent(e) { if (e.phase === 'progress') $('calibBar').style.width = `${Math.round(e.progress * 100)}%`; }

// ───────────────────────────── keyboard actions ─────────────────────────────
mapper.onAction = (name) => {
  const v = sim.vehicle;
  switch (name) {
    case 'shiftUp': if (v.mode !== 'manual') toast('Shift keys only work in manual mode (T)'); else v.requestShift(+1, mapper.out.clutch); break;
    case 'shiftDown': if (v.mode !== 'manual') toast('Shift keys only work in manual mode (T)'); else v.requestShift(-1, mapper.out.clutch); break;
    case 'mode': toast(`Transmission: ${v.cycleMode()}`); break;
    case 'camera': toggleView(); break;
    case 'calibrate': runCalibration(); break;
    case 'reset': sim.reset(); toast('Car reset'); break;
    case 'debug': $('debug').hidden = !$('debug').hidden; break;
    case 'stall': v.stallEnabled = !v.stallEnabled; toast(`Stalling ${v.stallEnabled ? 'ON (realistic)' : 'OFF'}`); break;
  }
};

// ───────────────────────────── HUD (DOM) ─────────────────────────────
const el = { speed: $('speed'), gear: $('gear'), rpm: $('rpmFill'), mode: $('modeTxt'), tip: $('tip'), hints: $('hints'), src: $('src'), dbg: $('debug'), fps: $('fps') };
const MODE_NAMES = { assisted: 'ASSISTED', manual: 'MANUAL', auto: 'AUTO' };
let hudAcc = 0;

function updateHud(dt, input) {
  hudAcc += dt;
  if (hudAcc < 0.06) return;
  hudAcc = 0;
  const v = sim.vehicle;
  el.speed.textContent = Math.round(v.kmh);
  el.gear.textContent = v.engineOn ? v.gear : '—';
  const f = Math.min(1, v.rpm / v.p.redline);
  el.rpm.style.width = `${(f * 100).toFixed(0)}%`;
  el.rpm.classList.toggle('hot', f > 0.85);
  el.mode.textContent = MODE_NAMES[v.mode];
  el.src.textContent = `steer: ${input.sources.steer} · pedals: ${input.sources.pedals}`;

  let tip = '';
  if (!v.engineOn) tip = 'ENGINE STALLED — press the clutch to restart';
  else if (v.offRoad) tip = 'OFF ROAD — steer back onto the asphalt';
  else if (v.mode === 'assisted' && v.rpm > 5600 && input.throttle > 0.4 && v.gear < 5) tip = 'High revs — press the clutch to shift up';
  else if (v.mode === 'assisted' && v.rpm < 1500 && input.throttle > 0.5 && v.gear > 1) tip = 'Lugging — press the clutch to shift down';
  else if (v.mode === 'manual' && v.rpm > 5800 && v.gear < 5) tip = 'Shift up: clutch + E';
  el.tip.textContent = tip; el.tip.classList.toggle('on', !!tip);

  if (tracker) {
    const hs = hints(lastPose);
    el.hints.innerHTML = '';
    for (const h of hs) { const li = document.createElement('li'); li.textContent = h; el.hints.append(li); }
    el.fps.textContent = lastPose?.fps ? `${Math.round(lastPose.fps)} fps` : '';
  }
  if (!el.dbg.hidden) {
    const p = lastPose, g = p?.gestures, ped = g?.pedalState;
    el.dbg.textContent = [
      `hands     ${g?.handsPosition ?? '-'}  tilt ${g?.hands.wheelAngleDeg ?? '-'}°  shift ${g?.hands.lateral ?? '-'}  sep ${g?.hands.separation ?? '-'}`,
      `knees     L ${p?.angles.leftKnee ?? '-'}°  R ${p?.angles.rightKnee ?? '-'}°`,
      `pedals    clutch ${ped?.clutch ?? 0}  brake ${ped?.brake ?? 0}  throttle ${ped?.accelerator ?? 0}  zone ${ped?.rightFootZone ?? '-'}`,
      `inputs    steer ${input.steer.toFixed(2)}  thr ${input.throttle.toFixed(2)}  brk ${input.brake.toFixed(2)}  clu ${input.clutch.toFixed(2)}`,
      `car       ${v.kmh.toFixed(0)} km/h  rpm ${v.rpm.toFixed(0)}  gear ${v.gear}  lat ${v.latAcc.toFixed(1)}  engage ${v.engagement.toFixed(2)}`,
      `tracker   ${tracker?.status ?? 'off'}  calibrated ${p?.calibrated ?? false}  ${p?.fps ?? 0} fps`,
    ].join('\n');
  }
}

// ───────────────────────────── main loop ─────────────────────────────
let prev = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - prev) / 1000);
  prev = now;
  const input = mapper.read(dt);
  sim.update(dt, input);
  for (const e of sim.events) {
    if (e === 'grind') toast('GRIND — press the clutch before shifting', 'warn');
    else if (e === 'stall') toast('ENGINE STALLED', 'warn');
    else if (e === 'restart') toast('Engine restarted', 'ok');
  }
  sim.render();
  updateHud(dt, input);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
