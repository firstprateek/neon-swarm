// src/telemetry.ts — anonymous, cookieless product telemetry.
//
// FEATURE-FLAGGED OFF: when TELEMETRY_ENDPOINT is null, track()/flush()/init/wire are
// all no-ops — no queue, no allocation, no listeners, no network. Mirrors feedback.ts.
// When ON: GPC/DNT/opt-out gated -> sampled -> batched -> beacon-flushed on hide. There
// is NO track() in the render loop, so the 120fps hot path is never touched.
import { TELEMETRY_ENDPOINT, CONFIG_URL, UMAMI_SRC, UMAMI_ID, type TelemetryConfig } from './config';

const OPT_OUT_KEY = 'ns-telemetry-optout';
const MAX_BATCH = 40; // well under the ~64KB sendBeacon cap
const FLUSH_MS = 5000;

const sess = crypto.randomUUID?.() ?? String(Math.random()).slice(2); // per page-load, in-memory ONLY
let q: { name: string; props?: Record<string, unknown>; ts: number }[] = [];
let enabled = true; // remote kill-switch
let sample: Record<string, number> = { default: 1, perf_sample: 0.02, ability_use: 0.1 };

/** HARD GATE — checked before any work AND before Umami injects. */
export function telemetryAllowed(): boolean {
  if (!TELEMETRY_ENDPOINT) return false; // feature flag: OFF => no-op
  const n = navigator as Navigator & { globalPrivacyControl?: boolean; doNotTrack?: string };
  if (n.globalPrivacyControl === true) return false; // GPC (CCPA, legally binding)
  const dnt = n.doNotTrack ?? (window as unknown as { doNotTrack?: string }).doNotTrack;
  if (dnt === '1' || dnt === 'yes') return false; // DNT incl. Firefox-legacy 'yes'
  try { if (localStorage.getItem(OPT_OUT_KEY) === '1') return false; } catch { /* ignore */ }
  return enabled;
}
export function optOut(): void { try { localStorage.setItem(OPT_OUT_KEY, '1'); } catch { /* ignore */ } q = []; }
export function optIn(): void { try { localStorage.removeItem(OPT_OUT_KEY); } catch { /* ignore */ } }
export function isOptedOut(): boolean { try { return localStorage.getItem(OPT_OUT_KEY) === '1'; } catch { return false; } }

function bootUmami(): void {
  if (!telemetryAllowed() || !UMAMI_SRC || !UMAMI_ID) return; // gate BEFORE the <script>
  const s = document.createElement('script');
  s.defer = true; s.src = UMAMI_SRC;
  s.setAttribute('data-website-id', UMAMI_ID);
  s.setAttribute('data-do-not-track', 'true');
  document.head.appendChild(s);
}

/** remote config once at boot (skipped entirely when OFF): kill-switch + sampling rates. */
export function initTelemetry(): void {
  if (!TELEMETRY_ENDPOINT) return; // OFF => zero network
  const after = () => bootUmami();
  if (!CONFIG_URL) { after(); return; }
  fetch(CONFIG_URL, { credentials: 'omit' })
    .then(r => r.json() as Promise<TelemetryConfig>)
    .then(c => { enabled = c.enabled !== false; if (c.sample) sample = { ...sample, ...c.sample }; })
    .catch(() => { /* keep safe defaults */ })
    .finally(after);
}

export function track(name: string, props: Record<string, unknown> = {}): void {
  if (!telemetryAllowed()) return; // gate before ANY work (no alloc when off)
  const rate = sample[name] ?? sample.default;
  if (rate < 1 && Math.random() > rate) return; // client-side sampling for high-freq events
  q.push({ name, props, ts: Date.now() });
  const um = (window as unknown as { umami?: { track: (n: string, p: unknown) => void } }).umami;
  if (um && ['page_view', 'title_shown', 'run_start', 'run_end', 'share_click', 'challenge_open'].includes(name))
    um.track(name, { mode: props.mode, backend: props.backend });
  if (q.length >= MAX_BATCH || name === 'run_end' || name === 'watchdog') flush(true);
}

function flush(beacon = false): void {
  if (!telemetryAllowed() || q.length === 0) return;
  const batch = q.splice(0, MAX_BATCH);
  const body = JSON.stringify({ v: 1, sid: sess, build: (typeof __VER__ !== 'undefined' ? __VER__ : 'dev'), ev: batch });
  let queued = false;
  if (beacon && navigator.sendBeacon) {
    try { queued = navigator.sendBeacon(TELEMETRY_ENDPOINT!, new Blob([body], { type: 'application/json' })); } catch { queued = false; }
  }
  if (!queued) {
    fetch(TELEMETRY_ENDPOINT!, {
      method: 'POST', body, keepalive: true, credentials: 'omit',
      headers: { 'content-type': 'application/json' },
    }).catch(() => { q.unshift(...batch); }); // re-queue on transient failure
  }
}

/** timers/listeners attach ONLY when ON (single entry point). */
let wired = false;
export function wireTelemetryLifecycle(): void {
  if (wired || !TELEMETRY_ENDPOINT) return;
  wired = true;
  setInterval(() => flush(false), FLUSH_MS);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
  addEventListener('pagehide', () => flush(true));
}

// test-only introspection (used by the OFF-state self-tests)
export const __t = { queueLen: () => q.length, _reset: () => { q = []; } };
