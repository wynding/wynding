// main-perf.ts — the PERF-ONLY browser entry point (M2-S4b, PLAN step 22). NOT part of
// the shipped app: `apps/web/perf/index.html` is this file's ONLY consumer, built by a
// SEPARATE Vite config (`vite.perf.config.ts`) into a SEPARATE output directory
// (`dist-perf`) — see that file's header for why a shared build would pollute the
// production artifact. This module drives the REAL `createApp` / `createController` /
// Phaser scene, injecting only the stress bundle (via `controller.ts`'s
// `ControllerContent` seam) — the measurement is worthless if it exercises a bespoke
// path instead of the real one.
//
// RECORDED-ONLY, deliberately NOT a CI gate (PLAN "Out of scope": "Any fps/memory/
// input-latency CI gate — recorded-only this story"). Nothing here fails a build; it
// only collects numbers for Phase 6's spike document. Do not wire this into CI as a
// pass/fail check.
//
// QC (the double-boot bug): this file imports `createApp` from `../src/main`, which used to
// ALSO auto-boot the production app on import (a module-top-level `boot(document)`
// guarded only by a `VITEST` env sniff that is false in a real browser). That side
// effect now lives in `../src/boot-entry.ts`, a module this file never imports — see
// that module's header. The guard below (right after `createApp`) is the belt to that
// braces: it asserts exactly one `.wy-shell` ever lands in the document, so a future
// reintroduction of a second auto-boot fails loudly here instead of silently doubling
// every sampled frame again.

import { parseRulesetJson } from '@wynding/sim';
import { STRESS_RULESET_URL, STRESS_BOARD_ID } from '@wynding/content/stress';
import { stressAnchors, towerIdAt, BUILD_TICKS, PLACEMENTS_PER_TICK } from '@wynding/perf';
import { mount as mountScene } from '@wynding/render/scene';
import { createApp } from '../src/main';
import { createController, type Controller, type ControllerHooks } from '../src/controller';

// ---- M2-S10 P8: semantic trace markers (perf-build only — this module never ships) ----
//
// The ADR 0005 frame-time diagnosis reads a minified bundle's DevTools trace, which
// cannot be read by function name. `performance.mark`/`measure` pairs bracket the three
// spans that matter — `wy:step`, `wy:derive` (via `ControllerHooks`, the seam
// `controller.ts` documents) and `wy:draw` (by wrapping the `RenderHandle` the scene
// factory returns — `draw` is public on the handle, so wrapping alone is enough there).
// They surface in a trace via the `blink.user_timing` category as `ph:'b'`/`'e'` async
// pairs. Also emitted: `wy:window:start`/`wy:window:end` marks bracketing the sampling
// window, so the trace post-processor clips attribution to the measured interval and
// discards warm-up (including the one-off V8 attach storm `cpu_profiler` causes) and
// teardown. Cost when no trace is recording: one mark + one measure call per span per
// tick/frame, measured at ~2µs/frame in the pilot — negligible against a 16.7ms budget.
const SPAN_MARK_PREFIX = 'wy:';

function beginSpan(name: string): void {
  performance.mark(`${SPAN_MARK_PREFIX}${name}:b`);
}
function endSpan(name: string): void {
  performance.measure(`${SPAN_MARK_PREFIX}${name}`, `${SPAN_MARK_PREFIX}${name}:b`);
}

const controllerHooks: ControllerHooks = {
  begin: (span) => beginSpan(span),
  end: (span) => endSpan(span),
};

/**
 * The perf-only measurement surface, read by `e2e-perf/stress.perf.spec.ts` via
 * `page.evaluate`. Kept intentionally tiny: readiness, the live-creep/tower-count/
 * bounty oracle echoes (the browser-side twin of the Node harness's workload oracle,
 * PLAN step 18), a frame-delta sampler, and the input-latency probe's collected
 * samples.
 */
export interface PerfHarness {
  /** True once the maze is built and the sim has been fast-forwarded to peak load
   *  (tick >= FAST_FORWARD_TICK). False while either is in flight — the spec must poll
   *  this before trusting anything else on this object. */
  ready: boolean;
  /** The current sim tick, for the spec's own sanity polling — and (QC: the frozen-sim-loop guard)
   *  for proving the sim genuinely advanced across the sampling window: the spec reads
   *  this before and after `startSampling` and asserts it moved, so a throw inside the
   *  app's own frame loop (which would freeze the board while `startSampling`'s
   *  independent rAF chain keeps sampling a static scene at a deceptively smooth fps)
   *  cannot pass unnoticed. */
  tick(): number;
  /** The sim's current phase. The spec asserts this is still `'running'` AFTER the
   *  sampling window, not just before it: `step()` freezes on a terminal phase
   *  (`@wynding/sim`'s `index.ts`), so a run that resolved mid-window would spend the
   *  rest of it rendering a finished match behind the results dialog and post
   *  beautiful, meaningless frame times. Exactly the failure mode the Node harness's
   *  every-sample-is-`running` assertion exists for (`packages/perf/src/oracle.ts`);
   *  this is its browser-side twin. */
  phase(): string;
  /** Live creep count RIGHT NOW — the browser echo of the Node oracle's peak-concurrency
   *  assertion (>= 280 in `packages/perf/src/oracle.ts`): a perf run over an empty board
   *  would otherwise post superb numbers on every metric below, so the spec asserts this
   *  before believing any of them. */
  liveCreepCount(): number;
  /** Live tower count RIGHT NOW (QC: the silently-rejected-placement blind spot) — the browser echo of the Node
   *  oracle's `TOWERS_PLACED_THRESHOLD` check. `armTower` + `clickAt` (the build loop
   *  below) drive the same player-intent API a real rejection can deterministically
   *  no-op through, so nothing else here would notice fewer than 150 towers actually
   *  landing — a run could report fps for a mostly-empty board and still pass every
   *  other check. */
  towerCount(): number;
  /** Current bounty RIGHT NOW (QC: the silently-rejected-placement blind spot) — the maze consumes the stress
   *  bundle's ENTIRE starting bounty by construction (150 anchors × cost 12 = the
   *  bundle's `startingBounty`, see `packages/perf/src/layout.ts`'s `towerIdAt` doc
   *  comment), so a non-zero leftover after the build loop is proof a placement was
   *  rejected — the same "leftover bounty" oracle the Node harness asserts
   *  (`packages/perf/src/oracle.ts`'s `LEFTOVER_BOUNTY_THRESHOLD`), echoed here. */
  bounty(): number;
  /** Samples real rAF frame deltas (ms) for `ms` milliseconds, replacing any prior
   *  sample set, and resolves once the window closes. */
  startSampling(ms: number): Promise<void>;
  /** Frame deltas (ms) collected by the most recent `startSampling` call. */
  frameDeltas: number[];
  /**
   * Input-latency samples (ms): each real pointer interaction the spec dispatches
   * against the first Rail Card toggles arm/disarm (`controller.armTower`'s documented
   * toggle — see `controller.ts`), which ALWAYS updates the assistive live region
   * (`.wy-sr-only[aria-live="polite"]`) no matter what else is going on. A placement
   * click was deliberately not used for this probe: the maze consumes the stress
   * bundle's entire starting bounty (150 × cost 12, see `layout.ts`'s `towerIdAt` doc
   * comment), so every board cell click after setup is a rejected no-op — it would
   * measure "how fast a rejection re-paints", not real input responsiveness.
   *
   * QC (the shared-scalar click/mutation race): a single shared `clickTimestamp` scalar used to be overwritten by
   * every `pointerdown` and zeroed by the MutationObserver, which meant a slow response
   * to click N got silently reattributed to click N+1's `pointerdown` — the recorded
   * "latency" was really the INTERVAL BETWEEN CLICKS, not a click's own response time.
   * Pairing is now FIFO: every `pointerdown` timestamp is queued, and every observed
   * live-region mutation resolves the OLDEST still-pending one. An extra mutation with
   * nothing queued (e.g. from unrelated DOM churn) is discarded rather than matched to
   * the wrong click.
   */
  inputLatencies: number[];
}

declare global {
  interface Window {
    wyndingPerf?: PerfHarness;
  }
}

/** Just past the last spawn (tick 1900, see `packages/perf/src/scenario.ts` and the
 *  stress bundle's `spacingTicks`/`countdown`) — every one of the scenario's 304 creeps
 *  is live once the sim reaches this tick. */
const FAST_FORWARD_TICK = 1950;

/** `@wynding/engine`'s `DEFAULT_MS_PER_TICK` — advancing exactly this many wall-ms per
 *  `controller.advance()` call commits exactly one tick, no more, no less. */
const MS_PER_TICK = 50;

/** The fixed loop's catch-up clamp (`DEFAULT_MAX_CATCHUP_TICKS` × `MS_PER_TICK` = 5 ×
 *  50ms): advancing by more than this per call would just be silently dropped past the
 *  clamp, so this is the largest step that is never wasted. */
const FAST_FORWARD_STEP_MS = 250;

/** Defensive bound on the fast-forward loop below — at `FAST_FORWARD_STEP_MS` per call
 *  this is far more than the ~39 calls actually needed to reach `FAST_FORWARD_TICK`; it
 *  exists only so a genuine stall (a scenario that stopped advancing) throws loudly
 *  instead of hanging the harness forever. */
const FAST_FORWARD_CALL_LIMIT = 1000;

async function main(): Promise<void> {
  const root = document.getElementById('app');
  if (root === null) throw new Error('missing #app root element');

  // 1) The one genuine validation path — `fetch` + `parseRulesetJson`, exactly like the
  // Node harness's `readFileSync` + `parseRulesetJson` (`packages/perf/src/run.ts`), so
  // both harnesses accept/reject the same bytes through the same compiler. QC round-1
  // fix 9: check `response.ok` before trusting the body — an unchecked 404/500 would
  // feed its error-page HTML/JSON into `parseRulesetJson`, which fails with a compiler
  // error naming no URL and no status, an unnecessarily oblique diagnostic for what is
  // really "the server didn't have this file".
  const response = await fetch(STRESS_RULESET_URL);
  if (!response.ok) {
    throw new Error(
      `failed to fetch the stress ruleset: ${response.status} ${response.statusText} ` +
        `from ${STRESS_RULESET_URL}`,
    );
  }
  const bundleText = await response.text();
  const bundle = parseRulesetJson(bundleText);

  // 2) Wire the REAL app — `sceneFactory` is the real Phaser mount, `schedule` is the
  // real rAF, `controllerFactory` injects the stress bundle through `ControllerContent`
  // (`controller.ts`) instead of the production `getBundledRuleset()` path. The created
  // controller is captured via closure: `createApp` calls `controllerFactory`
  // synchronously before it returns, so `controller` is assigned by the time the call
  // below completes.
  let controller!: Controller;
  createApp(document, root, {
    // P8: a delegating wrapper around the real Phaser mount, bracketing `draw` with the
    // `wy:draw` measure. `RenderHandle` is `{draw, reset, destroy}`; only `draw` is
    // timed — `reset`/`destroy` never run inside the sampled window.
    sceneFactory: (el, geometry) => {
      const handle = mountScene(el, geometry);
      return {
        draw: (prevVm, curVm, alpha, overlay): void => {
          beginSpan('draw');
          handle.draw(prevVm, curVm, alpha, overlay);
          endSpan('draw');
        },
        reset: (): void => {
          handle.reset();
        },
        destroy: (): void => {
          handle.destroy();
        },
      };
    },
    schedule: (onFrame: (nowMs: number) => void) => {
      let id = 0;
      const loop = (now: number): void => {
        onFrame(now);
        id = requestAnimationFrame(loop);
      };
      id = requestAnimationFrame(loop);
      return (): void => cancelAnimationFrame(id);
    },
    now: () => performance.now(),
    seed: 1234,
    controllerFactory: () => {
      controller = createController(1234, { bundle, boardId: STRESS_BOARD_ID }, controllerHooks);
      return controller;
    },
  });

  // QC (the double-boot bug) — this loud guard: `createApp` above must have mounted EXACTLY one
  // `.wy-shell`. `../src/main.ts` no longer auto-boots on import (that side effect
  // moved to `../src/boot-entry.ts`, which this file never imports) — but a comment
  // recording that intent is not a guard, so assert it structurally instead of trusting
  // the import graph to stay that way.
  const shellCount = document.querySelectorAll('.wy-shell').length;
  if (shellCount !== 1) {
    throw new Error(
      `expected exactly one .wy-shell in the document after createApp(), found ` +
        `${shellCount} — a second app instance is mounted, which would silently double ` +
        'every sampled frame (see QC: the double-boot bug).',
    );
  }

  // 3) The measurement surface, exposed BEFORE the maze build so the spec can already
  // poll `ready`/`tick` while it's in flight (useful for diagnosing a stuck run).
  const perf: PerfHarness = {
    ready: false,
    tick: () => controller.frame().curVm.tick,
    phase: () => controller.hud().phase,
    liveCreepCount: () => controller.frame().curVm.creeps.length,
    towerCount: () => controller.frame().curVm.towers.length,
    bounty: () => controller.hud().bounty,
    frameDeltas: [],
    inputLatencies: [],
    startSampling(ms: number): Promise<void> {
      perf.frameDeltas = [];
      // P8: sample-boundary marks. The trace post-processor clips ALL attribution to
      // the [wy:window:start, wy:window:end] interval — tracing itself starts earlier
      // (during warm-up), so the V8 attach storm lands outside anything attributed.
      performance.mark('wy:window:start');
      return new Promise((resolve) => {
        let last = performance.now();
        const start = last;
        const step = (now: number): void => {
          perf.frameDeltas.push(now - last);
          last = now;
          if (now - start < ms) requestAnimationFrame(step);
          else {
            performance.mark('wy:window:end');
            resolve();
          }
        };
        requestAnimationFrame(step);
      });
    },
  };
  window.wyndingPerf = perf;

  // The input-latency probe (see `PerfHarness.inputLatencies`'s doc comment): wired
  // once, here, against whichever Card the Rail mounted first — `createApp` above has
  // already built the Shell DOM synchronously, so both elements exist by this point.
  const armToggle = document.querySelector<HTMLElement>('.wy-card');
  const liveRegion = document.querySelector<HTMLElement>('.wy-sr-only[aria-live="polite"]');
  if (armToggle === null) throw new Error('no .wy-card element found — the Rail did not mount');
  if (liveRegion === null)
    throw new Error('no assistive live region found — the Shell did not mount');
  // QC (the shared-scalar click/mutation race): a FIFO queue of pending click timestamps, resolved in order by
  // each observed live-region mutation — see `PerfHarness.inputLatencies`'s doc comment
  // for why a single shared scalar was wrong.
  const pendingClicks: number[] = [];
  armToggle.addEventListener(
    'pointerdown',
    () => {
      pendingClicks.push(performance.now());
    },
    { capture: true },
  );
  new MutationObserver(() => {
    const clickedAt = pendingClicks.shift();
    if (clickedAt !== undefined) {
      perf.inputLatencies.push(performance.now() - clickedAt);
    }
  }).observe(liveRegion, { childList: true, characterData: true, subtree: true });

  // 4) Build the maze through the real player-intent API (armTower + clickAt), 3
  // placements per tick over 50 ticks — the exact pacing `buildTickInputs` uses, so the
  // browser build matches the committed replay's tower set exactly.
  // `controller.start()` must run first: `advance()` is a no-op while `!started`
  // (PLAN.md P4) — no tick would ever commit the buffered placements otherwise.
  controller.start();
  const anchors = stressAnchors();
  for (let tick = 0; tick < BUILD_TICKS; tick++) {
    for (let i = 0; i < PLACEMENTS_PER_TICK; i++) {
      const index = tick * PLACEMENTS_PER_TICK + i;
      const anchor = anchors[index];
      if (anchor === undefined) {
        throw new Error(`stress layout has fewer than ${index + 1} anchors`);
      }
      // QC (the arm-toggle double-click artifact): `armTower` is a TOGGLE (`controller.ts`: `if (armed ===
      // towerId) { armed = null; return; }`). This guard was written for when
      // `towerIdAt` repeated the same id across consecutive anchors (`blast, blast,
      // chill, …`) — the common case at the time. Since M2-S5b P9's three-way split
      // (`blast, venom, chill, blast, venom, chill, …`), consecutive anchors NEVER
      // repeat, so the arm-toggle path below is unreachable and `armed !== towerId` is
      // always true. Behaviour is unaffected — do not delete the guard; a future
      // layout could reintroduce repeats. Arming
      // unconditionally meant a REJECTED placement (which leaves `armed` unchanged)
      // followed by the next same-id anchor's `armTower` call actually DISARMED,
      // turning one rejection into two: the second anchor's `clickAt` then placed
      // nothing either. Only arm when not already armed with this exact id — the same
      // guard `apps/web/src/input.ts` already uses for its own drag-from-rail path.
      const towerId = towerIdAt(index);
      if (controller.uiState().armed !== towerId) controller.armTower(towerId);
      controller.clickAt(anchor.col, anchor.row);
    }
    controller.advance(MS_PER_TICK); // commits exactly this tick's 3 placements
  }

  // 5) Fast-forward to peak load (PLAN step 22's non-obvious part): the wave launches
  // at tick 100 and the last creep spawns at tick 1900, so sampling in real time would
  // take ~95s of wall clock. The fixed loop clamps catch-up at `FAST_FORWARD_STEP_MS`,
  // so this is ~39 calls and completes in well under a second — only THEN does rAF
  // sampling begin (the spec calls `startSampling` explicitly, after seeing `ready`).
  let guard = 0;
  while (perf.tick() < FAST_FORWARD_TICK) {
    controller.advance(FAST_FORWARD_STEP_MS);
    guard++;
    if (guard > FAST_FORWARD_CALL_LIMIT) {
      throw new Error(
        `fast-forward did not reach tick ${FAST_FORWARD_TICK} after ${guard} calls — ` +
          `stuck at tick ${perf.tick()}`,
      );
    }
  }

  perf.ready = true;
}

// QC (surfacing main-perf.ts's loud failure paths): every loud failure path above (`throw new Error(...)`) used to be
// discarded by a bare `void main()` with no `.catch` — the promise it returns simply
// went unhandled, and the spec (which had no `page.on('pageerror')` listener either)
// never saw it. The run instead failed minutes later on `waitForFunction`'s generic
// "ready never became true" timeout, with no diagnostic at all. Re-throwing from a
// macrotask (rather than merely letting the rejection go unhandled, or throwing again
// inside the `.catch` itself — both of which stay an unhandled PROMISE rejection)
// guarantees an actual uncaught EXCEPTION, which `page.on('pageerror')` always reports.
main().catch((err: unknown) => {
  setTimeout(() => {
    throw err;
  });
});
