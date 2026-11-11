/**
 * Seeded PRNG for the gameplay simulation — the spine of determinism.
 *
 * Gameplay randomness is split into INDEPENDENT seeded streams so one system's
 * draws can never shift another's (e.g. how often you fire must not change which
 * upgrades you're offered or what spawns next):
 *   - spawnRand()          spawn director: spawn angle/radius/type, enemy speed, boss angle
 *   - combatRand()         combat rolls: gun crits, boss gem scatter, gem-pool overflow
 *   - nextUpgradeStream()  a FRESH stream per level-up offer, derived from (seed, level-up
 *                          index) only — so the Nth offer is the same however the run went
 *   - streamFrom(CITY_SALT) city generation (city.ts), untouched by all of the above
 * Seeding them (setSeed) makes a run reproducible from (seed + the player's input
 * log), which is what unlocks daily-seed leaderboards, "beat my exact run"
 * challenge links, server-side anti-cheat re-simulation, and same-seed
 * multiplayer — all WITHOUT ever networking the 20k-enemy horde.
 *
 * COSMETIC randomness (screen shake, particle spread, the per-enemy colour/bob
 * jitter) deliberately stays on Math.random so it never enters the seeded
 * streams and never has to match across machines or replays.
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

let _seed = 0;
let _seeded = false;
let _spawn: () => number = Math.random;
let _combat: () => number = Math.random;
let _upgradeRolls = 0; // level-up offers rolled since the last setSeed

/** salt for the city-generation stream (kept distinct from the gameplay streams) */
export const CITY_SALT = 0x00c17;
export const SPAWN_SALT = 0x5b4a1;
export const COMBAT_SALT = 0xc0b47;
/** base salt for the per-offer upgrade streams; the level-up index is added to it */
export const UPGRADE_SALT = 0x0b9ad000;

/**
 * An INDEPENDENT seeded stream derived from (seed ^ salt) via an xmur3 avalanche
 * → mulberry32. Crucially it NEVER advances the gameplay streams (spawnRand/combatRand/upgrades), so
 * generating the city is fully reproducible from the seed yet decorrelated from
 * (and harmless to) the enemy/upgrade/loot rolls that determinism depends on.
 */
export function streamFrom(salt: number, seed: number = _seed): () => number {
  let h = (seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return mulberry32((h ^ (h >>> 15)) >>> 0);
}

/** seed every gameplay stream (and rewind the level-up index); pass a 32-bit unsigned int */
export function setSeed(seed: number): void {
  _seed = seed >>> 0;
  _seeded = true;
  _spawn = streamFrom(SPAWN_SALT, _seed);
  _combat = streamFrom(COMBAT_SALT, _seed);
  _upgradeRolls = 0;
}

/** the seed currently in use (for share links / leaderboard submission) */
export function getSeed(): number {
  return _seed;
}

/** a fresh random 32-bit seed (used when no ?seed= / daily seed is provided) */
export function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0;
}

/** next SPAWN-director random in [0,1) (spawn placement/type/speed, boss placement) */
export function spawnRand(): number {
  return _spawn();
}

/** next COMBAT random in [0,1) (crit rolls, gem scatter/overflow) */
export function combatRand(): number {
  return _combat();
}

/**
 * The stream for the next level-up offer. Derived from (seed, level-up index) alone, so
 * offer N never depends on how many spawn/combat draws — or earlier shuffle draws — came before.
 */
export function nextUpgradeStream(): () => number {
  const i = _upgradeRolls++;
  return _seeded ? streamFrom((UPGRADE_SALT + i) >>> 0, _seed) : Math.random;
}

/** revert to unseeded (Math.random) gameplay randomness */
export function clearSeed(): void {
  _spawn = _combat = Math.random;
  _seeded = false;
  _seed = 0;
  _upgradeRolls = 0;
}
