// board-integration.test.ts — the sim's grid/pathfinding built over the REAL M1
// board authored in @wynding/content. This is the only place the sim reaches for
// content, and it does so as a test-only devDependency: it proves the structural
// `GridSpec` seam lets the sim consume `Board` with no runtime content dependency.

import { describe, it, expect } from 'vitest';
import { sampleBoard } from '@wynding/content';
import { buildGrid } from './board';
import { computeDistanceField, shortestPath } from './pathfinding';

describe('field-01 (the real M1 board)', () => {
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
});
