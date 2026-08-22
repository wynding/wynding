import { defineConfig } from 'vitest/config';

// Coverage gate for the anti-cheat surface: >= 90% lines+branches+functions+statements,
// the same bar engine / sim / replay / content are held to. This package was the one
// workspace exempt from it (#108) — an odd exemption for the module whose entire job is
// deciding which submitted scores are real, and the one place where an unexercised
// branch is a hole an attacker gets to pick.
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
