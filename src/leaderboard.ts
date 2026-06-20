// src/leaderboard.ts — global daily leaderboard, off-guarded exactly like feedback.ts.
//
// FEATURE-FLAGGED OFF: when LEADERBOARD_ENDPOINT is null, submitScore/flush/fetchBoard
// are all no-ops and the game keeps its local-best behavior. Submit is fire-and-forget
// (queued + retried offline); fetchBoard is async and NEVER blocks a frame.
import type { Difficulty } from './modes';
import { dailyKey } from './daily';
import { LEADERBOARD_ENDPOINT, APP_VERSION } from './config';
import { isOptedOut } from './telemetry';

const HANDLE_KEY = 'ns-lb-handle';
const QUEUE_KEY = 'ns-lb-queue';
const MAX_QUEUE = 50;
const FETCH_TIMEOUT = 3000;

export interface ScoreInput {
  score: number; kills: number; level: number; time: number; combo_peak: number;
  survivor: string; mode: Difficulty; seed: number; daily_num: number;
  backend: 'webgpu' | 'webgl2';
}
export interface BoardEntry { rank: number; score: number; kills: number; level: number; run_time: number; survivor: string; handle?: string }
export interface Board {
  daily_num: number; mode: Difficulty; total: number; reset_in_s: number;
  your_rank: number | null; your_best: BoardEntry | null; top: BoardEntry[]; streak?: number;
}

type QueuedScore = Record<string, unknown> & { id: string; ts: number; attempts: number };
const rd = (): QueuedScore[] => { try { const a = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const wr = (q: QueuedScore[]) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE))); } catch { /* ignore */ } };

export function getHandle(): string | null { try { return localStorage.getItem(HANDLE_KEY); } catch { return null; } }
export function setHandle(h: string | null): void { try { if (h) localStorage.setItem(HANDLE_KEY, h); else localStorage.removeItem(HANDLE_KEY); } catch { /* ignore */ } }
export function suggestHandle(): string {
  const A = ['Neon', 'Steel', 'Void', 'Ghost', 'Rogue', 'Wild', 'Dark', 'Swift'];
  const N = ['Reaper', 'Wasp', 'Raider', 'Shade', 'Storm', 'Venom', 'Spark', 'Runner'];
  return A[(Math.random() * A.length) | 0] + N[(Math.random() * N.length) | 0] + (100 + ((Math.random() * 900) | 0));
}

/** Queue + fire-and-forget. Call from gameOver() AFTER recordDailyScore (no double-call). */
export function submitScore(s: ScoreInput): void {
  if (!LEADERBOARD_ENDPOINT || isOptedOut()) return; // OFF or opted-out => no-op
  const item: QueuedScore = {
    v: 1, daily_key: dailyKey(Date.now()), daily_num: s.daily_num, seed: s.seed, mode: s.mode,
    score: s.score, kills: s.kills, level: s.level, run_time: s.time, combo_peak: s.combo_peak,
    survivor: s.survivor, client_ver: APP_VERSION, backend: s.backend, handle: getHandle(),
    kills_per_sec: s.time > 0 ? s.kills / s.time : 0,
    score_per_min: s.time > 0 ? (s.score / s.time) * 60 : 0,
    id: 'sub_' + Math.random().toString(36).slice(2, 10), ts: Date.now(), attempts: 0,
  };
  const q = rd(); q.push(item); wr(q);
  void flushScores();
}

export async function flushScores(): Promise<void> {
  if (!LEADERBOARD_ENDPOINT) return;
  const q = rd(); if (!q.length || !navigator.onLine) return;
  const keep: QueuedScore[] = [];
  for (const it of q) {
    try {
      const { id: _i, ts: _t, attempts: _a, ...payload } = it;
      const res = await fetch(`${LEADERBOARD_ENDPOINT}/score`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), keepalive: true, credentials: 'omit',
      });
      if (!res.ok) { it.attempts++; keep.push(it); }
    } catch { it.attempts++; keep.push(it); }
  }
  wr(keep);
}

export function beaconFlushScores(): void {
  if (!LEADERBOARD_ENDPOINT) return;
  const q = rd(); if (!q.length) return;
  try {
    const body = JSON.stringify(q.map(({ id: _i, ts: _t, attempts: _a, ...p }) => p));
    if (navigator.sendBeacon(`${LEADERBOARD_ENDPOINT}/score`, new Blob([body], { type: 'application/json' }))) wr([]);
  } catch { /* ignore */ }
}

/** Async board fetch — NEVER blocks a frame. Parameter-free GET so it stays edge-cacheable. */
export async function fetchBoard(dailyNum: number, mode: Difficulty): Promise<Board | null> {
  if (!LEADERBOARD_ENDPOINT) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(`${LEADERBOARD_ENDPOINT}/leaderboard/${dailyNum}/${mode}?limit=10`, { credentials: 'omit', signal: ctrl.signal });
    return res.ok ? (await res.json() as Board) : null;
  } catch { return null; } finally { clearTimeout(t); }
}

export const __lb = { pending: () => rd() }; // test-only
