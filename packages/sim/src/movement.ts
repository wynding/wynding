// movement.ts — grid path-following creep movement. Pure, deterministic,
// integer-only, like the rest of the sim core.
//
// A creep occupies a cell `(col,row)` and carries `edgeProgress`: how far, in
// fixed-point units, it has travelled from that cell toward the next descent cell
// (the neighbour the distance field routes it to). Each tick it spends a fixed
// movement budget along the gradient; when progress reaches the edge length it
// snaps to the next cell and the remainder carries onto the following edge, so
// speed stays constant regardless of where cell boundaries fall.
//
// The follower re-derives its target from the field every step rather than storing
// a per-creep path, so a re-path (Story 3 recomputes the field) is picked up for
// free with no stored-path invalidation. Caveat for Story 3: a creep mid-edge when
// the field changes carries an `edgeProgress` measured on the OLD edge; if the new
// descent is a shorter edge (diagonal→orthogonal), `edgeProgress >= edgeLen` would
// drop it here. Story 3 owns that transition (clamp/complete the current edge before
// re-pathing); Story 2's static per-match field never hits it.

import { ORTHO_COST, DIAG_COST, forEachPassableNeighbor } from './board';
import { FP_ONE } from '@wynding/engine';
import { blockedAt, distAt } from './field-access';
import type { DistanceField } from './pathfinding';

/**
 * Fixed-point length of one edge as *traversed* by a creep. Distinct from the
 * field's `10/14` routing weights: a diagonal genuinely takes ≈1.41× an
 * orthogonal step to cross (`round(256·√2)`), matching the Euclidean world combat
 * range will use. Routing decides *which* cell is next; these decide *how long*
 * crossing to it takes. Since every edge is ≥ `ORTHO_LEN` (256) and a tick's
 * budget is far smaller, at most one cell boundary is crossed per tick.
 */
export const ORTHO_LEN = FP_ONE; // 256
export const DIAG_LEN = 362; // round(256·√2)

/** The next cell the field routes a creep toward, and whether reaching it is diagonal. */
export interface DescentStep {
  readonly col: number;
  readonly row: number;
  readonly diagonal: boolean;
}

/**
 * The first neighbour of `(col,row)`, in the canonical {@link forEachPassableNeighbor}
 * order, that lies exactly one edge-cost closer to the exit — i.e. `dist(n) + edge
 * === dist(col,row)`. This is the single source of truth for "the next step toward
 * the exit": {@link shortestPath} reconstructs whole routes with it and the creep
 * follower walks live creeps with it, so the two can never diverge on the
 * corner-cut or tie-break rule. Returns `null` when no neighbour exact-descends
 * (the exit itself, or a stranded cell in a forged field).
 */
export function firstDescentNeighbor(
  field: DistanceField,
  col: number,
  row: number,
): DescentStep | null {
  const curD = distAt(field, col, row);

  let result: DescentStep | null = null;
  forEachPassableNeighbor(
    col,
    row,
    (c, r) => blockedAt(field, c, r),
    (nc, nr, diagonal) => {
      const nd = distAt(field, nc, nr);
      if (nd >= 0 && nd + (diagonal ? DIAG_COST : ORTHO_COST) === curD) {
        result = { col: nc, row: nr, diagonal };
        return true; // first exact-descent neighbour wins (fixed-order tie-break)
      }
      return undefined;
    },
  );
  return result;
}

/**
 * The outcome of advancing one creep by one tick:
 * - `drop`  — the row is corrupt/impossible; remove it, no life lost (the
 *   "ragged SoA" skip policy, extended to the movement columns).
 * - `leak`  — the creep reached the exit; remove it and the caller decrements a life.
 * - `move`  — the creep is still in play at the returned cell/progress.
 */
export type AdvanceOutcome =
  | { readonly kind: 'drop' }
  | { readonly kind: 'leak' }
  | {
      readonly kind: 'move';
      readonly col: number;
      readonly row: number;
      readonly edgeProgress: number;
    };

const DROP: AdvanceOutcome = { kind: 'drop' };
const LEAK: AdvanceOutcome = { kind: 'leak' };

/**
 * Advance a single creep one tick over `field`, spending `budget` fixed-point
 * units along the descent gradient. The creep's columns are passed raw (possibly
 * `undefined`, from a restored/ragged SoA) so this function owns the full
 * validate-then-move policy — it never throws on corrupt creep state:
 *
 *   1. ROW VALIDATION — any non-safe-integer column, an out-of-bounds or
 *      unreachable cell, or negative progress ⇒ `drop`.
 *   2. LEAK AT ENTRY — a valid creep resting on the exit leaks now (a creep at
 *      rest always has progress 0, so a *positive* progress on the exit is corrupt
 *      ⇒ `drop`, not `leak`, and costs no life).
 *   3. MOVE — walk the gradient until the budget is spent or the exit is reached.
 *      A cell with no exact descent (only possible in a forged field) ⇒ `drop`,
 *      and out-of-range progress for the current edge ⇒ `drop`; both keep the loop
 *      from hanging and preserve the "step() never crashes on corrupt state" contract.
 *
 * The loop always terminates: each non-returning iteration has `0 ≤ progress <
 * edgeLen`, so `stepDist ≥ 1` and `budget` strictly decreases.
 */
export function advanceCreep(
  field: DistanceField,
  id: number | undefined,
  hp: number | undefined,
  col: number | undefined,
  row: number | undefined,
  edgeProgress: number | undefined,
  budget: number,
): AdvanceOutcome {
  // (1) ROW VALIDATION — deterministic drop of a corrupt/impossible row.
  if (
    !Number.isSafeInteger(id) ||
    !Number.isSafeInteger(hp) ||
    !Number.isSafeInteger(col) ||
    !Number.isSafeInteger(row) ||
    !Number.isSafeInteger(edgeProgress)
  ) {
    return DROP;
  }
  let curCol = col as number;
  let curRow = row as number;
  let progress = edgeProgress as number;
  const { width, height } = field;
  if (curCol < 0 || curRow < 0 || curCol >= width || curRow >= height) return DROP;
  if (distAt(field, curCol, curRow) < 0) return DROP; // unreachable cell
  if (progress < 0) return DROP;

  // (2) LEAK AT ENTRY — a creep resting on the exit leaks; a positive progress
  //     there is corrupt (rest implies progress 0), so drop without a life lost.
  if (curCol === field.exit.col && curRow === field.exit.row) {
    return progress === 0 ? LEAK : DROP;
  }

  // (3) MOVE — spend the budget along the gradient, crossing at most one boundary.
  let remaining = budget;
  while (remaining > 0) {
    const next = firstDescentNeighbor(field, curCol, curRow);
    if (next === null) return DROP; // forged-field backstop — no exact descent
    const edgeLen = next.diagonal ? DIAG_LEN : ORTHO_LEN;
    if (progress >= edgeLen) return DROP; // out-of-range progress for this edge
    const stepDist = Math.min(remaining, edgeLen - progress); // ≥ 1 here
    progress += stepDist;
    remaining -= stepDist;
    if (progress === edgeLen) {
      // Arrived exactly at the next cell centre.
      curCol = next.col;
      curRow = next.row;
      progress = 0;
      if (curCol === field.exit.col && curRow === field.exit.row) {
        return LEAK; // remaining budget is discarded
      }
    }
  }
  return { kind: 'move', col: curCol, row: curRow, edgeProgress: progress };
}
