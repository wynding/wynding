// paths.ts — a read-only query over a running match: the current ground path from one
// entrance to its destination (M3 story 3, for the balance checker's merged-or-separate
// classification of a two-route build, and `@wynding/perf`'s route oracles).
//
// It composes the sim's own public pipeline — the tower mask, the destination's
// distance field, the canonical descent — exactly as `step` derives a creep's route, so
// the cells it returns are the ones a ground creep leaving that entrance would walk
// right now. Nothing here is cached or written back: it is a pure function of
// `(ruleset, towers)`.

import type { Cell } from '@wynding/types';
import {
  computeDistanceField,
  materializeTowerMask,
  shortestPath,
  type CompiledRuleset,
  type TowerValidityView,
} from '@wynding/sim';

/**
 * The current ground path from entrance `entrance` — an INDEX into the board's
 * `entrances`, in the bundle's authored order — to ITS OWN destination's exit, under
 * `state`'s towers (a `SimState`, or any `{ towers }` view, e.g. a planned layout): an
 * ordered cell list beginning at the entrance and ending at the exit. The maze
 * invariant guarantees one exists for every entrance of a state `step` produced; `null`
 * can only mean a forged state. Throws on an entrance index the board does not have —
 * a checker asking for one is a fixture bug, not a "no path" answer.
 */
export function currentPath(
  ruleset: CompiledRuleset,
  state: { readonly towers: TowerValidityView },
  entrance: number,
): Cell[] | null {
  const { grid, fields, entranceDestination } = ruleset.board;
  const from = grid.entrances[entrance];
  const destination = entranceDestination[entrance];
  if (from === undefined || destination === undefined) {
    throw new Error(
      `currentPath: board has no entrance ${entrance} (it has ${grid.entrances.length})`,
    );
  }
  const mask = materializeTowerMask(grid, state.towers, ruleset.towerById);
  const field = computeDistanceField(grid, fields[destination]!.exit, mask);
  return shortestPath(grid, field, from);
}
