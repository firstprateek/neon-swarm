import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// build tag for telemetry (only ever transmitted when the backend is flagged on)
let gitSha = 'dev';
try { gitSha = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* gitless context */ }

// GitHub Pages serves this project repo under /neon-swarm/.
// Dev server stays at / so local URLs and the preview tools are unaffected.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/neon-swarm/' : '/',
  build: {
    target: 'esnext',
    // three (webgpu build + TSL + addons) dominates the bundle; splitting it into
    // its own chunk lets GitHub Pages visitors keep it cached across game updates.
    // The vendor chunk is still ~700 kB minified, so raise the warn limit for it.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three';
        },
      },
    },
  },
  esbuild: { target: 'esnext' },
  define: { __VER__: JSON.stringify(gitSha) },
}));
