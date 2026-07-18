import { defineConfig } from 'vite';

// The web app is a thin PWA shell. Workspace packages resolve to their TS source
// (see each package's `exports`), so Vite transpiles them directly — no prebuild.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
