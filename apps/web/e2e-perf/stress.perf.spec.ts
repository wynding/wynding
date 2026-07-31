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

  // Playwright has no built-in CPU-throttle option — DevTools throttling via CDP is the
  // only way to emulate a low-end device's execution speed (PLAN step 22).
  const cdp = await page.context().newCDPSession(page);
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
