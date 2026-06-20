import * as THREE from 'three/webgpu';
import type { SpatialGrid } from './spatial';
import { HIT_FLASH, type Swarm } from './swarm';
import { srand } from './rng';

let nextBulletId = 1;

/**
 * Auto-fired projectiles, pooled and instanced like the swarm.
 * Hits are deduplicated by bullet id stored on the ENEMY (swarm.hitBy),
 * which survives swap-remove compaction on both pools — slot indices don't.
 */
export class Bullets {
  readonly max: number;
  count = 0;
  readonly px: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vz: Float32Array;
  readonly life: Float32Array;
  readonly dmg: Float32Array;
  readonly pierce: Float32Array;
  readonly ids: Float64Array;
  readonly mesh: THREE.InstancedMesh;

  constructor(max: number, scene: THREE.Scene) {
    this.max = max;
    this.px = new Float32Array(max);
    this.pz = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vz = new Float32Array(max);
    this.life = new Float32Array(max);
    this.dmg = new Float32Array(max);
    this.pierce = new Float32Array(max);
    this.ids = new Float64Array(max);

    const geo = new THREE.IcosahedronGeometry(0.16, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xaaffee });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  private syncDraw(): void {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
  }

  fire(x: number, z: number, dirX: number, dirZ: number, speed: number, dmg: number, pierce: number): void {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.px[i] = x;
    this.pz[i] = z;
    this.vx[i] = dirX * speed;
    this.vz[i] = dirZ * speed;
    this.life[i] = 1.6;
    this.dmg[i] = dmg;
    this.pierce[i] = pierce;
    this.ids[i] = nextBulletId++;

    const m = this.mesh.instanceMatrix.array as Float32Array;
    const o = i * 16;
    m.fill(0, o, o + 16);
    m[o] = m[o + 5] = m[o + 10] = 1;
    m[o + 12] = x;
    m[o + 13] = 0.7;
    m[o + 14] = z;
    m[o + 15] = 1;
    this.syncDraw();
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last];
      this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last];
      this.vz[i] = this.vz[last];
      this.life[i] = this.life[last];
      this.dmg[i] = this.dmg[last];
      this.pierce[i] = this.pierce[last];
      this.ids[i] = this.ids[last];
      const m = this.mesh.instanceMatrix.array as Float32Array;
      m.copyWithin(i * 16, last * 16, last * 16 + 16);
    }
    this.syncDraw();
  }

  update(dt: number, swarm: Swarm, grid: SpatialGrid): void {
    const { px, pz, vx, vz, life, dmg, pierce, ids } = this;
    const { cellStart, indices, dim } = grid;
    const m = this.mesh.instanceMatrix.array as Float32Array;

    for (let i = this.count - 1; i >= 0; i--) {
      life[i] -= dt;
      if (life[i] <= 0) { this.remove(i); continue; }

      const ox = px[i], oz = pz[i]; // segment start (pre-move)
      const x = (px[i] += vx[i] * dt);
      const z = (pz[i] += vz[i] * dt);
      const sx = x - ox, sz = z - oz;
      const segLen2 = sx * sx + sz * sz + 1e-12;

      let dead = false;
      const cx = grid.cellX(x), cz = grid.cellZ(z);
      // 3x3 cells around the segment END cover the swept path at any
      // playable dt (worst case step 1.8 + elite radius 1.85 < 2 cells)
      outer:
      for (let gz = cz > 0 ? cz - 1 : 0; gz <= (cz < dim - 1 ? cz + 1 : cz); gz++) {
        for (let gx = cx > 0 ? cx - 1 : 0; gx <= (cx < dim - 1 ? cx + 1 : cx); gx++) {
          const c = gz * dim + gx;
          for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
            const j = indices[k];
            if (j >= swarm.count || swarm.hp[j] <= 0 || swarm.hitBy[j] === ids[i]) continue;
            // swept segment-vs-circle: closest approach of enemy center
            // to the bullet's path this frame (prevents tunneling at low FPS)
            const ex = swarm.posX[j] - ox, ez = swarm.posZ[j] - oz;
            let t = (ex * sx + ez * sz) / segLen2;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const qx = ex - t * sx, qz = ez - t * sz;
            const minD = swarm.radius[j] + 0.25;
            if (qx * qx + qz * qz < minD * minD) {
              swarm.hp[j] -= dmg[i];
              swarm.flash[j] = HIT_FLASH;
              swarm.hitBy[j] = ids[i];
              // fixed knockback impulse, independent of frame rate
              const kb = 0.4 / Math.sqrt(vx[i] * vx[i] + vz[i] * vz[i]);
              swarm.posX[j] += vx[i] * kb;
              swarm.posZ[j] += vz[i] * kb;
              if (--pierce[i] < 0) { dead = true; break outer; }
            }
          }
        }
      }

      if (dead) { this.remove(i); continue; }

      const o = i * 16;
      m[o + 12] = x;
      m[o + 14] = z;
    }

    if (this.count > 0) {
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, this.count * 16);
      im.needsUpdate = true;
    }
  }
}

/** XP gems dropped by dead enemies; magnetized to the player. */
export class Gems {
  readonly max: number;
  count = 0;
  readonly px: Float32Array;
  readonly pz: Float32Array;
  readonly val: Float32Array;
  readonly mesh: THREE.InstancedMesh;

  constructor(max: number, scene: THREE.Scene) {
    this.max = max;
    this.px = new Float32Array(max);
    this.pz = new Float32Array(max);
    this.val = new Float32Array(max);

    const geo = new THREE.OctahedronGeometry(0.26);
    const mat = new THREE.MeshBasicMaterial({ color: 0x44ff99 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  private syncDraw(): void {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
  }

  spawn(x: number, z: number, value: number): void {
    if (this.count >= this.max) {
      // pool exhausted: fold the XP into an existing gem so nothing is lost
      // (gameplay — affects XP distribution, so seeded)
      this.val[(srand() * this.count) | 0] += value;
      return;
    }
    const i = this.count++;
    this.px[i] = x;
    this.pz[i] = z;
    this.val[i] = value;
    this.syncDraw();
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last];
      this.pz[i] = this.pz[last];
      this.val[i] = this.val[last];
      // move the matrix too, or the swapped-in gem renders one frame
      // at the picked-up gem's position (right at the player's feet)
      const m = this.mesh.instanceMatrix.array as Float32Array;
      m.copyWithin(i * 16, last * 16, last * 16 + 16);
    }
    this.syncDraw();
  }

  update(dt: number, time: number, playerX: number, playerZ: number, magnet: number, onPickup: (value: number) => void): void {
    const { px, pz, val } = this;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const cs = Math.cos(time * 3), sn = Math.sin(time * 3);

    for (let i = this.count - 1; i >= 0; i--) {
      const dx = playerX - px[i], dz = playerZ - pz[i];
      const d = Math.sqrt(dx * dx + dz * dz) + 1e-6;

      if (d < 1.3) {
        onPickup(val[i]);
        this.remove(i);
        continue;
      }
      if (d < magnet) {
        const pull = (22 * (1 - d / magnet) + 6) * dt;
        px[i] += (dx / d) * pull;
        pz[i] += (dz / d) * pull;
      }

      const o = i * 16;
      m[o] = cs;      m[o + 1] = 0; m[o + 2] = -sn;     m[o + 3] = 0;
      m[o + 4] = 0;   m[o + 5] = 1; m[o + 6] = 0;       m[o + 7] = 0;
      m[o + 8] = sn;  m[o + 9] = 0; m[o + 10] = cs;     m[o + 11] = 0;
      m[o + 12] = px[i];
      m[o + 13] = 0.45 + Math.sin(time * 4 + i) * 0.1;
      m[o + 14] = pz[i];
      m[o + 15] = 1;
    }

    if (this.count > 0) {
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, this.count * 16);
      im.needsUpdate = true;
    }
  }
}

/**
 * Player-fired homing rockets (the Space ability). Each re-acquires the nearest
 * enemy via a cheap grid-local search, steers toward it, and detonates for area
 * damage on proximity or timeout. Pooled + instanced like everything else.
 */
const MISSILE_TRAIL = new THREE.Color(0xff7a1e); // hot exhaust

export class Missiles {
  readonly max: number;
  count = 0;
  readonly px: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vz: Float32Array;
  readonly life: Float32Array;
  readonly dmg: Float32Array;
  readonly aoe: Float32Array;
  readonly trailAcc: Float32Array; // distance since the last exhaust puff (fps-independent trail)
  readonly homing: Uint8Array;     // 1 = seek nearest in flight; 0 = dumb-fire straight
  readonly mesh: THREE.InstancedMesh;
  private readonly speed = 26;

  constructor(max: number, scene: THREE.Scene) {
    this.max = max;
    this.px = new Float32Array(max);
    this.pz = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vz = new Float32Array(max);
    this.life = new Float32Array(max);
    this.dmg = new Float32Array(max);
    this.aoe = new Float32Array(max);
    this.trailAcc = new Float32Array(max);
    this.homing = new Uint8Array(max);
    // a chunky, bright rocket so it reads clearly streaking across the field
    const geo = new THREE.ConeGeometry(0.45, 1.6, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd24a });
    mat.toneMapped = false; // stay vivid so the bloom pass picks it up
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  private syncDraw(): void { this.mesh.count = this.count; this.mesh.visible = this.count > 0; }

  fire(x: number, z: number, dirX: number, dirZ: number, dmg: number, aoe: number, homing = true): void {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.px[i] = x; this.pz[i] = z;
    this.vx[i] = dirX * this.speed; this.vz[i] = dirZ * this.speed;
    this.life[i] = 2.4; this.dmg[i] = dmg; this.aoe[i] = aoe;
    this.trailAcc[i] = 0;
    this.homing[i] = homing ? 1 : 0;
    this.syncDraw();
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last]; this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last]; this.vz[i] = this.vz[last];
      this.life[i] = this.life[last]; this.dmg[i] = this.dmg[last]; this.aoe[i] = this.aoe[last];
      this.trailAcc[i] = this.trailAcc[last];
      this.homing[i] = this.homing[last];
      // move the matrix too, or the swapped-in missile renders a stale ghost for a frame
      const m = this.mesh.instanceMatrix.array as Float32Array;
      m.copyWithin(i * 16, last * 16, last * 16 + 16);
    }
    this.syncDraw();
  }

  /** grid-local nearest living enemy to (x,z), or -1 */
  private nearestNear(x: number, z: number, swarm: Swarm, grid: SpatialGrid): number {
    const { cellStart, indices, dim } = grid;
    const cx = grid.cellX(x), cz = grid.cellZ(z);
    let best = -1, bestD2 = Infinity;
    for (let gz = Math.max(0, cz - 3); gz <= Math.min(dim - 1, cz + 3); gz++) {
      for (let gx = Math.max(0, cx - 3); gx <= Math.min(dim - 1, cx + 3); gx++) {
        const c = gz * dim + gx;
        for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
          const j = indices[k];
          if (j >= swarm.count || swarm.hp[j] <= 0) continue;
          const dx = swarm.posX[j] - x, dz = swarm.posZ[j] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; best = j; }
        }
      }
    }
    return best;
  }

  /** detonate: area damage to all enemies within aoe of (x,z) */
  private detonate(x: number, z: number, dmg: number, aoe: number, swarm: Swarm, grid: SpatialGrid, particles: Particles, onBoom: (x: number, z: number) => void): void {
    const { cellStart, indices, dim } = grid;
    const cells = Math.ceil(aoe / grid.cellSize) + 1;
    const cx = grid.cellX(x), cz = grid.cellZ(z);
    const a2 = aoe * aoe;
    for (let gz = Math.max(0, cz - cells); gz <= Math.min(dim - 1, cz + cells); gz++) {
      for (let gx = Math.max(0, cx - cells); gx <= Math.min(dim - 1, cx + cells); gx++) {
        const c = gz * dim + gx;
        for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
          const j = indices[k];
          if (j >= swarm.count || swarm.hp[j] <= 0) continue;
          const dx = swarm.posX[j] - x, dz = swarm.posZ[j] - z;
          if (dx * dx + dz * dz <= a2) { swarm.hp[j] -= dmg; swarm.flash[j] = HIT_FLASH; }
        }
      }
    }
    particles.burst(x, 0.6, z, new THREE.Color(0xffd27a), 60, 16);
    onBoom(x, z);
  }

  update(dt: number, swarm: Swarm, grid: SpatialGrid, particles: Particles, onBoom: (x: number, z: number) => void): void {
    const { px, pz, vx, vz, life, dmg, aoe, speed, homing } = this;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = this.count - 1; i >= 0; i--) {
      life[i] -= dt;
      // find the nearest enemy: homing rockets steer toward it; dumb rockets only
      // use it for the proximity-detonation check (they fly straight).
      const tgt = this.nearestNear(px[i], pz[i], swarm, grid);
      if (tgt >= 0) {
        const dx = swarm.posX[tgt] - px[i], dz = swarm.posZ[tgt] - pz[i];
        const d = Math.sqrt(dx * dx + dz * dz) + 1e-6;
        if (homing[i]) {
          const desiredX = (dx / d) * speed, desiredZ = (dz / d) * speed;
          const turn = Math.min(1, dt * 6);
          vx[i] += (desiredX - vx[i]) * turn;
          vz[i] += (desiredZ - vz[i]) * turn;
        }
        // detonate on close approach (both modes)
        if (d < swarm.radius[tgt] + 1.2) {
          this.detonate(px[i], pz[i], dmg[i], aoe[i], swarm, grid, particles, onBoom);
          this.remove(i);
          continue;
        }
      }
      if (life[i] <= 0) {
        this.detonate(px[i], pz[i], dmg[i], aoe[i], swarm, grid, particles, onBoom);
        this.remove(i);
        continue;
      }
      const nx = (px[i] += vx[i] * dt), nz = (pz[i] += vz[i] * dt);
      // lay the +Y cone flat with its tip pointing along the horizontal velocity:
      // local Y -> velocity dir, local Z -> world up, local X -> their cross
      const vlen = Math.sqrt(vx[i] * vx[i] + vz[i] * vz[i]) + 1e-6;
      const ux = vx[i] / vlen, uz = vz[i] / vlen;
      // fiery exhaust trail: a puff every ~0.6 units travelled, dropped at the tail
      this.trailAcc[i] += vlen * dt;
      if (this.trailAcc[i] >= 0.6) {
        this.trailAcc[i] -= 0.6;
        particles.trail(nx - ux * 0.8, 0.7, nz - uz * 0.8, MISSILE_TRAIL, 2);
      }
      const o = i * 16;
      m[o] = -uz; m[o + 1] = 0; m[o + 2] = ux; m[o + 3] = 0;     // col0 = X
      m[o + 4] = ux; m[o + 5] = 0; m[o + 6] = uz; m[o + 7] = 0;  // col1 = Y (tip)
      m[o + 8] = 0; m[o + 9] = 1; m[o + 10] = 0; m[o + 11] = 0;  // col2 = Z (up)
      m[o + 12] = nx; m[o + 13] = 0.7; m[o + 14] = nz; m[o + 15] = 1;
    }
    if (this.count > 0) {
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, this.count * 16);
      im.needsUpdate = true;
    }
  }
}

/** Short-lived explosion shards for kill feedback. */
export class Particles {
  readonly max: number;
  count = 0;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  readonly size: Float32Array;
  readonly mesh: THREE.InstancedMesh;

  constructor(max: number, scene: THREE.Scene) {
    this.max = max;
    this.px = new Float32Array(max);
    this.py = new Float32Array(max);
    this.pz = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vy = new Float32Array(max);
    this.vz = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);

    const geo = new THREE.TetrahedronGeometry(0.15);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  private syncDraw(): void {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
  }

  burst(x: number, y: number, z: number, color: THREE.Color, n: number, speed = 9): void {
    const col = this.mesh.instanceColor!.array as Float32Array;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    for (let s = 0; s < n; s++) {
      if (this.count >= this.max) break;
      const i = this.count++;
      const a = Math.random() * Math.PI * 2;
      const elev = Math.random() * 0.9 + 0.15;
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = Math.cos(a) * sp * (1 - elev * 0.5);
      this.vy[i] = elev * sp;
      this.vz[i] = Math.sin(a) * sp * (1 - elev * 0.5);
      this.maxLife[i] = this.life[i] = 0.35 + Math.random() * 0.45;
      this.size[i] = 0.7 + Math.random() * 1.3;
      col[i * 3] = color.r;
      col[i * 3 + 1] = color.g;
      col[i * 3 + 2] = color.b;
      // write the spawn matrix immediately so a burst is visible even on
      // frames where update() doesn't run (e.g. the death explosion)
      const o = i * 16;
      m.fill(0, o, o + 16);
      m[o] = m[o + 5] = m[o + 10] = this.size[i];
      m[o + 12] = x;
      m[o + 13] = y;
      m[o + 14] = z;
      m[o + 15] = 1;
    }
    this.mesh.instanceColor!.addUpdateRange(0, this.count * 3);
    this.mesh.instanceColor!.needsUpdate = true;
    const im = this.mesh.instanceMatrix;
    im.addUpdateRange(0, this.count * 16);
    im.needsUpdate = true;
    this.syncDraw();
  }

  /** a tight puff of exhaust at a point — used for missile trails (no big spread, slight rise) */
  trail(x: number, y: number, z: number, color: THREE.Color, n: number): void {
    const col = this.mesh.instanceColor!.array as Float32Array;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    for (let s = 0; s < n; s++) {
      if (this.count >= this.max) break;
      const i = this.count++;
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = (Math.random() - 0.5) * 2.2;
      this.vy[i] = Math.random() * 1.4 + 0.2;
      this.vz[i] = (Math.random() - 0.5) * 2.2;
      this.maxLife[i] = this.life[i] = 0.26 + Math.random() * 0.28;
      this.size[i] = 0.6 + Math.random() * 0.7;
      col[i * 3] = color.r;
      col[i * 3 + 1] = color.g;
      col[i * 3 + 2] = color.b;
      const o = i * 16;
      m.fill(0, o, o + 16);
      m[o] = m[o + 5] = m[o + 10] = this.size[i];
      m[o + 12] = x;
      m[o + 13] = y;
      m[o + 14] = z;
      m[o + 15] = 1;
    }
    this.mesh.instanceColor!.addUpdateRange(0, this.count * 3);
    this.mesh.instanceColor!.needsUpdate = true;
    const im = this.mesh.instanceMatrix;
    im.addUpdateRange(0, this.count * 16);
    im.needsUpdate = true;
    this.syncDraw();
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last];
      this.py[i] = this.py[last];
      this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.vz[i] = this.vz[last];
      this.life[i] = this.life[last];
      this.maxLife[i] = this.maxLife[last];
      this.size[i] = this.size[last];
      const m = this.mesh.instanceMatrix.array as Float32Array;
      m.copyWithin(i * 16, last * 16, last * 16 + 16);
      const col = this.mesh.instanceColor!.array as Float32Array;
      col.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.mesh.instanceColor!.addUpdateRange(0, this.count * 3);
      this.mesh.instanceColor!.needsUpdate = true;
    }
    this.syncDraw();
  }

  update(dt: number): void {
    const m = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = this.count - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0 || this.py[i] < 0) { this.remove(i); continue; }
      this.vy[i] -= 14 * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      const s = this.size[i] * (this.life[i] / this.maxLife[i]);
      const o = i * 16;
      m.fill(0, o, o + 16);
      m[o] = m[o + 5] = m[o + 10] = s;
      m[o + 12] = this.px[i];
      m[o + 13] = this.py[i];
      m[o + 14] = this.pz[i];
      m[o + 15] = 1;
    }
    if (this.count > 0) {
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, this.count * 16);
      im.needsUpdate = true;
    }
  }
}
