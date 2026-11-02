// balance-run.test.ts — M3 story 1: the instrumented run (`balance-run.ts`) on short real
// runs of M2's board. An undefended board loses wave 1 outright (ten `normal` creeps, ten
// lives), which exercises every leak path in a few hundred ticks; the full-arc
// measurements are `balance-calibration.test.ts`'s.

import { describe, it, expect } from 'vitest';
import {
  cellCenterX,
  cellCenterY,
  compileRuleset,
  computeDistanceField,
  createInitialState,
  hashSimState,
  type DistanceField,
  type SimState,
} from '@wynding/sim';
import type { Ruleset } from '@wynding/types';
import { getBundledRuleset } from './registry';
import { FIELD_UNITS_PER_CELL, remainingFraction, runReferenceBuild } from './balance-run';
import { runBuildScript, type ScriptStep } from './script-runner';
import { compileReferenceBuild, drawGrid, type ReferenceBuild } from './reference-build';
import { WINNER_A } from './showcase-builds';

const ruleset = compileRuleset(getBundledRuleset('wynding-core'), 'field-01');
const SEED = 0x5eed;

/** A state holding one creep of `creepId`, on its way from cell `from` to cell `head`. */
function oneCreep(
  creepId: string,
  from: readonly [number, number],
  head: readonly [number, number],
  progress: number,
): SimState {
  const state = createInitialState(SEED, ruleset);
  state.creeps = {
    id: [1],
    hp: [20],
    bounty: [1],
    speed: [26],
    fromX: [cellCenterX(from[0])],
    fromY: [cellCenterY(from[1])],
    headCol: [head[0]],
    headRow: [head[1]],
    progress: [progress],
    wave: [0],
    creepId: [creepId],
    slowMulFp: [0],
    slowUntilTick: [0],
    stunUntilTick: [0],
    destination: [0], // field-01's one destination, west → east
  };
  return state;
}

describe('remaining fraction — the closest-approach measure, per creep', () => {
  const { fields, grid } = ruleset.board;
  const EAST = grid.exits[0]!;
  const fraction = (state: SimState, f: readonly DistanceField[] = fields) =>
    remainingFraction(ruleset, state, 0, f);

  it('is 1 for a creep resting on the entrance, ground or air, on the empty board', () => {
    expect(fraction(oneCreep('normal', [0, 11], [0, 11], 0))).toBe(1);
    expect(fraction(oneCreep('flying', [0, 11], [0, 11], 0))).toBe(1);
  });

  it('reads a ground creep by path distance to its next cell plus the step it is part-way through', () => {
    // Half-way from (13,11) to (14,11): 13 cells of path left from the head, plus half a cell.
    expect(fraction(oneCreep('normal', [13, 11], [14, 11], 128))).toBe(13.5 / 27);
    // A wall across row 11 makes the same creep's path longer than the empty board's.
    const wall = new Uint8Array(ruleset.board.grid.width * ruleset.board.grid.height);
    for (let row = 1; row <= 20; row++) wall[row * ruleset.board.grid.width + 20] = 1;
    expect(
      fraction(oneCreep('normal', [13, 11], [14, 11], 128), [
        computeDistanceField(ruleset.board.grid, EAST, wall),
      ]),
    ).toBeGreaterThan(13.5 / 27);
  });

  it('reads an air creep by straight line to the exit, whatever the maze', () => {
    expect(fraction(oneCreep('flying', [13, 11], [14, 11], 128))).toBe(13.5 / 27);
  });

  it('has no reading for a row whose position does not derive, or a ground creep whose next cell is walled', () => {
    expect(fraction(oneCreep('normal', [13, 11], [14, 11], -1))).toBeNull();
    const covered = new Uint8Array(ruleset.board.grid.width * ruleset.board.grid.height);
    covered[11 * ruleset.board.grid.width + 14] = 1;
    expect(
      fraction(oneCreep('normal', [13, 11], [14, 11], 128), [
        computeDistanceField(ruleset.board.grid, EAST, covered),
      ]),
    ).toBeNull();
  });

  it('has no reading for a row whose destination names no field', () => {
    const forged = oneCreep('normal', [13, 11], [14, 11], 128);
    forged.creeps.destination[0] = 7;
    expect(fraction(forged)).toBeNull();
  });

  it('refuses a destination two entrances share: the creep’s own entrance is not recorded', () => {
    // field-01 plus a second entrance bound for the same exit — which entrance a creep
    // left is what its empty-board distance needs, and the sim keeps only its destination.
    const b = structuredClone(getBundledRuleset('wynding-core')) as Ruleset;
    (b.boards[0]!.entrances as unknown as object[]).push({
      id: 'west-lo',
      cell: { col: 0, row: 20 },
      destination: ['east'],
    });
    const shared = compileRuleset(b, 'field-01');
    const state = createInitialState(SEED, shared);
    state.creeps = oneCreep('normal', [13, 11], [14, 11], 128).creeps;
    expect(() => remainingFraction(shared, state, 0, shared.board.fields)).toThrow(
      /destination 0 is served by 2 entrances/,
    );
  });
});

describe('the instrumented reference-build run', { timeout: 120_000 }, () => {
  it("the field unit is one orthogonal step: field-01's empty path is 27 tiles", () => {
    const { grid, fields } = ruleset.board;
    const entrance = grid.entrances[0]!;
    expect(fields[0]!.dist[entrance.row * grid.width + entrance.col]).toBe(
      27 * FIELD_UNITS_PER_CELL,
    );
  });

  it('an undefended board: every wave-1 creep leaks, booked to wave 1 though wave 2 launched first, and nothing was placed', () => {
    const run = runReferenceBuild(ruleset, SEED, []);
    expect(run.state.phase).toBe('lost');
    expect(run.kills).toBe(0);
    expect(run.leaks.map((l) => [l.creepId, l.wave])).toEqual(
      Array.from({ length: 10 }, () => ['normal', 0]),
    );
    // Wave 2's countdown runs out while wave 1's tail is still walking, so the run ends in
    // wave 2's window — and what wave 1's creeps did stays on wave 1's row.
    expect(run.waves).toHaveLength(2);
    expect(run.waves[0]).toMatchObject({
      wave: 0,
      leaks: 10,
      livesLost: 10,
      closestApproach: 0,
      towers: 0,
      placed: 0,
    });
    expect(run.waves[0]!.lives).toBe(8);
    expect(run.waves[1]).toMatchObject({ wave: 1, leaks: 0, livesLost: 0, lives: 0 });
    // All ten of wave 1 on the board at once, then wave 2's sixteen with wave 1's last four;
    // each tick counts the creeps its own leaks removed, so the peak isn't read low.
    expect(run.waves.map((w) => w.peakAlive)).toEqual([10, 20]);
    expect(run.peakAlive).toBe(20);
    expect(run.lastPlacementWave).toBeNull();
    expect(run.spend).toBe(0);
    expect(run.stepsDone).toBe(0);
    // The last leak is on the final tick — the tick the run was lost.
    expect(run.leaks.at(-1)!.tick).toBe(run.state.tick - 1);
  });

  it('books a placement before wave 1 to no window, spend to its id, and a sell with the creeps it saw', () => {
    const plan: readonly ScriptStep[] = [
      { col: 2, row: 10, towerId: 'basic' },
      { col: 6, row: 10, towerId: 'basic', notBeforeTick: 520 },
      { kind: 'sell', col: 6, row: 10, notBeforeTick: 560 },
    ];
    const run = runReferenceBuild(ruleset, SEED, plan);
    expect(run.spendById).toEqual({ basic: 10 });
    expect(run.spend).toBe(10);
    expect(run.stepsDone).toBe(3);
    expect(run.stepCount).toBe(3);
    // Wave 1 launches at tick 500, so the second basic lands in its window.
    expect(run.lastPlacementWave).toBe(0);
    expect(run.waves[0]!.placed).toBe(1);
    // Three of wave 1 have spawned by tick 560, and one has already died to the basics.
    expect(run.sells).toEqual([{ tick: 560, col: 6, row: 10, towerId: 'basic', creepsAlive: 2 }]);
    expect([run.state.towers.col, run.state.towers.row, run.state.towers.towerId]).toEqual([
      [2],
      [10],
      ['basic'],
    ]);

    const early = runReferenceBuild(ruleset, SEED, plan.slice(0, 1));
    expect(early.lastPlacementWave).toBe(-1);
    expect(early.waves[0]!.placed).toBe(0);
    expect(early.waves[0]!.towers).toBe(1);
  });

  it('a mine re-armed after the last new tower leaves the board-full wave where that tower went down', () => {
    // Both towers go down before wave 1; the mine fires on tick 586 and is re-armed on 587,
    // in wave 1's window. The re-arm takes no new room, so the board filled before wave 1.
    const build: ReferenceBuild = {
      id: 'rearm',
      summary: 'a mine, a basic, the mine again',
      grid: drawGrid(ruleset, [
        [10, 12, 'm'],
        [2, 2, 'b'],
      ]),
      order: 'm10,12 b2,2 m10,12',
    };
    const run = runReferenceBuild(ruleset, SEED, compileReferenceBuild(build, ruleset));
    expect(run.stepsDone).toBe(3);
    expect(run.waves[0]!.placed).toBe(1);
    expect(run.lastPlacementWave).toBe(-1);
  });

  it('a held wave’s row, exactly: closest approach, lives, towers, placed, unspent, peak', () => {
    // Winner A's first fourteen towers hold waves 1–3 without a leak. Measured, and pinned
    // whole, so a change to how any column is booked moves a number here.
    const run = runReferenceBuild(ruleset, SEED, WINNER_A.slice(0, 14));
    const [w1, w2] = run.waves;
    expect(w1).toMatchObject({ wave: 0, leaks: 0, livesLost: 0, lives: 10, towers: 14 });
    expect([w1!.placed, w1!.unspent, w1!.peakAlive]).toEqual([2, 0, 5]);
    expect(w1!.closestApproach).toBeCloseTo(0.8405092592592592, 12);
    expect([w2!.placed, w2!.unspent, w2!.peakAlive]).toEqual([0, 20, 12]);
    expect(w2!.closestApproach).toBeCloseTo(0.45653935185185185, 12);
  });

  it('measures without changing the run: the same final hash as the bare runner', () => {
    const plan = WINNER_A.slice(0, 12);
    const bare = runBuildScript(ruleset, SEED, plan);
    expect(hashSimState(runReferenceBuild(ruleset, SEED, plan).state)).toBe(
      hashSimState(bare.state),
    );
  });
});
