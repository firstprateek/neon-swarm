import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// build tag for telemetry (only ever transmitted when the backend is flagged on)
let gitSha = 'dev';
try { gitSha = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* gitless context */ }

// GitHub Pages serves this project repo under /neon-swarm/.
// Dev server stays at / so local URLs and the preview tools are unaffected.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/neon-swarm/' : '/',
  build: { target: 'esnext' },
  esbuild: { target: 'esnext' },
  define: { __VER__: JSON.stringify(gitSha) },
}));
