// main-perf-catalog.ts — the CATALOG scene's perf-only browser entry point (M2-S11 P7).
//
// A sibling of `main-perf.ts`, never a parameterization of it. The two scenes differ in
// bundle, board, placement table and warm-up target, and — more importantly — the whole
// point of the catalog scene is that its measurement must not share a process (here, a
// page) with the stress scene's, or one warms the other. Two entry modules, two HTML
// pages (`vite.perf.config.ts`'s two rollup inputs), two Playwright specs.
//
// What it shares with `main-perf.ts` is everything that must never diverge: the real
// `createApp` / `createController` / Phaser mount, the real player-intent build loop
// (`armTower` + `clickAt`), the same `BUILD_TICKS` × `PLACEMENTS_PER_TICK` pacing, and
// the same `catalogTowerIdAt` table the Node driver places from — so the browser and Node
// scenes are the same maze by construction rather than by coincidence.
//
// RECORDED-ONLY, deliberately not a CI gate — same posture as `main-perf.ts`.

import { parseRulesetJson } from '@wynding/sim';
import { CATALOG_RULESET_URL, CATALOG_BOARD_ID } from '@wynding/content/catalog';
import {
  catalogPlacements,
  CATALOG_BUILD_TICKS,
  CATALOG_TOWER_COUNT,
  PLACEMENTS_PER_TICK,
  CATALOG_SEED,
  CATALOG_SAMPLE_START_TICK,
} from '@wynding/perf';
import { mount as mountScene } from '@wynding/render/scene';
import { createApp } from '../src/main';
import { createController, type Controller, type ControllerHooks } from '../src/controller';

// Semantic trace markers — identical mechanism to `main-perf.ts`'s (see that file for
// the full rationale and the buffer-drain requirement). Duplicated rather than shared
// because these six lines are the entire mechanism and a shared module between two
// perf entry points would be a third file to keep in step with both.
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

/** The catalog scene's measurement surface. Structurally the same shape
 *  `main-perf.ts` installs (the spec files declare it locally, per that file's note),
 *  so a reader moving between the two specs sees one contract. */
export interface CatalogPerfHarness {
  ready: boolean;
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
    wyndingPerfCatalog?: CatalogPerfHarness;
  }
}

/** The catalog scene's own sample-window opening tick (1055 = 55 build ticks + the
 *  1000-tick `CATALOG_WARMUP_AFTER_BUILD_TICKS` settle), imported from the Node oracle
 *  rather than restated so the browser and Node scenes open their windows at the same
 *  tick. */
const FAST_FORWARD_TICK = CATALOG_SAMPLE_START_TICK;

/** `@wynding/engine`'s `DEFAULT_MS_PER_TICK`. */
const MS_PER_TICK = 50;
/** The fixed loop's catch-up clamp (5 × 50ms) — the largest never-wasted step. */
const FAST_FORWARD_STEP_MS = 250;
/** Defensive bound so a stalled fast-forward throws loudly instead of hanging. */
const FAST_FORWARD_CALL_LIMIT = 1000;

async function main(): Promise<void> {
  const root = document.getElementById('app');
  if (root === null) throw new Error('missing #app root element');

  const response = await fetch(CATALOG_RULESET_URL);
  if (!response.ok) {
    throw new Error(
      `failed to fetch the catalog ruleset: ${response.status} ${response.statusText} ` +
        `from ${CATALOG_RULESET_URL}`,
    );
  }
  const bundle = parseRulesetJson(await response.text());

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
    seed: CATALOG_SEED,
    controllerFactory: () => {
      controller = createController(
        CATALOG_SEED,
        { bundle, boardId: CATALOG_BOARD_ID },
        controllerHooks,
      );
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

  const perf: CatalogPerfHarness = {
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
  window.wyndingPerfCatalog = perf;

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

  // The maze, through the real player-intent API, at the identical pacing the committed
  // catalog replay uses — the same `catalogPlacements()` list, in the same order, so the
  // browser scene and the Node scene are the same 165 towers by construction rather than
  // by coincidence. 55 build ticks × 3 placements, all inside the wave's 100-tick
  // countdown.
  controller.start();
  const placements = catalogPlacements();
  if (placements.length !== CATALOG_TOWER_COUNT) {
    throw new Error(
      `catalog layout has ${placements.length} placements, expected ${CATALOG_TOWER_COUNT}`,
    );
  }
  for (let tick = 0; tick < CATALOG_BUILD_TICKS; tick++) {
    for (let i = 0; i < PLACEMENTS_PER_TICK; i++) {
      const index = tick * PLACEMENTS_PER_TICK + i;
      const placement = placements[index];
      if (placement === undefined) {
        throw new Error(`catalog layout has fewer than ${index + 1} placements`);
      }
      // `armTower` is a TOGGLE — arm only when not already armed with this exact id, or
      // a run of the same id across consecutive placements would disarm instead of arming
      // (see `main-perf.ts`'s note). The catalog list DOES carry such runs — placements
      // 150..164 are all `mine` — so unlike the stress table this guard is genuinely live
      // here, not merely defensive.
      if (controller.uiState().armed !== placement.towerId) {
        controller.armTower(placement.towerId);
      }
      controller.clickAt(placement.anchor.col, placement.anchor.row);
    }
    controller.advance(MS_PER_TICK);
  }

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

main().catch((err: unknown) => {
  setTimeout(() => {
    throw err;
  });
});
