import { defineConfig } from 'vite';

// vite.perf.config.ts — the browser perf harness's OWN build (M2-S4b, PLAN step 22).
//
// Deliberately NOT a second entry bolted onto the production `vite.config.ts`. This
// config's `build.rollupOptions.input` points at `perf/index.html` — an entry the
// production `index.html` never references — and its output lands in `dist-perf/`, a
// directory neither `apps/web`'s `preview` script (which serves `dist/`) nor
// `scripts/size-limit.mjs` (which measures `dist/`) ever looks at. Because there is no
// path from `vite.config.ts`'s module graph to this one, the perf build is
// STRUCTURALLY incapable of entering the production artifact — not merely expected to
// stay out of it. Bolting a second entry onto the shared config instead would pull the
// 40×40 stress JSON (`@wynding/content/stress`, deliberately absent from the bundled
// registry) into the shipped graph, contradicting that module's own "never reaches the
// client build" guarantee and polluting ADR 0005's < 3 MB initial-load budget.
//
// RECORDED-ONLY (PLAN "Out of scope": "Any fps/memory/input-latency CI gate —
// recorded-only this story"). This config and everything it builds exist to produce
// numbers for a spike document (Phase 6), never to gate a merge — do not wire
// `perf:e2e` into CI.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist-perf',
    // M2-S10 P8 (ADR 0005 ruling 7): sourcemaps so the frame-time diagnosis's sampled
    // stacks resolve to names in the minified perf bundle. PERF-ONLY, NEVER PRODUCTION —
    // this config's module graph is unreachable from `vite.config.ts` (see header), so
    // this flag is structurally incapable of shipping a production sourcemap.
    sourcemap: true,
    rollupOptions: {
      input: 'perf/index.html',
    },
  },
});
