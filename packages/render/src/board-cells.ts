// board-cells.ts — pure board-paint geometry (#38): the outer-ring "blocked border"
// cells, and the ordered draw PLAN `scene.ts`'s `drawBoard` executes verbatim. Kept in a
// Phaser-free module so both are unit-testable; `scene.ts` is excluded from coverage
// (WebGL, exercised by the Playwright e2e smoke instead), so the ordering/content gate
// on the plan is the only real test coverage this drawing logic gets.

import type { Palette } from './palette';

/** Board size + entrance/exit — the same shape `scene.ts`'s `BoardGeometry` carries. */
export interface BoardCellsGeometry {
  readonly cols: number;
  readonly rows: number;
  readonly entrance: { readonly col: number; readonly row: number };
  readonly exit: { readonly col: number; readonly row: number };
}

export interface Cell {
  readonly col: number;
  readonly row: number;
}

/**
 * The outer-ring cells of a `cols`×`rows` grid — every cell on the border frame —
 * EXCLUDING the entrance and exit cells (those get their own glyph, not a blocked-border
 * fill). Derived purely from cols/rows/entrance/exit; no sim import, no maze knowledge.
 */
export function borderCells(geometry: BoardCellsGeometry): Cell[] {
  const { cols, rows, entrance, exit } = geometry;
  const isOpening = (col: number, row: number): boolean =>
    (col === entrance.col && row === entrance.row) || (col === exit.col && row === exit.row);
  const cells: Cell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const onBorder = col === 0 || col === cols - 1 || row === 0 || row === rows - 1;
      if (onBorder && !isOpening(col, row)) cells.push({ col, row });
    }
  }
  return cells;
}

/** One step of the board's paint plan, in the exact order it must be drawn. */
export type BoardPaintOp =
  | { readonly kind: 'floor'; readonly colour: number }
  | { readonly kind: 'border'; readonly colour: number; readonly cells: readonly Cell[] }
  | { readonly kind: 'entrance'; readonly colour: number; readonly cell: Cell }
  | { readonly kind: 'exit'; readonly colour: number; readonly cell: Cell };

/**
 * The board's ordered paint plan: floor fill → blocked-border ring (in `pal.border`) →
 * entrance/exit glyphs. `drawBoard` (scene.ts) is a thin executor of exactly this plan —
 * the integration seam a helper-only unit test can't reach. Depends only on geometry
 * (static per board) and `palette` (changes only on a colour-mode switch), so the caller
 * should precompute this at scene mount and rebuild ONLY when the palette changes —
 * steady-state per-frame drawing must stay allocation-free (ADR 0005).
 */
export function boardPaintOps(
  geometry: BoardCellsGeometry,
  palette: Palette,
): readonly BoardPaintOp[] {
  return [
    { kind: 'floor', colour: palette.floor },
    { kind: 'border', colour: palette.border, cells: borderCells(geometry) },
    { kind: 'entrance', colour: palette.entrance, cell: geometry.entrance },
    { kind: 'exit', colour: palette.exit, cell: geometry.exit },
  ];
}
