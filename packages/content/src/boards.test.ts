// boards.test.ts — pins the authored M1 ruleset values. Pure data assertions; no
// sim dependency (the sim's grid/pathfinding derivation is tested in @wynding/sim).

import { describe, it, expect } from 'vitest';
import { m1Ruleset, rulesets, M1_BOARD_ID } from './boards';

const m1Board = m1Ruleset.boards[0]!;

describe('m1Ruleset (field-01, the M1 board)', () => {
  it('has the M1 geometry: a 28×24 grid', () => {
    expect(m1Board.id).toBe('field-01');
    expect(M1_BOARD_ID).toBe('field-01');
    expect(m1Board.widthTiles).toBe(28);
    expect(m1Board.heightTiles).toBe(24);
  });

  it('places the single entrance/exit openings on row 11 of the left/right border', () => {
    expect(m1Board.entrance).toEqual({ col: 0, row: 11 });
    expect(m1Board.exit).toEqual({ col: 27, row: 11 });
    expect(m1Board.entrance.col).toBe(0);
    expect(m1Board.exit.col).toBe(m1Board.widthTiles - 1);
  });

  it('carries the M1 starting economy and scoring', () => {
    expect(m1Ruleset.balance.startingLives).toBe(10);
    expect(m1Ruleset.balance.startingBounty).toBe(80);
    expect(m1Ruleset.balance.countdownTicks).toBe(500);
    expect(m1Ruleset.balance.waveClearBonus).toBe(0);
    expect(m1Ruleset.balance.earlyCallBonus).toBe(0);
    expect(m1Ruleset.scoring.survivalMul).toBe(25);
    expect(m1Ruleset.scoring.starThresholds).toEqual([1, 6, 9]);
  });

  it('carries the M1 creep and tower catalogs and a single wave of 10', () => {
    expect(m1Ruleset.creepCatalog).toEqual([
      { kind: 'normal', hp: 20, speedFp: 26, bounty: 1, domain: 'ground' },
    ]);
    expect(m1Ruleset.towerCatalog[0]).toMatchObject({ cost: 5, damage: 10, rangeFp: 1024 });
    expect(m1Board.waves).toHaveLength(1);
    expect(m1Board.waves[0]!.entries).toEqual([{ kind: 'normal', count: 10, spacingTicks: 20 }]);
  });

  it('is the only bundled ruleset', () => {
    expect(rulesets).toHaveLength(1);
    expect(rulesets[0]).toBe(m1Ruleset);
  });
});
