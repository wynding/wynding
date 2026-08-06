// movement.ts — point-authoritative creep movement. Pure, deterministic,
// integer-only, like the rest of the sim core.
//
// A creep carries a fixed-point segment START POINT `(fromX,fromY)`, a waypoint
// cell `(headCol,headRow)` whose centre is the segment END `B`, and `progress`:
// arc-length travelled from `from` toward `B`. Its Euclidean point is DERIVED,
// `P = from + (B − from)·progress/edgeLen`, and the cell it "occupies" is derived
// too, `cellContaining(P) = floor(P/256)`. Combat (Story 4) is the first consumer
// of that point; movement, placement, and targeting all agree on it through the
// single {@link deriveValidCreepPosition} seam.
//
// `edgeLen` is NEVER stored — it is derived each tick from `(from, B)`. A persisted
// length would be a forgeable free variable that could desync interpolation from
// genuine movement; derived, it is stable across a segment's life and canonical by
// construction (Codex R2). A normal centre↔centre edge derives a CONSTANT length
// (256 orthogonal, 362 diagonal) with no sqrt; only a TRANSITIONAL segment — from an
// arbitrary interior point to an adjacent waypoint centre, created when a creep
// re-paths mid-step — derives `edgeLen = isqrt(dx²+dy²)`, so `isqrt` runs only while
// a creep is mid-turn, never on a normal tick.
//
// POINT-AUTHORITATIVE RE-PATH (closes #17): when the maze changes a mid-segment
// creep's next waypoint, it starts a transitional segment FROM ITS ACTUAL POINT `P`
// (never snapping backward to a cell centre) toward the new adjacent waypoint. At
// each waypoint arrival `from` snaps exactly to the centre, re-establishing an
// on-lattice segment so transitional drift cannot accumulate across cells. At rest
// (`progress === 0`) the head columns hold the canonical sentinel `head == cell` and
// the heading is derived fresh from the field.

import { ORTHO_COST, DIAG_COST, forEachPassableNeighbor } from './board';
import { FP_ONE } from '@wynding/engine';
import { blockedAt, distAt } from './field-access';
import type { DistanceField } from './pathfinding';

/**
 * Fixed-point length of one edge as *traversed* by a creep. Distinct from the
 * field's `10/14` routing weights: a diagonal genuinely takes ≈1.41× an
 * orthogonal step to cross (`round(256·√2)`), matching the Euclidean world combat
 * range uses. Routing decides *which* cell is next; these decide *how long*
 * crossing to it takes. `DIAG_LEN` equals `isqrt(256²+256²)` exactly, so the
 * constant fast-path and the transitional `isqrt` path agree on a diagonal.
 */
export const ORTHO_LEN = FP_ONE; // 256
export const DIAG_LEN = 362; // round(256·√2) === isqrt(256²+256²)

/** Half a cell in fixed-point — a cell centre sits this far inside the cell. */
const HALF_CELL = FP_ONE >> 1; // 128

/** The fixed-point centre of cell `(col,row)` — the single definition of the
 *  cell-centre convention, shared by movement, spawning, and combat geometry. */
export function cellCenterX(col: number): number {
  return col * FP_ONE + HALF_CELL;
}
export function cellCenterY(row: number): number {
  return row * FP_ONE + HALF_CELL;
}

/** The cell a fixed-point coordinate lies in — `floor(v/256)` for `v ≥ 0`. The single
 *  "which cell contains x" rule, shared by movement and combat targeting. */
export function cellOf(v: number): number {
  return Math.floor(v / FP_ONE);
}

/**
 * Exact integer floor square root of `n ≥ 0` (`isqrt(n)² ≤ n < (isqrt(n)+1)²`).
 * PURE integer math — no `Math.sqrt` (the deterministic core forbids floats and
 * transcendentals, AGENTS.md "Determinism"). Integer Newton's method with the
 * sanctioned `Math.floor(a / b)` division idiom (no 32-bit `>>`/`clz32` coercion,
 * so it is correct across the whole safe-integer domain, not just `< 2³²`). The
 * constant seed `2²⁷ ≥ √n` for every safe integer (`√(2⁵³−1) < 2²⁷`), so the
 * iteration descends monotonically to the floor in O(1) bounded steps; the final
 * ±1 clamp makes the RESULT exact despite any division rounding — byte-identical
 * on every platform.
 *
 * OPERAND RANGE, by caller — this is the comment a new caller will consult before
 * deciding its own operands are safe, so it must stay current (M2-S7):
 *   - `segmentLength` (below): adjacency bounds `dx²+dy²` to `~8·10⁵`.
 *   - `remainingRouteDist`'s AIR branch (`combat.ts`, M2-S7): the full creep-to-exit
 *     delta, bounded by the sv11 capability gate at ≤1024 cells/side to `dx²+dy² ≤ 2³⁷`.
 * Both are correct here for the same reason: the `1 << 27` seed exceeds `√n` for EVERY
 * safe integer, so this is exact across the whole safe-integer domain, not merely over
 * the small operands its first caller happened to pass.
 */
export function isqrt(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) return 0;
  let x = 1 << 27; // 2²⁷ ≥ √n for every safe integer n
  for (;;) {
    const y = Math.floor((x + Math.floor(n / x)) / 2);
    if (y >= x) break;
    x = y;
  }
  while (x > 0 && x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

/**
 * The traversal length of the segment from point `(fromX,fromY)` to the centre
 * `(Bx,By)` of an adjacent waypoint. When `from` is itself a cell centre the
 * offset is a whole number of cells and the length is the CONSTANT 256 (orthogonal
 * or at rest) or 362 (diagonal) — no sqrt. Otherwise the segment is transitional
 * and the length is the exact `isqrt(dx²+dy²)`.
 */
function segmentLength(fromX: number, fromY: number, Bx: number, By: number): number {
  const dx = Bx - fromX;
  const dy = By - fromY;
  if (fromX % FP_ONE === HALF_CELL && fromY % FP_ONE === HALF_CELL) {
    // `from` is a cell centre ⇒ dx, dy ∈ {−256, 0, 256}; length is a constant.
    if (dx === 0 && dy === 0) return ORTHO_LEN; // canonical rest
    return dx !== 0 && dy !== 0 ? DIAG_LEN : ORTHO_LEN;
  }
  return isqrt(dx * dx + dy * dy);
}

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
 * The line-follow heading rule for AIR creeps (M2-S7 P2), replacing
 * {@link firstDescentNeighbor} for the `air` domain. The ray is `occupancyCell →
 * exitCell`, entirely in CELL coordinates (not entrance → exit — `DistanceField`
 * carries no entrance, and a flyer simply re-aims from where it is; not the
 * derived point — a mid-segment point and its occupied-cell centre are different
 * origins that can select different headings). Air never consults `blockedAt` or
 * the distance field; walls and towers are not its business.
 *
 * Candidate filter: strictly closer to the exit in SQUARED Euclidean cell
 * distance (a strict integer comparison, no sqrt) — Euclidean, Manhattan and
 * Chebyshev admit different candidate sets, and this filter alone proves
 * termination (every step strictly reduces distance to the exit). Selection:
 * minimise the ABSOLUTE CROSS PRODUCT of the ray direction with the step — least
 * perpendicular deviation from the line — ties broken by the canonical
 * {@link forEachPassableNeighbor} order, so it agrees with every other ordering
 * rule in the sim.
 *
 * All arithmetic is in CELL coordinates, not fixed-point: with sides bounded to
 * 1024 by the capability profile's board-size gate, deltas stay under 2¹⁰ and
 * cross products under 2²¹ — no overflow argument needed at all.
 *
 * The neighbour predicate is bounds-aware but TERRAIN-BLIND: it rejects only
 * out-of-bounds cells — never terrain, never the tower mask — so the diagonal
 * corner-cut check passes automatically (a flyer has no corners to cut).
 *
 * ITS BOUNDS HALF IS DEFENSIVE, NOT LOAD-BEARING — stated precisely because an
 * earlier draft of this comment claimed the opposite (that without it an
 * off-board head could be written) and that claim is false. The exit is always
 * on-board, and the strict-closeness filter below admits only cells nearer to it,
 * so the |cross|-minimal candidate is always on-board already. Verified by
 * exhaustive sweep over every (col, row, exitCol, exitRow) on a 12×12 board,
 * including tie-ordering: replacing the predicate with an always-open one changes
 * the result in ZERO cases, and an off-board neighbour wins in zero cases. It is
 * kept because correctness should not rest on that emergent property holding for
 * every future edit to the filter — but no test can witness it, and none claims to.
 *
 * Returns `null` when no candidate is strictly closer (the exit cell itself, or
 * a from-cell already equal to it).
 */
export function airLineFollowNeighbor(
  bounds: Bounds,
  col: number,
  row: number,
  exitCol: number,
  exitRow: number,
): DescentStep | null {
  const curSq = (exitCol - col) * (exitCol - col) + (exitRow - row) * (exitRow - row);
  let best: DescentStep | null = null;
  let bestCross = 0; // overwritten before first use — `best` gates every read
  forEachPassableNeighbor(
    col,
    row,
    (c, r) => !inBounds(c, r, bounds),
    (nc, nr, diagonal) => {
      const distSq = (exitCol - nc) * (exitCol - nc) + (exitRow - nr) * (exitRow - nr);
      if (distSq >= curSq) return; // not strictly closer — not a candidate
      const cross = Math.abs((exitCol - col) * (nr - row) - (exitRow - row) * (nc - col));
      if (best === null || cross < bestCross) {
        best = { col: nc, row: nr, diagonal };
        bestCross = cross;
      }
    },
  );
  return best;
}

/** The derived geometry of a valid creep row: its point, occupied cell, edge length. */
export interface CreepGeometry {
  readonly point: { readonly x: number; readonly y: number };
  readonly occupancyCell: { readonly col: number; readonly row: number };
  readonly edgeLen: number;
}

/** The minimum bounds a derivation needs — both `Grid` and `DistanceField` satisfy it. */
export interface Bounds {
  readonly width: number;
  readonly height: number;
}

function inBounds(col: number, row: number, bounds: Bounds): boolean {
  return col >= 0 && row >= 0 && col < bounds.width && row < bounds.height;
}

/**
 * THE single source of truth (Codex R3) for validating a creep row's position and
 * deriving its geometry — used identically by movement ({@link advanceCreep}),
 * placement (`creepOccupiedCell`), and combat targeting, so the three can never
 * disagree about which cell a creep occupies or whether its state is legal.
 *
 * Returns `null` (⇒ the consumer drops / ignores the row) unless ALL hold, in an
 * order that establishes LOCAL, bounded geometry before any multiply or `isqrt`
 * (Codex R2 #3): every column is a safe integer; `progress ≥ 0`; the waypoint
 * `(headCol,headRow)` and the from-cell `cellContaining(from)` are both in bounds;
 * the waypoint is Chebyshev-adjacent to (or equal to) the from-cell — so every
 * delta feeding `isqrt`/interpolation is bounded to ~2 cells on ANY board; the
 * derived `edgeLen ≥ 1`; and `0 ≤ progress < edgeLen` (a persisted `progress ≥
 * edgeLen` is non-canonical — genuine arrival snaps to the waypoint with
 * `progress = 0` — so it is corrupt). Otherwise it returns the derived point (floor
 * interpolation), the in-bounds occupied cell, and the edge length.
 */
export function deriveValidCreepPosition(
  fromX: number | undefined,
  fromY: number | undefined,
  headCol: number | undefined,
  headRow: number | undefined,
  progress: number | undefined,
  bounds: Bounds,
): CreepGeometry | null {
  if (
    !Number.isSafeInteger(fromX) ||
    !Number.isSafeInteger(fromY) ||
    !Number.isSafeInteger(headCol) ||
    !Number.isSafeInteger(headRow) ||
    !Number.isSafeInteger(progress)
  ) {
    return null;
  }
  const fx = fromX as number;
  const fy = fromY as number;
  const hc = headCol as number;
  const hr = headRow as number;
  const p = progress as number;
  if (p < 0) return null;
  if (!inBounds(hc, hr, bounds)) return null; // waypoint off-board

  const fromCol = cellOf(fx);
  const fromRow = cellOf(fy);
  if (!inBounds(fromCol, fromRow, bounds)) return null; // from-point off-board
  // Waypoint must be a single step (or the resting sentinel) from the from-cell —
  // this bounds |Bx−fromX|,|By−fromY| ≤ ~2 cells, so every product below is tiny.
  if (Math.max(Math.abs(hc - fromCol), Math.abs(hr - fromRow)) > 1) return null;

  if (hc === fromCol && hr === fromRow) {
    // Rest sentinel (head == from-cell) is canonical ONLY at the exact centre with
    // `progress === 0`; a positive progress on a zero-length "step" is corrupt.
    if (p !== 0 || fx !== cellCenterX(fromCol) || fy !== cellCenterY(fromRow)) return null;
    return {
      point: { x: fx, y: fy },
      occupancyCell: { col: fromCol, row: fromRow },
      edgeLen: ORTHO_LEN,
    };
  }

  const Bx = cellCenterX(hc);
  const By = cellCenterY(hr);
  const edgeLen = segmentLength(fx, fy, Bx, By);
  if (edgeLen < 1) return null; // degenerate (a non-centre from coincident with B)
  if (p >= edgeLen) return null; // out-of-range progress for this segment

  // Derive the point by integer floor interpolation. Deltas ≤ ~640 and p < edgeLen
  // ≤ ~905, so the product stays a small safe integer.
  const px = fx + Math.floor(((Bx - fx) * p) / edgeLen);
  const py = fy + Math.floor(((By - fy) * p) / edgeLen);
  const occCol = cellOf(px);
  const occRow = cellOf(py);
  if (!inBounds(occCol, occRow, bounds)) return null; // derived point off-board

  return {
    point: { x: px, y: py },
    occupancyCell: { col: occCol, row: occRow },
    edgeLen,
  };
}

/**
 * The outcome of advancing one creep by one tick:
 * - `drop`  — the row is corrupt/impossible; remove it, no life lost (the
 *   "ragged SoA" skip policy, extended to the movement columns).
 * - `leak`  — the creep's point reached the exit centre; remove it and the caller
 *   decrements a life.
 * - `move`  — the creep is still in play at the returned segment state.
 */
export type AdvanceOutcome =
  | { readonly kind: 'drop' }
  | { readonly kind: 'leak' }
  | {
      readonly kind: 'move';
      readonly fromX: number;
      readonly fromY: number;
      readonly headCol: number;
      readonly headRow: number;
      readonly progress: number;
    };

const DROP: AdvanceOutcome = { kind: 'drop' };
const LEAK: AdvanceOutcome = { kind: 'leak' };

/** The domain-dispatched heading rule `advanceCreep` derives from at every
 *  waypoint boundary: {@link firstDescentNeighbor} (flow-field descent) for
 *  `ground`, {@link airLineFollowNeighbor} (straight at the exit cell) for `air`. */
function nextHeading(
  field: DistanceField,
  domain: 'ground' | 'air',
  col: number,
  row: number,
): DescentStep | null {
  return domain === 'air'
    ? airLineFollowNeighbor(field, col, row, field.exit.col, field.exit.row)
    : firstDescentNeighbor(field, col, row);
}

/**
 * Advance a single creep one tick over `field`, spending `budget` fixed-point
 * units toward the exit. The creep's columns are passed raw (possibly `undefined`,
 * from a restored/ragged SoA) so this function owns the full validate-then-move
 * policy — it never throws on corrupt creep state:
 *
 *   1. ROW VALIDATION — non-safe `id`/`hp`, or any invalid position (via the shared
 *      {@link deriveValidCreepPosition} seam) ⇒ `drop`.
 *   2. EXIT — the creep's derived point sitting exactly on the exit centre has
 *      arrived ⇒ `leak`.
 *   3. RE-PATH — while the creep occupies its from-side cell, re-derive the descent
 *      from the occupied cell; if the maze changed the next waypoint, turn FROM the
 *      current point `P` onto a transitional segment (never snapping backward). A
 *      creep already occupying its head cell is committed and finishes the segment.
 *   4. MOVE — spend the budget; at each waypoint arrival snap `from` to the centre
 *      and derive the next head via {@link firstDescentNeighbor} (a cell with no
 *      exact descent — a forged field — ⇒ `drop`). A transitional segment shorter
 *      than the budget, then a normal one, may both be crossed in one tick.
 *
 * The loop always terminates: each iteration starts with `0 ≤ progress < edgeLen`,
 * so `stepDist ≥ 1` and `budget` strictly decreases. A `move` outcome with
 * `progress === 0` reports the canonical rest sentinel (`head == cell`, `from ==
 * its centre`).
 *
 * `domain` (M2-S7 P2) selects the heading rule and the occupied-cell terrain
 * checks below — TWO things differ for `air`, not one:
 *   (a) OCCUPIED-CELL VALIDATION skips `blockedAt`/`distAt` entirely: those two
 *       checks exist to drop a forged GROUND row standing on a wall, and they
 *       would delete a flyer the instant it crossed a tower. Nothing else in the
 *       validation chain relaxes.
 *   (b) the heading — every {@link firstDescentNeighbor} call below is
 *       {@link airLineFollowNeighbor} instead, a stateless line-follow step from
 *       the occupied cell straight at the exit cell, consulting neither
 *       `blockedAt` nor the distance field. Both callers (the movement phase and
 *       `predictBlastPoint`'s blast-lead reuse of this function) supply the
 *       creep's own domain — an AoE aimed at a flyer must not lead it along the
 *       ground flow field.
 */
export function advanceCreep(
  field: DistanceField,
  id: number | undefined,
  hp: number | undefined,
  fromX: number | undefined,
  fromY: number | undefined,
  headCol: number | undefined,
  headRow: number | undefined,
  progress: number | undefined,
  budget: number,
  domain: 'ground' | 'air',
): AdvanceOutcome {
  // (1) ROW VALIDATION.
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(hp)) return DROP;

  const exitX = cellCenterX(field.exit.col);
  const exitY = cellCenterY(field.exit.row);

  // (2a) ARRIVED — a creep resting exactly on the exit centre has arrived and leaks,
  //      independent of its head columns (at progress 0 the point IS the from-point,
  //      so the head is irrelevant). Checked before row validation so a resting-on-
  //      exit creep leaks even if its (unused) head sentinel is non-canonical.
  if (progress === 0 && fromX === exitX && fromY === exitY) return LEAK;

  const geom = deriveValidCreepPosition(fromX, fromY, headCol, headRow, progress, field);
  if (geom === null) return DROP;

  // Working segment state (from-point, head cell, progress, derived edge length).
  let fx = fromX as number;
  let fy = fromY as number;
  let hCol = headCol as number;
  let hRow = headRow as number;
  let prog = progress as number;
  let edgeLen = geom.edgeLen;

  // (2) EXIT — a creep occupies the exit legitimately only by ARRIVING at its
  //     centre (⇒ leak). A row whose FROM cell is already the exit but whose point
  //     is not the exit centre is corrupt — a genuine creep leaks the instant it
  //     reaches the centre and never departs the exit, so a forged "leaving the
  //     exit" row is dropped (no life lost), matching the pre-rewrite policy.
  if (geom.point.x === exitX && geom.point.y === exitY) return LEAK;
  if (cellOf(fx) === field.exit.col && cellOf(fy) === field.exit.row) return DROP;

  // OCCUPIED-CELL VALIDATION — the cell placement protects must be on-board, open,
  // and reachable. Genuine GROUND states always satisfy this (the maze invariant
  // keeps every creep's occupied cell reachable and un-buildable); a forged
  // ground creep sitting on a wall or a stranded cell is dropped, never advanced
  // onto it. AIR skips both terrain checks (M2-S7 P2a) — a flyer's occupied cell
  // is terrain-independent by design, and these two checks exist only to catch a
  // forged ground row.
  const occ = geom.occupancyCell;
  if (domain === 'ground') {
    if (blockedAt(field, occ.col, occ.row)) return DROP;
    if (distAt(field, occ.col, occ.row) < 0) return DROP;
  }

  const atRest = prog === 0 && hCol === occ.col && hRow === occ.row;

  if (atRest) {
    // Derive a fresh head from the resting cell.
    const next = nextHeading(field, domain, occ.col, occ.row);
    if (next === null) return DROP; // stranded on a forged field
    hCol = next.col;
    hRow = next.row;
    edgeLen = next.diagonal ? DIAG_LEN : ORTHO_LEN;
  } else if (occ.col !== hCol || occ.row !== hRow) {
    // (3) RE-PATH — still on the from side of the boundary. If the maze changed the
    //     descent from the occupied cell, turn from the ACTUAL point P (Codex/#17).
    //     Guarded on `budget > 0` (M2-S6): the turn sets `fx`/`fy` to the mid-edge
    //     point `geom.point` (not a cell centre) and `prog = 0`; at budget 0 the MOVE
    //     loop below never runs, so `prog` would still be 0 at the sentinel
    //     normalization, which snaps `head` to `cellOf(fx)` — reproducing the rest
    //     sentinel shape (`head === from-cell`, `progress === 0`) with a non-centre
    //     `fx`/`fy`, exactly what `deriveValidCreepPosition` rejects as corrupt. A
    //     stunned creep would then be silently DROPped the following tick. A creep
    //     that cannot move cannot round a corner, so deferring the turn until budget
    //     is positive is behaviourally inert for every mover — it only matters at
    //     budget 0, which is now genuinely stun-only as an ENFORCED invariant, not
    //     merely an observation: `effectiveSpeedFp` floors every un-slowed base speed
    //     at 1 (M2-S6), so the movement rebuild's `stunned ? 0 : effectiveSpeedFp(...)`
    //     is the only remaining source of a zero budget. This buys the invariant that
    //     a stunned creep's movement row is byte-identical to its input for every
    //     GENUINE row — narrowly: at `progress === 0` with `head !== from-cell`, the
    //     sentinel normalization below still rewrites `head` to `cellOf(fx)`, which is
    //     unreachable for a genuine row (progress 0 with a non-canonical head is not a
    //     shape `advanceCreep` itself produces) but not for a forged one restored
    //     directly into that shape. The stranded-field DROP below still runs at
    //     budget 0 — only the turn's assignment defers.
    const next = nextHeading(field, domain, occ.col, occ.row);
    if (next === null) return DROP; // stranded on a forged field
    if (budget > 0 && (next.col !== hCol || next.row !== hRow)) {
      fx = geom.point.x;
      fy = geom.point.y;
      hCol = next.col;
      hRow = next.row;
      prog = 0;
      edgeLen = segmentLength(fx, fy, cellCenterX(hCol), cellCenterY(hRow));
      if (edgeLen < 1) return DROP; // never coincident with an adjacent waypoint
    }
  }
  // (else: occupies the head cell already — committed, finish the segment.)

  // (4) MOVE — spend the budget; snap to each waypoint centre on arrival.
  let Bx = cellCenterX(hCol);
  let By = cellCenterY(hRow);
  let remaining = budget;
  while (remaining > 0) {
    const stepDist = Math.min(remaining, edgeLen - prog); // ≥ 1 (0 ≤ prog < edgeLen)
    prog += stepDist;
    remaining -= stepDist;
    if (prog < edgeLen) break; // budget exhausted mid-segment
    // Arrived exactly at the head centre: snap onto the lattice.
    fx = Bx;
    fy = By;
    prog = 0;
    if (hCol === field.exit.col && hRow === field.exit.row) return LEAK; // remaining discarded
    const next = nextHeading(field, domain, hCol, hRow);
    if (next === null) return DROP; // forged-field backstop — no exact descent
    hCol = next.col;
    hRow = next.row;
    edgeLen = next.diagonal ? DIAG_LEN : ORTHO_LEN;
    Bx = cellCenterX(hCol);
    By = cellCenterY(hRow);
  }

  if (prog === 0) {
    // Canonical rest sentinel: head == current cell, from == its centre.
    hCol = cellOf(fx);
    hRow = cellOf(fy);
  }
  return { kind: 'move', fromX: fx, fromY: fy, headCol: hCol, headRow: hRow, progress: prog };
}
