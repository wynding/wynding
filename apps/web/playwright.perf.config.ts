import { defineConfig, devices } from '@playwright/test';
import { LOW_END_PROFILE, MID_RANGE_PROFILE } from './e2e-perf/profiles';

// playwright.perf.config.ts — the browser perf harness's OWN Playwright config
// (M2-S4b, PLAN step 22). Deliberately SEPARATE from `playwright.config.ts`, not new
// projects inside it: projects there run by default under `pnpm e2e` (the a11y smoke
// job), so perf projects living there would start executing on every accessibility
// run, and — absent a strict `testMatch` — the ordinary 64-test suite would
// additionally run under both throttled CPU profiles below, quietly multiplying e2e
// time and inventing throttled a11y failures nobody asked for. `testMatch` here is the
// mirror-image guard: only `*.perf.spec.ts` files run under THIS config.
//
// RECORDED-ONLY (PLAN "Out of scope": "Any fps/memory/input-latency CI gate —
// recorded-only this story"). Invoked only via `pnpm -C apps/web run perf:e2e`, by hand — never added to `pnpm e2e`, `verify`, or any CI workflow.
export default defineConfig({
  testDir: './e2e-perf',
  testMatch: /\.perf\.spec\.ts$/,
  // Six minutes, and it needs to be: the ~10s sustained sampling window is the SMALL part.
  // Before it, each project synchronously builds the 150-tower maze and fast-forwards the
  // sim 1,950 ticks to peak load — on the low-end project with its main thread throttled
  // 6x. A 120s ceiling timed that out; this is sized so a slow machine reports a real
  // number instead of a timeout. The spec records its own `setupMs` so an unexpectedly
  // long setup shows up as data rather than as a mysterious failure.
  timeout: 360_000,
  // Two CPU-throttled profiles measuring the SAME machine at once would contend for its
  // one real CPU and corrupt each other's numbers — run them one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // A recorded measurement should never silently retry and paper over a bad run — see
  // the one sample this invocation actually produced.
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    // Port 4174, deliberately NOT 4173 (`playwright.config.ts`'s port) — the two
    // webServers must never collide if both ever run in the same job.
    baseURL: 'http://localhost:4174',
    trace: 'off',
    // ASK FOR THE REAL GPU. Playwright's Chromium defaults to ANGLE-over-SwiftShader —
    // a pure software rasterizer, no GPU at all (directly observed: "ANGLE (Google,
    // Vulkan 1.3.0 (SwiftShader Device ...), SwiftShader driver)"). ADR 0005 exists to
    // validate the PHASER/WebGL BET, and an fps figure measured on a software
    // rasterizer measures SwiftShader, not that bet — the first run of this harness
    // reported 6 fps low-end / 10 fps mid-range for exactly that reason.
    //
    // `--enable-gpu` alone is enough and is portable: Chrome picks the
    // platform-appropriate ANGLE backend (Metal on macOS, Vulkan/GL on Linux). On a
    // machine with no usable GPU — a GitHub runner, say — it simply falls back to
    // SwiftShader rather than failing, which is why `webglRenderer` is RECORDED in
    // every report: an fps number whose renderer is unknown cannot be interpreted, and
    // S5–S10 comparing against an unlabelled one would be comparing nothing.
    launchOptions: { args: ['--enable-gpu'] },
  },
  projects: [
    {
      name: LOW_END_PROFILE.name,
      use: {
        ...devices['Desktop Chrome'],
        viewport: LOW_END_PROFILE.viewport,
        deviceScaleFactor: LOW_END_PROFILE.deviceScaleFactor,
        hasTouch: LOW_END_PROFILE.hasTouch,
      },
    },
    {
      name: MID_RANGE_PROFILE.name,
      use: {
        ...devices['Desktop Chrome'],
        viewport: MID_RANGE_PROFILE.viewport,
        deviceScaleFactor: MID_RANGE_PROFILE.deviceScaleFactor,
        hasTouch: MID_RANGE_PROFILE.hasTouch,
      },
    },
  ],
  webServer: {
    // Builds through `vite.perf.config.ts` (its own output dir, `dist-perf`) and
    // previews THAT directory — never `dist/`, so a perf run can never accidentally
    // serve (or be mistaken for) the production build.
    command:
      'pnpm exec vite build --config vite.perf.config.ts && ' +
      'pnpm exec vite preview --config vite.perf.config.ts --port 4174 --strictPort',
    // NOT the bare origin: `rollupOptions.input: 'perf/index.html'` (vite.perf.config.ts)
    // emits `dist-perf/perf/index.html`, not `dist-perf/index.html` — the origin '/'
    // 404s, so Playwright's readiness poll against it would hang for the full timeout
    // even though the preview server is already up.
    url: 'http://localhost:4174/perf/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
