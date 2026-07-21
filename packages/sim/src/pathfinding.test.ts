// pathfinding.test.ts — the exit-sourced distance field, reachability, and
// shortest-path reconstruction. Small local fixtures with hand-checkable values.

import { describe, it, expect } from 'vitest';
import type { Cell } from '@wynding/types';
import { buildGrid, GridError, type GridSpec } from './board';
import { computeDistanceField, isReachable, shortestPath, type DistanceField } from './pathfinding';

// The same 5×5 fixture as board.test: openings at (0,2) and (4,2), 3×3 interior.
function fixtureSpec(): GridSpec {
  return {
    widthTiles: 5,
    heightTiles: 5,
    entrance: { col: 0, row: 2 },
    exit: { col: 4, row: 2 },
  };
}

const idx = (c: number, r: number, w: number): number => r * w + c;

// Assert a path is a legal 8-connected, no-corner-cutting walk over the field's
// effective mask (each diagonal keeps both shared orthogonal cells open).
function assertLegalPath(path: readonly Cell[], field: DistanceField): void {
  const w = field.width;
  const blocked = (c: number, r: number): boolean =>
    c < 0 ||
    r < 0 ||
    c >= w ||
    r >= field.height ||
    (field.blockedMask[idx(c, r, w)] as number) !== 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const dc = b.col - a.col;
    const dr = b.row - a.row;
    expect(Math.max(Math.abs(dc), Math.abs(dr))).toBe(1); // 8-adjacent, single step
    expect(blocked(b.col, b.row)).toBe(false);
    if (dc !== 0 && dr !== 0) {
      expect(blocked(a.col + dc, a.row)).toBe(false);
      expect(blocked(a.col, a.row + dr)).toBe(false);
    }
  }
}

describe('computeDistanceField — exit-sourced octile distances', () => {
  const grid = buildGrid(fixtureSpec());
  const field = computeDistanceField(grid);

  it('is zero at the exit and increases monotonically along the straight run', () => {
    expect(field.dist[idx(4, 2, 5)]).toBe(0); // exit
    expect(field.dist[idx(3, 2, 5)]).toBe(10);
    expect(field.dist[idx(2, 2, 5)]).toBe(20);
    expect(field.dist[idx(1, 2, 5)]).toBe(30);
    expect(field.dist[idx(0, 2, 5)]).toBe(40); // entrance, 4 orthogonal steps × 10
  });

  it('marks the blocked border ring as unreachable (-1)', () => {
    expect(field.dist[idx(0, 0, 5)]).toBe(-1); // corner
    expect(field.dist[idx(2, 0, 5)]).toBe(-1); // top edge
  });

  it('is byte-identical across two runs (determinism)', () => {
    const a = computeDistanceField(grid);
    const b = computeDistanceField(grid);
    expect(Array.from(a.dist)).toEqual(Array.from(b.dist));
    expect(Array.from(a.blockedMask)).toEqual(Array.from(b.blockedMask));
  });
});

describe('isReachable', () => {
  const grid = buildGrid(fixtureSpec());
  const field = computeDistanceField(grid);

  it('is true for a cell with a route and false for blocked terrain', () => {
    expect(isReachable(field, { col: 0, row: 2 })).toBe(true); // entrance
    expect(isReachable(field, { col: 0, row: 0 })).toBe(false); // blocked corner
  });

  it('returns false for an out-of-bounds cell rather than throwing', () => {
    expect(isReachable(field, { col: -1, row: 2 })).toBe(false);
    expect(isReachable(field, { col: 99, row: 99 })).toBe(false);
  });
});

describe('shortestPath', () => {
  const grid = buildGrid(fixtureSpec());
  const field = computeDistanceField(grid);

  it('returns the straight entrance→exit line on the open board', () => {
    const path = shortestPath(grid, field);
    expect(path).toEqual([
      { col: 0, row: 2 },
      { col: 1, row: 2 },
      { col: 2, row: 2 },
      { col: 3, row: 2 },
      { col: 4, row: 2 },
    ]);
  });

  it('reroutes around an injected block, still a legal no-corner-cut path', () => {
    const extra = new Uint8Array(25);
    extra[idx(2, 2, 5)] = 1; // wall the centre of the straight run
    const blockedField = computeDistanceField(grid, extra);

    const path = shortestPath(grid, blockedField);
    expect(path).not.toBeNull();
    const p = path!;
    expect(p[0]).toEqual({ col: 0, row: 2 }); // starts at entrance
    expect(p[p.length - 1]).toEqual({ col: 4, row: 2 }); // ends at exit
    expect(p.some((c) => c.col === 2 && c.row === 2)).toBe(false); // avoids the wall
    expect(p.length).toBeGreaterThan(5); // longer than the straight line
    assertLegalPath(p, blockedField);
  });

  it('returns null when the start is walled off from the exit', () => {
    // Block the whole middle interior column — the left side can no longer reach
    // the right (any crossing would pass through the wall or cut a border corner).
    const extra = new Uint8Array(25);
    extra[idx(2, 1, 5)] = 1;
    extra[idx(2, 2, 5)] = 1;
    extra[idx(2, 3, 5)] = 1;
    const walled = computeDistanceField(grid, extra);
    expect(isReachable(walled, { col: 0, row: 2 })).toBe(false);
    expect(shortestPath(grid, walled)).toBeNull();
  });

  it('returns null for a field whose dimensions or exit do not match the grid', () => {
    const wider = buildGrid({ ...fixtureSpec(), widthTiles: 6, exit: { col: 5, row: 2 } });
    expect(shortestPath(wider, field)).toBeNull(); // dims differ

    const movedExit = buildGrid({ ...fixtureSpec(), exit: { col: 2, row: 4 } });
    expect(shortestPath(movedExit, field)).toBeNull(); // same dims, different exit
  });

  it('returns null rather than looping when a matching-shaped field has no descent', () => {
    // A hand-built field with correct dims/exit but a stranded start: (1,2) holds
    // a distance yet no neighbour exact-descends. shortestPath must bail to null.
    const stranded: DistanceField = {
      width: 5,
      height: 5,
      exit: { col: 4, row: 2 },
      blockedMask: field.blockedMask,
      dist: (() => {
        const d = new Int32Array(25).fill(-1);
        d[idx(4, 2, 5)] = 0; // exit
        d[idx(1, 2, 5)] = 5; // start, disconnected from the exit's descent
        return d;
      })(),
    };
    expect(shortestPath(grid, stranded, { col: 1, row: 2 })).toBeNull();
  });
});

describe('computeDistanceField — validation and defensive copy', () => {
  const grid = buildGrid(fixtureSpec());

  it('rejects an extraBlocked mask of the wrong length', () => {
    expect(() => computeDistanceField(grid, new Uint8Array(3))).toThrow(GridError);
  });

  it('rejects a mask that blocks the exit', () => {
    const extra = new Uint8Array(25);
    extra[idx(4, 2, 5)] = 1; // block the exit itself
    expect(() => computeDistanceField(grid, extra)).toThrow(/blocked/);
  });

  it('snapshots the effective mask — mutating the caller mask later cannot change the field', () => {
    const extra = new Uint8Array(25); // all open
    const field = computeDistanceField(grid, extra);
    expect(field.dist[idx(0, 2, 5)]).toBe(40);

    extra[idx(2, 2, 5)] = 1; // mutate AFTER computing
    expect(field.blockedMask[idx(2, 2, 5)]).toBe(0); // field kept its own copy
    expect(field.dist[idx(0, 2, 5)]).toBe(40); // distances unchanged
  });
});
