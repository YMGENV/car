/**
 * RoadPath.js — the deterministic road centre-line (no Three.js, so physics/auto-pilot tests can use it in Node).
 */
export class RoadPath {
  constructor() {
    this.halfWidth = 4.0;       // 2 lanes × 3.6 m + margins
    this.layers = [{ A: 40, L: 140, ph: 0 }, { A: 8, L: 70, ph: 1.3 }, { A: 90, L: 520, ph: 0.7 }];
    this._c0 = this.layers.reduce((a, l) => a + l.A * Math.sin(l.ph), 0);   // so that center(0) === 0
  }
  center(s) { let x = -this._c0; for (const l of this.layers) x += l.A * Math.sin(s / l.L + l.ph); return x; }
  slope(s) { let d = 0; for (const l of this.layers) d += (l.A / l.L) * Math.cos(s / l.L + l.ph); return d; }
  heading(s) { return Math.atan(this.slope(s)); }
}
