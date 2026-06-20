import { srand } from './rng';

export interface GameState {
  hp: number;
  maxHp: number;
  regen: number;
  xp: number;
  level: number;
  xpNeed: number;
  pendingLevels: number;
  kills: number;
  time: number;
  dmg: number;
  fireRate: number;
  projectiles: number;
  pierce: number;
  moveSpeed: number;
  magnet: number;
  bulletSpeed: number;
  // secondary weapons — level 0 means not yet acquired
  orbitalLevel: number;
  teslaLevel: number;
  // scoring (also the future global-leaderboard metric)
  score: number;
  combo: number;
  comboPeak: number;
  comboTimer: number;
  // active abilities (limited charges)
  missiles: number;
  nukes: number;
}

export function createState(): GameState {
  return {
    hp: 100,
    maxHp: 100,
    regen: 0,
    xp: 0,
    level: 1,
    xpNeed: 8,
    pendingLevels: 0,
    kills: 0,
    time: 0,
    dmg: 4,
    fireRate: 4,
    projectiles: 1,
    pierce: 0,
    moveSpeed: 11,
    magnet: 4.5,
    bulletSpeed: 36,
    orbitalLevel: 0,
    teslaLevel: 0,
    score: 0,
    combo: 0,
    comboPeak: 0,
    comboTimer: 0,
    missiles: 3,
    nukes: 1,
  };
}

// active-ability tuning
export const MISSILE_MAX = 6;
export const NUKE_MAX = 3;
export const MISSILE_REFILL = 11; // seconds per regained missile
export const MISSILE_DMG = 55;
export const MISSILE_AOE = 6.5;
export const NUKE_DMG = 100000; // effectively clears the screen

/** base score per enemy type index (grunt, runner, tank, elite, boss) —
 * tougher/faster enemies reward more (runner > grunt, per playtest feedback) */
export const SCORE_BY_TYPE = [1, 2, 6, 25, 300];
const COMBO_WINDOW = 2.5; // seconds before the combo resets
const COMBO_CAP = 40;     // combo count beyond which the multiplier stops growing

/** current score multiplier from the combo meter (1.0 .. 5.0) */
export function comboMultiplier(s: GameState): number {
  return 1 + Math.min(s.combo, COMBO_CAP) * 0.1;
}

/** register a kill: extend the combo and add combo-scaled score */
export function registerKill(s: GameState, type: number): void {
  s.combo++;
  if (s.combo > s.comboPeak) s.comboPeak = s.combo;
  s.comboTimer = COMBO_WINDOW;
  const base = SCORE_BY_TYPE[type] ?? 1;
  s.score += Math.round(base * comboMultiplier(s));
}

/** decay the combo window; reset the combo when it lapses */
export function tickCombo(s: GameState, dt: number): void {
  if (s.comboTimer > 0) {
    s.comboTimer -= dt;
    if (s.comboTimer <= 0) {
      s.comboTimer = 0;
      s.combo = 0;
    }
  }
}

export function xpForLevel(level: number): number {
  return Math.round(8 * Math.pow(1.33, level - 1));
}

/** Add XP, cascading through any number of level-ups. */
export function grantXp(s: GameState, v: number): void {
  s.xp += v;
  while (s.xp >= s.xpNeed) {
    s.xp -= s.xpNeed;
    s.level++;
    s.xpNeed = xpForLevel(s.level);
    s.pendingLevels++;
  }
}

export interface Upgrade {
  name: string;
  desc: string;
  max: number;
  count: number;
  apply: (s: GameState) => void;
}

export const UPGRADES: Upgrade[] = [
  { name: 'Plasma Overcharge', desc: '+30% damage', max: 8, count: 0, apply: s => { s.dmg *= 1.3; } },
  { name: 'Rapid Cycler', desc: '+25% fire rate', max: 8, count: 0, apply: s => { s.fireRate *= 1.25; } },
  { name: 'Split Shot', desc: '+1 projectile per volley', max: 6, count: 0, apply: s => { s.projectiles += 1; } },
  { name: 'Piercing Rounds', desc: 'shots pierce +1 enemy', max: 6, count: 0, apply: s => { s.pierce += 1; } },
  { name: 'Overdrive Thrusters', desc: '+12% move speed', max: 5, count: 0, apply: s => { s.moveSpeed *= 1.12; } },
  { name: 'Tractor Field', desc: '+45% pickup range', max: 6, count: 0, apply: s => { s.magnet *= 1.45; } },
  { name: 'Hull Plating', desc: '+30 max HP, restore 30 HP', max: 6, count: 0, apply: s => { s.maxHp += 30; s.hp = Math.min(s.maxHp, s.hp + 30); } },
  { name: 'Nanobot Repair', desc: '+1 HP/s regeneration', max: 5, count: 0, apply: s => { s.regen += 1; } },
  { name: 'Orbital Blades', desc: 'spinning blades shred foes on contact (+1 blade / level)', max: 5, count: 0, apply: s => { s.orbitalLevel += 1; } },
  { name: 'Arc Tesla', desc: 'chain lightning zaps nearby foes (+1 chain / level)', max: 5, count: 0, apply: s => { s.teslaLevel += 1; } },
];

export function rollUpgrades(n = 3): Upgrade[] {
  const pool = UPGRADES.filter(u => u.count < u.max);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (srand() * (i + 1)) | 0;
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
}
