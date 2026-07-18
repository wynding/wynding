import { defineConfig } from 'vitest/config';

// Coverage gate for the deterministic core (engine / sim / replay): >= 90%
// lines+branches. Render and the apps are held to a lighter bar and lean on
// e2e tests instead — correctness here is machine-checkable, so we check it.
export default defineConfig({
  test: {
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
