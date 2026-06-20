# NEON SWARM

A 3D swarm-survivor game (Vampire Survivors style) built for raw browser performance — pick a post-apocalyptic survivor, hold off the zombie horde, and beat your friends on the same seed.

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
| `WASD` / arrows | Move (weapons auto-fire at the nearest enemy) |
| `Space` | **Missile** — homing AoE rocket (limited, refills over time) |
| `Q` | **Nuke** — clears the screen (very limited) |
| `Shift` | **Dash** — short burst with i-frames (cooldown) |
| `Esc` | Pause / settings (quality, audio) |
| `M` | Mute |

Collect green XP gems, pick an upgrade on each level-up, and push your score. Bigger enemies are worth more; chaining kills builds a score **combo** multiplier. Bosses arrive on a timer and drop ammo restocks.

## Game modes & the share loop

- **☀ Daily Challenge** — one global seed per UTC day (everyone on Earth plays the *identical* run), with a local per-day personal best. Score is skill, not luck.
- **▶ Free Play** — a fresh random run every time.
- **Challenge a friend** — the game-over "brag card" copies a `?seed=…` link. Opening it drops your friend into the **byte-identical** run to beat your score. The whole sim is deterministic (seeded PRNG), so the same seed + same inputs always replays exactly.

## How it stays fast

- **One draw call per entity class** — all enemies (up to 20,000), bullets, gems, and particles render as `InstancedMesh`es; instance matrices are written directly into the underlying `Float32Array`.
- **Structure-of-arrays simulation** — enemy state lives in packed typed arrays (no per-enemy objects, no GC pressure); dead enemies are swap-removed so hot loops run over dense ranges.
- **Spatial hash grid** — rebuilt each frame with a counting sort (zero allocations), used for enemy separation, bullet collision, and contact damage.
- **Adaptive quality governor** — holds the target frame rate (default 120 FPS) by flexing pixel-ratio and bloom tiers under load.
- **WebGPU post-processing** — bloom via Three.js TSL nodes, with graceful fallback to plain rendering.
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

Other:

- **Cheat codes** — just type the word during a run: `god`, `guns`, `tank`, `boss`, `horde`, `rich`, `levelup`.
- `window.__spawnTest(n)` in the console — benchmark hook: spawns `n` enemies around the player with effectively infinite HP (a stress test, not a fair fight). 15,000 enemies hold 120 FPS on an Apple Silicon Mac.
- **`/test.html`** — in-browser self-test suite (143 tests) importing the real modules; results land on `window.__testResults`.

## Roadmap

The plan is a Wordle-style viral loop with global leaderboards, built in phases:

- ✅ **Phase 0 — Determinism.** Seeded sim, proven byte-identical replays.
- ✅ **Phase 1 — Share card + challenge links.** Zero-backend brag card and `?seed` "beat my run" links.
- ✅ **Phase 2a — Daily Challenge.** One global seed/day with a local best board.
- ⏳ **Phase 2b — Global leaderboard + telemetry.** Self-hosted backend (PocketBase on a Mac Mini behind a Cloudflare Tunnel) with server-side re-simulation anti-cheat and privacy-first, cookieless analytics.
- ⏳ **Phase 3 — Last Swarm Standing.** Real-time multiplayer (only a light player ribbon is networked; each client simulates its own horde from the shared seed).

## Ideas for later

- Move enemy steering onto the GPU with TSL compute shaders (storage buffers + instanced rendering straight from GPU memory)
- More weapons (orbiting blades, chain lightning), boss-drop unique weapons, richer audio
- Ghost races (replay a friend's recorded inputs alongside your run)
