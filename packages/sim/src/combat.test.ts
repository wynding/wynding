// combat.test.ts — Story 4 combat: scheduled-impact fire and resolution, wasted
// shots, inclusive range, sticky "first" targeting (hold vs re-acquire, tie-break),
// fire cadence with no warm-up, per-kill bounty, and sell-preserves-cooldown.

import { describe, it, expect } from 'vitest';
import { loadBoard, createInitialState, step, type BoardContext, type SimInput } from './index';
import type { TowerArrays } from './tower';
import {
  runCombat,
  RANGE,
  TRAVEL_TICKS,
  FIRE_INTERVAL,
  KILL_BOUNTY,
  DIRECT_DAMAGE,
  type CombatCreeps,
  type Impact,
} from './combat';

// A large open board so targeting geometry is clean; exit on the right at row 6.
const BOARD: BoardContext = loadBoard({
  widthTiles: 14,
  heightTiles: 14,
  entrance: { col: 0, row: 6 },
  exit: { col: 13, row: 6 },
});
const FIELD = BOARD.field;
const GRID = BOARD.grid;

/** One tower at (5,5); footprint centre = ((5+1)·256, (5+1)·256) = (1536,1536). */
function oneTower(targetId = 0, nextFireTick = 0): TowerArrays {
  return {
    id: [100],
    col: [5],
    row: [5],
    spend: [5],
    targetId: [targetId],
    nextFireTick: [nextFireTick],
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
    fromX: rows.map((r) => cx(r.col)),
    fromY: rows.map((r) => cy(r.row)),
    headCol: rows.map((r) => r.col),
    headRow: rows.map((r) => r.row),
    progress: rows.map(() => 0), // progress 0 (rest)
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
    fromX: [px],
    fromY: [py],
    headCol: [headCol],
    headRow: [row],
    progress: [0],
  };
}

describe('runCombat — fire, schedule, resolve, kill, bounty', () => {
  it('schedules an impact on the target and resolves it TRAVEL_TICKS later as a kill', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: DIRECT_DAMAGE }]); // in range
    const towers = oneTower();

    const t0 = runCombat(creeps, towers, [], 0, 0, FIELD, GRID);
    expect(t0.impacts).toHaveLength(1);
    expect(t0.impacts[0]?.impactTick).toBe(TRAVEL_TICKS);
    expect(t0.impacts[0]?.targetId).toBe(1);
    expect(towers.targetId[0]).toBe(1); // locked
    expect(towers.nextFireTick[0]).toBe(FIRE_INTERVAL); // cooldown set
    expect(t0.creeps.hp[0]).toBe(DIRECT_DAMAGE); // no damage yet (in flight)
    expect(t0.bounty).toBe(0);

    // Resolve at the impact tick: hp → 0, creep swept, bounty credited.
    const t4 = runCombat(t0.creeps, towers, t0.impacts, TRAVEL_TICKS, 0, FIELD, GRID);
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
    const t0 = runCombat(creeps, towers, [], 0, 0, FIELD, GRID);
    expect(t0.impacts[0]?.targetId).toBe(1);

    // Target 1 leaves play before the impact lands: drop it from the SoA.
    const withoutTarget: CombatCreeps = {
      id: [2],
      hp: [100],
      fromX: [cx(7)],
      fromY: [cy(7)],
      headCol: [7],
      headRow: [7],
      progress: [0],
    };
    const t4 = runCombat(withoutTarget, towers, t0.impacts, TRAVEL_TICKS, 0, FIELD, GRID);
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
    const inRangeResult = runCombat(onEdge, oneTower(), [], 0, 0, FIELD, GRID);
    expect(inRangeResult.impacts).toHaveLength(1); // inclusive — fired

    const beyond = creepAtPoint(1, 1536 + RANGE + 1, 1536, 10);
    const outResult = runCombat(beyond, oneTower(), [], 0, 0, FIELD, GRID);
    expect(outResult.impacts).toHaveLength(0); // one unit past the boundary — no target
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
    runCombat(creeps, towers, [], 0, 0, FIELD, GRID);
    expect(towers.targetId[0]).toBe(2);
  });

  it('HOLDS its locked target when a higher-priority creep enters, then re-acquires when it leaves', () => {
    // Acquire creep A (id 1) at col 7 alone.
    const towers = oneTower();
    const aOnly = restingCreeps([{ id: 1, col: 7, row: 6, hp: 100 }]);
    runCombat(aOnly, towers, [], 0, 0, FIELD, GRID);
    expect(towers.targetId[0]).toBe(1);

    // A HIGHER-priority creep B (id 2, nearer the exit ⇒ smaller route distance)
    // enters — the lock HOLDS on A and never swaps to the higher priority.
    const bothPresent = restingCreeps([
      { id: 1, col: 7, row: 6, hp: 100 },
      { id: 2, col: 9, row: 6, hp: 100 }, // nearer the exit — would win a fresh acquire
    ]);
    runCombat(bothPresent, towers, [], 1, 0, FIELD, GRID);
    expect(towers.targetId[0]).toBe(1); // did NOT swap to the higher-priority creep

    // A leaves play — the tower re-acquires the remaining in-range creep B.
    const bOnly = restingCreeps([{ id: 2, col: 9, row: 6, hp: 100 }]);
    runCombat(bOnly, towers, [], 2, 0, FIELD, GRID);
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
    fromX: rows.map(() => from.x),
    fromY: rows.map(() => from.y),
    headCol: rows.map(() => 8),
    headRow: rows.map(() => 6),
    progress: rows.map((r) => r.progress),
  });

  it('targets the creep further along a shared cell over a lower-id trailing creep', () => {
    // Higher-id creep 9 is further along (nearer the exit) than lower-id creep 1, so
    // "first" is 9 — sub-cell progress beats the id tie-break.
    const creeps = eastPair([
      { id: 1, hp: 100, progress: 40 },
      { id: 9, hp: 100, progress: 100 },
    ]);
    const towers = oneTower();
    runCombat(creeps, towers, [], 0, 0, FIELD, GRID);
    expect(towers.targetId[0]).toBe(9);
  });

  it('breaks a TRUE tie (identical progress in one cell) to the lower id', () => {
    // Same cell, same progress ⇒ genuinely equal remaining distance ⇒ lower id wins.
    const creeps = eastPair([
      { id: 9, hp: 100, progress: 70 },
      { id: 1, hp: 100, progress: 70 },
    ]);
    const towers = oneTower();
    runCombat(creeps, towers, [], 0, 0, FIELD, GRID);
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
      const r = runCombat(creeps, towers, impacts, t, 0, FIELD, GRID);
      // A fresh impact scheduled at t + TRAVEL_TICKS means the tower fired this tick.
      if (r.impacts.some((i) => i.impactTick === t + TRAVEL_TICKS)) fireTicks.push(t);
      impacts = r.impacts;
    }
    expect(fireTicks[0]).toBe(0); // fired at once — no placement warm-up
    expect(fireTicks).toContain(FIRE_INTERVAL); // and again exactly a cadence later
    expect(fireTicks.filter((t) => t > 0 && t < FIRE_INTERVAL)).toEqual([]); // silent cooldown
  });
});

describe("sellTower preserves survivors' cooldown and lock (Codex R1 #4)", () => {
  it("preserves a surviving tower's cooldown when another is sold", () => {
    // The bug R1 #4 fixes: a sell that rebuilt the combat columns as fresh zeros
    // would reset a survivor's cooldown, letting it fire immediately. `targetId` is
    // re-derived by the combat phase every tick, so the quantity a sell must carry
    // by SOURCE ROW is the survivor's `nextFireTick` (its live cooldown).
    const s = createInitialState(1);
    const place = (col: number, row: number): SimInput => ({
      kind: 'placeTower',
      anchor: { col, row },
    });
    step(s, [place(3, 3), place(9, 3)], BOARD);
    expect(s.towers.id).toHaveLength(2);
    const survivorId = s.towers.id[1] as number;

    // Put the survivor mid-cooldown, then sell the FIRST tower (index shifts down).
    s.towers.nextFireTick[1] = 12_345;
    const soldId = s.towers.id[0] as number;
    step(s, [{ kind: 'sellTower', tower: soldId }], BOARD);

    expect(s.towers.id).toEqual([survivorId]);
    expect(s.towers.nextFireTick[0]).toBe(12_345); // cooldown carried through the sell
  });

  it('coerces ragged/forged tower combat columns through a sell (never persists null)', () => {
    const s = createInitialState(1);
    const place = (col: number, row: number): SimInput => ({
      kind: 'placeTower',
      anchor: { col, row },
    });
    step(s, [place(3, 3), place(9, 3)], BOARD);
    // Forge a ragged SoA: the combat columns are shorter than id (missing entries).
    s.towers.targetId = [];
    s.towers.nextFireTick = [];
    step(s, [{ kind: 'sellTower', tower: s.towers.id[0] as number }], BOARD);
    // The survivor's combat columns are safe integers, never undefined/null.
    expect(s.towers.targetId.every((v) => Number.isSafeInteger(v))).toBe(true);
    expect(s.towers.nextFireTick.every((v) => Number.isSafeInteger(v))).toBe(true);
    expect(JSON.stringify(s.towers)).not.toContain('null');
  });
});
