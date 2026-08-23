import { defineConfig } from 'vitest/config';

// Coverage gate for the anti-cheat surface: >= 90% lines+branches+functions+statements,
// the same bar engine / sim / replay / content are held to. This package was the one
// workspace exempt from it (#108) — an odd exemption for the module whose entire job is
// deciding which submitted scores are real, and the one place where an unexercised
// branch is a hole an attacker gets to pick.
export default defineConfig({
  test: {
    // Turning coverage on is what makes this necessary. `replay-parity.test.ts` re-simulates
    // the full ten-wave arc through `handler()` three times, and v8's instrumentation costs
    // roughly 5x on that loop — measured here, 489ms of test time without `--coverage`
    // against 2.31s with it. Locally that still fits vitest's 5s default; on the CI runner
    // the same legs took 7.5s and 5.8s and timed out, red on the first push of #108. So the
    // package that opts into the instrumentation also states the budget it needs. Generous
    // on purpose (4x the worst CI reading, a quarter of what `m2-golden.test.ts` grants its
    // goldens): a slow cold runner must not red a suite that is merely doing its job.
    testTimeout: 30_000,
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
