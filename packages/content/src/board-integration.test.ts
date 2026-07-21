// board-integration.test.ts — proves the authored M1 board (field-01) builds a
// valid, solvable grid when fed to the sim's grid/pathfinding. It lives on the
// CONTENT side (content → sim) because the repo's dependency graph flows one way
// (types ← engine ← sim ← content); @wynding/sim is a test-only devDependency
// here, so no backwards sim → content edge is introduced.

import { describe, it, expect } from 'vitest';
import {
  buildGrid,
  computeDistanceField,
  shortestPath,
  loadBoard,
  createInitialState,
  GridError,
} from '@wynding/sim';
import { sampleBoard } from './boards';

describe('field-01 (the real M1 board) builds a solvable grid', () => {
  const grid = buildGrid(sampleBoard);
  const field = computeDistanceField(grid);

  it('builds a valid 28×24 grid with the two openings on row 11', () => {
    expect(grid.width).toBe(28);
    expect(grid.height).toBe(24);
    expect(grid.classAt({ col: 0, row: 11 })).toBe('walkable-unbuildable'); // entrance
    expect(grid.classAt({ col: 27, row: 11 })).toBe('walkable-unbuildable'); // exit
    expect(grid.classAt({ col: 1, row: 1 })).toBe('buildable-open'); // field corner
    expect(grid.classAt({ col: 0, row: 0 })).toBe('blocked'); // border corner
  });

  it('places the entrance 27 orthogonal steps from the exit (distance 270)', () => {
    expect(field.dist[11 * 28 + 0]).toBe(270); // 27 × 10
  });

  it('routes the entrance→exit shortest path straight along row 11', () => {
    const path = shortestPath(grid, field);
    expect(path).not.toBeNull();
    const p = path!;
    expect(p).toHaveLength(28); // cols 0..27 inclusive
    expect(p[0]).toEqual({ col: 0, row: 11 });
    expect(p[p.length - 1]).toEqual({ col: 27, row: 11 });
    expect(p.every((c) => c.row === 11)).toBe(true); // never leaves row 11
    expect(p.map((c) => c.col)).toEqual(Array.from({ length: 28 }, (_, i) => i));
  });

  it('surfaces buildGrid validation failures as a GridError through the @wynding/sim barrel', () => {
    // A downstream consumer can instanceof-catch the advertised typed failure via
    // the public barrel — not only through a package-internal relative import.
    expect(() => buildGrid({ ...sampleBoard, widthTiles: 0 })).toThrow(GridError);
  });
});

describe('field-01 as a loadable sim board', () => {
  it('builds a playable BoardContext through the sanctioned loadBoard constructor', () => {
    // The authored board passes the sim's full context validator (reachable
    // entrance, consistent field) — proving the production board is playable.
    expect(() => loadBoard(sampleBoard)).not.toThrow();
    const board = loadBoard(sampleBoard);
    expect(board.grid.width).toBe(28);
    expect(board.field.dist[11 * 28 + 0]).toBe(270); // entrance is 27 orthogonal steps out
  });

  it('keeps the interim sim economy constants in sync with the board content', () => {
    // Drift guard: until Story 5 makes the board the single source of truth, the
    // sim's starting lives/bounty must equal the content values — a divergence
    // turns this red rather than silently desyncing the economy.
    const s = createInitialState(1);
    expect(s.lives).toBe(sampleBoard.startingLives);
    expect(s.bounty).toBe(sampleBoard.startingBounty);
  });
});
