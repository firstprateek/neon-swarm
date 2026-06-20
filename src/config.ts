// src/config.ts — Phase 2b backend feature-flag registry.
//
// EVERY endpoint is null by default => the entire backend is a no-op. The live game
// is byte-for-byte unchanged until ONE of these is set (see the OFF-state tests in
// selftest.ts). Flip ON by editing the null literals to the Mac-Mini URLs, or by
// setting VITE_* at build time. The localStorage override is DEV/QA-ONLY — production
// builds never read it (no boot-time side effect, no override surface).

const env = (k: string): string | null =>
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[`VITE_${k}`]) ?? null;

const ovr = (k: string): string | null => {
  if (!import.meta.env.DEV) return null; // no override surface in production
  try { return localStorage.getItem(`ns-be-ovr-${k}`); } catch { return null; }
};

// --- the flags (all null === OFF) ---
export const TELEMETRY_ENDPOINT: string | null = ovr('TELEMETRY') ?? env('TELEMETRY_ENDPOINT') ?? null;
export const LEADERBOARD_ENDPOINT: string | null = ovr('LEADERBOARD') ?? env('LEADERBOARD_ENDPOINT') ?? null;
export const FEEDBACK_ENDPOINT: string | null = ovr('FEEDBACK') ?? env('FEEDBACK_ENDPOINT') ?? null;

// telemetry plumbing (only consulted when TELEMETRY_ENDPOINT is non-null)
export const CONFIG_URL: string | null = env('CONFIG_URL') ?? null; // edge-cached kill-switch + sampling
export const UMAMI_SRC: string | null = env('UMAMI_SRC') ?? null;   // optional self-hosted web analytics
export const UMAMI_ID: string | null = env('UMAMI_ID') ?? null;

export const APP_VERSION = '0.1.0'; // keep in sync with package.json (mirrors feedback.ts)

export interface TelemetryConfig { enabled?: boolean; sample?: Record<string, number> }

/** dev-only console helper: window.__cfg.set('TELEMETRY', 'http://localhost:8090') then reload */
export function setOverride(k: string, url: string | null): void {
  try {
    if (url === null) localStorage.removeItem(`ns-be-ovr-${k}`);
    else localStorage.setItem(`ns-be-ovr-${k}`, url);
  } catch { /* storage blocked */ }
}
