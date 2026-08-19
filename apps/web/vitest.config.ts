import { defineConfig } from 'vitest/config';

// Story 6 coverage gate for the app/orchestration layer. jsdom so the DOM overlay +
// input modules are exercised for real. Every source module is covered at the 90%
// branch bar — the controller, settings, keymap, i18n, the DOM overlay/input, and the
// `main` bootstrap (tested with the Phaser scene + rAF mocked). The only product source
// excluded in the whole render/app surface is the Phaser scene
// (packages/render/src/scene.ts) and `boot-entry.ts` (see below). `install-fakes.ts` and
// `wakelock-fakes.ts` are TEST-ONLY helpers (shared fakes that two `*.test.ts` suites each
// import) — like the test files themselves, they are exercised only by tests, so they are
// excluded rather than held to the branch bar. The generated catalog is data (fully covered on
// import); the Playwright e2e lives under `e2e/` (not `src`) and runs separately.
//
// `boot-entry.ts` (QC: the side-effect boot moved out of `main.ts`) is a genuinely untestable side-effect-only module
// — its entire body is "call `boot(document)` at import time", which is exactly the
// shape `main.ts`'s old inline auto-boot used to have BEFORE it was guarded out of the
// test runner (and therefore never covered either). Moving it to its own file made that
// pre-existing gap visible instead of changing it; excluded here for the same reason
// `scene.ts` is — there's no seam left to inject, `index.html`'s `<script>` tag is the
// only real caller, and that path is proven by the Playwright e2e suite, not Vitest.
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/install-fakes.ts',
        'src/wakelock-fakes.ts',
        'src/boot-entry.ts',
      ],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
