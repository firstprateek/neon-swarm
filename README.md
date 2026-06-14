# NEON SWARM

A 3D swarm-survivor game (Vampire Survivors style) built for raw browser performance.

### ▶ Play: https://firstprateek.github.io/neon-swarm/

**Stack:** TypeScript · Three.js `WebGPURenderer` (auto-falls back to WebGL2) · Vite

Pushing to `main` auto-deploys to GitHub Pages via `.github/workflows/deploy.yml`.

## Run

```sh
npm install
npm run dev
```

WASD / arrows to move. Weapons auto-fire at the nearest enemy. Collect green XP gems, pick upgrades on level-up, survive the hordes.

## How it stays fast

- **One draw call per entity class** — all enemies (up to 20,000), bullets, gems, and particles render as `InstancedMesh`es; instance matrices are written directly into the underlying `Float32Array`.
- **Structure-of-arrays simulation** — enemy state lives in packed typed arrays (no per-enemy objects, no GC pressure); dead enemies are swap-removed so hot loops run over dense ranges.
- **Spatial hash grid** — rebuilt each frame with a counting sort (zero allocations), used for enemy separation, bullet collision, and contact damage.
- **WebGPU post-processing** — bloom via Three.js TSL nodes, with graceful fallback to plain rendering.

## Flags & debug

- `?webgl` — force the WebGL2 backend (escape hatch for environments with broken WebGPU presentation)
- `window.__spawnTest(n)` in the console — benchmark hook: spawns `n` enemies around the player and grants effectively infinite HP (it's a stress test, not a fair fight). 15,000 enemies hold 120 FPS on an Apple Silicon Mac.

## Ideas for later

- Move enemy steering onto the GPU with TSL compute shaders (storage buffers + instanced rendering straight from GPU memory)
- More weapons (orbiting blades, chain lightning), boss waves, audio
