import { defineConfig } from 'vitest/config';

// Coverage gate for the deterministic core (engine / sim / replay) and — new in
// M2-S1 — content, now that it's a runtime loader/validation seam (the sanctioned
// content → sim edge): >= 90% lines+branches+functions+statements.
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
