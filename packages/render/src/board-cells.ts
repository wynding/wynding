// board-cells.ts — pure board-paint geometry (#38): the outer-ring "blocked border"
// cells, the ordered draw PLAN, and `drawBoard`, the executor that paints that plan
// verbatim. All three are Phaser-free and unit-tested. The executor used to live inside
// `scene.ts` (coverage-excluded) and repaint the board into a `Graphics` every frame; since
// the visual pass's V2 (#181) it paints ONCE per bake, into the board texture (`bake.ts`).

import type { GraphicsLike } from './board-draw';
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
 * entrance/exit glyphs. `drawBoard` below is a thin executor of exactly this plan — the
 * integration seam a helper-only unit test can't reach. Depends only on geometry (static
 * per board) and `palette` (changes only on a colour-mode switch); the board is baked once
 * per cell size, dpr and colour mode (`bake.ts`), never per frame (ADR 0005).
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
      case 'entrance': {
        g.fillStyle(op.colour, 1);
        const x = op.cell.col * cellPx;
        const y = op.cell.row * cellPx;
        g.fillTriangle(x, y, x + cellPx, y + cellPx / 2, x, y + cellPx);
        break;
      }
      case 'exit': {
        g.fillStyle(op.colour, 1);
        const x = op.cell.col * cellPx;
        const y = op.cell.row * cellPx;
        g.fillRect(x + cellPx * 0.25, y + cellPx * 0.25, cellPx * 0.5, cellPx * 0.5);
        break;
      }
    }
  }
}
