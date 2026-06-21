import * as THREE from 'three/webgpu';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute } from 'three/tsl';
import { streamFrom, CITY_SALT } from './rng';

/**
 * The collidable post-apocalyptic city.
 *
 * One FINITE world (1200×1200, matching the ground plane), generated once at
 * run start from an INDEPENDENT seeded stream (streamFrom) so a shared ?seed=
 * reproduces the exact same skyline WITHOUT ever touching the gameplay srand()
 * cursor (determinism stays intact — selftest guards this).
 *
 * Collision is a baked Uint8Array bitmask (`BlockGrid`): the 20k-enemy hot loop
 * and the player both resolve against it in O(1) per query, independent of how
 * many buildings exist. SOLID rects are rasterized into the mask; PASS_UNDER /
 * TUNNEL rects are deliberately NOT — that exemption is exactly what lets the
 * horde walk under billboards/bridges for zero runtime cost.
 */

// ---- world frame (single source of truth) ----
export const WORLD = { SIZE: 1200, HALF: 600, BOUND: 560, CELL: 1.0 } as const;
export const INV_CELL = 1 / WORLD.CELL;
export const DIM = (WORLD.SIZE / WORLD.CELL) | 0; // 1200

export const enum ObsFlag { SOLID = 1, PASS_UNDER = 2, TUNNEL = 4 }
export const enum Kind {
  House = 0, Hospital = 1, Cinema = 2, Ruin = 3, Rubble = 4, Boundary = 5,
  Tower = 6, Mall = 7,                              // building archetypes
  Mountain = 8, TreeTrunk = 9, Water = 10, Snag = 11, // terrain (Water is SOLID, render-routed by kind)
  Billboard = 12, Bridge = 13, Tunnel = 14,         // structures
}
export const enum Zone { Downtown = 0, Suburb = 1, Park = 2 }

export interface ObstacleSoA {
  count: number;
  minX: Float32Array; minZ: Float32Array;
  maxX: Float32Array; maxZ: Float32Array;
  flags: Uint8Array;   // ObsFlag bitset
  height: Float32Array;
  kind: Uint8Array;
  hollow: Uint8Array;   // 1 = enterable (wall ring + a door, open interior)
  doorSide: Uint8Array; // 0 S, 1 N, 2 W, 3 E — which wall has the doorway
}

/** drops generated inside hollow buildings (type: 0 health, 1 missiles, 2 nuke) */
export interface DropList {
  count: number; x: Float32Array; z: Float32Array; type: Uint8Array;
}

export interface BlockGrid {
  cell: number; invCell: number; dim: number; half: number;
  bound: number;       // playable half-extent (inside the boundary wall) — spawns clamp to this
  blocked: Uint8Array; // dim*dim, 1 = solid
}

export interface City {
  obstacles: ObstacleSoA;
  blockGrid: BlockGrid;
  drops: DropList;
  meshes: THREE.Object3D[];
  seed: number;
  zoneAt(x: number, z: number): Zone; // downtown / suburb / park at a world point
  warp: ZoneWarp;                     // the seed's zone-ring warp coeffs (for the ground shader)
  groundHeight(x: number, z: number): number; // render elevation (climbable mountain); 0 elsewhere
  climb: { x: number; z: number; r: number; h: number }; // the climbable mountain (for the swarm)
  setVisualTier(tier: number): void;
  updateTunnels(px: number, pz: number, dt: number): void;
}

const WALL_T = 2;   // hollow-building wall thickness (world units)
const DOOR_W = 5;   // doorway gap width
const HOLLOW_MIN = 16; // a building must be this wide/deep to be made hollow
const ROOF_OUT = 0.5;  // hollow-roof opacity when you're outside (a faint shell you see through)
const ROOF_IN = 0.12;  // hollow-roof opacity when you're inside (highly transparent)

// ---- generation tunables (counts are SEED-only — never tier/device derived) ----
const CITY = {
  BLOCK: 46,          // road-grid pitch (a lot + a road)
  ROAD_W: 9,          // road width carved between lots
  DENSITY: 0.33,      // P(a lot holds a building) — sparser, more open ground to fight in
  SPAWN_SAFE_R: 16,   // no building within this radius of the player's start
  // House, Hospital, Cinema, Ruin, Rubble — cumulative weights
  KIND_CDF: [0.42, 0.60, 0.70, 0.86, 1.0],
} as const;

// ruin tints per kind — grim but clearly readable against the dark ground; the
// Lambert dir-light + a faint emissive floor make the boxes read in 3D. Peak lit
// luminance stays under the 0.75 bloom threshold so the city never blooms. [r,g,b]
const KIND_TINT: [number, number, number][] = [
  [0.34, 0.30, 0.23],  // House — weathered warm concrete
  [0.28, 0.34, 0.39],  // Hospital — cold pale grey-blue
  [0.40, 0.25, 0.32],  // Cinema — faded magenta plaster
  [0.26, 0.22, 0.17],  // Ruin — charred brown
  [0.19, 0.17, 0.15],  // Rubble — dark debris
  [0.22, 0.24, 0.28],  // Boundary — cold barricade
  [0.30, 0.33, 0.40],  // Tower — glassy grey-blue
  [0.31, 0.27, 0.2],   // Mall — tan retail block (kept under bloom on its big lit faces)
  [0.20, 0.21, 0.19],  // Mountain — grey-green rock
  [0.18, 0.14, 0.10],  // TreeTrunk — dark bark
  [0.05, 0.12, 0.15],  // Water — dark teal
  [0.13, 0.11, 0.09],  // Snag — charred dead wood
  [0.20, 0.21, 0.24],  // Billboard — grey frame
  [0.24, 0.21, 0.18],  // Bridge — weathered deck
  [0.17, 0.16, 0.15],  // Tunnel — dark concrete
];

// ---- collision queries ----
export function cellBlocked(g: BlockGrid, x: number, z: number): 0 | 1 {
  const cx = ((x + g.half) * g.invCell) | 0;
  const cz = ((z + g.half) * g.invCell) | 0;
  if (cx < 0 || cz < 0 || cx >= g.dim || cz >= g.dim) return 1; // outside the world = blocked
  return g.blocked[cz * g.dim + cx] as 0 | 1;
}

/**
 * Nearest free world position to (x,z) by an expanding ring search — used to
 * nudge a spawn that landed inside a building out to walkable ground. Pure /
 * deterministic (no RNG), so it never breaks seed reproducibility.
 */
export function nearestFree(g: BlockGrid, x: number, z: number): { x: number; z: number } {
  if (cellBlocked(g, x, z) === 0) return { x, z };
  const cx0 = ((x + g.half) * g.invCell) | 0, cz0 = ((z + g.half) * g.invCell) | 0;
  for (let r = 1; r <= 48; r++) {
    for (let dz = -r; dz <= r; dz++) {
      const onZ = dz === -r || dz === r;
      for (let dx = -r; dx <= r; dx++) {
        if (!onZ && dx !== -r && dx !== r) continue; // perimeter of the ring only
        const cx = cx0 + dx, cz = cz0 + dz;
        if (cx < 0 || cz < 0 || cx >= g.dim || cz >= g.dim) continue;
        if (!g.blocked[cz * g.dim + cx]) return { x: (cx + 0.5) * g.cell - g.half, z: (cz + 0.5) * g.cell - g.half };
      }
    }
  }
  return { x, z };
}

/** true if a radius-r footprint at (x,z) clears all solids (4-corner sample) */
function isFree(g: BlockGrid, x: number, z: number, r: number): boolean {
  return cellBlocked(g, x - r, z - r) === 0 && cellBlocked(g, x + r, z - r) === 0 &&
         cellBlocked(g, x - r, z + r) === 0 && cellBlocked(g, x + r, z + r) === 0;
}

/**
 * Resolve a player move from (fromX,fromZ) toward (toX,toZ) with radius r:
 * axis-separated slide (try X, then Z) so you glide along walls, and substep in
 * ≤CELL increments so a fast dash (up to ~3.5 cells/frame) can't tunnel a wall.
 */
export function resolveMove(g: BlockGrid, fromX: number, fromZ: number, toX: number, toZ: number, r: number): { x: number; z: number } {
  const dx = toX - fromX, dz = toZ - fromZ;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const n = Math.max(1, Math.ceil(dist / g.cell)); // distance-derived substeps (handles dash)
  const sx = dx / n, sz = dz / n;
  let x = fromX, z = fromZ;
  for (let i = 0; i < n; i++) {
    let nx = x + sx, nz = z + sz;
    if (!isFree(g, nx, z, r)) nx = x;   // X blocked → keep old X
    if (!isFree(g, nx, nz, r)) nz = z;  // Z blocked → keep old Z
    x = nx; z = nz;
  }
  return { x, z };
}

// fill (val=1) or clear (val=0) a world-space rect of cells
function fillCells(g: BlockGrid, minX: number, minZ: number, maxX: number, maxZ: number, val: 0 | 1): void {
  const { blocked, dim, invCell, half } = g;
  const max = dim - 1, cl = (v: number) => (v < 0 ? 0 : v > max ? max : v);
  const cx0 = cl(((minX + half) * invCell) | 0), cz0 = cl(((minZ + half) * invCell) | 0);
  const cx1 = cl(((maxX + half) * invCell) | 0), cz1 = cl(((maxZ + half) * invCell) | 0);
  for (let cz = cz0; cz <= cz1; cz++) blocked.fill(val, cz * dim + cx0, cz * dim + cx1 + 1);
}

// ---- bake SOLID rects into the bitmask (PASS_UNDER/TUNNEL skipped → walk-under) ----
function bake(g: BlockGrid, s: ObstacleSoA): void {
  const { blocked, dim, invCell, half } = g;
  blocked.fill(0);
  const cl = (v: number) => (v < 0 ? 0 : v > dim - 1 ? dim - 1 : v);
  for (let i = 0; i < s.count; i++) {
    if (!(s.flags[i] & ObsFlag.SOLID)) continue;
    const minX = s.minX[i], minZ = s.minZ[i], maxX = s.maxX[i], maxZ = s.maxZ[i];
    if (s.hollow[i]) {
      // walls only: fill the box, hollow out the interior, then punch the doorway
      fillCells(g, minX, minZ, maxX, maxZ, 1);
      fillCells(g, minX + WALL_T, minZ + WALL_T, maxX - WALL_T, maxZ - WALL_T, 0);
      const mx = (minX + maxX) / 2, mz = (minZ + maxZ) / 2, hw = DOOR_W / 2;
      const ds = s.doorSide[i];
      if (ds === 0) fillCells(g, mx - hw, minZ - 1, mx + hw, minZ + WALL_T, 0);      // south
      else if (ds === 1) fillCells(g, mx - hw, maxZ - WALL_T, mx + hw, maxZ + 1, 0); // north
      else if (ds === 2) fillCells(g, minX - 1, mz - hw, minX + WALL_T, mz + hw, 0); // west
      else fillCells(g, maxX - WALL_T, mz - hw, maxX + 1, mz + hw, 0);               // east
    } else {
      const cx0 = cl(((minX + half) * invCell) | 0), cz0 = cl(((minZ + half) * invCell) | 0);
      const cx1 = cl(((maxX + half) * invCell) | 0), cz1 = cl(((maxZ + half) * invCell) | 0);
      for (let cz = cz0; cz <= cz1; cz++) blocked.fill(1, cz * dim + cx0, cz * dim + cx1 + 1);
    }
  }
  // seal everything AT or OUTSIDE the boundary (wall + dead zone) so nothing — neither
  // the player, a spawn, nor a relocated spawn — can ever occupy the outside ring.
  const lo = cl(((-WORLD.BOUND + half) * invCell) | 0); // 40
  const hi = cl(((WORLD.BOUND + half) * invCell) | 0);   // 1160
  for (let cz = 0; cz < dim; cz++) {
    if (cz <= lo || cz >= hi) blocked.fill(1, cz * dim, cz * dim + dim);
    else { blocked.fill(1, cz * dim, cz * dim + lo + 1); blocked.fill(1, cz * dim + hi, cz * dim + dim); }
  }
}

/** flood-fill free cells from origin; returns the count reachable (navigability check) */
function reachableFromOrigin(g: BlockGrid): number {
  const { blocked, dim, invCell, half } = g;
  const seen = new Uint8Array(dim * dim);
  const stack: number[] = [];
  const ox = ((0 + half) * invCell) | 0, oz = ((0 + half) * invCell) | 0;
  const start = oz * dim + ox;
  if (blocked[start]) return 0;
  stack.push(start); seen[start] = 1;
  let reached = 0;
  while (stack.length) {
    const c = stack.pop()!;
    reached++;
    const cx = c % dim, cz = (c / dim) | 0;
    if (cx > 0) { const n = c - 1; if (!seen[n] && !blocked[n]) { seen[n] = 1; stack.push(n); } }
    if (cx < dim - 1) { const n = c + 1; if (!seen[n] && !blocked[n]) { seen[n] = 1; stack.push(n); } }
    if (cz > 0) { const n = c - dim; if (!seen[n] && !blocked[n]) { seen[n] = 1; stack.push(n); } }
    if (cz < dim - 1) { const n = c + dim; if (!seen[n] && !blocked[n]) { seen[n] = 1; stack.push(n); } }
  }
  return reached;
}

// ---- building character: compose a recognisable silhouette per kind from merged
//      boxes/prisms. Each part is world-positioned + vertex-coloured and folded into
//      the single building mesh (1 draw call). Collision stays the AABB footprint. ---
function paint(g: THREE.BufferGeometry, r: number, gg: number, b: number): THREE.BufferGeometry {
  const ng = g.toNonIndexed(); // non-indexed → crisp flat-shaded faces + safe merge
  g.dispose();
  const n = ng.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) { c[k * 3] = r; c[k * 3 + 1] = gg; c[k * 3 + 2] = b; }
  ng.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return ng;
}
function archetypeParts(kind: Kind, w: number, h: number, d: number, cx: number, cz: number, tint: number[], rng: () => number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, mul = 1) => parts.push(paint(g, tint[0] * mul, tint[1] * mul, tint[2] * mul));
  if (kind === Kind.House) {
    const bodyH = h * 0.66;
    add(new THREE.BoxGeometry(w, bodyH, d).translate(cx, bodyH / 2, cz));                 // walls
    const roofH = h * 0.5;
    add(new THREE.ConeGeometry(Math.max(w, d) * 0.62, roofH, 4).rotateY(Math.PI / 4).translate(cx, bodyH + roofH / 2, cz), 0.7); // hipped roof (darker)
  } else if (kind === Kind.Hospital) {
    add(new THREE.BoxGeometry(w, h, d).translate(cx, h / 2, cz));                           // main slab
    add(new THREE.BoxGeometry(w * 0.18, h * 0.7, d * 1.12).translate(cx - w * 0.46, h * 0.35, cz), 0.85); // side wing
    add(new THREE.BoxGeometry(w * 0.4, h * 0.12, d * 0.4).translate(cx, h + h * 0.06, cz), 1.08);         // rooftop unit
    add(new THREE.BoxGeometry(w * 0.06, h * 0.16, d * 0.32).translate(cx + w * 0.2, h + h * 0.1, cz), 1.15); // a pale roof marker
  } else if (kind === Kind.Cinema) {
    add(new THREE.BoxGeometry(w, h, d).translate(cx, h / 2, cz));                           // hall
    add(new THREE.BoxGeometry(w * 1.05, h * 0.16, d * 0.24).translate(cx, h * 0.34, cz + d * 0.5), 1.1);   // marquee canopy (front)
    add(new THREE.BoxGeometry(w * 0.14, h * 0.55, d * 0.1).translate(cx, h + h * 0.27, cz), 1.15);         // vertical sign blade
  } else if (kind === Kind.Ruin) {
    const fragH = h * (0.45 + rng() * 0.45);
    add(new THREE.BoxGeometry(w * 0.92, fragH, d * 0.92).translate(cx, fragH / 2, cz));     // standing remnant
    const tiltH = h * 0.5, lean = (rng() - 0.5) * 0.5;
    add(new THREE.BoxGeometry(w * 0.42, tiltH, d * 0.42).rotateZ(lean).translate(cx + w * 0.28, tiltH * 0.42, cz - d * 0.18), 0.6); // collapsed slab
  } else if (kind === Kind.Tower) {
    const baseH = h * 0.55;
    add(new THREE.BoxGeometry(w, baseH, d).translate(cx, baseH / 2, cz));                   // base slab
    const setH = h * 0.30;
    add(new THREE.BoxGeometry(w * 0.78, setH, d * 0.78).translate(cx, baseH + setH / 2, cz), 1.05); // setback
    const crownH = h * 0.15;
    add(new THREE.BoxGeometry(w * 0.55, crownH, d * 0.55).translate(cx, baseH + setH + crownH / 2, cz), 1.12); // crown
    const antH = 3 + rng() * 5;
    add(new THREE.BoxGeometry(0.6, antH, 0.6).translate(cx, h + antH / 2, cz), 1.2);        // antenna mast
  } else if (kind === Kind.Mall) {
    add(new THREE.BoxGeometry(w, h, d).translate(cx, h / 2, cz));                           // big-box retail body
    const face = rng() < 0.5 ? 1 : -1;
    add(new THREE.BoxGeometry(w * 0.5, h * 0.32, d * 0.16).translate(cx, h * 0.16, cz + face * d * 0.5), 1.1); // entrance canopy
    const rn = 2 + ((rng() * 3) | 0);
    for (let s = 0; s < rn; s++) {
      const rw = w * (0.1 + rng() * 0.12), rd = d * (0.1 + rng() * 0.12), rh = h * (0.2 + rng() * 0.3);
      add(new THREE.BoxGeometry(rw, rh, rd).translate(cx + (rng() - 0.5) * w * 0.6, h + rh / 2, cz + (rng() - 0.5) * d * 0.6), 0.9); // rooftop HVAC
    }
  } else if (kind === Kind.Boundary) {
    add(new THREE.BoxGeometry(w, h, d).translate(cx, h / 2, cz));                           // barricade wall
  } else { // Rubble — scatter of low chunks
    const n = 3 + ((rng() * 3) | 0);
    for (let s = 0; s < n; s++) {
      const sw = w * (0.18 + rng() * 0.3), sd = d * (0.18 + rng() * 0.3), sh = h * (0.4 + rng() * 0.9);
      add(new THREE.BoxGeometry(sw, sh, sd).rotateY(rng() * 0.6).translate(cx + (rng() - 0.5) * w * 0.6, sh / 2, cz + (rng() - 0.5) * d * 0.6), 0.7 + rng() * 0.4);
    }
  }
  return parts;
}

// hollow (enterable) building: a roofless wall ring with a door gap, so the
// top-down camera sees the interior + the supply cache. Walls capped low.
function hollowParts(h: number, w: number, d: number, cx: number, cz: number, tint: number[], doorSide: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, mul = 1) => parts.push(paint(g, tint[0] * mul, tint[1] * mul, tint[2] * mul));
  const wallH = Math.min(h, 6.5), t = WALL_T, hw = DOOR_W / 2;
  const minX = cx - w / 2, maxX = cx + w / 2, minZ = cz - d / 2, maxZ = cz + d / 2;
  const wall = (x0: number, z0: number, x1: number, z1: number) => {
    const ww = x1 - x0, dd = z1 - z0;
    if (ww > 0.01 && dd > 0.01) add(new THREE.BoxGeometry(ww, wallH, dd).translate((x0 + x1) / 2, wallH / 2, (z0 + z1) / 2));
  };
  // south wall (z≈minZ) — split for a door when doorSide===0
  if (doorSide === 0) { wall(minX, minZ, cx - hw, minZ + t); wall(cx + hw, minZ, maxX, minZ + t); }
  else wall(minX, minZ, maxX, minZ + t);
  // north wall (z≈maxZ)
  if (doorSide === 1) { wall(minX, maxZ - t, cx - hw, maxZ); wall(cx + hw, maxZ - t, maxX, maxZ); }
  else wall(minX, maxZ - t, maxX, maxZ);
  // west wall (between the N/S walls)
  if (doorSide === 2) { wall(minX, minZ + t, minX + t, cz - hw); wall(minX, cz + hw, minX + t, maxZ - t); }
  else wall(minX, minZ + t, minX + t, maxZ - t);
  // east wall
  if (doorSide === 3) { wall(maxX - t, minZ + t, maxX, cz - hw); wall(maxX - t, cz + hw, maxX, maxZ - t); }
  else wall(maxX - t, minZ + t, maxX, maxZ - t);
  // a dark interior floor pad so the open room reads
  add(new THREE.BoxGeometry(w - 2 * t, 0.18, d - 2 * t).translate(cx, 0.09, cz), 0.45);
  return parts;
}

// ---- zones: 3 concentric, angularly-warped rings (Downtown → Suburb → Park) ----
export interface WarpCoeffs { a1: number; a2: number; a3: number; p1: number; p2: number; p3: number; }
export interface ZoneWarp { lo: WarpCoeffs; hi: WarpCoeffs; }
export const ZONE = { R0_BASE: 200, R0_AMP: 34, R1_BASE: 400, R1_AMP: 52 } as const;

// a single CLIMBABLE mountain in the park: a walkable cone you ascend to the peak.
// It is NEVER baked into the collision grid (movement stays flat XZ); the elevation is
// a pure render offset the player, camera, and swarm all follow via climbHeight().
export const CLIMB = { x: -330, z: -330, r: 62, h: 26 } as const;
export function climbHeight(x: number, z: number): number {
  const dx = x - CLIMB.x, dz = z - CLIMB.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  return d >= CLIMB.r ? 0 : CLIMB.h * (1 - d / CLIMB.r); // linear cone (matches the ConeGeometry mesh)
}

const TWO_PI = Math.PI * 2;
function warpVal(th: number, c: WarpCoeffs): number {
  return c.a1 * Math.sin(th + c.p1) + c.a2 * Math.sin(2 * th + c.p2) + c.a3 * Math.sin(3 * th + c.p3);
}
function drawWarp(rng: () => number): WarpCoeffs {
  // amplitudes sum < ~1.1 so the ring radii stay well-ordered & inside the world
  return { a1: rng() * 0.6, a2: rng() * 0.3, a3: rng() * 0.2, p1: rng() * TWO_PI, p2: rng() * TWO_PI, p3: rng() * TWO_PI };
}
/** O(1), allocation-free zone classification. Origin (d<1) is always Downtown → spawn-safe. */
function zoneAt(x: number, z: number, w: ZoneWarp): Zone {
  const dd = Math.sqrt(x * x + z * z);
  if (dd < 1) return Zone.Downtown;
  const th = Math.atan2(z, x);
  if (dd < ZONE.R0_BASE + ZONE.R0_AMP * warpVal(th, w.lo)) return Zone.Downtown;
  if (dd < ZONE.R1_BASE + ZONE.R1_AMP * warpVal(th, w.hi)) return Zone.Suburb;
  return Zone.Park;
}

// ---- roads: a segment list, rendered as oriented quads & tested for building placement ----
interface RoadSeg { ax: number; az: number; bx: number; bz: number; hw: number; }
/** distance from a point to a segment (for "is this lot on a road?" tests) */
function distToSeg(px: number, pz: number, s: RoadSeg): number {
  const dx = s.bx - s.ax, dz = s.bz - s.az;
  const l2 = dx * dx + dz * dz || 1e-6;
  let t = ((px - s.ax) * dx + (pz - s.az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = s.ax + t * dx, qz = s.az + t * dz;
  return Math.hypot(px - qx, pz - qz);
}
function onRoad(px: number, pz: number, roads: RoadSeg[], margin: number): boolean {
  for (let i = 0; i < roads.length; i++) if (distToSeg(px, pz, roads[i]) < roads[i].hw + margin) return true;
  return false;
}
/** suburb/park winding road: fixed step count (stream-stable), turned by one rng per step, kept in bounds */
function windingRoad(rng: () => number, sx: number, sz: number, heading0: number, steps: number, step: number, turn: number, hw: number, out: RoadSeg[]): void {
  let x = sx, z = sz, heading = heading0;
  for (let k = 0; k < steps; k++) {
    heading += (rng() - 0.5) * turn;                 // exactly one roll per step → constant count
    let nx = x + Math.cos(heading) * step, nz = z + Math.sin(heading) * step;
    if (Math.hypot(nx, nz) > WORLD.BOUND - 24) {     // bounce back inward (no extra roll)
      heading += Math.PI * 0.55;
      nx = x + Math.cos(heading) * step; nz = z + Math.sin(heading) * step;
    }
    out.push({ ax: x, az: z, bx: nx, bz: nz, hw });
    x = nx; z = nz;
  }
}
/** zone-aware kind pick (CDF per zone); returns a building Kind */
function pickKind(zone: Zone, kr: number): Kind {
  if (zone === Zone.Downtown) {            // skyline: towers dominate
    return kr < 0.68 ? Kind.Tower : kr < 0.80 ? Kind.Hospital : kr < 0.91 ? Kind.Cinema : Kind.Ruin;
  }
  if (zone === Zone.Suburb) {              // homes + the odd big-box mall
    return kr < 0.70 ? Kind.House : kr < 0.82 ? Kind.Mall : kr < 0.91 ? Kind.Ruin : Kind.Rubble;
  }
  return kr < 0.50 ? Kind.Rubble : kr < 0.80 ? Kind.Ruin : Kind.House; // park: ruined & sparse
}

// ---- structures: the carve pass that opens bridge decks & tunnel bores ----
// After bake() blocks every SOLID rect (incl. water & tunnel massifs), this re-clears
// every PASS_UNDER rect's cells → the ONLY free path across the water / through the
// mountain. Order-independent of push order (regions baked first, corridors carved last).
function carveCorridors(g: BlockGrid, s: ObstacleSoA): void {
  const dim = g.dim, half = g.half, inv = g.invCell;
  for (let i = 0; i < s.count; i++) {
    if (!(s.flags[i] & ObsFlag.PASS_UNDER)) continue;
    let cx0 = ((s.minX[i] + half) * inv) | 0, cx1 = ((s.maxX[i] + half) * inv) | 0;
    let cz0 = ((s.minZ[i] + half) * inv) | 0, cz1 = ((s.maxZ[i] + half) * inv) | 0;
    if (cx0 < 0) cx0 = 0; if (cz0 < 0) cz0 = 0;
    if (cx1 >= dim) cx1 = dim - 1; if (cz1 >= dim) cz1 = dim - 1;
    for (let cz = cz0; cz <= cz1; cz++) g.blocked.fill(0, cz * dim + cx0, cz * dim + cx1 + 1);
  }
}

// a glowing neon sign face (dark panel + accent-coloured text) baked to a canvas texture
function makeSignTexture(text: string, accent: string): THREE.CanvasTexture {
  const cw = 640, ch = 200;
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#070a12'; ctx.fillRect(0, 0, cw, ch);
  ctx.strokeStyle = accent; ctx.lineWidth = 10; ctx.strokeRect(12, 12, cw - 24, ch - 24);
  ctx.fillStyle = accent; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = accent; ctx.shadowBlur = 24;
  const words = text.split(' ');
  const lines = text.length > 12 && words.length > 1
    ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')]
    : [text];
  const fs = lines.length > 1 ? 66 : 88, lh = fs * 1.12;
  ctx.font = `900 ${fs}px "Arial Black", Impact, sans-serif`;
  const y0 = ch / 2 - (lines.length - 1) * lh / 2;
  lines.forEach((ln, i) => ctx.fillText(ln, cw / 2, y0 + i * lh));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// asphalt parking lot with painted white stall lines + a centre drive lane
function makeParkingTexture(): THREE.CanvasTexture {
  const s = 512;
  const cv = document.createElement('canvas');
  cv.width = s; cv.height = s;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#191b21'; ctx.fillRect(0, 0, s, s); // dark asphalt
  ctx.strokeStyle = 'rgba(205,205,180,0.45)'; ctx.lineWidth = 4;
  const cols = 11, stallW = s / cols;
  for (let c = 0; c <= cols; c++) {
    ctx.beginPath(); ctx.moveTo(c * stallW, s * 0.06); ctx.lineTo(c * stallW, s * 0.40); ctx.stroke(); // top row
    ctx.beginPath(); ctx.moveTo(c * stallW, s * 0.60); ctx.lineTo(c * stallW, s * 0.94); ctx.stroke(); // bottom row
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- generation ----
export function generateCity(seed: number, isTouch: boolean, skipMeshes = false): City {
  void isTouch; // collidable set is identical across devices/tiers (seed-only) — fairness/determinism
  const rng = streamFrom(CITY_SALT, seed);

  const minXa: number[] = [], minZa: number[] = [], maxXa: number[] = [], maxZa: number[] = [];
  const fl: number[] = [], hh: number[] = [], kk: number[] = [], ho: number[] = [], dse: number[] = [];
  const push = (mnX: number, mnZ: number, mxX: number, mxZ: number, flag: number, height: number, kind: number, hollow = 0, doorSide = 0): void => {
    minXa.push(mnX); minZa.push(mnZ); maxXa.push(mxX); maxZa.push(mxZ);
    fl.push(flag); hh.push(height); kk.push(kind); ho.push(hollow); dse.push(doorSide);
  };
  // supply caches placed inside hollow buildings
  const dx: number[] = [], dz: number[] = [], dty: number[] = [];
  // footprints of hollow buildings → fade-able roofs (render-only, never collidable)
  const roofs: { x: number; z: number; w: number; d: number; y: number }[] = [];

  const H = WORLD.HALF, B = CITY.BLOCK, road = CITY.ROAD_W;
  const lotIn = (B - road); // usable lot span
  const grid = Math.floor((WORLD.SIZE - 40) / B); // leave a margin inside the boundary ring
  const start = -((grid * B) / 2);
  const Bd = WORLD.BOUND;

  // (1) zone warp coeffs — the FIRST stream consumers, so zoneAt is fixed before anything places
  const warp: ZoneWarp = { lo: drawWarp(rng), hi: drawWarp(rng) };
  const zone = (x: number, z: number): Zone => zoneAt(x, z, warp);

  // a landmark shopping mall + huge parking lot in the suburb (placed below; lots here are cleared)
  const MALL = { x: 235, z: 168, w: 54, d: 36, h: 14, lotZ: 118, lotW: 74, lotD: 48 };

  // (2) roads → a segment list. Render uses all of them; placement only needs to dodge the
  // "big" roads (arterials/spokes) since grid lines run between (mid-block) lot centres.
  const roadSegs: RoadSeg[] = [];
  const trailSegs: RoadSeg[] = []; // park hiking trails (dirt, narrow, rendered separately)
  const bigRoads: RoadSeg[] = [];
  for (let i = 0; i < 6; i++) {                       // 6 radial spokes — the connectivity backbone
    const a = i * (Math.PI / 3), ex = Math.cos(a), ez = Math.sin(a);
    const r1 = ZONE.R1_BASE + ZONE.R1_AMP * warpVal(a, warp.hi); // park entry radius for this spoke
    const seg = { ax: 0, az: 0, bx: ex * r1, bz: ez * r1, hw: 5 }; // ASPHALT road: centre → park edge
    roadSegs.push(seg); bigRoads.push(seg);
    // a winding hiking TRAIL takes over at the park edge and meanders to the rim (no roads in the park)
    const before = trailSegs.length;
    windingRoad(rng, ex * r1, ez * r1, a, 11, 17, 0.85, 2.6, trailSegs);
    for (let k = before; k < trailSegs.length; k++) bigRoads.push(trailSegs[k]);
  }
  for (let i = 0; i < 3; i++) {                       // 3 winding suburb arterials from the downtown edge out
    const a0 = rng() * TWO_PI;
    const before = roadSegs.length;
    windingRoad(rng, Math.cos(a0) * ZONE.R0_BASE, Math.sin(a0) * ZONE.R0_BASE, a0, 22, 24, 0.7, 4.5, roadSegs);
    for (let k = before; k < roadSegs.length; k++) bigRoads.push(roadSegs[k]);
  }
  const Rd = ZONE.R0_BASE - 8;                        // downtown grid, clipped to a disc (chord per line)
  for (let p = -Rd; p <= Rd + 0.001; p += B) {
    const ext = Math.sqrt(Math.max(0, Rd * Rd - p * p));
    if (ext < 6) continue;
    roadSegs.push({ ax: p, az: -ext, bx: p, bz: ext, hw: road / 2 });
    roadSegs.push({ ax: -ext, az: p, bx: ext, bz: p, hw: road / 2 });
  }

  // (3) buildings, lot by lot in fixed row-major order (deterministic), zone-aware
  for (let gz = 0; gz < grid; gz++) {
    for (let gx = 0; gx < grid; gx++) {
      const lotCx = start + gx * B + B / 2;
      const lotCz = start + gz * B + B / 2;
      const zn = zone(lotCx, lotCz);
      const density = zn === Zone.Downtown ? 0.62 : zn === Zone.Suburb ? 0.34 : 0.12;
      const r0 = rng(); // one roll per lot regardless of outcome → stream length is layout-stable
      if (r0 > density) continue;
      if (Math.hypot(lotCx, lotCz) < CITY.SPAWN_SAFE_R + lotIn) continue;      // keep the start clear
      if (onRoad(lotCx, lotCz, bigRoads, lotIn * 0.3)) continue;               // leave arterials/spokes clear
      if (lotCx > MALL.x - 42 && lotCx < MALL.x + 42 && lotCz > MALL.lotZ - 28 && lotCz < MALL.z + 22) continue; // mall + its parking lot
      if (Math.hypot(lotCx - CLIMB.x, lotCz - CLIMB.z) < CLIMB.r + lotIn) continue; // keep the climbable mountain walkable (no buildings on it)
      // pick kind by zone
      const kr = rng();
      const kind = pickKind(zn, kr);
      // footprint within the lot (jittered, never spilling onto the road)
      const fw = lotIn * (0.55 + rng() * 0.4);
      const fd = lotIn * (0.55 + rng() * 0.4);
      const jx = (rng() - 0.5) * (lotIn - fw) * 0.6;
      const jz = (rng() - 0.5) * (lotIn - fd) * 0.6;
      const cx = lotCx + jx, cz = lotCz + jz;
      // height by kind: towers tower, hospitals tall, malls wide+low, houses low, ruins broken
      let height = 6;
      if (kind === Kind.Tower) height = 16 + rng() * 20;         // tallest, but readable from the angled cam
      else if (kind === Kind.Hospital) height = 14 + rng() * 8;
      else if (kind === Kind.Mall) height = 8 + rng() * 3;
      else if (kind === Kind.Cinema) height = 9 + rng() * 5;
      else if (kind === Kind.House) height = 5 + rng() * 4;
      else if (kind === Kind.Ruin) height = 4 + rng() * 7;
      else height = 1.5 + rng() * 2.5;                            // rubble pile
      // ~half the standing buildings are HOLLOW (enterable, with a supply cache inside) — every
      // kind EXCEPT the tower skyline and the tiny rubble piles; ~60% of those big enough.
      const hollowOk = kind === Kind.House || kind === Kind.Hospital || kind === Kind.Cinema || kind === Kind.Mall || kind === Kind.Ruin;
      const hollow = (hollowOk && fw >= HOLLOW_MIN && fd >= HOLLOW_MIN && rng() < 0.6) ? 1 : 0;
      let doorSide = 0;
      if (hollow) {
        doorSide = (rng() * 4) | 0;
        const dr = rng(); // cache type: health 50% / missiles 35% / nuke 15%
        dx.push(cx); dz.push(cz); dty.push(dr < 0.5 ? 0 : dr < 0.85 ? 1 : 2);
        roofs.push({ x: cx, z: cz, w: fw, d: fd, y: Math.min(height, 6.5) + 0.2 }); // roof sits at the wall top
      }
      push(cx - fw / 2, cz - fd / 2, cx + fw / 2, cz + fd / 2, ObsFlag.SOLID, height, kind, hollow, doorSide);
    }
  }

  // (4) park terrain — lakes, mountains, woods. Park zone only, stream-only, ONE fixed
  // roll-count per candidate (accept/reject never changes stream length). Sizes are capped
  // UNDER the nearestFree escape radius (48 cells) so spawns can never strand inside.
  const lakes: { x: number; z: number; r: number }[] = [];
  const mountains: { x: number; z: number; r: number; h: number }[] = [];
  const trees: { x: number; z: number; r: number; h: number }[] = [];
  const parkLo = ZONE.R1_BASE - 20, parkSpan = (Bd - 34) - parkLo;
  // lakes: ≤2, half-extent 20..32 (<48) → square ponds (SOLID, render-routed by kind)
  let lakeN = 0;
  for (let i = 0; i < 8; i++) {
    const ang = rng() * TWO_PI, rad = parkLo + rng() * parkSpan, r = 20 + rng() * 12;
    const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
    if (lakeN < 2 && zone(x, z) === Zone.Park && !onRoad(x, z, bigRoads, r + 8) && Math.hypot(x - CLIMB.x, z - CLIMB.z) > CLIMB.r + r + 14) {
      push(x - r, z - r, x + r, z + r, ObsFlag.SOLID, 0.5, Kind.Water);
      lakes.push({ x, z, r }); lakeN++;
    }
  }
  // mountains: ≤4, half-extent 24..38 (<48), tall enough (40..70) to resolve out of the fog
  let mtnN = 0;
  for (let i = 0; i < 10; i++) {
    const ang = rng() * TWO_PI, rad = parkLo + rng() * parkSpan, r = 24 + rng() * 14, mh = 40 + rng() * 30;
    const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
    if (mtnN < 4 && zone(x, z) === Zone.Park && !onRoad(x, z, bigRoads, r + 10) && Math.hypot(x - CLIMB.x, z - CLIMB.z) > CLIMB.r + r + 14) {
      push(x - r, z - r, x + r, z + r, ObsFlag.SOLID, mh, Kind.Mountain);
      mountains.push({ x, z, r, h: mh }); mtnN++;
    }
  }
  // woods: groves of tiny SOLID trunks (horde flows AROUND, never sealed) + walk-under canopies
  for (let g = 0; g < 6; g++) {
    const gang = rng() * TWO_PI, grad = parkLo + rng() * parkSpan;
    const gx = Math.cos(gang) * grad, gz = Math.sin(gang) * grad;
    const groveOk = zone(gx, gz) === Zone.Park && Math.hypot(gx - CLIMB.x, gz - CLIMB.z) > CLIMB.r + 40;
    for (let k = 0; k < 12; k++) {
      const ox = (rng() - 0.5) * 50, oz = (rng() - 0.5) * 50, tr = 1.2 + rng() * 0.8, th = 5 + rng() * 5;
      const tx = gx + ox, tz = gz + oz;
      if (groveOk && zone(tx, tz) === Zone.Park && !onRoad(tx, tz, bigRoads, 3)) {
        push(tx - tr / 2, tz - tr / 2, tx + tr / 2, tz + tr / 2, ObsFlag.SOLID, th, Kind.TreeTrunk);
        trees.push({ x: tx, z: tz, r: tr, h: th });
      }
    }
  }

  // (5) structures — billboards (walk UNDER), bridges (walk OVER lakes), tunnels (walk
  // THROUGH a massif, roof fades). Analytic placement (zero rng) so the stream is unchanged.
  const bridges: { x: number; z: number; len: number; hw: number }[] = [];
  const tunnels: { minX: number; minZ: number; maxX: number; maxZ: number; cx: number; cz: number }[] = [];
  const billboards: { x: number; z: number; ang: number; lit: boolean }[] = [];
  // a walkable deck spans each lake (PASS_UNDER → carved free over the SOLID water)
  for (const lk of lakes) {
    const half = lk.r + 7, hw = 7;
    push(lk.x - half, lk.z - hw, lk.x + half, lk.z + hw, ObsFlag.PASS_UNDER, 1.4, Kind.Bridge);
    bridges.push({ x: lk.x, z: lk.z, len: half * 2, hw });
  }
  // ≤2 tunnels on the X-axis spoke (axis-aligned bore), out in the park
  for (const sgn of [1, -1]) {
    const cx = sgn * 470, cz = 0;
    if (zone(cx, cz) !== Zone.Park) continue;
    push(cx - 26, cz - 26, cx + 26, cz + 26, ObsFlag.SOLID, 15, Kind.Tunnel);        // massif (the hill)
    push(cx - 27, cz - 8, cx + 27, cz + 8, ObsFlag.PASS_UNDER, 9, Kind.Tunnel);      // bore → carved free
    tunnels.push({ minX: cx - 27, minZ: cz - 8, maxX: cx + 27, maxZ: cz + 8, cx, cz });
  }
  // a few plain billboards lining the radial spokes — 2 SOLID posts you walk between/under a raised sign
  for (let s = 0; s < 6; s += 2) {
    const a = s * (Math.PI / 3), rad = 280;
    const px = -Math.sin(a), pz = Math.cos(a);          // perpendicular to the spoke
    const bx = Math.cos(a) * rad + px * 12, bz = Math.sin(a) * rad + pz * 12; // set beside the road
    if (zone(bx, bz) === Zone.Downtown) continue;       // keep the dense core clear
    const pw = 0.9, ph = 9;
    push(bx + px * -4 - pw / 2, bz + pz * -4 - pw / 2, bx + px * -4 + pw / 2, bz + pz * -4 + pw / 2, ObsFlag.SOLID, ph, Kind.Billboard);
    push(bx + px * 4 - pw / 2, bz + pz * 4 - pw / 2, bx + px * 4 + pw / 2, bz + pz * 4 + pw / 2, ObsFlag.SOLID, ph, Kind.Billboard);
    billboards.push({ x: bx, z: bz, ang: a, lit: true });
  }
  // GATEWAY billboards — one big neon sign naming each zone. The follow-cam always looks in a
  // FIXED world direction (−z), so the signs face +z (width along x) → always readable head-on.
  const signGates: { x: number; z: number; y: number; text: string; accent: string; w: number; h: number }[] = [];
  const GATES = [
    { r: 135, ang: Math.PI / 2, text: 'NEON DOWNTOWN', accent: '#5ef2ff' },
    { r: 300, ang: Math.PI * 7 / 6, text: 'NEON SUBURB', accent: '#ffd24a' },
    { r: 505, ang: Math.PI * 11 / 6, text: 'NEON NATIONAL PARK', accent: '#7bf26a' },
  ];
  for (const g of GATES) {
    const gx = Math.cos(g.ang) * g.r, gz = Math.sin(g.ang) * g.r;
    for (const s of [-9, 9]) push(gx + s - 0.8, gz - 0.8, gx + s + 0.8, gz + 0.8, ObsFlag.SOLID, 11, Kind.Billboard); // posts flank along x
    signGates.push({ x: gx, z: gz, y: 8.4, text: g.text, accent: g.accent, w: 18, h: 6 });
  }
  // the suburb shopping MALL — a big ENTERABLE landmark: hollow, door facing the parking lot,
  // with a handful of supply caches inside (you walk in from the lot and loot it)
  push(MALL.x - MALL.w / 2, MALL.z - MALL.d / 2, MALL.x + MALL.w / 2, MALL.z + MALL.d / 2, ObsFlag.SOLID, MALL.h, Kind.Mall, 1, 0);
  roofs.push({ x: MALL.x, z: MALL.z, w: MALL.w, d: MALL.d, y: Math.min(MALL.h, 6.5) + 0.2 });
  for (const [ox, oz, ty] of [[-15, 0, 0], [0, -8, 1], [15, 7, 2], [-9, 9, 0]]) { dx.push(MALL.x + ox); dz.push(MALL.z + oz); dty.push(ty); }

  // boundary ring — thin tall barricade walls that resolve out of the fog as the city edge
  const t = 4, wallH = 20;
  push(-Bd - t, -Bd - t, Bd + t, -Bd, ObsFlag.SOLID, wallH, Kind.Boundary); // south
  push(-Bd - t, Bd, Bd + t, Bd + t, ObsFlag.SOLID, wallH, Kind.Boundary);   // north
  push(-Bd - t, -Bd, -Bd, Bd, ObsFlag.SOLID, wallH, Kind.Boundary);         // west
  push(Bd, -Bd, Bd + t, Bd, ObsFlag.SOLID, wallH, Kind.Boundary);           // east

  // pack into SoA
  const count = minXa.length;
  const obstacles: ObstacleSoA = {
    count,
    minX: Float32Array.from(minXa), minZ: Float32Array.from(minZa),
    maxX: Float32Array.from(maxXa), maxZ: Float32Array.from(maxZa),
    flags: Uint8Array.from(fl), height: Float32Array.from(hh), kind: Uint8Array.from(kk),
    hollow: Uint8Array.from(ho), doorSide: Uint8Array.from(dse),
  };
  const drops: DropList = { count: dx.length, x: Float32Array.from(dx), z: Float32Array.from(dz), type: Uint8Array.from(dty) };

  // bake the collision bitmask
  const blockGrid: BlockGrid = {
    cell: WORLD.CELL, invCell: INV_CELL, dim: DIM, half: WORLD.HALF, bound: WORLD.BOUND,
    blocked: new Uint8Array(DIM * DIM),
  };
  bake(blockGrid, obstacles);
  carveCorridors(blockGrid, obstacles); // open bridge decks & tunnel bores over the baked SOLID

  // ---- meshes ----
  const meshes: THREE.Object3D[] = [];
  const cosmetic: THREE.Object3D[] = []; // toggled by visual tier
  // per-frame fade state for the hollow-building roofs (built below if there are any)
  let roofRT: {
    fade: Float32Array; attr: THREE.BufferAttribute; alpha: Float32Array;
    starts: Int32Array; counts: Int32Array;
    minX: Float32Array; maxX: Float32Array; minZ: Float32Array; maxZ: Float32Array; n: number;
  } | null = null;

  // buildings: ONE merged static geometry (per-building boxes baked into world
  // space, vertex-coloured by kind). One draw call, and it sidesteps a quirk where
  // box InstancedMeshes don't draw under this renderer build.
  if (!skipMeshes && count > 0) {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < count; i++) {
      if (obstacles.kind[i] >= Kind.Mountain) continue; // terrain/structures render in their own layers
      const w = obstacles.maxX[i] - obstacles.minX[i];
      const d = obstacles.maxZ[i] - obstacles.minZ[i];
      const h = obstacles.height[i];
      const cx = (obstacles.minX[i] + obstacles.maxX[i]) / 2;
      const cz = (obstacles.minZ[i] + obstacles.maxZ[i]) / 2;
      const tint = KIND_TINT[obstacles.kind[i]] ?? KIND_TINT[0];
      const j = 0.82 + rng() * 0.22; // grime jitter from the city stream (capped so faces never bloom white)
      const t = [tint[0] * j, tint[1] * j, tint[2] * j];
      const sub = obstacles.hollow[i]
        ? hollowParts(h, w, d, cx, cz, t, obstacles.doorSide[i])      // wall ring (a fade-roof is added below)
        : archetypeParts(obstacles.kind[i] as Kind, w, h, d, cx, cz, t, rng);
      for (const p of sub) parts.push(p);
    }
    const merged = BufferGeometryUtils.mergeGeometries(parts, false);
    parts.forEach(p => p.dispose());
    // faint warm emissive floor so shadowed faces still read against the dark ground
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x161310, flatShading: true });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.frustumCulled = false;
    meshes.push(mesh);
  }

  // fade-able transparent ROOFS over the hollow (cache) buildings — ONE merged mesh whose
  // per-vertex `fade` attribute is the opacity. A faint shell from outside (you make out the
  // structure + glimpse the cache); eases to highly transparent while you're inside (see §
  // updateTunnels). Render-only — never collidable; you still enter through the door.
  if (!skipMeshes && roofs.length > 0) {
    const parts: THREE.BufferGeometry[] = [];
    const starts: number[] = [], counts: number[] = [];
    let vOff = 0;
    for (const r of roofs) {
      const g = paint(new THREE.BoxGeometry(r.w + 0.6, 0.4, r.d + 0.6).translate(r.x, r.y, r.z), 0.17, 0.19, 0.23);
      const vc = g.attributes.position.count;
      starts.push(vOff); counts.push(vc); vOff += vc;
      parts.push(g);
    }
    const merged = BufferGeometryUtils.mergeGeometries(parts, false);
    parts.forEach(p => p.dispose());
    const totalV = merged.attributes.position.count;
    const fade = new Float32Array(totalV).fill(ROOF_OUT);
    const attr = new THREE.BufferAttribute(fade, 1);
    attr.setUsage(THREE.DynamicDrawUsage);
    merged.setAttribute('fade', attr);
    const rmat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, depthWrite: false, emissive: 0x0b0d12 });
    (rmat as unknown as { opacityNode: unknown }).opacityNode = attribute('fade'); // per-vertex opacity → per-building fade
    const rmesh = new THREE.Mesh(merged, rmat);
    rmesh.frustumCulled = false; rmesh.renderOrder = 4;
    meshes.push(rmesh);
    const n = roofs.length;
    roofRT = {
      fade, attr, alpha: new Float32Array(n).fill(ROOF_OUT),
      starts: Int32Array.from(starts), counts: Int32Array.from(counts),
      minX: Float32Array.from(roofs, r => r.x - r.w / 2),
      maxX: Float32Array.from(roofs, r => r.x + r.w / 2),
      minZ: Float32Array.from(roofs, r => r.z - r.d / 2),
      maxZ: Float32Array.from(roofs, r => r.z + r.d / 2),
      n,
    };
  }

  // park terrain — mountains (stepped prisms) + tree trunks merged into ONE Lambert mesh
  if (!skipMeshes && (mountains.length > 0 || trees.length > 0)) {
    const parts: THREE.BufferGeometry[] = [];
    const mt = KIND_TINT[Kind.Mountain], tt = KIND_TINT[Kind.TreeTrunk];
    for (const m of mountains) {
      const L = 4;
      for (let l = 0; l < L; l++) {
        const f = 1 - l / (L + 0.4);              // shrinking footprint up the peak
        const lw = m.r * 2 * f, lh = m.h / L, ly = l * lh;
        const sh = 0.7 + l * 0.12;                // higher layers a touch lighter (snowless crag)
        parts.push(paint(new THREE.BoxGeometry(lw, lh * 1.25, lw).rotateY(l * 0.5).translate(m.x, ly + lh * 0.6, m.z), mt[0] * sh, mt[1] * sh, mt[2] * sh));
      }
    }
    for (const tr of trees) {
      parts.push(paint(new THREE.BoxGeometry(tr.r, tr.h, tr.r).translate(tr.x, tr.h / 2, tr.z), tt[0], tt[1], tt[2]));
    }
    if (parts.length > 0) {
      const merged = BufferGeometryUtils.mergeGeometries(parts, false);
      parts.forEach(p => p.dispose());
      const tmat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0c0e0b, flatShading: true });
      const tmesh = new THREE.Mesh(merged, tmat);
      tmesh.frustumCulled = false;
      meshes.push(tmesh);
    }
  }

  // tree canopies — merged cones you walk UNDER (render-only, dropped on low tier)
  if (!skipMeshes && trees.length > 0) {
    const parts: THREE.BufferGeometry[] = [];
    for (const tr of trees) {
      const cr = tr.r * 3.4, ch = tr.h * 1.3, cy = tr.h * 0.78;
      parts.push(paint(new THREE.ConeGeometry(cr, ch, 6).translate(tr.x, cy + ch / 2, tr.z), 0.10, 0.21, 0.10));
    }
    const merged = BufferGeometryUtils.mergeGeometries(parts, false);
    parts.forEach(p => p.dispose());
    const cmat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x070b07, flatShading: true });
    const canopies = new THREE.Mesh(merged, cmat);
    canopies.frustumCulled = false;
    meshes.push(canopies); cosmetic.push(canopies);
  }

  // lakes — transparent dark quads (the proven plane-instance path; NOT boxes)
  if (!skipMeshes && lakes.length > 0) {
    const wq = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const wmat = new THREE.MeshBasicMaterial({ color: 0x0a2632, transparent: true, opacity: 0.84, depthWrite: false });
    wmat.polygonOffset = true; wmat.polygonOffsetFactor = -2; wmat.polygonOffsetUnits = -3;
    const water = new THREE.InstancedMesh(wq, wmat, lakes.length);
    water.frustumCulled = false;
    water.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const m = new THREE.Matrix4();
    for (let i = 0; i < lakes.length; i++) {
      m.makeScale(lakes[i].r * 2, 1, lakes[i].r * 2); m.setPosition(lakes[i].x, 0.06, lakes[i].z);
      water.setMatrixAt(i, m);
    }
    water.instanceMatrix.needsUpdate = true;
    meshes.push(water);
  }

  // CLIMBABLE MOUNTAIN — a walkable rocky cone + a dirt trail straight up + bushes on the slope
  if (!skipMeshes) {
    const mt = KIND_TINT[Kind.Mountain];
    const cone = paint(new THREE.ConeGeometry(CLIMB.r, CLIMB.h, 24).translate(CLIMB.x, CLIMB.h / 2, CLIMB.z), mt[0] * 0.95, mt[1], mt[2] * 0.9);
    const slope = Math.sqrt(CLIMB.r * CLIMB.r + CLIMB.h * CLIMB.h);
    const trail = paint(new THREE.BoxGeometry(slope, 0.4, 7).rotateZ(Math.atan2(CLIMB.h, -CLIMB.r)).translate(CLIMB.x + CLIMB.r / 2, CLIMB.h / 2 + 0.25, CLIMB.z), 0.26, 0.21, 0.13);
    const merged = BufferGeometryUtils.mergeGeometries([cone, trail], false);
    cone.dispose(); trail.dispose();
    const cmesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0a0c08, flatShading: true }));
    cmesh.frustumCulled = false;
    meshes.push(cmesh);
    // bushes along the slope (small green clumps sitting on the cone surface)
    const bushParts: THREE.BufferGeometry[] = [];
    for (let b = 0; b < 16; b++) {
      const a = b * 2.39996, rr = CLIMB.r * (0.22 + (b % 5) * 0.15); // golden-angle spiral up the cone
      const bx = CLIMB.x + Math.cos(a) * rr, bz = CLIMB.z + Math.sin(a) * rr, bs = 1.3 + (b % 3) * 0.5;
      bushParts.push(paint(new THREE.IcosahedronGeometry(bs, 0).translate(bx, climbHeight(bx, bz) + bs * 0.55, bz), 0.12, 0.32, 0.13));
    }
    const bmerged = BufferGeometryUtils.mergeGeometries(bushParts, false);
    bushParts.forEach(p => p.dispose());
    const bmesh = new THREE.Mesh(bmerged, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x070d07, flatShading: true }));
    bmesh.frustumCulled = false;
    meshes.push(bmesh); cosmetic.push(bmesh); // bushes drop on low tier
  }

  // structures: bridge decks + rails + billboard posts/signs → ONE merged Lambert mesh
  if (!skipMeshes && (bridges.length > 0 || billboards.length > 0)) {
    const parts: THREE.BufferGeometry[] = [];
    const bt = KIND_TINT[Kind.Bridge], bbt = KIND_TINT[Kind.Billboard];
    for (const br of bridges) {
      // a low boardwalk you walk OVER (just above the water), not a raised overpass you pass under
      parts.push(paint(new THREE.BoxGeometry(br.len, 0.22, br.hw * 2).translate(br.x, 0.12, br.z), bt[0], bt[1], bt[2])); // deck
      for (const s of [-1, 1]) parts.push(paint(new THREE.BoxGeometry(br.len, 0.7, 0.45).translate(br.x, 0.45, br.z + s * (br.hw - 0.3)), bt[0] * 1.1, bt[1] * 1.1, bt[2] * 1.1)); // low rails
    }
    for (const bb of billboards) {
      const px = -Math.sin(bb.ang), pz = Math.cos(bb.ang);
      for (const s of [-4, 4]) parts.push(paint(new THREE.BoxGeometry(0.9, 9, 0.9).translate(bb.x + px * s, 4.5, bb.z + pz * s), bbt[0], bbt[1], bbt[2])); // posts
      const lum = bb.lit ? 1.15 : 0.9; // lit signs a touch brighter, but kept well under the bloom threshold
      parts.push(paint(new THREE.BoxGeometry(11, 4.6, 0.5).rotateY(-bb.ang).translate(bb.x, 10.6, bb.z), bbt[0] * lum + (bb.lit ? 0.05 : 0), bbt[1] * lum, bbt[2] * lum + (bb.lit ? 0.06 : 0)));
    }
    const merged = BufferGeometryUtils.mergeGeometries(parts, false);
    parts.forEach(p => p.dispose());
    const smat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x141210, flatShading: true });
    const smesh = new THREE.Mesh(merged, smat);
    smesh.frustumCulled = false;
    meshes.push(smesh);
  }

  // tunnel massifs — each its OWN mesh+material so the roof fades independently as you pass through
  const tunnelRT: { mat: THREE.MeshLambertMaterial; minX: number; minZ: number; maxX: number; maxZ: number; alpha: number }[] = [];
  if (!skipMeshes) {
    const tnt = KIND_TINT[Kind.Tunnel];
    for (const tn of tunnels) {
      const parts = [
        paint(new THREE.BoxGeometry(54, 15, 54).translate(tn.cx, 7.5, tn.cz), tnt[0], tnt[1], tnt[2]),
        paint(new THREE.BoxGeometry(40, 6, 40).rotateY(0.3).translate(tn.cx, 16, tn.cz), tnt[0] * 1.1, tnt[1] * 1.1, tnt[2] * 1.1),
      ];
      const merged = BufferGeometryUtils.mergeGeometries(parts, false);
      parts.forEach(p => p.dispose());
      const tmat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0e0c0b, flatShading: true });
      const tmesh = new THREE.Mesh(merged, tmat);
      tmesh.frustumCulled = false; tmesh.renderOrder = 3;
      meshes.push(tmesh);
      tunnelRT.push({ mat: tmat, minX: tn.minX, minZ: tn.minZ, maxX: tn.maxX, maxZ: tn.maxZ, alpha: 1 });
    }
  }

  // roads: oriented dark quads — downtown grid disc + winding suburb arterials + radial spokes
  if (!skipMeshes && roadSegs.length > 0) {
    const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const rmat = new THREE.MeshBasicMaterial({ color: 0x0a0c12 }); // dark asphalt
    rmat.polygonOffset = true; rmat.polygonOffsetFactor = -1; rmat.polygonOffsetUnits = -2;
    const roads = new THREE.InstancedMesh(quad, rmat, roadSegs.length);
    roads.frustumCulled = false;
    roads.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const m = new THREE.Matrix4(), rot = new THREE.Matrix4(), sc = new THREE.Matrix4(), pos = new THREE.Matrix4();
    for (let i = 0; i < roadSegs.length; i++) {
      const s = roadSegs[i];
      const len = Math.hypot(s.bx - s.ax, s.bz - s.az) || 0.001;
      const ang = Math.atan2(s.bz - s.az, s.bx - s.ax);
      sc.makeScale(len, 1, s.hw * 2);
      rot.makeRotationY(-ang);
      pos.makeTranslation((s.ax + s.bx) / 2, 0.02, (s.az + s.bz) / 2);
      m.multiplyMatrices(pos, rot).multiply(sc);
      roads.setMatrixAt(i, m);
    }
    roads.instanceMatrix.needsUpdate = true;
    meshes.push(roads);
  }

  // park hiking trails: narrow dusty dirt paths (lighter + thinner than the asphalt roads)
  if (!skipMeshes && trailSegs.length > 0) {
    const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const tmat = new THREE.MeshBasicMaterial({ color: 0x3a2f1e }); // dusty trail dirt
    tmat.polygonOffset = true; tmat.polygonOffsetFactor = -1; tmat.polygonOffsetUnits = -2;
    const trails = new THREE.InstancedMesh(quad, tmat, trailSegs.length);
    trails.frustumCulled = false;
    trails.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const m = new THREE.Matrix4(), rot = new THREE.Matrix4(), sc = new THREE.Matrix4(), pos = new THREE.Matrix4();
    for (let i = 0; i < trailSegs.length; i++) {
      const s = trailSegs[i];
      const len = Math.hypot(s.bx - s.ax, s.bz - s.az) || 0.001;
      const ang = Math.atan2(s.bz - s.az, s.bx - s.ax);
      // overlap each chord a touch so the bends don't gap
      sc.makeScale(len + 1.5, 1, s.hw * 2);
      rot.makeRotationY(-ang);
      pos.makeTranslation((s.ax + s.bx) / 2, 0.03, (s.az + s.bz) / 2);
      m.multiplyMatrices(pos, rot).multiply(sc);
      trails.setMatrixAt(i, m);
    }
    trails.instanceMatrix.needsUpdate = true;
    meshes.push(trails);
  }

  // gateway zone-name signs: merged dark posts + a glowing textured sign quad facing the centre
  if (!skipMeshes && signGates.length > 0) {
    const postParts: THREE.BufferGeometry[] = [];
    const bbt = KIND_TINT[Kind.Billboard];
    for (const sg of signGates) {
      for (const s of [-9, 9]) postParts.push(paint(new THREE.BoxGeometry(1.4, 11, 1.4).translate(sg.x + s, 5.5, sg.z), bbt[0], bbt[1], bbt[2]));
      const mat = new THREE.MeshBasicMaterial({ map: makeSignTexture(sg.text, sg.accent), toneMapped: false, side: THREE.DoubleSide });
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(sg.w, sg.h), mat);
      sign.position.set(sg.x, sg.y, sg.z);
      // FIXED orientation (never tracks the player): tilt so the face is head-on to the camera's
      // constant 60°-down view direction → readable when ahead, like a real billboard.
      sign.rotation.x = -1.05;
      sign.frustumCulled = false;
      meshes.push(sign);
    }
    const merged = BufferGeometryUtils.mergeGeometries(postParts, false);
    postParts.forEach(p => p.dispose());
    const pmesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x141210, flatShading: true }));
    pmesh.frustumCulled = false;
    meshes.push(pmesh);
  }

  // the mall's huge parking lot — a paved quad with painted stalls + a scatter of parked cars
  if (!skipMeshes) {
    const lot = new THREE.Mesh(new THREE.PlaneGeometry(MALL.lotW, MALL.lotD).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: makeParkingTexture() }));
    (lot.material as THREE.MeshBasicMaterial).polygonOffset = true;
    (lot.material as THREE.MeshBasicMaterial).polygonOffsetFactor = -1;
    (lot.material as THREE.MeshBasicMaterial).polygonOffsetUnits = -2;
    lot.position.set(MALL.x, 0.025, MALL.lotZ);
    lot.frustumCulled = false;
    meshes.push(lot);
    const carParts: THREE.BufferGeometry[] = [];
    const carCols = [[0.5, 0.13, 0.13], [0.12, 0.3, 0.5], [0.5, 0.46, 0.13], [0.32, 0.34, 0.38], [0.42, 0.42, 0.45], [0.15, 0.42, 0.32]];
    const stalls = [[-27, 9], [-21, 9], [-15, 9], [-9, 9], [9, 9], [15, 9], [21, 9], [27, 9], [-27, -9], [-21, -9], [-9, -9], [-3, -9], [9, -9], [21, -9]];
    let ci = 0;
    for (const [ox, oz] of stalls) {
      if (((ox * 7 + oz * 3) & 3) === 0) continue; // some empty stalls
      const c = carCols[ci++ % carCols.length];
      const bx = MALL.x + ox, bz = MALL.lotZ + oz;
      carParts.push(paint(new THREE.BoxGeometry(2.0, 1.0, 3.7).translate(bx, 0.6, bz), c[0], c[1], c[2]));      // body
      carParts.push(paint(new THREE.BoxGeometry(1.7, 0.7, 1.9).translate(bx, 1.4, bz), c[0] * 0.8, c[1] * 0.8, c[2] * 0.8)); // cabin
    }
    if (carParts.length > 0) {
      const cmerged = BufferGeometryUtils.mergeGeometries(carParts, false);
      carParts.forEach(p => p.dispose());
      const cmesh = new THREE.Mesh(cmerged, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0a0a0c, flatShading: true }));
      cmesh.frustumCulled = false;
      meshes.push(cmesh);
    }
  }

  void H; // (reserved for future bounds use)

  const city: City = {
    obstacles, blockGrid, drops, meshes, seed,
    zoneAt(x: number, z: number): Zone { return zoneAt(x, z, warp); },
    warp,
    groundHeight(x: number, z: number): number { return climbHeight(x, z); },
    climb: { x: CLIMB.x, z: CLIMB.z, r: CLIMB.r, h: CLIMB.h },
    setVisualTier(tier: number): void {
      // collidable rects are identical across tiers; only cosmetics toggle
      const show = tier <= 1;
      for (const c of cosmetic) c.visible = show;
    },
    // fade a tunnel's roof when the PLAYER (only) is inside its bore — sub-µs, real dt.
    // Collision is decoupled: the horde streams through the carved-free bore regardless.
    updateTunnels(px: number, pz: number, dt: number): void {
      const k = Math.min(1, dt * 6); // frame-rate-independent ease
      for (let i = 0; i < tunnelRT.length; i++) {
        const tr = tunnelRT[i];
        const inside = px >= tr.minX && px <= tr.maxX && pz >= tr.minZ && pz <= tr.maxZ;
        tr.alpha += ((inside ? 0.14 : 1.0) - tr.alpha) * k;
        tr.mat.opacity = tr.alpha;
        tr.mat.transparent = tr.alpha < 0.999;
        tr.mat.depthWrite = !tr.mat.transparent;
      }
      // hollow-building roofs: fade the one you're standing in toward ROOF_IN, others to ROOF_OUT.
      // Only the transitioning buildings' vert ranges are dirty → upload just that span.
      const rr = roofRT;
      if (rr) {
        let dmin = Infinity, dmax = 0;
        for (let i = 0; i < rr.n; i++) {
          const inside = px >= rr.minX[i] && px <= rr.maxX[i] && pz >= rr.minZ[i] && pz <= rr.maxZ[i];
          const a = rr.alpha[i] + ((inside ? ROOF_IN : ROOF_OUT) - rr.alpha[i]) * k;
          if (Math.abs(a - rr.alpha[i]) > 0.0008) {
            rr.alpha[i] = a;
            const s = rr.starts[i], end = s + rr.counts[i];
            for (let v = s; v < end; v++) rr.fade[v] = a;
            if (s < dmin) dmin = s;
            if (end > dmax) dmax = end;
          }
        }
        if (dmax > dmin) {
          rr.attr.clearUpdateRanges();
          rr.attr.addUpdateRange(dmin, dmax - dmin); // upload only the changed span
          rr.attr.needsUpdate = true;
        }
      }
    },
  };
  return city;
}

export function disposeCity(scene: THREE.Scene, city: City): void {
  for (const o of city.meshes) {
    scene.remove(o);
    o.traverse(n => {
      const mesh = n as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach(mm => mm.dispose());
      else mat?.dispose();
    });
  }
}

/** debug/selftest: how many free cells are reachable from origin (navigability) */
export function _reachable(g: BlockGrid): number { return reachableFromOrigin(g); }
