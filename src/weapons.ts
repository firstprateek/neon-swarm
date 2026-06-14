import * as THREE from 'three/webgpu';
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
