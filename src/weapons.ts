import * as THREE from 'three/webgpu';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import type { SpatialGrid } from './spatial';
import { HIT_FLASH, type Swarm } from './swarm';
import type { Particles } from './combat';

/**
 * Orbiting blades that circle the player and deal continuous damage to any
 * enemy they overlap. Blade count scales with level; one InstancedMesh draws
 * the whole set. Damage is dps*dt on contact (no per-hit bookkeeping needed).
 */
export class Orbitals {
  level = 0;
  private angle = 0;
  readonly maxBlades: number;
  readonly mesh: THREE.InstancedMesh;
  private readonly bladeR = 0.7;

  constructor(maxBlades: number, scene: THREE.Scene) {
    this.maxBlades = maxBlades;
    const geo = new THREE.OctahedronGeometry(0.55, 0);
    geo.scale(1, 0.4, 0.5); // flatten into a blade
    const mat = new THREE.MeshBasicMaterial({ color: 0x9bf2ff });
    this.mesh = new THREE.InstancedMesh(geo, mat, maxBlades);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  /** blades active at the current level (0 = weapon not acquired) */
  get blades(): number {
    return this.level > 0 ? Math.min(this.maxBlades, this.level + 1) : 0;
  }

  update(dt: number, time: number, px: number, pz: number, swarm: Swarm, grid: SpatialGrid): void {
    const blades = this.blades;
    this.mesh.count = blades;
    this.mesh.visible = blades > 0;
    if (blades === 0) return;

    this.angle += dt * 2.6;
    const radius = 2.9;
    const dps = 15 * this.level;
    const r = this.bladeR;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const { cellStart, indices, dim } = grid;

    for (let b = 0; b < blades; b++) {
      const a = this.angle + (b / blades) * Math.PI * 2;
      const bx = px + Math.cos(a) * radius;
      const bz = pz + Math.sin(a) * radius;

      // spin each blade about Y for flair (yaw = orbit angle + quarter turn)
      const spin = a + Math.PI / 2 + time * 6;
      const cs = Math.cos(spin), sn = Math.sin(spin);
      const o = b * 16;
      m[o] = cs;     m[o + 1] = 0; m[o + 2] = -sn;    m[o + 3] = 0;
      m[o + 4] = 0;  m[o + 5] = 1; m[o + 6] = 0;      m[o + 7] = 0;
      m[o + 8] = sn; m[o + 9] = 0; m[o + 10] = cs;    m[o + 11] = 0;
      m[o + 12] = bx; m[o + 13] = 0.9; m[o + 14] = bz; m[o + 15] = 1;

      // damage overlapping enemies via the shared spatial grid
      const cx = grid.cellX(bx), cz = grid.cellZ(bz);
      for (let gz = cz > 0 ? cz - 1 : 0; gz <= (cz < dim - 1 ? cz + 1 : cz); gz++) {
        for (let gx = cx > 0 ? cx - 1 : 0; gx <= (cx < dim - 1 ? cx + 1 : cx); gx++) {
          const c = gz * dim + gx;
          for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
            const j = indices[k];
            if (j >= swarm.count || swarm.hp[j] <= 0) continue;
            const ddx = swarm.posX[j] - bx, ddz = swarm.posZ[j] - bz;
            const minD = swarm.radius[j] + r;
            if (ddx * ddx + ddz * ddz < minD * minD) {
              swarm.hp[j] -= dps * dt;
              swarm.flash[j] = HIT_FLASH;
              // light knockback outward from the player
              const pdx = swarm.posX[j] - px, pdz = swarm.posZ[j] - pz;
              const pd = Math.sqrt(pdx * pdx + pdz * pdz) + 1e-6;
              swarm.posX[j] += (pdx / pd) * 8 * dt;
              swarm.posZ[j] += (pdz / pd) * 8 * dt;
            }
          }
        }
      }
    }

    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges();
    im.addUpdateRange(0, blades * 16);
    im.needsUpdate = true;
  }
}

/**
 * Arc Tesla: on a fixed cooldown, strikes the nearest enemy and chains to
 * successive nearest un-hit neighbors, dealing instant damage at each node.
 * Bright bolt segments are pooled as oriented thin boxes that fade out.
 */
export class Tesla {
  level = 0;
  private cd = 0;
  readonly segMax: number;
  private segCount = 0;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly fx: Float32Array;
  private readonly fz: Float32Array;
  private readonly tx: Float32Array;
  private readonly tz: Float32Array;
  readonly mesh: THREE.InstancedMesh;
  private readonly chainRange = 7;
  private readonly hitScratch: number[] = [];

  constructor(segMax: number, scene: THREE.Scene) {
    this.segMax = segMax;
    this.life = new Float32Array(segMax);
    this.maxLife = new Float32Array(segMax);
    this.fx = new Float32Array(segMax);
    this.fz = new Float32Array(segMax);
    this.tx = new Float32Array(segMax);
    this.tz = new Float32Array(segMax);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xddffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, segMax);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  get chains(): number {
    return this.level > 0 ? this.level + 1 : 0;
  }

  private addSegment(fx: number, fz: number, tx: number, tz: number): void {
    if (this.segCount >= this.segMax) return;
    const i = this.segCount++;
    this.fx[i] = fx; this.fz[i] = fz; this.tx[i] = tx; this.tz[i] = tz;
    this.maxLife[i] = this.life[i] = 0.18;
  }

  private removeSegment(i: number): void {
    const last = --this.segCount;
    if (i !== last) {
      this.fx[i] = this.fx[last]; this.fz[i] = this.fz[last];
      this.tx[i] = this.tx[last]; this.tz[i] = this.tz[last];
      this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last];
    }
  }

  /** nearest living enemy to (x,z) within range, excluding already-hit slots */
  private nearestUnhit(x: number, z: number, swarm: Swarm, grid: SpatialGrid): number {
    const { cellStart, indices, dim } = grid;
    const cx = grid.cellX(x), cz = grid.cellZ(z);
    const range2 = this.chainRange * this.chainRange;
    let best = -1, bestD2 = range2;
    // search a 5x5 block so the chain can reach across a couple of cells
    for (let gz = Math.max(0, cz - 2); gz <= Math.min(dim - 1, cz + 2); gz++) {
      for (let gx = Math.max(0, cx - 2); gx <= Math.min(dim - 1, cx + 2); gx++) {
        const c = gz * dim + gx;
        for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
          const j = indices[k];
          if (j >= swarm.count || swarm.hp[j] <= 0 || this.hitScratch.includes(j)) continue;
          const dx = swarm.posX[j] - x, dz = swarm.posZ[j] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; best = j; }
        }
      }
    }
    return best;
  }

  private strike(px: number, pz: number, swarm: Swarm, grid: SpatialGrid, particles: Particles): void {
    let cur = swarm.nearest(px, pz);
    if (cur < 0) return;
    const dmg = 11 * this.level;
    const chains = this.chains;
    let fromX = px, fromZ = pz;
    this.hitScratch.length = 0;

    for (let c = 0; c < chains && cur >= 0; c++) {
      const ex = swarm.posX[cur], ez = swarm.posZ[cur];
      swarm.hp[cur] -= dmg;
      swarm.flash[cur] = HIT_FLASH;
      this.hitScratch.push(cur);
      this.addSegment(fromX, fromZ, ex, ez);
      particles.burst(ex, swarm.radius[cur] + 0.2, ez, new THREE.Color(0xddffff), 5, 7);
      fromX = ex; fromZ = ez;
      cur = this.nearestUnhit(ex, ez, swarm, grid);
    }
  }

  update(dt: number, px: number, pz: number, swarm: Swarm, grid: SpatialGrid, particles: Particles): void {
    // fire on cooldown
    if (this.level > 0) {
      this.cd -= dt;
      if (this.cd <= 0 && swarm.count > 0) {
        this.cd = 1.1;
        this.strike(px, pz, swarm, grid, particles);
      }
    }

    // age + render bolt segments as oriented, thinning boxes
    const m = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = this.segCount - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.removeSegment(i); continue; }
      const fade = this.life[i] / this.maxLife[i];
      const dx = this.tx[i] - this.fx[i], dz = this.tz[i] - this.fz[i];
      const L = Math.sqrt(dx * dx + dz * dz) + 1e-6;
      const ux = dx / L, uz = dz / L;
      const t = 0.13 * fade;
      const o = i * 16;
      // local X -> full segment vector; local Z -> in-plane perpendicular; local Y -> up
      m[o] = dx;        m[o + 1] = 0; m[o + 2] = dz;        m[o + 3] = 0;
      m[o + 4] = 0;     m[o + 5] = t; m[o + 6] = 0;         m[o + 7] = 0;
      m[o + 8] = -uz * t; m[o + 9] = 0; m[o + 10] = ux * t; m[o + 11] = 0;
      m[o + 12] = (this.fx[i] + this.tx[i]) * 0.5;
      m[o + 13] = 1.0;
      m[o + 14] = (this.fz[i] + this.tz[i]) * 0.5;
      m[o + 15] = 1;
    }

    this.mesh.count = this.segCount;
    this.mesh.visible = this.segCount > 0;
    if (this.segCount > 0) {
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, this.segCount * 16);
      im.needsUpdate = true;
    }
  }
}

/** colour a primitive in place (position+color only) for merging into a drone body */
function tintPart(g: THREE.BufferGeometry, r: number, gg: number, b: number): THREE.BufferGeometry {
  const ng = g.toNonIndexed();
  g.dispose();
  ng.deleteAttribute('uv'); ng.deleteAttribute('normal');
  const n = ng.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) { c[k * 3] = r; c[k * 3 + 1] = gg; c[k * 3 + 2] = b; }
  ng.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return ng;
}

/**
 * Recon drones: 1–3 companion drones that orbit the player and auto-fire at the
 * nearest enemy. Leveling speeds their fire, then adds occasional AoE missiles,
 * then more drones. Instant-hit (like Tesla) with a short cyan tracer per shot;
 * missiles add an AoE burst. Two InstancedMeshes (bodies + tracers).
 */
export class Drones {
  level = 0;
  readonly maxDrones: number;
  readonly body: THREE.InstancedMesh;
  readonly tracer: THREE.InstancedMesh;
  private orbit = 0;
  private readonly cd: Float32Array;
  private readonly shots: Int32Array;
  private readonly segMax = 48;
  private segCount = 0;
  private readonly life = new Float32Array(this.segMax);
  private readonly mlife = new Float32Array(this.segMax);
  private readonly fx = new Float32Array(this.segMax);
  private readonly fz = new Float32Array(this.segMax);
  private readonly tx = new Float32Array(this.segMax);
  private readonly tz = new Float32Array(this.segMax);
  private readonly tw = new Float32Array(this.segMax);

  constructor(maxDrones: number, scene: THREE.Scene) {
    this.maxDrones = maxDrones;
    this.cd = new Float32Array(maxDrones);
    this.shots = new Int32Array(maxDrones);
    // body: a small quad-rotor (lit frame + glowing cyan core + 4 rotor discs)
    const parts: THREE.BufferGeometry[] = [tintPart(new THREE.BoxGeometry(0.85, 0.2, 0.85), 0.42, 0.46, 0.52)];
    parts.push(tintPart(new THREE.OctahedronGeometry(0.3), 0.5, 0.97, 1.0)); // glowing core
    for (const [ox, oz] of [[0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]])
      parts.push(tintPart(new THREE.CylinderGeometry(0.26, 0.26, 0.07, 8).translate(ox, 0.12, oz), 0.2, 0.22, 0.26));
    const bodyGeo = BufferGeometryUtils.mergeGeometries(parts, false);
    parts.forEach(p => p.dispose());
    this.body = new THREE.InstancedMesh(bodyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), maxDrones);
    this.body.frustumCulled = false; this.body.visible = false;
    this.body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.body);
    // tracers
    this.tracer = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x9bf2ff, toneMapped: false }), this.segMax);
    this.tracer.frustumCulled = false; this.tracer.visible = false;
    this.tracer.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.tracer);
  }

  /** active drones at the current level (0 = not acquired) */
  get drones(): number {
    if (this.level <= 0) return 0;
    return this.level >= 6 ? 3 : this.level >= 5 ? 2 : 1;
  }

  private addTracer(fx: number, fz: number, tx: number, tz: number, w: number): void {
    if (this.segCount >= this.segMax) return;
    const i = this.segCount++;
    this.fx[i] = fx; this.fz[i] = fz; this.tx[i] = tx; this.tz[i] = tz; this.tw[i] = w;
    this.mlife[i] = this.life[i] = 0.12;
  }
  private removeSeg(i: number): void {
    const last = --this.segCount;
    if (i !== last) {
      this.fx[i] = this.fx[last]; this.fz[i] = this.fz[last]; this.tx[i] = this.tx[last]; this.tz[i] = this.tz[last];
      this.tw[i] = this.tw[last]; this.life[i] = this.life[last]; this.mlife[i] = this.mlife[last];
    }
  }

  /** AoE damage in a radius (a drone "missile") via the shared spatial grid */
  private aoe(cx: number, cz: number, R: number, dmg: number, swarm: Swarm, grid: SpatialGrid): void {
    const { cellStart, indices, dim } = grid;
    const gcx = grid.cellX(cx), gcz = grid.cellZ(cz), R2 = R * R;
    for (let gz = Math.max(0, gcz - 2); gz <= Math.min(dim - 1, gcz + 2); gz++) {
      for (let gx = Math.max(0, gcx - 2); gx <= Math.min(dim - 1, gcx + 2); gx++) {
        const c = gz * dim + gx;
        for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
          const j = indices[k];
          if (j >= swarm.count || swarm.hp[j] <= 0) continue;
          const dx = swarm.posX[j] - cx, dz = swarm.posZ[j] - cz;
          if (dx * dx + dz * dz < R2) { swarm.hp[j] -= dmg; swarm.flash[j] = HIT_FLASH; }
        }
      }
    }
  }

  update(dt: number, time: number, px: number, pz: number, swarm: Swarm, grid: SpatialGrid, particles: Particles): void {
    const n = this.drones;
    this.body.count = n; this.body.visible = n > 0;
    if (n > 0) {
      this.orbit += dt * 1.4;
      const fireInt = Math.max(0.16, 0.55 - (this.level - 1) * 0.07); // faster each level
      const dmg = 3 + this.level * 1.6;
      const bm = this.body.instanceMatrix.array as Float32Array;
      for (let d = 0; d < n; d++) {
        const a = this.orbit + (d / n) * Math.PI * 2;
        const dx = px + Math.cos(a) * 5.2, dz = pz + Math.sin(a) * 5.2;
        const dy = 3.1 + Math.sin(time * 3 + d) * 0.18;
        const yaw = a + time * 2, cs = Math.cos(yaw), sn = Math.sin(yaw);
        const o = d * 16;
        bm[o] = cs; bm[o + 1] = 0; bm[o + 2] = -sn; bm[o + 3] = 0;
        bm[o + 4] = 0; bm[o + 5] = 1; bm[o + 6] = 0; bm[o + 7] = 0;
        bm[o + 8] = sn; bm[o + 9] = 0; bm[o + 10] = cs; bm[o + 11] = 0;
        bm[o + 12] = dx; bm[o + 13] = dy; bm[o + 14] = dz; bm[o + 15] = 1;
        this.cd[d] -= dt;
        if (this.cd[d] <= 0 && swarm.count > 0) {
          const target = swarm.nearest(dx, dz);
          if (target >= 0) {
            this.cd[d] = fireInt;
            const ex = swarm.posX[target], ez = swarm.posZ[target];
            if (this.level >= 4 && (++this.shots[d] % 4 === 0)) {        // occasional missile (AoE)
              this.aoe(ex, ez, 5, 28 + this.level * 8, swarm, grid);
              particles.burst(ex, swarm.radius[target] + 0.3, ez, new THREE.Color(1, 0.7, 0.3), 16, 11);
              this.addTracer(dx, dz, ex, ez, 0.32);
            } else {                                                     // single-target shot
              swarm.hp[target] -= dmg; swarm.flash[target] = HIT_FLASH;
              this.addTracer(dx, dz, ex, ez, 0.12);
            }
          } else this.cd[d] = 0.08;
        }
      }
      this.body.instanceMatrix.needsUpdate = true;
    }
    // age + render tracers as flat oriented thinning boxes (y≈1.9)
    const tm = this.tracer.instanceMatrix.array as Float32Array;
    for (let i = this.segCount - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.removeSeg(i); continue; }
      const fade = this.life[i] / this.mlife[i];
      const ddx = this.tx[i] - this.fx[i], ddz = this.tz[i] - this.fz[i];
      const L = Math.sqrt(ddx * ddx + ddz * ddz) + 1e-6;
      const ux = ddx / L, uz = ddz / L, t = this.tw[i] * fade;
      const o = i * 16;
      tm[o] = ddx; tm[o + 1] = 0; tm[o + 2] = ddz; tm[o + 3] = 0;
      tm[o + 4] = 0; tm[o + 5] = t; tm[o + 6] = 0; tm[o + 7] = 0;
      tm[o + 8] = -uz * t; tm[o + 9] = 0; tm[o + 10] = ux * t; tm[o + 11] = 0;
      tm[o + 12] = (this.fx[i] + this.tx[i]) * 0.5; tm[o + 13] = 1.9; tm[o + 14] = (this.fz[i] + this.tz[i]) * 0.5; tm[o + 15] = 1;
    }
    this.tracer.count = this.segCount; this.tracer.visible = this.segCount > 0;
    if (this.segCount > 0) this.tracer.instanceMatrix.needsUpdate = true;
  }
}
