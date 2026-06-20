/**
 * Daily Challenge: one global seed per UTC day so every player on Earth fights
 * the IDENTICAL run that day (the Wordle / Spelunky-daily / Slay-the-Spire model)
 * — score becomes skill, not luck. Best score per day is kept locally
 * (localStorage) for now; the same daily seed plugs straight into a global
 * server leaderboard later (Phase 2) with no client change.
 *
 * `now` is injectable so this stays pure + testable.
 */
import { type Difficulty, coerceDifficulty } from './modes';

// Daily #1 = 2026-06-01 UTC
const EPOCH = Date.UTC(2026, 5, 1);
const DAY_MS = 86_400_000;

/** YYYY-MM-DD (UTC) for the given time */
export function dailyKey(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** sequential daily number (Daily #N) */
export function dailyNumber(now: number): number {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((today - EPOCH) / DAY_MS) + 1;
}

/** deterministic 32-bit seed from the UTC date (FNV-1a over the date string) */
export function dailySeed(now: number): number {
  const k = dailyKey(now);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < k.length; i++) {
    h ^= k.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** seconds until the next UTC day (for a countdown) */
export function secondsToNextDaily(now: number): number {
  return Math.ceil((DAY_MS - (now % DAY_MS)) / 1000);
}

// --- local best per daily PER MODE (localStorage) ---
// easy/medium/hard are independent leaderboards. Old un-suffixed keys are NOT
// migrated (the historical assist tier is unknown — seeding a board would corrupt it).
const keyFor = (num: number, mode: Difficulty) => `ns-daily-best-${num}-${coerceDifficulty(mode)}`;

export function getDailyBest(num: number, mode: Difficulty): number {
  try {
    return Number(localStorage.getItem(keyFor(num, mode))) || 0;
  } catch {
    return 0;
  }
}

/** record a daily score for a mode; returns true if it's a new best for that (day, mode) */
export function recordDailyScore(num: number, mode: Difficulty, score: number): boolean {
  try {
    if (score > getDailyBest(num, mode)) {
      localStorage.setItem(keyFor(num, mode), String(score));
      return true;
    }
  } catch {
    /* storage unavailable */
  }
  return false;
}
