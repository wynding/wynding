// context.ts — the board as an explicit, validated sim input.
//
// PRD 0001 states the sim is a pure function of (seed, ruleset, boardId, tick
// inputs): the board is an INPUT, not part of the mutable per-tick state. A match
// builds one `BoardContext` up front with `loadBoard` and threads it through every
// `step`. Keeping it out of `SimState` keeps the hashed/serialized state small and
// the resume path clean, and the precomputed field is never re-derived per tick.
//
// `loadBoard` is the only sanctioned constructor, so a context it returns is
// consistent by construction. But `step` accepts a structural `BoardContext` a
// caller could hand-forge (bypassing `loadBoard`), so `assertConsistent` validates
// the context's SHAPE and ENDPOINT TOPOLOGY at load and defensively — once,
// memoized — at the top of `step`: a mismatched-dimension, wrong-length,
// invalid-endpoint, bad-exit-distance, or unreachable-entrance context is rejected
// with a loud `GridError` before any tick can read a typed array out of bounds.
// Gradient *integrity* (every reachable non-exit cell has an exact descent) is NOT
// re-derived here — a shape-valid field with a broken gradient is caught behaviorally
// by the movement layer's drop backstop, not this validator. (Typed-array *element*
// immutability is likewise not enforced — the Story-1 "read-only by convention"
// posture for `baseMask`/`DistanceField` stands; this guards shape and topology.)

import type { Cell } from '@wynding/types';
import { buildGrid, GridError, type Grid, type GridSpec } from './board';
import { computeDistanceField, isReachable, type DistanceField } from './pathfinding';

/**
 * The static, immutable board a match is played on: its grid geometry and the
 * exit-sourced distance field creeps descend. Consistent by construction when
 * produced by {@link loadBoard}.
 */
export interface BoardContext {
  readonly grid: Grid;
  readonly field: DistanceField;
}

// Contexts that have passed `assertConsistent`, so the defensive per-tick call in
// `step` validates each context object exactly once. A WeakSet keys on identity and
// never retains a context past its last use.
const validated = new WeakSet<BoardContext>();

function cellInBounds(cell: Cell | null | undefined, width: number, height: number): boolean {
  return (
    cell != null &&
    Number.isSafeInteger(cell.col) &&
    Number.isSafeInteger(cell.row) &&
    cell.col >= 0 &&
    cell.row >= 0 &&
    cell.col < width &&
    cell.row < height
  );
}

/**
 * Assert a {@link BoardContext} is internally consistent, throwing {@link GridError}
 * on the first violation. Complete validator (Codex R2+R4): positive safe-integer
 * dimensions that the field matches; `dist`/`blockedMask` sized exactly `width·height`
 * so no movement read is out of bounds; entrance and exit both in-bounds safe-integer
 * cells with `field.exit` matching `grid.exit`; the field's defining exit invariant
 * (`dist[exit] === 0`, unblocked); and a reachable entrance. Result is memoized per
 * context object, so the defensive call in `step` costs nothing after the first tick.
 */
export function assertConsistent(board: BoardContext): void {
  if (validated.has(board)) return;

  // Guard the structure before any dereference: a hand-forged or partially
  // deserialized context (the "future JSON/mod loader" case this validator exists
  // for) can have a null/undefined grid, field, or field member. Reject it with the
  // documented GridError rather than letting a raw TypeError escape uncaught.
  if (board == null || typeof board !== 'object') {
    throw new GridError(`board context must be an object, got ${String(board)}`);
  }
  const { grid, field } = board;
  if (grid == null || typeof grid !== 'object' || field == null || typeof field !== 'object') {
    throw new GridError('board context must have a grid and a field object');
  }
  if (field.dist == null || field.blockedMask == null || field.exit == null) {
    throw new GridError('board field must have dist, blockedMask, and exit');
  }
  const { width, height } = grid;

  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new GridError(`board dimensions must be positive safe integers, got ${width}×${height}`);
  }
  if (field.width !== width || field.height !== height) {
    throw new GridError(
      `field dimensions ${field.width}×${field.height} do not match grid ${width}×${height}`,
    );
  }
  const cellCount = width * height;
  if (field.dist.length !== cellCount || field.blockedMask.length !== cellCount) {
    throw new GridError(
      `field arrays (dist ${field.dist.length}, mask ${field.blockedMask.length}) must be ${cellCount}`,
    );
  }
  if (!cellInBounds(grid.entrance, width, height)) {
    throw new GridError(`entrance must be an in-bounds cell for ${width}×${height}`);
  }
  if (!cellInBounds(grid.exit, width, height)) {
    throw new GridError(`exit must be an in-bounds cell for ${width}×${height}`);
  }
  if (field.exit.col !== grid.exit.col || field.exit.row !== grid.exit.row) {
    throw new GridError(
      `field exit (${field.exit.col},${field.exit.row}) does not match grid exit (${grid.exit.col},${grid.exit.row})`,
    );
  }
  const exitIdx = grid.exit.row * width + grid.exit.col;
  if ((field.dist[exitIdx] as number) !== 0 || (field.blockedMask[exitIdx] as number) !== 0) {
    throw new GridError(
      `exit must be the unblocked distance-0 source (dist ${field.dist[exitIdx]}, blocked ${field.blockedMask[exitIdx]})`,
    );
  }
  if (!isReachable(field, grid.entrance)) {
    throw new GridError(
      `entrance (${grid.entrance.col},${grid.entrance.row}) cannot reach the exit`,
    );
  }

  validated.add(board);
}

/**
 * Build the static board for a match from a structural {@link GridSpec}. This is
 * the only sanctioned {@link BoardContext} constructor: it builds the grid, derives
 * the exit-sourced distance field (so the two are consistent by construction), then
 * runs {@link assertConsistent} — which also enforces that the entrance can reach
 * the exit, so a fully walled-off board is rejected here rather than silently
 * spawning stuck creeps. Throws {@link GridError} on any malformed or unplayable board.
 */
export function loadBoard(spec: GridSpec): BoardContext {
  const grid = buildGrid(spec);
  const field = computeDistanceField(grid);
  const board: BoardContext = { grid, field };
  assertConsistent(board);
  return board;
}
