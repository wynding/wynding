import { defineConfig, devices } from '@playwright/test';

// Playwright e2e smoke for the M1 slice (ADR 0003: axe-core runs here, in CI, against the
// real DOM UI). Vite serves the app; the spec drives a build/sell/call-wave/results path
// and asserts zero axe violations. Kept out of the unit `test` script (it needs a browser
// + dev server) — run with `pnpm --filter @wynding/web e2e`.
export default defineConfig({
  testDir: './e2e',
  // Above home.spec's 40s results-dialog wait — a no-tower loss can approach ~25s of
  // wall-clock even at 2×, so a 30s per-test cap could abort it on a slow CI runner. The
  // paced marathon tests (#97) carry per-test `test.setTimeout` overrides sized above
  // the sum of their own declared worst-case budgets (ten/eight 5s pulse deadlines plus
  // the 60s dialog waits) — 150s in smoke.spec/start-gate.spec, 120s in compact.spec —
  // so this cap never governs them.
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /hidpi|touch|rotate/,
      use: { ...devices['Desktop Chrome'] },
    },
    // Touch/rotate coverage (#P6): a REAL mobile landscape device profile — `hasTouch`
    // alone only enables touch events, it does not guarantee `(pointer: coarse)` matches,
    // which the rotate overlay and the touch gestures both gate on. Every spec here
    // asserts that media query as its own precondition before testing gated behavior.
    {
      name: 'chromium-touch',
      // `compact.spec.ts` runs in BOTH projects (Story 11): the Compact trigger is keyed on
      // viewport HEIGHT alone, so the layout must hold identically for a coarse-pointer
      // phone and a short desktop window. `chromium.testIgnore` is deliberately untouched,
      // so it also runs under the default project.
      testMatch: /touch\.spec\.ts|rotate\.spec\.ts|compact\.spec\.ts/,
      use: { ...devices['Galaxy S9+ landscape'] },
    },
    // HiDPI backing-store gates (#28/P5): the same viewport at 1×/2×/3× device pixel
    // ratio. dsf 3 exercises the ≤2 effective-dpr CLAMP (ADR 0005) — the backing store
    // must size to 2×, not 3×, while CSS/pointer geometry stays identical across all
    // three. A fixed viewport (not the default) keeps the board's letterboxed layout
    // — and therefore the expected cell positions the specs assert against — stable.
    {
      name: 'chromium-dpr1',
      testMatch: /hidpi\.spec\.ts/,
      // Cold SwiftShader WebGL boot on CI can hold Phaser READY past the 5s default
      // expect timeout — only the hidpi polls need the longer window.
      expect: { timeout: 20_000 },
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: 'chromium-dpr2',
      testMatch: /hidpi\.spec\.ts/,
      // Cold SwiftShader WebGL boot on CI can hold Phaser READY past the 5s default
      // expect timeout — only the hidpi polls need the longer window.
      expect: { timeout: 20_000 },
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'chromium-dpr3',
      testMatch: /hidpi\.spec\.ts/,
      // Cold SwiftShader WebGL boot on CI can hold Phaser READY past the 5s default
      // expect timeout — only the hidpi polls need the longer window.
      expect: { timeout: 20_000 },
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 3,
      },
    },
    // The WebKit regression arm for #98 (a held press straddling a mid-run HUD label
    // refresh) — scoped to this one spec, not a whole-suite duplication: the rest of the
    // suite is chromium-calibrated (SwiftShader timings, device profiles), and this defect
    // class is pinned by `slow-press.spec.ts` plus the browser-agnostic unit invariant
    // (`overlay.test.ts`). The default `chromium` project deliberately ALSO runs this spec
    // (its `testIgnore` above doesn't exclude it) as the control arm — Chromium synthesizes
    // `click` across mutations, so it passes even before the P1 fix lands.
    {
      name: 'webkit',
      testMatch: /slow-press\.spec\.ts/,
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: 'pnpm run build && pnpm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
