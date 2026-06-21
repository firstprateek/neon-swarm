# NEON SWARM

A 3D swarm-survivor game (Vampire Survivors style) built for raw browser performance — pick a post-apocalyptic survivor, hold off the zombie horde, and beat your friends on the same seed. Wrapped in a "Hazard Deck" UI: chamfered industrial panels, stencil headers, and amber hazard trim over the cyan neon.

### ▶ Play: https://firstprateek.github.io/neon-swarm/

**Stack:** TypeScript · Three.js `WebGPURenderer` (auto-falls back to WebGL2) · Vite

Pushing to `main` auto-deploys to GitHub Pages via `.github/workflows/deploy.yml`.

## Run

```sh
npm install
npm run dev
```

## How to play

Pick **☀ Daily Challenge** or **▶ Free Play**, choose a survivor, then survive.

| Input | Action |
| --- | --- |
| `WASD` / arrows | **Move** |
| Mouse | **Aim** (in manual control modes) — the survivor faces the cursor; **left-click** holds fire, **right-click** launches a missile |
| `Space` | **Fire** the gun (only needed when auto-fire is off) |
| `E` | **Missile** — AoE rocket (limited, refills over time) |
| `Q` | **Nuke** — clears the screen (very limited) |
| `Shift` | **Dash** — short burst with i-frames (cooldown) |
| `Esc` | Pause / settings |
| `M` | Mute |
| mouse wheel / `+` `-` | **Zoom** the camera out (more field) or in (more survivor) — desktop |

All gameplay keys are **remappable** in Settings. Collect green XP gems, pick an upgrade on each level-up, and push your score. Bigger enemies are worth more; chaining kills builds a score **combo** multiplier. Bosses arrive on a timer and drop ammo restocks.

**On mobile/touch** (auto-detected): a floating analog joystick on the bottom-right moves you (push further = faster), and ability buttons on the bottom-left fire **nuke / missile / dash** (plus a **FIRE** button when auto-fire is off). A top-right ⚙ opens pause/settings and `+`/`−` buttons zoom. Menus stack vertically and tap-outside-to-close. Add `?touch` to force the on-screen controls on a desktop browser.

## Control modes

Pick how much the game helps you aim and fire — set a preset (or flip the toggles individually) in **Settings**:

| Mode | Auto-fire | Gun aim | Missile |
| --- | --- | --- | --- |
| **Easy** | on | auto-locks nearest | homes |
| **Medium** | on | aims at your mouse (the body faces the cursor) | fires toward the cursor |
| **Hard** | off (hold Fire / left-click) | aims at your mouse | fires toward the cursor |

In the **manual** modes (Medium / Hard) aiming is decoupled from movement — you walk with `WASD` and aim independently with the mouse (true twin-stick), instead of only firing where you walk. A neon reticle replaces the cursor, **left-click** fires a missile and **right-click** the nuke. On mobile, manual mode shows a **second joystick**: move with the left thumb, aim with the right thumb (holding it also fires), with the ability buttons centered between them.

In **Free Play** you can change controls anytime. In a **Daily Challenge** you choose the mode at the start and it's locked for that run — and **each mode has its own leaderboard** (an Easy score isn't compared against a Hard one).

## Game modes & the share loop

- **☀ Daily Challenge** — one global seed per UTC day (everyone on Earth plays the *identical* run), with a local per-day personal best **per control mode**. Score is skill, not luck.
- **▶ Free Play** — a fresh random run every time.
- **Challenge a friend** — the game-over "brag card" copies a `?seed=…` link. Opening it drops your friend into the **byte-identical** run to beat your score. The whole sim is deterministic (seeded PRNG), so the same seed + same inputs always replays exactly.

## How it stays fast

- **One draw call per entity class** — all enemies (up to 20,000), bullets, gems, and particles render as `InstancedMesh`es; instance matrices are written directly into the underlying `Float32Array`.
- **Structure-of-arrays simulation** — enemy state lives in packed typed arrays (no per-enemy objects, no GC pressure); dead enemies are swap-removed so hot loops run over dense ranges.
- **Spatial hash grid** — rebuilt each frame with a counting sort (zero allocations), used for enemy separation, bullet collision, and contact damage.
- **Adaptive quality governor** — holds the target frame rate (default 120 FPS) by flexing pixel-ratio and bloom tiers under load.
- **WebGPU post-processing** — bloom via Three.js TSL nodes, with graceful fallback to plain rendering.
- **GPU-only atmosphere** — the post-apocalyptic mood (sickly color grade folded into the bloom pass, gradient sky, fog, a procedural cracked-earth ground shader, drifting ash/embers) is fragment-shader + instancing work with **no extra lights or render passes**, and tiers down with the quality governor so it never costs the frame-rate target.
- **Deterministic core** — gameplay randomness runs through a seeded `mulberry32` PRNG, so runs are reproducible (the foundation for daily seeds, shareable challenges, and future server-side anti-cheat). Cosmetic randomness (shake, particles) stays unseeded.

## Flags & debug

URL params (append e.g. `?webgl`):

- `?seed=N` — replay the byte-identical run for seed `N` (challenge links use this)
- `?webgl` — force the WebGL2 backend (escape hatch for broken WebGPU presentation)
- `?webgpu` — trust WebGPU and skip the presentation watchdog probe
- `?nobloom` — disable bloom post-processing
- `?fps=N` — set the governor's target frame rate (default 120)
- `?quality=N` — pin a quality tier and disable the adaptive governor (`-1` = auto)
- `?mute` — start muted
- `?touch` — force-enable the on-screen touch controls (joystick + ability buttons) on a desktop browser
- `?mode=easy|medium|hard` — on a challenge link, replays the same control mode the sharer used

Other:

- **Cheat codes** — just type the word during a run: `god`, `guns`, `tank`, `boss`, `horde`, `rich`, `levelup`.
- `window.__spawnTest(n)` in the console — benchmark hook: spawns `n` enemies around the player with effectively infinite HP (a stress test, not a fair fight). 15,000 enemies hold 120 FPS on an Apple Silicon Mac.
- **`/test.html`** — in-browser self-test suite (207 tests) importing the real modules; results land on `window.__testResults`.

## Roadmap

The plan is a Wordle-style viral loop with global leaderboards, built in phases:

- ✅ **Phase 0 — Determinism.** Seeded sim, proven byte-identical replays.
- ✅ **Phase 1 — Share card + challenge links.** Zero-backend brag card and `?seed` "beat my run" links.
- ✅ **Phase 2a — Daily Challenge.** One global seed/day with a local best board.
- 🛠️ **Phase 2b — Global leaderboard + telemetry (code ready, flag OFF).** The client SDK (`src/telemetry.ts`, `src/leaderboard.ts`) and the self-hosted server ([`server/`](server/) — one PocketBase on a Mac Mini behind a Cloudflare Tunnel, statistical anti-cheat, cookieless salted-hash anonymity) are **built and feature-flagged off** — every endpoint is `null`, so the live game is unchanged (proven by tests: zero network while off). Flip one config to go live; the game-over screen then shows your **global rank** + streak + rival. Design: [`docs/BACKEND.md`](docs/BACKEND.md); go-live steps: [`server/docs/go-live-checklist.md`](server/docs/go-live-checklist.md).
- ⏳ **Phase 3 — Last Swarm Standing.** Real-time multiplayer (only a light player ribbon is networked; each client simulates its own horde from the shared seed).

## Ideas for later

- Move enemy steering onto the GPU with TSL compute shaders (storage buffers + instanced rendering straight from GPU memory)
- More weapons (orbiting blades, chain lightning), boss-drop unique weapons, richer audio
- Ghost races (replay a friend's recorded inputs alongside your run)
