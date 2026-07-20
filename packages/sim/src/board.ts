// board.ts — the static playfield grid: cell classification, the derived blocked
// mask, and the canonical 8-connected (no-corner-cutting) adjacency walk.
//
// Pure and deterministic — no floats, no RNG, no wall-clock. `buildGrid` is the
// authoritative runtime validation boundary for board geometry: it rejects
// malformed specs with a typed error rather than trusting the type system, so a
// bad board (from content, a future loader, or a test) fails loudly here instead
// of producing a silently-corrupt grid downstream.

import type { Cell } from '@wynding/types';

/**
 * The three cell classes (PRD 0001): the open buildable field, the two
 * walkable-but-unbuildable openings (entrance/exit), and permanent blocked
 * terrain (the border ring, minus the openings).
 */
export type CellClass = 'buildable-open' | 'walkable-unbuildable' | 'blocked';

/**
 * Structural board geometry `buildGrid` consumes. Deliberately a plain shape —
 * NOT the content `Board` — so `packages/sim` needs no runtime dependency on
 * `packages/content`: content's `Board` is assignable to this structurally.
 */
export interface GridSpec {
  readonly widthTiles: number;
  readonly heightTiles: number;
  readonly entrance: Cell;
  readonly exit: Cell;
}

/**
 * Upper bound on total cell count (width · height). Chosen so the worst-case
 * integer path cost can never overflow a signed 32-bit int or collide with the
 * `-1` unreachable sentinel: the longest simple path visits fewer than CELL_CAP
 * cells, each edge costs at most `DIAG_COST` (14), and 14 · (CELL_CAP − 1) is
 * still below 2^31 − 1. `1 << 20` (1,048,576) is far above any real board yet
 * well under that bound, and also keeps every flat row-major index in range.
 */
export const CELL_CAP = 1 << 20;

/** A built, validated grid: frozen geometry plus the derived base blocked mask. */
export interface Grid {
  readonly width: number;
  readonly height: number;
  /** Frozen copy of the entrance opening (never aliases the caller's spec). */
  readonly entrance: Cell;
  /** Frozen copy of the exit opening (never aliases the caller's spec). */
  readonly exit: Cell;
  /**
   * Row-major base terrain mask, one byte per cell: nonzero = permanently
   * blocked (the border ring, minus the two openings). Read-only by convention.
   * Pathfinding always consults this, so an injected `extraBlocked` can only
   * *add* blocks — it can never erase permanent terrain.
   */
  readonly baseMask: Uint8Array;
  /** Class of a cell; throws if the cell is out of bounds. */
  classAt(cell: Cell): CellClass;
  /** Whether a cell lies within the grid. */
  inBounds(cell: Cell): boolean;
}

/** A typed error raised by grid/pathfinding validation for a malformed input. */
export class GridError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridError';
  }
}

/**
 * The eight neighbour offsets in the fixed emission order N, NE, E, SE, S, SW,
 * W, NW. This one ordering is the single source of truth for adjacency and for
 * every deterministic tie-break (path reconstruction) in the sim.
 */
export const NEIGHBOR_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], // N
  [1, -1], // NE
  [1, 0], // E
  [1, 1], // SE
  [0, 1], // S
  [-1, 1], // SW
  [-1, 0], // W
  [-1, -1], // NW
];

/**
 * Walk the 8-connected neighbours of `(col,row)` in fixed order, skipping any
 * that are blocked and enforcing the no-corner-cutting rule: a diagonal step is
 * allowed only when BOTH shared orthogonal cells are unblocked. `blocked` must
 * report out-of-bounds cells as blocked. `visit` may return `true` to stop early
 * (used for first-match tie-breaks); returning nothing continues the walk.
 *
 * This is the one canonical adjacency implementation — `neighbors`, the distance
 * field, and shortest-path reconstruction all route through it, so the corner-cut
 * rule can never diverge between them.
 */
export function forEachPassableNeighbor(
  col: number,
  row: number,
  blocked: (c: number, r: number) => boolean,
  visit: (nc: number, nr: number, diagonal: boolean) => boolean | void,
): void {
  for (const [dc, dr] of NEIGHBOR_DELTAS) {
    const nc = col + dc;
    const nr = row + dr;
    if (blocked(nc, nr)) continue;
    const diagonal = dc !== 0 && dr !== 0;
    if (diagonal && (blocked(col + dc, row) || blocked(col, row + dr))) continue;
    if (visit(nc, nr, diagonal) === true) return;
  }
}

function assertPositiveSafeInt(n: number, name: string): void {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new GridError(`${name} must be a positive safe integer, got ${n}`);
  }
}

function assertBorderCell(
  cell: Cell | null | undefined,
  width: number,
  height: number,
  name: string,
): void {
  // Guard the whole cell object first: an untyped path (a future JSON/mod loader,
  // a hand-built test) can hand us a spec whose entrance/exit is missing or null.
  // Without this, destructuring below would throw a raw TypeError, breaking this
  // function's contract of failing malformed input with a typed GridError.
  if (cell == null) {
    throw new GridError(`${name} must be a { col, row } cell, got ${String(cell)}`);
  }
  const { col, row } = cell;
  if (!Number.isSafeInteger(col) || !Number.isSafeInteger(row)) {
    throw new GridError(`${name} coords must be safe integers, got (${col},${row})`);
  }
  if (col < 0 || row < 0 || col >= width || row >= height) {
    throw new GridError(`${name} (${col},${row}) is out of bounds for ${width}×${height}`);
  }
  const onBorder = col === 0 || col === width - 1 || row === 0 || row === height - 1;
  if (!onBorder) {
    throw new GridError(`${name} (${col},${row}) must lie on the border ring`);
  }
}

/**
 * Build and validate a grid from a structural spec. Throws {@link GridError} if
 * dimensions are not positive safe integers, the cell count exceeds
 * {@link CELL_CAP}, or the entrance/exit are not distinct safe-integer cells on
 * the border ring. Entrance/exit are cloned and frozen so the returned grid can
 * never desync from the caller mutating its spec.
 */
export function buildGrid(spec: GridSpec): Grid {
  const { widthTiles: width, heightTiles: height, entrance, exit } = spec;

  assertPositiveSafeInt(width, 'widthTiles');
  assertPositiveSafeInt(height, 'heightTiles');
  const cellCount = width * height;
  if (cellCount > CELL_CAP) {
    throw new GridError(`board too large: ${cellCount} cells exceeds CELL_CAP ${CELL_CAP}`);
  }

  assertBorderCell(entrance, width, height, 'entrance');
  assertBorderCell(exit, width, height, 'exit');

  // Snapshot the opening coordinates as plain numbers up front. Everything below
  // (the mask, `classAt`) reads only these — never the caller's spec objects — so
  // the grid can never desync from a spec the caller mutates after this returns.
  const entranceCol = entrance.col;
  const entranceRow = entrance.row;
  const exitCol = exit.col;
  const exitRow = exit.row;
  if (entranceCol === exitCol && entranceRow === exitRow) {
    throw new GridError(`entrance and exit coincide at (${entranceCol},${entranceRow})`);
  }

  const isOpening = (c: number, r: number): boolean =>
    (c === entranceCol && r === entranceRow) || (c === exitCol && r === exitRow);

  // Derive the base mask: the border ring is blocked, except the two openings.
  const baseMask = new Uint8Array(cellCount);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const border = c === 0 || c === width - 1 || r === 0 || r === height - 1;
      if (border && !isOpening(c, r)) baseMask[r * width + c] = 1;
    }
  }

  const frozenEntrance: Cell = Object.freeze({ col: entranceCol, row: entranceRow });
  const frozenExit: Cell = Object.freeze({ col: exitCol, row: exitRow });

  const inBounds = (cell: Cell): boolean =>
    cell.col >= 0 && cell.row >= 0 && cell.col < width && cell.row < height;

  const classAt = (cell: Cell): CellClass => {
    if (!inBounds(cell)) {
      throw new GridError(`classAt: (${cell.col},${cell.row}) is out of bounds`);
    }
    if (isOpening(cell.col, cell.row)) return 'walkable-unbuildable';
    return baseMask[cell.row * width + cell.col] !== 0 ? 'blocked' : 'buildable-open';
  };

  const grid: Grid = {
    width,
    height,
    entrance: frozenEntrance,
    exit: frozenExit,
    baseMask,
    classAt,
    inBounds,
  };
  return Object.freeze(grid);
}

/**
 * The passable 8-connected neighbours of `cell`, in the fixed emission order,
 * with no corner-cutting. Blocking is ADDITIVE: a cell is blocked when the grid's
 * base terrain marks it OR the optional `extraBlocked` mask does — so the base
 * border is always in force and an injected mask can only add walls. When given,
 * `extraBlocked` must be a row-major mask of exactly `width · height` bytes
 * (nonzero = blocked); a wrong length throws (a short mask must not let an
 * out-of-bounds read masquerade as "open" and permit a corner-cut).
 */
export function neighbors(grid: Grid, cell: Cell, extraBlocked?: Uint8Array): Cell[] {
  const { width, height, baseMask } = grid;
  if (extraBlocked !== undefined && extraBlocked.length !== width * height) {
    throw new GridError(`extraBlocked length ${extraBlocked.length} !== ${width * height}`);
  }
  const blocked = (c: number, r: number): boolean => {
    if (c < 0 || r < 0 || c >= width || r >= height) return true; // OOB is blocked
    const i = r * width + c;
    return baseMask[i] !== 0 || (extraBlocked !== undefined && extraBlocked[i] !== 0);
  };
  const out: Cell[] = [];
  forEachPassableNeighbor(cell.col, cell.row, blocked, (nc, nr) => {
    out.push({ col: nc, row: nr });
  });
  return out;
}
