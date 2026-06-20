/**
 * Difficulty / control-assist modes, shared by settings + daily (no import cycle).
 * A mode only changes the player's aim/fire ASSISTANCE — never the seed or sim RNG,
 * so determinism is preserved and the daily seed alone fixes the spawns.
 */
export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

/** strict whitelist — junk in -> 'easy', so a leaderboard key can never be malformed */
export function coerceDifficulty(m: unknown): Difficulty {
  return (DIFFICULTIES as string[]).includes(m as string) ? (m as Difficulty) : 'easy';
}

/** the 3 control booleans each preset stamps (the ONLY place this mapping lives) */
export function presetFlags(d: Difficulty): { autoFire: boolean; gunLock: boolean; missileLock: boolean } {
  switch (d) {
    case 'easy': return { autoFire: true, gunLock: true, missileLock: true };
    case 'medium': return { autoFire: true, gunLock: false, missileLock: false };
    case 'hard': return { autoFire: false, gunLock: false, missileLock: false };
  }
}

/** derive the matching preset from booleans (for UI highlight), or null if hand-tuned */
export function flagsToPreset(s: { autoFire: boolean; gunLock: boolean; missileLock: boolean }): Difficulty | null {
  for (const d of DIFFICULTIES) {
    const f = presetFlags(d);
    if (f.autoFire === s.autoFire && f.gunLock === s.gunLock && f.missileLock === s.missileLock) return d;
  }
  return null;
}
