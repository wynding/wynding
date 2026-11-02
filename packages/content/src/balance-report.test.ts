// balance-report.test.ts — M3 story 1: the balance report's own lines on sets built to hit
// them — a set where nothing wins (a build that sells mid-wave, one that builds only before
// wave 1, one that builds nothing), and a set of winners where the first is a juggler and
// the next never finishes its plan. Then section B's lines (M3 story 8) on measured runs made
// up to hit them. The registered M2 set's report is `balance-calibration.test.ts`'s, and M3's
// is `balance-crossing.test.ts`'s.

import { describe, it, expect } from 'vitest';
import {
  compileRuleset,
  createInitialState,
  type CompiledRuleset,
  type SimState,
} from '@wynding/sim';
import { getM2Fixture, loadRulesetOrM2Fixture, M2_BOARD_ID } from './m2-fixture';
import { balanceReport, closestText, strongest } from './balance-report';
import type { BuildRun } from './balance-run';
import { drawGrid, type ReferenceBuild, type ReferenceSet } from './reference-build';
import { M2_PINNED_LOSER, M2_SHOWCASE, M2_WINNER_A, M2_WINNER_B } from './reference-builds';

const ruleset = compileRuleset(getM2Fixture(), M2_BOARD_ID); // M2's board, frozen in M3 story 4

/** `grid` (as authored) with one more tower drawn over it. */
function withTower(grid: string, col: number, row: number, letter: string): string {
  return grid
    .trim()
    .split(/\n\s*/)
    .map((line, r) =>
      r === row || r === row + 1
        ? `${line.slice(0, col)}${letter}${letter}${line.slice(col + 2)}`
        : line,
    )
    .join('\n');
}

const LOSING_SET: ReferenceSet = {
  ...M2_SHOWCASE,
  id: 'probe',
  builds: [
    { id: 'undefended', summary: 'nothing built', grid: drawGrid(ruleset), order: '' },
    {
      id: 'one-basic',
      summary: 'one basic, before wave 1',
      grid: drawGrid(ruleset, [[2, 10, 'b']]),
      order: 'b2,10',
    },
    {
      ...M2_PINNED_LOSER,
      id: 'seller',
      summary: 'the pinned loser, selling a basic while wave 1 is on the board',
      order: `${M2_PINNED_LOSER.order} -b2,10@650`,
    },
  ],
};

const WINNING_SET: ReferenceSet = {
  ...M2_SHOWCASE,
  id: 'probe-winners',
  builds: [
    {
      ...M2_WINNER_A,
      id: 'juggler',
      summary: 'Winner A, selling and re-placing a basic while wave 1 walks',
      order: M2_WINNER_A.order
        .trim()
        .split(/\s+/)
        .flatMap((step, i) => (i === 7 ? [step, '-b2,10@560', 'b2,10'] : [step]))
        .join(' '),
    },
    {
      ...M2_WINNER_A,
      id: 'incomplete',
      summary: 'Winner A, with a last basic the run ends before',
      grid: withTower(M2_WINNER_A.grid, 2, 2, 'b'),
      order: `${M2_WINNER_A.order} b2,2@40000`,
    },
    M2_WINNER_B,
  ],
};

describe('the balance report', () => {
  it(
    'reports sells, how many came with creeps alive, and that no build won',
    { timeout: 120_000 },
    () => {
      const { text, failures } = balanceReport([LOSING_SET], loadRulesetOrM2Fixture);
      expect(text).toContain('== probe: m2-fixture / field-01, seed 0x5eed ==');
      expect(text).toMatch(
        /undefended — nothing built\n {2}lost · .* · last tower never · lost to 1 normal from wave 1 while on wave 2\n/,
      );
      expect(text).toMatch(/one-basic — .*\n {2}lost · .* · last tower before wave 1 · lost to /);
      expect(text).toMatch(
        /seller — .*\n {2}lost · .* · sells 1 \(1 with creeps alive\) · lost to /,
      );
      expect(text).toContain('board-full: no build won without a live sell, so none is strongest');
      expect(failures).toEqual([]);
    },
  );

  it(
    'never names a juggler the strongest build, says when the strongest plan is incomplete, and fails on it',
    { timeout: 120_000 },
    () => {
      const { text, failures } = balanceReport([WINNING_SET], loadRulesetOrM2Fixture);
      // The juggler wins on 10 lives too, and is registered first: without the rule it
      // would be the strongest.
      expect(text).toMatch(
        /juggler — .*\n {2}won · .* · lives 10 · .* · sells 1 \(1 with creeps alive\)/,
      );
      expect(text).toContain(
        'board-full: the strongest build, incomplete (won on 10 lives), plan incomplete (40/41)',
      );
      expect(failures).toEqual(['probe-winners/incomplete: ran 40 of its 41 steps']);
    },
  );

  it('fails when no reference set is registered', () => {
    expect(balanceReport([], loadRulesetOrM2Fixture).failures).toEqual([
      'no reference sets are registered',
    ]);
  });
});

describe('the report’s small rules', () => {
  /** A finished run with only what `strongest` reads. */
  function entry(id: string, state: Partial<SimState>, sells: BuildRun['sells'] = []) {
    const run = {
      state: { ...createInitialState(0, ruleset), ...state },
      sells,
    } as unknown as BuildRun;
    return { build: { id } as ReferenceBuild, run };
  }

  it('names a later winner on more lives over the first, and skips a live-sell juggler', () => {
    const juggler = entry('juggler', { phase: 'won', lives: 10 }, [
      { tick: 900, col: 2, row: 2, towerId: 'basic', creepsAlive: 3 },
    ]);
    const first = entry('first', { phase: 'won', lives: 6 });
    const later = entry('later', { phase: 'won', lives: 8 });
    const loser = entry('loser', { phase: 'lost', lives: 0 });
    expect(strongest([juggler, first, later, loser], ruleset)?.build.id).toBe('later');
    expect(strongest([juggler, loser], ruleset)).toBeNull();
  });

  it('breaks a tie on lives by the higher score', () => {
    const lower = entry('lower', { phase: 'won', lives: 8, cumulativeKillBounty: 300 });
    const higher = entry('higher', { phase: 'won', lives: 8, cumulativeKillBounty: 340 });
    expect(strongest([lower, higher], ruleset)?.build.id).toBe('higher');
    expect(strongest([higher, lower], ruleset)?.build.id).toBe('higher');
  });

  it('prints a near miss as <0.01, never as the 0.00 the legend keeps for a leak', () => {
    expect([0, 0.004, 0.005, 0.5].map(closestText)).toEqual(['0.00', '<0.01', '0.01', '0.50']);
  });

  it('fails a registered set with no builds', () => {
    const empty: ReferenceSet = { ...M2_SHOWCASE, id: 'empty', builds: [] };
    expect(balanceReport([empty], loadRulesetOrM2Fixture).failures).toEqual([
      'empty: the set has no builds',
    ]);
  });
});

describe('the report’s section-B lines (M3 story 8)', () => {
  const crossing = compileRuleset(loadRulesetOrM2Fixture('wynding-core'), 'crossing-medium');

  /** A measured run with only what the report reads: `state` over a fresh one on `on`. */
  function fake(
    on: CompiledRuleset,
    state: Partial<SimState>,
    fields: Partial<Omit<BuildRun, 'state'>> = {},
  ): BuildRun {
    return {
      state: { ...createInitialState(0, on), ...state },
      stepsDone: 0,
      stepCount: 0,
      stalled: false,
      spendById: {},
      spend: 0,
      kills: 0,
      leaks: [],
      sells: [],
      commands: { place: 0, sell: 0 },
      peakAlive: 0,
      lastPlacementWave: null,
      waves: [],
      ...fields,
    };
  }

  /** A crossing-board set of `builds`, naming the section-B builds `named`. */
  function crossingSet(
    builds: readonly ReferenceBuild[],
    named: Partial<Pick<ReferenceSet, 'juggling' | 'centreAntiAir'>>,
  ): ReferenceSet {
    return {
      id: 'probe',
      rulesetId: 'wynding-core',
      boardId: 'crossing-medium',
      seed: 0x5eed,
      builds,
      ...named,
    };
  }
  const build = (id: string): ReferenceBuild => ({ id, summary: id, grid: '', order: '' });
  /** The report on `set`, each build measured by `runs` (by id) rather than run — and the
   *  centre-only build's run with lives to spare by `spare`. */
  const report = (
    set: ReferenceSet,
    runs: Readonly<Record<string, BuildRun>>,
    spare: Readonly<Record<string, BuildRun>> = {},
  ) =>
    balanceReport([set], loadRulesetOrM2Fixture, (b, on) =>
      on.balance.startingLives > crossing.balance.startingLives ? spare[b.id]! : runs[b.id]!,
    );
  const cost = (id: string) => crossing.towerById[id]!.cost;
  const pct = (part: number, whole: number) => `${Math.round((part * 100) / whole)}%`;

  /** `state` with `placed` standing, `[towerId, col, row]` each, at their catalog cost. */
  function standing(placed: readonly (readonly [string, number, number])[]): Partial<SimState> {
    const base = createInitialState(0, crossing).towers;
    return {
      towers: {
        ...base,
        id: placed.map((_, i) => i + 1),
        towerId: placed.map(([id]) => id),
        col: placed.map(([, col]) => col),
        row: placed.map(([, , row]) => row),
        spend: placed.map(([id]) => cost(id)),
      } as SimState['towers'],
    };
  }

  it('gives each honest winner’s anti-air share, with the beacons that lift only flyer-only towers, and none when nothing won honestly', () => {
    const winner = build('winner');
    const juggler = build('juggler');
    // The beacon at (10,4) lifts the two antiair sharing its edges; the one at (10,10) lifts
    // an antiair and a basic; the one at (20,4) lifts nothing (the antiair at (22,6) only
    // touches its corner). Only the first counts as anti-air spend.
    const towers: [string, number, number][] = [
      ['antiair', 8, 4],
      ['beacon', 10, 4],
      ['antiair', 12, 4],
      ['basic', 8, 10],
      ['beacon', 10, 10],
      ['antiair', 12, 10],
      ['beacon', 20, 4],
      ['antiair', 22, 6],
      ['slow', 16, 16],
    ];
    const spend = towers.reduce((n, [id]) => n + cost(id), 0);
    const aa = 4 * cost('antiair');
    const { text } = report(crossingSet([winner, juggler], {}), {
      winner: fake(
        crossing,
        { phase: 'won', lives: 20, ...standing(towers) },
        {
          spendById: {
            antiair: aa,
            beacon: 3 * cost('beacon'),
            basic: cost('basic'),
            slow: cost('slow'),
          },
          spend,
        },
      ),
      juggler: fake(
        crossing,
        { phase: 'won', lives: 20 },
        {
          spendById: { antiair: 50 },
          spend: 50,
          sells: [{ tick: 900, col: 2, row: 2, towerId: 'basic', creepsAlive: 1 }],
        },
      ),
    });
    // `antiair` hits only flyers; `slow` hits both; `basic` only the ground.
    const lifted = aa + cost('beacon');
    const any = aa + cost('slow');
    expect(text).toContain(
      `anti-air share of spend (towers that hit only flyers; with the beacons that lift nothing else; every tower that can hit a flyer):\n  winner: ${aa} of ${spend} (${pct(aa, spend)}); ${lifted} (${pct(lifted, spend)}); ${any} (${pct(any, spend)})\n`,
    );
    // The juggler, on a live sell, is no honest winner.
    expect(text).not.toContain('  juggler:');
    const losing = report(crossingSet([winner], {}), {
      winner: fake(crossing, { phase: 'lost', lives: 0 }),
    });
    expect(losing.text).not.toContain('anti-air share');
  });

  it('puts the juggling build beside the honest winners, its spend net of refunds and its commands', () => {
    const juggler = build('juggler');
    const honest = build('honest');
    const runs = {
      juggler: fake(
        crossing,
        { phase: 'won', lives: 9 },
        {
          spend: 60,
          sells: [
            { tick: 900, col: 2, row: 2, towerId: 'basic', creepsAlive: 3 },
            { tick: 950, col: 2, row: 2, towerId: 'basic', creepsAlive: 0 },
          ],
          commands: { place: 10, sell: 2 },
        },
      ),
      honest: fake(crossing, { phase: 'won', lives: 18 }, { spend: 90 }),
    };
    const { text, failures } = report(crossingSet([juggler, honest], { juggling: juggler }), runs);
    expect(failures).toEqual([]);
    // Each sell of a basic refunds ⌊¾ × its cost⌋.
    const refund = Math.floor((crossing.towerById.basic!.cost * 3) / 4);
    expect(text).toContain(
      `juggling: juggler won on 9 lives (1★) — 2 sells, 1 with creeps alive; spend 60, ${60 - 2 * refund} net of refunds; 12 tower commands, 10 of them placements\n  beside the honest winners: honest won on 18 lives (3★), spend 90\n`,
    );
    const alone = report(crossingSet([juggler], { juggling: juggler }), runs);
    expect(alone.text).toContain('  beside the honest winners: none\n');
  });

  it('fails a juggling build that never juggles or goes over the replay’s budgets, and a named build that is not one of the set’s', () => {
    const juggler = build('juggler');
    const honest = fake(crossing, { phase: 'won', lives: 18 });
    expect(
      report(crossingSet([juggler], { juggling: juggler }), { juggler: honest }).failures,
    ).toEqual(['probe/juggler: the juggling build never sold with a creep alive']);
    const flooded = fake(
      crossing,
      { phase: 'won', lives: 18 },
      {
        sells: [{ tick: 900, col: 2, row: 2, towerId: 'basic', creepsAlive: 3 }],
        commands: { place: 1_001, sell: 1 },
      },
    );
    expect(
      report(crossingSet([juggler], { juggling: juggler }), { juggler: flooded }).failures,
    ).toEqual(['probe/juggler: 1001 placements, over the replay budget of 1000']);
    const other = build('other');
    expect(
      report(crossingSet([other], { juggling: juggler, centreAntiAir: juggler }), {
        other: honest,
      }).failures,
    ).toEqual([
      'probe: its juggling build, juggler, is not one of its builds',
      'probe: its centre-only anti-air build, juggler, is not one of its builds',
    ]);
  });

  it('measures the two-lane air on the centre-only build’s run with lives to spare, beside the lives its own run met it on', () => {
    const centre = build('centre');
    const set = crossingSet([centre], { centreAntiAir: centre });
    const leak = (creepId: string, wave: number) => ({ tick: 15_000, creepId, wave });
    /** Profile rows whose `lives` is `held` through wave 25's window, `after` from there. */
    const rows = (held: number, after: number): BuildRun['waves'] =>
      Array.from({ length: 30 }, (_, wave) => ({
        wave,
        leaks: 0,
        livesLost: 0,
        closestApproach: null,
        lives: wave < 25 ? held : after,
        towers: 0,
        unspent: 0,
        placed: 0,
        peakAlive: 0,
      }));
    // Its own run met wave 26 on 18 lives; with lives to spare, that air takes 3. A flyer
    // before wave 26 and a ground creep after it are not counted.
    const survives = report(
      set,
      {
        centre: fake(
          crossing,
          { phase: 'won', lives: 14, waveCursor: 30 },
          { waves: rows(18, 14) },
        ),
      },
      {
        centre: fake(
          crossing,
          { phase: 'won', lives: 999_990, waveCursor: 30 },
          {
            leaks: [
              leak('armored-flyer', 8),
              leak('armored-flyer', 25),
              leak('normal', 26),
              leak('armored-flyer', 28),
              leak('armored-flyer', 28),
            ],
          },
        ),
      },
    );
    expect(survives.failures).toEqual([]);
    // A second run that never ended gives a take that means nothing, so the report fails.
    const unfinished = report(
      set,
      {
        centre: fake(
          crossing,
          { phase: 'won', lives: 14, waveCursor: 30 },
          { waves: rows(18, 14) },
        ),
      },
      { centre: fake(crossing, { phase: 'running', tick: 72_000, waveCursor: 30 }) },
    );
    expect(unfinished.failures).toEqual([
      'probe/centre (lives to spare): still running at tick 72000, the cap',
    ]);
    expect(survives.text).toContain(
      'centre-only anti-air: centre won on 14 lives; it met the air down two lanes at once, from wave 26, on 18 lives\n  with lives to spare, the flyers from wave 26 on take 3 (wave 26: 1, wave 29: 2) — fewer than it met that air on: it survives it\n',
    );
    // Lost before wave 26: its own run never met that air; the spare run says what it costs.
    const early = report(
      set,
      {
        centre: fake(
          crossing,
          { phase: 'lost', lives: 0, tick: 1376, waveCursor: 2 },
          { leaks: [{ tick: 1375, creepId: 'swarm', wave: 1 }] },
        ),
      },
      { centre: fake(crossing, { phase: 'won', lives: 999_999, waveCursor: 30 }) },
    );
    expect(early.text).toContain(
      'centre-only anti-air: centre lost to 1 swarm from wave 2 while on wave 2; it never met the air down two lanes at once, from wave 26\n  with lives to spare, the flyers from wave 26 on take 0 (none) — fewer than the 20 a run starts with: it survives that air if it meets it on more than 0\n',
    );
    // An air that takes a whole run's lives beats any build like it, however it meets it.
    const overwhelmed = report(
      set,
      {
        centre: fake(
          crossing,
          { phase: 'lost', lives: 0, tick: 16_000, waveCursor: 26 },
          { waves: rows(20, 0), leaks: [{ tick: 15_999, creepId: 'armored-flyer', wave: 25 }] },
        ),
      },
      {
        centre: fake(
          crossing,
          { phase: 'won', lives: 999_980, waveCursor: 30 },
          { leaks: Array.from({ length: 20 }, () => leak('flying', 25)) },
        ),
      },
    );
    expect(overwhelmed.text).toContain(
      'centre-only anti-air: centre lost to 1 armored-flyer from wave 26 while on wave 26; it met the air down two lanes at once, from wave 26, on 20 lives\n  with lives to spare, the flyers from wave 26 on take 20 (wave 26: 20) — at least the 20 a run starts with: no build like it survives that air\n',
    );
    // M2's board has one entrance, so no wave there flies two lanes.
    const m2: ReferenceSet = { ...M2_SHOWCASE, id: 'm2', builds: [centre], centreAntiAir: centre };
    expect(
      balanceReport([m2], loadRulesetOrM2Fixture, () => fake(ruleset, { phase: 'won', lives: 10 }))
        .text,
    ).toContain('centre-only anti-air: centre — no wave flies two lanes at once\n');
  });
});
