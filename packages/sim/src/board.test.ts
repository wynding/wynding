// board.test.ts — grid classification, the runtime validation boundary, and the
// no-corner-cutting adjacency. Uses small local fixtures (not the real board).

import { describe, it, expect } from 'vitest';
import type { Cell } from '@wynding/types';
import { buildGrid, neighbors, CELL_CAP, GridError, type GridSpec } from './board';

// A 5×5 fixture: a blocked border ring with a left opening at (0,2) and a right
// opening at (4,2), leaving a 3×3 buildable-open interior (cols/rows 1..3).
function fixtureSpec(): GridSpec {
  return {
    widthTiles: 5,
    heightTiles: 5,
    entrances: [{ col: 0, row: 2 }],
    exits: [{ col: 4, row: 2 }],
  };
}

// Compare a neighbour list as an unordered set of "col,row" keys.
function cellSet(cells: readonly Cell[]): Set<string> {
  return new Set(cells.map((c) => `${c.col},${c.row}`));
}

describe('buildGrid — cell classification', () => {
  const grid = buildGrid(fixtureSpec());

  it('classifies the two openings as walkable-unbuildable', () => {
    expect(grid.classAt({ col: 0, row: 2 })).toBe('walkable-unbuildable');
    expect(grid.classAt({ col: 4, row: 2 })).toBe('walkable-unbuildable');
  });

  it('classifies the rest of the border (corners + edges) as blocked', () => {
    expect(grid.classAt({ col: 0, row: 0 })).toBe('blocked'); // corner
    expect(grid.classAt({ col: 4, row: 4 })).toBe('blocked'); // corner
    expect(grid.classAt({ col: 2, row: 0 })).toBe('blocked'); // top edge
    expect(grid.classAt({ col: 0, row: 1 })).toBe('blocked'); // left edge, not the opening
  });

  it('classifies the interior field as buildable-open', () => {
    expect(grid.classAt({ col: 1, row: 1 })).toBe('buildable-open');
    expect(grid.classAt({ col: 2, row: 2 })).toBe('buildable-open');
    expect(grid.classAt({ col: 3, row: 3 })).toBe('buildable-open');
  });

  it('exposes frozen, non-aliased geometry and the derived base mask', () => {
    expect(grid.width).toBe(5);
    expect(grid.height).toBe(5);
    expect(grid.baseMask).toBeInstanceOf(Uint8Array);
    expect(grid.baseMask.length).toBe(25);
    // border-minus-openings blocked; openings + interior clear
    expect(grid.baseMask[0 * 5 + 0]).toBe(1); // corner blocked
    expect(grid.baseMask[2 * 5 + 0]).toBe(0); // entrance opening clear
    expect(grid.baseMask[2 * 5 + 2]).toBe(0); // interior clear
  });

  it('throws on an out-of-bounds classAt query', () => {
    expect(() => grid.classAt({ col: 9, row: 9 })).toThrow(GridError);
    expect(grid.inBounds({ col: 9, row: 9 })).toBe(false);
    expect(grid.inBounds({ col: 2, row: 2 })).toBe(true);
  });

  it('rejects fractional cells rather than silently misreading terrain', () => {
    // A fractional col indexes baseMask with a non-index (→ undefined); untreated,
    // `undefined !== 0` is true, so classAt would silently report 'blocked' for
    // any fractional cell (wrong for an interior cell). inBounds now requires safe
    // integers, so classAt/neighbors reject such a cell with a typed error instead.
    expect(grid.inBounds({ col: 0.5, row: 0 })).toBe(false);
    expect(() => grid.classAt({ col: 0.5, row: 0 })).toThrow(GridError);
  });
});

describe('buildGrid — freezes and clones the entrance/exit lists', () => {
  it('returns frozen openings that do not alias the input spec', () => {
    const spec = fixtureSpec();
    const grid = buildGrid(spec);

    expect(Object.isFrozen(grid.entrances)).toBe(true);
    expect(Object.isFrozen(grid.exits)).toBe(true);
    expect(Object.isFrozen(grid.entrances[0])).toBe(true);
    expect(Object.isFrozen(grid.exits[0])).toBe(true);
    expect(grid.entrances).not.toBe(spec.entrances);
    expect(grid.entrances[0]).not.toBe(spec.entrances[0]);
    expect(grid.entrances).toEqual([{ col: 0, row: 2 }]);
    expect(grid.exits).toEqual([{ col: 4, row: 2 }]);

    // Mutating the caller's spec object afterward must not change the grid.
    (spec.entrances[0] as { col: number }).col = 99;
    (spec.entrances as Cell[]).push({ col: 2, row: 0 });
    expect(grid.entrances).toEqual([{ col: 0, row: 2 }]);
    expect(grid.classAt({ col: 0, row: 2 })).toBe('walkable-unbuildable');
  });
});

describe('buildGrid — several entrances and exits (format 3, ADR 0015)', () => {
  // A 7×7 board with two crossing pairs: west (0,3) → east (6,3), north (3,0) → south (3,6).
  const crossing: GridSpec = {
    widthTiles: 7,
    heightTiles: 7,
    entrances: [
      { col: 0, row: 3 },
      { col: 3, row: 0 },
    ],
    exits: [
      { col: 6, row: 3 },
      { col: 3, row: 6 },
    ],
  };

  it('opens every entrance and exit in the border, in list order', () => {
    const grid = buildGrid(crossing);
    expect(grid.entrances).toEqual(crossing.entrances);
    expect(grid.exits).toEqual(crossing.exits);
    for (const cell of [...crossing.entrances, ...crossing.exits]) {
      expect(grid.classAt(cell)).toBe('walkable-unbuildable');
      expect(grid.baseMask[cell.row * 7 + cell.col]).toBe(0);
    }
    expect(grid.classAt({ col: 2, row: 0 })).toBe('blocked'); // border beside an opening
  });

  it('rejects two openings on one cell, whichever lists they come from', () => {
    const at = (list: 'entrances' | 'exits', cell: Cell): GridSpec => ({
      ...crossing,
      [list]: [...crossing[list], cell],
    });
    expect(() => buildGrid(at('entrances', { col: 0, row: 3 }))).toThrow(/coincide/); // entrance ↔ entrance
    expect(() => buildGrid(at('exits', { col: 6, row: 3 }))).toThrow(/coincide/); // exit ↔ exit
    expect(() => buildGrid(at('exits', { col: 3, row: 0 }))).toThrow(/coincide/); // entrance ↔ exit
  });

  it('rejects an empty or non-array opening list with a typed GridError', () => {
    expect(() => buildGrid({ ...crossing, entrances: [] })).toThrow(GridError);
    expect(() => buildGrid({ ...crossing, exits: [] })).toThrow(GridError);
    expect(() =>
      buildGrid({ ...crossing, exits: { col: 6, row: 3 } } as unknown as GridSpec),
    ).toThrow(GridError);
  });

  it('checks every opening in a list, not only the first', () => {
    expect(() =>
      buildGrid({
        ...crossing,
        exits: [
          { col: 6, row: 3 },
          { col: 3, row: 3 },
        ],
      }),
    ).toThrow(/border ring/);
  });
});

describe('buildGrid — rejects malformed geometry (runtime validation)', () => {
  const bad = (patch: Partial<GridSpec>): (() => unknown) => {
    return () => buildGrid({ ...fixtureSpec(), ...patch });
  };

  it('rejects non-positive / non-integer dimensions', () => {
    expect(bad({ widthTiles: 0 })).toThrow(GridError);
    expect(bad({ heightTiles: -1 })).toThrow(GridError);
    expect(bad({ widthTiles: 3.5 })).toThrow(GridError);
    expect(bad({ heightTiles: Number.NaN })).toThrow(GridError);
  });

  it('rejects a cell count over CELL_CAP', () => {
    // 2 × CELL_CAP > CELL_CAP; the cap is checked before any allocation.
    expect(bad({ widthTiles: 2, heightTiles: CELL_CAP })).toThrow(/CELL_CAP/);
  });

  it('rejects entrance/exit off the border ring or out of bounds', () => {
    expect(bad({ entrances: [{ col: 2, row: 2 }] })).toThrow(/border ring/); // interior
    expect(bad({ exits: [{ col: 99, row: 2 }] })).toThrow(/out of bounds/);
  });

  it('rejects non-integer entrance/exit coordinates', () => {
    expect(bad({ entrances: [{ col: 0.5, row: 2 }] })).toThrow(GridError);
  });

  it('rejects coincident entrance and exit', () => {
    expect(bad({ exits: [{ col: 0, row: 2 }] })).toThrow(/coincide/);
  });

  it('rejects a null / non-object board document with a typed GridError', () => {
    // A parsed `null` (or non-object) JSON board must fail the validation
    // boundary with GridError, not a raw TypeError on destructure.
    expect(() => buildGrid(null as unknown as GridSpec)).toThrow(GridError);
    expect(() => buildGrid(undefined as unknown as GridSpec)).toThrow(GridError);
    expect(() => buildGrid(42 as unknown as GridSpec)).toThrow(GridError);
  });

  it('rejects a missing or null entrance/exit with a typed GridError (untyped loader path)', () => {
    // What `JSON.parse` of a board missing the `exits` key, or a null cell, yields.
    // TypeScript callers can't reach this, but the validation-boundary contract
    // must still fail loudly with a GridError, not a raw TypeError.
    const missingExits = { widthTiles: 5, heightTiles: 5, entrances: [{ col: 0, row: 2 }] };
    expect(() => buildGrid(missingExits as unknown as GridSpec)).toThrow(GridError);
    expect(() => buildGrid({ ...fixtureSpec(), entrances: null } as unknown as GridSpec)).toThrow(
      GridError,
    );
    expect(() => buildGrid({ ...fixtureSpec(), exits: [null] } as unknown as GridSpec)).toThrow(
      GridError,
    );
  });
});

describe('neighbors — 8-connected, additive blocking, no corner-cutting', () => {
  const grid = buildGrid(fixtureSpec());

  it('clamps at the edge: the entrance only opens inward', () => {
    // (0,2) can only step to the interior cell (1,2); every diagonal is a
    // corner-cut against the blocked left border, and N/S/W are blocked/OOB.
    expect(cellSet(neighbors(grid, { col: 0, row: 2 }))).toEqual(cellSet([{ col: 1, row: 2 }]));
  });

  it('never returns a base-blocked border cell, even with an all-zero extra mask', () => {
    const allZero = new Uint8Array(25);
    const withUndef = neighbors(grid, { col: 1, row: 1 });
    const withZero = neighbors(grid, { col: 1, row: 1 }, allZero);
    // Additive base terrain is always in force: an all-zero mask changes nothing.
    expect(cellSet(withZero)).toEqual(cellSet(withUndef));
    // (1,1) sits against the top-left border; no returned cell is on the ring.
    for (const c of withZero) {
      const onBorder = c.col === 0 || c.col === 4 || c.row === 0 || c.row === 4;
      expect(onBorder).toBe(false);
    }
  });

  it('forbids a diagonal when either shared orthogonal cell is blocked', () => {
    // Block N(2,1) and W(1,2) of the interior centre (2,2). That must remove
    // N, W, and every diagonal that shares one of them (NW, NE, SW), leaving
    // only E, SE, S.
    const extra = new Uint8Array(25);
    extra[1 * 5 + 2] = 1; // (col2,row1) = N
    extra[2 * 5 + 1] = 1; // (col1,row2) = W
    const got = cellSet(neighbors(grid, { col: 2, row: 2 }, extra));
    expect(got).toEqual(
      cellSet([
        { col: 3, row: 2 }, // E
        { col: 3, row: 3 }, // SE
        { col: 2, row: 3 }, // S
      ]),
    );
  });

  it('rejects an extraBlocked mask of the wrong length', () => {
    expect(() => neighbors(grid, { col: 2, row: 2 }, new Uint8Array(3))).toThrow(GridError);
  });

  it('rejects a fractional or out-of-bounds query cell (never emits fractional neighbours)', () => {
    expect(() => neighbors(grid, { col: 2.5, row: 2 })).toThrow(GridError);
    expect(() => neighbors(grid, { col: 99, row: 2 })).toThrow(GridError);
  });
});
