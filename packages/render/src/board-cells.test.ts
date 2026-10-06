// board-cells.test.ts — the blocked-border ring geometry, the board's ordered paint plan
// (#38), and `drawBoard`, the executor that paints the plan into the board texture (V2,
// #181). Pure, no Phaser — the executor used to live in the coverage-excluded `scene.ts`,
// so this is the first test that watches the plan actually being drawn.

import { describe, it, expect } from 'vitest';
import { borderCells, boardPaintOps, drawBoard } from './board-cells';
import type { GraphicsLike } from './board-draw';
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

describe('drawBoard — the plan, executed board-locally', () => {
  type Call = { method: string; args: unknown[] };
  const recorder = (): GraphicsLike & { calls: Call[] } => {
    const calls: Call[] = [];
    const record =
      (method: string) =>
      (...args: unknown[]): void => {
        calls.push({ method, args });
      };
    return {
      calls,
      fillStyle: record('fillStyle'),
      lineStyle: record('lineStyle'),
      fillRect: record('fillRect'),
      fillRoundedRect: record('fillRoundedRect'),
      strokeRoundedRect: record('strokeRoundedRect'),
      fillTriangle: record('fillTriangle'),
      fillCircle: record('fillCircle'),
      strokeCircle: record('strokeCircle'),
      fillPoints: record('fillPoints'),
      lineBetween: record('lineBetween'),
    };
  };
  const pal = resolvePalette('default');
  const CELL = 10;
  const draw = (): Call[] => {
    const g = recorder();
    drawBoard(g, boardPaintOps(GEOMETRY, pal), GEOMETRY, CELL);
    return g.calls;
  };

  it('fills the whole board in pal.floor from its own corner (0,0)', () => {
    const calls = draw();
    expect(calls[0]).toEqual({ method: 'fillStyle', args: [pal.floor, 1] });
    expect(calls[1]).toEqual({ method: 'fillRect', args: [0, 0, 28 * CELL, 24 * CELL] });
  });

  it('fills each border cell, one cell square, in pal.border', () => {
    const calls = draw();
    const borderStyle = calls.findIndex(
      (c) => c.method === 'fillStyle' && c.args[0] === pal.border,
    );
    expect(borderStyle).toBe(2);
    const cells = borderCells(GEOMETRY);
    const rects = calls.slice(borderStyle + 1, borderStyle + 1 + cells.length);
    expect(rects).toEqual(
      cells.map((c) => ({ method: 'fillRect', args: [c.col * CELL, c.row * CELL, CELL, CELL] })),
    );
  });

  it('draws the entrance as a triangle pointing into the board, in pal.entrance', () => {
    const calls = draw();
    const i = calls.findIndex((c) => c.method === 'fillTriangle');
    expect(calls[i - 1]).toEqual({ method: 'fillStyle', args: [pal.entrance, 1] });
    const x = GEOMETRY.entrance.col * CELL;
    const y = GEOMETRY.entrance.row * CELL;
    expect(calls[i]!.args).toEqual([x, y, x + CELL, y + CELL / 2, x, y + CELL]);
  });

  it('draws the exit as a centred half-cell square, in pal.exit, last', () => {
    const calls = draw();
    const last = calls[calls.length - 1]!;
    expect(calls[calls.length - 2]).toEqual({ method: 'fillStyle', args: [pal.exit, 1] });
    const x = GEOMETRY.exit.col * CELL;
    const y = GEOMETRY.exit.row * CELL;
    expect(last).toEqual({
      method: 'fillRect',
      args: [x + CELL * 0.25, y + CELL * 0.25, CELL * 0.5, CELL * 0.5],
    });
  });

  it('draws the plan in its own order — floor, border, entrance, exit — and nothing else', () => {
    const styles = draw()
      .filter((c) => c.method === 'fillStyle')
      .map((c) => c.args[0]);
    expect(styles).toEqual([pal.floor, pal.border, pal.entrance, pal.exit]);
    expect(draw().every((c) => ['fillStyle', 'fillRect', 'fillTriangle'].includes(c.method))).toBe(
      true,
    );
  });
});
