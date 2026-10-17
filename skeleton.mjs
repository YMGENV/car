// Synthetic skeleton generator for tests: builds 33 MediaPipe-style landmarks (normalized + world)
// for a person facing the camera. Coordinates are authored in USER space (x grows to the user's right,
// in "height units"), then converted to the camera's native, un-mirrored space like a real estimator returns.
import { LM } from './BodyTracker.js';

export function makeSkeleton({
  aspect = 4 / 3,
  handsTiltDeg = 0,     // + = right hand lower (clockwise wheel turn)
  handsShift = 0,       // hand-centre shift in height-units, + = to the user's right
  rightKneeFlex = 0,    // deg of knee flexion (foot coming up)
  leftKneeFlex = 0,
  rightFootSweep = 0,   // height-units, + = toward the user's left (body centre)
  hidden = [],          // landmark indices with visibility 0
} = {}) {
  const pts = Array.from({ length: 33 }, () => ({ hx: 0, y: 0.5, z: 0, v: 1 }));
  const set = (i, hx, y, z = 0) => { pts[i] = { hx, y, z, v: 1 }; };

  set(LM.nose, 0, 0.16); set(LM.leftEar, -0.04, 0.16); set(LM.rightEar, 0.04, 0.16);
  set(LM.leftShoulder, -0.1, 0.3); set(LM.rightShoulder, 0.1, 0.3);
  set(LM.leftElbow, -0.13, 0.42); set(LM.rightElbow, 0.13, 0.42);
  set(LM.leftHip, -0.07, 0.55); set(LM.rightHip, 0.07, 0.55);

  // Hands: 9-and-3 wheel grip at chest height, 0.30 apart, rotated by handsTiltDeg about their midpoint
  const half = 0.15, a = (handsTiltDeg * Math.PI) / 180;
  const cx = handsShift, cy = 0.42;
  set(LM.leftWrist, cx - half * Math.cos(a), cy - half * Math.sin(a), -0.1);
  set(LM.rightWrist, cx + half * Math.cos(a), cy + half * Math.sin(a), -0.1);

  // Legs: thigh straight down, shin rotated forward (toward camera) by `flex`
  const leg = (side, flex, sweep) => {
    const s = side === 'left' ? -1 : 1;
    const hipX = s * 0.07, kneeY = 0.75, shin = 0.18, f = (flex * Math.PI) / 180;
    const ankleY = kneeY + shin * Math.cos(f), ankleZ = -shin * Math.sin(f);
    const H = side === 'left' ? LM.leftHip : LM.rightHip;
    const K = side === 'left' ? LM.leftKnee : LM.rightKnee;
    const A = side === 'left' ? LM.leftAnkle : LM.rightAnkle;
    const F = side === 'left' ? LM.leftFoot : LM.rightFoot;
    set(K, hipX, kneeY, ankleZ * 0.1);
    set(A, hipX - sweep, ankleY, ankleZ);
    set(F, hipX - sweep, ankleY + 0.03, ankleZ - 0.02);
    return H;
  };
  leg('left', leftKneeFlex, 0);
  leg('right', rightKneeFlex, rightFootSweep);

  const S = 1.75; // metres per height-unit for world landmarks
  const landmarks = pts.map((p, i) => ({
    x: 0.5 - p.hx / aspect, y: p.y, z: p.z, visibility: hidden.includes(i) ? 0 : p.v,
  }));
  // World landmarks: metric, hip-centred. Authored in user space then mirrored like the real thing (x sign flip).
  const worldLandmarks = pts.map((p) => ({ x: -p.hx * S, y: (p.y - 0.55) * S, z: p.z * S, visibility: 1 }));
  return { landmarks, worldLandmarks, aspect };
}
