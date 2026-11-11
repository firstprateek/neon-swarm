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

// --- ATMOSPHERE gating (off by default → clean screen) ---------------------
// Both layers tier DOWN with the governor so the frame-rate target always wins,
// and both are hard-zeroed whenever the settings.atmosphere flag is OFF.
// Pure so the selftest can pin the gate; main.ts applyQuality() consumes them.

/** split-tone/desaturation/vignette grade amount for a quality tier */
export function gradeAmount(tier: number, atmosphere: boolean): number {
  return atmosphere ? (tier <= 1 ? 1.0 : tier === 2 ? 0.6 : 0.0) : 0.0;
}

/** drifting ash/ember (AmbientMotes) instance budget for a quality tier */
export function moteBudget(tier: number, atmosphere: boolean): number {
  return atmosphere ? ([260, 160, 90, 0][tier] ?? 160) : 0;
}

export interface QualityState {
  tier: number;
  emaMs: number;
  cooldown: number;   // seconds after a tier change before the next decision (lets the EMA settle)
  displayMs: number;  // measured display frame interval (vsync floor); 0 = not calibrated yet
  samples: number[];  // calibration rAF deltas, consumed by calibrateDisplay()
  missTime: number;   // seconds the smoothed frame time has been continuously over budget
  goodTime: number;   // seconds it has been continuously on time
  upDelay: number;    // on-time seconds required before the next step up (doubles on a failed probe)
  probe: number;      // >0: seconds left in which a step down means the last step up failed
}

// With vsync a frame can never be shorter than the display's refresh interval,
// so the governor judges against max(target interval, display interval) — a
// 120 fps target on a 60 Hz panel is "on time" at 16.7 ms, not "missing".
const MISS_RATIO = 1.25;   // over budget × this = a missed frame
const ONTIME_RATIO = 1.1;  // under budget × this = on time (vsync jitter tolerance)
const MISS_HOLD = 0.5;     // seconds of sustained misses before stepping down (shader-compile hitches don't count)
const UP_DELAY_BASE = 3;   // seconds of steady on-time frames before probing a better tier
const UP_DELAY_MAX = 48;   // back-off ceiling for a tier that keeps failing
const PROBE_WINDOW = 4;    // a step down this soon after a step up = the better tier didn't hold
const CAL_SAMPLES = 45;    // rAF deltas for the display measurement (~0.75 s at 60 Hz)
// clamp the measurement: a machine already overloaded while calibrating must not
// mistake its own slow frames for a 30 Hz display and then never step down
const DISPLAY_MIN_MS = 1000 / 250, DISPLAY_MAX_MS = 1000 / 50;

export function createQuality(seedMs = 8, displayMs = 0): QualityState {
  return { tier: 0, emaMs: seedMs, cooldown: 0.5, displayMs, samples: [], missTime: 0, goodTime: 0, upDelay: UP_DELAY_BASE, probe: 0 };
}

/**
 * Feed one raw rAF delta into the display-interval measurement. Once enough
 * samples are in, sets q.displayMs to their (clamped) median and returns true.
 */
export function calibrateDisplay(q: QualityState, frameMs: number): boolean {
  if (q.displayMs > 0) return true;
  if (frameMs > 80 || frameMs <= 0) return false; // same stall filter as the governor
  q.samples.push(frameMs);
  if (q.samples.length < CAL_SAMPLES) return false;
  const s = q.samples.slice().sort((a, b) => a - b);
  q.displayMs = Math.max(DISPLAY_MIN_MS, Math.min(DISPLAY_MAX_MS, s[s.length >> 1]));
  q.emaMs = Math.max(q.emaMs, q.displayMs); // start the EMA at the vsync floor
  q.samples = [];
  return true;
}

/**
 * Advance the governor by one frame. Returns true if the tier changed (the
 * caller should then re-apply renderer settings). Stall frames (tab switch,
 * GC pause) are ignored so they can't nuke quality. Steps down only on
 * sustained misses; steps up after a few seconds of on-time frames, backing
 * off exponentially when the better tier immediately misses again.
 */
export function governQuality(q: QualityState, frameMs: number, targetMs: number, dt: number): boolean {
  if (frameMs > 80 || frameMs <= 0) return false; // ignore pauses / bad samples
  const alpha = Math.min(1, dt * 5); // time-based smoothing (~0.2s settle)
  q.emaMs += (frameMs - q.emaMs) * alpha;
  if (q.probe > 0) {
    q.probe -= dt;
    if (q.probe <= 0) q.upDelay = UP_DELAY_BASE; // the last step up held through its window
  }
  q.cooldown -= dt;
  if (q.cooldown > 0) return false;
  const budget = Math.max(targetMs, q.displayMs);
  q.missTime = q.emaMs > budget * MISS_RATIO ? q.missTime + dt : 0;
  q.goodTime = q.emaMs <= budget * ONTIME_RATIO ? q.goodTime + dt : 0;
  if (q.missTime >= MISS_HOLD && q.tier < MAX_TIER) {
    q.tier++;
    if (q.probe > 0) q.upDelay = Math.min(UP_DELAY_MAX, q.upDelay * 2); // that better tier failed: wait longer next time
    q.probe = 0;
    q.cooldown = 0.5;
    q.missTime = q.goodTime = 0;
    return true;
  }
  if (q.goodTime >= q.upDelay && q.tier > 0) {
    q.tier--;
    q.probe = PROBE_WINDOW;
    q.cooldown = 0.5;
    q.missTime = q.goodTime = 0;
    return true;
  }
  return false;
}
