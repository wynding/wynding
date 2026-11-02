// balance-capacity.test.ts — M3 story 5: the capacity arithmetic (`balance-capacity.ts`) on
// small drawings and the shipped schedule, each branch on both sides; the check that the sim
// takes a drawing as drawn; and the report's capacity lines when the schedule's income does
// cover a drawing, and its failure when the sim refuses one. The registered capacity drawing
// is `balance-crossing.test.ts`'s.

import { describe, it, expect } from 'vitest';
import { compileRuleset } from '@wynding/sim';
import { loadRulesetOrM2Fixture } from './m2-fixture';
import { drawGrid, type ReferenceSet } from './reference-build';
import { M3_CROSSING, M3_UNDEFENDED, M3_WEST_ONLY } from './reference-builds';
import {
  drawnCapacity,
  firstWaveCovering,
  placeCapacityDrawing,
  scheduleIncome,
} from './balance-capacity';
import { balanceReport } from './balance-report';

const bundle = loadRulesetOrM2Fixture(M3_CROSSING.rulesetId);
const ruleset = compileRuleset(bundle, M3_CROSSING.boardId);

/** A basic on (1,10)–(2,11) walls in the west entrance at (0,11): the route is sealed. */
const SEALED = {
  id: 'sealed',
  summary: 'a basic across the west entrance',
  grid: drawGrid(ruleset, [[1, 10, 'b']]),
  order: 'b1,10',
};

describe('a drawing’s capacity', () => {
  it('prices every drawn tower once, at catalog cost — a sold and re-placed tower counts once', () => {
    const build = {
      id: 'probe',
      summary: 'a juggled basic beside a venom',
      grid: drawGrid(ruleset, [
        [2, 10, 'b'],
        [4, 10, 'v'],
      ]),
      order: 'b2,10 v4,10 -b2,10@700 b2,10',
    };
    expect(drawnCapacity(build, ruleset)).toEqual({
      towers: 2,
      bounty: 14,
      spendById: { basic: 5, venom: 9 },
    });
  });

  it('is nothing for an empty board', () => {
    expect(drawnCapacity(M3_UNDEFENDED, ruleset)).toEqual({ towers: 0, bounty: 0, spendById: {} });
  });
});

describe('a capacity drawing, placed', () => {
  const seed = M3_CROSSING.seed;

  it('stands tower by tower before wave 1, its whole price spent', () => {
    const { state, failures } = placeCapacityDrawing('probe', M3_WEST_ONLY, ruleset, seed);
    expect(failures).toEqual([]);
    expect(state.towers.id.length).toBe(19);
    expect(state.bounty).toBe(0);
    expect(state.waveLaunchTick[0]).toBeNull();
  });

  it('names a sell — and the re-placement the skipped sell leaves refused', () => {
    const juggled = {
      id: 'juggled',
      summary: 'a juggled basic',
      grid: drawGrid(ruleset, [[2, 10, 'b']]),
      order: 'b2,10 -b2,10@700 b2,10',
    };
    expect(placeCapacityDrawing('probe', juggled, ruleset, seed).failures).toEqual([
      'probe: a capacity drawing sells nothing, but it sells (2,10)',
      'probe: the sim refused its basic at (2,10)',
    ]);
  });

  it('names a tower the sim refuses: one that seals a route', () => {
    expect(placeCapacityDrawing('probe', SEALED, ruleset, seed).failures).toEqual([
      'probe: the sim refused its basic at (1,10)',
    ]);
  });

  it('names a wave 1 that launched before the last tower stood', () => {
    const board = bundle.boards[0]!;
    const waves = board.waves.map((w, k) => (k === 0 ? { ...w, countdownTicks: 1 } : w));
    const early = compileRuleset(
      { ...bundle, boards: [{ ...board, waves }, ...bundle.boards.slice(1)] },
      M3_CROSSING.boardId,
    );
    expect(placeCapacityDrawing('probe', M3_WEST_ONLY, early, seed).failures).toEqual([
      'probe: wave 1 launched before its last tower stood',
    ]);
  });
});

describe('a schedule’s income', () => {
  it('adds each wave’s kill bounty and clear bonus to the starting bounty, and the early calls beside it', () => {
    // Waves 1–3 of block 1: 10 normals, 16 swarm, 10 normals (1 bounty each), 2 a clear.
    // Wave 1's call pays nothing (Start claims it); a 500-tick countdown pays ⌊500 / 100⌋.
    expect(scheduleIncome(ruleset).slice(0, 3)).toEqual([
      { wave: 0, earned: 92, earnedWithCalls: 92 },
      { wave: 1, earned: 110, earnedWithCalls: 115 },
      { wave: 2, earned: 122, earnedWithCalls: 132 },
    ]);
  });

  it('pays no early call where the ruleset pays none', () => {
    const noCalls = compileRuleset(
      { ...bundle, balance: { ...bundle.balance, earlyCallBountyDivisor: 0 } },
      M3_CROSSING.boardId,
    );
    for (const row of scheduleIncome(noCalls)) expect(row.earnedWithCalls).toBe(row.earned);
  });

  it('names the first wave whose income covers a sum, with or without the calls, or none', () => {
    const income = scheduleIncome(ruleset);
    expect(firstWaveCovering(income, 92, false)).toBe(0);
    expect(firstWaveCovering(income, 123, false)).toBe(3); // 122 by wave 3, 152 by wave 4
    expect(firstWaveCovering(income, 123, true)).toBe(2); // 132 by wave 3
    expect(firstWaveCovering(income, 316, false)).toBeNull();
    expect(firstWaveCovering(income, 362, true)).toBeNull();
  });
});

describe('the report’s capacity lines', () => {
  it('name the wave whose income covers a drawing the schedule can pay for', () => {
    // West only's 19 towers, as a stand-in capacity drawing: 123 bounty.
    const set: ReferenceSet = {
      ...M3_CROSSING,
      id: 'probe',
      builds: [M3_UNDEFENDED],
      fullBoard: M3_WEST_ONLY,
    };
    const { text, failures } = balanceReport([set], loadRulesetOrM2Fixture);
    expect(failures).toEqual([]);
    expect(text).toContain(
      'capacity: m3-west-only draws 19 towers worth 123 bounty — basic 65, venom 27, splash 24, antiair 7',
    );
    expect(text).toContain('income (every kill and clear bonus) covers it by the end of wave 4');
    expect(text).toContain(
      'income with every early call at its maximum covers it by the end of wave 3',
    );
  });

  it('fail the report for a drawing the sim will not take', () => {
    const set: ReferenceSet = {
      ...M3_CROSSING,
      id: 'probe',
      builds: [M3_UNDEFENDED],
      fullBoard: SEALED,
    };
    expect(balanceReport([set], loadRulesetOrM2Fixture).failures).toEqual([
      'probe/sealed: the sim refused its basic at (1,10)',
    ]);
  });

  it('are absent for a set that draws no full board', () => {
    const set: ReferenceSet = { ...M3_CROSSING, id: 'probe', builds: [M3_UNDEFENDED] };
    const { fullBoard: _, ...withoutFull } = set;
    expect(balanceReport([withoutFull], loadRulesetOrM2Fixture).text).not.toContain('capacity:');
  });
});
