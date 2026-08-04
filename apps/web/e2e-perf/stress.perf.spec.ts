import { test, expect } from '@playwright/test';
import {
  percentile,
  max as maxOf,
  TOWERS_PLACED_THRESHOLD,
  LEFTOVER_BOUNTY_THRESHOLD,
  PEAK_LIVE_CREEPS_THRESHOLD,
} from '@wynding/perf';
import { PROFILES } from './profiles';

// The `window.wyndingPerf` shape `apps/web/perf/main-perf.ts` installs IN THE BROWSER.
// Declared locally rather than imported from that module: importing it as a value would
// execute its top-level `main().catch(...)` under Node (it reaches for `document`/
// `fetch`/`requestAnimationFrame`, none of which exist here), and a type-only import of
// an ambient `declare global` merge is not reliably picked up by Playwright's per-file
// transform. Kept in sync with that file's `PerfHarness` interface by hand — small and
// stable enough that this is a one-repo-shared-fact tradeoff, not a maintenance trap;
// `apps/web/tsconfig.json` now includes `e2e-perf` (QC: this file was previously unlinted) specifically so
// `tsc` catches a drift between the two as a type error.
declare global {
  interface Window {
    wyndingPerf?: {
      ready: boolean;
      tick(): number;
      phase(): string;
      liveCreepCount(): number;
      towerCount(): number;
      bounty(): number;
      startSampling(ms: number): Promise<void>;
      frameDeltas: number[];
      inputLatencies: number[];
    };
  }
}

// stress.perf.spec.ts — the M2-S4b browser perf spike (PLAN steps 22/23). Runs under
// BOTH `playwright.perf.config.ts` projects (`low-end`, `mid-range`), driving the REAL
// controller + Phaser scene (via `apps/web/perf/main-perf.ts`) against the ADR 0005
// stress scene, and printing one `PERF-BROWSER-REPORT:` line per profile for Phase 6 to
// lift verbatim into the spike document.
//
// RECORDED-ONLY (PLAN "Out of scope": "Any fps/memory/input-latency CI gate —
// recorded-only this story"). The only HARD assertions below are the ones that prove
// the scene was genuinely at peak load before any number is believed — never a budget
// number. A budget assertion here would be exactly the CI gate the plan puts out of
// scope; see the workload-oracle rationale this mirrors, `packages/perf/src/oracle.ts`.

// The browser-side echo of the Node oracle's own peak-concurrency floor
// (`packages/perf/src/oracle.ts`'s `PEAK_LIVE_CREEPS_THRESHOLD`) — imported directly
// (QC round 2: this file already imports two other thresholds from `@wynding/perf`;
// this one is exported too, so a hardcoded local copy could silently drift from it) so
// this check and the Node oracle's can never disagree about the floor. A perf run
// over an empty or idle board would otherwise post superb fps/heap/latency numbers
// while measuring nothing the ADR cares about.

/** ~10s of sustained rAF sampling, per ADR 0005's methodology (a percentile over a
 *  window, never a lucky best frame). `performance.now()` keeps advancing at real wall-
 *  clock speed under CDP CPU throttling (only JS *execution* is slowed), so this
 *  finishes in ~10 real seconds on every profile. */
const SAMPLE_WINDOW_MS = 10_000;

/** Real pointer interactions dispatched at the arm-toggle Card, for the input-latency
 *  percentile. */
const INPUT_LATENCY_SAMPLES = 20;

/** The original floor was 100, justified by "10 real seconds at even a terrible ~15 fps
 *  is 150 frames" — a GUESS, and the recorded low-end run refuted it: the low-end
 *  profile (6x CPU throttle) produced only 107 frames in its 10s window (that run has
 *  since been superseded; the current one produces 167, but the point stands). A floor
 *  of 100 was one slow run away from failing on a genuine, if slow, measurement —
 *  exactly the flap this file exists to avoid elsewhere.
 *
 *  Set against the MEASURED 107 instead: this floor exists only to catch "the
 *  sampling loop measured nothing" (a genuinely stalled or newly-broken loop — zero or
 *  a handful of frames), never to budget how SLOW a real run is allowed to be — that
 *  budget lives in the frame-TIME percentiles below, not in raw sample count.
 *  `packages/perf/src/stats.ts`'s `percentile` already throws on an EMPTY set; 10 is
 *  an order of magnitude below the slowest run recorded so far, comfortable headroom
 *  under any real (if slow) measurement, while still well above "produced almost
 *  nothing". */
const MIN_FRAME_SAMPLES = 10;

/** QC (the frozen-sim-loop guard): the sim must have genuinely advanced across the sampling window —
 *  proof the app's own frame loop (which drives `controller.advance()`) is still
 *  stepping, not frozen by a swallowed throw while `startSampling`'s INDEPENDENT rAF
 *  chain keeps sampling a static board. At `MS_PER_TICK` = 50ms, 10 real seconds is
 *  ~200 ticks in the unthrottled case; this floor is set far below that so it never
 *  flakes on the throttled low-end profile, while still being far above the "zero
 *  advancement" failure it exists to catch. */
const MIN_TICKS_ADVANCED = 50;

// ADR 0005's replacement mid-range trigger (PLAN steps 19/20, this packet). The old
// trigger — `measured fps <= 1.25 x 60` — is degenerate: 75 fps is unreachable on a
// vsync-capped display, so it fired unconditionally. Both signals below are pinned
// HERE, before any run, and neither is a threshold to move if it fires — a fired
// signal is a result to report.
//
// Signal 1 — MISSED-REFRESH PROPORTION: the share of sampled frames exceeding 1.5x the
// nominal refresh interval. 1.5x (not the 16.7ms budget itself) is the midpoint to the
// next refresh: a healthy 60Hz interval is ~16.667ms and ordinary scheduling jitter
// crosses 16.7 constantly, so counting frames above the BUDGET measures noise, while a
// frame above the midpoint genuinely missed one. Fires when the proportion exceeds 2% —
// a judgement, not a derivation: at 60Hz over a ~10s window, 2% is on the order of a
// dozen missed refreshes, few enough that a user would not call it stuttering, many
// enough that it is not one unlucky GC pause.
//
// Signal 2 — OUTRIGHT BREACH: p95 frame time above the 16.7ms budget itself. The two
// signals are INDEPENDENT, not ordered — 6% of frames at 20ms breaches p95 > 16.7 while
// producing no frame above 25ms, so neither implies the other. Either firing is a
// trigger.
//
// The generic `measured >= 0.75 x limit` margin rule (this ADR's escalation trigger,
// used everywhere else) CANNOT be reused for either signal: frame time under vsync is
// quantized, so a healthy profile sits AT the budget and a 0.75 margin fires
// unconditionally, the same degeneracy this replaces.
//
// It is normalized, not machine-independent: a fixed 25ms cutoff only separates the
// 16.7/33.3ms buckets on a 60Hz display; at 90 or 120Hz it means something else
// entirely, and the emulation profiles do not currently validate refresh rate.
const MISSED_REFRESH_INTERVAL_MULTIPLIER = 1.5;
const MISSED_REFRESH_PROPORTION_THRESHOLD = 0.02;

/** Signal 1 is the replacement **MID-RANGE** trigger, and only that. ADR 0005 replaced the
 *  degenerate mid-range fps trigger and left the low-end 30 fps floor standing as its own,
 *  separate budget — so the missed-refresh signal has no low-end definition to apply.
 *
 *  Applying it there anyway is not merely out of scope, it is the SAME degeneracy this
 *  trigger replaced, in the other direction: the cutoff is 1.5x the ~16.7ms display
 *  cadence (~25ms), while a low-end run MEETING its 30 fps floor produces ~33.3ms frames.
 *  Every one of them clears the cutoff, so the proportion is ~1.0, and a profile hitting
 *  its target exactly would report `missedRefreshSignalFired: true` — the artifact this
 *  story lifts verbatim into the spike doc. A trigger that fires on a passing run carries
 *  no information, which is precisely why the old one was thrown out.
 *
 *  Reported as NOT APPLICABLE rather than silently omitted: `missedRefreshStatus` below
 *  distinguishes it from the separate NOT EVALUATED case (cadence out of band), so a reader
 *  of the artifact can tell "this profile has no such budget" from "we could not measure
 *  the display". */
const MISSED_REFRESH_PROFILE = 'mid-range';
const P95_BREACH_FRAME_TIME_MS = 16.7;
/** The low-end profile's frame-time budget — ADR 0005 §Budgets sets **60 fps on mid-range**
 *  (16.7 ms) and a **>= 30 fps floor on low-end** (33.3 ms), which are different numbers.
 *
 *  QC round 1: the first draft of this trigger applied `P95_BREACH_FRAME_TIME_MS` (16.7) to
 *  BOTH projects with no reference to `profile.name`, so the low-end run would have emitted
 *  a breach against a budget the ADR never gave it — and the next packet lifts this
 *  artifact verbatim into the spike doc, so the wrong number would have been recorded as a
 *  measured breach. The p95-breach signal is now judged per profile.
 *
 *  `1000 / 30`, NOT the rounded `33.3` the ADR and the spike doc write in prose. 30 fps is
 *  33.333... ms/frame, so a run sitting EXACTLY on the low-end floor produces intervals
 *  ABOVE 33.3 — and the comparison is a strict `>`, so the rounded constant reports a
 *  profile that met its target as a breach. The direction of the rounding is what makes
 *  this wrong rather than imprecise: rounding a floor DOWN moves the boundary inside the
 *  passing region.
 *
 *  Mid-range keeps the literal `16.7` above deliberately, and the asymmetry is not an
 *  oversight: the two constants round in OPPOSITE directions relative to their budgets.
 *  60 fps is 16.667 ms, so `16.7` sits just ABOVE the exact budget and a run meeting the
 *  target still passes — the same leniency `1000/30` restores on low-end. Both constants
 *  now round away from the passing region, which is the property that matters; making
 *  16.7 exact as well would move a pre-pinned trigger value (ADR 0005: "Outright breach —
 *  p95 frame time > 16.7 ms") in the STRICTER direction for no defect, which is exactly
 *  the re-cutting that ADR forbids everywhere else. */
const P95_BREACH_FRAME_TIME_MS_LOW_END = 1000 / 30;

/** The frame-time budget this profile is actually judged against. */
function p95BreachBudgetMs(profileName: 'low-end' | 'mid-range'): number {
  return profileName === 'low-end' ? P95_BREACH_FRAME_TIME_MS_LOW_END : P95_BREACH_FRAME_TIME_MS;
}

// Cadence calibration — every parameter pinned here, before implementation. Calibrated
// on an idle, UNTHROTTLED `about:blank` page, navigated and sampled BEFORE the perf
// page is ever loaded and BEFORE `Emulation.setCPUThrottlingRate` is called (at CDP's
// default rate 1). This is the single most important constraint in this file: a
// profile that is missing refreshes BECAUSE THE APP IS SLOW would, if calibrated from
// the stressed frame deltas, be read as a display with a slow native cadence — the
// cutoff would scale up with the regression, and the regression would normalize itself
// away. Worst on the low-end profile, which is exactly where it matters. CDP CPU
// throttling slows JS execution, not the compositor's vsync cadence (see the
// `Emulation.setCPUThrottlingRate` call below), so an unthrottled calibration measures
// the same nominal refresh the throttled run will be judged against.
//
// `about:blank`, not `apps/web/perf/index.html` at rate 1: that page loads
// `main-perf.ts` as a module, which builds the scene and fast-forwards ON IMPORT — there
// is no pre-scene seam on it, and adding one would put a test-only branch in the
// measured path.
const CALIBRATION_WINDOW_MS = 2_000;
/** Startup transient — discarded before the median is taken. */
const CALIBRATION_DISCARD_FRAMES = 5;
/** A calibrated median inside this band is read as a nominal 60Hz display. Outside it,
 *  the missed-refresh signal is reported as NOT EVALUATED rather than silently applied
 *  with a 60Hz constant — the p95 breach signal is unaffected and still applies. */
const CALIBRATION_BAND_MS: { readonly low: number; readonly high: number } = {
  low: 15.0,
  high: 18.5,
};

/** Samples raw rAF deltas (ms) for `windowMs` on whatever page is currently loaded —
 *  the calibration twin of `main-perf.ts`'s `startSampling`, but standalone: it must
 *  run on `about:blank`, which never has `window.wyndingPerf`. */
function sampleRafDeltas(windowMs: number): Promise<number[]> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = performance.now();
    const start = last;
    const step = (now: number): void => {
      deltas.push(now - last);
      last = now;
      if (now - start < windowMs) requestAnimationFrame(step);
      else resolve(deltas);
    };
    requestAnimationFrame(step);
  });
}

function summarizeFrameTimes(msValues: readonly number[]): {
  p50: number;
  p95: number;
  p99: number;
} {
  return {
    p50: percentile(msValues, 50),
    p95: percentile(msValues, 95),
    p99: percentile(msValues, 99),
  };
}

/** fps derived FROM a frame-time percentile (never the other direction — QC round-1
 *  fix 6). `summarize()`'s old approach applied the same percentile function to fps
 *  directly, where p90/p99 pick out the BEST frames (the highest fps values), the
 *  opposite of what a floor should read against — ADR 0005 names the statistic
 *  explicitly: "reported as a percentile (not a lucky best frame) — e.g. the
 *  95th-percentile frame time must clear the floor." Frame TIME is the quantity a
 *  higher percentile should mean WORSE for; fps at that frame time is then just
 *  `1000 / ms`, reported for readability, never computed independently. */
function fpsAtFrameTimeMs(ms: number): number {
  return 1000 / ms;
}

test('stress scene: fps / heap / input latency', async ({ page }, testInfo) => {
  const profile = PROFILES[testInfo.project.name];
  if (profile === undefined) {
    throw new Error(`no PerfProfile for Playwright project '${testInfo.project.name}'`);
  }

  // QC (surfacing main-perf.ts's loud failure paths): every loud failure path `main-perf.ts` has (a missing #app, a
  // missing `.wy-card`/live-region anchor, the fast-forward stall's precise stuck-tick
  // message, the fix-1 shell-count guard) used to be discarded — no listener here ever
  // saw it, and the run instead failed minutes later on `waitForFunction`'s generic
  // timeout with no diagnostic. Collected for the whole test, asserted once at the end
  // so it catches anything raised at any point in the flow below, not just at startup.
  const pageErrors: Error[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const cdp = await page.context().newCDPSession(page);

  // Cadence calibration — BEFORE the CPU throttle is applied and before the perf page
  // is ever loaded (ADR 0005's replacement mid-range trigger, PLAN steps 19/20; see the
  // constants above for why the ordering and the page are both load-bearing).
  await page.goto('about:blank');
  const calibrationDeltas = await page.evaluate(sampleRafDeltas, CALIBRATION_WINDOW_MS);
  const calibrationSample = calibrationDeltas.slice(CALIBRATION_DISCARD_FRAMES);
  // FAIL SAFE on a short calibration window, do NOT throw (QC round 1). `percentile`
  // throws on an empty series, so fewer than `CALIBRATION_DISCARD_FRAMES + 1` rAF
  // callbacks in the window would abort the whole test before `PERF-BROWSER-REPORT` is
  // ever printed — taking the p95 breach signal, heap, input latency and every frame-time
  // percentile down with the cadence. That inverts the contract ADR 0005 pins: an
  // unmeasurable cadence must degrade the missed-refresh signal to NOT EVALUATED while
  // leaving every other measurement intact. An occluded or backgrounded window on a headed
  // runner is enough to trigger it, so this is a real path, not a theoretical one. The
  // measured window already carries this guard (`MIN_FRAME_SAMPLES`); the calibration
  // window had none.
  const observedCadenceMs: number | null =
    calibrationSample.length > 0 ? percentile(calibrationSample, 50) : null;
  const cadenceCalibration: 'ok' | 'out-of-band' =
    observedCadenceMs !== null &&
    observedCadenceMs >= CALIBRATION_BAND_MS.low &&
    observedCadenceMs <= CALIBRATION_BAND_MS.high
      ? 'ok'
      : 'out-of-band';
  // Why the signal is or is not evaluated, as one field. Profile applicability is checked
  // FIRST: on low-end the signal has no definition at all (`MISSED_REFRESH_PROFILE`), so
  // whether the cadence happened to calibrate is beside the point.
  const missedRefreshStatus: 'evaluated' | 'not-applicable-for-profile' | 'not-evaluated' =
    profile.name !== MISSED_REFRESH_PROFILE
      ? 'not-applicable-for-profile'
      : cadenceCalibration === 'ok'
        ? 'evaluated'
        : 'not-evaluated';
  // `null` unless evaluated: never silently applied with a 60Hz constant, and never applied
  // to a profile the ADR gave no such trigger. The explicit `observedCadenceMs !== null` is
  // not redundant with `missedRefreshStatus === 'evaluated'` to the compiler — and keeping
  // it explicit means the unmeasurable-cadence path above cannot reach this multiplication
  // even if the classification is later restructured.
  const missedRefreshCutoffMs =
    missedRefreshStatus === 'evaluated' && observedCadenceMs !== null
      ? MISSED_REFRESH_INTERVAL_MULTIPLIER * observedCadenceMs
      : null;

  // Playwright has no built-in CPU-throttle option — DevTools throttling via CDP is the
  // only way to emulate a low-end device's execution speed (PLAN step 22). CDP CPU
  // throttling slows JS execution, not the compositor's vsync cadence, which is exactly
  // why the calibration above — taken before this call — measures the same nominal
  // refresh this throttled run will be judged against.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuThrottleRate });

  await page.goto('/perf/index.html');

  // Wait for the scene to be ready AND for the fast-forward to complete (main-perf.ts
  // sets `ready = true` only after both). The ceiling is deliberately far above what the
  // mid-range profile needs: the low-end project runs the SAME synchronous 1,950-tick
  // build-and-fast-forward loop with its main thread throttled 6x, and a 60s ceiling
  // (the first version's) timed it out. `setupMs` is reported rather than discarded —
  // how long the scene takes to reach peak load is itself a number the spike wants, and
  // a future run that suddenly needs twice as long has regressed even if its frame
  // times look fine.
  const setupStart = Date.now();
  await page.waitForFunction(() => window.wyndingPerf?.ready === true, undefined, {
    timeout: 240_000,
  });
  const setupMs = Date.now() - setupStart;

  // The workload-oracle echoes (plus the `waitForFunction` above): the scene must
  // genuinely be at peak load, with the FULL intended maze standing and its ENTIRE
  // starting bounty spent, before any sampled number below means anything. This is the
  // browser-side twin of the Node workload oracle (PLAN step 18,
  // `packages/perf/src/oracle.ts`) — a perf run over an empty or partially-built board
  // would otherwise post excellent numbers.
  const liveCreepsAtSetup = await page.evaluate(() => window.wyndingPerf!.liveCreepCount());
  expect(liveCreepsAtSetup).toBeGreaterThanOrEqual(PEAK_LIVE_CREEPS_THRESHOLD);

  // QC (the silently-rejected-placement blind spot): `armTower` + `clickAt` reject a placement as a deterministic
  // no-op, so nothing above would notice fewer than the intended 150 towers landing (or
  // a placement's cost never leaving the bounty pool). Mirrors the Node oracle's own
  // `TOWERS_PLACED_THRESHOLD`/`LEFTOVER_BOUNTY_THRESHOLD` assertions exactly.
  const towerCount = await page.evaluate(() => window.wyndingPerf!.towerCount());
  expect(towerCount).toBe(TOWERS_PLACED_THRESHOLD);
  const bounty = await page.evaluate(() => window.wyndingPerf!.bounty());
  expect(bounty).toBe(LEFTOVER_BOUNTY_THRESHOLD);

  // FRAME SAMPLING RUNS FIRST, BEFORE THE LATENCY CLICKS, and the order is load-bearing
  // (owner ruling, 2026-07-31). The clicks take profile-dependent wall time while the sim
  // keeps advancing, so sampling after them started each profile's window at a different
  // tick with a different board — the slower profile got the LIGHTER scene, which is
  // backwards, and made the two profiles' frame times non-comparable with each other.
  // Sampling first pins both windows to the same tick and the same population.
  //
  // fps: sample real rAF frame deltas over a sustained window (never a single lucky
  // frame, per ADR 0005's methodology). `startSampling` resolves its own promise once
  // the window closes, so this `evaluate` call blocks for ~`SAMPLE_WINDOW_MS`.
  // QC (the frozen-sim-loop guard): bracket the window with `tick()` reads, proving the sim actually
  // advanced while sampling was in progress — see `MIN_TICKS_ADVANCED`'s doc comment.
  const tickAtSampleStart = await page.evaluate(() => window.wyndingPerf!.tick());
  await page.evaluate((ms) => window.wyndingPerf!.startSampling(ms), SAMPLE_WINDOW_MS);
  const tickAtSampleEnd = await page.evaluate(() => window.wyndingPerf!.tick());
  expect(tickAtSampleEnd).toBeGreaterThanOrEqual(tickAtSampleStart + MIN_TICKS_ADVANCED);

  const frameDeltas = await page.evaluate(() => window.wyndingPerf!.frameDeltas);
  const frameTimesMs = frameDeltas.filter((d) => d > 0);

  // Input latency: real pointer clicks (Playwright's `locator.click()` dispatches
  // genuine trusted-ish pointer events, not a synthetic DOM event), each toggling
  // arm/disarm on the first Rail Card. `main-perf.ts` times dispatch-to-observable-
  // response entirely in-browser (a `pointerdown` timestamp paired with a
  // MutationObserver on the assistive live region, FIFO-queued (QC: the shared-scalar
  // click/mutation race), so no Playwright IPC round trip contaminates the sample.
  const armToggle = page.locator('.wy-card').first();
  for (let i = 0; i < INPUT_LATENCY_SAMPLES; i++) {
    await armToggle.click();
  }
  const inputLatencies = await page.evaluate(() => window.wyndingPerf!.inputLatencies);
  // QC (the shared-scalar click/mutation race): with the ORIGINAL shared-scalar bug,
  // mutations could resolve MORE than once per click (a stray live-region write
  // between two clicks) or the queue could silently drop a response, and the sample
  // count would drift from 20 — this length assertion caught that directly.
  //
  // QC round 2: with the FIFO fix in place, this no longer holds. `inputLatencies`
  // is now paired FIFO, so its length is `min(#clicks dispatched, #live-region
  // mutations observed)` — it equals `INPUT_LATENCY_SAMPLES` whenever at least that
  // many mutations occur in the window, regardless of whether each one paired with
  // the click that "really" caused it. So this assertion still catches a starved or
  // stalled mutation stream (too few mutations), but it can no longer detect the
  // RESIDUAL case: an unrelated live-region write — anything else that touches the
  // assistive live region during the window — resolving a PENDING click early and
  // understating that click's latency, without changing the sample count at all. A
  // length check cannot see that; only inspecting the individual latency values
  // could.
  expect(inputLatencies).toHaveLength(INPUT_LATENCY_SAMPLES);

  // QC (the stalled-sampling-loop floor): the assertion that stops a stalled/suppressed sampling loop from
  // reporting `null` for every fps figure while the test itself stays green.
  // `packages/perf/src/stats.ts`'s `percentile` already throws on a genuinely EMPTY
  // set — this asserts against the browser-side twin of that failure at a floor high
  // enough to catch a sampling loop that produced only a handful of frames too.
  expect(frameTimesMs.length).toBeGreaterThanOrEqual(MIN_FRAME_SAMPLES);

  // QC (frame-TIME, not frame-rate, percentiles): frame-TIME percentiles (ms, higher = worse), matching ADR 0005's
  // methodology ("the 95th-percentile frame time must clear the floor") — computed with
  // `@wynding/perf`'s nearest-rank `percentile` (QC: one shared estimator, not a
  // second floor-rank copy living here). fps is DERIVED from each frame-time
  // percentile, never computed as its own percentile over the fps series (which would
  // pick out the BEST frames at p90/p99 — the wrong direction for a floor).
  const frameTimeMs = summarizeFrameTimes(frameTimesMs);
  const fpsAtFrameTimePercentile = {
    p50: fpsAtFrameTimeMs(frameTimeMs.p50),
    p95: fpsAtFrameTimeMs(frameTimeMs.p95),
    p99: fpsAtFrameTimeMs(frameTimeMs.p99),
  };

  // ADR 0005's replacement mid-range trigger (PLAN steps 19/20; see the constants and
  // calibration above). The missed-refresh signal is computed against the CALIBRATED
  // cutoff, never a hardcoded 60Hz constant — when calibration landed out-of-band, or when
  // the profile has no such trigger at all, `missedRefreshCutoffMs` is `null` and the
  // signal is not reported as fired (see `missedRefreshStatus` for which of the two it
  // was). The p95 breach signal is unaffected by both and always evaluates, against THIS
  // profile's own budget.
  const missedRefreshDenominator = frameTimesMs.length;
  const missedRefreshLongFrameCount =
    missedRefreshCutoffMs === null
      ? null
      : frameTimesMs.filter((ms) => ms > missedRefreshCutoffMs).length;
  const missedRefreshProportion =
    missedRefreshLongFrameCount === null
      ? null
      : missedRefreshLongFrameCount / missedRefreshDenominator;
  // §3's required fields — cutoff, observed cadence, long-frame count, denominator and
  // proportion, plus `cadenceCalibration` and `missedRefreshStatus` — so the trigger is
  // reproducible from the artifact rather than recomputed by hand. The two `*SignalFired`
  // booleans apply the pinned thresholds directly against those numbers, so a reader of the
  // artifact never has to re-derive "did it fire" from the raw figures either — and if
  // a signal fires, that is a RESULT to report, never a threshold to move.
  const frameTimeTrigger = {
    missedRefreshStatus,
    cadenceCalibration,
    observedCadenceMs,
    cutoffMs: missedRefreshCutoffMs,
    longFrameCount: missedRefreshLongFrameCount,
    denominator: missedRefreshDenominator,
    proportion: missedRefreshProportion,
    missedRefreshSignalFired:
      missedRefreshProportion === null
        ? null
        : missedRefreshProportion > MISSED_REFRESH_PROPORTION_THRESHOLD,
    // Judged against THIS profile's budget, not a single hardcoded one.
    p95BreachBudgetMs: p95BreachBudgetMs(profile.name),
    p95BreachSignalFired: frameTimeMs.p95 > p95BreachBudgetMs(profile.name),
  };

  // The frozen-sim-loop guard, second half: re-read `liveCreepCount()` after the sampling
  // window and the latency clicks, not just before them — a run that lost creeps to kills
  // (or even resolved, though `endPhase` below would catch that) over that stretch would
  // have its BOARD SIZE overstated by reporting only the earlier number. Note this read
  // now lands after the clicks rather than before them, so it is no longer the population
  // the frame times were measured over; that is `liveCreepsAtSetup`, taken immediately
  // before the window opens. Both are reported.
  const liveCreepsAtSampleEnd = await page.evaluate(() => window.wyndingPerf!.liveCreepCount());

  // The second budget-INDEPENDENT assertion, and it must run AFTER the window, not
  // before: `step()` freezes on a terminal phase, so a match that resolved mid-window
  // would render a finished board behind the results dialog for the remainder and post
  // beautiful, meaningless frame times. The >= 280 creep check above cannot see that —
  // it is taken before the window opens. Together they bracket the sample: loaded when
  // it started, still live when it ended.
  const endPhase = await page.evaluate(() => window.wyndingPerf!.phase());
  expect(endPhase).toBe('running');

  // JS heap: Chrome-only (`performance.memory` is a non-standard Chrome extension) —
  // degrade to `null` rather than fabricate a number on an engine that doesn't expose
  // it.
  const heapBytes = await page.evaluate(() => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    return perf.memory?.usedJSHeapSize ?? null;
  });

  // The GPU actually behind the canvas. Pinned alongside the Chrome version and for the
  // same reason: DevTools throttling shifts between Chrome versions, and the WebGL
  // backend shifts between MACHINES — Playwright's Chromium falls back to a SwiftShader
  // software rasterizer wherever no usable GPU exists (a CI runner). An fps figure
  // whose renderer is unrecorded is uninterpretable, and an S5–S10 re-measurement
  // compared against it would be comparing nothing. Recorded, never asserted on.
  const webglRenderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
  });

  // QC (surfacing main-perf.ts's loud failure paths, second half): assert no in-page exception or console error
  // happened anywhere in the run, now that the whole flow above has had the chance to
  // trigger one — instead of every one of `main-perf.ts`'s loud failure paths running
  // out the clock as an opaque `waitForFunction` timeout.
  expect(pageErrors.map((e) => e.message)).toEqual([]);
  expect(consoleErrors).toEqual([]);

  const report = {
    profile: profile.name,
    chromeVersion: page.context().browser()?.version() ?? null,
    webglRenderer,
    cpuThrottleRate: profile.cpuThrottleRate,
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    hasTouch: profile.hasTouch,
    liveCreepsAtSetup,
    liveCreepsAtSampleEnd,
    towerCount,
    bounty,
    setupMs,
    sampleWindowMs: SAMPLE_WINDOW_MS,
    frameSampleCount: frameTimesMs.length,
    tickAtSampleStart,
    tickAtSampleEnd,
    // Frame-time (ms, higher = worse) is the primary methodology-correct figure (QC
    // round-1 fix 6); fps is reported alongside, derived from each frame-time
    // percentile, purely for readability against the ADR's fps-shaped budget language.
    frameTimeMs,
    fpsAtFrameTimePercentile,
    // ADR 0005's replacement mid-range trigger (PLAN steps 19/20) — see the constants
    // above for both formulas and every calibration parameter, pinned before this run.
    frameTimeTrigger,
    heapBytes,
    inputLatencySampleCount: inputLatencies.length,
    // QC (frame-TIME, not frame-rate, percentiles, second half): with n = 20, a "p99" is just the maximum — label
    // it honestly as `max` rather than dressing a single largest sample up as a
    // percentile estimate.
    inputLatencyMs: {
      p50: percentile(inputLatencies, 50),
      max: maxOf(inputLatencies),
    },
  };
  // The machine-readable line Phase 6 lifts verbatim into the spike document. No
  // `eslint-disable` needed: this repo's flat config (`eslint.config.mjs`) never
  // enables `no-console` — QC found a stale disable comment here that
  // had been silently unused since this file was never linted at all (`apps/web`'s
  // `lint` script only ran `eslint src` until this fix widened it to `perf e2e-perf`).
  console.log(`PERF-BROWSER-REPORT: ${JSON.stringify(report)}`);
});
