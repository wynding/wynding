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

/** The stress scenario: 50 `stress-blast` + 50 `stress-chill` + 50 `stress-venom`, per
 *  `towerIdAt`'s assignment — the scene ADR 0005's budgets are measured against. */
export function buildStressReplay(bundle: Ruleset): Replay {
  return {
    seed: STRESS_SEED,
    boardId: STRESS_BOARD_ID,
    rulesetHash: currentRulesetHash(bundle),
    simVersion: SIM_VERSION,
    tickInputs: buildTickInputs(towerIdAt),
  };
}

/** The control scenario: identical anchors, order, and pacing, but every AoE tower is
 *  swapped for its blast-free SINGLE-FORM TWIN — `stress-blast` -> `stress-single`,
 *  `stress-chill` -> `stress-chill-single` — Phase 3's control workload for the ratio
 *  gate (PLAN step 21). `stress-venom` maps to ITSELF, unchanged: it is already
 *  blast-free (`form: single`, no `radiusFp` — see `stress.test.ts`), so it has no
 *  single-form twin to map to and none is needed. Each AoE twin matches its stress-side
 *  counterpart on cost, cadence, travel, damage, and — for the chill pair — the same
 *  `slow` effect DEFINITION (same `mulFp`, same duration). QC: an earlier draft mapped
 *  every tower to `stress-single` regardless of kind, which dropped the `slow` effect
 *  from the control entirely — 0 peak slowed creeps against the stress run's 304. A
 *  later, DoT-era draft of that same mistake would have sent `stress-venom` through the
 *  same fallback to `stress-single`, stripping the DoT from the control arm entirely: a
 *  DoT-free control would put DoT exclusively in the ratio's numerator, and `R` would
 *  silently start measuring DoT overhead on top of the blast difference it is defined to
 *  isolate. That is why `stress-venom` gets its own explicit arm below rather than
 *  falling through the `else`.
 *
 *  This is NOT, and cannot be, a genuine one-dimension control. The direct effect that
 *  changes for the AoE pair is `form` (`aoe` -> `single`), but that necessarily changes
 *  how many creeps RECEIVE the slow: `stress-chill` hits every creep in a radius,
 *  `stress-chill-single` hits one creep per impact. A single-form twin can never
 *  reproduce an area effect's coverage — that is structural, not a tuning gap. And slow
 *  coverage feeds straight into population, because an unslowed creep traverses faster
 *  and leaks sooner. Measured over the identical 2,500-tick sampled window: matching the
 *  chill pair's slow definition narrowed the control's live-creep median from 160 to 181
 *  against the stress run's 224 (a population gap of ~28.6% down to ~19.2%), and its
 *  peak slowed creeps from 0 to 109 against the stress run's 304 (~36% as many). It did
 *  not, and could not, close either gap.
 *
 *  Identical definitions do NOT produce identical work, and `stress-venom` mapping to
 *  itself is the sharpest example: the two arms carry different creep populations by
 *  construction (the control's median live creeps is 181 against the stress arm's 224),
 *  so the same `stress-venom` definition applies a different NUMBER of DoTs on each
 *  side even though the tower definition it fires from is byte-identical. Mapping
 *  `stress-venom` to itself fixes what the control *contains*; it does not, and cannot,
 *  make the DoT workload the two arms carry equal.
 *
 *  So what `R` isolates is blast cost PLUS blast-borne slow coverage together — not
 *  blast cost alone, and DoT overhead now rides identically defined (not identically
 *  sized) in both arms rather than being a numerator-only cost. That is the honest scope
 *  of what this ratio measures; do not describe it elsewhere as isolating "just" blast
 *  cost. Same anchors, same order, same `PLACEMENTS_PER_TICK`-per-tick pacing, same
 *  total cost (150 × 12 = 1800) either way. */
export function buildControlReplay(bundle: Ruleset): Replay {
  return {
    seed: STRESS_SEED,
    boardId: STRESS_BOARD_ID,
    rulesetHash: currentRulesetHash(bundle),
    simVersion: SIM_VERSION,
    tickInputs: buildTickInputs((index) => {
      const stressId = towerIdAt(index);
      if (stressId === 'stress-chill') return 'stress-chill-single';
      if (stressId === 'stress-venom') return 'stress-venom';
      return 'stress-single';
    }),
  };
}

/** The `dot-bench` scenario: identical anchors, order, and pacing to
 *  `buildControlReplay`, but with `stress-venom` ALSO mapped away — through the same
 *  `else` fallback as `stress-blast`, to `stress-single`, since `stress-venom` has no
 *  single-form twin of its own (`stress-venom-single` does not exist in the catalog —
 *  see `stress.test.ts`). This mapper is **exactly the pre-P9 control mapper** —
 *  `towerIdAt(index) === 'stress-chill' ? 'stress-chill-single' : 'stress-single'` —
 *  every tower becomes a blast-free, DoT-free single-form twin.
 *
 *  This is `dot-bench`'s scene, NOT the ratio gate's: `buildControlReplay` above is
 *  `gate.ts`'s control arm, and deliberately keeps `stress-venom` unchanged so that
 *  DoT overhead is not numerator-only (see that function's doc for why). But
 *  `dot-bench.ts` exists to isolate the cost of a full resident `dots` table against
 *  an empty one — it fills the table itself, on both arms, and needs a scene where
 *  the table stays empty on its own so the "empty" arm is genuinely empty rather than
 *  carrying whatever real DoT records the scene's own venom towers accumulate. A
 *  baseline that carries its own real records measures neither end of that comparison
 *  cleanly.
 *
 *  `buildControlReplay` and this function were the SAME function until M2-S5b P9 gave
 *  the stress scene a DoT-bearing tower — they diverged because the ratio gate and
 *  the DoT bench need opposite things from `stress-venom`: the gate needs it to keep
 *  the venom arm's real DoT cost in the control (so DoT does not fall entirely on the
 *  stress side of `R`), and the bench needs it GONE (so the "empty" arm actually
 *  starts empty and stays that way until the bench itself fills it). Do not
 *  re-merge them. */
export function buildDotFreeReplay(bundle: Ruleset): Replay {
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
