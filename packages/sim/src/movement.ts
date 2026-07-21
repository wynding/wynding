// movement.ts — grid path-following creep movement. Pure, deterministic,
// integer-only, like the rest of the sim core.
//
// A creep steps centre-to-centre between cells. It carries the cell it is stepping
// FROM `(col,row)`, the cell it is stepping TO `(headCol,headRow)`, and
// `edgeProgress`: how far, in fixed-point units, it has travelled along that step.
// Each tick it spends a fixed budget; when progress reaches the edge length it
// snaps onto the head cell and the remainder carries onto the next step, so speed
// is constant regardless of where cell boundaries fall.
//
// OCCUPANCY & RE-PATH (PRD 0001 §1/§3): a creep "occupies" the single cell its
// point is in — the FROM cell until it crosses the boundary (the half-way point of
// the step), the TO cell after. Placement forbids only that occupied cell, so a
// player may build on the cell a creep is heading toward right up until it crosses
// in. When the maze changes, a creep still on the near side of the boundary
// re-derives its heading from its current cell that tick and turns (re-centring on
// the cell — a ≤half-step adjustment) so it never advances onto a cell just walled;
// a creep already past the boundary occupies the head cell (which placement
// therefore protects) and finishes its step, then re-routes from there. Either way
// a creep never lands on a tower. At rest (`edgeProgress === 0`, including fresh
// spawns) the head columns hold the sentinel `head == (col,row)` and the heading is
// derived fresh from the field.

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
 * The cell a creep's point currently lies in — the single cell it "occupies" for
 * the never-build-on-a-creep rule (PRD 0001 §3). Its point is in the FROM cell
 * `(col,row)` until it crosses the step's midpoint, and in the head cell after. A
 * resting creep (`edgeProgress <= 0`) or one whose head is not a single legal step
 * away (corrupt/forged — movement will reroute or drop it) occupies its own
 * `(col,row)`.
 */
export function occupiedCell(
  col: number,
  row: number,
  headCol: number | undefined,
  headRow: number | undefined,
  edgeProgress: number | undefined,
): { readonly col: number; readonly row: number } {
  if (!Number.isSafeInteger(edgeProgress) || (edgeProgress as number) <= 0) return { col, row };
  if (!Number.isSafeInteger(headCol) || !Number.isSafeInteger(headRow)) return { col, row };
  const hc = headCol as number;
  const hr = headRow as number;
  const dCol = hc - col;
  const dRow = hr - row;
  if (Math.max(Math.abs(dCol), Math.abs(dRow)) !== 1) return { col, row };
  const edgeLen = dCol !== 0 && dRow !== 0 ? DIAG_LEN : ORTHO_LEN;
  return (edgeProgress as number) < edgeLen >> 1 ? { col, row } : { col: hc, row: hr };
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
 * units toward the exit. The creep's columns are passed raw (possibly `undefined`,
 * from a restored/ragged SoA) so this function owns the full validate-then-move
 * policy — it never throws on corrupt creep state:
 *
 *   1. ROW VALIDATION — any non-safe-integer column or negative progress ⇒ `drop`.
 *   2. EXIT AT ENTRY — a creep whose FROM cell is the exit has arrived: at rest it
 *      leaks; a *positive* progress there is corrupt ⇒ `drop`, and costs no life.
 *   3. STEP GEOMETRY — for a mid-step creep (`edgeProgress > 0`) the head must be a
 *      single step away (Chebyshev distance 1) with in-range progress, else `drop`;
 *      the midpoint classifies it as near or far side of the boundary.
 *   4. OCCUPIED-CELL VALIDATION — validate ONLY the cell the creep occupies (the
 *      FROM cell on the near side / at rest, the head on the far side). A far-side
 *      creep's FROM cell can be legally walled behind it, so it is not checked — the
 *      move loop never reads it again.
 *   5. NEAR-SIDE RE-ROUTE — on the near side, if the maze changed the descent from
 *      `(col,row)` the creep re-centres (`progress = 0`) and heads the new way; it
 *      never steps onto a walled cell.
 *   6. MOVE — spend the budget, deriving a fresh head at each cell centre via
 *      {@link firstDescentNeighbor}; a cell with no exact descent (a forged field,
 *      or a head made unreachable — the maze invariant keeps both out of genuine
 *      states) ⇒ `drop`.
 *
 * The loop always terminates: each iteration starts with `0 ≤ progress < edgeLen`,
 * so `stepDist ≥ 1` and `budget` strictly decreases. A `move` outcome with
 * `edgeProgress === 0` always reports the sentinel head.
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
  if (progress < 0) return DROP;

  // (2) EXIT AT ENTRY — a creep whose FROM cell is the exit has arrived: at rest it
  //     leaks; a positive progress there is corrupt (it cannot step out of the exit).
  if (curCol === field.exit.col && curRow === field.exit.row) {
    return progress === 0 ? LEAK : DROP;
  }

  // (3) STEP GEOMETRY — a mid-step creep carries a head; classify near/far side.
  let hCol = headCol as number;
  let hRow = headRow as number;
  let diagonal = false;
  let edgeLen = ORTHO_LEN;
  let nearSide = true;
  if (progress > 0) {
    const dCol = hCol - curCol;
    const dRow = hRow - curRow;
    if (Math.max(Math.abs(dCol), Math.abs(dRow)) !== 1) return DROP; // head not one step away
    diagonal = dCol !== 0 && dRow !== 0;
    edgeLen = diagonal ? DIAG_LEN : ORTHO_LEN;
    if (progress >= edgeLen) return DROP; // out-of-range progress for this edge
    nearSide = progress < edgeLen >> 1;
  }

  // (4) OCCUPIED-CELL VALIDATION — the creep occupies (curCol,curRow) on the near
  //     side (or at rest) and the head on the far side; that occupied cell is the
  //     one placement protects, so validate exactly it. A far-side creep's FROM
  //     cell may be legally walled *behind* it — validating it here would drop a
  //     legal live creep, so it must not be checked.
  const occCol = nearSide ? curCol : hCol;
  const occRow = nearSide ? curRow : hRow;
  if (blockedAt(field, occCol, occRow)) return DROP; // occupied cell out of bounds or blocked
  if (distAt(field, occCol, occRow) < 0) return DROP; // occupied cell unreachable (walled-off)

  // (5) NEAR-SIDE RE-ROUTE — still on the near side of the boundary, so if the maze
  //     changed the shortest descent from (curCol,curRow), re-centre (progress 0)
  //     and let the move loop derive the new head; it never steps onto a walled cell.
  if (progress > 0 && nearSide) {
    const next = firstDescentNeighbor(field, curCol, curRow);
    if (next === null) return DROP; // stranded on a forged field
    if (next.col !== hCol || next.row !== hRow) progress = 0;
  }

  // (4) MOVE — spend the budget; derive a fresh head at each cell centre.
  let remaining = budget;
  while (remaining > 0) {
    if (progress === 0) {
      const next = firstDescentNeighbor(field, curCol, curRow);
      if (next === null) return DROP; // forged-field backstop — no exact descent
      hCol = next.col;
      hRow = next.row;
      diagonal = next.diagonal;
      edgeLen = diagonal ? DIAG_LEN : ORTHO_LEN;
    }
    const stepDist = Math.min(remaining, edgeLen - progress); // ≥ 1 here
    progress += stepDist;
    remaining -= stepDist;
    if (progress === edgeLen) {
      // Arrived exactly at the head's centre.
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
