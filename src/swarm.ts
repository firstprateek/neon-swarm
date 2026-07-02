import * as THREE from 'three/webgpu';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import type { SpatialGrid } from './spatial';
import { cellBlocked, nearestFree, type BlockGrid } from './city';
import { srand } from './rng';

/**
 * Procedurally build a low-poly shambling humanoid from merged boxes — a clear
 * zombie silhouette that costs about the same as the old icosahedron and, as
 * ONE merged BufferGeometry, drops straight into the single-InstancedMesh horde
 * (one draw call preserved). Authored vertically centered (feet ≈ y -0.5, head
 * ≈ +0.5, ~1.0 tall) so the existing `m[o+13] = r*pulse` lift plants the feet on
 * the ground for every type (radius = scale*0.5 across all ENEMY_TYPES).
 */
function buildZombieGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, rx: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    parts.push(g);
  };
  // legs — frozen mid-stride (one forward, one back) so the static mesh reads as walking
  box(0.11, 0.40, 0.13, 0, 0.07, -0.30, 0.05);
  box(0.11, 0.40, 0.13, 0, -0.07, -0.30, -0.05);
  // hips
  box(0.30, 0.16, 0.18, 0, 0, -0.14, 0);
  // torso — hunched forward
  box(0.34, 0.42, 0.20, 0.21, 0, 0.07, 0.02);
  // arms — reaching out ahead (classic shamble), slightly asymmetric
  box(0.09, 0.34, 0.10, 0.96, 0.21, 0.12, 0.12);
  box(0.09, 0.34, 0.10, 1.05, -0.21, 0.14, 0.12);
  // head — lolling forward/down
  box(0.20, 0.20, 0.20, 0.26, 0, 0.36, 0.07);

  const merged = BufferGeometryUtils.mergeGeometries(parts, false);
  parts.forEach(p => p.dispose());
  merged.computeVertexNormals();
  return merged;
}

export interface EnemyType {
  hp: number;
  speed: number;
  radius: number;
  dps: number;
  xp: number;
  scale: number;
  color: THREE.Color;
}

// Apocalypse palette: rotten flesh-greens, bruised purples, bile, and a
// radioactive boss. Muted/desaturated so only the player, tracers and the
// mutant boss glow under the warm-dark fog.
export const ENEMY_TYPES: EnemyType[] = [
  { hp: 3,    speed: 7,    radius: 0.5,  dps: 8,  xp: 1,   scale: 1.0,  color: new THREE.Color(0xaec47e) }, // shambler (rotten grey-green)
  { hp: 2,    speed: 11.5, radius: 0.38, dps: 6,  xp: 2,   scale: 0.76, color: new THREE.Color(0xd6dba0) }, // runner (pallid, brighter)
  { hp: 28,   speed: 3.6,  radius: 1.1,  dps: 18, xp: 8,   scale: 2.2,  color: new THREE.Color(0xa98fc4) }, // brute (purple-bruise)
  { hp: 130,  speed: 5,    radius: 1.6,  dps: 30, xp: 30,  scale: 3.2,  color: new THREE.Color(0xd8e46a) }, // heavy (bile/acid)
  { hp: 1500, speed: 3.1,  radius: 3.4,  dps: 45, xp: 220, scale: 6.8,  color: new THREE.Color(0x9bff52) }, // BOSS (radioactive mutant)
];

/** index into ENEMY_TYPES for the boss */
export const BOSS_TYPE = 4;

export const PLAYER_RADIUS = 0.8; // shared with main.ts move-resolve so the player can't clip walls
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
  private blockGrid: BlockGrid | null = null; // city collision; spawns relocate out of buildings
  setBlockGrid(g: BlockGrid | null): void { this.blockGrid = g; }
  // climbable-mountain elevation so enemies render on the slope as they chase you up it
  private climbX = 0; private climbZ = 0; private climbR2 = 0; private climbInvR = 0; private climbH = 0;
  setClimb(x: number, z: number, r: number, h: number): void {
    this.climbX = x; this.climbZ = z; this.climbR2 = r * r; this.climbInvR = 1 / r; this.climbH = h;
  }

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
  private readonly sway = new Float32Array(BOB_BUCKETS); // signed L↔R shamble weave (walk look)

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

    // procedural low-poly zombie, shared across all 20k instances (1 draw call)
    const geo = buildZombieGeometry();
    // Lambert (diffuse-only) instead of Standard (full PBR): the swarm is the
    // fragment-overdraw bottleneck when the horde fills the screen — hundreds of
    // instances overlap per pixel, each running the fragment shader. These tiny
    // flat-shaded figures don't need PBR; Lambert shades far cheaper per fragment.
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
    if (this.blockGrid) {
      // keep spawns inside the boundary wall (never in the unreachable dead zone outside)
      const b = this.blockGrid.bound - 1;
      if (x < -b) x = -b; else if (x > b) x = b;
      if (z < -b) z = -b; else if (z > b) z = b;
      // and never sealed inside a building — nudge to walkable ground (deterministic, no srand)
      if (cellBlocked(this.blockGrid, x, z)) { const f = nearestFree(this.blockGrid, x, z); x = f.x; z = f.z; }
    }
    const i = this.count++;
    const t = ENEMY_TYPES[typeIdx];
    this.posX[i] = x;
    this.posZ[i] = z;
    this.hp[i] = this.maxHp[i] = hpOverride ?? t.hp;
    this.speed[i] = t.speed * (0.9 + srand() * 0.2); // gameplay (affects collisions) -> seeded
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
    // boss biased bright so its radioactive tint exceeds the bloom threshold and glows
    const v = (typeIdx === BOSS_TYPE ? 1.5 : 0.85) + Math.random() * 0.3;
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
  update(dt: number, time: number, playerX: number, playerZ: number, grid: SpatialGrid, blockGrid: BlockGrid | null = null): number {
    const { posX, posZ, speed, radius, dps, bob, count, pulse, sway, flash, baseCol, age, baseScale } = this;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const col = this.mesh.instanceColor!.array as Float32Array;
    const { cellStart, indices, dim } = grid;
    // city collision (hoisted; the whole block is skipped when there's no city)
    const bBlocked = blockGrid ? blockGrid.blocked : null;
    const bDim = blockGrid ? blockGrid.dim : 0, bMax = bDim - 1;
    const bInv = blockGrid ? blockGrid.invCell : 0, bHalf = blockGrid ? blockGrid.half : 0;
    const bCell = blockGrid ? blockGrid.cell : 1, bCell2 = bCell * bCell;
    let playerDamage = 0;
    let colorDirty = false;

    // 64-entry pulse LUT replaces 20k Math.sin calls for the cosmetic bob
    for (let b = 0; b < BOB_BUCKETS; b++) {
      const ph = b * ((Math.PI * 2) / BOB_BUCKETS);
      pulse[b] = 1 + 0.34 * Math.abs(Math.sin(time * 4 + ph)); // vertical step bounce (was 0.3)
      sway[b] = Math.sin(time * 5 + ph);                       // signed L↔R shamble weave
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

      let nx = x + (vx + sepX * 10) * dt;
      let nz = z + (vz + sepZ * 10) * dt;
      if (bBlocked) {
        // clamp this frame's move to ≤ one cell so a single point-sample can't
        // tunnel a thin wall (a separation spike can otherwise fling an enemy
        // several cells in one frame), then axis-slide along any blocked cell.
        let mx = nx - x, mz = nz - z;
        const st2 = mx * mx + mz * mz;
        if (st2 > bCell2) { const s = bCell / Math.sqrt(st2); mx *= s; mz *= s; nx = x + mx; nz = z + mz; }
        let cx = ((nx + bHalf) * bInv) | 0; cx = cx < 0 ? 0 : cx > bMax ? bMax : cx;
        let cz = ((z + bHalf) * bInv) | 0; cz = cz < 0 ? 0 : cz > bMax ? bMax : cz;
        if (bBlocked[cz * bDim + cx]) nx = x;             // X blocked → slide
        cx = ((nx + bHalf) * bInv) | 0; cx = cx < 0 ? 0 : cx > bMax ? bMax : cx;
        cz = ((nz + bHalf) * bInv) | 0; cz = cz < 0 ? 0 : cz > bMax ? bMax : cz;
        if (bBlocked[cz * bDim + cx]) nz = z;             // Z blocked → slide
      }
      posX[i] = nx;
      posZ[i] = nz;

      if (d < r + PLAYER_RADIUS) playerDamage += dps[i] * dt;

      // spawn telegraph: scale up from 0 to the target over GROW_T
      age[i] += dt;
      const sc = age[i] < GROW_T ? baseScale[i] * (age[i] / GROW_T) : baseScale[i];

      // face the player as they shamble: local +Z -> direction toward player,
      // baked into a Y-rotation × scale (the chase dir dxp/d,dzp/d is already known)
      const ux = dxp / d, uz = dzp / d;
      const o = i * 16;
      m[o] = uz * sc; m[o + 2] = -ux * sc;
      m[o + 5] = sc;
      m[o + 8] = ux * sc; m[o + 10] = uz * sc;
      // shamble: a render-only lateral weave (perp to the facing) — the SIM pos stays nx/nz so the
      // hitbox doesn't move; capped per size so big enemies don't drift far from where you shoot.
      const sw = sway[bob[i]] * (r < 2 ? r : 2) * 0.12;
      m[o + 12] = nx - uz * sw;
      // climbable mountain: lift enemies onto the cone slope (cheap distance check; 0 for the far majority)
      let gy = 0;
      if (this.climbH > 0) {
        const cdx = nx - this.climbX, cdz = nz - this.climbZ, cd2 = cdx * cdx + cdz * cdz;
        if (cd2 < this.climbR2) gy = this.climbH * (1 - Math.sqrt(cd2) * this.climbInvR);
      }
      m[o + 13] = r * pulse[bob[i]] + gy;
      m[o + 14] = nz + ux * sw;

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

/**
 * Dash phase-strike: damage + knock back every living NON-BOSS enemy whose disc
 * overlaps the player disc (`reach`). Grid-local (like the missiles' detonate)
 * so a max-density dash never scans the whole swarm — bosses are immune, dead
 * enemies are left for the death sweep. `dmg`/`knock` arrive pre-scaled by dt
 * (main.ts passes DASH_STRIKE_DPS*dt / DASH_KNOCK*dt each dash frame).
 */
export function phaseStrike(sw: Swarm, grid: SpatialGrid, px: number, pz: number, reach: number, dmg: number, knock: number): void {
  const { cellStart, indices, dim } = grid;
  const cells = Math.ceil(reach / grid.cellSize) + 1;
  const cx = grid.cellX(px), cz = grid.cellZ(pz);
  for (let gz = Math.max(0, cz - cells); gz <= Math.min(dim - 1, cz + cells); gz++) {
    for (let gx = Math.max(0, cx - cells); gx <= Math.min(dim - 1, cx + cells); gx++) {
      const c = gz * dim + gx;
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
        const i = indices[k];
        if (i >= sw.count || sw.hp[i] <= 0 || sw.type[i] === BOSS_TYPE) continue;
        const dx = sw.posX[i] - px, dz = sw.posZ[i] - pz, rr = reach + sw.radius[i];
        if (dx * dx + dz * dz > rr * rr) continue;
        sw.hp[i] -= dmg;                // flat DPS while overlapped — the death sweep handles the kill
        const d = Math.hypot(dx, dz) || 1;
        sw.posX[i] += (dx / d) * knock; // shove outward
        sw.posZ[i] += (dz / d) * knock;
      }
    }
  }
}
