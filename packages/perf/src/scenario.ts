// scenario.ts — the two committed stress-scene replays (PLAN step 17).
//
// Both builders return a `Replay` (`@wynding/replay`'s wire format) rather than a
// bespoke driver of `step()` directly: a `Replay` is the same envelope the server's
// replay validator re-simulates, so building the scenario this way means the perf
// harness measures the real replay path — the one untrusted client submissions
// actually go through — instead of a shortcut that could silently diverge from it.

import type { Ruleset } from '@wynding/types';
import { currentRulesetHash, type Replay } from '@wynding/replay';
import { SIM_VERSION, type SimInput } from '@wynding/sim';
import { STRESS_BOARD_ID } from '@wynding/content/stress';
import { stressAnchors, towerIdAt } from './layout';

/** The fixed seed both scenarios run under — arbitrary but pinned, so the committed
 *  replays (and everything measured against them) are reproducible byte-for-byte. */
const STRESS_SEED = 1234;

/** Ticks 0..`BUILD_TICKS`-1 — the build-tick prefix shared by both scenarios, all 150
 *  anchors landing inside the wave's 100-tick countdown so the maze is fully built and
 *  static before the first creep spawns. Exported (via `@wynding/perf`'s barrel) so
 *  `apps/web/perf/main-perf.ts`'s browser build paces its own placements identically
 *  instead of duplicating the literal (QC round-1 finding: it used to). */
export const BUILD_TICKS = 50;
/** `placeTower` inputs issued per build tick — `BUILD_TICKS * PLACEMENTS_PER_TICK` =
 *  150, `stressAnchors()`'s full anchor count. */
export const PLACEMENTS_PER_TICK = 3;

/** Builds the `BUILD_TICKS`-tick, 150-input `tickInputs` prefix shared by both
 *  scenarios, each placement's `towerId` chosen by `towerId(index)`. */
function buildTickInputs(towerId: (index: number) => string): SimInput[][] {
  const anchors = stressAnchors();
  const tickInputs: SimInput[][] = [];
  for (let tick = 0; tick < BUILD_TICKS; tick++) {
    const inputs: SimInput[] = [];
    for (let i = 0; i < PLACEMENTS_PER_TICK; i++) {
      const index = tick * PLACEMENTS_PER_TICK + i;
      const anchor = anchors[index];
      if (anchor === undefined) {
        throw new Error(`stress layout has fewer than ${index + 1} anchors`);
      }
      inputs.push({ kind: 'placeTower', anchor, towerId: towerId(index) });
    }
    tickInputs.push(inputs);
  }
  return tickInputs;
}

/** The stress scenario: 100 `stress-blast` + 50 `stress-chill`, per `towerIdAt`'s
 *  assignment — the scene ADR 0005's budgets are measured against. */
export function buildStressReplay(bundle: Ruleset): Replay {
  return {
    seed: STRESS_SEED,
    boardId: STRESS_BOARD_ID,
    rulesetHash: currentRulesetHash(bundle),
    simVersion: SIM_VERSION,
    tickInputs: buildTickInputs(towerIdAt),
  };
}

/** The control scenario: identical anchors, order, and pacing, but every tower is
 *  swapped for its blast-free SINGLE-FORM TWIN — `stress-blast` -> `stress-single`,
 *  `stress-chill` -> `stress-chill-single` — Phase 3's control workload for the ratio
 *  gate (PLAN step 21). Each twin matches its stress-side counterpart on cost, cadence,
 *  travel, damage, and — for the chill pair — the same `slow` effect DEFINITION (same
 *  `mulFp`, same duration). QC: an earlier draft mapped every tower to `stress-single`
 *  regardless of kind, which dropped the `slow` effect from the control entirely — 0
 *  peak slowed creeps against the stress run's 304.
 *
 *  This is NOT, and cannot be, a genuine one-dimension control. The direct effect that
 *  changes is `form` (`aoe` -> `single`), but that necessarily changes how many creeps
 *  RECEIVE the slow: `stress-chill` hits every creep in a radius, `stress-chill-single`
 *  hits one creep per impact. A single-form twin can never reproduce an area effect's
 *  coverage — that is structural, not a tuning gap. And slow coverage feeds straight
 *  into population, because an unslowed creep traverses faster and leaks sooner.
 *  Measured over the identical 2,500-tick sampled window: matching the chill pair's
 *  slow definition narrowed the control's live-creep median from 160 to 181 against the
 *  stress run's 224 (a population gap of ~28.6% down to ~19.2%), and its peak slowed
 *  creeps from 0 to 109 against the stress run's 304 (~36% as many). It did not, and
 *  could not, close either gap.
 *
 *  So what `R` isolates is blast cost PLUS blast-borne slow coverage together — not
 *  blast cost alone. That is the honest scope of what this ratio measures; do not
 *  describe it elsewhere as isolating "just" blast cost. Same anchors, same order, same
 *  `PLACEMENTS_PER_TICK`-per-tick pacing, same total cost (150 × 12 = 1800) either
 *  way. */
export function buildControlReplay(bundle: Ruleset): Replay {
  return {
    seed: STRESS_SEED,
    boardId: STRESS_BOARD_ID,
    rulesetHash: currentRulesetHash(bundle),
    simVersion: SIM_VERSION,
    tickInputs: buildTickInputs((index) =>
      towerIdAt(index) === 'stress-chill' ? 'stress-chill-single' : 'stress-single',
    ),
  };
}
