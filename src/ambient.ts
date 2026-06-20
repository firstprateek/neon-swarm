import * as THREE from 'three/webgpu';

/**
 * Ambient ash & embers — a constant-count instanced field of motes that drift and
 * WRAP around the moving top-down camera, so the dead air always feels alive without
 * ever spawning/dying. Cosmetic only (Math.random, never the seeded srand). One draw
 * call, no per-frame allocations. NOT the gameplay Particles pool (that's a
 * gravity/life burst pool that would fight its cap during heavy combat).
 *
 * Grey-brown ash rises slowly (<0.75 luminance → reads as haze); amber embers fall +
 * flicker (>0.75 → they bloom). Flicker is done via instance SCALE so instanceColor
 * is written exactly once, at construction.
 */
const HALF = 42;             // box half-extent in x/z around the camera
const Y_LO = 0.4, Y_HI = 13; // visible air column under the steep top-down cam
const EMBER_FRAC = 0.3;

export class AmbientMotes {
  readonly mesh: THREE.InstancedMesh;
  readonly max: number;
  count = 0;
  private px: Float32Array; private py: Float32Array; private pz: Float32Array;
  private vx: Float32Array; private vy: Float32Array; private vz: Float32Array;
  private ph: Float32Array; private base: Float32Array; private ember: Uint8Array;

  constructor(max: number, scene: THREE.Scene) {
    this.max = max;
    const f = () => new Float32Array(max);
    this.px = f(); this.py = f(); this.pz = f(); this.vx = f(); this.vy = f();
    this.vz = f(); this.ph = f(); this.base = f(); this.ember = new Uint8Array(max);

    const geo = new THREE.TetrahedronGeometry(0.22);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);

    const col = this.mesh.instanceColor.array as Float32Array;
    for (let i = 0; i < max; i++) {
      const isEmber = Math.random() < EMBER_FRAC;
      this.ember[i] = isEmber ? 1 : 0;
      this.px[i] = (Math.random() * 2 - 1) * HALF;
      this.pz[i] = (Math.random() * 2 - 1) * HALF;
      this.py[i] = Y_LO + Math.random() * (Y_HI - Y_LO);
      this.ph[i] = Math.random() * Math.PI * 2;
      this.vx[i] = (Math.random() * 2 - 1) * 0.35;
      this.vz[i] = (Math.random() * 2 - 1) * 0.35;
      if (isEmber) { // amber, fall + flicker — blooms
        this.vy[i] = -(0.25 + Math.random() * 0.4); this.base[i] = 0.4 + Math.random() * 0.5;
        col[i * 3] = 1.0; col[i * 3 + 1] = 0.42; col[i * 3 + 2] = 0.1;
      } else {       // grey-brown ash, larger, rise — reads as drifting haze
        this.vy[i] = 0.12 + Math.random() * 0.18; this.base[i] = 0.7 + Math.random() * 0.8;
        col[i * 3] = 0.16; col[i * 3 + 1] = 0.14; col[i * 3 + 2] = 0.11;
      }
    }
    this.mesh.instanceColor.needsUpdate = true; // set ONCE
    this.mesh.count = 0; this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** active mote count for the current quality tier (called from applyQuality) */
  setBudget(n: number): void {
    this.count = Math.min(n, this.max);
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
  }

  update(dt: number, cx: number, cz: number, t: number): void {
    if (this.count === 0) return; // low tier: literally free
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const loX = cx - HALF, hiX = cx + HALF, loZ = cz - HALF, hiZ = cz + HALF, span = HALF * 2;
    for (let i = 0; i < this.count; i++) {
      let x = this.px[i] + this.vx[i] * dt, y = this.py[i] + this.vy[i] * dt, z = this.pz[i] + this.vz[i] * dt;
      if (x < loX) x += span; else if (x > hiX) x -= span; // wrap — never depletes
      if (z < loZ) z += span; else if (z > hiZ) z -= span;
      if (y > Y_HI) y = Y_LO; else if (y < Y_LO) y = Y_HI;
      this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      let s = this.base[i];
      if (this.ember[i]) s *= 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 8 + this.ph[i])); // flicker via scale
      const o = i * 16; m.fill(0, o, o + 16);
      m[o] = m[o + 5] = m[o + 10] = s; m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    }
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, this.count * 16); im.needsUpdate = true;
  }
}
