import * as THREE from 'three/webgpu';
import type { SpatialGrid } from './spatial';

export interface EnemyType {
  hp: number;
  speed: number;
  radius: number;
  dps: number;
  xp: number;
  scale: number;
  color: THREE.Color;
}

export const ENEMY_TYPES: EnemyType[] = [
  { hp: 3,    speed: 7,    radius: 0.5,  dps: 8,  xp: 1,   scale: 1.0,  color: new THREE.Color(0xff3355) },
  { hp: 2,    speed: 11.5, radius: 0.38, dps: 6,  xp: 2,   scale: 0.76, color: new THREE.Color(0xff8822) },
  { hp: 28,   speed: 3.6,  radius: 1.1,  dps: 18, xp: 8,   scale: 2.2,  color: new THREE.Color(0xaa33ff) },
  { hp: 130,  speed: 5,    radius: 1.6,  dps: 30, xp: 30,  scale: 3.2,  color: new THREE.Color(0xffee33) },
  { hp: 1500, speed: 3.1,  radius: 3.4,  dps: 45, xp: 220, scale: 6.8,  color: new THREE.Color(0xff44ff) }, // boss
];

/** index into ENEMY_TYPES for the boss */
export const BOSS_TYPE = 4;

const PLAYER_RADIUS = 0.8;
const BOB_BUCKETS = 64;

/** seconds an enemy flashes white after being hit */
export const HIT_FLASH = 0.09;
/** seconds for a newly spawned enemy to scale up from nothing (spawn telegraph) */
const GROW_T = 0.25;

/**
 * All enemies live in packed structure-of-arrays buffers and render as a
 * single InstancedMesh (one draw call for the entire horde). Dead enemies
 * are swap-removed so the hot loops always run over a dense [0, count) range.
 *
 * The mesh is constructed with count = capacity so the renderer's node graph
 * is built for the full instanced path on the very first draw (the backing
 * matrices are all-zero, which renders as invisible degenerate geometry);
 * from the first spawn on, count tracks the live entity count and the mesh
 * is hidden entirely whenever the pool is empty — count = 0 would otherwise
 * still draw one phantom instance under the WebGPU renderer.
 */
export class Swarm {
  readonly max: number;
  count = 0;

  readonly posX: Float32Array;
  readonly posZ: Float32Array;
  readonly hp: Float32Array;
  readonly maxHp: Float32Array;
  readonly speed: Float32Array;
  readonly radius: Float32Array;
  readonly dps: Float32Array;
  readonly xpv: Float32Array;
  /** id of the last bullet that damaged this enemy (survives compaction) */
  readonly hitBy: Float64Array;
  readonly bob: Uint8Array;
  readonly type: Uint8Array;
  readonly flash: Float32Array;   // hit-flash timer (seconds remaining)
  readonly baseCol: Float32Array; // per-instance base color, to restore after a flash
  readonly age: Float32Array;     // seconds since spawn (drives the scale-in telegraph)
  readonly baseScale: Float32Array; // target render scale per instance

  readonly mesh: THREE.InstancedMesh;
  private readonly pulse = new Float32Array(BOB_BUCKETS);

  constructor(max: number, scene: THREE.Scene) {
    this.max = max;
    this.posX = new Float32Array(max);
    this.posZ = new Float32Array(max);
    this.hp = new Float32Array(max);
    this.maxHp = new Float32Array(max);
    this.speed = new Float32Array(max);
    this.radius = new Float32Array(max);
    this.dps = new Float32Array(max);
    this.xpv = new Float32Array(max);
    this.hitBy = new Float64Array(max);
    this.bob = new Uint8Array(max);
    this.type = new Uint8Array(max);
    this.flash = new Float32Array(max);
    this.baseCol = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.baseScale = new Float32Array(max);

    const geo = new THREE.IcosahedronGeometry(0.5, 0);
    // Lambert (diffuse-only) instead of Standard (full PBR): the swarm is the
    // fragment-overdraw bottleneck when the horde fills the screen — hundreds of
    // instances overlap per pixel, each running the fragment shader. These tiny
    // flat-shaded blobs don't need PBR; Lambert shades far cheaper per fragment.
    const mat = new THREE.MeshLambertMaterial({ flatShading: true });
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

  spawn(typeIdx: number, x: number, z: number, hpOverride?: number): void {
    if (this.count >= this.max) return;
    const i = this.count++;
    const t = ENEMY_TYPES[typeIdx];
    this.posX[i] = x;
    this.posZ[i] = z;
    this.hp[i] = this.maxHp[i] = hpOverride ?? t.hp;
    this.speed[i] = t.speed * (0.9 + Math.random() * 0.2);
    this.radius[i] = t.radius;
    this.dps[i] = t.dps;
    this.xpv[i] = t.xp;
    this.hitBy[i] = 0; // slot may be recycled — forget old bullet ids
    this.bob[i] = (Math.random() * BOB_BUCKETS) | 0;
    this.type[i] = typeIdx;
    this.flash[i] = 0;
    this.age[i] = 0;
    this.baseScale[i] = t.scale;

    const m = this.mesh.instanceMatrix.array as Float32Array;
    const o = i * 16;
    m.fill(0, o, o + 16);
    // start at scale 0 — update() grows it in over GROW_T (spawn telegraph)
    m[o + 12] = x;
    m[o + 13] = t.radius;
    m[o + 14] = z;
    m[o + 15] = 1;

    const col = this.mesh.instanceColor!.array as Float32Array;
    const v = 0.85 + Math.random() * 0.3;
    const cr = Math.min(1, t.color.r * v), cg = Math.min(1, t.color.g * v), cb = Math.min(1, t.color.b * v);
    col[i * 3] = this.baseCol[i * 3] = cr;
    col[i * 3 + 1] = this.baseCol[i * 3 + 1] = cg;
    col[i * 3 + 2] = this.baseCol[i * 3 + 2] = cb;
    this.mesh.instanceColor!.addUpdateRange(0, this.count * 3);
    this.mesh.instanceColor!.needsUpdate = true;

    this.syncDraw();
  }

  /** Swap-remove slot i; the (alive) last enemy moves into it. */
  kill(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.posX[i] = this.posX[last];
      this.posZ[i] = this.posZ[last];
      this.hp[i] = this.hp[last];
      this.maxHp[i] = this.maxHp[last];
      this.speed[i] = this.speed[last];
      this.radius[i] = this.radius[last];
      this.dps[i] = this.dps[last];
      this.xpv[i] = this.xpv[last];
      this.hitBy[i] = this.hitBy[last];
      this.bob[i] = this.bob[last];
      this.type[i] = this.type[last];
      this.flash[i] = this.flash[last];
      this.age[i] = this.age[last];
      this.baseScale[i] = this.baseScale[last];
      this.baseCol.copyWithin(i * 3, last * 3, last * 3 + 3);
      const m = this.mesh.instanceMatrix.array as Float32Array;
      m.copyWithin(i * 16, last * 16, last * 16 + 16);
      const col = this.mesh.instanceColor!.array as Float32Array;
      col.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.mesh.instanceColor!.addUpdateRange(0, this.count * 3);
      this.mesh.instanceColor!.needsUpdate = true;
    }
    this.syncDraw();
  }

  /**
   * Chase the player with local separation so the horde packs instead of
   * stacking. Returns contact damage dealt to the player this frame.
   */
  update(dt: number, time: number, playerX: number, playerZ: number, grid: SpatialGrid): number {
    const { posX, posZ, speed, radius, dps, bob, count, pulse, flash, baseCol, age, baseScale } = this;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const col = this.mesh.instanceColor!.array as Float32Array;
    const { cellStart, indices, dim } = grid;
    let playerDamage = 0;
    let colorDirty = false;

    // 64-entry pulse LUT replaces 20k Math.sin calls for the cosmetic bob
    for (let b = 0; b < BOB_BUCKETS; b++) {
      pulse[b] = 1 + 0.3 * Math.abs(Math.sin(time * 4 + b * ((Math.PI * 2) / BOB_BUCKETS)));
    }

    for (let i = 0; i < count; i++) {
      const x = posX[i], z = posZ[i], r = radius[i];
      const dxp = playerX - x, dzp = playerZ - z;
      const d = Math.sqrt(dxp * dxp + dzp * dzp) + 1e-6;

      const vx = (dxp / d) * speed[i];
      const vz = (dzp / d) * speed[i];

      // Local separation: push away from a few overlapping neighbors.
      // Capped per enemy so worst-case cost stays bounded in dense packs.
      let sepX = 0, sepZ = 0, checked = 0;
      const cx = grid.cellX(x), cz = grid.cellZ(z);
      outer:
      for (let gz = cz > 0 ? cz - 1 : 0; gz <= (cz < dim - 1 ? cz + 1 : cz); gz++) {
        for (let gx = cx > 0 ? cx - 1 : 0; gx <= (cx < dim - 1 ? cx + 1 : cx); gx++) {
          const c = gz * dim + gx;
          for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
            const j = indices[k];
            if (j === i || j >= count) continue;
            const ddx = x - posX[j], ddz = z - posZ[j];
            const minD = r + radius[j];
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 < minD * minD && d2 > 1e-8) {
              const dn = Math.sqrt(d2);
              const push = (minD - dn) / minD;
              sepX += (ddx / dn) * push;
              sepZ += (ddz / dn) * push;
            }
            if (++checked >= 14) break outer;
          }
        }
      }

      const nx = x + (vx + sepX * 10) * dt;
      const nz = z + (vz + sepZ * 10) * dt;
      posX[i] = nx;
      posZ[i] = nz;

      if (d < r + PLAYER_RADIUS) playerDamage += dps[i] * dt;

      // spawn telegraph: scale up from 0 to the target over GROW_T
      age[i] += dt;
      const sc = age[i] < GROW_T ? baseScale[i] * (age[i] / GROW_T) : baseScale[i];

      const o = i * 16;
      m[o] = sc;
      m[o + 5] = sc;
      m[o + 10] = sc;
      m[o + 12] = nx;
      m[o + 13] = r * pulse[bob[i]];
      m[o + 14] = nz;

      // hit-flash: blend toward white while active, snap back to base when done
      if (flash[i] > 0) {
        flash[i] -= dt;
        const tf = flash[i] > 0 ? flash[i] / HIT_FLASH : 0;
        const o3 = i * 3;
        col[o3] = baseCol[o3] + (1 - baseCol[o3]) * tf;
        col[o3 + 1] = baseCol[o3 + 1] + (1 - baseCol[o3 + 1]) * tf;
        col[o3 + 2] = baseCol[o3 + 2] + (1 - baseCol[o3 + 2]) * tf;
        colorDirty = true;
      }
    }

    if (count > 0) {
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, count * 16); // upload only the live slice
      im.needsUpdate = true;
      if (colorDirty) {
        const ic = this.mesh.instanceColor!;
        ic.clearUpdateRanges();
        ic.addUpdateRange(0, count * 3);
        ic.needsUpdate = true;
      }
    }
    return playerDamage;
  }

  /** Compact out hp<=0 enemies; calls back with death position/loot info. */
  sweepDead(onDeath: (x: number, z: number, xp: number, type: number) => void): void {
    for (let i = this.count - 1; i >= 0; i--) {
      if (this.hp[i] <= 0) {
        onDeath(this.posX[i], this.posZ[i], this.xpv[i], this.type[i]);
        this.kill(i);
      }
    }
  }

  /** Linear scan for nearest enemy — runs once per volley, not per frame. */
  nearest(x: number, z: number): number {
    let best = -1, bestD2 = Infinity;
    for (let i = 0; i < this.count; i++) {
      const dx = this.posX[i] - x, dz = this.posZ[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    return best;
  }
}
