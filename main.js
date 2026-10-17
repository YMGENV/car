/**
 * main.js — wires BodyTracker → InputMapper → Simulator and drives the DOM UI.
 * (The tracker never sees the simulator and the simulator never sees the tracker.)
 */
import { BodyTracker, CameraError } from './BodyTracker.js';
import { Simulator } from './Simulator.js';
import { InputMapper } from './Controls.js';
import { ViewerLink, PlayerLink, LinkError, normalizeCode, joinUrl, CODE_LEN } from './Link.js';

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
let role = 'solo';          // 'solo' | 'player' (camera → viewer) | 'viewer' (game screen fed by the player)
let link = null;            // PlayerLink / ViewerLink in two-device mode
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
  if (err instanceof LinkError) {
    title = 'Connection problem';
  } else if (err instanceof CameraError) {
    const tips = {
      'permission-denied': 'Click the camera icon in the address bar, allow access, then press Retry.',
      'insecure-context': 'Browsers only allow cameras on https:// or http://localhost. On a phone, use the HTTPS dev server (see README).',
      'not-found': 'Plug in a webcam, or use the keyboard instead.',
      'in-use': 'Close other apps/tabs that are using the camera.',
      'unsupported': 'Try a current version of Chrome, Edge, Safari or Firefox.',
    };
    title = 'Camera problem';
    tip = `${err.message} ${tips[err.code] ?? ''}`.trim();
  } else if (!(err instanceof LinkError)) {
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

async function beginTracking() {
  tracker?.stop();
  tracker = new BodyTracker({ video: $('camVideo') });
  tracker.onPose(onPose);
  tracker.on('status', ({ status }) => { $('trackState').dataset.state = status; });
  tracker.on('calibration', onCalibrationEvent);
  const saved = store.get();
  if (saved) tracker.setCalibration(saved);
  try {
    await tracker.start();
  } catch (err) {
    tracker = null;
    throw err;
  }
  return saved;
}

$('btnCamera').addEventListener('click', async () => {
  $('camError').hidden = true;
  const btn = $('btnCamera');
  btn.disabled = true; btn.textContent = 'Starting camera…';
  role = 'solo'; document.body.dataset.role = 'solo';
  try {
    const saved = await beginTracking();
    $('camBox').hidden = false;
    closeStart();
    toast(saved ? 'Camera ready — saved calibration loaded (C to redo)' : 'Camera ready — press C to calibrate', 'ok');
  } catch (err) {
    console.error(err);
    showError(err);
  } finally {
    btn.disabled = false; btn.textContent = 'Retry with camera';
  }
});

// ───────────────────────────── player / viewer (two-device mode) ─────────────────────────────
function selectMode(m) {
  for (const [k, id] of [['solo', 'Solo'], ['player', 'Player'], ['viewer', 'Viewer']]) {
    $(`mode${id}`).setAttribute('aria-pressed', String(k === m));
    $(`panel${id}`).hidden = k !== m;
  }
  $('camError').hidden = true;
  if (m === 'player') $('joinCode').focus();
}
$('modeSolo').addEventListener('click', () => selectMode('solo'));
$('modePlayer').addEventListener('click', () => selectMode('player'));
$('modeViewer').addEventListener('click', () => selectMode('viewer'));
$('btnClose').addEventListener('click', closeStart);
$('joinCode').addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });

let wakeLock = null;
async function keepAwake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported / denied */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && role !== 'solo' && link) keepAwake(); });

const linkEl = { box: $('link'), state: $('linkState'), code: $('linkCode'), help: $('linkHelp') };
function renderLink({ state, code, lost }) {
  const box = linkEl.box;
  box.hidden = false;
  box.classList.toggle('ok', state === 'connected');
  box.classList.toggle('compact', state === 'connected' || role === 'player');
  linkEl.code.textContent = code ?? '';
  if (role === 'viewer') {
    if (state === 'connected') { linkEl.state.textContent = 'Player connected'; linkEl.help.textContent = ''; }
    else {
      linkEl.state.textContent = lost ? 'Player disconnected — waiting…' : 'Viewer ready — waiting for the player';
      linkEl.help.textContent = 'On the Player phone: open this site, choose Player, enter this code (or use Copy link).';
    }
  } else {
    linkEl.state.textContent = state === 'connected' ? 'Connected to viewer' : state === 'disconnected' ? 'Reconnecting to viewer…' : 'Connecting…';
    linkEl.help.textContent = '';
  }
}
let prevLinkState = null;
function onLinkStatus(s) {
  renderLink(s);
  if (s.state === prevLinkState) return;
  if (role === 'viewer') {
    if (s.state === 'connected') toast('Player connected', 'ok');
    else if (s.state === 'waiting' && prevLinkState === 'connected') { toast('Player disconnected', 'warn'); mapper.setPose(null); lastPose = null; }
    $('trackState').dataset.state = s.state === 'connected' ? 'running' : 'starting';
  } else if (role === 'player') {
    if (s.state === 'disconnected') toast('Lost the viewer — reconnecting…', 'warn');
    else if (s.state === 'connected' && prevLinkState === 'disconnected') toast('Reconnected to viewer', 'ok');
  }
  prevLinkState = s.state;
}

function lockStart() { $('start').classList.add('locked'); }

$('btnJoin').addEventListener('click', async () => {
  const errBox = $('camError');
  errBox.hidden = true;
  const code = normalizeCode($('joinCode').value);
  if (code.length !== CODE_LEN) { showError(new LinkError('code', `Enter the ${CODE_LEN}-character code shown on the Viewer.`)); return; }
  if (!window.Peer) { showError(new LinkError('lib', 'The connection library could not be loaded. Check your internet connection, any content blocker, and reload.')); return; }
  const btn = $('btnJoin');
  btn.disabled = true; btn.textContent = 'Connecting…';
  role = 'player'; document.body.dataset.role = 'player'; prevLinkState = null;
  link?.close();
  link = new PlayerLink({ Peer: window.Peer, code, onStatus: onLinkStatus, onMessage: onPlayerMessage });
  const [cam, con] = await Promise.allSettled([beginTracking(), link.connect()]);
  if (cam.status === 'rejected' || con.status === 'rejected') {
    const err = cam.status === 'rejected' ? cam.reason : con.reason;
    console.error(err);
    tracker?.stop(); tracker = null; link?.close(); link = null;
    role = 'solo'; document.body.dataset.role = 'solo'; linkEl.box.hidden = true;
    showError(err);
    btn.disabled = false; btn.textContent = 'Retry';
    return;
  }
  keepAwake();
  $('camBox').hidden = false;
  lockStart(); closeStart();
  renderLink({ state: 'connected', code });
  toast(store.get() ? 'Connected — saved calibration loaded' : 'Connected — calibrate with the button below (or C on the viewer)', 'ok');
  btn.disabled = false; btn.textContent = 'Connect & start camera';
});

$('btnViewer').addEventListener('click', async () => {
  $('camError').hidden = true;
  if (!window.Peer) { showError(new LinkError('lib', 'The connection library could not be loaded. Check your internet connection, any content blocker, and reload.')); return; }
  const btn = $('btnViewer');
  btn.disabled = true; btn.textContent = 'Starting…';
  role = 'viewer'; document.body.dataset.role = 'viewer'; prevLinkState = null;
  link?.close();
  link = new ViewerLink({ Peer: window.Peer, onStatus: onLinkStatus, onPose: onLinkPose, onMessage: onViewerMessage });
  try {
    await link.open();
  } catch (err) {
    console.error(err);
    link?.close(); link = null; role = 'solo'; document.body.dataset.role = 'solo';
    showError(err);
    btn.disabled = false; btn.textContent = 'Retry';
    return;
  }
  keepAwake();
  $('camBox').hidden = false;
  lockStart(); closeStart();
  btn.disabled = false; btn.textContent = 'Start viewer';
});

$('btnCopy').addEventListener('click', async () => {
  if (!link?.code) return;
  const url = joinUrl(link.code);
  try { await navigator.clipboard.writeText(url); toast('Link copied — open it on the Player phone', 'ok'); }
  catch { toast(url); }
});
$('btnLeave').addEventListener('click', () => { link?.close(); location.assign(location.pathname); });

// Viewer side: receive poses + calibration progress from the player
function onLinkPose(p) {
  lastPose = p;
  mapper.setPose(p);
}
function onViewerMessage(m) {
  if (m.t !== 'calib') return;
  if (m.end) { calibHide(); if (m.ok) toast('Calibrated — your rest pose is now zero', 'ok'); else toast(m.reason || 'Calibration failed', 'warn'); }
  else if (m.progress != null) $('calibBar').style.width = `${Math.round(m.progress * 100)}%`;
  else if (m.hold) calibShow('●', '<b>Hold still…</b>');
  else if (m.n) calibShow(m.n, 'Get in your driving pose.<br><b>Hands as on a wheel, both feet flat on the floor.</b>');
}
// Player side: commands from the viewer
function onPlayerMessage(m) { if (m.t === 'cmd' && m.c === 'calibrate') runCalibration(); }

// ?join=CODE (link from the viewer's "Copy link") opens straight on the Player tab
{
  const j = normalizeCode(new URLSearchParams(location.search).get('join'));
  if (j) { selectMode('player'); $('joinCode').value = j; }
}

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
  if (role === 'player') link?.sendPose(p);
  else mapper.setPose(p);
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
  if (role === 'viewer') {
    if (!link?.connected) return ['Waiting for the player phone…'];
    if (!p || performance.now() - mapper.poseAt > 1000) return ['No data from the player phone — is it awake and open?'];
  } else if (!tracker) return [];
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

function calibShow(count, html) { $('calib').classList.add('show'); $('calibCount').textContent = count; $('calibText').innerHTML = html; }
function calibHide() { $('calib').classList.remove('show'); $('calibBar').style.width = '0%'; }

async function runCalibration() {
  if (role === 'viewer') {                                   // the camera is on the player phone: ask it to calibrate
    if (link?.send({ t: 'cmd', c: 'calibrate' })) toast('Calibration started on the player phone');
    else toast('No player connected yet', 'warn');
    return;
  }
  if (!tracker) { toast('Calibration needs the camera — click "Start with camera" first', 'warn'); return; }
  if (calibrating) return;
  calibrating = true;
  const say = (m) => { if (role === 'player') link?.send({ t: 'calib', ...m }); };   // mirror the countdown on the viewer screen
  $('calibBar').style.width = '0%';
  const prep = 'Sit or stand in your driving pose.<br><b>Hands as on a wheel, both feet flat on the floor.</b>';
  for (let n = 3; n >= 1; n--) { calibShow(n, prep); say({ n }); await wait(1000); }
  calibShow('●', '<b>Hold still…</b>'); say({ hold: true });
  const res = await tracker.calibrate({ durationMs: 2500 });
  calibHide();
  calibrating = false;
  say({ end: true, ok: res.ok, reason: res.reason });
  if (res.ok) { store.set(res.calibration); toast('Calibrated — your rest pose is now zero', 'ok'); }
  else toast(res.reason, 'warn');
}
let lastProgressSend = 0;
function onCalibrationEvent(e) {
  if (e.phase !== 'progress') return;
  $('calibBar').style.width = `${Math.round(e.progress * 100)}%`;
  const t = performance.now();
  if (role === 'player' && t - lastProgressSend > 100) { lastProgressSend = t; link?.send({ t: 'calib', progress: e.progress }); }
}

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

  if (tracker || role === 'viewer') {
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
      `tracker   ${role === 'viewer' ? (link?.state ?? 'off') : (tracker?.status ?? 'off')}  calibrated ${p?.calibrated ?? false}  ${p?.fps ?? 0} fps`,
    ].join('\n');
  }
}

// ───────────────────────────── main loop ─────────────────────────────
let prev = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - prev) / 1000);
  prev = now;
  const input = mapper.read(dt);
  if (role === 'player') { updateHud(dt, input); requestAnimationFrame(frame); return; }   // the player phone only tracks
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
