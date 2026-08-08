// story-burst.test.ts — M2 Story 9 P3: the burst fire path and its CONSUMPTION. A
// burst tower (`mine`) fires exactly once, centres its blast on its own footprint
// (never on a creep — `predictBlastPoint` is skipped entirely), and its SoA row is
// deleted at that same fire tick so the maze re-routes from the next movement step.
// Mirrors `story-aoe.test.ts`'s structure and voice for the fixture/helper style.
// The content story goldens (the shipped `mine` tower) are packet P6's — this file
// is SIM-level behaviour only, built on `test-support.ts`'s `TEST_BURST_TOWER`.

import { describe, it, expect } from 'vitest';
import { FP_ONE } from '@wynding/engine';
import { MAX_IN_FLIGHT_IMPACTS, type CombatCreeps, type Impact } from './combat';
import { emptyTowers, materializeTowerMask, type TowerArrays } from './tower';
import { computeDistanceField } from './pathfinding';
import { testRuleset, runCombatT, pushCreep, TEST_BURST_TOWER, TEST_TOWER } from './test-support';
import { createInitialState, step, hashSimState, type SimInput, type SimState } from './index';
import { advanceCreep, deriveValidCreepPosition } from './movement';
import { effectiveSpeedFp } from './ruleset-shared';

const LANE = {
  widthTiles: 14,
  heightTiles: 14,
  entrance: { col: 0, row: 6 },
  exit: { col: 13, row: 6 },
} as const;

const cx = (col: number): number => col * FP_ONE + FP_ONE / 2;
const cy = (row: number): number => row * FP_ONE + FP_ONE / 2;

/** The 2×2 footprint centre for an anchor — the shared corner of its four cells,
 *  same formula `runCombat` itself uses (combat.ts). */
const footprintCenter = (col: number, row: number): { x: number; y: number } => ({
  x: (col + 1) * FP_ONE,
  y: (row + 1) * FP_ONE,
});

const RULESET = testRuleset(LANE, { extraTowers: [TEST_BURST_TOWER] });
const FIELD = RULESET.board.field;
const GRID = RULESET.board.grid;
const SF_NUM = RULESET.balance.slowFloorNum;
const SF_DEN = RULESET.balance.slowFloorDen;

const RANGE_FP = TEST_BURST_TOWER.attack!.rangeFp;
const TRAVEL_TICKS = TEST_BURST_TOWER.attack!.travelTicks;

/** Build a raw tower SoA from row descriptors — mirrors `story-aoe.test.ts`'s
 *  `aoeTower()`, generalized to several rows of either catalog kind. */
function buildTowers(
  rows: ReadonlyArray<{
    readonly id: number;
    readonly col: number;
    readonly row: number;
    readonly towerId: 'mine' | 'basic';
    readonly targetId?: number;
    readonly nextFireTick?: number;
  }>,
): TowerArrays {
  const towers = emptyTowers();
  for (const r of rows) {
    towers.id.push(r.id);
    towers.col.push(r.col);
    towers.row.push(r.row);
    towers.spend.push(r.towerId === 'mine' ? TEST_BURST_TOWER.cost : TEST_TOWER.cost);
    towers.targetId.push(r.targetId ?? 0);
    towers.nextFireTick.push(r.nextFireTick ?? 0);
    towers.towerId.push(r.towerId);
  }
  return towers;
}

/** Build a resting-creeps SoA from `(id, col, row, hp)` rows — mirrors
 *  `story-aoe.test.ts`'s `restingCreeps`. */
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
    progress: rows.map(() => 0),
    wave: rows.map(() => 0),
    creepId: rows.map(() => 'normal'),
    slowMulFp: rows.map(() => 0),
    slowUntilTick: rows.map(() => 0),
    stunUntilTick: rows.map(() => 0),
  };
}

/** A creep whose DERIVED point is exactly `(px,py)` — a progress-0 transitional
 *  row (mirrors `story-aoe.test.ts`'s `creepAtPoint`), used for boundary points
 *  that don't land on a cell centre. */
function creepAtPoint(id: number, px: number, py: number, hp: number, speed = 26): CombatCreeps {
  const col = Math.floor(px / FP_ONE);
  const row = Math.floor(py / FP_ONE);
  const headCol = col + 1 <= 13 ? col + 1 : col - 1;
  return {
    id: [id],
    hp: [hp],
    bounty: [1],
    speed: [speed],
    fromX: [px],
    fromY: [py],
    headCol: [headCol],
    headRow: [row],
    progress: [0],
    wave: [0],
    creepId: ['normal'],
    slowMulFp: [0],
    slowUntilTick: [0],
    stunUntilTick: [0],
  };
}

describe('the row is deleted at the fire tick', () => {
  it('a mine that trips fires and its row is gone from the returned towers in the SAME phase', () => {
    const towers = buildTowers([{ id: 100, col: 1, row: 1, towerId: 'mine' }]);
    const mineCenter = footprintCenter(1, 1);
    // Well within RANGE_FP of the mine's own footprint centre.
    const creeps = restingCreeps([{ id: 1, col: 2, row: 2, hp: 100 }]);
    const result = runCombatT(
      creeps,
      towers,
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
    );
    expect(result.towers.id).toHaveLength(0); // the mine's row is gone
    expect(result.impacts).toHaveLength(1); // it fired — resident until impactTick
    const imp = result.impacts[0]!;
    expect(imp.sourceId).toBe(100);
    expect(imp.kind).toBe('blast');
    if (imp.kind === 'blast') {
      expect(imp.x).toBe(mineCenter.x);
      expect(imp.y).toBe(mineCenter.y);
    }
  });
});

describe('combat columns are carried by source row through the compaction', () => {
  it('a consumption never resets a survivor’s target lock or cooldown — mirrors sellTower’s own invariant', () => {
    const HELD_B = 501;
    const HELD_C = 502;
    const NEXT_FIRE_B = 12_345; // far past any tick this test runs, so tower B never fires
    const NEXT_FIRE_C = 6_789; // distinct from B's, so a swap between rows is observable
    const towers = buildTowers([
      { id: 100, col: 1, row: 1, towerId: 'mine' },
      { id: 200, col: 5, row: 5, towerId: 'basic', targetId: HELD_B, nextFireTick: NEXT_FIRE_B },
      { id: 300, col: 9, row: 9, towerId: 'basic', targetId: HELD_C, nextFireTick: NEXT_FIRE_C },
    ]);
    const creeps = restingCreeps([
      { id: 1, col: 2, row: 2, hp: 100 }, // trips the mine
      { id: HELD_B, col: 6, row: 6, hp: 100 }, // held by tower B, in its range
      { id: HELD_C, col: 10, row: 10, hp: 100 }, // held by tower C, in its range
    ]);
    const result = runCombatT(
      creeps,
      towers,
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
    );
    // The mine's row is gone; B and C survive, in their ORIGINAL source-row order.
    expect(result.towers.id).toEqual([200, 300]);
    expect(result.towers.targetId).toEqual([HELD_B, HELD_C]);
    expect(result.towers.nextFireTick).toEqual([NEXT_FIRE_B, NEXT_FIRE_C]);
  });
});

describe('the blast is centred on the mine, not on the creep', () => {
  it('a moving creep whose predicted lead point genuinely differs from the mine centre still lands the blast on the mine', () => {
    const towers = buildTowers([{ id: 100, col: 5, row: 5, towerId: 'mine' }]);
    const mineCenter = footprintCenter(5, 5);
    const SPEED = 300; // one tick's budget vastly exceeds sub-cell rounding
    const creeps = restingCreeps([{ id: 1, col: 6, row: 6, hp: 10_000 }]);
    creeps.speed[0] = SPEED;

    const result = runCombatT(
      creeps,
      towers,
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
    );
    expect(result.impacts).toHaveLength(1);
    const imp = result.impacts[0]!;
    if (imp.kind !== 'blast') throw new Error('expected a blast impact');

    // Independently recompute what `predictBlastPoint` WOULD have produced, via the
    // same public seam it is documented to use (effectiveSpeedFp then advanceCreep) —
    // mirrors story-aoe.test.ts's slowed-lead-point test.
    const budget = TRAVEL_TICKS * effectiveSpeedFp(SPEED, 0, SF_NUM, SF_DEN);
    // headCol/headRow are the fixture's OWN (`restingCreeps` sets them to the creep's
    // cell), so this advances from the same row `predictBlastPoint` would read.
    const outcome = advanceCreep(FIELD, 1, 10_000, cx(6), cy(6), 6, 6, 0, budget, 'ground');
    let leadX: number;
    let leadY: number;
    if (outcome.kind === 'move') {
      const geom = deriveValidCreepPosition(
        outcome.fromX,
        outcome.fromY,
        outcome.headCol,
        outcome.headRow,
        outcome.progress,
        GRID,
      );
      if (geom === null) throw new Error('expected a valid derived position');
      leadX = geom.point.x;
      leadY = geom.point.y;
    } else if (outcome.kind === 'leak') {
      leadX = FIELD.exit.col * FP_ONE + FP_ONE / 2;
      leadY = FIELD.exit.row * FP_ONE + FP_ONE / 2;
    } else {
      throw new Error('expected a move or leak outcome, not drop');
    }
    // The scenario is vacuous unless these two points genuinely differ.
    expect(leadX !== mineCenter.x || leadY !== mineCenter.y).toBe(true);
    expect(imp.x).toBe(mineCenter.x);
    expect(imp.y).toBe(mineCenter.y);
    expect(imp.x).not.toBe(leadX);
  });
});

describe('a forged mine row carrying a nonzero nextFireTick is not permanently inert', () => {
  it('the meaningless column is normalized rather than read — the mine still fires and is still consumed', () => {
    // `nextFireTick` has no meaning for a burst tower: it never fires twice, so nothing
    // legitimate writes the column for one (`placeTower` pushes 0). But `coerceSoa`'s
    // `safeCombatColumn` admits ANY safe integer, and `step()` is exported with forged
    // state in scope (ADR 0006 §4). Before this was normalized, such a row failed the
    // fireability test forever — a mine that could neither fire NOR be consumed, an inert
    // wall, with the meaningless value resident in the world hash for the whole match.
    // Same class the support arm closes by zeroing both of its columns; burst is the
    // second discipline for which this one is meaningless. (ship-review, M2-S9.)
    const FORGED = 1_000_000_000;
    const towers = buildTowers([
      { id: 100, col: 1, row: 1, towerId: 'mine', nextFireTick: FORGED },
    ]);
    const creeps = restingCreeps([{ id: 1, col: 2, row: 2, hp: 100 }]);
    const result = runCombatT(
      creeps,
      towers,
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
    );
    expect(result.towers.id).toHaveLength(0); // consumed, not stuck armed forever
    expect(result.impacts).toHaveLength(1); // and it really did fire
    // A CADENCED tower's cooldown is still honoured — the normalization is scoped to the
    // discipline that has no use for the column, not applied to every tower.
    const cadenced = buildTowers([
      { id: 200, col: 5, row: 5, towerId: 'basic', nextFireTick: FORGED },
    ]);
    const cadencedResult = runCombatT(
      restingCreeps([{ id: 1, col: 6, row: 6, hp: 100 }]),
      cadenced,
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
    );
    expect(cadencedResult.impacts).toHaveLength(0); // still on cooldown
    expect(cadencedResult.towers.nextFireTick).toEqual([FORGED]); // and untouched
  });

  it('the column is cleared even when NO creep is in range — the hash-residency half', () => {
    // The normalization is unconditional, above target selection, so a mine standing on a
    // lane nothing ever approaches still has its meaningless column cleared. Gating it
    // behind "a creep is in the trigger ring" would fix the inert-wall half and leave the
    // forged value resident in every tick's world hash for the whole match — the exact
    // residency the support arm zeroes unconditionally to avoid. (Fable stand-in review,
    // PR #90: the normalization originally sat below the `targetLive === null` return.)
    const towers = buildTowers([
      { id: 100, col: 1, row: 1, towerId: 'mine', nextFireTick: 1_000_000_000 },
    ]);
    const result = runCombatT(
      restingCreeps([{ id: 1, col: 11, row: 11, hp: 100 }]), // far outside the 576 fp trigger
      towers,
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
    );
    expect(result.impacts).toHaveLength(0); // nothing in range — it did NOT fire
    expect(result.towers.id).toEqual([100]); // still standing, still armed
    expect(result.towers.nextFireTick).toEqual([0]); // but the dead value is gone
  });
});

describe('no mine placed ⇒ the identical towers reference is returned', () => {
  it('object identity, not toEqual — the zero-added-cost guarantee', () => {
    const towers = buildTowers([{ id: 1, col: 3, row: 3, towerId: 'basic' }]);
    const result = runCombatT(
      restingCreeps([]),
      towers,
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
    );
    expect(result.towers).toBe(towers);
  });
});

describe('MAX_IN_FLIGHT_IMPACTS full ⇒ the mine neither fires nor is consumed', () => {
  it('a capped queue leaves the mine unfired and its row intact, to retry next tick', () => {
    const towers = buildTowers([{ id: 999, col: 1, row: 1, towerId: 'mine' }]);
    const creeps = restingCreeps([{ id: 1, col: 2, row: 2, hp: 100 }]);
    // Fill the queue with MAX_IN_FLIGHT_IMPACTS not-yet-due filler impacts.
    const filler: Impact[] = Array.from({ length: MAX_IN_FLIGHT_IMPACTS }, () => ({
      kind: 'targeted',
      impactTick: 100_000,
      targetId: 1,
      sourceId: 1,
      domain: 'ground',
      effects: [{ kind: 'direct', amount: 1 }],
    }));
    const result = runCombatT(
      creeps,
      towers,
      filler,
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
    );
    expect(result.impacts).toHaveLength(MAX_IN_FLIGHT_IMPACTS); // no new shot added
    expect(result.towers.id).toEqual([999]); // the mine's row survives, unconsumed
  });
});

describe('several mines tripping on one tick', () => {
  it('all fire that tick, all land at T + travelTicks, all their rows are dropped, in SoA order', () => {
    const towers = buildTowers([
      { id: 10, col: 1, row: 1, towerId: 'mine' },
      { id: 20, col: 5, row: 5, towerId: 'mine' },
      { id: 30, col: 9, row: 9, towerId: 'mine' },
    ]);
    const creeps = restingCreeps([
      { id: 1, col: 2, row: 2, hp: 100 },
      { id: 2, col: 6, row: 6, hp: 100 },
      { id: 3, col: 10, row: 10, hp: 100 },
    ]);
    const T = 7;
    const result = runCombatT(
      creeps,
      towers,
      [],
      T,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
    );
    expect(result.towers.id).toHaveLength(0); // all three rows dropped
    expect(result.impacts).toHaveLength(3);
    // Deterministic order matching SoA row order (10, 20, 30) — never re-sorted.
    expect(result.impacts.map((imp) => imp.sourceId)).toEqual([10, 20, 30]);
    for (const imp of result.impacts) {
      expect(imp.impactTick).toBe(T + TRAVEL_TICKS);
    }
  });
});

describe('one routing snapshot per tick — a tower firing LATER in the same combat phase still reads PRE-consumption distances', () => {
  // m2.md's pinned tick-level contract: the routing field is derived ONCE per tick,
  // before movement (`index.ts`), and a mid-combat-phase consumption never re-derives it.
  // `live[].dist` is likewise precomputed once, at step (4), so nothing SHORT of
  // deliberate sabotage re-derives mid-phase — which is exactly why the contract needs a
  // witness rather than a shrug: an invariant that holds by construction still holds only
  // until someone re-constructs it, and this is the test that would notice.
  //
  // The scene makes the difference OBSERVABLE. A partial wall at cols 8-9 (rows 2..7)
  // plugged at rows 8-9 by a mine leaves rows 10-12 permanently open, so nothing is ever
  // stranded — the mine is a SHORTCUT, not a plug. Consuming it opens that shortcut and
  // INVERTS the route-distance order of two creeps: `NEAR_DOOR` is the farther of the two
  // while the mine stands and the nearer once it is gone. An observer tower in range of
  // both, sitting at a HIGHER SoA row index than the mine (so `forEachValidTower` visits
  // it after the consumption is recorded), acquires "the in-range creep nearest the exit".
  // Which creep it locks is therefore a direct readout of WHICH field it read.
  const WALL_ANCHORS = [
    { col: 8, row: 2 },
    { col: 8, row: 4 },
    { col: 8, row: 6 },
  ] as const;
  const MINE_DOOR = { col: 8, row: 8 } as const;
  const OBSERVER = { col: 4, row: 8 } as const;
  const NEAR_DOOR = { col: 7, row: 8 } as const; // behind the door: 108 → 68 when it opens
  const LONG_WAY = { col: 7, row: 10 } as const; // already past it:   88 → 76

  it('the observer locks the creep that was nearest under the PRE-consumption field, not the post-consumption one', () => {
    const towers = buildTowers([
      ...WALL_ANCHORS.map((a, k) => ({
        id: 10 + k,
        col: a.col,
        row: a.row,
        towerId: 'basic' as const,
      })),
      { id: 90, col: MINE_DOOR.col, row: MINE_DOOR.row, towerId: 'mine' as const },
      // LAST row index — `forEachValidTower` walks in index order, so this tower is
      // visited AFTER the mine has already been recorded as consumed this phase.
      { id: 99, col: OBSERVER.col, row: OBSERVER.row, towerId: 'basic' as const },
    ]);

    // Both fields, derived here the way `step()` derives its one-per-tick snapshot
    // (`index.ts`: mask from the CURRENT tower SoA, then `computeDistanceField`). The
    // rest of this file passes the bare board field, which is right for scenes whose
    // towers never change the route — here the wall IS the route, so the field must come
    // from the SoA or the scene would silently be a different one. The sabotage this test
    // exists to catch would make the sim read `postField`, so the test knows both rather
    // than trusting either.
    const fieldFor = (t: TowerArrays): ReturnType<typeof computeDistanceField> =>
      computeDistanceField(GRID, materializeTowerMask(GRID, t, RULESET.towerById));
    const distAtCell = (t: TowerArrays, cell: { col: number; row: number }): number =>
      fieldFor(t).dist[cell.row * GRID.width + cell.col]!;
    const standing = towers;
    const consumedSoa = buildTowers([
      ...WALL_ANCHORS.map((a, k) => ({
        id: 10 + k,
        col: a.col,
        row: a.row,
        towerId: 'basic' as const,
      })),
      { id: 99, col: OBSERVER.col, row: OBSERVER.row, towerId: 'basic' as const },
    ]);
    const nearPre = distAtCell(standing, NEAR_DOOR);
    const nearPost = distAtCell(consumedSoa, NEAR_DOOR);
    const longPre = distAtCell(standing, LONG_WAY);
    const longPost = distAtCell(consumedSoa, LONG_WAY);
    // The scene is VACUOUS unless the order genuinely inverts — assert that first, so a
    // future board tweak that flattens the difference fails here loudly rather than
    // leaving a green test that can no longer tell the two fields apart.
    expect(nearPre).toBeGreaterThan(longPre); // mine standing → LONG_WAY is nearer the exit
    expect(nearPost).toBeLessThan(longPost); // mine gone     → NEAR_DOOR is nearer

    const creeps = restingCreeps([
      { id: 1, col: NEAR_DOOR.col, row: NEAR_DOOR.row, hp: 1000 },
      { id: 2, col: LONG_WAY.col, row: LONG_WAY.row, hp: 1000 },
    ]);
    const result = runCombatT(
      creeps,
      towers,
      [],
      0,
      0,
      fieldFor(standing), // the ONE snapshot this tick was derived from — mine still standing
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
    );

    // Mid-trace proof the feature engaged: the mine really was consumed THIS phase, so
    // the observer genuinely ran after a consumption rather than in an ordinary tick.
    expect(result.towers.id).not.toContain(90);
    const observerRow = result.towers.id.indexOf(99);
    expect(observerRow).toBeGreaterThanOrEqual(0);

    // THE ASSERTION: creep 2 (`LONG_WAY`) was nearest under the field this tick was
    // derived from, and stays the lock even though the consumption has already made
    // creep 1 nearer in the maze that the NEXT tick will derive.
    expect(result.towers.targetId[observerRow]).toBe(2);
  });
});

describe('the inRange trigger boundary is inclusive', () => {
  it('a creep at exactly rangeFp trips it; one fp unit further does not', () => {
    const center = footprintCenter(1, 1);

    const towersOn = buildTowers([{ id: 500, col: 1, row: 1, towerId: 'mine' }]);
    const onBoundary = creepAtPoint(1, center.x + RANGE_FP, center.y, 100);
    const onResult = runCombatT(
      onBoundary,
      towersOn,
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
    );
    expect(onResult.towers.id).toHaveLength(0); // tripped and consumed
    expect(onResult.impacts).toHaveLength(1);

    const towersBeyond = buildTowers([{ id: 500, col: 1, row: 1, towerId: 'mine' }]);
    const beyond = creepAtPoint(1, center.x + RANGE_FP + 1, center.y, 100);
    const beyondResult = runCombatT(
      beyond,
      towersBeyond,
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
    );
    expect(beyondResult.towers.id).toEqual([500]); // never triggered, row intact
    expect(beyondResult.impacts).toHaveLength(0);
  });
});

describe('a consumption survives a cold serialize/restore', () => {
  // The project's standing determinism contract is that everything derived from the SoA
  // is recomputed on demand, "so a cold serialize/restore reproduces identical behavior
  // with no ambient/cache state" (`tower.ts`'s header). Burst is the first mechanic since
  // DoT that REWRITES the tower SoA mid-run, and the tick where it does is structurally
  // novel: the row is gone while its discharge is still in flight, so the state carries a
  // resident impact whose source tower no longer exists.
  //
  // Nothing witnessed a restore straddling that tick. `determinism.test.ts`'s round-trip
  // runs the canonical scenario, which places no mine (deliberately — its GOLDEN must stay
  // byte-identical across this story, which is the evidence that sv13 changed nothing for
  // existing content), and every other burst test stops at `runCombat`. Found by the Fable
  // stand-in review of PR #90; fixed here rather than by widening the canonical scenario,
  // which would have moved the GOLDEN for a reason unrelated to behaviour (Rob's call,
  // 2026-08-07).
  const SEED = 0x5eed;
  const MINE_ANCHOR = { col: 1, row: 1 } as const;
  const TICKS = 40;

  /** Drive the full `step()` path with a mine placed at tick 0 and one ground creep set
   *  down inside its trigger ring, returning the per-tick world hashes and end state.
   *  `roundTripAt` JSON round-trips the state after that tick's step — the resume seam
   *  `determinism.test.ts` exercises, here made to straddle the consumption. */
  function run(roundTripAt: number | null): { trace: string[]; state: SimState } {
    let state = createInitialState(SEED, RULESET);
    const trace: string[] = [];
    for (let t = 0; t < TICKS; t++) {
      const inputs: SimInput[] =
        t === 0 ? [{ kind: 'placeTower', anchor: { ...MINE_ANCHOR }, towerId: 'mine' }] : [];
      state = step(state, RULESET, inputs);
      // Set the creep down AFTER tick 0's step, so the mine is standing first (placement
      // refuses a footprint a ground creep occupies), and inside the trigger ring, so the
      // trip tick is deterministic without waiting on the wave schedule. Cell (3,3) sits
      // OUTSIDE the mine's own 2×2 footprint — anchor (1,1) covers cells (1,1)..(2,2), and
      // a creep standing on a tower's blocked cell is simply dropped by movement — while
      // still inside it: 543 fp from the footprint centre against a 576 fp trigger.
      if (t === 0) pushCreep(state, { id: 9001, hp: 100, col: 3, row: 3 });
      if (t === roundTripAt) state = JSON.parse(JSON.stringify(state)) as SimState;
      trace.push(hashSimState(state));
    }
    return { trace, state };
  }

  it('restoring at the fire tick — row gone, discharge still in flight — resumes byte-identically', () => {
    const ref = run(null);

    // Mid-trace proof the scenario reaches the state under test, BEFORE comparing tails:
    // find the tick the mine's row actually disappears by replaying the same script.
    let probe = createInitialState(SEED, RULESET);
    let fireTick = -1;
    let hadRow = false;
    for (let t = 0; t < TICKS && fireTick === -1; t++) {
      const inputs: SimInput[] =
        t === 0 ? [{ kind: 'placeTower', anchor: { ...MINE_ANCHOR }, towerId: 'mine' }] : [];
      probe = step(probe, RULESET, inputs);
      if (t === 0) pushCreep(probe, { id: 9001, hp: 100, col: 3, row: 3 });
      const hasRow = probe.towers.id.length > 0;
      if (hadRow && !hasRow) fireTick = t;
      hadRow = hasRow;
    }
    expect(fireTick).toBeGreaterThan(0); // it really was consumed, not merely never placed
    // …and at that tick the discharge is resident with no tower behind it — the shape
    // that makes this round-trip worth pinning rather than an ordinary resume.
    expect(probe.towers.id).toHaveLength(0);
    expect(probe.impacts.length).toBeGreaterThan(0);

    const resumed = run(fireTick);
    // The WHOLE tail, not just the final hash — a matching end state could otherwise mask
    // a diverge-then-reconverge, the same reasoning `determinism.test.ts`'s resume test
    // gives for comparing traces rather than endpoints.
    expect(resumed.trace).toEqual(ref.trace);
    expect(JSON.stringify(resumed.state)).toBe(JSON.stringify(ref.state));
  });
});
