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
  // Cold SwiftShader WebGL boot on CI can hold Phaser READY (and first paint) past
  // Playwright's 5s default expect timeout — the hidpi polls need the longer window.
  expect: { timeout: 20_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', testIgnore: /hidpi\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    // HiDPI backing-store gates (#28/P5): the same viewport at 1×/2×/3× device pixel
    // ratio. dsf 3 exercises the ≤2 effective-dpr CLAMP (ADR 0005) — the backing store
    // must size to 2×, not 3×, while CSS/pointer geometry stays identical across all
    // three. A fixed viewport (not the default) keeps the board's letterboxed layout
    // — and therefore the expected cell positions the specs assert against — stable.
    {
      name: 'chromium-dpr1',
      testMatch: /hidpi\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: 'chromium-dpr2',
      testMatch: /hidpi\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'chromium-dpr3',
      testMatch: /hidpi\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 3,
      },
    },
  ],
  webServer: {
    command: 'pnpm run build && pnpm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
