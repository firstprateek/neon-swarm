/**
 * Seeded PRNG for the gameplay simulation — the spine of determinism.
 *
 * The GAMEPLAY stream (`srand`) drives everything that affects the outcome:
 * enemy spawn types/positions/speeds, boss spawns, upgrade rolls, loot scatter.
 * Seeding it (setSeed) makes a run reproducible from (seed + the player's input
 * log), which is what unlocks daily-seed leaderboards, "beat my exact run"
 * challenge links, server-side anti-cheat re-simulation, and same-seed
 * multiplayer — all WITHOUT ever networking the 20k-enemy horde.
 *
 * COSMETIC randomness (screen shake, particle spread, the per-enemy colour/bob
 * jitter) deliberately stays on Math.random so it never enters the seeded
 * stream and never has to match across machines or replays.
 *
 * Default (no seed set) === Math.random, so unseeded play is byte-for-byte the
 * old behaviour; determinism only kicks in once setSeed() is called.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _rng: () => number = Math.random;
let _seed = 0;

/** salt for the city-generation stream (kept distinct from any future streams) */
export const CITY_SALT = 0x00c17;

/**
 * An INDEPENDENT seeded stream derived from (seed ^ salt) via an xmur3 avalanche
 * → mulberry32. Crucially it NEVER advances the gameplay `srand()` cursor, so
 * generating the city is fully reproducible from the seed yet decorrelated from
 * (and harmless to) the enemy/upgrade/loot rolls that determinism depends on.
 */
export function streamFrom(salt: number, seed: number = _seed): () => number {
  let h = (seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return mulberry32((h ^ (h >>> 15)) >>> 0);
}

/** seed the gameplay stream; pass a 32-bit unsigned int */
export function setSeed(seed: number): void {
  _seed = seed >>> 0;
  _rng = mulberry32(_seed);
}

/** the seed currently in use (for share links / leaderboard submission) */
export function getSeed(): number {
  return _seed;
}

/** a fresh random 32-bit seed (used when no ?seed= / daily seed is provided) */
export function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0;
}

/** next gameplay random in [0,1) — use this instead of Math.random for anything that affects the run */
export function srand(): number {
  return _rng();
}

/** revert to unseeded (Math.random) gameplay randomness */
export function clearSeed(): void {
  _rng = Math.random;
  _seed = 0;
}
