// board-cells.test.ts — the blocked-border ring geometry, the board's ordered paint plan
// (#38), and `drawBoard`, the executor that paints the plan into the board texture (V2,
// #181). Pure, no Phaser — the executor used to live in the coverage-excluded `scene.ts`,
// so this is the first test that watches the plan actually being drawn. Since M3 story 4 the
// geometry is the crossing board's: two entrances, two exits, each pair sharing a heading.

import { describe, it, expect } from 'vitest';
import {
  borderCells,
  borderSide,
  boardPaintOps,
  drawBoard,
  openingHeading,
  type BoardPaintOp,
} from './board-cells';
import { recordingGraphics as recorder, type Call } from './test-support/recording-graphics';
import { resolvePalette } from './palette';

const WEST = { col: 0, row: 11 };
const NORTH = { col: 13, row: 0 };
const EAST = { col: 27, row: 11 };
const SOUTH = { col: 13, row: 23 };

const GEOMETRY = { cols: 28, rows: 24, entrances: [WEST, NORTH], exits: [EAST, SOUTH] };
const OPENINGS = 4;
const RING = 2 * 28 + 2 * 24 - 4; // the perimeter, its corners counted once

describe('borderCells', () => {
  it('yields exactly the perimeter cell count, excluding every entrance and exit', () => {
    expect(borderCells(GEOMETRY)).toHaveLength(RING - OPENINGS);
  });

  it('every cell is on the outer ring (col 0/27 or row 0/23)', () => {
    for (const c of borderCells(GEOMETRY)) {
      expect(c.col === 0 || c.col === 27 || c.row === 0 || c.row === 23).toBe(true);
    }
  });

  it('excludes all four openings', () => {
    const cells = borderCells(GEOMETRY);
    for (const o of [WEST, NORTH, EAST, SOUTH]) {
      expect(cells.some((c) => c.col === o.col && c.row === o.row)).toBe(false);
    }
  });

  it('contains no strictly-interior cell', () => {
    for (const c of borderCells(GEOMETRY)) {
      expect(c.col > 0 && c.col < 27 && c.row > 0 && c.row < 23).toBe(false);
    }
  });
});

describe('borderSide and openingHeading — the way creeps travel through an opening', () => {
  it('names the wall each opening sits in', () => {
    expect([WEST, NORTH, EAST, SOUTH].map((c) => borderSide(GEOMETRY, c))).toEqual([
      'west',
      'north',
      'east',
      'south',
    ]);
  });

  it('points an entrance into the board and an exit out of it', () => {
    expect(openingHeading(GEOMETRY, WEST, 'entrance')).toBe('east');
    expect(openingHeading(GEOMETRY, NORTH, 'entrance')).toBe('south');
    expect(openingHeading(GEOMETRY, EAST, 'exit')).toBe('east');
    expect(openingHeading(GEOMETRY, SOUTH, 'exit')).toBe('south');
    // The two walls the crossing board leaves without an opening, for completeness.
    expect(openingHeading(GEOMETRY, EAST, 'entrance')).toBe('west');
    expect(openingHeading(GEOMETRY, NORTH, 'exit')).toBe('north');
  });
});

describe('boardPaintOps', () => {
  const pal = resolvePalette('default');
  const ops = boardPaintOps(GEOMETRY, pal);
  const openings = ops.filter(
    (o): o is Extract<BoardPaintOp, { kind: 'entrance' | 'exit' }> =>
      o.kind === 'entrance' || o.kind === 'exit',
  );

  it('paints the border ring cells in pal.border, every opening left out', () => {
    const border = ops.find((o) => o.kind === 'border');
    if (border?.kind !== 'border') throw new Error('no border op');
    expect(border.colour).toBe(pal.border);
    expect(border.cells).toHaveLength(RING - OPENINGS);
  });

  it('orders floor, border, then every entrance, then every exit, each in board order', () => {
    expect(ops.map((o) => o.kind)).toEqual([
      'floor',
      'border',
      'entrance',
      'entrance',
      'exit',
      'exit',
    ]);
    expect(openings.map((o) => o.cell)).toEqual([WEST, NORTH, EAST, SOUTH]);
  });

  it('gives each opening its own palette colour and the heading creeps travel through it', () => {
    expect(openings.map((o) => [o.kind, o.colour, o.heading])).toEqual([
      ['entrance', pal.entrance, 'east'],
      ['entrance', pal.entrance, 'south'],
      ['exit', pal.exit, 'east'],
      ['exit', pal.exit, 'south'],
    ]);
  });

  it('shares a heading within each pair and never across them — a shape cue, not a colour one', () => {
    const [west, north, east, south] = openings.map((o) => o.heading);
    expect(west).toBe(east);
    expect(north).toBe(south);
    expect(west).not.toBe(north);
  });
});

describe('drawBoard — the plan, executed board-locally', () => {
  const pal = resolvePalette('default');
  const CELL = 10;
  const draw = (): Call[] => {
    const g = recorder();
    drawBoard(g, boardPaintOps(GEOMETRY, pal), GEOMETRY, CELL);
    return g.calls;
  };
  /** The calls each opening drew: its style, then its shapes up to the next style. */
  const openingCalls = (): Call[][] => {
    const calls = draw();
    const firstOpening = calls.findIndex(
      (c) => c.method === 'fillStyle' && c.args[0] === pal.entrance,
    );
    const groups: Call[][] = [];
    for (const c of calls.slice(firstOpening)) {
      if (c.method === 'fillStyle') groups.push([]);
      else groups.at(-1)!.push(c);
    }
    return groups;
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

  it('draws each entrance as a full-cell triangle pointing into the board', () => {
    const [west, north] = openingCalls();
    const wx = WEST.col * CELL;
    const wy = WEST.row * CELL;
    expect(west).toEqual([
      { method: 'fillTriangle', args: [wx, wy, wx + CELL, wy + CELL / 2, wx, wy + CELL] },
    ]);
    const nx = NORTH.col * CELL;
    const ny = NORTH.row * CELL;
    expect(north).toEqual([
      { method: 'fillTriangle', args: [nx, ny, nx + CELL / 2, ny + CELL, nx + CELL, ny] },
    ]);
  });

  it('draws each exit as a smaller triangle pointing out of the board, stopped by a bar', () => {
    const [, , east, south] = openingCalls();
    const ex = EAST.col * CELL;
    const ey = EAST.row * CELL;
    expect(east).toEqual([
      {
        method: 'fillTriangle',
        args: [
          ex + 0.1 * CELL,
          ey + 0.15 * CELL,
          ex + 0.65 * CELL,
          ey + 0.5 * CELL,
          ex + 0.1 * CELL,
          ey + 0.85 * CELL,
        ],
      },
      {
        method: 'fillRect',
        args: [
          ex + 0.7 * CELL,
          ey + 0.15 * CELL,
          0.85 * CELL - 0.7 * CELL,
          0.85 * CELL - 0.15 * CELL,
        ],
      },
    ]);
    const sx = SOUTH.col * CELL;
    const sy = SOUTH.row * CELL;
    expect(south).toEqual([
      {
        method: 'fillTriangle',
        args: [
          sx + 0.15 * CELL,
          sy + 0.1 * CELL,
          sx + 0.5 * CELL,
          sy + 0.65 * CELL,
          sx + 0.85 * CELL,
          sy + 0.1 * CELL,
        ],
      },
      {
        method: 'fillRect',
        args: [
          sx + 0.15 * CELL,
          sy + 0.7 * CELL,
          0.85 * CELL - 0.15 * CELL,
          0.85 * CELL - 0.7 * CELL,
        ],
      },
    ]);
  });

  it('draws a west-heading opening mirrored, the bar on the board’s west side', () => {
    const g = recorder();
    const geometry = { cols: 28, rows: 24, entrances: [EAST], exits: [WEST] };
    drawBoard(g, boardPaintOps(geometry, pal), geometry, CELL);
    const rect = g.calls.at(-1)!;
    expect(rect.method).toBe('fillRect');
    // The bar runs u = 0.7 → 0.85 along a heading that runs west, so 0.15 → 0.3 of the cell.
    expect(rect.args[0]).toBeCloseTo(WEST.col * CELL + 0.15 * CELL);
    expect(rect.args[2]).toBeCloseTo(0.15 * CELL);
  });

  it('draws a north-heading exit with its bar at the top of its cell', () => {
    const g = recorder();
    const geometry = { cols: 28, rows: 24, entrances: [SOUTH], exits: [NORTH] };
    drawBoard(g, boardPaintOps(geometry, pal), geometry, CELL);
    const rect = g.calls.at(-1)!;
    expect(rect.args[1]).toBeCloseTo(NORTH.row * CELL + 0.15 * CELL);
    expect(rect.args[3]).toBeCloseTo(0.15 * CELL);
  });

  it('draws the plan in its own order — floor, border, entrances, exits — and nothing else', () => {
    const styles = draw()
      .filter((c) => c.method === 'fillStyle')
      .map((c) => c.args[0]);
    expect(styles).toEqual([pal.floor, pal.border, pal.entrance, pal.entrance, pal.exit, pal.exit]);
    expect(draw().every((c) => ['fillStyle', 'fillRect', 'fillTriangle'].includes(c.method))).toBe(
      true,
    );
  });
});
