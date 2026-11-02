// balance-crossing.test.ts — M3 stories 5–6: the M3 reference builds, blocks 1–2 on the
// shipped crossing board (m3.md, "What tuned means"), and the board's capacity in bounty.
//
// Section A as far as block 2 reaches it, each outcome pinned by what the checker measures
// and every loss LOCATED BY CREEP ID (M2's de-indexing):
//   - two winners — the serpentine, which merges both routes into one maze, and two mazes,
//     which defends them separately, each by story 1's classifier — win on all 20 lives,
//     never selling, every creep killed, and share neither of their top two tower ids by
//     spend (A1's distinctness);
//   - undefended loses by wave 3, to the swarm;
//   - west only (every tower in columns 1–8) loses to the north route's armored creeps,
//     within two waves of that route opening, and clears the plausibility floors;
//   - no anti-air (no tower that can hit a flyer) loses to the north lane's flyers, the first
//     air down that lane, by the end of block 2, and clears the plausibility floors.
// Then the capacity: the serpentine fills the board, a legal maze the sim accepts, priced
// against the schedule's income.
//
// Runs to wave 20 are about 12,000 ticks, a fraction of a second each outside coverage, so
// they live in the default suite, as M2's calibration does.

import { describe, it, expect } from 'vitest';
import { compileRuleset, deriveStars, type SimState } from '@wynding/sim';
import { loadRulesetOrM2Fixture } from './m2-fixture';
import { compileReferenceBuild, type ReferenceBuild } from './reference-build';
import {
  M2_SHOWCASE,
  M3_CROSSING,
  M3_NO_ANTI_AIR,
  M3_SERPENTINE,
  M3_TWO_MAZES,
  M3_UNDEFENDED,
  M3_WEST_ONLY,
  REFERENCE_SETS,
} from './reference-builds';
import { runReferenceBuild, type BuildRun } from './balance-run';
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
import {
  drawnCapacity,
  firstWaveCovering,
  placeCapacityDrawing,
  scheduleIncome,
} from './balance-capacity';
import { balanceReport } from './balance-report';
import { currentPath } from './paths';
import { runBuildScript } from './script-runner';
import { waveIndexForCreep } from './wave-lookup';

const ruleset = compileRuleset(loadRulesetOrM2Fixture(M3_CROSSING.rulesetId), M3_CROSSING.boardId);
const SEED = M3_CROSSING.seed;
const WEST = 0; // entrance indices, in board order
const NORTH = 1;

/** M3's section-A budget on creeps alive at once. */
const PEAK_ALIVE_BUDGET = 200;

const isAir = (creepId: string): boolean => ruleset.creepById[creepId]!.domain === 'air';

/** The first wave that spawns from the north entrance — the route's opening, located by
 *  content rather than typed. */
const NORTH_OPENS = ruleset.waves.findIndex((w) => w.spawns.some((s) => s.entrance === NORTH));

/** Block 2's last wave, wave 20, as the arc numbers blocks (m3.md, "Waves & timing"). */
const BLOCK_2_LAST = 19;

/** The first wave that flies the north lane — where it joins, located the same way. */
const NORTH_AIR = ruleset.waves.findIndex((w) =>
  w.spawns.some((s) => s.entrance === NORTH && isAir(s.creepId)),
);

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

/** Where `build`'s leaked creeps were bound, and where each wave's creeps were: the sim's
 *  own `destination` column, fixed at spawn — the runner's leak records carry no route. A
 *  creep leaks in the movement phase, so an earlier tick has already recorded it. */
function leakDestinations(build: ReferenceBuild) {
  const seen = new Map<number, number>();
  const leaked: (number | undefined)[] = [];
  const byWave = new Map<number, Set<number>>();
  runBuildScript(ruleset, SEED, compileReferenceBuild(build, ruleset), {
    collectEvents: true,
    afterStep: (state, _ruleset, _inputs, _placed, { events }) => {
      const c = state.creeps;
      for (let i = 0; i < c.id.length; i++) {
        seen.set(c.id[i]!, c.destination[i]!);
        let wave = byWave.get(c.wave[i]!);
        if (wave === undefined) byWave.set(c.wave[i]!, (wave = new Set()));
        wave.add(c.destination[i]!);
      }
      for (const id of events!.leaked!) leaked.push(seen.get(id));
    },
  });
  return { leaked, byWave };
}

/** Every open 2 × 2 on `state`'s board left clear of both routes' paths — room for one more
 *  tower that blocks neither route. */
function openRoom(state: SimState): string[] {
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
  return room;
}

describe('M3 stories 5–6 — the reference builds, blocks 1–2 on the crossing board', () => {
  it('registers M3’s set on the shipped crossing board, beside M2’s on its fixture', () => {
    expect(REFERENCE_SETS).toEqual([M2_SHOWCASE, M3_CROSSING]);
    expect(M3_CROSSING).toMatchObject({
      rulesetId: 'wynding-core',
      boardId: 'crossing-medium',
      seed: 0x5eed,
      builds: [M3_SERPENTINE, M3_TWO_MAZES, M3_UNDEFENDED, M3_WEST_ONLY, M3_NO_ANTI_AIR],
      fullBoard: M3_SERPENTINE,
    });
    expect(ruleset.waves).toHaveLength(20);
    expect(NORTH_OPENS).toBe(2); // wave 3
    expect(NORTH_AIR).toBe(15); // wave 16
  });

  it.each([
    { build: M3_SERPENTINE, tick: 11710, steps: 83, spend: 613 },
    { build: M3_TWO_MAZES, tick: 11717, steps: 69, spend: 505 },
  ])(
    '$build.id wins blocks 1–2 on all 20 lives, 3★, every creep killed, every step run, never selling',
    { timeout: 120_000 },
    ({ build, tick, steps, spend }) => {
      const run = measured(build);
      expect(run.state.phase).toBe('won');
      expect(run.state.tick).toBe(tick);
      expect(run.state.lives).toBe(20);
      expect(deriveStars(run.state, ruleset)).toBe(3);
      expect(run.leaks).toEqual([]);
      expect(run.kills).toBe(totalScheduledSpawns(ruleset));
      expect(run.kills).toBe(323);
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
      // through the same corridors (west 167 tiles, north 143, against 27 and 23 empty); two
      // mazes winds each its own way and they cross once (west 54, north 42).
      expect(routes(measured(M3_SERPENTINE).state)).toEqual({
        west: 167,
        north: 143,
        sharing: 'merged',
      });
      expect(routes(measured(M3_TWO_MAZES).state)).toEqual({
        west: 54,
        north: 42,
        sharing: 'separate',
      });
    },
  );

  it(
    'the two winners share neither of their top two tower ids by spend, each at least 25% of its build’s spend',
    { timeout: 120_000 },
    () => {
      // A1's distinctness, M2's rule. The serpentine is walled in basic and fights the
      // shared corridors with splash; two mazes adds no basic past block 1, and venom and
      // antiair overtake it.
      const winners = [M3_SERPENTINE, M3_TWO_MAZES].map((b) => ({
        id: b.id,
        spendById: measured(b).spendById,
      }));
      expect(checkDistinctness(winners)).toEqual([]);
      expect(winners.map((w) => idsBySpend(w.spendById).slice(0, 2))).toEqual([
        ['basic', 'splash'],
        ['venom', 'antiair'],
      ]);
      expect(measured(M3_SERPENTINE).spendById).toEqual({
        basic: 215,
        splash: 192,
        venom: 90,
        antiair: 70,
        beacon: 30,
        slow: 16,
      });
      expect(measured(M3_TWO_MAZES).spendById).toEqual({
        venom: 189,
        antiair: 133,
        basic: 120,
        splash: 48,
        beacon: 15,
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
    expect(run.state.tick).toBe(1376);
    expect(locateLoss(run)).toEqual({
      tick: 1375,
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
      expect(run.state.tick).toBe(2943);
      expect(locateLoss(run)).toEqual({
        tick: 2942,
        reachedWave: armored,
        fatalLeaks: [{ creepId: 'armored', wave: armored }],
      });
      // That wave's armored creeps all walk the north route, which the build never reaches —
      // and every life it lost went down that route: each creep that leaked was bound where
      // the north route's own first wave was, never where wave 1's west creeps were.
      const armoredSpawns = ruleset.waves[armored]!.spawns.filter((s) => s.creepId === 'armored');
      expect(new Set(armoredSpawns.map((s) => s.entrance))).toEqual(new Set([NORTH]));
      const { leaked, byWave } = leakDestinations(M3_WEST_ONLY);
      const north = byWave.get(NORTH_OPENS)!;
      expect([north.size, byWave.get(0)!.size]).toEqual([1, 1]);
      expect(north).not.toEqual(byWave.get(0));
      expect(leaked).toHaveLength(run.leaks.length);
      expect(new Set(leaked)).toEqual(north);
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

  it(
    'no anti-air places nothing that can hit a flyer, and loses by the end of block 2 to the north lane’s flyers, located by creep id',
    { timeout: 120_000 },
    () => {
      // Every tower it places attacks the ground alone: the serpentine's maze with venom for
      // its antiair and basic for its slow, the two kinds that reach the air.
      const plan = compileReferenceBuild(M3_NO_ANTI_AIR, ruleset);
      const kinds = new Set(plan.flatMap((s) => (s.kind === 'sell' ? [] : [s.towerId])));
      expect(plan.every((s) => s.kind !== 'sell')).toBe(true);
      expect([...kinds].sort()).toEqual(['basic', 'splash', 'venom']);
      for (const id of kinds) expect(ruleset.towerById[id]!.attack?.domain, id).toBe('ground');

      const run = measured(M3_NO_ANTI_AIR);
      expect(run.state.phase).toBe('lost');
      expect(checkAllStepsRan(M3_NO_ANTI_AIR.id, run)).toEqual([]);
      // Lost to the first flyers down the north lane — `flying`, in the wave the lane joins —
      // inside block 2, which ends at wave 20.
      const flying = ruleset.waves[NORTH_AIR]!.spawns;
      expect(new Set(flying.map((s) => s.creepId))).toEqual(new Set(['flying']));
      expect(NORTH_AIR).toBeLessThanOrEqual(BLOCK_2_LAST);
      expect(checkLossWindow(M3_NO_ANTI_AIR.id, run, ruleset, { fromWaveOf: 'flying' })).toEqual(
        [],
      );
      expect(run.state.tick).toBe(8707);
      expect(locateLoss(run)).toEqual({
        tick: 8706,
        reachedWave: NORTH_AIR,
        fatalLeaks: [{ creepId: 'flying', wave: NORTH_AIR }],
      });
      // Every life it lost, it lost to the air: block 1's two air waves down the west lane
      // (8 + 6 lives), then six of the north lane's ten. Its ground maze let nothing through.
      expect(run.leaks.every((l) => isAir(l.creepId))).toBe(true);
      expect(run.waves.filter((w) => w.livesLost > 0).map((w) => [w.wave, w.livesLost])).toEqual([
        [waveIndexForCreep(ruleset, 'flying'), 8],
        [waveIndexForCreep(ruleset, 'armored-flyer'), 6],
        [NORTH_AIR, 6],
      ]);
    },
  );

  it(
    'no anti-air clears the plausibility floors: it spends its income and kills every ground creep it meets',
    { timeout: 120_000 },
    () => {
      // Floors chosen for this story: nearly every bounty it received spent, three tower
      // kinds, and the 211 ground creeps of waves 1–15 all killed.
      const run = measured(M3_NO_ANTI_AIR);
      expect(
        checkPlausibility(M3_NO_ANTI_AIR.id, run, ruleset, {
          minSpend: 400,
          minSpentShare: 0.95,
          minTowerKinds: 3,
          minKills: 211,
          reachesWaveOf: 'armored-flyer',
        }),
      ).toEqual([]);
      const groundSpawns = ruleset.waves
        .slice(0, NORTH_AIR)
        .flatMap((w) => w.spawns)
        .filter((s) => !isAir(s.creepId)).length;
      expect([run.kills, groundSpawns]).toEqual([211, 211]);
      expect([run.spend, run.state.bounty, run.stepsDone]).toEqual([427, 7, 61]);
    },
  );

  it('keeps blocks 1–2 inside section A’s budgets', { timeout: 120_000 }, () => {
    expect(totalScheduledSpawns(ruleset)).toBe(323);
    expect(totalScheduledSpawns(ruleset)).toBeLessThanOrEqual(2000);
    for (const build of M3_CROSSING.builds) {
      expect(measured(build).peakAlive, build.id).toBeLessThanOrEqual(PEAK_ALIVE_BUDGET);
    }
  });
});

describe('M3 stories 5–6 — the board’s capacity in bounty', () => {
  it('the serpentine is its own capacity drawing: a maze the sim accepts tower by tower, still one both routes walk, with no 2 × 2 left clear of their paths', () => {
    // One placement a tick before wave 1, each accepted — the maze invariant never refuses
    // one (the report's own check, `placeCapacityDrawing`).
    expect(M3_CROSSING.fullBoard).toBe(M3_SERPENTINE);
    const { state, failures } = placeCapacityDrawing('full', M3_SERPENTINE, ruleset, SEED);
    expect(failures).toEqual([]);
    expect(state.towers.id.length).toBe(compileReferenceBuild(M3_SERPENTINE, ruleset).length);
    expect(routes(state)).toEqual({ west: 167, north: 143, sharing: 'merged' });

    // "Every tower the maze holds": no open 2 × 2 is left off both routes' paths — where two
    // mazes, which leaves the board's corners and middle open, leaves room (the scan can
    // find some).
    expect(openRoom(state)).toEqual([]);
    const open = placeCapacityDrawing('two mazes', M3_TWO_MAZES, ruleset, SEED);
    expect(open.failures).toEqual([]);
    expect(openRoom(open.state).length).toBeGreaterThan(0);
  });

  it('prices at 83 towers, 613 bounty, which the schedule’s income covers by wave 19 — wave 17 with every early call', () => {
    expect(drawnCapacity(M3_SERPENTINE, ruleset)).toEqual({
      towers: 83,
      bounty: 613,
      spendById: { basic: 215, splash: 192, venom: 90, antiair: 70, beacon: 30, slow: 16 },
    });
    // Blocks 1–2 earn 715 by wave 20 (80 + 577 in kills + 58 in clear bonuses), 815 with
    // every early call at its maximum. 613 is covered by wave 19's 642 (581 by wave 18), and
    // with the calls by wave 17's 621 (573 by wave 16).
    const income = scheduleIncome(ruleset);
    expect(income[19]).toEqual({ wave: 19, earned: 715, earnedWithCalls: 815 });
    expect(income.slice(15, 19).map((r) => [r.earned, r.earnedWithCalls])).toEqual([
      [495, 573],
      [538, 621],
      [581, 669],
      [642, 735],
    ]);
    expect(firstWaveCovering(income, 613, false)).toBe(18);
    expect(firstWaveCovering(income, 613, true)).toBe(16);
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
      expect(text).toContain('won · tick 11710 · lives 20 · score 1077 · 3★ · steps 83/83');
      expect(text).toContain('won · tick 11717 · lives 20 · score 1077 · 3★ · steps 69/69');
      expect(text).toContain('lost to 1 swarm from wave 2 while on wave 2');
      expect(text).toContain('lost to 1 armored from wave 5 while on wave 5');
      expect(text).toContain('lost to 1 flying from wave 16 while on wave 16');
      // The two winners tie on lives and score; the first registered is the strongest.
      expect(text).toContain(
        'board-full: the strongest build, m3-serpentine (won on 20 lives), placed its last tower in wave 19',
      );
      expect(text).toContain(
        'capacity: m3-serpentine draws 83 towers worth 613 bounty — basic 215, splash 192, venom 90, antiair 70, beacon 30, slow 16',
      );
      expect(text).toContain('income (every kill and clear bonus) covers it by the end of wave 19');
      expect(text).toContain(
        'income with every early call at its maximum covers it by the end of wave 17',
      );
    },
  );
});
