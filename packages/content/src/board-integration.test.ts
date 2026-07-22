// board-integration.test.ts — proves the authored M1 ruleset (field-01) builds a
// valid, solvable grid AND compiles for the sim. It lives on the CONTENT side
// (content → sim) because the repo's dependency graph flows one way
// (types ← engine ← sim ← content); @wynding/sim is a test-only devDependency here,
// so no backwards sim → content edge is introduced.

import { describe, it, expect } from 'vitest';
import {
  buildGrid,
  computeDistanceField,
  shortestPath,
  loadBoard,
  compileRuleset,
  createInitialState,
  GridError,
} from '@wynding/sim';
import { m1Ruleset, M1_BOARD_ID } from './boards';

const m1Board = m1Ruleset.boards[0]!;

describe('field-01 (the real M1 board) builds a solvable grid', () => {
  const grid = buildGrid(m1Board);
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
    expect(() => buildGrid({ ...m1Board, widthTiles: 0 })).toThrow(GridError);
  });
});

describe('field-01 compiles for the sim as the single source of truth', () => {
  it('builds a playable BoardContext through the sanctioned loadBoard constructor', () => {
    expect(() => loadBoard(m1Board)).not.toThrow();
    const board = loadBoard(m1Board);
    expect(board.grid.width).toBe(28);
    expect(board.field.dist[11 * 28 + 0]).toBe(270); // entrance is 27 orthogonal steps out
  });

  it('compiles the ruleset and seeds the sim economy FROM the content (Story 5)', () => {
    // Story 5 made the ruleset the single source of truth: createInitialState reads
    // the starting economy from the compiled bundle, no hardcoded sim constants.
    const ruleset = compileRuleset(m1Ruleset, M1_BOARD_ID);
    const s = createInitialState(1, ruleset);
    expect(s.lives).toBe(m1Ruleset.balance.startingLives);
    expect(s.bounty).toBe(m1Ruleset.balance.startingBounty);
    expect(s.phase).toBe('pre-wave');
    expect(ruleset.schedule).toHaveLength(10); // one wave × 10 creeps
  });
});
