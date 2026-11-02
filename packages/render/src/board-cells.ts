// board-cells.ts — pure board-paint geometry (#38): the outer-ring "blocked border"
// cells, the ordered draw PLAN, and `drawBoard`, the executor that paints that plan
// verbatim. All three are Phaser-free and unit-tested. The executor used to live inside
// `scene.ts` (coverage-excluded) and repaint the board into a `Graphics` every frame; since
// the visual pass's V2 (#181) it paints ONCE per bake, into the board texture (`bake.ts`).

import type { GraphicsLike } from './board-draw';
import type { Palette } from './palette';

/** Board size + every entrance and exit — the same shape `scene.ts`'s `BoardGeometry` carries.
 *  Each list is in the board's own order (the compiled grid's `entrances`/`exits`, M3), so an
 *  exit's index here is its index there. */
export interface BoardCellsGeometry {
  readonly cols: number;
  readonly rows: number;
  readonly entrances: readonly Cell[];
  readonly exits: readonly Cell[];
}

export interface Cell {
  readonly col: number;
  readonly row: number;
}

/** A compass heading on the board: east is +col, south is +row. */
export type Heading = 'north' | 'east' | 'south' | 'west';

/** The edge of the board a border cell sits on — west, east, north or south, checked in that
 *  order, so a corner reads as its column's edge. Every opening is a border cell (the board
 *  validator's rule), which is what makes this total for them. */
export function borderSide(
  geometry: Pick<BoardCellsGeometry, 'cols' | 'rows'>,
  cell: Cell,
): Heading {
  if (cell.col === 0) return 'west';
  if (cell.col === geometry.cols - 1) return 'east';
  if (cell.row === 0) return 'north';
  return 'south';
}

const OPPOSITE: Readonly<Record<Heading, Heading>> = {
  north: 'south',
  east: 'west',
  south: 'north',
  west: 'east',
};

/** The way creeps travel through an opening: INTO the board at an entrance, OUT of it at an
 *  exit. An entrance and the exit in line with it on the far wall therefore share a heading —
 *  that shared heading is the pair's shape cue (m3.md: each entrance shares a cue with its own
 *  exit, never colour alone). */
export function openingHeading(
  geometry: Pick<BoardCellsGeometry, 'cols' | 'rows'>,
  cell: Cell,
  kind: 'entrance' | 'exit',
): Heading {
  const side = borderSide(geometry, cell);
  return kind === 'exit' ? side : OPPOSITE[side];
}

/**
 * The outer-ring cells of a `cols`×`rows` grid — every cell on the border frame —
 * EXCLUDING every entrance and exit cell (those get their own glyph, not a blocked-border
 * fill). Derived purely from cols/rows and the openings; no sim import, no maze knowledge.
 */
export function borderCells(geometry: BoardCellsGeometry): Cell[] {
  const { cols, rows } = geometry;
  const openings = new Set(
    [...geometry.entrances, ...geometry.exits].map((c) => c.row * cols + c.col),
  );
  const cells: Cell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const onBorder = col === 0 || col === cols - 1 || row === 0 || row === rows - 1;
      if (onBorder && !openings.has(row * cols + col)) cells.push({ col, row });
    }
  }
  return cells;
}

/** One step of the board's paint plan, in the exact order it must be drawn. An opening's
 *  `heading` is the way creeps travel through it (`openingHeading`). */
export type BoardPaintOp =
  | { readonly kind: 'floor'; readonly colour: number }
  | { readonly kind: 'border'; readonly colour: number; readonly cells: readonly Cell[] }
  | {
      readonly kind: 'entrance' | 'exit';
      readonly colour: number;
      readonly cell: Cell;
      readonly heading: Heading;
    };

/**
 * The board's ordered paint plan: floor fill → blocked-border ring (in `pal.border`) → every
 * entrance glyph, then every exit glyph, each in board order. `drawBoard` below is a thin
 * executor of exactly this plan — the integration seam a helper-only unit test can't reach.
 * Depends only on geometry (static per board) and `palette` (changes only on a colour-mode
 * switch); the board is baked once per cell size, dpr and colour mode (`bake.ts`), never per
 * frame (ADR 0005).
 */
export function boardPaintOps(
  geometry: BoardCellsGeometry,
  palette: Palette,
): readonly BoardPaintOp[] {
  const opening =
    (kind: 'entrance' | 'exit', colour: number) =>
    (cell: Cell): BoardPaintOp => ({
      kind,
      colour,
      cell,
      heading: openingHeading(geometry, cell, kind),
    });
  return [
    { kind: 'floor', colour: palette.floor },
    { kind: 'border', colour: palette.border, cells: borderCells(geometry) },
    ...geometry.entrances.map(opening('entrance', palette.entrance)),
    ...geometry.exits.map(opening('exit', palette.exit)),
  ];
}

/** A point given ALONG the heading (`u`, 0 → 1 across the cell in the direction of travel) and
 *  ACROSS it (`v`), in the cell whose top-left is (`x`, `y`). Every glyph below is symmetric
 *  about `v = 0.5`, so which side `v` runs from does not matter. */
function along(
  heading: Heading,
  x: number,
  y: number,
  cellPx: number,
  u: number,
  v: number,
): { x: number; y: number } {
  switch (heading) {
    case 'east':
      return { x: x + u * cellPx, y: y + v * cellPx };
    case 'west':
      return { x: x + (1 - u) * cellPx, y: y + v * cellPx };
    case 'south':
      return { x: x + v * cellPx, y: y + u * cellPx };
    case 'north':
      return { x: x + v * cellPx, y: y + (1 - u) * cellPx };
  }
}

/** The opening glyphs, as (`u`, `v`) corners for `along`. The entrance is a triangle the full
 *  cell, pointing the way creeps enter. The exit is the same triangle, smaller, pointing the way
 *  they leave, stopped by a bar at its tip: the heading is the pair's shared cue, the bar is what
 *  makes it an exit, and the colour says so a second time. */
export const ENTRANCE_TRIANGLE: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0.5],
  [0, 1],
];
export const EXIT_TRIANGLE: readonly (readonly [number, number])[] = [
  [0.1, 0.15],
  [0.65, 0.5],
  [0.1, 0.85],
];
/** The exit's bar, as two opposite (`u`, `v`) corners. */
export const EXIT_BAR: readonly (readonly [number, number])[] = [
  [0.7, 0.15],
  [0.85, 0.85],
];

function fillOpening(
  g: GraphicsLike,
  op: { readonly kind: 'entrance' | 'exit'; readonly cell: Cell; readonly heading: Heading },
  cellPx: number,
): void {
  const x = op.cell.col * cellPx;
  const y = op.cell.row * cellPx;
  const at = ([u, v]: readonly [number, number]): { x: number; y: number } =>
    along(op.heading, x, y, cellPx, u, v);
  const [a, b, c] = (op.kind === 'entrance' ? ENTRANCE_TRIANGLE : EXIT_TRIANGLE).map(at);
  g.fillTriangle(a!.x, a!.y, b!.x, b!.y, c!.x, c!.y);
  if (op.kind === 'exit') {
    const [p, q] = EXIT_BAR.map(at);
    g.fillRect(
      Math.min(p!.x, q!.x),
      Math.min(p!.y, q!.y),
      Math.abs(q!.x - p!.x),
      Math.abs(q!.y - p!.y),
    );
  }
}

/**
 * Paint `plan` in BOARD-LOCAL CSS px — the board's top-left corner is (0, 0), cell (c, r)
 * starts at (c × cellPx, r × cellPx). A thin executor of the plan verbatim (#38): the
 * ordering/content gate lives on `boardPaintOps` itself; do not reorder or special-case ops
 * here, change the plan instead. The geometry is the per-frame executor's, unchanged except
 * for its origin, which used to be the projection's letterbox offset and is now the board
 * texture's own corner (the texture is positioned at that offset instead).
 */
export function drawBoard(
  g: GraphicsLike,
  plan: readonly BoardPaintOp[],
  geometry: Pick<BoardCellsGeometry, 'cols' | 'rows'>,
  cellPx: number,
): void {
  for (const op of plan) {
    switch (op.kind) {
      case 'floor': {
        g.fillStyle(op.colour, 1);
        g.fillRect(0, 0, geometry.cols * cellPx, geometry.rows * cellPx);
        break;
      }
      case 'border': {
        g.fillStyle(op.colour, 1);
        for (const cell of op.cells)
          g.fillRect(cell.col * cellPx, cell.row * cellPx, cellPx, cellPx);
        break;
      }
      case 'entrance':
      case 'exit': {
        g.fillStyle(op.colour, 1);
        fillOpening(g, op, cellPx);
        break;
      }
    }
  }
}
