import { defineConfig } from 'vitest/config';

// Held to the deterministic core's bar (>= 90%): this is the contract a server enforces on
// untrusted input, so every branch of the validator is checked.
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
