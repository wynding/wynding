// profiles.ts — the two pinned device/throttle profiles ADR 0005 measures against
// (M2-S4b, PLAN step 22/23). A SINGLE committed data module: `playwright.perf.config.ts`
// reads the viewport/deviceScaleFactor/hasTouch fields to build its two projects, and
// `stress.perf.spec.ts` reads `cpuThrottleRate` to drive the CDP throttle Playwright has
// no built-in option for. One source of truth means Phase 6's spike document — and
// S5–S10's re-measurements — can cite these numbers verbatim, and the two configs can
// never quietly drift apart.
//
// ADR 0005 sets SEPARATE mid-range budgets (60 fps, `step()` < 2ms) that a low-end-only
// run cannot speak to at all — hence exactly two profiles, never one "representative"
// setting.

export interface PerfProfile {
  readonly name: 'low-end' | 'mid-range';
  /** `Emulation.setCPUThrottlingRate`'s `rate` (CDP) — applied per-test via
   *  `context.newCDPSession(page)`, since Playwright's `use` block has no CPU-throttle
   *  option of its own. */
  readonly cpuThrottleRate: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly hasTouch: boolean;
}

/** A small mobile viewport at 6x CPU throttle — ADR 0005's low-end reference.
 *
 *  LANDSCAPE, and that is load-bearing rather than a preference. The app's rotate
 *  prompt (`src/rotate.ts`) is a modal that fires whenever `(orientation: portrait)`
 *  AND `(pointer: coarse)` both match, and a touch profile at 360×740 matches both:
 *  the first run of this harness spent its whole window behind that dialog, which
 *  swallowed every input-latency click until the sim ran itself out to a terminal
 *  phase — so it measured a rotate prompt, not the game. The main Playwright config's
 *  `chromium-touch` project uses 'Galaxy S9+ landscape' for exactly this reason;
 *  phones play this game in landscape by design, so landscape is also the honest
 *  thing to measure. */
export const LOW_END_PROFILE: PerfProfile = {
  name: 'low-end',
  cpuThrottleRate: 6,
  viewport: { width: 740, height: 360 },
  deviceScaleFactor: 3,
  hasTouch: true,
};

/** A desktop-ish viewport at 2x CPU throttle — ADR 0005's mid-range reference, the
 *  profile the fps/`step()`-under-2ms budgets actually speak to. */
export const MID_RANGE_PROFILE: PerfProfile = {
  name: 'mid-range',
  cpuThrottleRate: 2,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  hasTouch: false,
};

/** Keyed by Playwright project name (`playwright.perf.config.ts`'s `projects[].name`),
 *  so the spec can look its own profile up via `testInfo.project.name` with no second
 *  mapping to keep in sync. */
export const PROFILES: Readonly<Record<string, PerfProfile>> = {
  'low-end': LOW_END_PROFILE,
  'mid-range': MID_RANGE_PROFILE,
};
