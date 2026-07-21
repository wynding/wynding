// pathfinding.ts — the exit-sourced distance field and shortest path over the
// grid. Pure, deterministic, integer-only.
//
// Distances are uniform-cost (Dijkstra) from the EXIT outward, with octile edge
// weights: orthogonal steps cost 10 and diagonal steps cost 14 (≈ 10·√2), so a
// diagonal costs ~1.4× an orthogonal one and paths follow the true-shortest
// route rather than a hop-count approximation that can't tell routes apart. The
// resulting field is a descent map every creep can follow toward the exit.
//
// Injected blocks are ADDITIVE, exactly as in `neighbors`: the effective topology
// is `grid.baseMask | extraBlocked`, materialized once into the field's private
// `blockedMask`. An all-zero `extraBlocked` can therefore never open the border,
// and later mutation of the caller's mask can never retroactively alter a field.

import type { Cell } from '@wynding/types';
import {
  CELL_CAP,
  GridError,
  ORTHO_COST,
  DIAG_COST,
  forEachPassableNeighbor,
  type Grid,
} from './board';
import { firstDescentNeighbor } from './movement';

/**
 * A distance-to-exit field. `dist` is row-major, in the octile integer metric,
 * with `-1` marking unreachable cells. `blockedMask` is the field's own private
 * snapshot of the effective topology it was computed against.
 *
 * Produced only by {@link computeDistanceField}. It is read-only by convention —
 * consumers must not mutate `dist`/`blockedMask` (TypedArray elements can't be
 * frozen); the small `exit` cell is frozen. Consumers validate what they read
 * (dims, source exit, in-bounds) at the boundary rather than trusting the shape.
 */
export interface DistanceField {
  readonly dist: Int32Array;
  readonly width: number;
  readonly height: number;
  readonly exit: Cell;
  readonly blockedMask: Uint8Array;
}

/**
 * Compute the exit-sourced distance field for `grid`. Blocking is additive: the
 * effective topology is the grid's base terrain OR the optional `extraBlocked`
 * mask (row-major, `width · height` bytes, nonzero = blocked). Throws
 * {@link GridError} if `extraBlocked` has the wrong length or if the exit is
 * blocked in the effective mask. The returned field owns a private copy of the
 * effective mask, so mutating the caller's `extraBlocked` afterward cannot change
 * an already-computed field.
 */
export function computeDistanceField(grid: Grid, extraBlocked?: Uint8Array): DistanceField {
  const { width, height } = grid;
  const cellCount = width * height;
  if (extraBlocked !== undefined && extraBlocked.length !== cellCount) {
    throw new GridError(`extraBlocked length ${extraBlocked.length} !== ${cellCount}`);
  }

  // Private effective mask = base terrain OR the injected mask (additive).
  const blockedMask = new Uint8Array(grid.baseMask);
  if (extraBlocked !== undefined) {
    for (let i = 0; i < cellCount; i++) {
      if (extraBlocked[i] !== 0) blockedMask[i] = 1;
    }
  }

  const exitIndex = grid.exit.row * width + grid.exit.col;
  if (blockedMask[exitIndex] !== 0) {
    throw new GridError(
      `exit (${grid.exit.col},${grid.exit.row}) is blocked in the effective mask`,
    );
  }

  const blocked = (c: number, r: number): boolean => {
    if (c < 0 || r < 0 || c >= width || r >= height) return true; // OOB is blocked
    return blockedMask[r * width + c] !== 0;
  };

  const dist = new Int32Array(cellCount).fill(-1);
  dist[exitIndex] = 0;

  // Binary min-heap of entries packed as `d * CELL_CAP + index` (orders by d).
  // Both fields recover exactly: index = packed % CELL_CAP, d = (packed − index)
  // / CELL_CAP. CELL_CAP bounds keep the packed value a safe integer.
  const heap: number[] = [exitIndex]; // d = 0 for the exit
  const heapPush = (value: number): void => {
    heap.push(value);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      const pv = heap[parent] as number;
      const cv = heap[child] as number;
      if (pv <= cv) break;
      heap[parent] = cv;
      heap[child] = pv;
      child = parent;
    }
  };
  const heapPopMin = (): number => {
    // Precondition: heap is non-empty (the drain loop guards on length).
    const top = heap[0] as number;
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      const n = heap.length;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < n && (heap[left] as number) < (heap[smallest] as number)) smallest = left;
        if (right < n && (heap[right] as number) < (heap[smallest] as number)) smallest = right;
        if (smallest === parent) break;
        const sv = heap[smallest] as number;
        heap[smallest] = heap[parent] as number;
        heap[parent] = sv;
        parent = smallest;
      }
    }
    return top;
  };

  while (heap.length > 0) {
    const packed = heapPopMin();
    const index = packed % CELL_CAP;
    const d = (packed - index) / CELL_CAP;
    if (d > (dist[index] as number)) continue; // stale heap entry — already improved
    const col = index % width;
    const row = (index - col) / width;
    forEachPassableNeighbor(col, row, blocked, (nc, nr, diagonal) => {
      const nIndex = nr * width + nc;
      const nd = d + (diagonal ? DIAG_COST : ORTHO_COST);
      const known = dist[nIndex] as number;
      if (known === -1 || nd < known) {
        dist[nIndex] = nd;
        heapPush(nd * CELL_CAP + nIndex);
      }
    });
  }

  return {
    dist,
    width,
    height,
    exit: Object.freeze({ col: grid.exit.col, row: grid.exit.row }),
    blockedMask,
  };
}

/**
 * Whether `cell` can reach the exit in `field`. Out-of-bounds cells are not
 * reachable (returns `false`) rather than throwing — the caller may probe cells
 * near the edge. Enforcement of the maze invariant (rejecting a build) is Story 3.
 */
export function isReachable(field: DistanceField, cell: Cell): boolean {
  const { col, row } = cell;
  if (col < 0 || row < 0 || col >= field.width || row >= field.height) return false;
  return (field.dist[row * field.width + col] as number) >= 0;
}

/**
 * The shortest path from `from` (default: the grid entrance) to the exit, as an
 * ordered `Cell[]` beginning at `from` and ending at the exit — or `null` on a
 * typed failure: the field does not match the grid (dimensions or exit differ),
 * or `from` is out of bounds, blocked, or unreachable.
 *
 * Reconstruction steps cell-by-cell via {@link firstDescentNeighbor} — the single
 * canonical descent rule the creep follower also uses, so a stored path can never
 * diverge from a live creep's route. Exact-descent strictly decreases a
 * non-negative integer every step, so the walk always terminates at the exit; the
 * fixed neighbour order makes the chosen path deterministic.
 */
export function shortestPath(
  grid: Grid,
  field: DistanceField,
  from: Cell = grid.entrance,
): Cell[] | null {
  if (
    field.width !== grid.width ||
    field.height !== grid.height ||
    field.exit.col !== grid.exit.col ||
    field.exit.row !== grid.exit.row
  ) {
    return null;
  }
  const { width, height } = grid;
  const blocked = (c: number, r: number): boolean => {
    if (c < 0 || r < 0 || c >= width || r >= height) return true;
    return (field.blockedMask[r * width + c] as number) !== 0;
  };
  const distAt = (c: number, r: number): number => field.dist[r * width + c] as number;

  if (blocked(from.col, from.row)) return null; // out of bounds or on a wall
  if (distAt(from.col, from.row) < 0) return null; // unreachable

  const path: Cell[] = [{ col: from.col, row: from.row }];
  let col = from.col;
  let row = from.row;
  while (distAt(col, row) !== 0) {
    const next = firstDescentNeighbor(field, col, row);
    if (next === null) return null; // no descent from a supposedly-reachable cell
    col = next.col;
    row = next.row;
    path.push({ col, row });
  }
  return path;
}
