// boards.test.ts — pins the authored M1 board values. Pure data assertions; no
// sim dependency (the sim's grid/pathfinding derivation is tested in @wynding/sim).

import { describe, it, expect } from 'vitest';
import { sampleBoard, boards } from './boards';

describe('sampleBoard (field-01, the M1 board)', () => {
  it('has the M1 geometry: a 28×24 grid', () => {
    expect(sampleBoard.id).toBe('field-01');
    expect(sampleBoard.widthTiles).toBe(28);
    expect(sampleBoard.heightTiles).toBe(24);
  });

  it('places the single entrance/exit openings on row 11 of the left/right border', () => {
    expect(sampleBoard.entrance).toEqual({ col: 0, row: 11 });
    expect(sampleBoard.exit).toEqual({ col: 27, row: 11 });
    // Both sit on the border ring and are distinct — the sim validates this too,
    // but pinning it here catches a bad edit at the content layer.
    expect(sampleBoard.entrance.col).toBe(0);
    expect(sampleBoard.exit.col).toBe(sampleBoard.widthTiles - 1);
  });

  it('carries the M1 starting economy', () => {
    expect(sampleBoard.startingLives).toBe(10);
    expect(sampleBoard.startingBounty).toBe(80);
  });

  it('is the only bundled board', () => {
    expect(boards).toHaveLength(1);
    expect(boards[0]).toBe(sampleBoard);
  });
});
