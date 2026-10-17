/**
 * Simulator.js — Three.js scene, cameras, per-frame update (physics → visuals) and the 3D input HUD.
 *
 * Usage:
 *   const sim = new Simulator(canvas);
 *   // each frame:
 *   sim.update(dt, { steer, throttle, brake, clutch });
 *   sim.render();
 */
import * as THREE from 'three';
import { Vehicle } from './Vehicle.js';
import { World, RoadPath } from './World.js';
import { buildCar, buildSteeringWheel, buildPedals, makeLabel } from './Models.js';

const STEER_VISUAL = 2.3;            // wheel rotation (rad) at full lock ≈ 130°
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Simulator {
  constructor(canvas) {
    this.canvas = canvas;
    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.autoClear = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2600);
    this.path = new RoadPath();
    this.world = new World(this.scene, this.path, renderer);

    this.car = buildCar();
    this.scene.add(this.car.root);
    this.vehicle = new Vehicle();
    this.cameraMode = 'chase';          // 'chase' | 'cockpit'
    this.hudVisible = true;
    this.events = [];
    this.time = 0;
    this._camPos = new THREE.Vector3(); this._camLook = new THREE.Vector3();
    this._camInit = false;

    this._buildHud();
    this.reset();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Second scene rendered into a corner viewport: a big wheel + 3 pedals that visibly follow your inputs. */
  _buildHud() {
    const s = this.hud = new THREE.Scene();
    s.add(new THREE.AmbientLight(0xffffff, 1.1));
    const l = new THREE.DirectionalLight(0xfff0dd, 2.2); l.position.set(-1, 2, 2); s.add(l);

    const panel = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 2.4), new THREE.MeshBasicMaterial({ color: 0x0b0d12, transparent: true, opacity: 0.55 }));
    panel.position.z = -0.6; s.add(panel);

    this.hudWheel = buildSteeringWheel(0.3);
    this.hudWheel.root.position.set(-0.8, 0.12, 0);
    this.hudWheel.root.rotation.x = -0.25;
    s.add(this.hudWheel.root);

    this.hudPedals = buildPedals();
    this.hudPedals.root.position.set(0.66, -0.4, 0);
    this.hudPedals.root.scale.setScalar(1.45);
    this.hudPedals.root.rotation.x = -0.45;
    s.add(this.hudPedals.root);
    for (const [name, x, txt] of [['clutch', -0.2, 'CLUTCH'], ['brake', 0, 'BRAKE'], ['accelerator', 0.2, 'THROTTLE']]) {
      const lab = makeLabel(txt, { size: 34, world: 0.34 });
      lab.position.set(0.66 + x * 1.45, -0.72, 0.3);
      s.add(lab);
    }
    this.hudCam = new THREE.PerspectiveCamera(36, 1.55, 0.1, 20);
    this.hudCam.position.set(0, 0, 2.75);
  }

  reset() {
    this.vehicle.reset({ x: 0, yaw: this.path.heading(0) });
    this._camInit = false;
  }

  toggleCamera() {
    this.cameraMode = this.cameraMode === 'chase' ? 'cockpit' : 'chase';
    this._camInit = false;
    return this.cameraMode;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.size = { w, h };
  }

  /** Advance physics by dt and pose every visual. */
  update(dt, input) {
    const v = this.vehicle, car = this.car;
    this.time += dt;
    v.step(dt, input, this.path);
    this.events = v.events.slice();

    // car transform: world is rendered relative to the car in z, absolute in x
    car.root.position.set(v.x, 0, 0);
    car.root.rotation.y = -v.yaw;
    const bump = v.offRoad ? Math.sin(this.time * 55) * 0.012 * clamp(v.speed / 15, 0, 1.5) : 0;
    car.chassis.position.y = bump;
    car.chassis.rotation.x += (clamp(v.longAcc * 0.0035, -0.05, 0.05) - car.chassis.rotation.x) * Math.min(1, dt * 6);   // squat / dive
    car.chassis.rotation.z += (clamp(v.latAcc * 0.0028, -0.06, 0.06) - car.chassis.rotation.z) * Math.min(1, dt * 6);    // body roll
    for (const w of car.wheels) {
      w.spin.rotation.x = -v.wheelSpin;
      if (w.front) w.pivot.rotation.y = -v.steerAngle * 1.6;                 // exaggerated so steering reads from behind
    }

    // wheel + pedals (cockpit wheel, HUD wheel, HUD pedals)
    const a = v.steerState * STEER_VISUAL;
    car.cockpit.wheel.setAngle(a);
    this.hudWheel.setAngle(a);
    this.hudPedals.set({ clutch: input.clutch, brake: input.brake, accelerator: input.throttle });
    car.cockpit.updateCluster({ kmh: v.kmh, gear: v.engineOn ? v.gear : 'X', rpm: v.rpm, redline: v.p.redline, mode: v.mode });

    this.world.update(v.s, this.camera);
    this._updateCamera(dt);
    car.cockpit.group.visible = true;
  }

  _updateCamera(dt) {
    const v = this.vehicle, cam = this.camera, car = this.car;
    car.root.updateMatrixWorld(true);
    const speedFrac = clamp(v.speed / 50, 0, 1);

    if (this.cameraMode === 'cockpit') {
      const eye = car.cockpit.eye.clone(); eye.x -= v.latAcc * 0.004;
      cam.position.copy(car.chassis.localToWorld(eye));
      cam.lookAt(car.chassis.localToWorld(new THREE.Vector3(-0.4, 1.22, -20)));
      cam.rotation.z += 0;                                     // keep horizon level
      cam.fov += ((78 + speedFrac * 8) - cam.fov) * Math.min(1, dt * 3);
    } else {
      const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
      const targetPos = new THREE.Vector3(v.x - sy * 7.6, 2.9 + speedFrac * 0.3, cy * 7.6);
      const targetLook = new THREE.Vector3(v.x + sy * 10, 1.15, -cy * 10);
      if (!this._camInit) { this._camPos.copy(targetPos); this._camLook.copy(targetLook); this._camInit = true; }
      const k = 1 - Math.exp(-5.5 * dt);
      this._camPos.lerp(targetPos, k); this._camLook.lerp(targetLook, 1 - Math.exp(-9 * dt));
      cam.position.copy(this._camPos);
      if (v.offRoad) cam.position.y += Math.sin(this.time * 60) * 0.015 * clamp(v.speed / 15, 0, 1.5);
      cam.lookAt(this._camLook);
      cam.fov += ((60 + speedFrac * 14) - cam.fov) * Math.min(1, dt * 3);
    }
    cam.updateProjectionMatrix();
  }

  render() {
    const r = this.renderer, { w, h } = this.size;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.clear();
    r.render(this.scene, this.camera);

    if (this.hudVisible) {
      const hw = Math.round(Math.min(360, w * 0.42)), hh = Math.round(hw / 1.55);
      const x = w - hw - 14, y = 14;                            // bottom-right
      r.clearDepth();
      r.setViewport(x, y, hw, hh);
      r.setScissor(x, y, hw, hh);
      r.setScissorTest(true);
      r.render(this.hud, this.hudCam);
      r.setScissorTest(false);
    }
  }
}
