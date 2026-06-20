// src/telemetry-helpers.ts — pure coarsening + allow-listing helpers so telemetry
// carries only anonymous, low-cardinality data (privacy rule: no PII, no fingerprints).
// Pure functions => unit-testable, zero side effects.

export const normNote = (n: string): 'native' | 'forced' | 'auto-fallback' =>
  n.includes('forced') ? 'forced' : n.includes('auto-fallback') ? 'auto-fallback' : 'native';

export const dprBucket = (d: number): '1' | '2' | '3+' => (d <= 1.2 ? '1' : d <= 2.2 ? '2' : '3+');

export const screenTier = (w: number, h: number): string => {
  const s = Math.min(w, h);
  return s <= 1080 ? '<=1080p' : s <= 1440 ? '1440p' : s <= 2160 ? '4k' : 'ultrawide';
};

export const hostOnly = (r: string): string | null => {
  try { return new URL(r).hostname; } catch { return null; }
};

/** map a referrer host to a small allow-list (never store the raw URL/host) */
export const refAllow = (h: string | null): string | null => {
  if (!h) return null;
  if (/x\.com|twitter|t\.co/.test(h)) return 'twitter';
  if (/discord/.test(h)) return 'discord';
  if (/reddit/.test(h)) return 'reddit';
  if (/youtube|youtu\.be/.test(h)) return 'youtube';
  if (/neon-swarm/.test(h)) return 'self';
  return 'other';
};

/** per-share rotating throwaway token (NOT the raw seed) for attribution */
export const rotShareToken = (): string => 'sh_' + Math.random().toString(36).slice(2, 10);
