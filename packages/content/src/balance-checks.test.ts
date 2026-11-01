// balance-checks.test.ts — M3 story 1: the section-A checks (`balance-checks.ts`) on
// synthetic runs and paths, so each verdict is pinned on both sides of its line without
// running the sim. `balance-calibration.test.ts` runs them on M2's real builds.

import { describe, it, expect } from 'vitest';
import { compileRuleset, createInitialState, type SimState } from '@wynding/sim';
import type { Cell } from '@wynding/types';
import { getBundledRuleset } from './registry';
import type { BuildRun } from './balance-run';
import {
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
});

describe('no sell while any creep is alive', () => {
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

  it('fails a run that did not lose', () => {
    expect(checkLossWindow('winner', fakeRun({}, { phase: 'won' }), ruleset, {})).toEqual([
      'winner: did not lose (won)',
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
