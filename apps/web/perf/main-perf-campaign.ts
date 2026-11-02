// main-perf-campaign.ts — the CAMPAIGN scene's perf-only browser entry point (M3 story 8).
//
// A sibling of `main-perf.ts` and `main-perf-catalog.ts`, never a parameterization of either:
// its own page, its own entry module, its own Playwright spec, so no scene's run warms or
// downloads another's. Where those two scenes are synthetic ceilings, this one is the shipped
// game: the registry's own bundle and default board — the crossing board's thirty waves — and
// the strongest reference build, the serpentine (`packages/content`'s `M3_SERPENTINE`),
// played through the REAL controller the way a player plays it, arm then click, by
// `playScript` (`../src/scripted-run.ts`) on the content runner's greedy rule. That driver
// stops at the densest stretch's first tick (`@wynding/perf`'s `CAMPAIGN_SAMPLE_START_TICK`,
// re-derived in Node by `campaign.test.ts`), and from there the app's own rAF loop runs the
// sim at 1× while the spec times frames.
//
// The board is captured AT that tick, before any frame runs (`atStart`), because the loop
// moves the sim on the moment this module returns: the spec checks the capture against the
// Node oracle's `CAMPAIGN_AT_START` — every tower, the bounty, the creeps alive — so the
// browser's run is the Node run to the tick before a frame time means anything.
//
// The serpentine and its compiler are reached by relative path, as the e2e results harness
// reaches the content package's showcase build: its `exports` map has no subpath for them.
//
// RECORDED-ONLY, deliberately not a CI gate — same posture as `main-perf.ts`.

import { compileRuleset } from '@wynding/sim';
import { defaultBoardId, getBundledRuleset } from '@wynding/content';
import { CAMPAIGN_SAMPLE_START_TICK } from '@wynding/perf';
import { mount as mountScene } from '@wynding/render/scene';
import { compileReferenceBuild } from '../../../packages/content/src/reference-build';
import { M3_CROSSING, M3_SERPENTINE } from '../../../packages/content/src/reference-builds';
import { createApp, rafScheduler } from '../src/main';
import { createController, type Controller, type ControllerHooks } from '../src/controller';
import { playScript, type ScriptedPlacement } from '../src/scripted-run';

// Semantic trace markers — the same six-line mechanism `main-perf-catalog.ts` duplicates
// from `main-perf.ts` (see that file for the rationale and the buffer-drain requirement).
const SPAN_MARK_PREFIX = 'wy:';

function beginSpan(name: string): void {
  performance.mark(`${SPAN_MARK_PREFIX}${name}:b`);
}
function endSpan(name: string): void {
  const measureName = `${SPAN_MARK_PREFIX}${name}`;
  const markName = `${measureName}:b`;
  performance.measure(measureName, markName);
  performance.clearMeasures(measureName);
  performance.clearMarks(markName);
}

const controllerHooks: ControllerHooks = {
  begin: (span) => beginSpan(span),
  end: (span) => endSpan(span),
};

/** The board when the driver hands over, read before any frame runs. */
export interface CampaignBoard {
  readonly tick: number;
  readonly towers: number;
  readonly bounty: number;
  readonly liveCreeps: number;
}

/** The campaign scene's measurement surface: the catalog scene's shape, plus the board at
 *  hand-over (`atStart`) and how many of the plan's towers the driver placed. */
export interface CampaignPerfHarness {
  ready: boolean;
  atStart: CampaignBoard | null;
  placed: number;
  planLength: number;
  tick(): number;
  phase(): string;
  liveCreepCount(): number;
  towerCount(): number;
  bounty(): number;
  startSampling(ms: number): Promise<void>;
  frameDeltas: number[];
  inputLatencies: number[];
}

declare global {
  interface Window {
    wyndingPerfCampaign?: CampaignPerfHarness;
    /** Set when `main()` throws, so the spec stops waiting and reports why. */
    wyndingPerfCampaignError?: string;
  }
}

function main(): void {
  const root = document.getElementById('app');
  if (root === null) throw new Error('missing #app root element');

  const bundle = getBundledRuleset();
  const boardId = defaultBoardId(bundle);
  if (bundle.rulesetId !== M3_CROSSING.rulesetId || boardId !== M3_CROSSING.boardId) {
    throw new Error(
      `the shipped default is ${bundle.rulesetId} / ${boardId}, not the reference set's ` +
        `${M3_CROSSING.rulesetId} / ${M3_CROSSING.boardId}`,
    );
  }
  const plan: ScriptedPlacement[] = compileReferenceBuild(
    M3_SERPENTINE,
    compileRuleset(bundle, boardId),
  ).map((step) => {
    if (step.kind === 'sell' || step.notBeforeTick !== undefined) {
      throw new Error('the campaign scene plays a plan with no timed step and no sell');
    }
    return { col: step.col, row: step.row, towerId: step.towerId };
  });

  let controller!: Controller;
  createApp(document, root, {
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
        needsRemount: (): boolean => handle.needsRemount(),
        destroy: (): void => {
          handle.destroy();
        },
      };
    },
    schedule: rafScheduler, // the app's own, as `boot()` passes it
    now: () => performance.now(),
    seed: M3_CROSSING.seed,
    controllerFactory: () => {
      controller = createController(M3_CROSSING.seed, { bundle, boardId }, controllerHooks);
      return controller;
    },
  });

  // The double-boot guard, for the same reason `main-perf.ts` carries it.
  const shellCount = document.querySelectorAll('.wy-shell').length;
  if (shellCount !== 1) {
    throw new Error(
      `expected exactly one .wy-shell in the document after createApp(), found ${shellCount}`,
    );
  }

  const perf: CampaignPerfHarness = {
    ready: false,
    atStart: null,
    placed: 0,
    planLength: plan.length,
    tick: () => controller.frame().curVm.tick,
    phase: () => controller.hud().phase,
    liveCreepCount: () => controller.frame().curVm.creeps.length,
    towerCount: () => controller.frame().curVm.towers.length,
    bounty: () => controller.hud().bounty,
    frameDeltas: [],
    inputLatencies: [],
    startSampling(ms: number): Promise<void> {
      perf.frameDeltas = [];
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
  window.wyndingPerfCampaign = perf;

  const armToggle = document.querySelector<HTMLElement>('.wy-card');
  const liveRegion = document.querySelector<HTMLElement>('.wy-sr-only[aria-live="polite"]');
  if (armToggle === null) throw new Error('no .wy-card element found — the Rail did not mount');
  if (liveRegion === null)
    throw new Error('no assistive live region found — the Shell did not mount');
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

  // The serpentine, one tick per step, to the window's first tick — synchronously, so no
  // frame of the app's loop runs in between and the capture below is the board at that tick.
  perf.placed = playScript(controller, plan, CAMPAIGN_SAMPLE_START_TICK);
  perf.atStart = {
    tick: perf.tick(),
    towers: perf.towerCount(),
    bounty: perf.bounty(),
    liveCreeps: perf.liveCreepCount(),
  };
  perf.ready = true;
}

try {
  main();
} catch (err: unknown) {
  // Recorded for the spec, which would otherwise wait out its whole setup timeout on a page
  // that will never be ready, then rethrown as a page error as the other scenes do.
  window.wyndingPerfCampaignError = err instanceof Error ? err.message : String(err);
  setTimeout(() => {
    throw err;
  });
}
