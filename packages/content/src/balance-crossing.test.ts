// balance-crossing.test.ts — M3 story 5: the first M3 reference builds, block 1 on the
// shipped crossing board (m3.md, "What tuned means"), and the board's capacity in bounty.
//
// Section A as far as block 1 reaches it, each outcome pinned by what the checker measures
// and every loss LOCATED BY CREEP ID (M2's de-indexing):
//   - two winners — the serpentine, which merges both routes into one maze, and two mazes,
//     which defends them separately, each by story 1's classifier — win on all 20 lives,
//     never selling, every creep killed;
//   - undefended loses by wave 3, to the swarm;
//   - west only (every tower in columns 1–8) loses to the north route's armored creeps,
//     within two waves of that route opening, and clears the plausibility floors.
// Then the capacity drawing: the serpentine drawn to the whole board, a legal maze the sim
// accepts, priced against block 1's income.
//
// Block-1 runs are short (under 6,000 ticks, a fraction of a second each outside coverage),
// so they live in the default suite, as M2's calibration does.

import { describe, it, expect } from 'vitest';
import { compileRuleset, createInitialState, deriveStars, step, type SimState } from '@wynding/sim';
import { loadRulesetOrM2Fixture } from './m2-fixture';
import { compileReferenceBuild, type ReferenceBuild } from './reference-build';
import {
  M2_SHOWCASE,
  M3_CROSSING,
  M3_SERPENTINE,
  M3_SERPENTINE_FULL,
  M3_TWO_MAZES,
  M3_UNDEFENDED,
  M3_WEST_ONLY,
  REFERENCE_SETS,
} from './reference-builds';
import { runReferenceBuild, type BuildRun } from './balance-run';
import {
  checkAllStepsRan,
  checkLossWindow,
  checkNoSellWithLiveCreep,
  checkPlausibility,
  classifyPathSharing,
  locateLoss,
  totalScheduledSpawns,
} from './balance-checks';
import { drawnCapacity, firstWaveCovering, scheduleIncome } from './balance-capacity';
import { balanceReport } from './balance-report';
import { currentPath } from './paths';
import { waveIndexForCreep } from './wave-lookup';

const ruleset = compileRuleset(loadRulesetOrM2Fixture(M3_CROSSING.rulesetId), M3_CROSSING.boardId);
const SEED = M3_CROSSING.seed;
const WEST = 0; // entrance indices, in board order
const NORTH = 1;

/** M3's section-A budget on creeps alive at once. */
const PEAK_ALIVE_BUDGET = 200;

/** The first wave that spawns from the north entrance — the route's opening, located by
 *  content rather than typed. */
const NORTH_OPENS = ruleset.waves.findIndex((w) => w.spawns.some((s) => s.entrance === NORTH));

// Lazy memo (the calibration file's pattern): each run happens inside the first test that
// needs it, under that test's own timeout, never at collection time.
const memo = new Map<string, BuildRun>();
function measured(build: ReferenceBuild): BuildRun {
  let run = memo.get(build.id);
  if (run === undefined) {
    run = runReferenceBuild(ruleset, SEED, compileReferenceBuild(build, ruleset));
    memo.set(build.id, run);
  }
  return run;
}

/** Both routes' ground paths on `state`'s maze, and how they share it. */
function routes(state: { readonly towers: SimState['towers'] }) {
  const west = currentPath(ruleset, state, WEST)!;
  const north = currentPath(ruleset, state, NORTH)!;
  return {
    west: west.length - 1,
    north: north.length - 1,
    sharing: classifyPathSharing(west, north),
  };
}

describe('M3 story 5 — the first reference builds, block 1 on the crossing board', () => {
  it('registers M3’s set on the shipped crossing board, beside M2’s on its fixture', () => {
    expect(REFERENCE_SETS).toEqual([M2_SHOWCASE, M3_CROSSING]);
    expect(M3_CROSSING).toMatchObject({
      rulesetId: 'wynding-core',
      boardId: 'crossing-medium',
      seed: 0x5eed,
      builds: [M3_SERPENTINE, M3_TWO_MAZES, M3_UNDEFENDED, M3_WEST_ONLY],
      fullBoard: M3_SERPENTINE_FULL,
    });
    expect(ruleset.waves).toHaveLength(10);
    expect(NORTH_OPENS).toBe(2); // wave 3
  });

  it.each([
    { build: M3_SERPENTINE, tick: 5990, steps: 45, spend: 297 },
    { build: M3_TWO_MAZES, tick: 5958, steps: 43, spend: 289 },
  ])(
    '$build.id wins block 1 on all 20 lives, 3★, every creep killed, every step run, never selling',
    { timeout: 120_000 },
    ({ build, tick, steps, spend }) => {
      const run = measured(build);
      expect(run.state.phase).toBe('won');
      expect(run.state.tick).toBe(tick);
      expect(run.state.lives).toBe(20);
      expect(deriveStars(run.state, ruleset)).toBe(3);
      expect(run.leaks).toEqual([]);
      expect(run.kills).toBe(totalScheduledSpawns(ruleset));
      expect(run.kills).toBe(129);
      expect([run.stepsDone, run.spend]).toEqual([steps, spend]);
      expect(checkAllStepsRan(build.id, run)).toEqual([]);
      expect(run.sells).toEqual([]);
      expect(checkNoSellWithLiveCreep(build.id, run)).toEqual([]);
      expect(run.peakAlive).toBeLessThanOrEqual(PEAK_ALIVE_BUDGET);
    },
  );

  it(
    'the serpentine merges the two routes into one maze; two mazes defends them separately',
    { timeout: 120_000 },
    () => {
      // Story 1's classifier on each build's final maze. The serpentine sends both routes
      // through the same corridors (west 88 tiles, north 49, against 27 and 23 empty); two
      // mazes winds each its own way and they cross once (west 54, north 42).
      expect(routes(measured(M3_SERPENTINE).state)).toEqual({
        west: 88,
        north: 49,
        sharing: 'merged',
      });
      expect(routes(measured(M3_TWO_MAZES).state)).toEqual({
        west: 54,
        north: 42,
        sharing: 'separate',
      });
    },
  );

  it('undefended loses by wave 3 — to the swarm, located by creep id', { timeout: 120_000 }, () => {
    const run = measured(M3_UNDEFENDED);
    expect(run.state.phase).toBe('lost');
    expect(run.spend).toBe(0);
    const swarm = waveIndexForCreep(ruleset, 'swarm');
    expect(swarm).toBeLessThanOrEqual(NORTH_OPENS); // "by wave 3", the north route's opening
    expect(checkLossWindow(M3_UNDEFENDED.id, run, ruleset, { toWaveOf: 'swarm' })).toEqual([]);
    expect(locateLoss(run)).toEqual({
      tick: run.state.tick - 1,
      reachedWave: swarm,
      fatalLeaks: [{ creepId: 'swarm', wave: swarm }],
    });
  });

  it(
    'west only keeps every tower in columns 1–8 and loses within two waves of the north route opening, to its armored creeps',
    { timeout: 120_000 },
    () => {
      // Columns 1–8: a tower's 2 × 2 footprint ends a column right of its anchor.
      for (const s of compileReferenceBuild(M3_WEST_ONLY, ruleset)) {
        expect(s.col + 1, `(${s.col},${s.row})`).toBeLessThanOrEqual(8);
      }
      const run = measured(M3_WEST_ONLY);
      expect(run.state.phase).toBe('lost');
      expect(checkAllStepsRan(M3_WEST_ONLY.id, run)).toEqual([]);
      const armored = waveIndexForCreep(ruleset, 'armored');
      expect(armored - NORTH_OPENS).toBeLessThanOrEqual(2);
      expect(
        checkLossWindow(M3_WEST_ONLY.id, run, ruleset, {
          fromWaveOf: 'armored',
          toWaveOf: 'armored',
        }),
      ).toEqual([]);
      expect(locateLoss(run)!.fatalLeaks).toEqual([{ creepId: 'armored', wave: armored }]);
      // That wave's armored creeps all walk the north route, which the build never reaches —
      // and every life it lost went down that route, from the opening on.
      const armoredSpawns = ruleset.waves[armored]!.spawns.filter((s) => s.creepId === 'armored');
      expect(new Set(armoredSpawns.map((s) => s.entrance))).toEqual(new Set([NORTH]));
      expect(run.leaks.every((l) => l.wave >= NORTH_OPENS)).toBe(true);
    },
  );

  it(
    'west only clears the plausibility floors: it spends its income and engages the arc',
    { timeout: 120_000 },
    () => {
      // Floors chosen for this story (the spec leaves them open): most of every bounty it
      // received spent, three tower kinds or more, and every west creep it met killed —
      // 42 across waves 1, 2, 4 and 5 — and the armored creeps' wave reached.
      const run = measured(M3_WEST_ONLY);
      expect(
        checkPlausibility(M3_WEST_ONLY.id, run, ruleset, {
          minSpend: 100,
          minSpentShare: 0.85,
          minTowerKinds: 3,
          minKills: 40,
          reachesWaveOf: 'armored',
        }),
      ).toEqual([]);
      expect([run.spend, run.state.bounty, run.kills]).toEqual([123, 11, 42]);
      expect(Object.keys(run.spendById).sort()).toEqual(['antiair', 'basic', 'splash', 'venom']);
    },
  );

  it('keeps block 1 inside section A’s budgets', { timeout: 120_000 }, () => {
    expect(totalScheduledSpawns(ruleset)).toBeLessThanOrEqual(2000);
    for (const build of M3_CROSSING.builds) {
      expect(measured(build).peakAlive, build.id).toBeLessThanOrEqual(PEAK_ALIVE_BUDGET);
    }
  });
});

describe('M3 story 5 — the board’s capacity in bounty', () => {
  const full = compileReferenceBuild(M3_SERPENTINE_FULL, ruleset);

  it('draws the block-1 serpentine to the whole board: its plan first, tower for tower', () => {
    const block1 = compileReferenceBuild(M3_SERPENTINE, ruleset);
    expect(full.slice(0, block1.length)).toEqual(block1);
  });

  it('is a maze the sim accepts tower by tower, still one both routes walk, with no 2 × 2 left clear of their paths', () => {
    // Bounty enough for every tower before wave 1: one placement a tick, each accepted —
    // the maze invariant never refuses one.
    const rich = compileRuleset(
      {
        ...loadRulesetOrM2Fixture(M3_CROSSING.rulesetId),
        balance: { ...ruleset.balance, startingBounty: 10_000 },
      },
      M3_CROSSING.boardId,
    );
    let state = createInitialState(SEED, rich);
    for (const s of full) {
      if (s.kind === 'sell') throw new Error('the capacity drawing sells nothing');
      const before = state.towers.id.length;
      state = step(state, rich, [
        { kind: 'placeTower', anchor: { col: s.col, row: s.row }, towerId: s.towerId },
      ]);
      expect(state.towers.id.length, `${s.towerId} at (${s.col},${s.row})`).toBe(before + 1);
    }
    expect(state.waveLaunchTick[0]).toBeNull(); // all of it before wave 1
    expect(routes(state)).toEqual({ west: 167, north: 143, sharing: 'merged' });

    // "Every tower the maze holds": no open 2 × 2 is left off both routes' paths.
    const { grid } = ruleset.board;
    const onPath = new Set(
      [...currentPath(ruleset, state, WEST)!, ...currentPath(ruleset, state, NORTH)!].map(
        (c) => `${c.col},${c.row}`,
      ),
    );
    const covered = new Set<string>();
    for (let i = 0; i < state.towers.id.length; i++) {
      for (const [dc, dr] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        covered.add(`${state.towers.col[i]! + dc},${state.towers.row[i]! + dr}`);
      }
    }
    const free = (col: number, row: number) =>
      grid.classAt({ col, row }) === 'buildable-open' &&
      !covered.has(`${col},${row}`) &&
      !onPath.has(`${col},${row}`);
    const room: string[] = [];
    for (let row = 0; row < grid.height - 1; row++) {
      for (let col = 0; col < grid.width - 1; col++) {
        if (free(col, row) && free(col + 1, row) && free(col, row + 1) && free(col + 1, row + 1)) {
          room.push(`${col},${row}`);
        }
      }
    }
    expect(room).toEqual([]);
  });

  it('prices at 83 towers, 569 bounty, beyond what block 1 earns', () => {
    expect(drawnCapacity(M3_SERPENTINE_FULL, ruleset)).toEqual({
      towers: 83,
      bounty: 569,
      spendById: { basic: 225, splash: 96, venom: 162, antiair: 70, slow: 16 },
    });
    // Block 1 earns 315 by wave 10 (80 + 211 in kills + 24 in clear bonuses), 361 with every
    // early call at its maximum (+5 a call on a 500-tick countdown, +6 on wave 10's 600).
    const income = scheduleIncome(ruleset);
    expect(income[9]).toEqual({ wave: 9, earned: 315, earnedWithCalls: 361 });
    expect(firstWaveCovering(income, 569, false)).toBeNull();
    expect(firstWaveCovering(income, 569, true)).toBeNull();
  });

  it(
    'the balance report runs the M3 set, names the strongest build, and prices the board',
    { timeout: 120_000 },
    () => {
      const { text, failures } = balanceReport([M3_CROSSING], loadRulesetOrM2Fixture);
      expect(failures).toEqual([]);
      for (const build of M3_CROSSING.builds) {
        expect(text).toContain(`${build.id} — ${build.summary}`);
      }
      expect(text).toContain('won · tick 5990 · lives 20 · score 711 · 3★ · steps 45/45');
      expect(text).toContain('lost to 1 swarm from wave 2 while on wave 2');
      expect(text).toContain('lost to 1 armored from wave 5 while on wave 5');
      // The two winners tie on lives and score; the first registered is the strongest.
      expect(text).toContain(
        'board-full: the strongest build, m3-serpentine (won on 20 lives), placed its last tower in wave 10',
      );
      expect(text).toContain(
        'capacity: m3-serpentine-full draws 83 towers worth 569 bounty — basic 225, venom 162, splash 96, antiair 70, slow 16',
      );
      expect(text).toContain(
        'income (every kill and clear bonus) reaches 315 by the end of wave 10, short of it',
      );
    },
  );
});
