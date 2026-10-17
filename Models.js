/**
 * Models.js — procedural 3D models (no external assets): car, steering wheel, pedals, cockpit.
 * Car convention: origin on the ground at the centre, nose toward −z, driver on the left (−x).
 */
import * as THREE from 'three';

const phong = (color, o = {}) => new THREE.MeshPhongMaterial({ color, shininess: 40, ...o });

/** Text on a transparent plane (used for pedal labels). */
export function makeLabel(text, { w = 256, h = 64, size = 40, color = '#ffd9a0', world = 0.5 } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.font = `700 ${size}px "Arial Narrow", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = color; g.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(world, (world * h) / w), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  return m;
}

// ───────────────────────────── steering wheel ─────────────────────────────

/** Faces +z (toward the driver). Call setAngle(rad): + = clockwise as the driver sees it (steer right). */
export function buildSteeringWheel(radius = 0.19) {
  const root = new THREE.Group(), rot = new THREE.Group();
  root.add(rot);
  const dark = phong(0x1b1c20, { shininess: 25 });
  rot.add(new THREE.Mesh(new THREE.TorusGeometry(radius, radius * 0.12, 14, 48), dark));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.27, radius * 0.3, radius * 0.22, 20), phong(0x2c2e35));
  hub.rotation.x = Math.PI / 2; rot.add(hub);
  const spokeH = new THREE.Mesh(new THREE.BoxGeometry(radius * 1.85, radius * 0.13, radius * 0.1), dark);
  const spokeV = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.13, radius * 0.9, radius * 0.1), dark);
  spokeV.position.y = -radius * 0.45;
  rot.add(spokeH, spokeV);
  const mark = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.16, radius * 0.3, radius * 0.2),
    new THREE.MeshBasicMaterial({ color: 0xff4a2a }));
  mark.position.y = radius;                                  // 12 o'clock marker makes rotation obvious
  rot.add(mark);
  return { root, rot, setAngle(rad) { rot.rotation.z = -rad; } };
}

// ───────────────────────────── pedals ─────────────────────────────

/** Hinged pedals. Automatic car: brake + accelerator only. set({brake,accelerator}) with values 0..1. */
export function buildPedals() {
  const root = new THREE.Group();
  const defs = { brake: { x: -0.1, color: 0xff3b3b }, accelerator: { x: 0.1, color: 0x35d070 } };
  const pedals = {};
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.3), phong(0x2a2c34));
  plate.position.set(0, -0.015, -0.02);
  root.add(plate);
  for (const [name, d] of Object.entries(defs)) {
    const pivot = new THREE.Group(); pivot.position.set(d.x, 0.2, 0.06);        // hinge near the top
    const padMat = phong(d.color, { emissive: d.color, emissiveIntensity: 0.12, shininess: 70 });
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.26, 0.035), padMat);
    pad.position.y = -0.1;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.14, 0.025), phong(0x888a92));
    arm.position.y = 0.07;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.014, 0.04), phong(0x111111));
    for (const y of [-0.08, -0.14, -0.2]) { const g = grip.clone(); g.position.set(0, y, 0.002); pivot.add(g); }
    pivot.add(pad, arm);
    root.add(pivot);
    pedals[name] = { pivot, padMat };
  }
  return {
    root, pedals,
    set(values) {
      for (const [name, p] of Object.entries(pedals)) {
        const v = Math.min(1, Math.max(0, values[name] ?? 0));
        p.pivot.rotation.x = v * 0.5;                    // pad swings away from the driver
        p.padMat.emissiveIntensity = 0.12 + v * 0.9;
      }
    },
  };
}

// ───────────────────────────── cockpit ─────────────────────────────

/** Dashboard + steering wheel + a live instrument cluster (canvas texture). Positioned in car space. */
export function buildCockpit() {
  const group = new THREE.Group();
  const dashMat = phong(0x17181c, { shininess: 15 });

  // seats-and-floor deck so the red body shell isn't visible from inside
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.02, 2.2), phong(0x25262b, { shininess: 5 }));
  deck.position.set(0, 0.915, 0.35); group.add(deck);
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.16, 0.75), dashMat);
  dash.position.set(0, 0.99, -0.95); group.add(dash);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), phong(0x2e2f36));
  seat.position.set(-0.4, 0.99, 0.7); group.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.1), phong(0x2e2f36));
  back.position.set(-0.4, 1.28, 0.97); back.rotation.x = -0.15; group.add(back);

  // steering column + wheel, tilted toward the driver
  const wheel = buildSteeringWheel(0.17);
  wheel.root.position.set(-0.4, 1.0, -0.5);
  wheel.root.rotation.x = -0.42;
  group.add(wheel.root);
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.4, 10), dashMat);
  col.rotation.x = Math.PI / 2 - 0.42; col.position.set(-0.4, 0.96, -0.6); group.add(col);

  // instrument cluster
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 192;
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const cluster = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.128), new THREE.MeshBasicMaterial({ map: tex }));
  cluster.position.set(-0.4, 1.12, -0.82); cluster.rotation.x = -0.6; group.add(cluster);

  let last = '';
  function updateCluster({ kmh, gear, rpm, redline = 6500, mode = '' }) {
    const key = `${Math.round(kmh)}|${gear}|${Math.round(rpm / 60)}|${mode}`;
    if (key === last) return; last = key;
    ctx.fillStyle = '#07090c'; ctx.fillRect(0, 0, 512, 192);
    const frac = Math.min(1, rpm / redline);
    for (let i = 0; i < 30; i++) {                                // tach ticks
      const on = i / 30 < frac;
      ctx.fillStyle = on ? (i > 24 ? '#ff4a2a' : '#ffb454') : '#2a2d33';
      ctx.fillRect(16 + i * 16, 14, 11, 26);
    }
    ctx.fillStyle = '#ffe6c2'; ctx.font = '700 92px "Arial Narrow", Arial'; ctx.textAlign = 'left';
    ctx.fillText(String(Math.round(kmh)), 22, 142);
    ctx.font = '600 24px Arial'; ctx.fillStyle = '#9a8f80'; ctx.fillText('km/h', 24, 178);
    ctx.textAlign = 'right'; ctx.fillStyle = '#ffb454'; ctx.font = '700 96px "Arial Narrow", Arial';
    ctx.fillText(String(gear), 488, 142);
    ctx.font = '600 22px Arial'; ctx.fillStyle = '#9a8f80'; ctx.fillText(mode.toUpperCase(), 490, 178);
    tex.needsUpdate = true;
  }

  return { group, wheel, updateCluster, eye: new THREE.Vector3(-0.4, 1.36, 0.3) };
}

// ───────────────────────────── exterior car ─────────────────────────────

export function buildCar() {
  const root = new THREE.Group();          // moved/yawed by the simulator
  const chassis = new THREE.Group();       // pitched/rolled for weight transfer
  root.add(chassis);

  const paint = phong(0xd8322b, { shininess: 110, specular: 0x886655 });
  const tub = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.62, 4.3), paint);
  tub.position.y = 0.6; chassis.add(tub);

  // cabin: trapezoid profile in the (z, y) plane extruded across x, so the roof/screen rake looks like a car
  const prof = new THREE.Shape();
  prof.moveTo(1.6, 0.0); prof.lineTo(0.95, 0.52); prof.lineTo(-0.5, 0.52); prof.lineTo(-1.1, 0.0); prof.closePath();
  const cabinGeo = new THREE.ExtrudeGeometry(prof, { depth: 1.62, bevelEnabled: false });
  cabinGeo.rotateY(-Math.PI / 2); cabinGeo.translate(0.81, 0.91, 0);     // (shape x → z, extrude → x)
  const glass = new THREE.Mesh(cabinGeo, phong(0x0f1a26, { transparent: true, opacity: 0.72, shininess: 150, specular: 0xaaccff }));
  chassis.add(glass);
  // Single-sided plane: seen from outside it's the roof, from inside it's culled so the view isn't blocked by a headliner.
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(1.62, 1.48), paint);
  roof.rotation.x = -Math.PI / 2; roof.position.set(0, 1.432, 0.225); chassis.add(roof);

  // lights
  const head = new THREE.MeshBasicMaterial({ color: 0xfff1cf });
  const tail = new THREE.MeshBasicMaterial({ color: 0xff2a1f });
  for (const x of [-0.62, 0.62]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.05), head); h.position.set(x, 0.72, -2.16); chassis.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.05), tail); t.position.set(x, 0.74, 2.16); chassis.add(t);
  }
  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(1.74, 0.16, 0.1), phong(0x1a1a1d)); bumperF.position.set(0, 0.4, -2.18); chassis.add(bumperF);
  const bumperR = bumperF.clone(); bumperR.position.z = 2.18; chassis.add(bumperR);

  // wheels: pivot (steers) → spin (rolls)
  const tyre = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 24); tyre.rotateZ(Math.PI / 2);
  const tyreMat = phong(0x0e0e10, { shininess: 8 });
  const rimMat = phong(0xb8bcc6, { shininess: 90 });
  const wheels = [];
  for (const [x, z, front] of [[-0.9, -1.38, true], [0.9, -1.38, true], [-0.9, 1.38, false], [0.9, 1.38, false]]) {
    const pivot = new THREE.Group(); pivot.position.set(x, 0.34, z);
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(tyre, tyreMat));
    const hub = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.46, 0.07), rimMat);
    const hub2 = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.07, 0.46), rimMat);
    spin.add(hub, hub2);
    pivot.add(spin); root.add(pivot);                         // wheels stay on the ground (not in the pitched chassis)
    wheels.push({ pivot, spin, front });
  }

  const cockpit = buildCockpit();
  chassis.add(cockpit.group);

  return { root, chassis, wheels, cockpit, bodyMeshes: [tub, roof, glass] };
}
