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
  };
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
];

export function rollUpgrades(n = 3): Upgrade[] {
  const pool = UPGRADES.filter(u => u.count < u.max);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
}
