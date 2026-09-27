import { defineConfig } from 'vite';
import { gameVersionDefine, hostedDefine } from './build-config';

// vite.e2e.config.ts — the e2e survey harness's OWN build (#158), on the perf harness's
// pattern (`vite.perf.config.ts`): a separate config, a separate entry
// (`e2e-harness/survey.html`) and a separate output (`dist-e2e`). Nothing in
// `vite.config.ts`'s module graph reaches the harness, so its fake survey transport is
// structurally incapable of entering the shipped artifact.
//
// That structure is also CHECKED, not only argued: `scripts/check-build-layering.mjs` builds
// this config in CI's e2e job and uses `dist-e2e` as a positive control — the harness's
// markers must be found here, emitted by `e2e-harness/survey-entry.ts`, before the check
// asserts they are absent from `dist` and `dist-host`. It names this config's outDir and input
// in its `CONTROLS` and `ENTRY` tables and deletes the outDir before building, so moving
// either here without the other there fails the check instead of letting it read a stale
// build.
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
      input: ['e2e-harness/survey.html'],
    },
  },
});
