/**
 * Meta-progression — "failure banks progress", the genre's #1 retention hook.
 * Every run's outcome accumulates into persistent stats (localStorage), and
 * crossing a milestone permanently unlocks a CAPABILITY: a secondary weapon you
 * then start every run with. Capability-changing, NOT flat-% stat creep (the
 * anti-pattern both reports called out). Freeplay only — the daily stays a pure,
 * equal-footing competition, so unlocks never apply there.
 *
 * `now`-free + pure-ish (localStorage is try/catch-guarded exactly like daily.ts).
 */
const META_KEY = 'ns-meta';

export interface Meta {
  kills: number;   // lifetime kills across all freeplay runs
  runs: number;    // total runs finished
  maxZone: number; // furthest zone reached (0 downtown / 1 suburb / 2 park)
}

export function getMeta(): Meta {
  try {
    const r = JSON.parse(localStorage.getItem(META_KEY) || 'null');
    if (r && typeof r.kills === 'number') return { kills: r.kills | 0, runs: r.runs | 0, maxZone: r.maxZone | 0 };
  } catch { /* storage unavailable / corrupt */ }
  return { kills: 0, runs: 0, maxZone: 0 };
}

/** fold a finished run into the lifetime totals; returns the updated meta */
export function recordRun(kills: number, zoneReached: number): Meta {
  const m = getMeta();
  m.kills += Math.max(0, kills | 0);
  m.runs += 1;
  m.maxZone = Math.max(m.maxZone, zoneReached | 0);
  try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch { /* ignore */ }
  return m;
}

export interface Unlock {
  id: 'orbital' | 'drone' | 'tesla' | 'drone2';
  name: string;
  desc: string;
  has: (m: Meta) => boolean; // milestone predicate
}

// Ordered easy→hard. Each grants a STARTING secondary weapon (a capability), so a
// returning player begins stronger — the "one more run" ratchet.
export const UNLOCKS: Unlock[] = [
  { id: 'orbital', name: 'Orbital Guard', desc: 'start with a spinning blade', has: m => m.maxZone >= 1 },   // reach the suburb
  { id: 'drone',   name: 'Recon Drone',  desc: 'start with a combat drone',    has: m => m.kills >= 150 },
  { id: 'tesla',   name: 'Arc Capacitor', desc: 'start with chain lightning',  has: m => m.maxZone >= 2 },   // reach the national park
  { id: 'drone2',  name: 'Drone Wing',   desc: 'start with a stronger drone',  has: m => m.kills >= 1500 },
];

/** ids of every unlock the given (or stored) meta has earned */
export function unlockedIds(m: Meta = getMeta()): string[] {
  return UNLOCKS.filter(u => u.has(m)).map(u => u.id);
}

/** the starting-secondary fields of GameState that meta unlocks may touch */
export interface SecondaryLevels { orbitalLevel: number; droneLevel: number; teslaLevel: number }

/**
 * Stamp the deploy-time starting secondaries onto a fresh run's state.
 * FREEPLAY: raise each secondary to its earned unlock level (never downgrade —
 * cheats/upgrades already applied stay). DAILY: explicitly CLEAR all three, so a
 * prior freeplay run in the same session can never leak unlocks into the
 * equal-footing competition. Called by main.ts deploy(); pure so the selftest
 * can pin the isolation invariant.
 */
export function applyStartingSecondaries(s: SecondaryLevels, isDaily: boolean, ids: string[] = unlockedIds()): void {
  if (isDaily) {
    s.orbitalLevel = 0;
    s.droneLevel = 0;
    s.teslaLevel = 0;
    return;
  }
  if (ids.includes('orbital')) s.orbitalLevel = Math.max(s.orbitalLevel, 1);
  if (ids.includes('drone')) s.droneLevel = Math.max(s.droneLevel, 1);
  if (ids.includes('drone2')) s.droneLevel = Math.max(s.droneLevel, 2);
  if (ids.includes('tesla')) s.teslaLevel = Math.max(s.teslaLevel, 1);
}
