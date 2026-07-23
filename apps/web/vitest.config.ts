import { defineConfig } from 'vitest/config';

// Story 6 coverage gate for the app/orchestration layer. jsdom so the DOM overlay +
// input modules are exercised for real. Every source module is covered at the 90%
// branch bar — the controller, settings, keymap, i18n, the DOM overlay/input, and the
// `main` bootstrap (tested with the Phaser scene + rAF mocked). Nothing in apps/web is
// coverage-excluded: the only excluded file in the whole render/app surface is the
// Phaser scene (packages/render/src/scene.ts). The generated catalog is data (fully
// covered on import); the Playwright e2e lives under `e2e/` (not `src`) and runs
// separately.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
