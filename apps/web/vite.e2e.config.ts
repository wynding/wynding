import { defineConfig } from 'vite';
import { gameVersionDefine, hostedDefine } from './build-config';

// vite.e2e.config.ts — the e2e harnesses' OWN build (#158), on the perf harness's pattern
// (`vite.perf.config.ts`): a separate config, separate entries (`e2e-harness/survey.html`; since
// #181 H2 `e2e-harness/results.html`, which plays a scripted run to its results; and
// `e2e-harness/turned-heads.html`, #181's renderer-only page for turned heads) and a separate
// output (`dist-e2e`). Nothing in `vite.config.ts`'s module graph reaches a harness, so their
// fake survey transports and the scene hook are structurally incapable of entering the
// shipped artifact.
//
// That structure is also CHECKED, not only argued: `scripts/check-build-layering.mjs` builds
// this config in CI's e2e job and uses `dist-e2e` as a positive control — each harness entry
// module's markers must be found here, emitted by that module, before the check asserts they
// are absent from `dist` and `dist-host`. It names this config's outDir and the survey page in
// its `CONTROLS` and `ENTRY` tables and deletes the outDir before building, so moving either
// here without the other there fails the check instead of letting it read a stale build. A
// page dropped from `input` fails it too: its module's markers are then missing from here.
//
// `gameVersion` is PINNED rather than read from git: the harness must offer the survey on
// a developer's dirty worktree too, where the real build resolves `unknown` and offers
// nothing. The value is a fixed, obviously-fake full SHA.
export const E2E_GAME_VERSION = 'e2e0000000000000000000000000000000000001';

export default defineConfig({
  define: {
    ...hostedDefine(false),
    ...gameVersionDefine(E2E_GAME_VERSION),
  },
  build: {
    target: 'es2022',
    outDir: 'dist-e2e',
    rollupOptions: {
      input: [
        'e2e-harness/survey.html',
        'e2e-harness/results.html',
        'e2e-harness/turned-heads.html',
      ],
    },
  },
});
