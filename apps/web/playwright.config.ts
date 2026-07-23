import { defineConfig, devices } from '@playwright/test';

// Playwright e2e smoke for the M1 slice (ADR 0003: axe-core runs here, in CI, against the
// real DOM UI). Vite serves the app; the spec drives a build/sell/call-wave/results path
// and asserts zero axe violations. Kept out of the unit `test` script (it needs a browser
// + dev server) — run with `pnpm --filter @wynding/web e2e`.
export default defineConfig({
  testDir: './e2e',
  // Above the smoke test's 40s results-dialog wait — a no-tower M1 loss can approach ~25s
  // of wall-clock even at 2×, so a 30s per-test cap could abort it on a slow CI runner.
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm run build && pnpm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
