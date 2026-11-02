// balance-crossing.test.ts — M3 stories 5–8: the M3 reference builds over the whole 30-wave
// arc on the shipped crossing board (m3.md, "What tuned means"), and the board's capacity in
// bounty.
//
// Section A, each outcome pinned by what the checker measures and every loss LOCATED BY
// CREEP ID (M2's de-indexing):
//   - three winners — the serpentine, which merges both routes into one maze, two mazes,
//     which defends them separately, each by story 1's classifier, and the channel, which
//     sends both routes down one straight channel — win without a sell, one on all 20 lives
//     (3★) and two on fewer (1★), and share no top-two tower id by spend (A1's distinctness);
//   - undefended loses by wave 3, to the swarm;
//   - west only (every tower in columns 1–8) loses to the north route's armored creeps,
//     within two waves of that route opening, and clears the plausibility floors;
//   - no anti-air (no tower that can hit a flyer) loses to the north lane's flyers, the first
//     air down that lane, by the end of block 2, and clears the plausibility floors;
//   - damage only (basic, splash, mine and antiair alone) and the competent corridor (M2's
//     winning shape, one per route) each lose to a block-3 creep and clear the floors.
// Then section B's two reported builds (M3 story 8): the juggling build, which wins only
// because it juggles, inside the replay's command budgets; and the centre-only anti-air
// build, which does not survive the waves that fly both lanes at once. Then block 2's
// firmness: each winner, stopped after block 1, runs out of lives to block 2's creeps. Then
// the budgets, and the capacity: the serpentine fills the board, a legal maze the sim
// accepts, priced against the schedule's income, in wave 23 — inside the board-full target —
// and creep hit points flatten the wave after.
//
// A run of the whole arc is about 19,500 ticks, under a second outside coverage, so they live
// in the default suite, as M2's calibration does. Each build is run once (the memo below) and
// every test reads that run, the report's included; only the route checks run a build again,
// to read where each leaked creep was bound (`leakDestinations`), and the block-1 and honest
// probes run the shorter plans they name.

import { afterEach, describe, it, expect } from 'vitest';
import {
  compileRuleset,
  deriveStars,
  MAX_TOTAL_TOWER_COMMANDS,
  MAX_TOWER_PLACEMENTS,
  type SimState,
} from '@wynding/sim';
import { loadRulesetOrM2Fixture } from './m2-fixture';
import { compileReferenceBuild, type ReferenceBuild } from './reference-build';
import {
  M2_SHOWCASE,
  M3_CENTRE_ANTI_AIR,
  M3_CHANNEL,
  M3_CORRIDOR,
  M3_CROSSING,
  M3_DAMAGE_ONLY,
  M3_JUGGLER,
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
  checkCommandBudgets,
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
import { balanceReport, firstMultiLaneAirWave } from './balance-report';
import { currentPath } from './paths';
import { runBuildScript, type Placement, type ScriptStep } from './script-runner';
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

/** Block 1's and block 2's last waves, waves 10 and 20, as the arc numbers blocks (m3.md,
 *  "Waves & timing"). */
const BLOCK_1_LAST = 9;
const BLOCK_2_LAST = 19;

/** The first wave that flies the north lane — where it joins, located the same way. */
const NORTH_AIR = ruleset.waves.findIndex((w) =>
  w.spawns.some((s) => s.entrance === NORTH && isAir(s.creepId)),
);

/** The first wave that flies both lanes at once — block 3's air headline, located the same
 *  way (the report's own reader). */
const BOTH_LANES = firstMultiLaneAirWave(ruleset)!;

const isBoss = (creepId: string): boolean => ruleset.creepById[creepId]!.role === 'boss';

/** Block 3's wall — the one wave without a boss that flies armored flyers down both lanes —
 *  and its finale, the arc's last boss wave, located the same way. Block 3 brings no creep id
 *  the arc has not already sent, so a block-3 loss is located by its fatal creep and these
 *  waves, not by a creep's first appearance. */
const WALL = ruleset.waves.findIndex(
  (w) =>
    !w.spawns.some((s) => isBoss(s.creepId)) &&
    new Set(w.spawns.filter((s) => s.creepId === 'armored-flyer').map((s) => s.entrance)).size ===
      2,
);
const FINALE = ruleset.waves.map((w) => w.spawns.some((s) => isBoss(s.creepId))).lastIndexOf(true);

/** m3.md's board-full target, wave 24 ± 2, as wave indices. */
const BOARD_FULL_TARGET = { from: 21, to: 25 } as const;

/** A tower anchored at (col, row) reaches a lane: its 2 × 2 footprint's centre stands within
 *  four cells of the west lane's line (row 11) or the north lane's (column 13), where a ground
 *  tower's range reaches the lane — the competent corridor's reach. */
const reachesALane = (col: number, row: number): boolean =>
  Math.min(Math.abs(row + 1 - 11.5), Math.abs(col + 1 - 13.5)) <= 4;

/** The centre-only anti-air build's cluster: the anchors in columns 8–17 and rows 8–14, the
 *  middles of the serpentine's three walls along the west lane, around the crossing. */
const inCentre = (col: number, row: number): boolean =>
  col >= 8 && col <= 17 && row >= 8 && row <= 14;

// Several tests here run the whole arc synchronously. Yield a macrotask after each so the
// worker reads Vitest's RPC replies between them: birpc times a reply out at 60 s, so each
// test alone must still finish inside that. The yield sits between runs, never in one.
// eslint-disable-next-line no-restricted-globals -- yield between tests, not inside a run
afterEach(() => new Promise<void>((r) => setImmediate(r)));

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

/** The lives each wave's own creeps took, as `[wave index, lives]` for every wave that took
 *  any. */
function livesLostByWave(run: BuildRun): [number, number][] {
  return run.waves.filter((w) => w.livesLost > 0).map((w) => [w.wave, w.livesLost]);
}

/** A build's spend as a share of all the bounty it had received by the end of the wave whose
 *  window held its last first placement — while it was still building. A build that has
 *  placed every tower its plan holds banks the rest, the winners as much as the losers.
 *  Banking then is not declining to play only while the plan has no room left within its
 *  reach, which the floor's test checks (`openRoom`). */
function spentShareWhileBuilding(run: BuildRun): number {
  expect(run.stepsDone).toBe(run.stepCount);
  const window = run.waves[run.lastPlacementWave!]!;
  return run.spend / (run.spend + window.unspent);
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

/** `build`'s leaks as `creep@wave route`, in leak order, each creep's route read off where it
 *  was bound (`leakDestinations`, a second run of the same plan, so the same leaks). */
function leakRoutes(build: ReferenceBuild): string[] {
  const { leaked } = leakDestinations(build);
  const { leaks } = measured(build);
  expect(leaked).toHaveLength(leaks.length);
  const routeTo = (destination: number | undefined) =>
    destination === ruleset.board.entranceDestination[WEST]
      ? 'west'
      : destination === ruleset.board.entranceDestination[NORTH]
        ? 'north'
        : `destination ${destination}`;
  return leaks.map(({ creepId, wave }, k) => `${creepId}@${wave + 1} ${routeTo(leaked[k])}`);
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

/** The serpentine's plan, step for step, with each tower kind swapped by `swap` (a kind it
 *  does not name stays) — the derived builds' shared premise. */
function serpentineSwapped(swap: (step: Placement) => string): ScriptStep[] {
  return compileReferenceBuild(M3_SERPENTINE, ruleset).map((s) =>
    s.kind === 'sell' ? s : { ...s, towerId: swap(s) },
  );
}

describe('M3 stories 5–8 — the reference builds, the whole arc on the crossing board', () => {
  it('registers M3’s set on the shipped crossing board, beside M2’s on its fixture', () => {
    expect(REFERENCE_SETS).toEqual([M2_SHOWCASE, M3_CROSSING]);
    expect(M3_CROSSING).toMatchObject({
      rulesetId: 'wynding-core',
      boardId: 'crossing-medium',
      seed: 0x5eed,
      builds: [
        M3_SERPENTINE,
        M3_TWO_MAZES,
        M3_CHANNEL,
        M3_UNDEFENDED,
        M3_WEST_ONLY,
        M3_NO_ANTI_AIR,
        M3_DAMAGE_ONLY,
        M3_CORRIDOR,
        M3_JUGGLER,
        M3_CENTRE_ANTI_AIR,
      ],
      fullBoard: M3_SERPENTINE,
      juggling: M3_JUGGLER,
      centreAntiAir: M3_CENTRE_ANTI_AIR,
    });
    expect(ruleset.waves).toHaveLength(30);
    expect(NORTH_OPENS).toBe(2); // wave 3
    expect(NORTH_AIR).toBe(15); // wave 16
    expect(BOTH_LANES).toBe(25); // wave 26
    expect([WALL, FINALE]).toEqual([28, 29]); // waves 29 and 30
    expect(FINALE).toBe(ruleset.waves.length - 1);
  });

  // The two winners on fewer lives let a few armored flyers through at the walls and the
  // finale and the finale's north boss (two mazes), or a few of the north route's first
  // ground creeps and the same block-3 creeps (the channel); `[wave index, lives]` per wave
  // that took any.
  it.each([
    { build: M3_SERPENTINE, tick: 19549, lives: 20, stars: 3, steps: 83, spend: 799, lost: [] },
    {
      build: M3_TWO_MAZES,
      tick: 17986,
      lives: 10,
      stars: 1,
      steps: 75,
      spend: 689,
      lost: [
        [8, 3],
        [28, 3],
        [29, 4],
      ],
    },
    {
      build: M3_CHANNEL,
      tick: 18458,
      lives: 11,
      stars: 1,
      steps: 80,
      spend: 876,
      lost: [
        [2, 1],
        [3, 2],
        [10, 1],
        [28, 2],
        [29, 3],
      ],
    },
  ])(
    '$build.id wins the whole arc on $lives lives, $stars★, every step run, never selling',
    { timeout: 120_000 },
    ({ build, tick, lives, stars, steps, spend, lost }) => {
      const run = measured(build);
      expect(run.state.phase).toBe('won');
      expect(run.state.tick).toBe(tick);
      expect(run.state.lives).toBe(lives);
      expect(deriveStars(run.state, ruleset)).toBe(stars);
      expect(livesLostByWave(run)).toEqual(lost);
      expect(run.kills + run.leaks.length).toBe(totalScheduledSpawns(ruleset));
      expect([run.stepsDone, run.spend]).toEqual([steps, spend]);
      expect(checkAllStepsRan(build.id, run)).toEqual([]);
      expect(run.sells).toEqual([]);
      expect(checkNoSellWithLiveCreep(build.id, run)).toEqual([]);
      expect(run.peakAlive).toBeLessThanOrEqual(PEAK_ALIVE_BUDGET);
    },
  );

  it(
    'the winners’ block-3 leaks are armored flyers and the finale’s north boss; before it, block 1’s wall and early north ground creeps',
    { timeout: 120_000 },
    () => {
      // Located by creep id, each on the route it was bound for: every creep two mazes and the
      // channel let through in block 3 is an armored flyer or the finale's north boss, all from
      // waves after both lanes first fly together. Before block 3, two mazes lets three of
      // block 1's wall through down the west lane, and the channel a few of the north route's
      // first ground creeps.
      expect(leakRoutes(M3_TWO_MAZES)).toEqual([
        'armored-flyer@9 west',
        'armored-flyer@9 west',
        'armored-flyer@9 west',
        'armored-flyer@29 north',
        'armored-flyer@29 north',
        'armored-flyer@29 west',
        'boss@30 north',
        'armored-flyer@30 north',
      ]);
      expect(leakRoutes(M3_CHANNEL)).toEqual([
        'normal@3 north',
        'fast@4 north',
        'fast@4 north',
        'normal@11 north',
        'armored-flyer@29 north',
        'armored-flyer@29 north',
        'boss@30 north',
      ]);
      for (const build of [M3_TWO_MAZES, M3_CHANNEL]) {
        for (const l of measured(build).leaks.filter((l) => l.wave > BLOCK_2_LAST)) {
          expect(l.wave, build.id).toBeGreaterThan(BOTH_LANES);
          expect(l.creepId === 'armored-flyer' || l.creepId === 'boss', build.id).toBe(true);
        }
      }
    },
  );

  it(
    'at least one winner wins 3★ and at least one wins ≤ 2★ (m3.md, A1)',
    { timeout: 120_000 },
    () => {
      const stars = [M3_SERPENTINE, M3_TWO_MAZES, M3_CHANNEL].map((b) =>
        deriveStars(measured(b).state, ruleset),
      );
      expect(stars).toEqual([3, 1, 1]);
      expect(stars.some((s) => s === 3)).toBe(true);
      expect(stars.some((s) => s >= 1 && s <= 2)).toBe(true);
    },
  );

  it(
    'the serpentine merges the two routes into one maze; two mazes defends them separately',
    { timeout: 120_000 },
    () => {
      // Story 1's classifier on each build's final maze. The serpentine sends both routes
      // through the same corridors (west 167 tiles, north 143, against 27 and 23 empty); two
      // mazes winds each its own way and they cross once (west 55, north 42).
      expect(routes(measured(M3_SERPENTINE).state)).toEqual({
        west: 167,
        north: 143,
        sharing: 'merged',
      });
      expect(routes(measured(M3_TWO_MAZES).state)).toEqual({
        west: 55,
        north: 42,
        sharing: 'separate',
      });
      // The channel's routes run side by side down it — the north route straight down
      // column 13, the west route, after winding the west half, down column 14 from row 3 to
      // row 21 — so the classifier, which counts shared cells, calls them separate. A1 asks
      // for one of each across the set, which the first two give.
      const { state } = measured(M3_CHANNEL);
      expect(routes(state)).toEqual({ west: 98, north: 23, sharing: 'separate' });
      const west = currentPath(ruleset, state, WEST)!;
      expect(west.filter((c) => c.col === 14 && c.row >= 3 && c.row <= 21)).toHaveLength(19);
      expect(currentPath(ruleset, state, NORTH)!.every((c) => c.col === 13)).toBe(true);
    },
  );

  it(
    'the three winners share no top-two tower id by spend, each at least 25% of its build’s spend',
    { timeout: 120_000 },
    () => {
      // A1's distinctness, M2's rule. The serpentine is walled in basic and fights the
      // shared corridors with splash, nearly level by spend, splash just ahead since story 8's
      // prices; two mazes adds no basic past block 1, and venom and antiair overtake it; the
      // channel is slows and beacons around its venom and antiair. Every winner carries
      // antiair for block 3's armored flyers (m3.md's flag): at 9 a tower it stays out of the
      // serpentine's and the channel's top two.
      const winners = [M3_SERPENTINE, M3_TWO_MAZES, M3_CHANNEL].map((b) => ({
        id: b.id,
        spendById: measured(b).spendById,
      }));
      expect(checkDistinctness(winners)).toEqual([]);
      expect(winners.map((w) => idsBySpend(w.spendById).slice(0, 2))).toEqual([
        ['splash', 'basic'],
        ['venom', 'antiair'],
        ['slow', 'beacon'],
      ]);
      expect(measured(M3_SERPENTINE).spendById).toEqual({
        splash: 225,
        basic: 216,
        antiair: 144,
        beacon: 108,
        venom: 66,
        slow: 40,
      });
      expect(measured(M3_TWO_MAZES).spendById).toEqual({
        venom: 242,
        antiair: 207,
        basic: 144,
        splash: 60,
        beacon: 36,
      });
      expect(measured(M3_CHANNEL).spendById).toEqual({
        slow: 250,
        beacon: 234,
        antiair: 135,
        venom: 110,
        splash: 75,
        basic: 72,
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
      expect([run.spend, run.state.bounty, run.kills]).toEqual([150, 0, 42]);
      expect(Object.keys(run.spendById).sort()).toEqual(['antiair', 'basic', 'splash', 'venom']);
    },
  );

  it(
    'no anti-air places nothing that can hit a flyer, and loses by the end of block 2 to the north lane’s flyers, located by creep id',
    { timeout: 120_000 },
    () => {
      // The serpentine's plan, step for step, with a venom for each antiair and a basic for
      // each slow (the two kinds that reach the air) and each beacon (which lifts them) —
      // so every tower it places attacks the ground alone.
      const plan = compileReferenceBuild(M3_NO_ANTI_AIR, ruleset);
      const swap: Readonly<Record<string, string>> = {
        antiair: 'venom',
        slow: 'basic',
        beacon: 'basic',
      };
      expect(plan).toEqual(serpentineSwapped((s) => swap[s.towerId] ?? s.towerId));
      const kinds = new Set(plan.flatMap((s) => (s.kind === 'sell' ? [] : [s.towerId])));
      expect(plan.every((s) => s.kind !== 'sell')).toBe(true);
      expect([...kinds].sort()).toEqual(['basic', 'splash', 'venom']);
      for (const id of kinds) expect(ruleset.towerById[id]!.attack?.domain, id).toBe('ground');

      const run = measured(M3_NO_ANTI_AIR);
      expect(run.state.phase).toBe('lost');
      expect(checkAllStepsRan(M3_NO_ANTI_AIR.id, run)).toEqual([]);
      // Lost to the first flyers down the north lane — `flying`, in the wave the lane joins —
      // inside block 2, which ends at wave 20. Block 2 brings no creep id block 1 did not, so
      // no window named by first appearance (`checkLossWindow`) can single that wave out: the
      // loss is located by its fatal creep and the lane's opening, itself found by content.
      const flying = ruleset.waves[NORTH_AIR]!.spawns;
      expect(new Set(flying.map((s) => s.creepId))).toEqual(new Set(['flying']));
      expect(NORTH_AIR).toBeLessThanOrEqual(BLOCK_2_LAST);
      expect(run.state.tick).toBe(8663);
      expect(locateLoss(run)).toEqual({
        tick: 8662,
        reachedWave: NORTH_AIR,
        fatalLeaks: [{ creepId: 'flying', wave: NORTH_AIR }],
      });
      // It lost all but one wave's lives to the air: block 1's two air waves down the west
      // lane (8 + 6 lives), then three of the north lane's twelve. Its ground maze let one
      // creep through — block 1's boss, which the dearer towers give it too few of to stop.
      expect(run.leaks.filter((l) => !isAir(l.creepId))).toEqual([
        expect.objectContaining({ creepId: 'boss', wave: BLOCK_1_LAST }),
      ]);
      expect(livesLostByWave(run)).toEqual([
        [waveIndexForCreep(ruleset, 'flying'), 8],
        [waveIndexForCreep(ruleset, 'armored-flyer'), 6],
        [BLOCK_1_LAST, 3],
        [NORTH_AIR, 3],
      ]);
    },
  );

  it(
    'no anti-air clears the plausibility floors: it spends its income and kills every ground creep it meets but block 1’s boss',
    { timeout: 120_000 },
    () => {
      // Floors chosen for this story: nearly every bounty it received spent, three tower
      // kinds, and 210 of the 211 ground creeps of waves 1–15 killed — all but block 1's boss.
      // The wave it reached, the north lane's opening, is pinned above (`locateLoss`): no
      // creep id first appears there.
      const run = measured(M3_NO_ANTI_AIR);
      expect(
        checkPlausibility(M3_NO_ANTI_AIR.id, run, ruleset, {
          minSpend: 400,
          minSpentShare: 0.95,
          minTowerKinds: 3,
          minKills: 210,
        }),
      ).toEqual([]);
      const groundSpawns = ruleset.waves
        .slice(0, NORTH_AIR)
        .flatMap((w) => w.spawns)
        .filter((s) => !isAir(s.creepId)).length;
      expect([run.kills, groundSpawns]).toEqual([210, 211]);
      expect([run.spend, run.state.bounty, run.stepsDone]).toEqual([418, 1, 49]);
    },
  );

  it(
    'damage only places nothing but basic, splash, mine and antiair, and loses to block 3’s armored flyers, located by creep id',
    { timeout: 120_000 },
    () => {
      // The serpentine's plan, step for step, with a basic for each venom (DoT) and each slow,
      // and an antiair for each beacon (support) — so it carries no slow, stun, DoT or
      // support (m3.md, A2).
      const plan = compileReferenceBuild(M3_DAMAGE_ONLY, ruleset);
      const swap: Readonly<Record<string, string>> = {
        venom: 'basic',
        slow: 'basic',
        beacon: 'antiair',
      };
      expect(plan).toEqual(serpentineSwapped((s) => swap[s.towerId] ?? s.towerId));
      const kinds = new Set(plan.flatMap((s) => (s.kind === 'sell' ? [] : [s.towerId])));
      expect([...kinds].sort()).toEqual(['antiair', 'basic', 'splash']);
      // Each kind it places only deals damage: a direct hit, single or area, and nothing else.
      for (const id of kinds) {
        const effects = ruleset.towerById[id]!.effects.map((e) => e.kind);
        expect(
          effects.every((k) => k === 'direct' || k === 'aoe'),
          id,
        ).toBe(true);
      }

      const run = measured(M3_DAMAGE_ONLY);
      expect(run.state.phase).toBe('lost');
      expect(checkAllStepsRan(M3_DAMAGE_ONLY.id, run)).toEqual([]);
      // Lost to the armored flyers of block 3's wall, wave 29, which flies them down both lanes
      // (located by content). Without a beacon to lift its antiair or a slow to hold the
      // flyers in range it lets five of wave 26's through and the wall's six finish it; with
      // no DoT for their armor it has leaked every boss before that.
      expect(run.state.tick).toBe(16306);
      const loss = locateLoss(run)!;
      expect(loss).toEqual({
        tick: 16305,
        reachedWave: WALL,
        fatalLeaks: [{ creepId: 'armored-flyer', wave: WALL }],
      });
      for (const l of loss.fatalLeaks) expect(l.wave).toBeGreaterThan(BLOCK_2_LAST);
      expect(livesLostByWave(run)).toEqual([
        [9, 3],
        [19, 6],
        [BOTH_LANES, 5],
        [WALL, 6],
      ]);
      expect(run.leaks.filter((l) => l.creepId === 'boss').map((l) => l.wave)).toEqual([9, 19, 19]);
      expect(run.leaks.filter((l) => l.wave > BLOCK_2_LAST).every((l) => isAir(l.creepId))).toBe(
        true,
      );
    },
  );

  it(
    'the competent corridor walks each route straight down its own lane and loses to block 3’s armored flyers, located by creep id',
    { timeout: 120_000 },
    () => {
      // No maze: on its finished build both routes are their empty-board lengths, 27 and 23.
      // Every tower it places reaches a lane (`reachesALane`).
      const run = measured(M3_CORRIDOR);
      expect(routes(run.state)).toEqual({ west: 27, north: 23, sharing: 'separate' });
      for (const s of compileReferenceBuild(M3_CORRIDOR, ruleset)) {
        expect(reachesALane(s.col, s.row), `(${s.col},${s.row})`).toBe(true);
      }

      expect(run.state.phase).toBe('lost');
      expect(checkAllStepsRan(M3_CORRIDOR.id, run)).toEqual([]);
      // Lost to the armored flyers of block 3's wall, wave 29. Short lanes give its antiair too
      // little time on the air: after a few of the block-1 wall's and the north lane's first
      // flyers, it lets five of wave 26's armored flyers through and eight of the wall's.
      // Every life it lost went to a flyer; its lanes hold the ground, bosses included.
      expect(run.state.tick).toBe(16296);
      const loss = locateLoss(run)!;
      expect(loss).toEqual({
        tick: 16295,
        reachedWave: WALL,
        fatalLeaks: [{ creepId: 'armored-flyer', wave: WALL }],
      });
      for (const l of loss.fatalLeaks) expect(l.wave).toBeGreaterThan(BLOCK_2_LAST);
      expect(livesLostByWave(run)).toEqual([
        [8, 2],
        [NORTH_AIR, 5],
        [BOTH_LANES, 5],
        [WALL, 8],
      ]);
      expect(run.leaks.every((l) => isAir(l.creepId))).toBe(true);
      // The wall's armored flyers came down both lanes.
      expect(
        new Set(
          leakRoutes(M3_CORRIDOR)
            .filter((l) => l.startsWith(`armored-flyer@${WALL + 1} `))
            .map((l) => l.split(' ')[1]),
        ),
      ).toEqual(new Set(['west', 'north']));
    },
  );

  it(
    'damage only and the corridor clear the plausibility floors: they spend their income and engage the arc',
    { timeout: 120_000 },
    () => {
      // Floors chosen for this story: the spend of a block-2 winner, the kills of most of the
      // arc, three tower kinds or more, and nearly all their income spent while they were still
      // building. Neither finishes with a small bank — damage only places its last tower in
      // wave 23, as the serpentine it copies does, and the corridor in wave 20, each with every
      // tower it draws standing — and both bank the rest as the winners do (see
      // `spentShareWhileBuilding`), so the floor reads their spend up to then. That bank is
      // not declining to play because neither has room left within its reach: damage only
      // stands on the serpentine's full maze, and the corridor leaves no 2 × 2 that reaches a
      // lane — only room farther out, which its shape does not use.
      expect(openRoom(measured(M3_DAMAGE_ONLY).state)).toEqual([]);
      const corridorRoom = openRoom(measured(M3_CORRIDOR).state).map((anchor) =>
        anchor.split(',').map(Number),
      );
      expect(corridorRoom.filter(([col, row]) => reachesALane(col!, row!))).toEqual([]);
      expect(corridorRoom.length).toBeGreaterThan(0);
      for (const build of [M3_DAMAGE_ONLY, M3_CORRIDOR]) {
        const run = measured(build);
        expect(
          checkPlausibility(build.id, run, ruleset, {
            minSpend: 500,
            minTowerKinds: 3,
            minKills: 500,
          }),
        ).toEqual([]);
        expect(spentShareWhileBuilding(run), build.id).toBeGreaterThanOrEqual(0.9);
      }
      expect([
        measured(M3_DAMAGE_ONLY).lastPlacementWave,
        measured(M3_CORRIDOR).lastPlacementWave,
      ]).toEqual([22, BLOCK_2_LAST]);
      expect([
        measured(M3_DAMAGE_ONLY).spend,
        measured(M3_DAMAGE_ONLY).kills,
        measured(M3_CORRIDOR).spend,
        measured(M3_CORRIDOR).kills,
      ]).toEqual([699, 505, 669, 503]);
    },
  );
});

describe('M3 story 8 — section B’s reported builds', () => {
  it(
    'the juggling build is the serpentine without its venom, then a juggle that trades two basics at the last corridor’s ends',
    { timeout: 120_000 },
    () => {
      // Its first 83 steps are the serpentine's, with a basic for each venom; every step after
      // them is a juggle: a sell then a placement, the basic at (4, 20) traded for one at
      // (22, 20) and back, each pair a tick apart, all in the finale.
      const plan = compileReferenceBuild(M3_JUGGLER, ruleset);
      const serpentine = serpentineSwapped((s) => (s.towerId === 'venom' ? 'basic' : s.towerId));
      expect(plan.slice(0, serpentine.length)).toEqual(serpentine);
      const juggle = plan.slice(serpentine.length);
      expect(juggle).toHaveLength(48);
      const ends = ['4,20', '22,20'];
      juggle.forEach((s, k) => {
        const pair = Math.floor(k / 2);
        const sold = ends[pair % 2]!;
        const placed = ends[(pair + 1) % 2]!;
        if (k % 2 === 0) {
          expect(s, `step ${k}`).toMatchObject({ kind: 'sell' });
          expect(`${s.col},${s.row}`, `step ${k}`).toBe(sold);
        } else {
          expect(s, `step ${k}`).toMatchObject({ towerId: 'basic' });
          expect(`${s.col},${s.row}`, `step ${k}`).toBe(placed);
          expect(s.notBeforeTick, `step ${k}`).toBe(juggle[k - 1]!.notBeforeTick! + 1);
        }
        expect(s.notBeforeTick!, `step ${k}`).toBeGreaterThan(
          measured(M3_JUGGLER).state.waveLaunchTick[FINALE]!,
        );
      });
    },
  );

  it(
    'the juggling build, played straight — its 83 towers without the juggle — loses the finale by a life, to a boss',
    { timeout: 120_000 },
    () => {
      const honest = runReferenceBuild(
        ruleset,
        SEED,
        compileReferenceBuild(M3_JUGGLER, ruleset).slice(0, 83),
      );
      expect([honest.state.phase, honest.state.lives]).toEqual(['lost', -1]);
      expect(locateLoss(honest)).toEqual({
        tick: 19980,
        reachedWave: FINALE,
        fatalLeaks: [{ creepId: 'boss', wave: FINALE }],
      });
      expect(livesLostByWave(honest)).toEqual([
        [4, 3],
        [9, 3],
        [19, 6],
        [FINALE, 9],
      ]);
    },
  );

  it(
    'the juggling build wins only because it juggles: on 2 lives, every sell with creeps alive, inside the replay’s command budgets',
    { timeout: 120_000 },
    () => {
      const run = measured(M3_JUGGLER);
      expect(run.state.phase).toBe('won');
      expect([run.state.tick, run.state.lives, deriveStars(run.state, ruleset)]).toEqual([
        23136, 2, 1,
      ]);
      expect(checkAllStepsRan(M3_JUGGLER.id, run)).toEqual([]);
      // Every one of its 24 sells comes with creeps alive — juggling, so never a winner by
      // A1's rule, and never the strongest build.
      expect(run.sells).toHaveLength(24);
      expect(checkNoSellWithLiveCreep(M3_JUGGLER.id, run)).toHaveLength(24);
      // Against the same plan played straight (above), the juggle saves three lives in the
      // finale, one boss's worth: the north boss, turned back the length of the last corridor
      // until it dies. Both west bosses still leak, a west creep's way out being as long by
      // either end.
      expect(livesLostByWave(run)).toEqual([
        [4, 3],
        [9, 3],
        [19, 6],
        [FINALE, 6],
      ]);
      expect(leakRoutes(M3_JUGGLER).filter((l) => l.startsWith(`boss@${FINALE + 1} `))).toEqual([
        `boss@${FINALE + 1} west`,
        `boss@${FINALE + 1} west`,
      ]);
      // Every command it sends is accepted the tick it is sent: 107 placements (its 83 towers,
      // and 24 re-placements) and 24 sells, far inside both of the replay validator's budgets.
      expect(run.commands).toEqual({ place: 107, sell: 24 });
      expect(checkCommandBudgets(M3_JUGGLER.id, run)).toEqual([]);
      expect(run.commands.place + run.commands.sell).toBeLessThanOrEqual(MAX_TOTAL_TOWER_COMMANDS);
      expect(run.commands.place).toBeLessThanOrEqual(MAX_TOWER_PLACEMENTS);
    },
  );

  it(
    'the centre-only anti-air build keeps the serpentine’s maze and puts every tower that can hit a flyer in the cluster at the crossing',
    { timeout: 120_000 },
    () => {
      // Tower for tower the serpentine's plan: inside the block of anchors around the crossing
      // every tower but a beacon is an antiair; outside it, a venom for each antiair and a
      // basic for each slow, so nothing out there reaches the air.
      const plan = compileReferenceBuild(M3_CENTRE_ANTI_AIR, ruleset);
      expect(plan).toEqual(
        serpentineSwapped((s) => {
          if (inCentre(s.col, s.row)) return s.towerId === 'beacon' ? 'beacon' : 'antiair';
          return s.towerId === 'antiair' ? 'venom' : s.towerId === 'slow' ? 'basic' : s.towerId;
        }),
      );
      const placed = plan.flatMap((s) => (s.kind === 'sell' ? [] : [s]));
      const airReach = placed.filter(
        (s) => ruleset.towerById[s.towerId]!.attack?.domain !== 'ground' && s.towerId !== 'beacon',
      );
      expect(airReach.every((s) => s.towerId === 'antiair' && inCentre(s.col, s.row))).toBe(true);
      expect([
        airReach.length,
        placed.filter((s) => s.towerId === 'beacon' && inCentre(s.col, s.row)).length,
      ]).toEqual([11, 4]);
    },
  );

  it(
    'the centre-only anti-air build does not survive the air down both lanes at once, located by creep id',
    { timeout: 120_000 },
    () => {
      // It reaches block 3's two-lane air, then the flyers coming down both lanes at once take
      // its lives: seven of wave 26's, and the wall's finish it. (Block 1's wall, down the west
      // lane alone, already gets five past a cluster that far from the west entrance.)
      const run = measured(M3_CENTRE_ANTI_AIR);
      expect(run.state.phase).toBe('lost');
      expect(checkAllStepsRan(M3_CENTRE_ANTI_AIR.id, run)).toEqual([]);
      expect(run.state.tick).toBe(16306);
      expect(locateLoss(run)).toEqual({
        tick: 16305,
        reachedWave: WALL,
        fatalLeaks: [{ creepId: 'armored-flyer', wave: WALL }],
      });
      expect(livesLostByWave(run)).toEqual([
        [8, 5],
        [BOTH_LANES, 7],
        [WALL, 8],
      ]);
      expect(run.leaks.every((l) => isAir(l.creepId))).toBe(true);
      expect(run.waves[BOTH_LANES - 1]!.lives).toBe(15);
    },
  );
});

describe('M3 story 8 — block 2 asks for more than block 1 built', () => {
  // Stopped after block 1 — the towers each winner stands when wave 11 launches, its plan up
  // to there, banking everything after — no winner wins block 2: two run out of lives to its
  // creeps, and the strongest is left on one life by them and falls in block 3's first armor
  // wave. (Before story 8, block-1 builds won block 2 on 6–7 lives without a block-2 tower.)
  it.each([
    {
      build: M3_SERPENTINE,
      towers: 37,
      loss: { tick: 13616, reachedWave: 23, fatalLeaks: [{ creepId: 'armored', wave: 23 }] },
      lost: [
        [NORTH_AIR, 6],
        [18, 7],
        [BLOCK_2_LAST, 6],
        [23, 1],
      ],
    },
    {
      build: M3_TWO_MAZES,
      towers: 38,
      loss: { tick: 11500, reachedWave: 20, fatalLeaks: [{ creepId: 'boss', wave: BLOCK_2_LAST }] },
      lost: [
        [8, 3],
        [NORTH_AIR, 7],
        [18, 8],
        [BLOCK_2_LAST, 3],
      ],
    },
    {
      build: M3_CHANNEL,
      towers: 28,
      loss: { tick: 10327, reachedWave: 18, fatalLeaks: [{ creepId: 'armored', wave: 18 }] },
      lost: [
        [2, 1],
        [3, 2],
        [10, 1],
        [14, 2],
        [NORTH_AIR, 9],
        [17, 3],
        [18, 2],
      ],
    },
  ])(
    '$build.id, stopped after block 1, does not win block 2',
    { timeout: 120_000 },
    ({ build, towers, loss, lost }) => {
      const full = measured(build);
      const standing = full.waves[BLOCK_1_LAST]!.towers;
      expect(standing).toBe(towers);
      const run = runReferenceBuild(
        ruleset,
        SEED,
        compileReferenceBuild(build, ruleset).slice(0, standing),
      );
      expect(run.state.phase).toBe('lost');
      expect(locateLoss(run)).toEqual(loss);
      expect(livesLostByWave(run)).toEqual(lost);
      // The lives block 1 and 2's own creeps took: all of them, or all but one.
      const blocksOneAndTwo = run.waves
        .filter((w) => w.wave <= BLOCK_2_LAST)
        .reduce((n, w) => n + w.livesLost, 0);
      expect(blocksOneAndTwo).toBeGreaterThanOrEqual(ruleset.balance.startingLives - 1);
    },
  );
});

describe('M3 stories 5–8 — the budgets', () => {
  it('keeps the whole arc inside section A’s budgets', { timeout: 120_000 }, () => {
    // 544 spawns since story 8's block-2 moves (546 in m3.md's first pass), and the biggest
    // wave, wave 29, still sends 30.
    expect(totalScheduledSpawns(ruleset)).toBe(544);
    expect(totalScheduledSpawns(ruleset)).toBeLessThanOrEqual(2000);
    expect(Math.max(...ruleset.waves.map((w) => w.spawns.length))).toBe(30);
    const peaks = Object.fromEntries(M3_CROSSING.builds.map((b) => [b.id, measured(b).peakAlive]));
    for (const [id, peak] of Object.entries(peaks)) {
      expect(peak, id).toBeLessThanOrEqual(PEAK_ALIVE_BUDGET);
    }
    expect(peaks).toEqual({
      'm3-serpentine': 26,
      'm3-two-mazes': 25,
      'm3-channel': 25,
      'm3-undefended': 16,
      'm3-west-only': 10,
      'm3-no-anti-air': 15,
      'm3-damage-only': 29,
      'm3-corridor': 25,
      'm3-juggler': 29,
      'm3-centre-anti-air': 24,
    });
  });
});

describe('M3 stories 5–8 — the board’s capacity in bounty', () => {
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

  it('prices at 83 towers, 799 bounty, which the schedule’s income covers by wave 23 — wave 20 with every early call', () => {
    expect(drawnCapacity(M3_SERPENTINE, ruleset)).toEqual({
      towers: 83,
      bounty: 799,
      spendById: { splash: 225, basic: 216, antiair: 144, beacon: 108, venom: 66, slow: 40 },
    });
    // Blocks 1–2 earn 735 by wave 20 (96 + 581 in kills + 58 in clear bonuses), 835 with
    // every early call at its maximum. 799 is covered by wave 23's 825 (781 by wave 22), and
    // with the calls by wave 20's 835 (755 by wave 19). The whole arc earns 1,286 (96 + 1,088
    // + 102), 1,443 with every call — the board holds well over half of it.
    const income = scheduleIncome(ruleset);
    expect(income[29]).toEqual({ wave: 29, earned: 1286, earnedWithCalls: 1443 });
    expect(income.slice(18, 23).map((r) => [r.earned, r.earnedWithCalls])).toEqual([
      [662, 755],
      [735, 835],
      [751, 859],
      [781, 894],
      [825, 943],
    ]);
    expect(firstWaveCovering(income, 799, false)).toBe(22);
    expect(firstWaveCovering(income, 799, true)).toBe(19);
  });

  it(
    'the strongest build places its last tower in wave 23, inside the board-full target of wave 24 ± 2',
    { timeout: 120_000 },
    () => {
      // m3.md's board-full target; the serpentine, the strongest build, places its 83rd and
      // last tower in wave 23's window — the wave whose income first covers the drawing (the
      // runner places a step only once the bounty for it is in hand).
      const run = measured(M3_SERPENTINE);
      expect(run.lastPlacementWave).toBe(22);
      expect(run.lastPlacementWave!).toBeGreaterThanOrEqual(BOARD_FULL_TARGET.from);
      expect(run.lastPlacementWave!).toBeLessThanOrEqual(BOARD_FULL_TARGET.to);
      expect(run.waves[22]!.towers).toBe(83);
    },
  );

  it(
    'creep hit points rise to their flat top the wave after the board fills (m3.md, "Creep HP growth")',
    { timeout: 120_000 },
    () => {
      // The curve flattens at the board-full wave: the last tower stands in wave 23, so from
      // wave 24 on every wave carries the top value, and every wave before it less.
      const full = measured(M3_SERPENTINE).lastPlacementWave!;
      const hp = ruleset.waves.map((w) => w.hpPercent);
      const top = Math.max(...hp);
      expect(top).toBe(270);
      expect(hp.findIndex((p) => p === top)).toBe(full + 1);
      expect(hp.slice(full + 1).every((p) => p === top)).toBe(true);
    },
  );

  it(
    'the balance report runs the M3 set, names the strongest build, reports section B’s builds and prices the board',
    { timeout: 120_000 },
    () => {
      // The memo's runs, not a second simulation of every build: the report's own runner
      // would measure the same builds on the same bundle, board and seed — which it checks.
      const { text, failures } = balanceReport(
        [M3_CROSSING],
        loadRulesetOrM2Fixture,
        (build, compiled, seed) => {
          expect([compiled.digest, compiled.boardId, seed]).toEqual([
            ruleset.digest,
            ruleset.boardId,
            SEED,
          ]);
          return measured(build);
        },
      );
      expect(failures).toEqual([]);
      for (const build of M3_CROSSING.builds) {
        expect(text).toContain(`${build.id} — ${build.summary}`);
      }
      expect(text).toContain('won · tick 19549 · lives 20 · score 1588 · 3★ · steps 83/83');
      expect(text).toContain('won · tick 17986 · lives 10 · score 1292 · 1★ · steps 75/75');
      expect(text).toContain('won · tick 18458 · lives 11 · score 1326 · 1★ · steps 80/80');
      expect(text).toContain('lost to 1 swarm from wave 2 while on wave 2');
      expect(text).toContain('lost to 1 armored from wave 5 while on wave 5');
      expect(text).toContain('lost to 1 flying from wave 16 while on wave 16');
      expect(text).toContain('lost to 1 armored-flyer from wave 29 while on wave 29');
      expect(text).toContain(
        'won · tick 23136 · lives 2 · score 1004 · 1★ · steps 131/131 · spend 913 · kills 536 · peak alive 29 · last tower in wave 30 · sells 24 (24 with creeps alive)',
      );
      // The serpentine wins on the most lives, so it is the strongest; the juggler, on a
      // live sell, is never a candidate.
      expect(text).toContain(
        'board-full: the strongest build, m3-serpentine (won on 20 lives), placed its last tower in wave 23',
      );
      expect(text).toContain(
        [
          'anti-air share of spend — on towers that hit only flyers, then on every tower that can hit one:',
          '  m3-serpentine: 144 of 799 (18%), 184 (23%)',
          '  m3-two-mazes: 207 of 689 (30%), 207 (30%)',
          '  m3-channel: 135 of 876 (15%), 385 (44%)',
        ].join('\n'),
      );
      expect(text).toContain(
        [
          'juggling: m3-juggler won on 2 lives (1★) — 24 sells, 24 with creeps alive; spend 913, 817 net of refunds; 131 tower commands, 107 of them placements',
          '  beside the honest winners: m3-serpentine won on 20 lives (3★), spend 799; m3-two-mazes won on 10 lives (1★), spend 689; m3-channel won on 11 lives (1★), spend 876',
        ].join('\n'),
      );
      expect(text).toContain(
        [
          'centre-only anti-air: m3-centre-anti-air lost on wave 29 — it does not survive the air down two lanes at once from wave 26',
          '  lives its flyers took from wave 26 on: wave 26: 7, wave 29: 8',
        ].join('\n'),
      );
      expect(text).toContain(
        'capacity: m3-serpentine draws 83 towers worth 799 bounty — splash 225, basic 216, antiair 144, beacon 108, venom 66, slow 40',
      );
      expect(text).toContain('income (every kill and clear bonus) covers it by the end of wave 23');
      expect(text).toContain(
        'income with every early call at its maximum covers it by the end of wave 20',
      );
    },
  );
});
