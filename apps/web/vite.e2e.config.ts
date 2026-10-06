import { defineConfig } from 'vite';
import { gameVersionDefine, hostedDefine } from './build-config';

// vite.e2e.config.ts — the e2e harnesses' OWN build (#158), on the perf harness's pattern
// (`vite.perf.config.ts`): a separate config, separate entries (`e2e-harness/survey.html`,
// and `e2e-harness/turned-heads.html`, #181's renderer-only page for turned heads) and a
// separate output (`dist-e2e`). Nothing in `vite.config.ts`'s module graph reaches a harness,
// so the survey's fake transport and the scene hook are structurally incapable of entering
// the shipped artifact.
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
      input: ['e2e-harness/survey.html', 'e2e-harness/turned-heads.html'],
    },
  },
});
