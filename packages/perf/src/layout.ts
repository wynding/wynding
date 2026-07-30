// layout.ts — the scripted stress maze (PLAN step 17, HANDOFF-M2-S4B.md "Specific to
// S4b"). Every anchor and constant in this file is a MEASURED result, verified
// end-to-end against the real sim before being written down — not re-derived here, not
// re-tuned. If a test in `layout.test.ts` disagrees with a number below, that is a
// reproduction failure to report, not a cue to adjust either side.
//
// The maze is two layers:
//   1. Eight vertical bands (144 anchors) — the structural skeleton. Each band is a
//      column of towers with exactly one 2-cell gap, and consecutive bands put that gap
//      at opposite ends of the board, so a creep crossing from one band to the next must
//      travel the board's full height. This is what turns a 40×40 board into a long
//      route instead of a short one.
//   2. Six tail baffles (the last 6 anchors) — NOT part of the structural pattern above.
//      They were found by a greedy search over every remaining legal anchor, each step
//      picking whichever single placement grew the route length the most. They look
//      arbitrary because they are: a hand-drawn shape could not have found them, and
//      re-deriving "why col 25, row 36" from first principles is not possible — they are
//      the output of a search, not a design. They buy the route from 307 → 329 cells.

import {
  materializeTowerMask,
  computeDistanceField,
  shortestPath,
  type CompiledRuleset,
  type TowerValidityView,
} from '@wynding/sim';

/** The eight vertical band columns (anchor col, i.e. the band's left edge). */
export const BAND_COLS = [2, 5, 8, 11, 14, 17, 20, 23] as const;

/** Candidate anchor rows within a band, before that band's one dropped row. Rows
 *  1..37 odd, i.e. every other row from the top of the buildable interior (row 1) to
 *  near its bottom (row 38) — 19 candidates, each anchor's 2×2 footprint stacking
 *  cleanly against its neighbours with no overlap. */
function bandCandidateRows(): readonly number[] {
  const rows: number[] = [];
  for (let row = 1; row <= 37; row += 2) {
    rows.push(row);
  }
  return rows;
}

/** The six tail baffles, appended after the eight bands, in this exact order — see the
 *  header comment above for what they are and why they cannot be re-derived. */
export const TAIL_BAFFLES = [
  { col: 25, row: 36 },
  { col: 37, row: 21 },
  { col: 35, row: 19 },
  { col: 33, row: 17 },
  { col: 31, row: 15 },
  { col: 29, row: 13 },
] as const;

/** The full 150-anchor stress layout: eight bands (144 anchors, top-to-bottom within
 *  each band, band by band in `BAND_COLS` order), then the six tail baffles. Each
 *  anchor is a 2×2 footprint's top-left corner — the footprint also covers (col+1,row),
 *  (col,row+1), (col+1,row+1), matching the sim's own `FOOTPRINT_DELTAS`
 *  (`packages/sim/src/tower.ts`). */
export function stressAnchors(): readonly { col: number; row: number }[] {
  const candidateRows = bandCandidateRows();
  const anchors: { col: number; row: number }[] = [];
  BAND_COLS.forEach((col, b) => {
    // Each band drops exactly one row to leave a 2-cell gap for creeps to pass
    // through. Even bands drop the first row, odd bands drop the last, so consecutive
    // bands' gaps sit at opposite ends of the board and a creep must cross the full
    // board height to get from one band's gap to the next.
    const rows = b % 2 === 0 ? candidateRows.slice(1) : candidateRows.slice(0, -1);
    for (const row of rows) {
      anchors.push({ col, row });
    }
  });
  for (const baffle of TAIL_BAFFLES) {
    anchors.push({ col: baffle.col, row: baffle.row });
  }
  return anchors;
}

/** The tower catalog id to place at a given index in `stressAnchors()`'s order. Every
 *  third anchor (index 2, 5, 8, …) is `stress-chill`; the rest are `stress-blast` — 100
 *  blast + 50 chill over 150 anchors. Both towers cost 12, so 150 × 12 = 1800 exactly
 *  matches the bundle's `startingBounty` (`stress-40x40.json`'s `balance.startingBounty`).
 *  That equality is a second, independent oracle beyond "the compiler accepted the
 *  bundle": if the leftover bounty after all 150 placements is exactly 0, every single
 *  placement was accepted (an insufficient-bounty or illegal-anchor placement is a
 *  deterministic no-op per PLAN step 18 — it would silently leave bounty unspent
 *  instead of throwing), so a non-zero leftover would be the tell. */
export function towerIdAt(index: number): string {
  return index % 3 === 2 ? 'stress-chill' : 'stress-blast';
}

/**
 * The scripted stress maze's route length against `compiled`'s grid — entrance to
 * exit, built on the sim's OWN `materializeTowerMask` (`@wynding/sim`, `tower.ts`), the
 * exact function `step()` itself uses to derive the tower-blocked mask. QC: `run.ts`
 * and `layout.test.ts`'s route-length check used to each hand-copy `tower.ts`'s
 * PRIVATE `FOOTPRINT_DELTAS` constant into a local mask-building loop — byte-identical
 * copies that could therefore only ever be wrong TOGETHER, which defeats the stated
 * point of having two independent computations. Routing both call sites through this
 * one function, built on the exported `materializeTowerMask`, makes THAT drift
 * (route length specifically) structurally impossible instead of merely unlikely.
 * `layout.test.ts` separately keeps its OWN small `FOOTPRINT_DELTAS` copy for an
 * unrelated non-overlap check that this function does not perform — see that file's
 * comment for why that one still exists.
 *
 * Computed from the INTENDED layout (`stressAnchors()`/`towerIdAt()`), not from a run's
 * realized `state.towers` — see `oracle.ts`'s `OracleInput` doc for what that means
 * this can and cannot detect. The synthetic `TowerValidityView` below is built directly
 * from the anchors and `towerIdAt`, with no live sim state involved.
 */
export function stressRouteLength(compiled: CompiledRuleset): number {
  const grid = compiled.board.grid;
  const anchors = stressAnchors();
  const towers: TowerValidityView = {
    id: anchors.map((_, i) => i + 1),
    col: anchors.map((a) => a.col),
    row: anchors.map((a) => a.row),
    spend: anchors.map((_, i) => {
      const def = compiled.towerById[towerIdAt(i)];
      if (def === undefined) {
        throw new Error(`stressRouteLength: unknown tower id at index ${i}`);
      }
      return def.cost;
    }),
    towerId: anchors.map((_, i) => towerIdAt(i)),
  };
  const mask = materializeTowerMask(grid, towers, compiled.towerById);
  const field = computeDistanceField(grid, mask);
  const path = shortestPath(grid, field, grid.entrance);
  return path === null ? 0 : path.length;
}
