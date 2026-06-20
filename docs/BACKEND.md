<!--
NEON SWARM — Backend design (Phase 2b). PLANNING DOC ONLY — no infra built yet; needs explicit GO.
Produced by a multi-agent design pass (research → synthesize → adversarial critique → revise), 2026-06-20.
Scope: privacy-first telemetry + traffic analytics + global leaderboard on a self-hosted Mac Mini.
-->

# NEON SWARM — Telemetry + Analytics + Leaderboard Backend (Phase 2b)

**Status:** PLANNING DOC. No infra built yet. Needs the user's explicit GO. The **telemetry + analytics half is one-afternoon-executable** *after* the prerequisite client diffs in §0 land. The **leaderboard anti-cheat half is NOT an afternoon** — it is descoped to statistical verification (§6), because byte-identical re-sim is impossible against the current engine (see §0 and §6). Do not conflate the two.
**Box:** one self-hosted Mac Mini behind a Cloudflare Tunnel. **No cloud accounts, no third-party trackers, anonymous-aggregate by design.** *Caveat surfaced up front:* Cloudflare itself is in the request path and its edge sees and may log raw client IPs — it IS a third party processing IP, regardless of our origin settings. We minimize, we do not eliminate, third-party IP exposure.

---

## 0. PREREQUISITE CODE WORK (must land BEFORE the "one-liner" track() calls)

The original draft called these "one-liners." They are not — the data they reference does not exist in the code today (verified against `src/main.ts`, `src/hud.ts`, `src/rng.ts`, `src/swarm.ts`). Ship these diffs first or the events emit `undefined`:

1. **Build/version constant.** No `__VER__` / `import.meta.env` / `VITE_*` exists anywhere. Add a Vite `define: { __VER__: JSON.stringify(gitSha) }` (or `import.meta.env.VITE_BUILD`) and surface it. Until then `build` is `undefined` on every event.
2. **`pageLoadT`** — capture `const pageLoadT = performance.now()` at module top of `main.ts`; `ttfr_ms` depends on it and it is currently undefined.
3. **`runsThisSession`** — add a module-level counter; `run_index` depends on it.
4. **`runTainted`** — add module-level boolean, set by `applyCheat`/`__dbg`; `tainted` depends on it. (Cheat codes incl. the `horde` code at main.ts:303 must flip it.)
5. **`new_daily_best` threading.** `recordDailyScore()` is ALREADY called at `main.ts:583` (`newDailyBest`). Reuse that returned value in the `track()` call — do NOT call `recordDailyScore` a second time (it would double-record / mutate state).
6. **`backend_forced`** — reuse the existing `backendNote` (main.ts:167/176, values `''|' (forced)'|' (auto-fallback)'`); normalize to `native|forced|auto-fallback`.
7. **UTM on shares.** `shareUrl` is built at `main.ts:588` as `` `${location.origin}${location.pathname}?seed=${seed}` `` with NO utm. Append `&utm_source=challenge` (challenge link) / `&utm_source=share` (brag). The `shareText` strings at `hud.ts:414-416` interpolate `info.shareUrl`, so fixing the source URL is sufficient — but the URL must carry utm before the Umami attribution + "challenge-link" acquisition SQL mean anything.
8. **`share_click` wiring is NOT a drop-in.** The share onclick lives inside `showGameOver()` in `hud.ts` (~419) and has no telemetry import and no access to `mode`/`isDaily` as separate values (only `info`/`daily`). Pass an `onShare(method)` callback from `main.ts` into `hud.showGameOver()` and fire `track('share_click', …)` from `main.ts` where `mode`/`isDaily` are in scope. Do not reach the SDK into hud.ts.
9. **First-time CSP.** `index.html` has NO CSP today. Adding `connect-src` is therefore adding a CSP from scratch — it can break Three.js module loading / inline bootstrap if done naively. Author the full policy, test the WebGPU+WebGL2 boot locally, ship behind a `Content-Security-Policy-Report-Only` pass first.

**These nine are the real v1 critical path and appear as explicit checklist items in §8 — not folded into the analytics afternoon.**

---

## 1. TL;DR / Decisions

The five lenses split on **one** big question — *one bespoke SQLite firehose vs. add Umami for web analytics.* Resolved in favor of **Umami for web/funnel + bespoke SQLite for game events**, because the funnel/referrer/UTM UI is the entire point of "going viral" measurement and hand-rolling it is the afternoon-eating work we want to avoid. The Architecture lens's "Umami's Postgres competes for RAM" objection is real and, on a small box, NOT negligible (see §7 RAM budget — this is a real constraint, not a footnote). I keep that lens's hard rule — **physically separate SQLite files**.

- **Web traffic / funnel / virality →** **Umami v2 (Postgres 16)**, self-hosted. Cookieless. **Gated by the SAME consent kill-switch as the bespoke SDK** — the `<script>` is injected conditionally and only when `telemetryAllowed()` is true, AND `data-do-not-track` is set, so a GPC/DNT/opted-out user never sends Umami a pageview. (The original draft's static `<script>` auto-fired a pageview + IP hit before the gate ran — that bypass is fixed in §5.)
- **Deep game events →** **bespoke append-only SQLite** (`telemetry.db`, WAL), written by a **single batched-writer goroutine** behind a thin Go ingest path (or a PocketBase custom route in front of its *own* db file — see §6). NOT the leaderboard DB.
- **Scores + leaderboard →** **PocketBase** on **`leaderboard.db`** (its own file). Anti-cheat is **statistical/heuristic (§6)** — NOT byte-identical re-sim, which the current engine cannot support.
- **Privacy stance →** **cookieless, no tracking identifier on the device.** Uniques counted by a **server-side daily-rotating salted hash** of `truncated_ip + coarse_UA + day`; raw IP discarded in-request, salt destroyed at UTC midnight → prior-day hashes irreversible → *anonymous-aggregate by design*. We honor GPC (legally binding under CCPA) + DNT as a hard client kill-switch. **Consent-banner-free is our defensible position, not settled law** (see §3).
- **Dashboard →** **Datasette as primary** (lightweight, read-only, ad-hoc SQL) reading a **read-only snapshot** of `telemetry.db`. **Metabase is OPTIONAL** and only if RAM allows — its JVM spikes past `-m1g` and is the most likely OOM trigger on an 8GB box during a spike (§7). Default ship = Datasette-only.
- **Edge = shock absorber →** Cloudflare Tunnel. **Edge mitigations are best-effort on the free plan** (free tier gives ~3 page rules and ~1 rate-limiting rule — you likely cannot configure all of them). **Origin-side rate limiting + the in-process kill-switch/shedding are the REAL backstop** (§6); the edge is a bonus, not the foundation.
- **Cross-day retention →** **we cannot measure true anon-keyed cross-day cohorts** with daily-destroyed salt (the same device gets a different `anon` every day — an anon-keyed cross-day JOIN returns ~0, not a lower bound). We rely on **Umami's directional cross-day number** only, and flag it as directional. Exact cohorts require the v2 privacy-reviewed rotating-linkable token (§8) — explicitly out of scope for v1. This resolves the internal contradiction in the original draft.

> **Resolved disagreement #1 (identity):** Privacy lens wins: NO random `localStorage`/cookie tracking id. Identity = server-side daily salted hash only.
> **Resolved disagreement #2 (retention math):** You cannot both destroy the cross-day link AND compute anon-keyed cross-day cohorts. We destroy the link. **True cross-day retention is therefore NOT computed in SQLite in v1** — the D1/D7 anon-JOIN was removed because it returns ~0 by construction. Umami's number is the directional stand-in.

---

## 2. Architecture

```
                         ┌──────────────────────────────────────────────┐
   PLAYER BROWSER        │            GitHub Pages (static)              │
   (WebGPU/WebGL2)       │  index.html + bundle + telemetry.ts SDK      │
                         │  Umami <script> INJECTED ONLY IF gate passes  │
                         │  ?utm_source appended to share/challenge URLs │
                         └───────┬───────────────┬──────────────┬───────┘
                                 │               │              │
              umami pageviews/   │  game events  │   scores +   │  leaderboard
              events (only when  │  (sendBeacon  │  heuristics  │  GET (cacheable)
              gate passes)       │   POST /t)    │  (POST /score)│
                                 │               │              │
        ┌────────────────────────┴───────────────┴──────────────┴───────────────┐
        │      CLOUDFLARE (Tunnel + edge shield, FREE plan — best-effort)        │
        │  • cache GET /leaderboard* via origin Cache-Control (if rule budget)   │
        │  • cache GET /telemetry-config.json (60s)                              │
        │  • rate-limit POSTs IF a free rule slot exists  ── ELSE origin does it │
        │  • WAF on · POST never cached · CF edge SEES raw IP (CF is a 3rd party) │
        └───────────────┬───────────────┬───────────────────┬───────────────────┘
                        │ cloudflared    │                   │   (launchd KeepAlive)
        ┌───────────────┴───────────────┴───────────────────┴───────────────────┐
        │                  MAC MINI (M-series) — STATE RAM (§7)                  │
        │  *** ORIGIN REJECTS any request NOT arriving via the tunnel ***        │
        │  *** (firewall + shared-secret header) so CF-* headers can't be spoofed│
        │                                                                        │
        │  analytics.<domain> ─► Umami :3100 ──► Postgres 16  (web/funnel UI)    │
        │                                                                        │
        │  t.<domain> ─► Go ingest :8090 ──[bounded ring buf, SHED on full]──►   │
        │                    single writer goroutine ──► telemetry.db (WAL)      │
        │                         │ verify tunnel secret; stamp CF-IPCountry     │
        │                         │ truncate+discard IP; salted-daily-hash anon  │
        │                         │ NOTE: restart loses ≤ring-buf events (lossy) │
        │                                                                        │
        │  api.<domain> ─► PocketBase :8091 ──► leaderboard.db (WAL, DURABLE)    │
        │                    └─ stats/heuristic verifier (nice +10, bounded) ─┐  │
        │                       impossible-score / kills-sec / percentile     │  │
        │                       outlier flags ── NO byte-identical re-sim ────┘  │
        │                       (re-sim impossible: variable dt + Math.random)   │
        │                                                                        │
        │  snapshot.sh (periodic): sqlite3 .backup → snapshots/ro.db            │
        │   (backup pins a WAL reader → checkpoint risk under spike, see §7)     │
        │  Datasette (primary) ─► snapshots/ro.db   ·  Metabase OPTIONAL/-m1g    │
        └────────────────────────────────────────────────────────────────────────┘

DATA FLOW SUMMARY
  • Pageviews/funnel → Umami (gated) → Postgres → Umami UI (Funnels/Referrer/UTM)
  • Game events      → SDK batch → /t → ring buf → writer → telemetry.db → snapshot
  • Scores           → SDK on run_end → /score → PocketBase → HEURISTIC verify → flag
  • Three DB files = three write locks; a telemetry storm can't starve scores.
    (BUT leaderboard.db has INTERNAL contention — verifier writes vs /score writes; see §6.)
```

---

## 3. Privacy Posture

**Anonymous-aggregate-by-design rules (non-negotiable):**
1. **No tracking identifier on the device.** No cookie, no `localStorage`/`IndexedDB` random id, no fingerprint read. The only telemetry `localStorage` write is the one-bit **opt-out flag** (strictly-necessary, banner-exempt). *Note for honesty: the shipped game ALREADY writes localStorage for game settings (`settings.ts`) and per-daily best scores (`daily.ts ns-daily-best-*`). The privacy blurb is worded to reflect that truthfully — see below.*
2. **Identity = server-side daily salted hash.** `anon = sha256(salt_today | truncate_ip | coarse_UA | day)`.
3. **Salt lifecycle (fully specified — the original draft was contradictory):**
   - Salt is a random 32 bytes regenerated **at process start AND at UTC midnight**.
   - It lives **ONLY in tmpfs / process memory** (e.g. a file under a RAM-disk mount), **never on the durable volume**, **never persisted to disk that survives a reboot**, and is **explicitly EXCLUDED from the nightly box `.backup`/rsync** (the backup script's ignore-list names the salt path).
   - On rotation the old salt buffer is overwritten in place.
   - **Documented consequence:** a mid-day crash / launchd restart regenerates the salt early, which **splits that day's anon population into two cohorts → inflates that day's DAU and breaks same-day uniqueness for that day.** This is an accepted, surfaced limitation (shown on the dashboard as a "salt-rotation events today" counter so a skewed day is identifiable), not a silent one.
4. **Raw IP never written.** Truncate to /24 (IPv4) or /48 (IPv6) *before* hashing; derive 2-letter country *before* discard; IP then out of scope. Disable/anonymize IP in PocketBase + reverse-proxy access logs. **We CANNOT stop Cloudflare's edge from seeing/logging the real client IP** — that is disclosed in the blurb, not hidden.
5. **Minimal hash entropy.** Only truncated-IP + coarse-UA-family feed identity. **`tech_profile` fingerprint-grade fields are COARSENED before storage:** screen is bucketed to a small set of resolution *tiers* (e.g. `≤1080p | 1440p | 4k | ultrawide`), DPR bucketed to `{1, 2, 3+}`. Full `width x height` and exact DPR are NOT stored (the original draft stored them raw; `country + exact-screen + DPR + backend` is a same-day fingerprint in a low-traffic region). Even coarsened, these are aggregate dimensions, never identity inputs.

**Consent stance (honest about uncertainty):** Because we store/read **no tracking identifier** on the device for analytics, our position is **ePrivacy Art.5(3) / PECR reg.6 is not triggered → no consent banner**, with transient in-request IP processing resting on **legitimate interest (GDPR Art.6(1)(f))**. **This is a defensible posture, NOT settled black-letter law:** (a) truncated/transient IP is still personal data while in-request and a 6(1)(f) basis is challengeable and requires a documented LIA (write one before go-live); (b) some DPAs treat even cookieless analytics as needing care; (c) "UK DUAA-2025" and "EDPB requires salt destruction" are directional supports, not a guarantee. **GPC is honored as a hard client kill-switch** before any beacon (and before Umami's script) loads; **DNT** honored (including Firefox's legacy `window.doNotTrack === 'yes'`, not just `'1'`).

**Collect vs NEVER collect:**

| COLLECT (anonymous + aggregate) | NEVER COLLECT |
|---|---|
| event name + props (score, kills, level, time, peakCombo, survivor, isDaily, dailyNum) | raw/full IP (truncate+discard in-request) |
| coarse dims: country (2-letter), backend, quality tier, fps bucket, **screen TIER, DPR bucket**, mode, channel tag | any cookie or `localStorage` tracking ID |
| daily anon hash (non-persistent across days) + UTC day | login / email / name / any PII (there are no accounts) |
| referrer **host only** (coarsened to a known-source allowlist; rare/low-volume hosts collapse to `other`) | precise geo (city / GPS / lat-long / ASN) |
| `?utm_source` token | full UA string, exact screen res, or exact DPR |
| **challenge linkage:** a **per-share salted rotating token** (NOT the raw seed) for attribution | **raw `seed`/`src_seed` as a stored identifier** (see note) |
| | full referrer URL or full `?seed=` share URL |
| | any cross-day or cross-device tracking identifier |

> **Seed-linkage fix (was a privacy hole).** A shared challenge seed is identical for inviter and invitee, so storing raw `seed`/`src_seed` in plaintext **is** a cross-device link (A shared, B opened the same rare token) — exactly what the NEVER-COLLECT row forbids. **For challenge attribution we store a per-share, daily-salted rotating token** derived server-side, not the raw seed. The raw seed is still needed *transiently* by the leaderboard to know which daily/challenge a run belongs to (`daily_key` / `seed` on `scores`), but it is **not stored on telemetry event rows as an identifier**, and free-play seeds (effectively per-run unique) are **never** stored on telemetry rows. If a future feature genuinely needs raw-seed challenge graphs, that is a documented re-identification tradeoff requiring a fresh privacy GO.

**Retention:** raw events kept **≤ 90 days** then pruned; rolling aggregates ≤ 12 months; daily salt destroyed nightly; reverse-proxy + PocketBase IP logging disabled. **Disk-capacity caveat:** at viral scale 90-day raw retention is large (see §7 sizing) — retention is enforced by **monthly partitioning + incremental vacuum**, never a single weekly full `VACUUM` on a multi-GB file. COPPA-safe by construction (no accounts, no PII, no birthdate collection).

**Publishable privacy blurb (paste into `/privacy` — corrected to match the SHIPPED product):**
> *NEON SWARM uses privacy-first, self-hosted analytics to understand how the game is played and shared. We do not use tracking cookies and we never collect your name, email, or any personal information — there are no accounts and no logins. The only things stored on your device are your game settings and your local best scores, plus an opt-out flag if you turn analytics off; none of these is a tracking identifier. To count visitors without tracking you, our own server (a Mac Mini, not a third party) combines your truncated IP address, a rough browser type, and the date into a one-way code using a secret key that is permanently deleted every night, so the code can never be linked back to you or across days. Our hosting provider, Cloudflare, sits between you and our server and may briefly see your IP address to route and protect traffic; we configure it to minimize logging. We store only anonymous, aggregated game statistics, kept at most 12 months. We honor Global Privacy Control and Do-Not-Track automatically, and you can opt out anytime in Settings. No Google Analytics, no Mixpanel, no ad networks — ever.*

---

## 4. Event Taxonomy & Schema

**Envelope (every event; sent batched per run):**
```ts
interface Envelope {
  v: 1;
  sid: string;     // session id — random per page-load, IN-MEMORY ONLY (not stored on device)
  ts: number;      // client epoch ms (skew analysis only; server stamps authoritative ts)
  utc_day: string; // dailyKey(now) "YYYY-MM-DD"  (src/daily.ts)
  build: string;   // git sha — REQUIRES the §0.1 vite define; else undefined
}
// anon id is NOT in the envelope — it is computed SERVER-SIDE (salted daily hash). Privacy rule #2.
```

**Event list** — `[v1]` = ship now (7-event minimal subset); rest defer to v2. **Every prop below either already exists in the code OR is listed as a prerequisite in §0** (the original draft falsely implied all hooks were drop-ins).

| Event | Tier | Key props | Real hook + prereq |
|---|---|---|---|
| `page_view` | **v1** | `referrer_host`(allowlisted), `utm`, `has_seed`, `country`(server) | load, before routing |
| `challenge_open` | **v1** | `referrer_host`, `share_token`(rotating, not raw seed) | `challengeSeed` @ main.ts:99. ⚠ referrer is EMPTY for Web Share / clipboard / app handoffs — see attribution caveat below |
| `title_shown` | **v1** | `challenge`, `daily_num`, `daily_best_local` | `hud.showStart` @ main.ts:269 |
| `run_start` | **v1** (activation numer) | `mode`, `survivor`, `daily_num`, `ttfr_ms`, `backend` | `deploy()` @ main.ts:266. **Needs §0.2 `pageLoadT`** |
| `run_end` | **v1** (NSM) | `mode`, `survivor`, `score`, `kills`, `level`, `time_s`, `combo_peak`, `is_daily`, `daily_num`, `new_daily_best`, `run_index`, `tainted`, `end_reason` | `gameOver()` @ main.ts:573 / showGameOver:582. **Needs §0.3/0.4/0.5 (`runsThisSession`, `runTainted`, reuse `newDailyBest`)** |
| `share_click` | **v1** (K i-factor) | `is_daily`, `method`(web_share\|clipboard), `score` | **§0.8 callback from main.ts — NOT a hud onclick drop-in** |
| `tech_profile` | **v1** | `backend`, `backend_forced`(native\|forced\|auto-fallback), `bloom_ok`, `dpr_bucket`, `screen_tier`, `target_fps` | early, ~main.ts:168. **Needs §0.6 (`backendNote`) + coarsened screen/DPR (rule #5)** |
| `mode_chosen` | v2 | `mode` *(folds into run_start.mode)* | onDaily/onFreePlay @ 272/278 |
| `level_up` | v2 | `level`, `upgrade`, `upgrade_count`, `time_s` | openLevelUp/onPick |
| `ability_use` | v2 (sampled) | `ability`(missile\|nuke\|dash), `time_s`, `level` | fireMissile/Nuke/doDash |
| `boss_event` | v2 | `phase`(spawn\|kill), `boss_index`, `time_s` | spawnBoss / sweepDead |
| `cheat_used` | v2 | `code`, `time_s` → flips `tainted` | applyCheat (incl. `horde` @303) |
| `perf_sample` | v2 (sampled ~2%) | `fps`, `quality_tier`(0-3), `ema_ms`, `enemies`, `time_s` | FPS readout |
| `watchdog` | v2 (critical) | `kind`(blackscreen\|fallback\|init_fail), `backend`, `detail`(truncated) | `presentsBlack()` @ main.ts:37 / start().catch |

> **Attribution blind-spot (surfaced, not hidden).** `?utm_source` survives a share ONLY because §0.7 appends it. But `document.referrer` is **empty** for the dominant share channels — native Web Share sheet, clipboard→Discord/WhatsApp/SMS, https→app handoff. So `challenge_open` frequently arrives with **no referrer and no utm**, and the K-factor `challenge_open/share` leg **systematically undercounts**. The dashboard labels K-factor a **lower bound** and shows the `% of challenge_open with usable attribution` so the undercount is visible.

**North-star metric:** *weekly Activated Players* — distinct same-day anon devices that reached `run_end`. (*Note: "returning" is intentionally dropped from the NSM because we cannot reliably measure cross-day return without a stable id — see §1. Umami's directional return number is reported separately as directional.*)
**KPIs:** (1) Activation = distinct `run_end` anon / distinct `page_view` anon (same-day); (2) **K-factor (lower bound)** — see SQL in §7, computed to MATCH the prose definition; (3) crash-free session rate; (4) tech health (webgpu%, crash%). *Per-player score/kills are vanity, not KPIs.*

**SQLite schema — `telemetry.db` (standalone, WAL):**
```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
PRAGMA wal_autocheckpoint=1000; PRAGMA cache_size=-16000;

CREATE TABLE events (
  id        INTEGER PRIMARY KEY,        -- rowid = fastest insert
  ts        INTEGER NOT NULL,           -- SERVER receive epoch ms
  client_ts INTEGER,
  day       TEXT NOT NULL,              -- 'YYYY-MM-DD' UTC bucket
  anon      TEXT NOT NULL,              -- server: hash(daily_salt|trunc_ip|coarse_ua|day) — non-stable across days
  sess      TEXT NOT NULL,              -- per page-load id (groups one visit)
  name      TEXT NOT NULL,
  mode      TEXT,  is_daily INTEGER DEFAULT 0,  daily_num INTEGER,
  share_token TEXT,                     -- per-share ROTATING salted token (NOT raw seed). challenge attribution.
  referrer_host TEXT, utm TEXT, country TEXT,   -- referrer_host allowlisted; country server-stamped
  backend   TEXT, quality INTEGER, fps INTEGER,
  screen_tier TEXT, dpr_bucket TEXT,    -- COARSENED (rule #5) — never raw res/DPR
  crash     INTEGER DEFAULT 0,
  score INTEGER, kills INTEGER, level INTEGER, time_s REAL, combo_peak INTEGER,
  survivor TEXT,
  tainted   INTEGER DEFAULT 0,          -- cheat/__dbg fired this run → exclude from score stats
  is_bot    INTEGER DEFAULT 0
) STRICT;
CREATE INDEX ix_events_day  ON events(day);
CREATE INDEX ix_events_name ON events(name, ts);
CREATE INDEX ix_events_anon ON events(day, anon);
-- NOTE: raw seed/src_seed are deliberately ABSENT from this table (privacy §3 seed-linkage fix).
-- Schema-migration policy: schema changes ship as numbered migrations applied by the writer at
-- startup (a `schema_version` pragma/table). New v2 props => additive `ALTER TABLE ADD COLUMN`
-- only (online, lock-light on WAL); never rename/drop on the live file. Envelope `v` bumps in lockstep.
```

**`leaderboard.db` (PocketBase — durable, low-write):**
```sql
CREATE TABLE scores (
  id TEXT PRIMARY KEY, created TEXT NOT NULL,
  daily_key TEXT, seed INTEGER NOT NULL,
  score INTEGER NOT NULL, kills INTEGER NOT NULL, level INTEGER NOT NULL,
  run_time REAL NOT NULL, combo_peak INTEGER NOT NULL, survivor TEXT NOT NULL,
  anon_id TEXT NOT NULL, client_ver TEXT, backend TEXT,
  -- heuristic-verification inputs (NO input_log replay — see §6):
  kills_per_sec REAL, score_per_min REAL,        -- derived sanity ratios computed at submit
  status TEXT NOT NULL DEFAULT 'pending',         -- pending|accepted|flagged|rejected
  flag_reason TEXT
);
CREATE INDEX ix_scores_daily   ON scores(daily_key, status, score DESC);
CREATE INDEX ix_scores_pending ON scores(status) WHERE status='pending';
-- input_log BLOB intentionally REMOVED: a deterministic per-tick input log does not exist in the
-- engine and could not be replayed identically anyway (§6). Storing it would imply a guarantee we
-- cannot keep.
```

**Rollup tables (in `telemetry.db`; written hourly; dashboard reads these):**
```sql
CREATE TABLE daily_metrics (
  day TEXT PRIMARY KEY, page_views INTEGER, sessions INTEGER, dau INTEGER,
  salt_rotations INTEGER,                         -- >1 => DAU for this day is inflated (rule #3)
  runs_started INTEGER, runs_ended INTEGER, shares INTEGER, challenge_opens INTEGER,
  mode_daily INTEGER, mode_free INTEGER, mode_challenge INTEGER,
  webgpu INTEGER, webgl2 INTEGER, crashes INTEGER,
  median_run_time REAL, median_score INTEGER );
CREATE TABLE funnel_daily   (day TEXT, step TEXT, n INTEGER, PRIMARY KEY(day,step));
CREATE TABLE referrers_daily(day TEXT, ref  TEXT, n INTEGER, PRIMARY KEY(day,ref));
```

---

## 5. Client Telemetry SDK

New file `src/telemetry.ts`. Cookieless, GPC/DNT/opt-out gated, batched, beacon-flushed, sampled, remote-kill-switchable. **No tracking identifier on the device** — the only `localStorage` write is the opt-out bit. **Umami is gated by the SAME function** and injected conditionally (fixes the bypass).

```ts
// src/telemetry.ts — zero deps. NO cookie, NO random device-id. Server computes anon identity.
const T_ENDPOINT = 'https://t.neon-swarm.example/t';
const CONFIG_URL  = 'https://neon-swarm.example/telemetry-config.json'; // edge-cached kill-switch
const UMAMI_SRC   = 'https://analytics.neon-swarm.example/script.js';
const UMAMI_ID    = '<id>';
const OPT_OUT_KEY = 'ns-telemetry-optout';
const MAX_BATCH = 40;            // keep beacon payload well under the ~64KB sendBeacon cap
const FLUSH_MS  = 5000;

const uuid = () => crypto.randomUUID?.() ?? String(Math.random()).slice(2);
const sess = uuid();             // in-memory only, per page-load — NOT persisted
let q: {name:string; props?:Record<string,unknown>; ts:number}[] = [];
let enabled = true;
let sample: Record<string, number> = { default:1, perf_sample:0.02, ability_use:0.1 };

// HARD GATE — runs before ANY beacon AND before the Umami <script> is injected.
function telemetryAllowed(): boolean {
  const n = navigator as any;
  if (n.globalPrivacyControl === true) return false;                 // GPC: legally binding (CCPA)
  // DNT: cover modern '1' AND Firefox-legacy 'yes' on both navigator and window
  const dnt = n.doNotTrack ?? (window as any).doNotTrack;
  if (dnt === '1' || dnt === 'yes') return false;
  try { if (localStorage.getItem(OPT_OUT_KEY) === '1') return false; } catch {}
  return enabled;                // remote kill switch
}
export function optOut(){ try{ localStorage.setItem(OPT_OUT_KEY,'1'); }catch{} q=[]; }

// Umami is injected ONLY when the gate passes — a GPC/DNT/opted-out user never loads it,
// so it can never auto-fire a pageview + IP hit behind the kill-switch (the original bug).
function bootUmami(){
  if (!telemetryAllowed()) return;
  const s = document.createElement('script');
  s.defer = true; s.src = UMAMI_SRC;
  s.setAttribute('data-website-id', UMAMI_ID);
  s.setAttribute('data-do-not-track', 'true');   // also respect Umami's own DNT handling
  document.head.appendChild(s);
}

// remote config once at boot: kill switch + sampling. failure = keep safe defaults. THEN boot Umami.
fetch(CONFIG_URL).then(r=>r.json()).then(c=>{
  enabled = c.enabled !== false; if (c.sample) sample = { ...sample, ...c.sample };
}).catch(()=>{}).finally(bootUmami);

export function track(name: string, props: Record<string, unknown> = {}) {
  if (!telemetryAllowed()) return;                       // gate BEFORE queue/backpressure
  const rate = sample[name] ?? sample.default;
  if (rate < 1 && Math.random() > rate) return;          // client-side sampling, high-freq events
  q.push({ name, props, ts: Date.now() });

  // mirror funnel-critical events to Umami (only reaches here if gate passed AND umami booted)
  if (['page_view','title_shown','run_start','run_end','share_click','challenge_open'].includes(name))
    (window as any).umami?.track(name, { mode: props.mode, backend: props.backend });

  if (q.length >= MAX_BATCH || name === 'run_end' || name === 'watchdog') flush(true);
}

function flush(beacon = false) {
  if (!telemetryAllowed() || q.length === 0) return;
  const batch = q.splice(0, MAX_BATCH);
  const body = JSON.stringify({ v:1, sid: sess, build: (window as any).__VER__, ev: batch });
  // NOTE: sendBeacon is fire-and-forget — it returns only a queued? boolean, cannot read the 204,
  // cannot set credentials, and a FALSE return (over quota) means the batch was NOT queued.
  // We detect that and fall back to keepalive fetch so the critical run_end/watchdog batch isn't
  // silently lost (the original draft lost beacon failures with no detection).
  let queued = false;
  if (beacon && navigator.sendBeacon)
    queued = navigator.sendBeacon(T_ENDPOINT, new Blob([body], { type:'application/json' }));
  if (!queued)
    fetch(T_ENDPOINT, { method:'POST', body, keepalive:true, credentials:'omit',
                        headers:{'content-type':'application/json'} })
      .catch(()=>{ q.unshift(...batch); });               // re-queue on transient failure
}
setInterval(()=>flush(false), FLUSH_MS);
addEventListener('visibilitychange', ()=>{ if (document.visibilityState==='hidden') flush(true); });
addEventListener('pagehide', ()=>flush(true));            // mobile-safe; fires when vischange may not
```

**Wire-up at the real hooks — each depends on the §0 prerequisite noted:**
```ts
// main.ts top: capture pageLoadT (§0.2) + attribution ONCE
const pageLoadT = performance.now();
track('page_view', { referrer_host: refAllow(hostOnly(document.referrer)),
                     utm: params.get('utm_source'), has_seed: params.has('seed') });
if (challengeSeed != null)                                   // challengeSeed @99
  track('challenge_open', { referrer_host: refAllow(hostOnly(document.referrer)),
                            share_token: rotShareToken() });  // rotating token, NOT raw seed

// main.ts ~168: emit EARLY; backendNote exists (§0.6); screen/DPR COARSENED (rule #5)
track('tech_profile', { backend: onWebGPU()?'webgpu':'webgl2', backend_forced: normNote(backendNote),
                        bloom_ok: !!post, dpr_bucket: dprBucket(devicePixelRatio),
                        screen_tier: screenTier(screen.width, screen.height), target_fps: settings.fps });

// hud.showStart @269
track('title_shown', { challenge: challengeSeed!=null, daily_num: dailyNumber(Date.now()),
                       daily_best_local: getDailyBest(...) });

// deploy() @266 (= run_start). ttfr_ms needs pageLoadT (§0.2)
track('run_start', { mode, survivor:AVATARS[settings.avatar].name,
                     daily_num: isDaily?dailyNum:null, ttfr_ms: performance.now()-pageLoadT,
                     backend: onWebGPU()?'webgpu':'webgl2' });

// gameOver() @573 — REUSE the existing newDailyBest from main.ts:583 (do NOT call recordDailyScore again, §0.5).
// runsThisSession (§0.3) + runTainted (§0.4) are new module state.
track('run_end', { mode, survivor:AVATARS[settings.avatar].name,
                   score:state.score, kills:state.kills, level:state.level, time_s:state.time,
                   combo_peak:state.comboPeak, is_daily:isDaily, daily_num:dailyNum,
                   new_daily_best: newDailyBest, run_index:++runsThisSession,
                   tainted: runTainted, end_reason:'death' });

// share_click — fired from main.ts via the onShare callback passed INTO hud.showGameOver (§0.8),
// NOT inline in hud.ts's onclick. mode/isDaily are in scope here; hud only reports the method.
hud.showGameOver(state, { ...info, onShare:(method)=>
  track('share_click', { is_daily:isDaily, method, score:state.score }) });
```

**Umami:** injected by `bootUmami()` above — **no static `<script>` in `index.html`** (that was the kill-switch bypass).
**CSP (§0.9 — adding one for the first time):** ship `Content-Security-Policy-Report-Only` first to confirm Three.js module/WebGPU boot survives, then enforce `connect-src 'self' https://t.neon-swarm.example https://analytics.neon-swarm.example`. Keep Umami's **default `/api/send`** path (custom paths have Safari/Firefox sendBeacon CORS quirks).

---

## 6. Ingestion + Scale + Anti-Cheat

### 6a. Anti-cheat — REFRAMED HONESTLY (this is the biggest correction)

**Byte-identical server re-sim is IMPOSSIBLE against the current engine. Do not ship the leaderboard promising it.** Verified against the code:
- **Variable-timestep wall-clock loop.** `main.ts:766` `setAnimationLoop`, `:769` `dt = Math.min(0.05, rawDt)`, `:786-792` `simDt` (incl. hit-stop `dt*0.18`), `:408` `spawnAcc += dt*spawnRate(t)`. A server cannot reproduce a player's exact `dt` sequence (frame pacing, hit-stop, tab throttling, quality governor), so a replay does not reproduce the score even with a perfect input log.
- **`Math.random()` is in the OUTCOME path**, despite `rng.ts`'s aspirational "cosmetic-only" comment. `swarm.ts:176` sets enemy speed `v = base + Math.random()*0.3` (speed decides whether enemies reach the player → affects survival/score); `swarm.ts:159` bob bucket; plus `main.ts:303` horde cheat and `main.ts:598-602` boss spawn placement. Two replays of the same seed+input **diverge**. (This is also a real determinism bug to file regardless of analytics.)
- **No input log exists.** `main.ts` samples input LIVE from the DOM via `getMove()` each frame; nothing is recorded or serialized.
- **The real daily threat is farming, not score-tampering.** `dailySeed` (`daily.ts:29`) is public FNV-1a of the UTC date — anyone can compute it offline, run thousands of headless sims, and submit the best with a *perfectly legitimate* run. Re-sim would VALIDATE that. Re-sim catches `score != replay`; it does NOT catch botted/farmed-optimal play.

**v1 anti-cheat = statistical / heuristic flagging (no replay):**
- Impossible-score thresholds (score given `time_s`, `level`, `kills` exceeds analytic ceiling).
- Sanity ratios computed at submit: `kills_per_sec`, `score_per_min` outside human envelope → `flagged`.
- Per-daily percentile-outlier flagging (a score N sigma above the distribution → `flagged` for manual review).
- `tainted` runs (cheat/`__dbg` fired) are rejected from leaderboards outright.
- Display policy: leaderboard shows `accepted`; `flagged` held for review; nothing claims cryptographic verification.

**If true verification is ever required**, it is a **multi-WEEK engineering project, not an afternoon**: make the loop fixed-timestep, move ALL outcome-affecting randomness onto `srand()` (kill the `Math.random()` calls in `swarm.ts`/spawn paths), add a deterministic serializable input-log recorder, AND add anti-farming (rate-limit submissions per daily, proof-of-effort, or server-authoritative seeds). That is its own spec with its own GO — explicitly out of scope here.

### 6b. Ingestion

**Origin trust (was a spoofing hole).** `t.<domain>` and `api.<domain>` **REJECT any request not arriving via the Cloudflare Tunnel** — enforced by (a) only binding the tunnel, no public DNS A record, and (b) a shared-secret header injected by cloudflared and verified at the origin. Otherwise a leaked origin IP lets clients spoof `CF-Connecting-IP`/`CF-IPCountry` to poison `anon`/`country` and bypass rate limits.

**`POST /t` returns `204` instantly; never blocks on disk:**
```go
var ch = make(chan Event, 50000)                  // BOUNDED ring buffer. drop-on-full = SHED, never OOM.
// NOTE: this buffer is per-process and in-memory. A crash / launchd-KeepAlive restart loses up to
// 50k queued events AND resets `dropped`. Acceptable (telemetry is lossy-by-design) but we EXPORT
// `dropped` + a restart counter to a metric so the loss is measurable, not silent.

func handleTelemetry(w http.ResponseWriter, r *http.Request) {
  if !verifyTunnelSecret(r) { w.WriteHeader(403); return }            // reject non-tunnel traffic
  if !configEnabled() { w.WriteHeader(204); return }                 // kill switch
  var b Batch
  if json.NewDecoder(io.LimitReader(r.Body, 128<<10)).Decode(&b) != nil { w.WriteHeader(204); return }
  ip := truncate(r.Header.Get("CF-Connecting-IP"))                   // /24 or /48 — trusted only post-secret
  country := r.Header.Get("CF-IPCountry")                            // 2-letter, server-stamped
  anon := dailyHash(saltToday(), ip, coarseUA(r.UserAgent()))        // raw ip now out of scope
  now := time.Now().UnixMilli()
  if len(b.Ev) > 50 { b.Ev = b.Ev[:50] }                             // cap array BEFORE the loop
  for _, e := range b.Ev {
    if !validName(e.Name) { continue }                               // allowlist; reject junk
    ev := Event{Ts: now, ClientTs: e.Ts, Anon: anon, Sess: b.Sid, Day: utcDay(now),
                Name: e.Name, Props: clampJSON(e.Props, 2<<10), Country: country,
                IsBot: classifyBot(r.UserAgent())}
    select { case ch <- ev: default: atomic.AddInt64(&dropped, 1) }  // SHED, don't block
  }
  w.WriteHeader(204)
}
```
**Single writer goroutine** drains `ch` into `telemetry.db` in batched transactions (one txn per 500 rows or per 250ms). Only writer to that file.

**Scores → PocketBase** on its own file. **Leaderboard.db has INTERNAL self-contention** the 3-file story does NOT solve: the heuristic verifier writes `status`/`flag_reason` back while `/score` POSTs are writing — both fight PocketBase's single write lock, and `busy_timeout=5000` means a `/score` POST can stall up to 5s then `SQLITE_BUSY` under a flood. Mitigation: the verifier batches its status-writes into infrequent transactions (one sweep, not row-by-row), runs at low priority (below), and `/score` writes are tiny/fast so the lock is held briefly.

> **PocketBase-route variant (lighter ops):** register the ingest route inside a **second PocketBase instance** pointed at its own `telemetry.db`. The separate-file isolation is what matters. Never put events in the leaderboard PB instance.

**SQLite tuning:** WAL + `synchronous=NORMAL` + `busy_timeout=5000` + `wal_autocheckpoint=1000`; nightly `PRAGMA wal_checkpoint(TRUNCATE)`.

**Scale envelope — corrected to name the REAL bottleneck.** Batched WAL sustains ~10k–50k writes/s; `5M events/day ≈ 58 ev/s mean`, `100× spike ≈ 5,800 ev/s`. **SQLite write throughput is NOT the limiter at that rate.** The limiter under a spike is **inbound request handling + the single cloudflared tunnel process + TLS + the Go handler**, all of which run before a row ever reaches the ring buffer. The tunnel is one process with practical connection/throughput ceilings; that is the layer that bends first, not SQLite. Real breakers: (a) tunnel/request-handling saturation; (b) Metabase JVM OOM contending with everything (§7); (c) WAL bloat from snapshot readers under sustained writes (§7); (d) leaderboard.db internal lock contention (above). Three files prevent a telemetry storm from starving scores; they do NOT make the box infinitely scalable.

**Viral-spike graceful-degradation escalator (origin-first, edge-bonus):**
1. **Origin rate limiting is the primary backstop** (the free-plan edge may not have the rule slots). The Go ingest + PocketBase enforce per-IP limits in-process.
2. Edge cache absorbs leaderboard reads IF a free cache rule is configured.
3. Raise sampling via `telemetry-config.json` (`run_end`/`share_click` stay 1.0; `perf_sample`→0.005, `ability_use`→0.01) — ≤60s propagation, no deploy.
4. Ring buffer sheds telemetry on overflow — leaderboard untouched (separate file).
5. Global kill switch: `telemetry-config.json {"enabled":false}` halts ingest.
6. Heuristic verifier stays bounded (below) so a submit flood can't eat CPU.

**Verifier resourcing (nice value CORRECTED + queue bounded by CPU):** the verifier runs at **`nice +10` (LOWER priority — yields to the request path)**. The original draft's `nice -10` was inverted: negative nice = *higher* priority, the opposite of "don't starve the box." Additionally cap total verifier CPU (cpulimit/cgroup) and impose a **hard `max N verifications/hour, shed the rest to status='pending'`** rule so a flood cannot back up for hours or peg the M-series cores. (Even heuristic scoring of pathological submissions is bounded this way; if real re-sim is ever added, this CPU governor is mandatory because a single replay would be seconds-to-minutes of game time.)

**Retention/backups:** **monthly partitioning + incremental vacuum** (NOT a single weekly full `VACUUM` — on a multi-GB viral file that needs ~equal scratch space and locks the DB for a long time = an outage). Nightly prune `DELETE FROM events WHERE day < date('now','-90 day')` operates per-partition. Nightly online `.backup` of **both** DBs (WAL-safe), `integrity_check` the copies, rsync off-box. **Leaderboard backup is priority** — scores are irreplaceable; telemetry is lossy-by-design. **Backup hygiene:** the salt path (§3 rule #3) is in the backup ignore-list. Umami's Postgres gets a scheduled `pg_dump`. **Run one manual restore drill before go-live** (untested backups are worthless).

---

## 7. Dashboards & Ops

**Datasette-primary** (read-only snapshot). **Metabase OPTIONAL** — only if the RAM budget below has room; default ship is Datasette-only because Metabase's JVM is the top OOM risk during a spike. Umami covers Funnel/Referrer/UTM visually.

**RAM budget (the box's RAM MUST be stated before GO — assume 8GB unless confirmed otherwise; if 8GB, drop Metabase):**

| Component | Rough RSS | Note |
|---|---|---|
| Postgres 16 (Umami) | ~400 MB | recurring ops: `pg_dump`, version upgrades |
| PocketBase (leaderboard) | ~80 MB | |
| Go ingest + 50k ring buf | ~50–100 MB | |
| Umami node | ~150 MB | |
| Datasette | ~100 MB | lightweight, primary |
| Metabase JVM (`-m1g`) | **1–1.5 GB+** | spikes past `-m1g` under heavy query; **OOM/swap trigger during a spike** |
| OS + headroom | ~1.5 GB | |

On an 8GB box, running Metabase **and** absorbing a traffic spike **and** running a verifier sweep is a swap/OOM hazard. **Default: Datasette-only.** Two DB engines (Postgres + SQLite×2) + Umami + PocketBase + Go + cloudflared is already a lot of moving parts and recurring ops for a hobby box — this is acknowledged, not waved through.

**The load-bearing SQL:**

**K-factor — computed to MATCH the §4 prose definition** (the original `k_factor` query computed only `challenge_open/distinct(run_start)` and mislabeled it):
```sql
WITH t AS (SELECT * FROM events WHERE day = strftime('%Y-%m-%d','now') AND is_bot=0)
SELECT
  (SELECT COUNT(DISTINCT anon) FROM t WHERE name='run_start')              AS activated,
  (SELECT COUNT(*) FROM t WHERE name='share_click')                        AS shares,
  (SELECT COUNT(*) FROM t WHERE name='challenge_open')                     AS invites_opened,
  (SELECT COUNT(*) FROM t WHERE name='run_end'  AND share_token IS NOT NULL) AS runs_on_invite,
  -- K = (shares/activated) * (challenge_open/share) * (run_end_on_challenge/challenge_open)
  ROUND(
    ( 1.0*(SELECT COUNT(*) FROM t WHERE name='share_click')
          /NULLIF((SELECT COUNT(DISTINCT anon) FROM t WHERE name='run_start'),0) )
  * ( 1.0*(SELECT COUNT(*) FROM t WHERE name='challenge_open')
          /NULLIF((SELECT COUNT(*) FROM t WHERE name='share_click'),0) )
  * ( 1.0*(SELECT COUNT(*) FROM t WHERE name='run_end' AND share_token IS NOT NULL)
          /NULLIF((SELECT COUNT(*) FROM t WHERE name='challenge_open'),0) )
  , 3) AS k_factor_lower_bound;
  -- LOWER BOUND: challenge_open undercounts (Web Share/clipboard kill the referrer & sometimes utm).
  -- K >= 1 => self-sustaining viral. Card also shows '% challenge_open with usable attribution'.
```

**Cross-day retention — NOT computed in SQLite (was an internal contradiction).** With daily-destroyed salt, `anon` is non-stable across days, so an `anon`-keyed cross-day cohort JOIN returns ~0, not a lower bound. The §7 D1/D7 anon-JOIN from the original draft is **removed**. Cross-day return is reported **only** from **Umami (directional)** and labeled directional on the dashboard. Exact cohorts require the v2 rotating-linkable token under a fresh privacy GO (§8).

**Acquisition sources (last 7d):**
```sql
SELECT CASE
   WHEN referrer_host IS NULL OR referrer_host='' THEN 'direct/unattributed'   -- incl. Web Share/clipboard
   WHEN referrer_host LIKE '%t.co%' OR referrer_host LIKE '%x.com%' OR referrer_host LIKE '%twitter%' THEN 'twitter/x'
   WHEN referrer_host LIKE '%discord%' THEN 'discord'
   WHEN referrer_host LIKE '%reddit%'  THEN 'reddit'
   WHEN utm='challenge' OR share_token IS NOT NULL THEN 'challenge-link'
   ELSE 'other' END AS source,
  COUNT(*) loads, COUNT(DISTINCT anon) visitors
FROM events WHERE name='page_view' AND is_bot=0 AND day>=date('now','-7 day')
GROUP BY source ORDER BY loads DESC;
-- 'direct/unattributed' is expected to be LARGE: Web Share/clipboard shares strip the referrer.
```
Other cards: **DAU (with `salt_rotations` flag so inflated days are obvious)**, **same-day activation funnel** (`page_view`→`run_start`→`run_end`), **daily-challenge completion** (`run_end is_daily`/`run_start mode=daily`), **tech health** (`webgpu_pct`, `crash_pct`, `avg_fps_at_death`, leaderboard `flagged_pct`). Exclude `tainted=1` from all score stats.

**Bot filtering:** server sets `is_bot` at insert via UA blocklist (`facebookexternalhit|slackbot|discord|bot|crawl|spider|preview|headless`); nightly sweep flags any `anon` with a `page_view` but no `run_start` within 30s. Keep raw-vs-filtered counts side-by-side — link-unfurlers wreck K-factor otherwise.

**Alerting / health (`healthcheck.sh`, cron `*/2`, push via ntfy):** outage (`/api/health` must 200 in 3s), spike (>5000 page_views/5min → pre-emptively raise sampling), crash-spike (`crash_pct`>5%/15min → WebGPU regression), **salt-rotation alert** (>1 rotation/day = a mid-day restart skewed DAU), **drop/restart-counter alert** (ring buffer shed or process restart). **Snapshot** (periodic): `sqlite3 telemetry.db ".backup snapshots/ro.db"` — dashboard reads the snapshot, never the live WAL.

> **WAL-bloat warning (real disk-fill risk during the spike you care about):** a `.backup` holds a read transaction, and a busy WAL **cannot checkpoint while that reader is active**. Under a 100× spike, frequent snapshot reads + a continuous writer can let `-wal` grow unbounded between snapshots until the nightly TRUNCATE. Mitigations: (a) **lengthen the snapshot interval during a spike** (the escalator can switch it to hourly), (b) monitor `-wal` size and alert before disk pressure, (c) prefer `PRAGMA wal_checkpoint(PASSIVE)` opportunistically between snapshots. This is the disk-fill trap at exactly the worst moment.

**Disk sizing (was absent):** `5M events/day × 90 days = 450M rows`. With ~24 columns incl. TEXT (`survivor`/`utm`/`referrer_host`/`share_token`) and 3 indexes, plan **~50–150 GB** for `telemetry.db` at sustained viral scale; the 3 indexes also tax every insert, eroding write headroom. This is why retention is **monthly-partitioned with incremental vacuum** and why the disk free-space alert is mandatory. (At normal hobby volume this is megabytes — the sizing matters only IF it goes viral, which is the scenario the doc is for.)

**Backup-vs-evidence:** there is **no `input_log` to lose** (it was removed, §6a), so the original "NULL after validation drops the only evidence" tension is gone. Heuristic flags + the stored derived ratios are the audit trail; `flag_reason` persists.

---

## 8. Rollout Plan (folds into Phase 2b — needs GO)

> **Instrument this ONE thing first:** `run_end` (the `gameOver()` hook at main.ts:573) flowing to `/t`. It is the North-Star event and the score-submit payload — but it is **not free**: it depends on §0.3 (`runsThisSession`), §0.4 (`runTainted`), and reusing the existing `newDailyBest` (§0.5). Land those, then this single event gives the activation denominator's other half, K-factor's conversion leg, and the leaderboard write.

**v0 — PREREQUISITE code diffs (do these BEFORE the analytics afternoon — they are real diffs, not one-liners):**
- [ ] §0.1 Vite `__VER__`/build-sha define (else `build` is `undefined` everywhere).
- [ ] §0.2 `pageLoadT`, §0.3 `runsThisSession`, §0.4 `runTainted` module state in `main.ts`.
- [ ] §0.5 reuse existing `newDailyBest` (do NOT double-call `recordDailyScore`).
- [ ] §0.6 normalize existing `backendNote` → `native|forced|auto-fallback`.
- [ ] §0.7 append `utm_source` to `shareUrl` (main.ts:588) — `shareText` (hud.ts:414-416) inherits it.
- [ ] §0.8 add `onShare` callback param to `hud.showGameOver`; fire `share_click` from `main.ts`.
- [ ] §0.9 author the first-ever CSP; ship `Report-Only` and confirm WebGPU/WebGL2 boot, then enforce.
- [ ] Coarsen screen→tier + DPR→bucket helpers; `refAllow()` referrer allowlist; `rotShareToken()`.

**v1 — ship (one afternoon, AFTER v0):**
- [ ] DNS + cloudflared: `analytics.`→:3100, `t.`→:8090, `api.`→:8091. cloudflared under launchd `KeepAlive`. **Origin firewall + tunnel shared-secret so non-tunnel traffic is rejected (anti-spoof).**
- [ ] Cloudflare (FREE plan — configure what the rule budget allows; **origin-side rate limiting is the real backstop**): cache GET `/leaderboard*` + `/telemetry-config.json` via origin Cache-Control; per-IP rate limits at origin; WAF on.
- [ ] Umami (Postgres 16) via docker-compose; create website, grab id. **Umami injected by `bootUmami()` behind the gate — NO static `<script>`.** Append UTM to share/challenge links.
- [ ] `telemetry.db` (schema §4, STRICT, migration policy) + Go ingest (`/t`, tunnel-secret check, ring buffer, single batched writer) **OR** 2nd PocketBase instance on its own file. Implement **server salted-daily-hash anon + salt regen at start AND UTC midnight + salt in tmpfs/excluded-from-backup + IP truncate/discard + disabled IP access logs**.
- [ ] PocketBase `leaderboard.db` `scores` collection; `/score` submit computing `kills_per_sec`/`score_per_min`; **heuristic verifier (impossible-score + ratio + percentile-outlier), `nice +10`, CPU-capped, max-N/hour shed-to-pending. NO re-sim, NO input_log.**
- [ ] Ship `src/telemetry.ts` (GPC + DNT incl. Firefox-legacy + opt-out gate, beacon-fallback-on-false, Umami-gated) + Settings opt-out toggle; wire the **7 v1 events** at the §5 hooks; ship `telemetry-config.json` kill-switch.
- [ ] Datasette on the snapshot; build the Daily Health dashboard (K-factor-lower-bound, same-day activation, DAU+salt-rotation flag, attribution coverage, tech health). **Metabase only if RAM (§7) allows.**
- [ ] Cron: `healthcheck.sh` (`*/2`), `snapshot.sh` (spike-adjustable interval + WAL-size guard), hourly rollups, nightly prune + WAL-truncate + verified backup (salt excluded). **Do one manual restore drill.**
- [ ] Write the **GDPR LIA** doc for the in-request IP processing; publish `/privacy` (corrected blurb §3).

**v2 — later:**
- [ ] Remaining events: `level_up`, `ability_use`(sampled), `boss_event`, `cheat_used`, `perf_sample`(sampled), `watchdog`.
- [ ] Umami v3 upgrade path is Postgres-clean (never go MySQL).
- [ ] DuckDB/Parquet export only IF dashboard scans get slow.
- [ ] **Privacy-reviewed rotating-but-linkable token** for exact cross-day cohorts — **needs a fresh privacy GO** (reintroduces device-storage tradeoffs v1 avoids; would change the consent posture).
- [ ] **True leaderboard verification = its own multi-WEEK spec/GO:** fixed-timestep loop, all outcome randomness on `srand()` (remove `swarm.ts:176`/spawn `Math.random()`), deterministic input-log recorder, AND anti-farming for the public daily seed. Not part of this doc.

**Files this touches (all absolute):**
- `/Users/padi/Documents/projects/ai-projects/neon-swarm/src/telemetry.ts` (new)
- `/Users/padi/Documents/projects/ai-projects/neon-swarm/src/main.ts` — §0 state (`pageLoadT`, `runsThisSession`, `runTainted`), utm on `shareUrl` (:588), reuse `newDailyBest` (:583), `onShare` wiring, and the 7 `track()` calls (~99, ~168, 269, 266, 573)
- `/Users/padi/Documents/projects/ai-projects/neon-swarm/src/hud.ts` — `onShare` callback param on `showGameOver` (~419); inherits utm via `info.shareUrl`
- `/Users/padi/Documents/projects/ai-projects/neon-swarm/src/swarm.ts` — (v2 only) remove outcome-path `Math.random()` IF true re-sim is ever pursued
- `/Users/padi/Documents/projects/ai-projects/neon-swarm/index.html` — first-ever CSP `connect-src` (Report-Only first); NO Umami `<script>` (injected by SDK)
- `/Users/padi/Documents/projects/ai-projects/neon-swarm/vite.config.*` — `__VER__`/build-sha define
- plus new server/infra files (`docker-compose.yml`, `telemetry-config.json`, ingest Go/PB-hook, `*.sh` cron scripts) living outside the static repo on the Mac Mini

**Caveats pinned to the dashboard (honest by design):**
- **Cross-day retention is NOT measured in SQLite** — daily salt destroys the link; Umami's number is directional only.
- **K-factor is a lower bound** — Web Share/clipboard strip the referrer, so `challenge_open` undercounts; the attribution-coverage card shows how blind we are.
- **DAU is inflated on any day with >1 salt rotation** (a mid-day restart splits the cohort) — the `salt_rotations` card flags it.
- **Cookieless ≠ legally bulletproof** — the no-consent-banner stance is defensible, not settled; an LIA is on file and raw IP is never stored, but Cloudflare's edge still sees IP and is a third party in the path.
- **Anti-cheat is heuristic, not verified re-sim** — the engine is non-deterministic (variable dt + `Math.random()` in the outcome path) and farming a public daily seed is undetectable by replay anyway.
