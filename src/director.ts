import { ENEMY_TYPES, BOSS_TYPE } from './swarm';

/** seconds between boss spawns; first boss at BOSS_INTERVAL */
export const BOSS_INTERVAL = 70;

/**
 * Ambient enemies spawned per second. Ramps with elapsed time and soft-caps
 * so the spawn director can't outrun the swarm pool or the frame budget.
 */
export function spawnRate(t: number): number {
  return Math.min(48, 2.5 + t * 0.12);
}

/**
 * Pick an ambient enemy type by elapsed time — tougher types unlock later.
 * Never returns the boss (bosses come only from the boss timer). `r` is the
 * roll, injectable for deterministic tests.
 */
export function rollEnemyType(t: number, r: number = Math.random()): number {
  if (t > 240 && r < 0.1) return 3;  // elite
  if (t > 100 && r < 0.22) return 2; // tank
  if (t > 35 && r < 0.42) return 1;  // runner
  return 0;                          // grunt
}

/** HP for the Nth boss (1-based); each successive boss is tougher. */
export function bossHp(bossNumber: number): number {
  return Math.round(ENEMY_TYPES[BOSS_TYPE].hp * (1 + 0.5 * (bossNumber - 1)));
}

/** Enemies in the periodic horde burst, scaled by time and clamped. */
export function hordeSize(t: number): number {
  return Math.min(500, 80 + t * 1.2) | 0;
}
