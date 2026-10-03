// scripted-run.ts — TEST SUPPORT, never imported by the shipped graph (#181 H2): play a build
// script through a REAL controller, the way a player does it — arm the tower, click the cell —
// on the content package's greedy rule (`packages/content/src/script-runner.ts`): place the
// script's next tower on the first tick its cost is covered, and move on once it is accepted.
//
// It exists so the results panel can be checked against runs whose outcome is already proven
// elsewhere: the content package's showcase build (`showcase-builds.ts`'s WINNER_A) wins the
// arc, and its 12-tower prefix loses it (`apps/server`'s replay-parity fixture). Driven through
// the controller on the same seed, a script produces the same per-tick inputs the content
// runner feeds `step()`: the controller's placement check runs the sim's own input phase on the
// same state, so it accepts exactly what the sim would. `controller.test.ts` holds that claim
// to the final tick, and the e2e results harness (`e2e-harness/results-entry.ts`) uses it to
// reach a real win in a browser.

import { MS_PER_TICK } from '@wynding/sim';
import type { Controller } from './controller';

/** One scripted build — the content package's `Placement` shape, restated so nothing shipped
 *  ever has a reason to import the content package's test-support module. */
export interface ScriptedPlacement {
  readonly col: number;
  readonly row: number;
  readonly towerId: string;
}

/** Start `controller` and play `plan` until the run resolves (or `maxTicks` pass), one tick
 *  per step at 1×. Returns how many placements were accepted, in script order — the content
 *  runner's `placedCount`. Throws on a tower id the catalog does not know, as that runner does.
 *  Never claims a wave early: every wave launches on its own countdown, as in the runner. */
export function playScript(
  controller: Controller,
  plan: readonly ScriptedPlacement[],
  maxTicks = 20_000,
): number {
  controller.start();
  let cursor = 0;
  for (let t = 0; t < maxTicks && !controller.isTerminal(); t++) {
    const next = plan[cursor];
    if (next !== undefined) {
      const cost = controller.ruleset.towerById[next.towerId]?.cost;
      if (cost === undefined) throw new Error(`unknown towerId '${next.towerId}' in a script`);
      if (controller.hud().bounty >= cost) {
        // A rejected click leaves the tower armed, and arming the armed tower again would
        // DISARM it — so arm only when it is not already.
        if (controller.uiState().armed !== next.towerId) controller.armTower(next.towerId);
        const before = controller.uiState().outcomeSeq;
        controller.clickAt(next.col, next.row);
        const after = controller.uiState();
        if (after.outcomeSeq !== before && after.lastOutcome?.kind === 'placed') cursor++;
      }
    }
    controller.advance(MS_PER_TICK);
  }
  return cursor;
}
