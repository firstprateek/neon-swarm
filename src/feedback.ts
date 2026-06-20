// Privacy-first feedback queue. Captures NOW (localStorage), flushes to a
// self-hosted endpoint LATER (Phase 2b PocketBase). No third parties, no PII.
// localStorage access is try/catch-guarded exactly like daily.ts.

export const FEEDBACK_ENDPOINT: string | null = null; // Phase 2b: set to the PocketBase records URL
const KEY = 'ns-feedback-queue';
const MAX_QUEUE = 50;
const SCHEMA_V = 1;
export const APP_VERSION = '0.1.0'; // keep in sync with package.json

export type Rating = 1 | 2 | 3 | 4 | 5 | null;
export type Category = 'bug' | 'too_hard' | 'idea' | 'other' | null;

export interface FeedbackCtx {
  appVersion: string;
  backend: 'webgpu' | 'webgl2';
  deviceClass: 'mobile' | 'tablet' | 'desktop';
  viewport: string; dpr: number; locale?: string;
  mode: 'daily' | 'free'; dailyNum: number | null;
  seed: number; survivor: string; score: number;
  timeS: number; level: number; kills: number; comboPeak: number;
}
export interface FeedbackItem {
  v: number; id: string; ts: number;
  rating: Rating; category: Category; text: string;
  ctx: FeedbackCtx; attempts: number;
}
export interface FeedbackInput { rating: Rating; category: Category; text: string; }

function readQueue(): FeedbackItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    const a = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function writeQueue(q: FeedbackItem[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(q.slice(-MAX_QUEUE))); }
  catch { /* storage blocked/full — drop silently, never break game-over */ }
}

export function deviceClass(): 'mobile' | 'tablet' | 'desktop' {
  const w = Math.min(window.innerWidth, window.innerHeight);
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (coarse && w < 600) return 'mobile';
  if (coarse) return 'tablet';
  return 'desktop';
}

export function pendingFeedback(): FeedbackItem[] { return readQueue(); }

/** Queue immediately, then best-effort send. Never throws, never blocks. */
export function submitFeedback(input: FeedbackInput, ctx: FeedbackCtx): void {
  const item: FeedbackItem = {
    v: SCHEMA_V,
    id: 'fb_' + Math.random().toString(36).slice(2, 10),
    ts: Date.now(),
    rating: input.rating,
    category: input.category,
    text: (input.text || '').slice(0, 280),
    ctx,
    attempts: 0,
  };
  const q = readQueue(); q.push(item); writeQueue(q);
  void flushFeedback(); // fire-and-forget; safe no-op when endpoint is null
}

/** Best-effort flush of the whole backlog. Call once on startup + after each submit. */
export async function flushFeedback(): Promise<void> {
  if (!FEEDBACK_ENDPOINT) return;          // backend not live yet — keep queued
  const q = readQueue();
  if (!q.length || !navigator.onLine) return;
  const remaining: FeedbackItem[] = [];
  for (const item of q) {
    try {
      const { attempts: _a, ...payload } = item; // strip local-only counter
      const res = await fetch(FEEDBACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (!res.ok) { item.attempts++; remaining.push(item); }
    } catch { item.attempts++; remaining.push(item); } // offline/CORS => retry next load
  }
  writeQueue(remaining);
}

/** Last-ditch delivery on tab close (RESTART = location.reload). */
export function beaconFlush(): void {
  if (!FEEDBACK_ENDPOINT) return;
  const q = readQueue();
  if (!q.length) return;
  try {
    const body = JSON.stringify(q.map(({ attempts: _a, ...p }) => p));
    if (navigator.sendBeacon(FEEDBACK_ENDPOINT, new Blob([body], { type: 'application/json' })))
      writeQueue([]);
  } catch { /* ignore */ }
}
