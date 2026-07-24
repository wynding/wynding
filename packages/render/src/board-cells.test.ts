// board-cells.test.ts — the blocked-border ring geometry and the board's ordered paint
// plan (#38). Pure, no Phaser — `scene.ts`'s `drawBoard` is a thin executor of exactly
// this plan (the integration seam this test proves, since scene.ts itself is coverage-
// excluded, exercised by the Playwright e2e smoke instead).

import { describe, it, expect } from 'vitest';
import { borderCells, boardPaintOps } from './board-cells';
import { resolvePalette } from './palette';

const GEOMETRY = {
  cols: 28,
  rows: 24,
  entrance: { col: 0, row: 11 },
  exit: { col: 27, row: 11 },
};

describe('borderCells', () => {
  it('yields exactly the perimeter cell count, excluding entrance and exit', () => {
    const cells = borderCells(GEOMETRY);
    // 2*28 + 2*24 - 4 (double-counted corners) - 2 (entrance + exit) = 98
    expect(cells).toHaveLength(2 * 28 + 2 * 24 - 4 - 2);
  });

  it('every cell is on the outer ring (col 0/27 or row 0/23)', () => {
    const cells = borderCells(GEOMETRY);
    for (const c of cells) {
      expect(c.col === 0 || c.col === 27 || c.row === 0 || c.row === 23).toBe(true);
    }
  });

  it('excludes the entrance and exit cells', () => {
    const cells = borderCells(GEOMETRY);
    expect(cells.some((c) => c.col === 0 && c.row === 11)).toBe(false);
    expect(cells.some((c) => c.col === 27 && c.row === 11)).toBe(false);
  });

  it('contains no strictly-interior cell', () => {
    const cells = borderCells(GEOMETRY);
    for (const c of cells) {
      const interior = c.col > 0 && c.col < 27 && c.row > 0 && c.row < 23;
      expect(interior).toBe(false);
    }
  });
});

describe('boardPaintOps', () => {
  it('paints the border ring cells in pal.border', () => {
    const pal = resolvePalette('default');
    const ops = boardPaintOps(GEOMETRY, pal);
    const border = ops.find((o) => o.kind === 'border');
    expect(border).toBeDefined();
    if (border?.kind !== 'border') return;
    expect(border.colour).toBe(pal.border);
    expect(border.cells).toHaveLength(2 * 28 + 2 * 24 - 4 - 2);
  });

  it('orders border AFTER the floor fill and BEFORE the entrance/exit glyphs', () => {
    const pal = resolvePalette('default');
    const ops = boardPaintOps(GEOMETRY, pal);
    const kinds = ops.map((o) => o.kind);
    expect(kinds.indexOf('floor')).toBeLessThan(kinds.indexOf('border'));
    expect(kinds.indexOf('border')).toBeLessThan(kinds.indexOf('entrance'));
    expect(kinds.indexOf('border')).toBeLessThan(kinds.indexOf('exit'));
  });

  it('gives the entrance/exit cells no border fill (they are excluded from the border op)', () => {
    const pal = resolvePalette('default');
    const ops = boardPaintOps(GEOMETRY, pal);
    const border = ops.find((o) => o.kind === 'border');
    if (border?.kind !== 'border') throw new Error('no border op');
    expect(border.cells.some((c) => c.col === 0 && c.row === 11)).toBe(false);
    expect(border.cells.some((c) => c.col === 27 && c.row === 11)).toBe(false);
  });

  it('resolves the entrance/exit ops to their own palette colours and cells', () => {
    const pal = resolvePalette('default');
    const ops = boardPaintOps(GEOMETRY, pal);
    const entrance = ops.find((o) => o.kind === 'entrance');
    const exit = ops.find((o) => o.kind === 'exit');
    expect(entrance).toMatchObject({ colour: pal.entrance, cell: GEOMETRY.entrance });
    expect(exit).toMatchObject({ colour: pal.exit, cell: GEOMETRY.exit });
  });
});
