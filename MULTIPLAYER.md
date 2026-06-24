# NEON SWARM — 2-Player Co-op Design Doc

**Status:** Definitive design, ready to execute. **Author:** Lead Architect. **Date:** 2026-06-23.
**Audience:** the solo developer building it. **Constraint:** privacy-first, self-hosted on a Mac Mini, no cloud accounts.

> **How to read this doc.** The architecture choice (host-authoritative over lockstep) is sound and verified against the codebase. The OFF-state invariant and flag reuse are solid. But four of the v1 problems are genuinely hard and only *partially* solved — they are called out inline with a **⚠ HARD** tag so nobody mistakes "named" for "solved": prediction-under-collision (§3.2), hit-stop propagation (§3.2.1), bandwidth-when-players-separate (§3.3/R1), and the level-up control-flow refactor (§3.6/§6.2). Read those before estimating.

---

## 1. Goal & Scope

Ship **2-player browser-to-browser co-op** for NEON SWARM, covering **both Free Play and the Daily/Challenge**, behind a feature flag that is **OFF by default and never touches solo play**.

**In scope (v1):**
- Two players, two browsers, two cameras (no split-screen), one shared seeded city.
- Free Play co-op (host shares a random seed) and Daily co-op (both derive the same `dailySeed`).
- WebRTC P2P transport + a tiny self-hostable signaling server on the Mac Mini.
- Host-authoritative netcode: host runs the live sim, joiner predicts only its own movement.
- Co-op-specific UX: downed/revive, partner HUD, separate per-player progression.
- A separate co-op leaderboard board that never pollutes the solo daily board.

**Explicitly out of scope (v1) — documented, not promised:**
- More than 2 players.
- Host migration (host leaving ends the run — host-authoritative's honest cost).
- Deterministic **lockstep** netcode (phase-2; requires a fixed-step refactor — see §2.3).
- Real anti-cheat (free game; we isolate co-op runs rather than enforce).
- The full 20,000-enemy horde in co-op (MP runs a lower cap for bandwidth — see §3.4).

**Non-negotiable invariant:** when the flag is null, **zero co-op code loads** and the game is byte-for-byte identical to today. This is verified by the same OFF-state mechanism the backend already uses — the `seed 777 → 8 srand()` desync gate in `selftest.ts:135–137`, plus the "zero network while OFF" asserts at `selftest.ts:469–482`.

---

## 2. Recommended Architecture

### 2.1 Decision: Host-Authoritative WebRTC P2P

**One player's browser (the host) runs the entire live simulation** — the existing `update(simDt)` loop, unchanged. The host streams world-state snapshots to the joiner. The joiner is a **presentation + input client**: it predicts only its own avatar's movement (reconciling against host snapshots) and renders everything else (enemies, the partner, all damage/scoring) directly from snapshots and authoritative events.

### 2.2 Why host-authoritative (and not lockstep) is correct *today*

The single most important fact in this codebase: **the main loop is a variable timestep.** `src/main.ts:1365` computes `dt = Math.min(0.05, rawDt)` from `performance.now()`, and `src/main.ts:1383–1385` further scales it to `simDt = dt * 0.18` during hit-stop. The sim's math is a function of a wall-clock-derived, frame-rate-dependent, slow-mo-warped `dt` that **will never be identical on two machines.**

Three consequences drive the decision:

1. **Lockstep is impossible without a rewrite.** Deterministic lockstep requires both peers to reach bit-identical state from `seed + both input logs`. That demands a **fixed timestep** so `dt` leaves the math entirely. We don't have one. (Detailed prerequisite in §2.3.)
2. **Host-authoritative needs no per-frame determinism.** It works *on top of* the variable-timestep sim as-is, because only **one** machine ever simulates. The seeded spine we already have (`setSeed`/`srand`/`streamFrom`/`CITY_SALT`, confirmed in `rng.ts`) is enough: the host alone advances `srand()`, so spawns/upgrades/loot stay reproducible, and **both browsers regenerate the identical city** from the same seed via `streamFrom(CITY_SALT, seed)` — so the static world **never needs to be networked as content**, only the host's live enemy *positions*.
3. **The desync gate becomes moot, by design.** With one simulator there is no cross-peer divergence to gate. The joiner must **never call `srand()` for gameplay** — that's the one new invariant, and it's directly testable (§6.7).

The seeded RNG comment in `rng.ts:5–14` already names this exact use case: *"same-seed multiplayer — all WITHOUT ever networking the 20k-enemy horde."* The engine was built anticipating this path. **But note the precise scope** (this is a correction to earlier drafts): the shared seed buys the joiner an **identical city only**, plus reproducible host-side spawns; it does **not** mean the joiner runs the same gameplay RNG. See §2.4.

### 2.3 The lockstep alternative (phase-2) and its prerequisite refactor

Lockstep sends **only the ~10-byte input packets both ways**; each peer sims the identical world locally. Bandwidth becomes trivial and the full 20k cap returns — no snapshots at all. The costs are **input-delay latency** and that *any* float/logic divergence desyncs the run.

To earn it, the loop's spine must change:

1. **Variable → fixed step.** Replace `dt = Math.min(0.05, rawDt)` with a fixed `STEP = 1/60` accumulator: run N integer `update(STEP)` steps per frame, render-interpolate the remainder. This removes `dt` from the sim math — including reworking the hit-stop `simDt = dt * 0.18` (line 1385) into an integer step-skip or step-rate change.
2. **Input log keyed by tick.** A peer only advances tick T once *both* players' inputs for T have arrived (the lockstep stall), with input-delay (run T against inputs from T−3) to hide RTT.
3. **Purge non-seeded gameplay randomness.** The `Math.random` calls in `swarm.ts` for `bob`/`baseCol` are confirmed cosmetic (the `rng.ts` contract guarantees this), so they're safe — but audit that *nothing* outcome-affecting bypasses `srand()`. The `seed 777 → 8 srand()` desync gate then graduates from a build-time selftest into a **per-tick cross-peer world-state hash** that halts on mismatch.
4. **Cross-machine float determinism** — the genuinely hard part; may require fixed-point or a tolerance hash for the world-state checksum.

**When it's worth it:** only after co-op proves popular *and* players demand the full horde or low-bandwidth (e.g. mobile/cellular) play. Treat it as a **separate future project**, not a stretch goal of this one.

### 2.4 What the shared seed actually buys (clarifying a real conflation)

Earlier analyses described `?seed=` as pinning both players to "the identical city **and** gameplay RNG." That double claim is contradictory in host-authoritative mode and must be stated precisely:

- **City:** `setSeed(seed)` then `streamFrom(CITY_SALT, seed)` regenerates a **byte-identical city** on both browsers. ✅ Both peers do this. The static world and its seeded **Drop list** are therefore free on the wire.
- **Gameplay RNG:** advances on the **host only**. The host's `srand()` cursor drives spawns, upgrade rolls, and loot. The **joiner must never advance gameplay `srand()`** (the §6.7 invariant) — if it did, its cursor would diverge from the host's and there'd be nothing keeping them aligned, since the joiner doesn't run the director.

So: **seed → identical city on both peers; gameplay RNG → host-authoritative, joiner-frozen.** The shared seed is *load-bearing for the city* and *decorative for the joiner's gameplay RNG*. This is not a contradiction once you separate the two cursors (`streamFrom` reads a fork; the gameplay stream is the one we freeze on the joiner).

---

## 3. Netcode Design

### 3.1 Authoritative tick (host)

The host runs the existing `update(simDt)` loop unchanged — it is already the full sim (swarm, bullets, missiles, gems, director, secondaries). Two engine changes plus one emit:

1. **Two player entities.** Promote the single `player` Group + `state` singleton into a 2-element player array (the load-bearing refactor; full plan in §6.1–6.2).
2. **Dual-target swarm AI + per-player damage return.** `swarm.update()` (signature at `src/swarm.ts:237`, currently `update(dt, time, playerX, playerZ, grid, blockGrid)`) chases a single `(playerX, playerZ)` by value and returns a single `playerDamage: number` (`swarm.ts:359`). Change it to accept **both player positions**, steer each enemy toward the **nearest** of the two (a cheap 2-way distance compare inside the existing per-instance loop — no new pass), and **return per-player contact damage** instead of one scalar.
   > **Touched call-site (do not under-scope this).** The targeting change is swarm-internal, but the return-type change is **not contained**: the sole caller at `main.ts:1260` (`const damage = swarm.update(...)`) consumes the scalar and applies it to one player's HP/i-frames. That line and its damage-application block must split into per-player handling. It's one call-site, but it's the *damage pipeline*, so treat it as a real edit, not a signature tweak.
3. **Snapshot emit** after `update()`, gated by a **fixed 20 Hz accumulator** that samples the latest sim state. The host keeps simming at full framerate; only the *send cadence* is fixed (do not add a fixed simulation step — that's the §2.3 rewrite).

The host alone advances `srand()`. The joiner's gameplay RNG cursor is never touched.

### 3.2 Client prediction + reconciliation (joiner's own avatar only) ⚠ HARD

The joiner predicts **only its own movement.** It `setSeed()`s to the same seed and regenerates the identical static `BlockGrid` locally (`PLAYER_RADIUS = 0.8`, the shared move-resolve constant, `swarm.ts:66`). Each frame it integrates its own input against that grid and stores `{seq, predictedPos}` in a ring buffer.

Each host snapshot carries `lastInputSeq`. On arrival the joiner snaps its avatar to the authoritative position, then **replays** buffered inputs after `lastInputSeq` through the same movement+`BlockGrid` resolve. If the post-replay error is **< ~0.3u**, smooth-correct over ~100 ms instead of snapping (kills rubber-banding).

**Do not predict** bullets, enemies, HP, pickups, score, or combo. They are display-only from snapshots and authoritative events — this deletes the entire hardest desync class.

**⚠ The honest limit — prediction is clean in open space, NOT near walls.** Earlier drafts claimed the variable timestep is "a non-issue" because "movement integrates cleanly under any `dt`." That is **only true in open space.** The move-resolve is **non-linear**: it slides the player along the `BlockGrid` against `PLAYER_RADIUS`, clamped per frame. When the joiner *replays* the same inputs under a **different `dt`-split than the host used**, the collision path along a building edge diverges — the reconciliation error is then **not** a smooth <0.3u offset but a **discontinuity** (the predicted path took a slightly different slide). Consequences and the chosen posture:

- **Accept a visible snap near geometry.** In open space, corrections stay sub-0.3u and lerp invisibly. Hugging a wall, the joiner may see a small position pop on snapshot arrival. This is acceptable for a frantic twin-stick where you're rarely wall-grinding under fire.
- **If wall-pop proves ugly in M2 playtest, the fix is to stop reconciling against a final position alone** and instead have the host stamp each input `seq` with the **resolved post-step position** it produced, so the joiner reconciles against the host's *actual resolved path* rather than re-deriving it under a different `dt`. That's more bytes on the `rel` channel but removes the near-wall guesswork. **Decide in M2 from real footage, not now.** (Risk **R5**.)

This is reconciliation, **not** deterministic re-simulation — there is no rollback of the world, only of the local avatar's kinematics.

#### 3.2.1 Hit-stop desyncs prediction too — propagate a time-scale ⚠ HARD

Hit-stop (`simDt = dt * 0.18`, `main.ts:1383–1385`) is **not just a lockstep concern** — it bites host-authoritative prediction directly, and earlier drafts missed this. Hit-stop is triggered by **gameplay impacts on the host**; the joiner, predicting its own movement, has **no knowledge of an active host hit-stop** until an event arrives. During the hit-stop window the host's avatar integrates at **18% speed** while the joiner's local prediction runs at **full speed** → a **guaranteed reconciliation pop on every juicy hit.**

**Fix (required for M2, not optional):** the host stamps every snapshot (and the relevant events) with a **`simScale` field** — the current `simDt/dt` ratio (1.0 normally, 0.18 during hit-stop). The joiner **scales its own movement integration by `simScale`** so its prediction tracks the host's slowed avatar. Because hit-stop is brief and snapshots are 20 Hz, the joiner runs slightly stale on the scale, but the residual is tiny and lerps out. Without this field, every kill rubber-bands the joiner.

> This also interacts with §3.6 (global vs per-player hit-stop). If hit-stop stays **global** (host-side), `simScale` is one field. If it becomes **per-player**, the joiner needs *its* player's scale — still one field per local player, but the host must track two hit-stop timers. See Open Decision #8.

### 3.3 Snapshot / delta protocol (host → joiner)

Binary (`DataView`), **20 Hz**, delta-vs-last-acked baseline. JSON is too heavy at this entity count.

- **Players (×2):** pos (quantized int16 — world is ±600, giving ~0.02u resolution), `hp`, `level`, `xp`, `missiles`, `nukes`, `score`, `combo`, secondary levels (`orbitalLevel`/`teslaLevel`/`droneLevel`), active i-frames, **1-byte downed/bleed-out state**. ~40 bytes.
- **Swarm (area-of-interest):** only enemies within a cull radius of *either* player. Per visible enemy delta-encoded: `id`, `posX`/`posZ` (int16), `type` (3 bits), `hp`-bucket (4 bits), `flash` bit. **Never** send `bob`/`baseCol` — the joiner re-derives those cosmetics with `Math.random` locally, exactly as `rng.ts` intends.
- **Projectiles:** bullets/missiles as `id`+pos+vel (int16); joiner extrapolates between snapshots. Gems/drops: `id`+pos+type, spawn/despawn events only.
- **Events (reliable, ordered channel):** kills, damage applied, level-up offers, pickup-consumed, boss spawn, downed/revived, `simScale` changes (§3.2.1). The joiner's combo/score/HUD update **only** from these events — never from a local guess.

**⚠ Bandwidth: state the WORST case, not the headline.** Earlier drafts led with "2–4 KB at 20 Hz ≈ 40–80 KB/s." That is the **optimistic, players-together case** and it undersells the real risk in three ways:

1. **Separation explodes the AOI union.** When the two players split across the 1200×1200 map (which the design *encourages* — no leash), the AOI is the **union of two disjoint radii**, which can cover **most of the MP cap** in two clusters. The "smaller packet when split" intuition is wrong once both clusters are near the cap.
2. **Deltas don't stay small against a chasing horde.** Enemies move fast and chase players, so frame-to-frame position **deltas are large every tick** — delta-encoding saves far less than it does for mostly-static entities. Assume near-full int16 positions, not tiny deltas, for the chasing majority.
3. **Fresh baselines spike.** Any newly-AOI'd enemy needs a **full** int16 position (no delta baseline yet). A player turning to reveal a new cluster produces a baseline spike well above the steady-state number.

**Therefore the real budget must be derived from the worst case:** both players apart, ~full cap split across two AOIs, mostly baselines/large-deltas. At a 1,500-cap that is on the order of **~7.5 KB/packet → ~150 KB/s host upload** at 20 Hz in the bad case — *several × the headline number*, and the figure that must fit the host's real **upload** budget. **Concrete fallbacks, committed (not just "auto-tune in M5"):**

- **Adaptive send rate:** when measured upload exceeds budget, **drop the snap cadence to 10 Hz** (interpolation already covers the gap) before anything else.
- **Adaptive cap *during a run*:** shrink the live MP enemy cap dynamically when the channel can't sustain it — not only at M5 tuning time. The director can be told "hold at N" mid-run.
- **AOI tightening:** under pressure, shrink the per-player cull radius (closer enemies matter most).
- **Measure in M1b and pick the steady cap from the *separated* worst case**, never the together case.

Determinism fixes spawn *type/timing*, **not** positions under prediction — positions must still stream. Do **not** rely on the seed to skip the horde (Risk **R1**).

### 3.4 Enemy cap & area-of-interest

The MP enemy total is a **bandwidth** problem, not a CPU one. Add a co-op cap **constant** (do not touch solo's 20k `MAX_ENEMIES`) — **start at ~1,500** and let it be tuned **down** from the measured *separated* worst case (§3.3), with mid-run shrinking allowed. The full SoA is never serialized: AOI culls to the union of both players' radii. The host already builds a spatial grid each frame (`main.ts:1259`-area) — reuse it for the AOI query; no new structure.

### 3.5 Player separation across 1200×1200

The world is finite and there is **no leash** — splitting up to cover spawn pressure is legitimate co-op. AOI is the **per-player union** (and its worst case is the §3.3 bandwidth driver — separation is the *expensive* case, not the cheap one). The off-screen partner is shown as a **directional screen-edge arrow** (direction + distance) and a second minimap dot; the partner summary block (pos/hp/downed) is *always* sent regardless of AOI so the arrow and HUD stay live.

### 3.6 Event consistency + the level-up control-flow refactor ⚠ HARD

All score/kill/level/damage/pickup/revive decisions happen **once, on the host**, and arrive as reliable ordered events. The joiner's HUD is a pure function of those events.

**Level-up without freezing the partner — and why this is a real refactor, not a flag swap.** Today, `leveling` is a **module-level boolean** (`main.ts:428`) wired into a single gate that stops the **entire** `update()`:

```
// main.ts:1388
if (started && !over && !leveling && !paused) { tickRealtime(dt); update(simDt); }
```

`canAct()` (`main.ts:431`) also reads it, **and so does the debug stepper** (`main.ts:1146`: `if (started && !over && !leveling && !paused) { ... }`). So "make `leveling` a per-player struct field" is **under-specified** — flipping a per-player flag while the loop's gate still calls the whole `update()` either freezes everyone (if the gate still checks it) or freezes no one (if it doesn't). The actual work:

1. **Pull the input-pause out of the loop gate.** `update()` must **keep running every frame** in co-op (the shared sim can't stall), so the global `!leveling` term comes **out** of the `main.ts:1388` gate for the co-op path. The "this player is choosing an upgrade" pause moves into **per-player input handling** — the leveling player's `p.input` is ignored/zeroed while their picker is open, but the world steps on.
2. **Update `canAct()` (`:431`)** to be per-player (or co-op-aware): it currently answers one global question; touch/UI visibility keys off it.
3. **Update the debug stepper (`:1146`)** — it independently re-checks `!leveling`. Miss this and stepping behaves differently from the live loop in co-op. (Flagged explicitly because it's easy to forget.)
4. **Audit every place `leveling` gates UI** (the upgrade card overlay, touch show/hide) and route it through the local player's flag.

Flow once refactored:
- Host rolls upgrades with seeded `rollUpgrades()` and sends `levelup_offer{playerId, 3 ids}`.
- **Only the leveling player's input is paused** (their picker open, their `p.input` zeroed); the host keeps simming everyone else.
- That player picks (6s auto-pick-first fallback so an AFK player can't soft-lock the run), replies on `rel`; the host applies and resumes that player.

This is the single biggest *feel* decision in the mode (**Open Decision #1**) **and** a non-trivial control-flow change (#4 in the risk register). Budget it as such.

### 3.7 Disconnect / host-leave

- **Joiner drops:** host pauses ~3s ("partner reconnecting", attempts one WebRTC ICE restart), then continues solo; the dropped avatar becomes host-controlled, stationary, and invulnerable so the horde can't farm it.
- **Host leaves:** the live sim dies with it — host-authoritative's honest cost. **No migration in v1.** The joiner gets a clean **"host left — run ended"** screen (not a freeze).
  > **What the joiner can actually bank (correction to earlier drafts).** Because the joiner **never simulates score/kills/HP** — those are display-only from host events (§3.2/§3.6) — it has **no independent local tally.** "Bank the partial" therefore means banking **the last host-acked total**, which may be **a few seconds stale** (as old as the last received event before the channel closed). It is *not* a joiner-computed score. We surface it honestly as "your last synced score" and, for daily, allow submitting that last-synced figure. Do not imply a real local count exists (Risk **R6**).

---

## 4. Transport

### 4.1 The feature flag (reuse the exact existing pattern)

Add **one line** to `src/config.ts`, alongside the three backend flags at lines 18–20:

```ts
export const COOP_SIGNAL_ENDPOINT: string | null = ovr('COOP') ?? env('COOP_SIGNAL_ENDPOINT') ?? null;
```

Verified mechanics of the helpers (`config.ts:9–15`): `env(k)` **already prefixes `VITE_`**, so you enable co-op at build time with `VITE_COOP_SIGNAL_ENDPOINT=wss://…`; `ovr('COOP')` is the **DEV-only** `localStorage` key `ns-be-ovr-COOP` for QA (no override surface in production — `ovr` returns null unless `import.meta.env.DEV`). Null === OFF: no signaling import, no WebRTC, no co-op UI. STUN/TURN URLs ride alongside as `env('ICE_SERVERS')` (JSON). All co-op code sits behind `if (COOP_SIGNAL_ENDPOINT)`. **No new config concept is invented** — same shape, same OFF-guarantee as the leaderboard.

### 4.2 Signaling server (tiny WebSocket relay, ~80 LOC)

A dumb, room-keyed relay that **only brokers the handshake** and never sees gameplay. Run it next to PocketBase on the Mac Mini, behind the **same Cloudflare Tunnel** (mirrors the `server/` + `cloudflared` deployment pattern already in the repo). State is a `Map<room, [ws, ws]>`; nothing persisted.

**Messages (JSON, relayed verbatim — server never parses SDP):**

```
→ {t:'join',   room}            // client announces intent
← {t:'peers',  ids, host:bool}  // are you first (host) or second (joiner)?
↔ {t:'offer',  room, sdp}
↔ {t:'answer', room, sdp}
↔ {t:'ice',    room, cand}      // trickle ICE
← {t:'peer-left', room} / {t:'full'} / {t:'error', why}
```

Rooms hold **max 2** sockets (first = host, second = joiner). Once the DataChannel opens, **both sides close the WebSocket** — signaling is connect-only. Expire empty/half rooms after 60s. Privacy-first / self-host: room-code matchmaking only, nothing persistent (**Open Decision #7**).

### 4.3 Room codes + share links (tied into the existing `?seed=` path)

The host already owns a seed via `getSeed()`. Extend the existing challenge URL with a co-op room token:

```
https://…/?seed=1234567&co=A7K2
```

The `?seed=` half is the **existing** challenge path (parsed at `main.ts:160` — `params.has('seed')`, `Number(...) >>> 0`, then `setSeed(...)`) — it pins both players to the identical **city** (§2.4). The `?co=` half routes into signaling. At boot the joiner parses both: `setSeed(seed)` runs exactly as today, then if `co` is present **and** `COOP_SIGNAL_ENDPOINT` is set, it opens the WebSocket and joins that room as the **joiner** (never host).

- **Free Play co-op:** host generates `randomSeed()`, sends it to the joiner over signaling before deploy.
- **Daily co-op:** both independently compute the daily seed — identical by construction. **Reject the join if the two clients disagree on the daily number** (timezone/midnight edge), with a clear "you're on different days" message.

### 4.4 ICE: STUN free, TURN honestly needed

- **STUN:** `stun:stun.l.google.com:19302` (free, public) — covers most home/cone-NAT cases. Ship STUN-only first.
- **TURN:** be honest — STUN alone **fails for symmetric / carrier-grade NAT** (common on mobile, some ISPs); two such peers cannot connect P2P, period. The self-hoster's answer is **coturn on the same Mac Mini** behind the same tunnel (static-auth-secret, a UDP port range + 3478, a TLS cert; ~30 min to configure). It relays traffic, but co-op is 2 players at kilobytes/sec — negligible cost (egress roughly doubles for relayed pairs). Add it behind the same `ICE_SERVERS` flag in **M5**, when you get the first no-connect report. Don't pretend STUN is enough (Risk **R4**).

### 4.5 DataChannels (two, by reliability)

```ts
pc.createDataChannel('rel',  { ordered: true });                       // reliable: handshake, inputs, levelups, deaths, events, simScale, ping/pong
pc.createDataChannel('snap', { ordered: false, maxRetransmits: 0 });   // unreliable: host→joiner world snapshots
```

`snap` carries high-rate state where an old snapshot is worthless once a newer one arrives — dropping is *correct*. `rel` carries discrete facts that must not be lost. **Heartbeat** `ping/pong` on `rel` every 1s; miss 3 (>3s) → "peer lost" → one ICE-restart attempt → solo/abort.

> **Input channel note:** the joiner's input packets must not be silently dropped (a lost nuke is bad) but also must not head-of-line-block behind a stale one. Send inputs on `rel` (ordered+reliable, simplest and correct for v1); if input latency becomes a problem under loss, move *movement* to `snap` with sticky-bit ability retransmits acked by `seq`, keeping abilities reliable. Start simple.

---

## 5. Two-Player Design

### 5.1 Decided defaults (build these)

| Aspect | Decision | Rationale |
|---|---|---|
| **View** | Two browsers, two cameras, no split-screen | Each camera already follows `player`; just point it at the local player. No new render path. |
| **World** | One shared seeded city, no leash | Finite 1200×1200; splitting up is valid tactics. |
| **Friendly fire** | **OFF, non-negotiable** | Frantic twin-stick; never enable. |
| **XP & leveling** | **Separate per player** | Each keeps own `xp`/`level`/`xpNeed`, picks own upgrades from own seeded `rollUpgrades()`. |
| **Score** | **Separate per player + displayed TEAM total** | Personal flow + shared goal. |
| **Combo** | **Per player** | Personal skill-flow mechanic; sharing means one death tanks the other. |
| **Missiles / nukes** | **Separate per player** | A nuke clears the shared screen and helps both — organic generosity, no shared pool. |
| **Pickups (gems/XP/ammo)** | Magnet pull per-player; gem/XP credit to **nearest** player; ammo `Drops` to whoever walks in | "Nearest" matches solo math, avoids double-credit desync. **Drops contention rule:** see Open Decision #9. |
| **Downed / revive** | On HP→0 enter **DOWNED** (immobile, invuln-to-finish, 12s bleed-out ring); partner stands within ~3u for 2.5s to revive at 40% HP; **both downed = run ends** | Core co-op tension; cheap on the wire (1 byte/player). Timer/score freeze: see Open Decision #9. |
| **Level-up pause** | **Only the leveling player pauses** (per-player gate, §3.6 refactor), 6s auto-pick fallback | Pausing the shared sim on every ding is miserable at high combo. |
| **Partner HUD** | Partner HP bar + survivor name (corner); off-screen direction+distance arrow (red when downed); second minimap dot; "REVIVE!" banner | Keeps a separated partner legible. |

### 5.2 Daily co-op leaderboard & fairness

Co-op runs are **not comparable to solo** (two players clear faster), so they live on a **separate board** and never pollute the solo daily.

**Resolved conflict (the one real schema issue across analyses):** several drafts proposed a free-form `mode` suffix like `'easy-coop'`. That **does not type-check** — `ScoreInput.mode` is typed `Difficulty = 'easy'|'medium'|'hard'` (`modes.ts:6`), strictly whitelisted via `coerceDifficulty` (`modes.ts:9–12`), and that whitelist is a deliberate guard: *"junk in → 'easy', so a leaderboard key can never be malformed."* **Do not widen `Difficulty`** — it would leak co-op into every mode picker and preset map.

**Decision:** keep `mode: Difficulty` unchanged and add a **separate `coop: boolean` field** to `ScoreInput` (`leaderboard.ts:16–20`) and the server `scores` collection (alongside the `seed`/`daily_num` it already carries — and which `submitScore` already serializes at `leaderboard.ts:40–43`). The leaderboard key becomes `(daily_num, mode, coop)`; the co-op board is queried with `coop=true`. Additive column, not a type change.

Submit the **team result**, host-only, tagged with both handles, behind the **same** `LEADERBOARD_ENDPOINT` flag (still OFF by default). The submit path already gates on `isDaily && !runTainted` (`main.ts:1056`); a co-op run is always flagged `coop` so it's structurally incapable of reaching the solo board (mirrors the existing `runTainted` exclusion, `main.ts:131,560`).

### 5.3 OPEN DECISIONS — your call before/while building

1. **Non-blocking level-up picker vs. brief shared pause** *(biggest feel risk; also gates the §3.6 control-flow refactor)*. Default is non-blocking (only the leveling player pauses) — more work, can feel rushed. Simpler alternative: a 1.5s soft slow-mo pause for *both* on either level-up (interrupts flow but trivial, and it sidesteps most of the §3.6 refactor). **Prototype both in M3.**
2. **Co-op enemy cap.** §3.3/§3.4 start at ~1,500 — a guess. **Measure WebRTC throughput on your real connection in the *separated* worst case (M1b) before committing.**
3. **Shared vs separate XP.** Default **separate** (§5.1). A shared-pool "we're truly one team" variant (level together, alternate picks) is valid and changes the mode's identity. Flag it; don't half-build both.
4. **Revive tuning numbers.** 12s bleed-out / 2.5s channel / 40% revive HP all need playtesting.
5. **Daily co-op integrity.** Two networked humans are harder to anti-cheat than one. **Recommendation: casual-only co-op daily board, never "ranked"** — cheapest, matches the "free game, isolate don't enforce" posture.
6. **Host-leave grace.** v1 ends the run on host-leave (§3.7), and the joiner can only bank its **last-synced** (possibly seconds-stale) score. Confirm that's acceptable and you don't want host migration.
7. **Signaling scope.** Confirm the server is room-code matchmaking only (SDP/ICE relay, then peers talk directly), nothing persistent — to hold the privacy-first/self-host line.
8. **Global vs per-player hit-stop.** `hitStop` is a **module-level global** (`main.ts:1382`). If it stays global, **player B's whole screen stutters when player A lands a juicy hit across the map** (host-side slow-mo is shared) — possibly bad feel, but one `simScale` field on the wire (§3.2.1). If it goes **per-player**, B doesn't feel A's hits, but the host tracks two hit-stop timers and the joiner needs *its* player's scale — more netcode, and it must coordinate with prediction. **Pick in M3; default to global for v1 simplicity, revisit if testers hate the shared stutter.**
9. **The 2-player decisions still un-made — settle these in M3:**
   - **Drops contention.** Gems credit to nearest, but building-loot **Drops are a fixed seeded set** (`combat.ts` `Drops.load(...)`, ~line 669) — if both players can grab the same nuke drop, **who gets it?** Pick a rule: first-to-touch wins with a host-authoritative consume event (recommended — host already owns events), so there's no double-credit race.
   - **Shared death / timer freeze.** "Both downed = run ends" — does the **score/timer freeze the instant the second player goes down, or at bleed-out expiry?** Affects co-op-board fairness. Recommend freezing at the instant the second goes down (the run is decided then).
   - **Director pressure for 2 players.** `zonePressure` reads **one** player's zone (`main.ts:782`: `city.zoneAt(player.position.x, player.position.z)`) and feeds `spawnRate(t) * zonePressure` (`:783`). With two players in **different zones**, whose zone drives pressure? And two players trivially out-DPS a solo-tuned director. Decide: drive pressure from the **higher-pressure** of the two players' zones, and apply a co-op spawn-rate multiplier so the horde keeps up with doubled DPS. (This is a balance lever, not just plumbing.)
   - **Avatar/trait collision.** Can both players pick the **same survivor** (e.g. two MEDICs)? Traits live in `avatars.ts`. Recommend **allow duplicates** (simplest; no lobby lock needed) unless a trait is co-op-degenerate.
   - **Pause semantics.** Solo has a real `paused` flag (`main.ts:428`). In co-op, **can either player pause the shared sim?** Recommend **host-only pause**, surfaced to the joiner as "partner paused" — a joiner pause can't stop the host's authoritative sim anyway.

---

## 6. Codebase Integration

All hooks are wrapped `if (net)` / `if (COOP_SIGNAL_ENDPOINT)`. When the flag is null, none of this constructs.

### 6.1 Extract the player from the singleton (the load-bearing refactor — riskiest part)

`main.ts` reads the module-level `state.*` and the `player` Group directly inside **~40 closures** (`fire()`, `update()`, `deploy()`, upgrade effects, scoring). Rewriting every reference is not viable for a solo dev. The tractable approach:

- **`src/state.ts`:** `createState()` already returns a fresh object — keep it. Define `interface Player { id: 0|1; local: boolean; state: GameState; group: THREE.Group; ring; light; mesh; input: InputSnapshot; iframes; dashCd; missileRefillTimer; fireHeld; leveling: boolean }`. Move the per-player run-locals currently floating at module scope in `main.ts` (`iframes`, `dashCd`, `missileRefillTimer`, `fireHeld`, `lastCritShown`, and the now-per-player `leveling`) into `Player`.
- **`src/main.ts`:** create `players: Player[]`. Keep `const state = players[0].state` and `const player = players[0].group` as **aliases** so the read-paths that only act on the local player compile unchanged. **Only** the swarm-targeting, damage, pickup, camera, and level-up paths become loop-over-`players`.

> **⚠ The alias trick has a sharp edge — and this is why the estimate is bigger than "2–3 days."** The alias is safe for **reads of the local player**. But every *write* that should be **per-player** — `damage`, `score`, `xp`/`level`, `missiles`/`nukes`, `combo`, `iframes`, `dashCd` — must be **hunted individually across the ~40 closures**, because a write that silently goes to `players[0]` when it should target `players[1]` corrupts co-op with no compile error. The doc's own framing called this both "the riskiest part" and "2–3 days," which is inconsistent: a **write-path audit across 40 closures + the dual-target swarm + per-player damage return** realistically **dwarfs 2–3 days.** Estimate it as **~1 week of careful extraction + audit**, not a long weekend (revised in §6.6). This is Risk **R8** and the #1 source of subtle co-op bugs.

### 6.2 Thread player 2 through the sim

- **Firing/movement:** parameterize `fire()` and the per-player portions of `update()` by `p: Player`, reading `p.input` instead of the global `getMove()/getAim()/fireHeld`. Local player's `p.input` comes from `input.ts`; remote player's comes from the last decoded net packet.
- **Swarm targeting + damage:** change `swarm.update()` (`swarm.ts:237`) to both positions + nearest-of-2, and change the **return** from one scalar to **per-player damage**; update the **caller at `main.ts:1260`** to apply each player's damage to that player's HP/i-frames (§3.1).
- **Camera:** point the existing follow at `localPlayer.group`. Trivial.
- **Level-up:** the **control-flow refactor** in §3.6 — pull the input-pause out of the `main.ts:1388` loop gate, make `canAct()` (`:431`) per-player, and **update the debug stepper at `:1146`** which independently checks `!leveling`. Not a flag swap.

### 6.3 New modules

- **`src/net/signal.ts`** — WebSocket client to the signaling server (offer/answer/ICE relay only).
- **`src/net/peer.ts`** — owns `RTCPeerConnection` + the two DataChannels, role (`host`|`client`), snapshot/input pumps, heartbeat, reconnect, `simScale` propagation.
- **`src/net/codec.ts`** — binary `DataView` (en/de)code: snapshot (enemy SoA slices int16-quantized, both players' state, projectile/gem deltas, `simScale`) and input (`{seq, moveX, moveZ, aimX, aimY, buttons:bitfield}`). No JSON on the hot path.
- **`server/signal/`** — the ~80-LOC WS relay, deployed alongside the existing `server/` + `cloudflared` setup.

### 6.4 Loop wiring in `main.ts`

- **`deploy()`:** after `buildWorld()`, if `net`, the seed is already locked and shared via signaling, so **both browsers generate the identical city** from `streamFrom(CITY_SALT, seed)`. Host stays authoritative on spawns.
- **HOST `update()`:** run the full sim for both players (apply P2's decoded input before stepping P2), then emit a snapshot via the 20 Hz accumulator (with the current `simScale`) after the swarm/combat steps.
- **JOINER `update()`:** do **not** run the director/authoritative swarm. Integrate own input locally (prediction, **scaled by `simScale`**, §3.2.1) for `localPlayer.group` + own bullets; on snapshot arrival, overwrite the enemy SoA + remote player wholesale and reconcile the local player (snap if error > ~0.3u — expect a visible snap near walls, §3.2 — else lerp). Render from the interpolated buffer.
- **`render()`** is untouched except reading interpolated positions.

### 6.5 Backend tagging

In the death/submit path (`main.ts:1048–1083`), when `net`, set `coop:true` on the `ScoreInput` and submit host-only to the co-op board (§5.2). The existing `runTainted` exclusion and the `isDaily && !runTainted` gate (`:1056`) carry over unchanged.

### 6.6 Files touched + effort (solo) — revised

- **New (~600 LOC):** `src/net/{signal,peer,codec}.ts`, `server/signal/`.
- **Changed:** `state.ts` (Player struct), `main.ts` (player array + alias + **per-player write-path audit** + per-player level-up/debug-stepper + net hooks — *the bulk*), `swarm.ts` (nearest-of-2 + **per-player damage return**), `combat.ts` (per-player pickup credit + Drops consume rule), `input.ts` (export `InputSnapshot`), `hud.ts` (2nd HP/score, partner arrow, lobby/room-code UI), `config.ts` (one flag line), `leaderboard.ts` + server `scores` collection (`coop` field), `selftest.ts` (OFF + no-joiner-`srand` asserts), `director.ts`/spawn-pressure (co-op rebalance, Open #9).
- **Revised effort (honest):**
  - Player extraction + **write-path audit** ≈ **~1 week** (not 2–3 days — see §6.1).
  - Swarm dual-target + per-player damage return + caller rework + camera ≈ **2–3 days**.
  - Level-up control-flow refactor (loop gate + `canAct` + debug stepper + UI) ≈ **2 days**.
  - net/peer/codec + host/joiner loop split + **prediction/reconciliation + near-wall handling + `simScale` hit-stop** ≈ **2–2.5 weeks** (codec quantization, snapshot-rate tuning, and the two ⚠ HARD problems are where time goes).
  - HUD/lobby ≈ **2–3 days**.
  - **≈ 4–4.5 weeks for the freeplay core**, before daily + hardening.

### 6.7 The new test invariants (extend `selftest.ts`)

1. **OFF-state unchanged:** the existing `seed 777 → 8 srand()` desync gate (`:135–137`) and "zero network while OFF" asserts (`:469–482`) must still pass with the flag null — co-op adds nothing to the solo path.
2. **Joiner never calls `srand()` for gameplay:** add an assert that during a co-op *client* session the gameplay RNG cursor does not advance (wrap/spy `srand`). This is the new desync alarm and the one invariant host-authoritative depends on (§2.4).

---

## 7. Phased Roadmap

> **Demo-ability fix:** the old M1 bundled the entire player-extraction refactor **and** host→joiner streaming into one "XL" with a "renders dumb" joiner — which at real latency with *no* prediction (prediction is M2) would be a 20 Hz slideshow of stuttering enemies and a teleporting avatar: **not a satisfying or judgeable demo.** M1 is split so each half is independently shippable.

| M | What ships | Effort | Key risk | Demo-able outcome |
|---|---|---|---|---|
| **M0** | `COOP_SIGNAL_ENDPOINT` flag in `config.ts`; ~80-LOC WS signaling server on the Mac Mini behind the Cloudflare Tunnel; `RTCPeerConnection` + `rel`/`snap` channels; SDP/ICE exchange; room codes + `?co=` parse. No gameplay. | **M** | Signaling lifecycle/rooms; STUN reachability | Two browsers connect, exchange ping/pong over a DataChannel, show "Connected" + RTT. **Genuinely demo-able, well-scoped.** |
| **M1a** | **Player extraction + alias + write-path audit** (§6.1) and **dual-target swarm + per-player damage** (§3.1), proven **locally/solo, no net.** Run 2 keyboard-mapped players in one tab if needed. | **L** | Singleton write-path audit (**R8**) | Two avatars move/shoot/take-damage independently in one shared city — **with zero netcode.** De-risks the load-bearing refactor in isolation. |
| **M1b** | Host-authoritative streaming on top of M1a: joiner sends input only, host streams snapshots (AOI enemy slice, both players, gems, score). **MP enemy cap + adaptive rate/cap.** Joiner renders from snapshots (no prediction yet). | **L** | Snapshot bandwidth, esp. **separated** (**R1**) | Both players in one shared city across two browsers; joiner sees the real swarm. **Measure real bandwidth in the *separated* worst case → set the cap + fallbacks.** |
| **M2** | Client prediction + reconciliation (own movement only; replay buffered inputs); entity interpolation (~100 ms) for enemies/remote player; int16-quantized delta snapshots; projectile extrapolation; **`simScale` hit-stop propagation (§3.2.1)** and **near-wall snap handling (§3.2).** | **XL** | Variable-timestep & collision vs prediction (**R5**); hit-stop pop | Joiner movement feels instant at 80–150 ms simulated latency; no open-space rubber-banding; hits don't pop the joiner; near-wall snap is acceptable (or upgraded to host-resolved positions). |
| **M3** | Co-op UX: downed/revive; per-player level-up (**prototype both options, Open #1**, incl. the §3.6 refactor); separate progression; partner HUD; **settle Open #8 (hit-stop) + #9 (Drops/timer/director/avatar/pause).** | **L** | Level-up control-flow refactor (**R4-feel/#4**); separation vs camera/AOI (**R2**) | Partner panel live; one player downed and revived; both level independently without freezing each other. |
| **M4** | Daily/challenge co-op: both `setSeed(dailySeed)`; reject on daily-number mismatch; host-only team submit with the new `coop` field to a separate board. Reuse `LEADERBOARD_ENDPOINT` plumbing. | **M** | 2-player submission fairness (**R7**) | Two players run today's daily together; combined run posts to the co-op board, never the solo one. |
| **M5** | Hardening: coturn TURN relay for symmetric NAT; reconnect/ICE-restart; host-leave → clean "host left" screen (+ joiner's last-synced save); enemy-cap auto-tune by measured bandwidth; idle/abuse timeouts. | **L** | TURN traversal + host-leave correctness (**R4, R6**) | Connect across two cellular networks; kill the host tab → joiner gets a clean end screen with its last-synced score, not a freeze. |

**Realistic MVP = M0–M3** (freeplay co-op behind the flag). Ship that, make it fun, *then* add M4 daily and M5 hardening.

---

## 8. Risk Register

| ID | Risk | Mitigation |
|---|---|---|
| **R1** | **Swarm-sync bandwidth (hardest).** Worst case is **players separated**: AOI union covers ~full cap in two disjoint clusters, chasing enemies produce **large per-tick deltas** (delta-encoding helps little), and newly-AOI'd enemies need **full baselines** — well above the optimistic headline (§3.3). | Never send full SoA. Int16-quantize, AOI-cull to the *union*, delta vs last-acked, 20 Hz. **Commit concrete fallbacks, not just M5 auto-tune:** drop to 10 Hz under pressure, **shrink the MP cap mid-run**, tighten cull radius. **Set the cap from the measured *separated* worst case in M1b.** Determinism fixes spawn type/timing, **not positions** — positions must stream. |
| **R2** | **Player separation** breaks single-camera framing and means per-player cull sets. | No leash; each camera follows its own player; union the two cull radii (and accept that union is the bandwidth driver, R1); off-screen arrow + minimap dot keep the partner legible. |
| **R3** | **Host latency advantage** — host sims at 0 latency, joiner always reconciles. | Accept it (host-authoritative is inherently asymmetric); soften with input-delay buffering and lag-compensated hit registration for the joiner's bullets. Lockstep is the symmetric phase-2 answer. |
| **R4** | **NAT/TURN traversal** — P2P fails on symmetric/CGNAT. | STUN in M0; self-hosted **coturn** on the Mac Mini in M5 behind the `ICE_SERVERS` flag. Budget the small relay egress. |
| **R5** | **Variable timestep + collision vs prediction** — replayed inputs under variable `simDt` (incl. hit-stop ×0.18, `main.ts:1385`) don't reproduce host results, **especially near walls** where the non-linear `BlockGrid` slide diverges → a discontinuity, not a smooth offset. | Predict **only the joiner's own kinematics**; interpolate everything else; never predict the swarm. **In open space, error stays sub-0.3u and lerps invisibly; near geometry, accept a visible snap** — or (decided in M2 from footage) have the host stamp each `seq` with its **resolved post-step position** so the joiner reconciles against the real path. **Propagate `simScale`** so hit-stop doesn't pop the joiner (§3.2.1). This is reconciliation, not rollback. Fixed-step is the phase-2 prerequisite (§2.3); **do not take it on here.** |
| **R6** | **Host leaving mid-run** kills the joiner's world, and the joiner has **no independent score tally** (display-only). | Detect DataChannel close → clean "host left — run ended" screen; joiner banks **the last host-acked total only** (possibly seconds stale), surfaced honestly as "last synced." Host-migration flagged, not promised. |
| **R7** | **Cheat surface widens** — a hacked host can fabricate a co-op run. | Keep the server's accept-and-observe posture; flag every co-op run `coop` onto a *separate* board so it can never pollute solo daily; apply existing per-player kills/sec + score/min heuristics. Don't build real anti-cheat — isolation beats enforcement. |
| **R8** | **Singleton-extraction regressions** — `state`/`player` read in ~40 closures; a missed **per-player write** (damage/score/xp/missiles/combo/iframes) corrupts co-op **silently** (no compile error). | The alias trick keeps it compiling but **only protects reads.** Audit **every write** for "should this be per-player?" Budget it as ~1 week, not 2–3 days (§6.1). The OFF-state desync gate is your solo-regression alarm. |
| **R9** | **Global hit-stop shares stutter** — `hitStop` is module-global (`main.ts:1382`), so on the host, player A's big hit slows player B's whole screen. | One `simScale` field already covers the wire (§3.2.1). Default to global for v1 simplicity; if testers hate the shared stutter, go per-player (more netcode — Open #8). Either way the joiner needs the scale to predict correctly. |

---

## 9. Effort Summary & Immediate Next Step

**Total:** 1 XL + 4 L + 2 M ≈ **11–17 weeks of focused solo work**, with **M1a→M2 the bulk** (the load-bearing refactor + real netcode, not a weekend). The two ⚠ HARD problems inside v1 — **near-wall prediction (§3.2)** and **hit-stop propagation (§3.2.1)** — plus **separated-case bandwidth (§3.3)** and the **level-up control-flow refactor (§3.6)** are the time sinks; budget them explicitly. Cut scope honestly: skip host-migration, keep the enemy cap conservative and adaptive, treat lockstep as a separate future project.

**Immediate next step — M0, this week, in order:**
1. Add the single `COOP_SIGNAL_ENDPOINT` line to `src/config.ts` (it stays null; solo untouched; run `selftest.ts` to confirm the OFF-state gate still passes).
2. Write the ~80-LOC WebSocket signaling relay in `server/signal/`; deploy it next to PocketBase behind the existing Cloudflare Tunnel.
3. Build `src/net/{signal,peer}.ts` enough to open an `RTCPeerConnection` between two tabs via a room code, parse `?co=` at boot (alongside the `?seed=` parse at `main.ts:160`), and exchange ping/pong over the `rel` channel.
4. **Ship the M0 "Connected + RTT" demo.** That proves the transport and self-host story end-to-end before a single line of the gameplay refactor — the cheapest possible way to de-risk the whole project.

**The decisions to make before M3:** Open Decision **#1** (non-blocking level-up vs. shared soft-pause — it also determines how much of the §3.6 refactor you must do), **#8** (global vs per-player hit-stop), and the **#9** cluster (Drops contention, timer freeze, director rebalance, avatar duplicates, pause semantics). Everything else can be tuned in flight.

---

### Files grounding this doc (all verified against the codebase)
- `src/config.ts:9–20` — flag helpers (`env` prefixes `VITE_`; `ovr` is DEV-only via `import.meta.env.DEV`) + the three OFF-by-default backend flags the co-op flag mirrors.
- `src/rng.ts:5–14` — `setSeed`/`getSeed`/`srand`/`streamFrom`/`CITY_SALT`; the seeded spine and the "same-seed MP without networking the horde" contract.
- `src/main.ts:1362–1400` — the variable-timestep loop (`dt = Math.min(0.05, rawDt)` at 1365; hit-stop `simDt = dt*0.18` at 1383–1385; the `started && !over && !leveling && !paused` gate at 1388).
- `src/main.ts:160` — `?seed=` challenge parse (`params.has('seed')` → `setSeed`); the `?co=` extension point.
- `src/main.ts:428–431` — module-level `leveling`/`paused` + `canAct()`; `:1146` — the **debug stepper that also checks `!leveling`** (must be updated for per-player level-up).
- `src/main.ts:131,560` — `runTainted` (cheat → leaderboard exclusion) to mirror for co-op.
- `src/main.ts:782–783` — `zonePressure` from **one** player's zone × `spawnRate(t)` (the co-op director-rebalance question, Open #9).
- `src/main.ts:1048–1083` — death/submit path; `:1056` `isDaily && !runTainted` gate; for the `coop`-tagged submission.
- `src/main.ts:1260` — the **sole** `swarm.update(...)` caller consuming the scalar `damage` (must become per-player).
- `src/swarm.ts:66` — `PLAYER_RADIUS = 0.8` (shared move-resolve). `:237` — `update(dt, time, playerX, playerZ, grid, blockGrid)` single-target by value (→ dual-target). `:359` — `return playerDamage` single scalar (→ per-player).
- `src/modes.ts:6,9–12` — `Difficulty` union + `coerceDifficulty` whitelist (why co-op uses a separate `coop` field, **not** a widened `mode`).
- `src/leaderboard.ts:16–20,40–43` — `ScoreInput` shape + `submitScore` serialization to extend with `coop`.
- `src/combat.ts:~669` — `Drops.load(...)` fixed seeded loot set (the Drops-contention question, Open #9).
- `src/selftest.ts:135–137,469–482` — the `seed 777 → 8 srand()` desync gate + "zero network while OFF" asserts that guard the OFF-state invariant.
- `server/` + `cloudflared` — PocketBase + Cloudflare Tunnel deployment pattern the signaling server reuses.
