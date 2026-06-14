/**
 * Adaptive quality governor. The frame-rate target is the guarantee; visual
 * polish flexes under load to hold it. We smooth frame time (EMA) and, on a
 * cooldown, step quality down when we're missing the target or back up when
 * there's comfortable headroom. Cheapest-to-lose quality goes first
 * (pixel ratio, then bloom).
 */
export interface QualityTier {
  pixelRatioCap: number;
  bloom: boolean;
  label: string;
}

// tier 0 = best looking; higher = cheaper
export const QUALITY_TIERS: QualityTier[] = [
  { pixelRatioCap: 2.0, bloom: true, label: 'ultra' },
  { pixelRatioCap: 1.5, bloom: true, label: 'high' },
  { pixelRatioCap: 1.0, bloom: true, label: 'medium' },
  { pixelRatioCap: 1.0, bloom: false, label: 'low' },
];

export const MAX_TIER = QUALITY_TIERS.length - 1;

export interface QualityState {
  tier: number;
  emaMs: number;
  cooldown: number;
}

export function createQuality(seedMs = 8): QualityState {
  return { tier: 0, emaMs: seedMs, cooldown: 0.5 };
}

/**
 * Advance the governor by one frame. Returns true if the tier changed (the
 * caller should then re-apply renderer settings). Stall frames (tab switch,
 * GC pause) are ignored so they can't nuke quality.
 */
export function governQuality(q: QualityState, frameMs: number, targetMs: number, dt: number): boolean {
  if (frameMs > 80 || frameMs <= 0) return false; // ignore pauses / bad samples
  const alpha = Math.min(1, dt * 5); // time-based smoothing (~0.2s settle)
  q.emaMs += (frameMs - q.emaMs) * alpha;
  q.cooldown -= dt;
  if (q.cooldown > 0) return false;
  if (q.emaMs > targetMs * 1.25 && q.tier < MAX_TIER) {
    q.tier++;
    q.cooldown = 0.5; // react quickly when struggling
    return true;
  }
  if (q.emaMs < targetMs * 0.7 && q.tier > 0) {
    q.tier--;
    q.cooldown = 1.5; // restore quality cautiously to avoid oscillation
    return true;
  }
  return false;
}
