// combat.test.ts — Story 4 combat: scheduled-impact fire and resolution, wasted
// shots, inclusive range, sticky "first" targeting (hold vs re-acquire, tie-break),
// fire cadence with no warm-up, per-kill bounty, and sell-preserves-cooldown.

import { describe, it, expect } from 'vitest';
import { createInitialState, step, type SimInput } from './index';
import { emptyTowers, type TowerArrays } from './tower';
import {
  runCombat,
  applyImpactToCreep,
  MAX_DOT_RECORDS,
  type CombatCreeps,
  type DotRecord,
  type Impact,
  type StepEvents,
} from './combat';
import type { CompiledEffect } from './ruleset';
import { testRuleset } from './test-support';
import type { CreepDef } from '@wynding/types';

// A large open board so targeting geometry is clean; exit on the right at row 6.
const RULESET = testRuleset({
  widthTiles: 14,
  heightTiles: 14,
  entrance: { col: 0, row: 6 },
  exit: { col: 13, row: 6 },
});
const FIELD = RULESET.board.field;
const GRID = RULESET.board.grid;

// Tuning now lives in the ruleset; mirror the compiled M1 tower stats as locals for
// the tests. `runCombat` takes the sim-owned `CompiledTower` (the raw v2 `TowerDef`
// carries a discriminated `effects` array instead of a flat `damage`), so `TEST_TOWER`
// here is `RULESET.towerById['basic']` — the compiled projection — not
// `test-support`'s raw def. `runCombat` itself now takes the whole `towerById` map
// (M2-S3: a real catalog, not one flat tower), so `TOWER_BY_ID` is the arg every
// call site below passes.
const TEST_TOWER = RULESET.towerById['basic']!;
const TOWER_BY_ID = RULESET.towerById;
const RANGE = TEST_TOWER.rangeFp;
const TRAVEL_TICKS = TEST_TOWER.travelTicks;
const FIRE_INTERVAL = TEST_TOWER.cadenceTicks;
// A type predicate rather than a cast (CodeRabbit #73): if `basic` ever loses its
// direct effect this throws a NAMED error at module load, not an opaque TypeError.
const DIRECT_EFFECT = TEST_TOWER.effects.find(
  (e): e is Extract<CompiledEffect, { kind: 'direct' }> => e.kind === 'direct',
);
if (DIRECT_EFFECT === undefined) throw new Error('`basic` must carry a direct effect');
const DIRECT_DAMAGE = DIRECT_EFFECT.amount;
// Bounty follows the compiled creep catalog for the same reason the tower stats do
// above — a testBundle bounty edit must move these economy assertions with it.
const KILL_BOUNTY = RULESET.creepById[RULESET.waves[0]!.spawns[0]!.creepId]!.bounty;

// `runCombat` gained a REQUIRED `creepById` armor-lookup parameter at M2-S5a P1 —
// this local wrapper supplies an empty one (`{}`, unarmored) so this file's ~20
// existing call sites, which exercise pre-armor behaviour, don't need one-by-one
// edits. M2-S5a P2 then added a `dots` parameter (STATE SHAPE ONLY — no behaviour
// in this packet), which this wrapper likewise defaults to `[]`. The param types
// are DERIVED from `runCombat` itself (never duplicated) so this wrapper can never
// silently drift from the real signature. Tests that exercise armor or DoT state
// call `runCombat`/`applyImpactToCreep` directly with a real `creepById`/`dots`.
type RunCombatParams = Parameters<typeof runCombat>;
function runCombatT(
  creeps: RunCombatParams[0],
  towers: RunCombatParams[1],
  impacts: RunCombatParams[2],
  tick: RunCombatParams[4],
  bounty: RunCombatParams[5],
  field: RunCombatParams[6],
  grid: RunCombatParams[7],
  towerById: RunCombatParams[8],
  slowFloorNum: RunCombatParams[10],
  slowFloorDen: RunCombatParams[11],
  events?: RunCombatParams[12],
): ReturnType<typeof runCombat> {
  return runCombat(
    creeps,
    towers,
    impacts,
    [],
    tick,
    bounty,
    field,
    grid,
    towerById,
    {},
    slowFloorNum,
    slowFloorDen,
    events,
  );
}

/** One tower at (5,5); footprint centre = ((5+1)·256, (5+1)·256) = (1536,1536). */
function oneTower(targetId = 0, nextFireTick = 0): TowerArrays {
  return {
    id: [100],
    col: [5],
    row: [5],
    spend: [5],
    targetId: [targetId],
    nextFireTick: [nextFireTick],
    towerId: ['basic'],
  };
}

const cx = (col: number): number => col * 256 + 128;
const cy = (row: number): number => row * 256 + 128;

/** Build a creep SoA from resting creeps at given cells. */
function restingCreeps(
  rows: ReadonlyArray<{ id: number; col: number; row: number; hp: number }>,
): CombatCreeps {
  return {
    id: rows.map((r) => r.id),
    hp: rows.map((r) => r.hp),
    bounty: rows.map(() => 1),
    speed: rows.map(() => 26),
    fromX: rows.map((r) => cx(r.col)),
    fromY: rows.map((r) => cy(r.row)),
    headCol: rows.map((r) => r.col),
    headRow: rows.map((r) => r.row),
    progress: rows.map(() => 0), // progress 0 (rest)
    wave: rows.map(() => 0),
    creepId: rows.map(() => 'normal'),
    slowMulFp: rows.map(() => 0),
    slowUntilTick: rows.map(() => 0),
  };
}

/** A creep whose DERIVED point is exactly `(px,py)` — a progress-0 transitional row. */
function creepAtPoint(id: number, px: number, py: number, hp: number): CombatCreeps {
  const col = Math.floor(px / 256);
  const row = Math.floor(py / 256);
  // Head must be an adjacent in-bounds cell so the row validates as transitional.
  const headCol = col + 1 <= 13 ? col + 1 : col - 1;
  return {
    id: [id],
    hp: [hp],
    bounty: [1],
    speed: [26],
    fromX: [px],
    fromY: [py],
    headCol: [headCol],
    headRow: [row],
    progress: [0],
    wave: [0],
    creepId: ['normal'],
    slowMulFp: [0],
    slowUntilTick: [0],
  };
}

describe('runCombat — fire, schedule, resolve, kill, bounty', () => {
  it('schedules an impact on the target and resolves it TRAVEL_TICKS later as a kill', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: DIRECT_DAMAGE }]); // in range
    const towers = oneTower();

    const t0 = runCombatT(
      creeps,
      towers,
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(t0.impacts).toHaveLength(1);
    expect(t0.impacts[0]?.impactTick).toBe(TRAVEL_TICKS);
    expect(t0.impacts[0]).toMatchObject({ kind: 'targeted', targetId: 1 });
    expect(towers.targetId[0]).toBe(1); // locked
    expect(towers.nextFireTick[0]).toBe(FIRE_INTERVAL); // cooldown set
    expect(t0.creeps.hp[0]).toBe(DIRECT_DAMAGE); // no damage yet (in flight)
    expect(t0.bounty).toBe(0);

    // Resolve at the impact tick: hp → 0, creep swept, bounty credited.
    const t4 = runCombatT(
      t0.creeps,
      towers,
      t0.impacts,
      TRAVEL_TICKS,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(t4.creeps.id).toHaveLength(0); // killed and swept
    expect(t4.impacts).toHaveLength(0); // impact consumed
    expect(t4.bounty).toBe(KILL_BOUNTY);
  });

  it('consumes a WASTED shot (target gone before impact) with no damage or bounty', () => {
    const creeps = restingCreeps([
      { id: 1, col: 7, row: 6, hp: DIRECT_DAMAGE }, // the fired-at target
      { id: 2, col: 7, row: 7, hp: 100 }, // a bystander that must be untouched
    ]);
    const towers = oneTower();
    const t0 = runCombatT(
      creeps,
      towers,
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(t0.impacts[0]).toMatchObject({ kind: 'targeted', targetId: 1 });

    // Target 1 leaves play before the impact lands: drop it from the SoA.
    const withoutTarget: CombatCreeps = {
      id: [2],
      hp: [100],
      bounty: [1],
      speed: [26],
      fromX: [cx(7)],
      fromY: [cy(7)],
      headCol: [7],
      headRow: [7],
      progress: [0],
      wave: [0],
      creepId: ['normal'],
      slowMulFp: [0],
      slowUntilTick: [0],
    };
    const t4 = runCombatT(
      withoutTarget,
      towers,
      t0.impacts,
      TRAVEL_TICKS,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(t4.bounty).toBe(0); // wasted — no bounty
    expect(t4.creeps.hp[0]).toBe(100); // bystander undamaged (impact was for id 1)
    // The impact is consumed; a fresh fire this tick (cooldown from t0 was 30) is not
    // due yet, so no new impact should appear from resolution alone.
    expect(t4.impacts.every((i: Impact) => i.impactTick > TRAVEL_TICKS)).toBe(true);
  });
});

describe('runCombat — inclusive range boundary', () => {
  it('targets a creep whose point is exactly RANGE away, but not one a unit beyond', () => {
    // Tower centre (1536,1536). A point at x = 1536 + RANGE, y = 1536 is exactly RANGE.
    const onEdge = creepAtPoint(1, 1536 + RANGE, 1536, 10);
    const inRangeResult = runCombatT(
      onEdge,
      oneTower(),
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(inRangeResult.impacts).toHaveLength(1); // inclusive — fired

    const beyond = creepAtPoint(1, 1536 + RANGE + 1, 1536, 10);
    const outResult = runCombatT(
      beyond,
      oneTower(),
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(outResult.impacts).toHaveLength(0); // one unit past the boundary — no target
  });
});

describe('runCombat — landed-impact StepEvents (#31)', () => {
  it('a leaked (gone) target produces zero events — the wasted shot drains with no point', () => {
    const withoutTarget: CombatCreeps = {
      id: [2],
      hp: [100],
      bounty: [1],
      speed: [26],
      fromX: [cx(7)],
      fromY: [cy(7)],
      headCol: [7],
      headRow: [7],
      progress: [0],
      wave: [0],
      creepId: ['normal'],
      slowMulFp: [0],
      slowUntilTick: [0],
    };
    const impact: Impact = {
      kind: 'targeted',
      impactTick: TRAVEL_TICKS,
      targetId: 1, // no row with this id — the target already left
      sourceId: 100,
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
    };
    const events: StepEvents = { impactPoints: [], fired: [] };
    runCombatT(
      withoutTarget,
      oneTower(),
      [impact],
      TRAVEL_TICKS,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
      events,
    );
    expect(events.impactPoints).toHaveLength(0);
  });

  it('a survivor hit produces exactly one event at its point', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 100 }]); // survives DIRECT_DAMAGE
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
    };
    const events: StepEvents = { impactPoints: [], fired: [] };
    const result = runCombatT(
      creeps,
      oneTower(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
      events,
    );
    expect(result.creeps.hp[0]).toBe(100 - DIRECT_DAMAGE); // damaged, alive
    expect(events.impactPoints).toEqual([{ x: cx(7), y: cy(6), radiusFp: 0 }]);
  });

  it('a kill produces exactly one event, at the point before death', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: DIRECT_DAMAGE }]);
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
    };
    const events: StepEvents = { impactPoints: [], fired: [] };
    const result = runCombatT(
      creeps,
      oneTower(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
      events,
    );
    expect(result.creeps.id).toHaveLength(0); // killed and swept
    expect(events.impactPoints).toEqual([{ x: cx(7), y: cy(6), radiusFp: 0 }]);
  });

  it('same-tick two-impact overkill produces exactly one event (the second is wasted)', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: DIRECT_DAMAGE }]);
    const impacts: Impact[] = [
      {
        kind: 'targeted',
        impactTick: 0,
        targetId: 1,
        sourceId: 100,
        effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
      },
      {
        kind: 'targeted',
        impactTick: 0,
        targetId: 1,
        sourceId: 100,
        effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
      },
    ];
    const events: StepEvents = { impactPoints: [], fired: [] };
    const result = runCombatT(
      creeps,
      oneTower(),
      impacts,
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
      events,
    );
    expect(result.creeps.id).toHaveLength(0); // killed once
    expect(events.impactPoints).toHaveLength(1); // the second impact resolves against a dead row — wasted
  });

  it('a multi-step catch-up accumulates events append-only across steps sharing one collector', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    const events: StepEvents = { impactPoints: [], fired: [] };
    let cur = creeps;
    let impacts: Impact[] = [];
    const towers = oneTower();
    for (let t = 0; t <= FIRE_INTERVAL; t++) {
      const r = runCombatT(
        cur,
        towers,
        impacts,
        t,
        0,
        FIELD,
        GRID,
        TOWER_BY_ID,
        RULESET.balance.slowFloorNum,
        RULESET.balance.slowFloorDen,
        events,
      );
      cur = r.creeps;
      impacts = r.impacts;
    }
    // Exactly one fire+resolve landed within this window (fired at t=0, resolves at
    // TRAVEL_TICKS, next fire not due until FIRE_INTERVAL) — the collector accumulated it.
    expect(events.impactPoints).toEqual([{ x: cx(7), y: cy(6), radiusFp: 0 }]);
  });
});

describe('runCombat — fired StepEvents (#32)', () => {
  it('firing emits exactly one fired event with the exact origin and tick window', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 100 }]);
    const events: StepEvents = { impactPoints: [], fired: [] };
    runCombatT(
      creeps,
      oneTower(),
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
      events,
    );
    // Tower at (5,5): footprint centre = ((5+1)·256, (5+1)·256) = (1536,1536).
    expect(events.fired).toEqual([
      {
        kind: 'targeted',
        originX: 1536,
        originY: 1536,
        targetId: 1,
        launchTick: 0,
        impactTick: TRAVEL_TICKS,
      },
    ]);
  });

  it('a wasted (no-target) tick fires nothing — no fired event either', () => {
    const creeps = restingCreeps([]); // nothing in range
    const events: StepEvents = { impactPoints: [], fired: [] };
    runCombatT(
      creeps,
      oneTower(),
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
      events,
    );
    expect(events.fired).toEqual([]);
  });

  it('retargeting before the first shot resolves does not corrupt its already-recorded event (the case that killed state-derived inference)', () => {
    const towers = oneTower();
    const events: StepEvents = { impactPoints: [], fired: [] };
    // Tick 0: creep A (id 1) in range — tower fires at A.
    let cur = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    let impacts: Impact[] = [];
    for (let t = 0; t < FIRE_INTERVAL; t++) {
      const r = runCombatT(
        cur,
        towers,
        impacts,
        t,
        0,
        FIELD,
        GRID,
        TOWER_BY_ID,
        RULESET.balance.slowFloorNum,
        RULESET.balance.slowFloorDen,
        events,
      );
      cur = r.creeps;
      impacts = r.impacts;
    }
    // A leaves (swapped for creep B, id 2) exactly when the next fire becomes due — the
    // sticky-hold breaks (A no longer present), the tower retargets to B, and fires
    // again. A state-derived origin (re-reading `towers.targetId` later) would report
    // B for BOTH shots; the fired-event route must keep the first shot's target as A.
    cur = restingCreeps([{ id: 2, col: 7, row: 6, hp: 1000 }]);
    runCombatT(
      cur,
      towers,
      impacts,
      FIRE_INTERVAL,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
      events,
    );

    expect(events.fired).toHaveLength(2);
    expect(events.fired[0]).toMatchObject({ targetId: 1, launchTick: 0, impactTick: TRAVEL_TICKS });
    expect(events.fired[1]).toMatchObject({
      targetId: 2,
      launchTick: FIRE_INTERVAL,
      impactTick: FIRE_INTERVAL + TRAVEL_TICKS,
    });
  });
});

describe('runCombat — sticky "first" targeting', () => {
  it('picks the lower creep id on a route-distance tie', () => {
    // (7,5) and (7,7) are the same route-distance from the exit (row-6 symmetry) and
    // both in range, so the tie breaks to the lower id — here id 2, not id 5.
    const creeps = restingCreeps([
      { id: 5, col: 7, row: 5, hp: 100 },
      { id: 2, col: 7, row: 7, hp: 100 },
    ]);
    const towers = oneTower();
    runCombatT(
      creeps,
      towers,
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(towers.targetId[0]).toBe(2);
  });

  it('HOLDS its locked target when a higher-priority creep enters, then re-acquires when it leaves', () => {
    // Acquire creep A (id 1) at col 7 alone.
    const towers = oneTower();
    const aOnly = restingCreeps([{ id: 1, col: 7, row: 6, hp: 100 }]);
    runCombatT(
      aOnly,
      towers,
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(towers.targetId[0]).toBe(1);

    // A HIGHER-priority creep B (id 2, nearer the exit ⇒ smaller route distance)
    // enters — the lock HOLDS on A and never swaps to the higher priority.
    const bothPresent = restingCreeps([
      { id: 1, col: 7, row: 6, hp: 100 },
      { id: 2, col: 9, row: 6, hp: 100 }, // nearer the exit — would win a fresh acquire
    ]);
    runCombatT(
      bothPresent,
      towers,
      [],
      1,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(towers.targetId[0]).toBe(1); // did NOT swap to the higher-priority creep

    // A leaves play — the tower re-acquires the remaining in-range creep B.
    const bOnly = restingCreeps([{ id: 2, col: 9, row: 6, hp: 100 }]);
    runCombatT(
      bOnly,
      towers,
      [],
      2,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(towers.targetId[0]).toBe(2);
  });
});

describe('runCombat — point-level "first" (PRD: the creep most about to leak)', () => {
  // Two creeps in the SAME cell (7,6), both heading east to the waypoint (8,6) from
  // its centre — so they differ only by `progress` along one orthogonal edge. Their
  // occupied cell is identical, so cell-granularity targeting would tie them and fall
  // to the lower id; the PRD's weighted remaining route-distance orders them by which
  // is physically nearer the exit.
  const from = { x: cx(7), y: cy(6) };
  const eastPair = (
    rows: ReadonlyArray<{ id: number; hp: number; progress: number }>,
  ): CombatCreeps => ({
    id: rows.map((r) => r.id),
    hp: rows.map((r) => r.hp),
    bounty: rows.map(() => 1),
    speed: rows.map(() => 26),
    fromX: rows.map(() => from.x),
    fromY: rows.map(() => from.y),
    headCol: rows.map(() => 8),
    headRow: rows.map(() => 6),
    progress: rows.map((r) => r.progress),
    wave: rows.map(() => 0),
    creepId: rows.map(() => 'normal'),
    slowMulFp: rows.map(() => 0),
    slowUntilTick: rows.map(() => 0),
  });

  it('targets the creep further along a shared cell over a lower-id trailing creep', () => {
    // Higher-id creep 9 is further along (nearer the exit) than lower-id creep 1, so
    // "first" is 9 — sub-cell progress beats the id tie-break.
    const creeps = eastPair([
      { id: 1, hp: 100, progress: 40 },
      { id: 9, hp: 100, progress: 100 },
    ]);
    const towers = oneTower();
    runCombatT(
      creeps,
      towers,
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(towers.targetId[0]).toBe(9);
  });

  it('breaks a TRUE tie (identical progress in one cell) to the lower id', () => {
    // Same cell, same progress ⇒ genuinely equal remaining distance ⇒ lower id wins.
    const creeps = eastPair([
      { id: 9, hp: 100, progress: 70 },
      { id: 1, hp: 100, progress: 70 },
    ]);
    const towers = oneTower();
    runCombatT(
      creeps,
      towers,
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(towers.targetId[0]).toBe(1);
  });
});

describe('runCombat — fire cadence and no warm-up', () => {
  it('fires immediately (no warm-up), then not again until FIRE_INTERVAL elapses', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 10_000 }]); // never dies
    const towers = oneTower(); // nextFireTick 0 ⇒ may fire at tick 0
    let impacts: Impact[] = [];
    const fireTicks: number[] = [];
    for (let t = 0; t <= FIRE_INTERVAL; t++) {
      const r = runCombatT(
        creeps,
        towers,
        impacts,
        t,
        0,
        FIELD,
        GRID,
        TOWER_BY_ID,
        RULESET.balance.slowFloorNum,
        RULESET.balance.slowFloorDen,
      );
      // A fresh impact scheduled at t + TRAVEL_TICKS means the tower fired this tick.
      if (r.impacts.some((i) => i.impactTick === t + TRAVEL_TICKS)) fireTicks.push(t);
      impacts = r.impacts;
    }
    expect(fireTicks[0]).toBe(0); // fired at once — no placement warm-up
    expect(fireTicks).toContain(FIRE_INTERVAL); // and again exactly a cadence later
    expect(fireTicks.filter((t) => t > 0 && t < FIRE_INTERVAL)).toEqual([]); // silent cooldown
  });
});

describe("sellTower preserves survivors' cooldown and lock", () => {
  it("preserves a surviving tower's cooldown when another is sold", () => {
    // Regression guard: a sell that rebuilt the combat columns as fresh zeros
    // would reset a survivor's cooldown, letting it fire immediately. `targetId` is
    // re-derived by the combat phase every tick, so the quantity a sell must carry
    // by SOURCE ROW is the survivor's `nextFireTick` (its live cooldown).
    const s = createInitialState(1, RULESET);
    const place = (col: number, row: number): SimInput => ({
      kind: 'placeTower',
      anchor: { col, row },
      towerId: 'basic',
    });
    step(s, RULESET, [place(3, 3), place(9, 3)]);
    expect(s.towers.id).toHaveLength(2);
    const survivorId = s.towers.id[1] as number;

    // Put the survivor mid-cooldown, then sell the FIRST tower (index shifts down).
    s.towers.nextFireTick[1] = 12_345;
    const soldId = s.towers.id[0] as number;
    step(s, RULESET, [{ kind: 'sellTower', tower: soldId }]);

    expect(s.towers.id).toEqual([survivorId]);
    expect(s.towers.nextFireTick[0]).toBe(12_345); // cooldown carried through the sell
  });

  it('coerces ragged/forged tower combat columns through a sell (never persists null)', () => {
    const s = createInitialState(1, RULESET);
    const place = (col: number, row: number): SimInput => ({
      kind: 'placeTower',
      anchor: { col, row },
      towerId: 'basic',
    });
    step(s, RULESET, [place(3, 3), place(9, 3)]);
    // Forge a ragged SoA: the combat columns are shorter than id (missing entries).
    s.towers.targetId = [];
    s.towers.nextFireTick = [];
    step(s, RULESET, [{ kind: 'sellTower', tower: s.towers.id[0] as number }]);
    // The survivor's combat columns are safe integers, never undefined/null.
    expect(s.towers.targetId.every((v) => Number.isSafeInteger(v))).toBe(true);
    expect(s.towers.nextFireTick.every((v) => Number.isSafeInteger(v))).toBe(true);
    expect(JSON.stringify(s.towers)).not.toContain('null');
  });
});

// QC round-2: "a lethal hit applies no statuses" (m2.md, `applyImpactToCreep`'s own
// doc comment) had no direct witness. Every existing test that reaches PASS 2's
// death-gated branch observes it only through `runCombat`, which SWEEPS the killed
// row before its slow columns could be read — so reordering PASS 1/PASS 2 (statuses
// applied before the death check) or deleting the death gate entirely survives all
// of them. `applyImpactToCreep` is called directly here, on the row BEFORE any
// sweep, so its slow columns are still readable after the lethal call returns.
describe('applyImpactToCreep — a lethal hit applies no statuses (pinned before the sweep)', () => {
  it('a hit that kills the row leaves its slow columns untouched, even though the impact carries a slow effect', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 8 }]);
    const killedByImpact = new Set<number>();
    applyImpactToCreep(
      creeps,
      0,
      [
        { kind: 'direct', amount: 8 }, // exactly lethal
        { kind: 'slow', mulFp: 128, durationTicks: 30 },
      ],
      0,
      killedByImpact,
      {},
    );
    expect(creeps.hp[0]).toBeLessThanOrEqual(0);
    expect(killedByImpact.has(0)).toBe(true);
    expect(creeps.slowMulFp[0]).toBe(0); // PASS 2 never ran on the killed row
    expect(creeps.slowUntilTick[0]).toBe(0);
  });

  it('a NON-lethal hit still applies its slow — the guard is death-gated, not a blanket status skip', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 100 }]);
    const killedByImpact = new Set<number>();
    applyImpactToCreep(
      creeps,
      0,
      [
        { kind: 'direct', amount: 8 },
        { kind: 'slow', mulFp: 128, durationTicks: 30 },
      ],
      0,
      killedByImpact,
      {},
    );
    expect(creeps.hp[0]).toBeGreaterThan(0);
    expect(killedByImpact.has(0)).toBe(false);
    expect(creeps.slowMulFp[0]).toBe(128);
  });
});

// M2-S5a — flat armor on the `direct` primitive (`applyDirect`'s `max(0, amount -
// armor)`, resolved once per creep row via `runCombat`'s `creepById` param). All
// five cases go through `runCombat` itself (not a private `applyDirect` unit call —
// there is none exported), asserting the resulting hp as a NUMBER, never a hash
// (the done-criterion's own framing).
describe('runCombat — armor (M2-S5a)', () => {
  /** An armored creep def, appended to the catalog under a distinct id so the
   *  default 'normal' creep (armor 0) is untouched for every other test in this
   *  file. `hp` is generous — these tests assert per-hit damage, not a kill. */
  function armoredCreepDef(id: string, armor: number): CreepDef {
    return {
      id,
      hp: 1000,
      speedFp: 26,
      armor,
      domain: 'ground',
      immunities: [],
      leakCost: 1,
      bounty: 1,
    };
  }

  it("basic's damage 10 against armor 6 deals exactly 4 per hit (the done-criterion)", () => {
    const ARMOR_RULESET = testRuleset(
      { widthTiles: 14, heightTiles: 14, entrance: { col: 0, row: 6 }, exit: { col: 13, row: 6 } },
      { extraCreeps: [armoredCreepDef('armored6', 6)] },
    );
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    creeps.creepId[0] = 'armored6';
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }], // 10
    };
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      ARMOR_RULESET.creepById,
      ARMOR_RULESET.balance.slowFloorNum,
      ARMOR_RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.hp[0]).toBe(1000 - 4); // 10 - 6 armor = 4
  });

  it('armor at or above the incoming damage deals exactly 0 — the creep survives, provably', () => {
    const ARMOR_RULESET = testRuleset(
      { widthTiles: 14, heightTiles: 14, entrance: { col: 0, row: 6 }, exit: { col: 13, row: 6 } },
      { extraCreeps: [armoredCreepDef('armored16', 16)] }, // 16 ≥ DIRECT_DAMAGE (10)
    );
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    creeps.creepId[0] = 'armored16';
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
    };
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      ARMOR_RULESET.creepById,
      ARMOR_RULESET.balance.slowFloorNum,
      ARMOR_RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.hp[0]).toBe(1000); // fully blanked
    expect(result.creeps.hp[0]).toBeGreaterThan(0); // provably alive
    expect(result.creeps.id).toContain(1); // present among survivors, not swept
  });

  it('armor 0 leaves the existing unarmored path byte-identical to today', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]); // creepId 'normal', armor 0
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
    };
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.creepById,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.hp[0]).toBe(1000 - DIRECT_DAMAGE); // unarmored — no change
  });

  it("a blast's per-creep damage is armored the same way, for free (snapshotEffects collapses aoe → direct)", () => {
    const ARMOR_RULESET = testRuleset(
      { widthTiles: 14, heightTiles: 14, entrance: { col: 0, row: 6 }, exit: { col: 13, row: 6 } },
      { extraCreeps: [armoredCreepDef('armored6', 6)] },
    );
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    creeps.creepId[0] = 'armored6';
    const point = { x: cx(7), y: cy(6) };
    const impact: Impact = {
      kind: 'blast',
      impactTick: 0,
      x: point.x,
      y: point.y,
      radiusFp: 300,
      sourceId: 100,
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }], // 10, same as a splash's per-creep amount
    };
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      ARMOR_RULESET.creepById,
      ARMOR_RULESET.balance.slowFloorNum,
      ARMOR_RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.hp[0]).toBe(1000 - 4); // armored identically to a targeted hit
  });

  it("a creep whose creepId doesn't resolve in creepById takes unarmored damage rather than throwing (totality rail)", () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    creeps.creepId[0] = 'ghost-creep-id'; // absent from RULESET.creepById entirely
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
    };
    let result: ReturnType<typeof runCombat> | undefined;
    expect(() => {
      result = runCombat(
        creeps,
        emptyTowers(),
        [impact],
        [],
        0,
        0,
        FIELD,
        GRID,
        TOWER_BY_ID,
        RULESET.creepById,
        RULESET.balance.slowFloorNum,
        RULESET.balance.slowFloorDen,
      );
    }).not.toThrow();
    expect(result?.creeps.hp[0]).toBe(1000 - DIRECT_DAMAGE); // unarmored — the `?? 0` rail
  });
});

// M2-S5a P2 — the DoT STATE SHAPE, with NO behaviour: nothing here ticks, applies,
// or expires a DoT record (P3). `runCombat`'s `dots` param is canonicalized and
// returned unchanged — these tests pin that canonicalization exactly the way
// `combat.test.ts`'s existing forged-impact tests pin `canonicalImpacts`.
describe('DoT records — canonicalization rails (M2-S5a P2)', () => {
  const noTowers = emptyTowers();

  /** Run `runCombat` against a fixed one-creep world with no impacts — isolates
   *  the `dots` canonicalization rail under test from targeting/firing. */
  function runWithDots(dots: readonly unknown[]): ReturnType<typeof runCombat> {
    return runCombat(
      restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]),
      noTowers,
      [],
      dots,
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.creepById,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
  }

  const VALID: DotRecord = {
    targetId: 1,
    sourceId: 100,
    amount: 2,
    cadenceTicks: 10,
    nextTickTick: 10,
    untilTick: 60,
  };

  it('a well-formed record survives canonicalization to its exact shape, unchanged', () => {
    const result = runWithDots([VALID]);
    expect(result.dots).toEqual([VALID]);
  });

  it('a well-formed record with an unknown extra property is rebuilt to its exact canonical shape (never a spread — the property is dropped, not leaked)', () => {
    const forged = { ...VALID, extra: 'nope' };
    const result = runWithDots([forged]);
    expect(result.dots).toEqual([VALID]);
    expect(Object.keys(result.dots[0]!)).toEqual(Object.keys(VALID));
  });

  it('a battery of individually-forged records — non-safe/negative fields across every column, zero ids, cadenceTicks 0, untilTick < nextTickTick — each dropped with no unsafe arithmetic, mixed alongside well-formed entries that DO survive', () => {
    const other: DotRecord = { ...VALID, sourceId: 200 };
    const malformed: unknown[] = [
      { ...VALID, targetId: 0 }, // zero targetId — not an entity id
      { ...VALID, targetId: -1 }, // negative targetId
      { ...VALID, targetId: 1.5 }, // non-safe-integer targetId
      { ...VALID, sourceId: 0 }, // zero sourceId — not an entity id
      { ...VALID, sourceId: -1 }, // negative sourceId
      { ...VALID, sourceId: Number.MAX_SAFE_INTEGER + 1 }, // non-safe-integer sourceId
      { ...VALID, amount: 0 }, // amount must be ≥ 1
      { ...VALID, amount: -5 },
      { ...VALID, cadenceTicks: 0 }, // cadenceTicks must be ≥ 1
      { ...VALID, cadenceTicks: -1 },
      { ...VALID, nextTickTick: -1 }, // non-negative
      { ...VALID, untilTick: -1 },
      { ...VALID, nextTickTick: 60, untilTick: 10 }, // untilTick < nextTickTick — structurally forged
      null,
      42,
      'not a record',
      VALID, // well-formed — survives
      other, // well-formed, distinct pair — survives
    ];
    const result = runWithDots(malformed);
    expect(result.dots).toEqual([VALID, other]);
  });

  it("duplicate (targetId, sourceId) pairs deduplicate, keeping the FIRST occurrence (a canonical-form invariant, not applyDot's job)", () => {
    const first: DotRecord = { ...VALID, amount: 2, untilTick: 60 };
    const second: DotRecord = { ...VALID, amount: 999, untilTick: 999 }; // same pair — would win under last-wins
    const result = runWithDots([first, second]);
    expect(result.dots).toEqual([first]);
  });

  it('an over-cap array keeps only the first MAX_DOT_RECORDS valid records, in array order', () => {
    const many: DotRecord[] = Array.from({ length: MAX_DOT_RECORDS + 5 }, (_, i) => ({
      ...VALID,
      sourceId: i + 1, // distinct pairs — never deduplicated, so the cap alone is under test
    }));
    const result = runWithDots(many);
    expect(result.dots).toHaveLength(MAX_DOT_RECORDS);
    expect(result.dots).toEqual(many.slice(0, MAX_DOT_RECORDS));
  });

  it('a long all-invalid array is walked to completion without inspecting every entry (the raw-scan bound, 4× the record cap) — a pre-existing latent defect in canonicalImpacts, closed here in both functions', () => {
    // Every entry is individually invalid (amount 0), so `out.length` never reaches
    // MAX_DOT_RECORDS on its own — without the raw-scan bound this walk would still
    // terminate, but only after inspecting all 4×MAX_DOT_RECORDS+500 entries. The
    // bound's effect isn't independently observable from the OUTPUT (empty either
    // way); this test's job is to prove the call returns promptly on a hostile array
    // many times longer than any legitimate table could be.
    const allInvalid: unknown[] = new Array(4 * MAX_DOT_RECORDS + 500).fill({
      ...VALID,
      amount: 0,
    });
    const result = runWithDots(allInvalid);
    expect(result.dots).toEqual([]);
  });

  it("a non-array `dots` value coerces to an empty table through step()'s coerceSoa — never throws", () => {
    const s = createInitialState(1, RULESET);
    // @ts-expect-error forging a non-array onto SimState.dots — coerceSoa's job to repair
    s.dots = 42;
    expect(() => step(s, RULESET, [])).not.toThrow();
    expect(s.dots).toEqual([]);
  });
});

describe('Impact.sourceId — REQUIRED on both variants (M2-S5a P2)', () => {
  it('a targeted impact with a malformed sourceId (zero) is dropped whole — no damage, not kept', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    const impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 0, // malformed — 0 is not an entity id
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
    };
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.creepById,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.impacts).toHaveLength(0);
    expect(result.creeps.hp[0]).toBe(1000); // dropped whole — the effect never applied
  });

  it('a targeted impact with a non-safe-integer sourceId is dropped whole', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    const impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: -1,
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
    };
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.creepById,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.impacts).toHaveLength(0);
    expect(result.creeps.hp[0]).toBe(1000);
  });

  it('a blast impact with a malformed sourceId (zero) is dropped whole — no damage, not kept', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    const impact = {
      kind: 'blast',
      impactTick: 0,
      x: cx(7),
      y: cy(6),
      radiusFp: 50,
      sourceId: 0, // malformed
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
    };
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.creepById,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.impacts).toHaveLength(0);
    expect(result.creeps.hp[0]).toBe(1000);
  });

  it('a blast impact with a negative sourceId is dropped whole', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    const impact = {
      kind: 'blast',
      impactTick: 0,
      x: cx(7),
      y: cy(6),
      radiusFp: 50,
      sourceId: -5,
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
    };
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.creepById,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.impacts).toHaveLength(0);
    expect(result.creeps.hp[0]).toBe(1000);
  });
});

describe("EffectPrimitive's `dot` variant (M2-S5a P2: STATE SHAPE ONLY — a `dot` primitive that reaches applyImpactToCreep does nothing; applying it is P3)", () => {
  it('a valid dot primitive survives canonicalization with its exact fields and no extra properties', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    const impact = {
      kind: 'targeted',
      impactTick: 100, // future — stays in the kept queue unresolved, so its effects stay inspectable
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'dot', amount: 3, cadenceTicks: 10, durationTicks: 60, forged: 'nope' }],
    };
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.creepById,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.impacts).toHaveLength(1);
    expect(result.impacts[0]!.effects).toEqual([
      { kind: 'dot', amount: 3, cadenceTicks: 10, durationTicks: 60 },
    ]);
  });

  it('a dot primitive that reaches applyImpactToCreep (impact resolves this tick) applies NOTHING — no direct damage, no dots record, no crash (that is P3)', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    const impact = {
      kind: 'targeted',
      impactTick: 0, // resolves THIS tick
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'dot', amount: 3, cadenceTicks: 10, durationTicks: 60 }],
    };
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.creepById,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.hp[0]).toBe(1000); // no damage — 'dot' is neither 'direct' nor 'slow'
    expect(result.dots).toEqual([]); // no record appended — applyDot doesn't exist yet
    expect(result.impacts).toHaveLength(0); // resolved (consumed), not kept
  });

  it('an invalid dot primitive (durationTicks 0) makes the whole impact drop', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1000 }]);
    const impact = {
      kind: 'targeted',
      impactTick: 100,
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'dot', amount: 3, cadenceTicks: 10, durationTicks: 0 }],
    };
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      TOWER_BY_ID,
      RULESET.creepById,
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.impacts).toHaveLength(0);
  });
});
