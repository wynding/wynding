// movement.ts — grid path-following creep movement. Pure, deterministic,
// integer-only, like the rest of the sim core.
//
// A creep occupies a cell `(col,row)` and carries `edgeProgress`: how far, in
// fixed-point units, it has travelled from that cell toward its committed head
// cell. Each tick it spends a fixed movement budget along the gradient; when
// progress reaches the edge length it snaps to the head cell and the remainder
// carries onto the following edge, so speed stays constant regardless of where
// cell boundaries fall.
//
// COMMIT-TO-NEXT: the head `(headCol,headRow)` is a *committed* heading only
// while the creep is mid-edge (`edgeProgress > 0`) — a field change (a build or
// sell re-paths the maze) never reroutes a creep mid-edge; it finishes the edge
// it is on, then re-derives its next head from the current field at the cell
// centre. At rest (`edgeProgress === 0`, including fresh spawns) the head columns
// hold the canonical sentinel `head == (col,row)`; the stored value is ignored
// and the head is re-derived from the field the moment the creep leaves the
// centre. So every creep adopts a new route within one cell of travel — bounded
// latency, no teleport, no stranding.

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
  if (blockedAt(field, col, row)) return null; // OOB/blocked current cell — bounds-safe read
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
      readonly headCol: number;
      readonly headRow: number;
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
 *   3. COMMITTED-EDGE VALIDATION — a mid-edge creep (`edgeProgress > 0`) must
 *      carry a legal committed edge: the head exactly one step away (distinct,
 *      Chebyshev distance 1), in-bounds and unblocked, both corner cells
 *      unblocked when diagonal, and `edgeProgress` within the edge length ⇒
 *      anything else is `drop`. At rest the stored head is the sentinel
 *      `head == (col,row)`; it is ignored and re-derived from `field`.
 *   4. MOVE — spend the budget: finish the committed edge (or derive a fresh
 *      head at a centre via {@link firstDescentNeighbor}), snap to the head at
 *      the boundary, re-derive at each subsequent centre from the same field. A
 *      cell with no exact descent (only possible in a forged field, or from an
 *      unreachable head — the maze invariant keeps both out of genuine states)
 *      ⇒ `drop`.
 *
 * The loop always terminates: each iteration starts with `0 ≤ progress <
 * edgeLen`, so `stepDist ≥ 1` and `budget` strictly decreases. A `move` outcome
 * with `edgeProgress === 0` always reports the sentinel head.
 */
export function advanceCreep(
  field: DistanceField,
  id: number | undefined,
  hp: number | undefined,
  col: number | undefined,
  row: number | undefined,
  headCol: number | undefined,
  headRow: number | undefined,
  edgeProgress: number | undefined,
  budget: number,
): AdvanceOutcome {
  // (1) ROW VALIDATION — deterministic drop of a corrupt/impossible row.
  if (
    !Number.isSafeInteger(id) ||
    !Number.isSafeInteger(hp) ||
    !Number.isSafeInteger(col) ||
    !Number.isSafeInteger(row) ||
    !Number.isSafeInteger(headCol) ||
    !Number.isSafeInteger(headRow) ||
    !Number.isSafeInteger(edgeProgress)
  ) {
    return DROP;
  }
  let curCol = col as number;
  let curRow = row as number;
  let progress = edgeProgress as number;
  if (blockedAt(field, curCol, curRow)) return DROP; // out of bounds or blocked terrain
  if (distAt(field, curCol, curRow) < 0) return DROP; // in-bounds but unreachable (walled-off)
  if (progress < 0) return DROP;

  // (2) LEAK AT ENTRY — a creep resting on the exit leaks; a positive progress
  //     there is corrupt (rest implies progress 0), so drop without a life lost.
  if (curCol === field.exit.col && curRow === field.exit.row) {
    return progress === 0 ? LEAK : DROP;
  }

  // (3) COMMITTED-EDGE VALIDATION — only a mid-edge creep carries a binding head.
  let hCol = headCol as number;
  let hRow = headRow as number;
  let diagonal = false;
  if (progress > 0) {
    const dCol = hCol - curCol;
    const dRow = hRow - curRow;
    if ((dCol === 0 && dRow === 0) || dCol < -1 || dCol > 1 || dRow < -1 || dRow > 1) {
      return DROP; // head is not exactly one step away
    }
    if (blockedAt(field, hCol, hRow)) return DROP; // head out of bounds or blocked
    diagonal = dCol !== 0 && dRow !== 0;
    if (diagonal && (blockedAt(field, hCol, curRow) || blockedAt(field, curCol, hRow))) {
      return DROP; // committed diagonal's corner is closed
    }
    if (progress >= (diagonal ? DIAG_LEN : ORTHO_LEN)) return DROP; // out-of-range progress
  }

  // (4) MOVE — finish the committed edge, then follow the gradient; a creep at a
  //     centre (including the start, if resting) derives its head from `field`.
  let remaining = budget;
  while (remaining > 0) {
    if (progress === 0) {
      const next = firstDescentNeighbor(field, curCol, curRow);
      if (next === null) return DROP; // forged-field backstop — no exact descent
      hCol = next.col;
      hRow = next.row;
      diagonal = next.diagonal;
    }
    const edgeLen = diagonal ? DIAG_LEN : ORTHO_LEN;
    const stepDist = Math.min(remaining, edgeLen - progress); // ≥ 1 here
    progress += stepDist;
    remaining -= stepDist;
    if (progress === edgeLen) {
      // Arrived exactly at the committed head's centre.
      curCol = hCol;
      curRow = hRow;
      progress = 0;
      if (curCol === field.exit.col && curRow === field.exit.row) {
        return LEAK; // remaining budget is discarded
      }
    }
  }
  if (progress === 0) {
    hCol = curCol; // canonical sentinel: at rest, head == current cell
    hRow = curRow;
  }
  return {
    kind: 'move',
    col: curCol,
    row: curRow,
    headCol: hCol,
    headRow: hRow,
    edgeProgress: progress,
  };
}
