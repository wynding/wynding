// context.ts — the board as an explicit, validated sim input.
//
// PRD 0001 states the sim is a pure function of (seed, ruleset, boardId, tick
// inputs): the board is an INPUT, not part of the mutable per-tick state. A match
// builds one `BoardContext` up front with `loadBoard`, which folds it into a
// `CompiledRuleset` (`compileRuleset`, ruleset.ts) that's threaded through every
// `step`. Keeping it out of `SimState` keeps the hashed/serialized state small and
// the resume path clean, and the precomputed fields are never re-derived per tick.
//
// `loadBoard` is the only sanctioned constructor, so a context it returns is
// consistent by construction: `loadBoard` calls `assertConsistent` on it ONCE, at
// compile time, validating the context's SHAPE and ENDPOINT TOPOLOGY — a
// mismatched-dimension, wrong-length, invalid-endpoint, bad-exit-distance,
// dangling-destination, or unreachable-entrance context is rejected with a loud
// `GridError` before any tick can read a typed array out of bounds. `step` itself
// never accepts a structural `BoardContext` — it takes the branded `CompiledRuleset`
// `compileRuleset` produces, and `assertRuleset` (ruleset.ts) rejects an
// out-of-band/forged ruleset object at the tick boundary. Wiring `assertConsistent`
// into `step` itself was considered and arbitrated OUT (#46) — gold-plating, since
// `assertRuleset` already guards the tick boundary and a `CompiledRuleset` can only be
// produced via `compileRuleset` → `loadBoard` → `assertConsistent`. Gradient
// *integrity* (every reachable non-exit cell has an exact descent) is NOT re-derived
// here — a shape-valid field with a broken gradient is caught behaviorally by the
// movement layer's drop backstop, not this validator. (Typed-array *element*
// immutability is likewise not enforced — the Story-1 "read-only by convention"
// posture for `baseMask`/`DistanceField` stands; this guards shape and topology.)
//
// DESTINATIONS (ADR 0015, M3 story 3): a board assigns each entrance a destination — a
// set of exits — and keeps ONE empty-board flow-field per DISTINCT destination, in
// first-use order over the entrances (two entrances bound for the same exit share a
// field; M3's crossing board has two). `entranceDestination` maps each entrance to
// its field's index; a creep copies that index at spawn (`CreepArrays.destination`)
// and reads only its own field for life.

import type { Cell } from '@wynding/types';
import { buildGrid, GridError, type Grid, type GridSpec } from './board';
import { computeDistanceField, isReachable, type DistanceField } from './pathfinding';

/** A board's geometry plus each entrance's destination — what {@link loadBoard}
 *  consumes. `compileRuleset` builds one from a format-3 board, resolving every
 *  destination's exit ids to indices into `exits`. */
export interface BoardSpec extends GridSpec {
  /** Index-parallel to `entrances`: each entrance's destination as a set of indices into
   *  `exits` (ADR 0015's shape). Only one-exit destinations are supported (below). */
  readonly destinations: readonly (readonly number[])[];
}

/**
 * The static, immutable board a match is played on: its grid geometry, one
 * empty-board flow-field per distinct destination, and which destination each
 * entrance sends its creeps to. Consistent by construction when produced by
 * {@link loadBoard}.
 */
export interface BoardContext {
  readonly grid: Grid;
  /** One empty-board distance field per DISTINCT destination, in first-use order over
   *  `grid.entrances` — a creep's `destination` column indexes this array. */
  readonly fields: readonly DistanceField[];
  /** Index-parallel to `grid.entrances`: the index into `fields` of each entrance's
   *  destination. */
  readonly entranceDestination: readonly number[];
}

// Contexts that have passed `assertConsistent`, memoizing a REPEAT call against the
// SAME context object (identity, via WeakSet) to a no-op. This benefits only a caller
// that re-validates one already-validated object — NOT repeated `loadBoard()` calls:
// each `loadBoard()` call builds a fresh `BoardContext` object, so a second call with
// an equivalent spec validates again from scratch. Never retains a context past its
// last use.
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

/** Validate one destination field's shape, and its exit, against `grid`. */
function assertFieldConsistent(grid: Grid, field: DistanceField, d: number): void {
  if (field == null || typeof field !== 'object') {
    throw new GridError(`board field ${d} must be an object`);
  }
  if (field.dist == null || field.blockedMask == null || field.exit == null) {
    throw new GridError(`board field ${d} must have dist, blockedMask, and exit`);
  }
  const { width, height } = grid;
  if (field.width !== width || field.height !== height) {
    throw new GridError(
      `field ${d} dimensions ${field.width}×${field.height} do not match grid ${width}×${height}`,
    );
  }
  const cellCount = width * height;
  if (field.dist.length !== cellCount || field.blockedMask.length !== cellCount) {
    throw new GridError(
      `field ${d} arrays (dist ${field.dist.length}, mask ${field.blockedMask.length}) must be ${cellCount}`,
    );
  }
  if (!cellInBounds(field.exit, width, height)) {
    throw new GridError(`field ${d} exit must be an in-bounds cell for ${width}×${height}`);
  }
  if (!grid.exits.some((x) => x.col === field.exit.col && x.row === field.exit.row)) {
    throw new GridError(
      `field ${d} exit (${field.exit.col},${field.exit.row}) is not one of the grid's exits`,
    );
  }
  const exitIdx = field.exit.row * width + field.exit.col;
  if ((field.dist[exitIdx] as number) !== 0 || (field.blockedMask[exitIdx] as number) !== 0) {
    throw new GridError(
      `field ${d} exit must be the unblocked distance-0 source (dist ${field.dist[exitIdx]}, blocked ${field.blockedMask[exitIdx]})`,
    );
  }
}

/**
 * Assert a {@link BoardContext} is internally consistent, throwing {@link GridError}
 * on the first violation. Complete validator (Codex R2+R4): positive safe-integer
 * dimensions that every field matches; each field's `dist`/`blockedMask` sized
 * exactly `width·height` so no movement read is out of bounds; every entrance and
 * exit an in-bounds safe-integer cell; each field's exit one of the grid's exits,
 * holding its defining invariant (`dist[exit] === 0`, unblocked); `entranceDestination`
 * index-parallel to the entrances with every index naming a field; and every
 * entrance reachable in ITS OWN destination's field. Result is memoized per context
 * object.
 */
export function assertConsistent(board: BoardContext): void {
  if (validated.has(board)) return;

  // Guard the structure before any dereference: a hand-forged or partially
  // deserialized context (the "future JSON/mod loader" case this validator exists
  // for) can have a null/undefined grid or field list. Reject it with the documented
  // GridError rather than letting a raw TypeError escape uncaught.
  if (board == null || typeof board !== 'object') {
    throw new GridError(`board context must be an object, got ${String(board)}`);
  }
  const { grid, fields, entranceDestination } = board;
  if (grid == null || typeof grid !== 'object') {
    throw new GridError('board context must have a grid object');
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new GridError('board context must have a non-empty field list');
  }
  const { width, height } = grid;

  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new GridError(`board dimensions must be positive safe integers, got ${width}×${height}`);
  }
  if (!Array.isArray(grid.entrances) || grid.entrances.length === 0) {
    throw new GridError('grid must have a non-empty entrance list');
  }
  if (!Array.isArray(grid.exits) || grid.exits.length === 0) {
    throw new GridError('grid must have a non-empty exit list');
  }
  grid.entrances.forEach((cell, i) => {
    if (!cellInBounds(cell, width, height)) {
      throw new GridError(`entrance ${i} must be an in-bounds cell for ${width}×${height}`);
    }
  });
  grid.exits.forEach((cell, i) => {
    if (!cellInBounds(cell, width, height)) {
      throw new GridError(`exit ${i} must be an in-bounds cell for ${width}×${height}`);
    }
  });
  fields.forEach((field, d) => assertFieldConsistent(grid, field, d));
  if (!Array.isArray(entranceDestination) || entranceDestination.length !== grid.entrances.length) {
    throw new GridError(
      `entranceDestination must name one destination per entrance (${grid.entrances.length})`,
    );
  }
  grid.entrances.forEach((entrance, i) => {
    const d = entranceDestination[i];
    if (!Number.isSafeInteger(d) || (d as number) < 0 || (d as number) >= fields.length) {
      throw new GridError(`entrance ${i} names no destination field (${String(d)})`);
    }
    const field = fields[d as number]!;
    if (!isReachable(field, entrance)) {
      throw new GridError(
        `entrance (${entrance.col},${entrance.row}) cannot reach its destination exit ` +
          `(${field.exit.col},${field.exit.row})`,
      );
    }
  });

  validated.add(board);
}

/**
 * Where a creep scheduled at entrance index `entrance` spawns, and the destination it
 * takes for life: the entrance's cell and the index of its destination's field. The
 * spawn drain's one lookup (index.ts). `compileRuleset` resolves every wave entry's
 * entrance id to an index of this board, and `assertConsistent` gives every entrance a
 * destination, so an index naming no entrance is a corrupt compiled ruleset — an
 * invariant breach that throws {@link GridError}, never a spawn quietly skipped.
 */
export function entranceSpawn(
  board: BoardContext,
  entrance: number,
): { readonly cell: Cell; readonly destination: number } {
  const cell = board.grid.entrances[entrance];
  const destination = board.entranceDestination[entrance];
  if (cell === undefined || destination === undefined) {
    throw new GridError(
      `compiled spawn names entrance ${entrance}, but the board has ${board.grid.entrances.length}`,
    );
  }
  return { cell, destination };
}

/**
 * Build the static board for a match from a {@link BoardSpec}. This is the only
 * sanctioned {@link BoardContext} constructor: it builds the grid, groups the
 * entrances by DISTINCT destination (first-use order), derives each destination's
 * exit-sourced field (so grid and fields are consistent by construction), then runs
 * {@link assertConsistent} — which also enforces that every entrance can reach its
 * own destination, so a walled-off pair is rejected here rather than silently
 * spawning stuck creeps. Throws {@link GridError} on any malformed or unplayable
 * board, including a destination of more than one exit: ADR 0015 leaves which exit
 * wins a tie and how a flyer picks among several to the first story whose board
 * needs one, so this layer refuses them rather than answering either by accident
 * (the capability profile rejects them first, with a version-named message).
 */
export function loadBoard(spec: BoardSpec): BoardContext {
  const grid = buildGrid(spec);
  const destinations = (spec as { destinations?: unknown }).destinations;
  if (!Array.isArray(destinations) || destinations.length !== grid.entrances.length) {
    throw new GridError(
      `destinations must name one destination per entrance (${grid.entrances.length})`,
    );
  }
  const fields: DistanceField[] = [];
  const fieldByExit = new Map<number, number>();
  const entranceDestination = (destinations as unknown[]).map((destination, i) => {
    if (!Array.isArray(destination) || destination.length === 0) {
      throw new GridError(`entrance ${i}'s destination must be a non-empty set of exits`);
    }
    if (destination.length > 1) {
      throw new GridError(
        `entrance ${i}'s destination has ${destination.length} exits — only one-exit ` +
          `destinations are supported (ADR 0015)`,
      );
    }
    const exitIndex = destination[0] as unknown;
    if (
      !Number.isSafeInteger(exitIndex) ||
      (exitIndex as number) < 0 ||
      (exitIndex as number) >= grid.exits.length
    ) {
      throw new GridError(`entrance ${i}'s destination names no exit (${String(exitIndex)})`);
    }
    const known = fieldByExit.get(exitIndex as number);
    if (known !== undefined) return known;
    fields.push(computeDistanceField(grid, grid.exits[exitIndex as number]!));
    fieldByExit.set(exitIndex as number, fields.length - 1);
    return fields.length - 1;
  });
  const board: BoardContext = {
    grid,
    fields: Object.freeze(fields),
    entranceDestination: Object.freeze(entranceDestination),
  };
  assertConsistent(board);
  return board;
}
