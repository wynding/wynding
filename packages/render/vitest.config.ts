import { defineConfig } from 'vitest/config';

// Story 6 coverage gate for the presentation layer. Every module is covered at the
// 90% branch bar (the same bar as the deterministic core) EXCEPT the Phaser scene glue
// (`scene.ts`), which is WebGL and not meaningfully unit-testable under jsdom — it is a
// dumb consumer of the pure modules (projection, view-model, interpolate, palette) and
// is exercised by the app's Playwright + axe e2e smoke instead. `types.ts` is pure
// interface declarations (no executable code) and the barrel is covered by an import
// test; only the scene file is excluded.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/scene.ts'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
