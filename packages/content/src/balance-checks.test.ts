// balance-checks.test.ts — M3 story 1: the section-A checks (`balance-checks.ts`) on
// synthetic runs and paths, so each verdict is pinned on both sides of its line without
// running the sim — plus one short grid build compiled, run and checked end to end.
// `balance-calibration.test.ts` runs them on M2's real builds.

import { describe, it, expect } from 'vitest';
import { compileRuleset, createInitialState, type SimState } from '@wynding/sim';
import type { Cell } from '@wynding/types';
import { getBundledRuleset } from './registry';
import { runReferenceBuild, type BuildRun } from './balance-run';
import { compileReferenceBuild, drawGrid, type ReferenceBuild } from './reference-build';
import {
  checkAllStepsRan,
  checkDistinctness,
  checkLossWindow,
  checkNoSellWithLiveCreep,
  checkPlausibility,
  classifyPathSharing,
  idsBySpend,
  locateLoss,
  totalScheduledSpawns,
} from './balance-checks';

const ruleset = compileRuleset(getBundledRuleset('wynding-core'), 'field-01');
const initial = createInitialState(0x5eed, ruleset);

/** A measured run with only the fields a check reads set. */
function fakeRun(
  fields: Partial<Omit<BuildRun, 'state'>>,
  state: Partial<SimState> = {},
): BuildRun {
  return {
    state: { ...initial, ...state },
    stepsDone: 0,
    stepCount: 0,
    stalled: false,
    spendById: {},
    spend: 0,
    kills: 0,
    leaks: [],
    sells: [],
    peakAlive: 0,
    lastPlacementWave: null,
    waves: [],
    ...fields,
  };
}

/** The arc's wave indices, located by creep id the same way the checks locate them. */
const FLYING = ruleset.waves.findIndex((w) => w.spawns.some((s) => s.creepId === 'flying'));
const ARMORED_FLYER = ruleset.waves.findIndex((w) =>
  w.spawns.some((s) => s.creepId === 'armored-flyer'),
);

describe('distinctness (M2’s rule)', () => {
  it('orders ids by spend, ties broken on the id', () => {
    expect(idsBySpend({ venom: 9, basic: 30, antiair: 30 })).toEqual(['antiair', 'basic', 'venom']);
    // By code unit, not the host locale: a locale-aware compare would put `a` first.
    expect(idsBySpend({ a: 1, B: 1 })).toEqual(['B', 'a']);
  });

  it('passes builds with disjoint top-two ids that each carry at least 25% of their own spend', () => {
    expect(
      checkDistinctness([
        { id: 'a', spendById: { venom: 198, antiair: 84, basic: 30 } },
        { id: 'b', spendById: { slow: 96, beacon: 90, basic: 70, antiair: 52 } },
      ]),
    ).toEqual([]);
  });

  it('names a shared top-two id', () => {
    expect(
      checkDistinctness([
        { id: 'a', spendById: { venom: 50, antiair: 50 } },
        { id: 'b', spendById: { slow: 50, antiair: 50 } },
        { id: 'c', spendById: { stun: 50, splash: 50 } },
      ]),
    ).toEqual(["a and b share top-two id 'antiair'"]);
  });

  it('names a top-two id under 25% of its build’s spend, and passes one exactly at it', () => {
    expect(
      checkDistinctness([{ id: 'a', spendById: { venom: 60, antiair: 24, basic: 16 } }]),
    ).toEqual(["a: top-two id 'antiair' is 24.0% of its spend, under 25%"]);
    expect(
      checkDistinctness([{ id: 'a', spendById: { venom: 60, antiair: 25, basic: 15 } }]),
    ).toEqual([]);
  });

  it('fails what has no top two to judge: no builds, a build that spent nothing, a one-id build', () => {
    expect(checkDistinctness([])).toEqual(['distinctness: no builds to compare']);
    expect(
      checkDistinctness([
        { id: 'idle', spendById: {} },
        { id: 'mono', spendById: { venom: 90 } },
      ]),
    ).toEqual([
      'idle: spent nothing, so it has no top two',
      'mono: spent on 1 tower id, not a top two',
    ]);
  });
});

describe('every step ran', { timeout: 120_000 }, () => {
  it('passes a finished plan whose run ended, and names a short plan and a run cut off at the cap', () => {
    expect(
      checkAllStepsRan('done', fakeRun({ stepsDone: 3, stepCount: 3 }, { phase: 'won' })),
    ).toEqual([]);
    expect(
      checkAllStepsRan(
        'stuck',
        fakeRun({ stepsDone: 2, stepCount: 3 }, { phase: 'running', tick: 36000 }),
      ),
    ).toEqual(['stuck: ran 2 of its 3 steps', 'stuck: still running at tick 36000, the cap']);
  });

  it('a lost run may leave steps queued, but not a step the sim rejected', () => {
    const queued = fakeRun({ stepsDone: 2, stepCount: 3, stalled: false }, { phase: 'lost' });
    expect(checkAllStepsRan('loser', queued)).toEqual([]);
    const blocked = fakeRun({ stepsDone: 2, stepCount: 3, stalled: true }, { phase: 'lost' });
    expect(checkAllStepsRan('loser', blocked)).toEqual([
      'loser: step 3 was rejected by the sim and never ran',
    ]);
  });

  it('end to end — a loser dying with steps queued passes; one dying behind a rejected step fails', () => {
    const run = (order: string, towers: readonly (readonly [number, number, string])[]) =>
      runReferenceBuild(
        ruleset,
        0x5eed,
        compileReferenceBuild(
          { id: 'loser', summary: 'a loser', grid: drawGrid(ruleset, towers), order },
          ruleset,
        ),
      );
    // The basic waits for tick 40,000; wave 1 ends the run long before.
    const queued = run('b2,2@40000', [[2, 2, 'b']]);
    expect([queued.state.phase, queued.stepsDone, queued.stalled]).toEqual(['lost', 0, false]);
    expect(checkAllStepsRan('queued', queued)).toEqual([]);
    // A mine far off the path never fires, so its re-arm waits for the anchor to clear —
    // queued, sending nothing, not a stall.
    const rearm = run('m2,2 m2,2', [[2, 2, 'm']]);
    expect([rearm.state.phase, rearm.stepsDone, rearm.stalled]).toEqual(['lost', 1, false]);
    expect(checkAllStepsRan('rearm', rearm)).toEqual([]);
    // A wall of basics down columns 12–13: the eleventh would close the last gap and seal
    // the path, so the sim rejects it every tick until the run is lost.
    const wall = Array.from({ length: 11 }, (_, i) => [12, 1 + 2 * i, 'b'] as const);
    const blocked = run(wall.map(([col, row]) => `b${col},${row}`).join(' '), wall);
    expect([blocked.state.phase, blocked.stepsDone, blocked.stalled]).toEqual(['lost', 10, true]);
    expect(checkAllStepsRan('blocked', blocked)).toEqual([
      'blocked: step 11 was rejected by the sim and never ran',
    ]);
  });
});

describe('no sell while any creep is alive', { timeout: 120_000 }, () => {
  it('flags only the sells applied with a creep on the board', () => {
    const run = fakeRun({
      sells: [
        { tick: 400, col: 2, row: 10, towerId: 'basic', creepsAlive: 0 },
        { tick: 812, col: 6, row: 10, towerId: 'basic', creepsAlive: 3 },
      ],
    });
    expect(checkNoSellWithLiveCreep('juggler', run)).toEqual([
      'juggler: sold the basic at (6,10) on tick 812 with 3 creep(s) alive',
    ]);
    expect(checkNoSellWithLiveCreep('honest', fakeRun({}))).toEqual([]);
  });

  it('end to end — a grid build compiled, run and checked: a sell before wave 1 passes, one mid-wave is named', () => {
    const build: ReferenceBuild = {
      id: 'seller',
      summary: 'two basics off the path, sold before and during wave 1',
      grid: drawGrid(ruleset, [
        [2, 2, 'b'],
        [6, 2, 'b'],
      ]),
      order: 'b2,2 b6,2 -b2,2@100 -b6,2@560',
    };
    const run = runReferenceBuild(ruleset, 0x5eed, compileReferenceBuild(build, ruleset));
    // Wave 1 launches on tick 500 and spawns a creep every 20 ticks; out of every tower's
    // range, the three spawned before tick 560 are all still walking when it sells.
    expect(run.sells).toEqual([
      { tick: 100, col: 2, row: 2, towerId: 'basic', creepsAlive: 0 },
      { tick: 560, col: 6, row: 2, towerId: 'basic', creepsAlive: 3 },
    ]);
    expect(checkNoSellWithLiveCreep(build.id, run)).toEqual([
      'seller: sold the basic at (6,2) on tick 560 with 3 creep(s) alive',
    ]);
  });
});

describe('plausibility floors for a loser', () => {
  const played = fakeRun(
    { spend: 82, spendById: { basic: 30, venom: 36, slow: 16 }, kills: 72 },
    { bounty: 18, waveLaunchTick: ruleset.waves.map((_, k) => (k <= FLYING ? 100 * k : null)) },
  );

  it('passes a run above every floor it is given', () => {
    expect(
      checkPlausibility('loser', played, ruleset, {
        minSpend: 60,
        minSpentShare: 0.8,
        minTowerKinds: 3,
        minKills: 40,
        reachesWaveOf: 'flying',
      }),
    ).toEqual([]);
    expect(checkPlausibility('loser', played, ruleset, {})).toEqual([]);
  });

  it('names every floor a run falls under', () => {
    expect(
      checkPlausibility('loser', played, ruleset, {
        minSpend: 83,
        minSpentShare: 0.9,
        minTowerKinds: 4,
        minKills: 73,
        reachesWaveOf: 'armored-flyer',
      }),
    ).toEqual([
      'loser: spend 82, under 83',
      'loser: spent share 0.820, under 0.9',
      'loser: tower kinds 3, under 4',
      'loser: kills 72, under 73',
      `loser: never launched wave ${ARMORED_FLYER + 1}, the first with 'armored-flyer'`,
    ]);
  });

  it('a run that received no bounty at all spent none of it', () => {
    const broke = fakeRun({ spend: 0 }, { bounty: 0 });
    expect(checkPlausibility('broke', broke, ruleset, { minSpentShare: 0.5 })).toEqual([
      'broke: spent share 0.000, under 0.5',
    ]);
  });
});

describe('loss location, by creep id', () => {
  const lost = fakeRun(
    {
      leaks: [
        { tick: 1800, creepId: 'flying', wave: FLYING },
        { tick: 2925, creepId: 'armored-flyer', wave: ARMORED_FLYER },
      ],
    },
    { phase: 'lost', tick: 2926, waveCursor: ARMORED_FLYER + 2 },
  );

  it('locates a loss by the creeps that took the last lives, beside the wave the player was on', () => {
    expect(locateLoss(lost)).toEqual({
      tick: 2925,
      reachedWave: ARMORED_FLYER + 1,
      fatalLeaks: [{ creepId: 'armored-flyer', wave: ARMORED_FLYER }],
    });
    expect(locateLoss(fakeRun({}, { phase: 'won' }))).toBeNull();
  });

  it('passes a loss inside the window and names one outside it, either end open', () => {
    const at = { fromWaveOf: 'armored-flyer', toWaveOf: 'armored-flyer' };
    expect(checkLossWindow('loser', lost, ruleset, at)).toEqual([]);
    expect(checkLossWindow('loser', lost, ruleset, {})).toEqual([]);
    expect(checkLossWindow('loser', lost, ruleset, { toWaveOf: 'flying' })).toEqual([
      `loser: lost to armored-flyer from wave ${ARMORED_FLYER + 1}, outside waves 1–${FLYING + 1}`,
    ]);
    expect(checkLossWindow('loser', lost, ruleset, { fromWaveOf: 'boss' })).toHaveLength(1);
  });

  it('judges every fatal leak when the last lives went to creeps of more than one wave', () => {
    const split = fakeRun(
      {
        leaks: [
          { tick: 2925, creepId: 'flying', wave: FLYING },
          { tick: 2925, creepId: 'armored-flyer', wave: ARMORED_FLYER },
        ],
      },
      { phase: 'lost', tick: 2926, waveCursor: ARMORED_FLYER + 1 },
    );
    expect(checkLossWindow('loser', split, ruleset, { fromWaveOf: 'flying' })).toEqual([]);
    expect(checkLossWindow('loser', split, ruleset, { fromWaveOf: 'armored-flyer' })).toEqual([
      `loser: lost to flying from wave ${FLYING + 1}, outside waves ${ARMORED_FLYER + 1}–10`,
    ]);
  });

  it('fails a run that did not lose, and a loss with no leak to locate it by', () => {
    expect(checkLossWindow('winner', fakeRun({}, { phase: 'won' }), ruleset, {})).toEqual([
      'winner: did not lose (won)',
    ]);
    const unexplained = fakeRun({}, { phase: 'lost', tick: 900, waveCursor: 1 });
    expect(checkLossWindow('odd', unexplained, ruleset, {})).toEqual([
      'odd: lost with no leak on its final tick',
    ]);
  });
});

describe('budget readers', () => {
  it('counts every creep the schedule spawns', () => {
    // M2's arc: 10 + 16 + 8 + 6 + 18 + 8 + 12 + 6 + 24 + 9.
    expect(totalScheduledSpawns(ruleset)).toBe(117);
  });
});

describe('merged vs separate: how a two-path build’s mazes relate', () => {
  const row = (r: number, from: number, to: number): Cell[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ col: from + i, row: r }));
  const col = (c: number, from: number, to: number): Cell[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ col: c, row: from + i }));

  it('two straight paths that only cross are separate', () => {
    expect(classifyPathSharing(row(11, 0, 27), col(13, 0, 23))).toBe('separate');
  });

  it('two paths that run through one shared corridor are merged', () => {
    // Both streams join row 11 and walk 20 cells of it together.
    const west = row(11, 0, 27);
    const north = [...col(4, 0, 10), ...row(11, 4, 23), ...col(23, 12, 23)];
    expect(classifyPathSharing(west, north)).toBe('merged');
  });

  it('draws its lines at a half and a tenth of the shorter path, with a gap between', () => {
    const a = row(5, 0, 19); // 20 cells
    const sharing = (n: number): Cell[] => [
      ...row(5, 0, n - 1),
      ...row(9, 0, 19 - n), // the rest of a 20-cell path, off `a`
    ];
    expect(classifyPathSharing(a, sharing(10))).toBe('merged');
    expect(classifyPathSharing(a, sharing(9))).toBe('neither');
    expect(classifyPathSharing(a, sharing(3))).toBe('neither');
    expect(classifyPathSharing(a, sharing(2))).toBe('separate');
  });

  it('rejects an empty path', () => {
    expect(() => classifyPathSharing([], row(1, 0, 3))).toThrow(/an empty path/);
    expect(() => classifyPathSharing(row(1, 0, 3), [])).toThrow(/an empty path/);
  });
});
