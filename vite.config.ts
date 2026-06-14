import { defineConfig } from 'vite';

// GitHub Pages serves this project repo under /neon-swarm/.
// Dev server stays at / so local URLs and the preview tools are unaffected.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/neon-swarm/' : '/',
  build: { target: 'esnext' },
  esbuild: { target: 'esnext' },
}));
