import * as THREE from 'three/webgpu';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
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
export const enum Kind { House = 0, Hospital = 1, Cinema = 2, Ruin = 3, Rubble = 4, Boundary = 5 }

export interface ObstacleSoA {
  count: number;
  minX: Float32Array; minZ: Float32Array;
  maxX: Float32Array; maxZ: Float32Array;
  flags: Uint8Array;   // ObsFlag bitset
  height: Float32Array;
  kind: Uint8Array;
}

export interface BlockGrid {
  cell: number; invCell: number; dim: number; half: number;
  blocked: Uint8Array; // dim*dim, 1 = solid
}

export interface City {
  obstacles: ObstacleSoA;
  blockGrid: BlockGrid;
  meshes: THREE.Object3D[];
  seed: number;
  setVisualTier(tier: number): void;
  updateTunnels(px: number, pz: number, dt: number): void;
}

// ---- generation tunables (counts are SEED-only — never tier/device derived) ----
const CITY = {
  BLOCK: 46,          // road-grid pitch (a lot + a road)
  ROAD_W: 9,          // road width carved between lots
  DENSITY: 0.66,      // P(a lot holds a building)
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

// ---- bake SOLID rects into the bitmask (PASS_UNDER/TUNNEL skipped → walk-under) ----
function bake(g: BlockGrid, s: ObstacleSoA): void {
  const { blocked, dim, invCell, half } = g;
  blocked.fill(0);
  const max = dim - 1;
  const cl = (v: number) => (v < 0 ? 0 : v > max ? max : v);
  for (let i = 0; i < s.count; i++) {
    if (!(s.flags[i] & ObsFlag.SOLID)) continue;
    const cx0 = cl(((s.minX[i] + half) * invCell) | 0);
    const cz0 = cl(((s.minZ[i] + half) * invCell) | 0);
    const cx1 = cl(((s.maxX[i] + half) * invCell) | 0);
    const cz1 = cl(((s.maxZ[i] + half) * invCell) | 0);
    for (let cz = cz0; cz <= cz1; cz++) blocked.fill(1, cz * dim + cx0, cz * dim + cx1 + 1);
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

// ---- generation ----
export function generateCity(seed: number, isTouch: boolean): City {
  void isTouch; // collidable set is identical across devices/tiers (seed-only) — fairness/determinism
  const rng = streamFrom(CITY_SALT, seed);

  const minXa: number[] = [], minZa: number[] = [], maxXa: number[] = [], maxZa: number[] = [];
  const fl: number[] = [], hh: number[] = [], kk: number[] = [];
  const push = (mnX: number, mnZ: number, mxX: number, mxZ: number, flag: number, height: number, kind: number): void => {
    minXa.push(mnX); minZa.push(mnZ); maxXa.push(mxX); maxZa.push(mxZ); fl.push(flag); hh.push(height); kk.push(kind);
  };

  const H = WORLD.HALF, B = CITY.BLOCK, road = CITY.ROAD_W;
  const lotIn = (B - road); // usable lot span
  const grid = Math.floor((WORLD.SIZE - 40) / B); // leave a margin inside the boundary ring
  const start = -((grid * B) / 2);

  // buildings, lot by lot in fixed row-major order (deterministic)
  for (let gz = 0; gz < grid; gz++) {
    for (let gx = 0; gx < grid; gx++) {
      const lotCx = start + gx * B + B / 2;
      const lotCz = start + gz * B + B / 2;
      const r0 = rng(); // one roll per lot regardless of outcome → stream length is layout-stable
      if (r0 > CITY.DENSITY) continue;
      if (Math.hypot(lotCx, lotCz) < CITY.SPAWN_SAFE_R + lotIn) continue; // keep the start clear
      // pick kind
      const kr = rng();
      let kind = Kind.House;
      for (let k = 0; k < CITY.KIND_CDF.length; k++) { if (kr <= CITY.KIND_CDF[k]) { kind = k as Kind; break; } }
      // footprint within the lot (jittered, never spilling onto the road)
      const fw = lotIn * (0.55 + rng() * 0.4);
      const fd = lotIn * (0.55 + rng() * 0.4);
      const jx = (rng() - 0.5) * (lotIn - fw) * 0.6;
      const jz = (rng() - 0.5) * (lotIn - fd) * 0.6;
      const cx = lotCx + jx, cz = lotCz + jz;
      // height by kind: hospitals tall, cinemas mid+wide, houses low, ruins broken
      let height = 6;
      if (kind === Kind.Hospital) height = 16 + rng() * 12;
      else if (kind === Kind.Cinema) height = 9 + rng() * 5;
      else if (kind === Kind.House) height = 5 + rng() * 4;
      else if (kind === Kind.Ruin) height = 4 + rng() * 7;       // jagged remains
      else height = 1.5 + rng() * 2.5;                            // rubble pile
      push(cx - fw / 2, cz - fd / 2, cx + fw / 2, cz + fd / 2, ObsFlag.SOLID, height, kind);
    }
  }

  // boundary ring — tall barricade walls that resolve out of the fog as the city edge
  const Bd = WORLD.BOUND, t = 10, wallH = 22;
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
  };

  // bake the collision bitmask
  const blockGrid: BlockGrid = {
    cell: WORLD.CELL, invCell: INV_CELL, dim: DIM, half: WORLD.HALF,
    blocked: new Uint8Array(DIM * DIM),
  };
  bake(blockGrid, obstacles);

  // ---- meshes ----
  const meshes: THREE.Object3D[] = [];
  const cosmetic: THREE.Object3D[] = []; // toggled by visual tier

  // buildings: ONE merged static geometry (per-building boxes baked into world
  // space, vertex-coloured by kind). One draw call, and it sidesteps a quirk where
  // box InstancedMeshes don't draw under this renderer build.
  if (count > 0) {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < count; i++) {
      const w = obstacles.maxX[i] - obstacles.minX[i];
      const d = obstacles.maxZ[i] - obstacles.minZ[i];
      const h = obstacles.height[i];
      const cx = (obstacles.minX[i] + obstacles.maxX[i]) / 2;
      const cz = (obstacles.minZ[i] + obstacles.maxZ[i]) / 2;
      const bg = new THREE.BoxGeometry(w, h, d).translate(cx, h / 2, cz); // base on y=0
      const tint = KIND_TINT[obstacles.kind[i]] ?? KIND_TINT[0];
      const j = 0.85 + rng() * 0.3; // grime jitter from the city stream
      const r = tint[0] * j, g = tint[1] * j, b = tint[2] * j;
      const nv = bg.attributes.position.count;
      const colors = new Float32Array(nv * 3);
      for (let k = 0; k < nv; k++) { colors[k * 3] = r; colors[k * 3 + 1] = g; colors[k * 3 + 2] = b; }
      bg.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      parts.push(bg);
    }
    const merged = BufferGeometryUtils.mergeGeometries(parts, false);
    parts.forEach(p => p.dispose());
    // faint warm emissive floor so shadowed faces still read against the dark ground
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x161310, flatShading: true });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.frustumCulled = false;
    meshes.push(mesh);
  }

  // roads: dark strips along the grid lines (cosmetic, never collidable)
  {
    const lines = grid + 1;
    const roadCount = lines * 2;
    const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const rmat = new THREE.MeshBasicMaterial({ color: 0x0a0c12 }); // dark asphalt
    rmat.polygonOffset = true; rmat.polygonOffsetFactor = -1; rmat.polygonOffsetUnits = -2;
    const roads = new THREE.InstancedMesh(quad, rmat, roadCount);
    roads.frustumCulled = false;
    roads.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const m = new THREE.Matrix4();
    const span = grid * B;
    let ri = 0;
    for (let i = 0; i < lines; i++) {
      const p = start + i * B - road / 2 + road / 2; // line centre
      m.makeScale(road, 1, span); m.setPosition(p, 0.02, 0); roads.setMatrixAt(ri++, m); // vertical road
      m.makeScale(span, 1, road); m.setPosition(0, 0.02, p); roads.setMatrixAt(ri++, m); // horizontal road
    }
    roads.instanceMatrix.needsUpdate = true;
    meshes.push(roads);
  }

  void H; // (reserved for future bounds use)

  const city: City = {
    obstacles, blockGrid, meshes, seed,
    setVisualTier(tier: number): void {
      // collidable rects are identical across tiers; only cosmetics toggle
      const show = tier <= 1;
      for (const c of cosmetic) c.visible = show;
    },
    updateTunnels(): void { /* Phase 3 */ },
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
