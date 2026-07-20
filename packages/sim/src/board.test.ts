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
    entrance: { col: 0, row: 2 },
    exit: { col: 4, row: 2 },
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
});

describe('buildGrid — freezes and clones entrance/exit', () => {
  it('returns frozen openings that do not alias the input spec', () => {
    const spec = fixtureSpec();
    const grid = buildGrid(spec);

    expect(Object.isFrozen(grid.entrance)).toBe(true);
    expect(Object.isFrozen(grid.exit)).toBe(true);
    expect(grid.entrance).not.toBe(spec.entrance);
    expect(grid.entrance).toEqual({ col: 0, row: 2 });

    // Mutating the caller's spec object afterward must not change the grid.
    (spec.entrance as { col: number }).col = 99;
    expect(grid.entrance.col).toBe(0);
    expect(grid.classAt({ col: 0, row: 2 })).toBe('walkable-unbuildable');
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
    expect(bad({ entrance: { col: 2, row: 2 } })).toThrow(/border ring/); // interior
    expect(bad({ exit: { col: 99, row: 2 } })).toThrow(/out of bounds/);
  });

  it('rejects non-integer entrance/exit coordinates', () => {
    expect(bad({ entrance: { col: 0.5, row: 2 } })).toThrow(GridError);
  });

  it('rejects coincident entrance and exit', () => {
    expect(bad({ exit: { col: 0, row: 2 } })).toThrow(/coincide/);
  });

  it('rejects a null / non-object board document with a typed GridError', () => {
    // A parsed `null` (or non-object) JSON board must fail the validation
    // boundary with GridError, not a raw TypeError on destructure.
    expect(() => buildGrid(null as unknown as GridSpec)).toThrow(GridError);
    expect(() => buildGrid(undefined as unknown as GridSpec)).toThrow(GridError);
    expect(() => buildGrid(42 as unknown as GridSpec)).toThrow(GridError);
  });

  it('rejects a missing or null entrance/exit with a typed GridError (untyped loader path)', () => {
    // What `JSON.parse` of a board missing the `exit` key, or a null cell, yields.
    // TypeScript callers can't reach this, but the validation-boundary contract
    // must still fail loudly with a GridError, not a raw TypeError.
    const missingExit = { widthTiles: 5, heightTiles: 5, entrance: { col: 0, row: 2 } };
    expect(() => buildGrid(missingExit as unknown as GridSpec)).toThrow(GridError);
    expect(() => buildGrid({ ...fixtureSpec(), entrance: null } as unknown as GridSpec)).toThrow(
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
});
