// balance-capacity.test.ts — M3 story 5: the capacity arithmetic (`balance-capacity.ts`) on
// small drawings and the shipped schedule, each branch on both sides; the check that the sim
// takes a drawing as drawn, and that it draws the strongest build; and the report's capacity
// lines when the schedule's income does cover a drawing and when it falls short, and its
// failure when the sim refuses one or it draws another build. The registered capacity
// drawing is `balance-crossing.test.ts`'s.

import { describe, it, expect } from 'vitest';
import { compileRuleset } from '@wynding/sim';
import { loadRulesetOrM2Fixture } from './m2-fixture';
import { drawGrid, type ReferenceBuild, type ReferenceSet } from './reference-build';
import {
  M3_CROSSING,
  M3_SERPENTINE,
  M3_TWO_MAZES,
  M3_UNDEFENDED,
  M3_WEST_ONLY,
} from './reference-builds';
import {
  drawnCapacity,
  firstWaveCovering,
  placeCapacityDrawing,
  scheduleIncome,
} from './balance-capacity';
import { balanceReport, checkDrawsStrongest } from './balance-report';

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

  it('names a creep on the board before the last tower stood — not a wave 1 launched on that tick', () => {
    // West only's 19 towers go in on ticks 0–18. A wave 1 launched on tick 18 spawns after
    // that tick's input phase has placed the last of them; launched on tick 17, its first
    // creep is on the board when the 19th goes in.
    const launchingAt = (countdownTicks: number) => {
      const board = bundle.boards[0]!;
      const waves = board.waves.map((w, k) => (k === 0 ? { ...w, countdownTicks } : w));
      return compileRuleset(
        { ...bundle, boards: [{ ...board, waves }, ...bundle.boards.slice(1)] },
        M3_CROSSING.boardId,
      );
    };
    const onTheTick = placeCapacityDrawing('probe', M3_WEST_ONLY, launchingAt(18), seed);
    expect(onTheTick.state.waveLaunchTick[0]).toBe(18);
    expect(onTheTick.failures).toEqual([]);
    expect(placeCapacityDrawing('probe', M3_WEST_ONLY, launchingAt(17), seed).failures).toEqual([
      'probe: creeps were on the board before its last tower stood',
    ]);
    // Launched on tick 10, its first creep is on the board before four of the placements
    // (until the towers kill it): said once.
    expect(placeCapacityDrawing('probe', M3_WEST_ONLY, launchingAt(10), seed).failures).toEqual([
      'probe: creeps were on the board before its last tower stood',
    ]);
  });
});

describe('a capacity drawing of the strongest build', () => {
  /** A reference build drawing the towers `order` places. */
  const drawing = (id: string, order: string): ReferenceBuild => {
    const anchors = new Map<string, readonly [number, number, string]>();
    for (const token of order.split(' ')) {
      const m = /^(-?)([a-z])(\d+),(\d+)/.exec(token)!;
      if (m[1] === '') anchors.set(`${m[3]},${m[4]}`, [Number(m[3]), Number(m[4]), m[2]!]);
    }
    return { id, summary: id, grid: drawGrid(ruleset, [...anchors.values()]), order };
  };
  const check = (built: string, drawn: string) =>
    checkDrawsStrongest(
      'probe',
      drawing('full', drawn),
      { build: drawing('best', built) },
      ruleset,
    );
  const BUILT = 'b2,10 v4,10 b6,10';
  const FAILED = [
    "probe: the capacity drawing does not draw the strongest build, best — its towers do not begin with that build's",
  ];

  it('passes the build itself, and a drawing that goes on past it', () => {
    expect(check(BUILT, BUILT)).toEqual([]);
    expect(check(BUILT, 'b2,10 v4,10 b6,10 b8,10 v10,10')).toEqual([]);
  });

  it('reads the towers, not their timing or a juggle', () => {
    expect(check(BUILT, 'b2,10@600 v4,10 b6,10@900')).toEqual([]);
    expect(check('b2,10 v4,10 -v4,10@700 v4,10 b6,10', BUILT)).toEqual([]);
  });

  it('fails one that stops short of it, leaves it late, changes a tower or reorders it', () => {
    expect(check(BUILT, 'b2,10 v4,10')).toEqual(FAILED);
    expect(check(BUILT, 'b2,10 v4,10 b8,10 b6,10')).toEqual(FAILED);
    expect(check(BUILT, 'b2,10 b4,10 b6,10')).toEqual(FAILED);
    expect(check(BUILT, 'v4,10 b2,10 b6,10')).toEqual(FAILED);
  });

  it('has nothing to check when no build is strongest', () => {
    expect(checkDrawsStrongest('probe', M3_SERPENTINE, null, ruleset)).toEqual([]);
  });
});

describe('a schedule’s income', () => {
  it('adds each wave’s kill bounty and clear bonus to the starting bounty, and the early calls beside it', () => {
    // Waves 1–3: 10 normals, 16 swarm, 10 normals (1 bounty each), 2 a clear.
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
    // One past what the whole schedule earns, with or without the calls: no wave covers it.
    const last = income[income.length - 1]!;
    expect(firstWaveCovering(income, last.earned, false)).toBe(last.wave);
    expect(firstWaveCovering(income, last.earned + 1, false)).toBeNull();
    expect(firstWaveCovering(income, last.earnedWithCalls, true)).toBe(last.wave);
    expect(firstWaveCovering(income, last.earnedWithCalls + 1, true)).toBeNull();
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

  it('say how far short the schedule’s income falls of a drawing it cannot pay for', () => {
    // The serpentine's 613 against block 1 alone: ten waves earn 315, 361 with every call.
    const board = bundle.boards[0]!;
    const blockOne = { ...bundle, boards: [{ ...board, waves: board.waves.slice(0, 10) }] };
    const set: ReferenceSet = {
      ...M3_CROSSING,
      id: 'probe',
      builds: [M3_UNDEFENDED],
      fullBoard: M3_SERPENTINE,
    };
    const { text, failures } = balanceReport([set], () => blockOne);
    expect(failures).toEqual([]);
    expect(text).toContain(
      'income (every kill and clear bonus) reaches 315 by the end of wave 10, short of it',
    );
    expect(text).toContain(
      'income with every early call at its maximum reaches 361 by the end of wave 10, short of it',
    );
  });

  it(
    'fail the report for a drawing that does not draw the strongest build',
    { timeout: 120_000 },
    () => {
      // Two mazes is the set's only winner, so its strongest; the serpentine's towers do not
      // begin with its towers, so the serpentine priced is no drawing of it.
      const set: ReferenceSet = {
        ...M3_CROSSING,
        id: 'probe',
        builds: [M3_TWO_MAZES],
        fullBoard: M3_SERPENTINE,
      };
      expect(balanceReport([set], loadRulesetOrM2Fixture).failures).toEqual([
        "probe/m3-serpentine: the capacity drawing does not draw the strongest build, m3-two-mazes — its towers do not begin with that build's",
      ]);
    },
  );

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
