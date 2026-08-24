import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

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
// numbers for a spike document (Phase 6) — do not wire
// `perf:e2e` into CI.
//
// ONE CI CONSUMER EXISTS, and it is not a gate on these numbers. Since #129,
// `scripts/check-build-layering.mjs` BUILDS this config in the e2e job and uses `dist-perf`
// as its positive control: because these two entry points deliberately reach
// `@wynding/perf`, `@wynding/content/stress` and `./catalog`, they are where the check
// proves its markers still match something before asserting they are absent from `dist`.
// Nothing here is measured or asserted against a budget by that check — but this file is
// no longer "never" part of a merge gate, and an earlier version of this header said it was.

/**
 * Emit `perf/root.html` as the packaged output's ROOT `index.html` (#148).
 *
 * A Capacitor WebView loads the asset root, and `dist-perf` had none: Vite emits an HTML
 * input beside its source path, so `perf/index.html` lands at `dist-perf/perf/index.html`
 * and a packaged perf build booted to a 404 and a white screen.
 *
 * Emitted as an ASSET rather than added as a third rollup input, and the distinction is
 * the point twice over. An input would land at `dist-perf/perf/root.html` — still not the
 * root — and it would give the launcher a module graph of its own. It has none: it is
 * static markup with two relative links, so it cannot pull either scene's bundle (or
 * anything else) into the other's graph, and this file's structural guarantee stays exactly
 * as strong as it was.
 */
function perfRootEntry(): Plugin {
  return {
    name: 'wynding-perf-root-entry',
    generateBundle(_options, bundle) {
      const source = readFileSync(fileURLToPath(new URL('./perf/root.html', import.meta.url)));
      if ('index.html' in bundle) {
        // Cannot happen today (neither input is named `index.html` at the root), and it must
        // fail loudly rather than silently overwrite a real entry if it ever can.
        throw new Error('perf root entry would overwrite an emitted index.html');
      }
      this.emitFile({ type: 'asset', fileName: 'index.html', source });
    },
  };
}

export default defineConfig({
  plugins: [perfRootEntry()],
  build: {
    target: 'es2022',
    outDir: 'dist-perf',
    // M2-S10 P8 (ADR 0005 ruling 7): sourcemaps so the frame-time diagnosis's sampled
    // stacks resolve to names in the minified perf bundle. PERF-ONLY, NEVER PRODUCTION —
    // this config's module graph is unreachable from `vite.config.ts` (see header), so
    // this flag is structurally incapable of shipping a production sourcemap.
    sourcemap: true,
    rollupOptions: {
      // M2-S11 P7: TWO perf pages, one per scene. Both are inputs of THIS config only —
      // the production `vite.config.ts` still references neither, so adding the catalog
      // page keeps the structural guarantee in this file's header intact (no path from
      // the production graph to either scene's bundle). Two entries rather than one page
      // switching on a query parameter so a run of one scene never even downloads the
      // other's ruleset JSON.
      input: ['perf/index.html', 'perf/catalog.html'],
    },
  },
});
