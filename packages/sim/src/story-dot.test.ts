// story-dot.test.ts — M2 Story 5a: DoT application, ticking, and expiry (P3).
// Mirrors `story-slow.test.ts`'s structure and voice for the `dot` status effect:
// the tick-by-tick schedule, armor bypass, per-source independence, the refresh
// rule (including the same-tick refresh-then-fire ordering), the sold-source
// rule's both halves, lethal-hit suppression, kill-bounty credit, the record cap,
// creep-id traversal order, and a determinism witness taken while records are
// LIVE. `combat.test.ts` already pins every one of these at the primitive level
// (`applyDot`, the tick step, in isolation); this file re-pins them at the STORY
// level — through the catalog `venom`-shaped tower and, where it matters (the
// sold-source rule, the determinism witness), through real `step()` play — the
// same relationship `story-slow.test.ts` already has to `combat.test.ts`'s own
// slow-stacking tests.

import { describe, it, expect } from 'vitest';
import { createInitialState, step, hashSimState, type SimInput, type SimState } from './index';
import {
  runCombat,
  MAX_DOT_RECORDS,
  type CombatCreeps,
  type DotRecord,
  type Impact,
} from './combat';
import { emptyTowers } from './tower';
import { testRuleset, pushCreep, TEST_DOT_TOWER } from './test-support';
import type { CreepDef } from '@wynding/types';

const LANE = {
  widthTiles: 14,
  heightTiles: 14,
  entrance: { col: 0, row: 6 },
  exit: { col: 13, row: 6 },
} as const;

const cx = (col: number): number => col * 256 + 128;
const cy = (row: number): number => row * 256 + 128;

// The venom-shaped dot effect's magnitude/cadence/duration, pulled from
// TEST_DOT_TOWER itself (never hardcoded independently, mirroring
// story-slow.test.ts's own `slowEffect`/`attack` extraction) so a test-fixture
// edit moves every test in this file along with it.
const DOT_EFFECT = TEST_DOT_TOWER.effects.find((e) => e.kind === 'dot');
if (DOT_EFFECT?.kind !== 'dot') throw new Error('TEST_DOT_TOWER must carry a dot effect');
const AMOUNT = DOT_EFFECT.damagePerTick; // 2
const CADENCE = DOT_EFFECT.cadenceTicks; // 10
const DURATION = DOT_EFFECT.durationTicks; // 60

const RULESET = testRuleset(LANE, { extraTowers: [TEST_DOT_TOWER] });
const FIELD = RULESET.board.field;
const GRID = RULESET.board.grid;
const FLOOR_NUM = RULESET.balance.slowFloorNum;
const FLOOR_DEN = RULESET.balance.slowFloorDen;

/** Build a resting creep SoA from row descriptors — id/col/row/hp, optional bounty
 *  (default 1), always unarmored/'normal' unless the caller overwrites `creepId`
 *  afterward. Mirrors `combat.test.ts`'s own `restingCreeps` helper. */
function restingCreeps(
  rows: ReadonlyArray<{ id: number; col: number; row: number; hp: number; bounty?: number }>,
): CombatCreeps {
  return {
    id: rows.map((r) => r.id),
    hp: rows.map((r) => r.hp),
    bounty: rows.map((r) => r.bounty ?? 1),
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
  };
}

describe('the schedule — applied at T, ticks at T+10, T+20 … T+60, never at T, expiry inclusive at T+60', () => {
  it('deals the exact per-tick magnitude on the T+10 lattice and nowhere else, then the record is gone from T+60 onward', () => {
    const T = 5;
    const startHp = 1_000_000;
    let creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: startHp }]);
    const impact: Impact = {
      kind: 'targeted',
      impactTick: T,
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'dot', amount: AMOUNT, cadenceTicks: CADENCE, durationTicks: DURATION }],
    };
    // T — applied. Application itself deals no damage: the record's first tick is
    // due at T + cadenceTicks, never at T.
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      T,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    expect(result.creeps.hp[0]).toBe(startHp);
    expect(result.dots).toHaveLength(1);

    let hp = startHp;
    let dots = result.dots;
    creeps = result.creeps;
    for (let t = T + 1; t <= T + DURATION; t++) {
      const r = runCombat(
        creeps,
        emptyTowers(),
        [],
        dots,
        t,
        0,
        FIELD,
        GRID,
        {},
        RULESET.creepById,
        FLOOR_NUM,
        FLOOR_DEN,
      );
      const due = (t - T) % CADENCE === 0;
      if (due) hp -= AMOUNT;
      expect(r.creeps.hp[0]).toBe(hp); // exact magnitude, exactly on the lattice, nowhere else
      creeps = r.creeps;
      dots = r.dots;
    }
    expect(hp).toBe(startHp - AMOUNT * (DURATION / CADENCE)); // all 6 scheduled ticks landed
    expect(dots).toEqual([]); // expiry closed INCLUSIVELY at T + DURATION (T+60)
  });
});

describe('armor bypass — the same schedule against an armored creep', () => {
  it('the direct hit is blanked to 0 by armor, but the DoT tick deals full magnitude, unreduced', () => {
    const armoredDef: CreepDef = {
      id: 'armored-venom-target',
      hp: 1_000_000,
      speedFp: 26,
      armor: 6, // ≥ the venom-shaped direct damage (2) — the direct hit blanks to 0
      domain: 'ground',
      immunities: [],
      leakCost: 1,
      bounty: 1,
    };
    const ruleset = testRuleset(LANE, { extraCreeps: [armoredDef] });
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1_000_000 }]);
    creeps.creepId[0] = 'armored-venom-target';
    const T = 0;
    const impact: Impact = {
      kind: 'targeted',
      impactTick: T,
      targetId: 1,
      sourceId: 100,
      // Authored order mirrors the venom-shaped tower: direct, then dot.
      effects: [
        { kind: 'direct', amount: AMOUNT },
        { kind: 'dot', amount: AMOUNT, cadenceTicks: CADENCE, durationTicks: DURATION },
      ],
    };
    const applied = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      T,
      0,
      FIELD,
      GRID,
      {},
      ruleset.creepById,
      ruleset.balance.slowFloorNum,
      ruleset.balance.slowFloorDen,
    );
    expect(applied.creeps.hp[0]).toBe(1_000_000); // direct blanked to 0 by armor — untouched

    let result = applied;
    for (let t = T + 1; t <= T + CADENCE; t++) {
      result = runCombat(
        result.creeps,
        emptyTowers(),
        [],
        result.dots,
        t,
        0,
        FIELD,
        GRID,
        {},
        ruleset.creepById,
        ruleset.balance.slowFloorNum,
        ruleset.balance.slowFloorDen,
      );
    }
    // The first DoT tick (T+10) landed at FULL magnitude — armor never subtracted.
    expect(result.creeps.hp[0]).toBe(1_000_000 - AMOUNT);
  });
});

describe('per-source independence — two sources on one creep, both ticking, neither refreshing the other', () => {
  it('two distinct sourceIds create two independent records with independent schedules', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1_000_000 }]);
    const impactA: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'dot', amount: AMOUNT, cadenceTicks: CADENCE, durationTicks: DURATION }],
    };
    let r = runCombat(
      creeps,
      emptyTowers(),
      [impactA],
      [],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    expect(r.dots).toHaveLength(1);

    // A SECOND source, applied 5 ticks later — a distinct sourceId, so this is a
    // fresh append, not a refresh of source A's record.
    const impactB: Impact = {
      kind: 'targeted',
      impactTick: 5,
      targetId: 1,
      sourceId: 200,
      effects: [
        { kind: 'dot', amount: AMOUNT + 3, cadenceTicks: CADENCE, durationTicks: DURATION },
      ],
    };
    r = runCombat(
      r.creeps,
      emptyTowers(),
      [impactB],
      r.dots,
      5,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    expect(r.dots).toHaveLength(2); // source A's own record is untouched by source B's application
    expect(r.dots.find((d) => d.sourceId === 100)).toMatchObject({
      amount: AMOUNT,
      nextTickTick: 10,
    });
    expect(r.dots.find((d) => d.sourceId === 200)).toMatchObject({
      amount: AMOUNT + 3,
      nextTickTick: 15,
    });

    // T+10 — only source A is due.
    r = runCombat(
      r.creeps,
      emptyTowers(),
      [],
      r.dots,
      10,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    expect(r.creeps.hp[0]).toBe(1_000_000 - AMOUNT);

    // T+15 — only source B is due.
    r = runCombat(
      r.creeps,
      emptyTowers(),
      [],
      r.dots,
      15,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    expect(r.creeps.hp[0]).toBe(1_000_000 - AMOUNT - (AMOUNT + 3));
  });
});

describe('the refresh rule — reapplication keeps the T+10 lattice, adopts the new magnitude, and extends expiry', () => {
  it('a re-application BEFORE the next due tick leaves nextTickTick UNTOUCHED (the lattice, never reset to reapplication + cadence)', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1_000_000 }]);
    const first: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'dot', amount: AMOUNT, cadenceTicks: CADENCE, durationTicks: DURATION }],
    };
    let r = runCombat(
      creeps,
      emptyTowers(),
      [first],
      [],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    // Run through the first two due ticks (T+10, T+20) uneventfully.
    r = runCombat(
      r.creeps,
      emptyTowers(),
      [],
      r.dots,
      CADENCE,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    r = runCombat(
      r.creeps,
      emptyTowers(),
      [],
      r.dots,
      CADENCE * 2,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    expect(r.dots[0]).toMatchObject({ nextTickTick: CADENCE * 3 }); // 30 — next due tick on the lattice

    // Re-apply from the SAME source at T+25 — before the next due tick (T+30) — with
    // a new magnitude. A WRONG "reset the cadence at refresh" implementation would
    // set nextTickTick = 25 + CADENCE = 35; the correct rule leaves it at 30.
    const NEW_AMOUNT = AMOUNT + 7;
    const refreshTick = CADENCE * 2 + 5; // 25
    const refresh: Impact = {
      kind: 'targeted',
      impactTick: refreshTick,
      targetId: 1,
      sourceId: 100,
      effects: [
        { kind: 'dot', amount: NEW_AMOUNT, cadenceTicks: CADENCE, durationTicks: DURATION },
      ],
    };
    r = runCombat(
      r.creeps,
      emptyTowers(),
      [refresh],
      r.dots,
      refreshTick,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    expect(r.dots).toHaveLength(1); // still one record — a refresh, not a second source
    expect(r.dots[0]).toMatchObject({ amount: NEW_AMOUNT, nextTickTick: CADENCE * 3 }); // lattice untouched (30, not 35)
    expect(r.dots[0]!.untilTick).toBe(refreshTick + DURATION); // expiry extended from the refresh tick

    // The next due tick (T+30) fires at the NEWLY adopted magnitude — on top of the
    // two earlier ticks (T+10, T+20) already landed at the ORIGINAL magnitude.
    r = runCombat(
      r.creeps,
      emptyTowers(),
      [],
      r.dots,
      CADENCE * 3,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    expect(r.creeps.hp[0]).toBe(1_000_000 - AMOUNT * 2 - NEW_AMOUNT);
  });

  it('a re-application EXACTLY on a due tick still fires THAT tick, at the new magnitude — because runCombat resolves impacts (step 1, which refreshes the record) BEFORE the DoT tick step (step 2), within the SAME call/tick', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1_000_000 }]);
    const first: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 100,
      effects: [{ kind: 'dot', amount: AMOUNT, cadenceTicks: CADENCE, durationTicks: DURATION }],
    };
    let r = runCombat(
      creeps,
      emptyTowers(),
      [first],
      [],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    r = runCombat(
      r.creeps,
      emptyTowers(),
      [],
      r.dots,
      CADENCE,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    expect(r.dots[0]).toMatchObject({ nextTickTick: CADENCE * 2 }); // 20 — due next

    // A second shot from the SAME source lands on EXACTLY the due tick (T+20).
    const NEW_AMOUNT = AMOUNT + 4;
    const dueTick = CADENCE * 2;
    const refresh: Impact = {
      kind: 'targeted',
      impactTick: dueTick,
      targetId: 1,
      sourceId: 100,
      effects: [
        { kind: 'dot', amount: NEW_AMOUNT, cadenceTicks: CADENCE, durationTicks: DURATION },
      ],
    };
    r = runCombat(
      r.creeps,
      emptyTowers(),
      [refresh],
      r.dots,
      dueTick,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    // The tick still fired THIS SAME call, at the NEW magnitude, on top of the one
    // earlier tick (T+10) already landed at the ORIGINAL magnitude — if the DoT
    // tick step ran before impact resolution, this final tick would read AMOUNT
    // (the pre-refresh value) or not fire at all until next call. It holds only
    // because `runCombat`'s step (1) [resolve impacts, including this refresh] runs
    // strictly before step (2) [DoT tick] within one call — combat.ts's own
    // documented phase order.
    expect(r.creeps.hp[0]).toBe(1_000_000 - AMOUNT - NEW_AMOUNT);
    expect(r.dots[0]).toMatchObject({ nextTickTick: dueTick + CADENCE });
  });
});

describe('the sold-source rule (step 18) — a sold tower fires nothing new, but its in-flight impact still applies/refreshes on landing', () => {
  it('after a sale, no further shots ever fire, yet an already-launched shot still lands and refreshes the existing record', () => {
    const ruleset = testRuleset(LANE, { towers: [TEST_DOT_TOWER] });
    const s = createInitialState(1, ruleset);
    // id 500 — well clear of allocEntityId's low range, so the placed tower (id 1)
    // never collides with this manually-pushed row (coerceSoa's nextEntityId repair
    // then anchors above it anyway). `speed: 1` — a pushed creep still MOVES every
    // tick through the normal movement phase (pushCreep only fixes its STARTING
    // point, not a permanent rest); a near-zero speed keeps it inside the tower's
    // range for the whole window this test needs, without the test depending on
    // exact drift arithmetic.
    pushCreep(s, { id: 500, hp: 1_000_000, col: 6, row: 6, speed: 1 });
    step(s, ruleset, [{ kind: 'placeTower', anchor: { col: 5, row: 3 }, towerId: 'venom' }]);
    const towerId = s.towers.id[0] as number;

    // Tick 0's placement lands in tick 0's own input phase, so the tower (nextFireTick
    // 0, no warm-up) fires that same tick's combat phase — shot 0, impactTick 2
    // (travelTicks). Run through its resolution and up to just before the next fire
    // (cadenceTicks 30).
    for (let t = 1; t <= 29; t++) step(s, ruleset, []);
    expect(s.dots).toHaveLength(1); // shot 0 landed — first application
    const untilAfterFirst = s.dots[0]!.untilTick;

    // Tick 30 — the tower is still standing and still holding its target: shot 1
    // fires (impactTick 32).
    step(s, ruleset, []);
    // Tick 31 — sell the tower BEFORE shot 1 resolves. Its impact is already
    // queued, carrying its own fire-time `sourceId` (the sold tower's entity id),
    // independent of the tower row that fired it.
    step(s, ruleset, [{ kind: 'sellTower', tower: towerId }]);
    expect(s.towers.id).toEqual([]); // gone — fires no NEW shots from here on

    // Run well past shot 1's impactTick (32) and past the sold tower's would-be
    // next cadence (60) — no third shot ever appears.
    for (let t = 0; t < 40; t++) step(s, ruleset, []);
    expect(s.dots).toHaveLength(1); // still exactly ONE record — refreshed, not a second one
    // The record outlives its ORIGINAL expiry (untilAfterFirst) — proof shot 1
    // landed and refreshed it despite the tower already being sold.
    expect(s.dots[0]!.untilTick).toBeGreaterThan(untilAfterFirst);
  });
});

describe('a lethal hit applies no DoT', () => {
  it('a lethal direct effect in the same impact prevents its dot effect from ever creating a record', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 1 }]);
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 100,
      effects: [
        { kind: 'direct', amount: 999 }, // lethal
        { kind: 'dot', amount: AMOUNT, cadenceTicks: CADENCE, durationTicks: DURATION },
      ],
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
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    expect(result.creeps.id).toHaveLength(0); // dead, swept
    expect(result.dots).toEqual([]); // PASS 2 (statuses) never ran — no record created
  });
});

describe('DoT kills credit kill bounty, and the creep is swept in the same phase', () => {
  it('a DoT tick that reduces hp to 0 credits the killed creep bounty and sweeps the row this same call', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 4, bounty: 7 }]);
    const record: DotRecord = {
      targetId: 1,
      sourceId: 100,
      amount: 4, // lethal against hp 4
      cadenceTicks: CADENCE,
      nextTickTick: 0,
      untilTick: 1000,
    };
    const startingBounty = 50;
    const result = runCombat(
      creeps,
      emptyTowers(),
      [],
      [record],
      0,
      startingBounty,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    expect(result.creeps.id).toHaveLength(0); // swept THIS phase
    expect(result.bounty).toBe(startingBounty + 7); // kill bounty credited
    expect(result.killBounty).toBe(7);
    expect(result.dots).toEqual([]); // its own record dies with it
  });
});

describe('the record cap — a table at MAX_DOT_RECORDS drops the application and keeps the direct damage', () => {
  it("a full table drops the impact's new DoT record but its direct damage still lands", () => {
    const startHp = 1_000_000;
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: startHp }]);
    const fullTable: DotRecord[] = Array.from({ length: MAX_DOT_RECORDS }, (_, i) => ({
      targetId: 1,
      sourceId: i + 1, // distinct from the impact's own sourceId below
      amount: 1,
      cadenceTicks: 1000,
      nextTickTick: 100_000, // far from due — untouched by this call's tick step
      untilTick: 200_000, // far from expiry — untouched by this call's sweep
    }));
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 999_999,
      effects: [
        { kind: 'direct', amount: AMOUNT },
        { kind: 'dot', amount: AMOUNT, cadenceTicks: CADENCE, durationTicks: DURATION },
      ],
    };
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      fullTable,
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    expect(result.creeps.hp[0]).toBe(startHp - AMOUNT); // direct damage still landed
    expect(result.dots).toHaveLength(MAX_DOT_RECORDS); // the new record dropped — table size unchanged
  });
});

describe('traversal order — a deliberately shuffled SoA with a duplicate id', () => {
  // Witnesses the ROW-INDEX TIEBREAK only, not the creep-id key — see the twin of this
  // test in `combat.test.ts` and the traversal's own comment in `combat.ts` for why the
  // id key is unobservable today and kept anyway (QC round 1).
  it('ticks the LOWER-index duplicate, leaving the other untouched', () => {
    // Rows deliberately NOT in id order (30, 10, 10, 20) — id 10 appears twice, at
    // row indices 1 and 2. Sorted order is (10,1) → (10,2) → (20,3) → (30,0). A DoT
    // record ticks at most once per call, so whichever row is visited FIRST for a
    // given id consumes the tick, leaving the duplicate row untouched.
    const creeps = restingCreeps([
      { id: 30, col: 7, row: 6, hp: 1_000_000 }, // idx 0
      { id: 10, col: 7, row: 6, hp: 1_000_000 }, // idx 1 — lower idx wins the tick
      { id: 10, col: 7, row: 6, hp: 1_000_000 }, // idx 2 — duplicate id, untouched
      { id: 20, col: 7, row: 6, hp: 1_000_000 }, // idx 3
    ]);
    const records: DotRecord[] = [
      {
        targetId: 10,
        sourceId: 100,
        amount: 5,
        cadenceTicks: CADENCE,
        nextTickTick: 0,
        untilTick: 1000,
      },
      {
        targetId: 20,
        sourceId: 100,
        amount: 7,
        cadenceTicks: CADENCE,
        nextTickTick: 0,
        untilTick: 1000,
      },
      {
        targetId: 30,
        sourceId: 100,
        amount: 3,
        cadenceTicks: CADENCE,
        nextTickTick: 0,
        untilTick: 1000,
      },
    ];
    const result = runCombat(
      creeps,
      emptyTowers(),
      [],
      records,
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      FLOOR_NUM,
      FLOOR_DEN,
    );
    // Survivor order mirrors the original (nothing died): idx0=30, idx1=10, idx2=10, idx3=20.
    expect(result.creeps.hp).toEqual([1_000_000 - 3, 1_000_000 - 5, 1_000_000, 1_000_000 - 7]);
  });
});

describe('a determinism witness with LIVE DoT records', () => {
  it('a JSON round-trip taken at a tick where a DoT record is resident reproduces every following tick byte-identically', () => {
    function build(seed: number): SimState {
      const s = createInitialState(seed, RULESET);
      pushCreep(s, { id: 500, hp: 1_000_000, col: 6, row: 6, speed: 1 }); // near-stationary, tanky, in range
      return s;
    }
    const inputs = (t: number): SimInput[] =>
      t === 0 ? [{ kind: 'placeTower', anchor: { col: 5, row: 3 }, towerId: 'venom' }] : [];

    const TICKS = 80;
    const MID = 40; // between the first application (~T=2) and expiry (~T=62)

    let refState = build(7);
    const refTrace: string[] = [];
    for (let t = 0; t < TICKS; t++) {
      refState = step(refState, RULESET, inputs(t));
      refTrace.push(hashSimState(refState));
    }

    let live = build(7);
    for (let t = 0; t < MID; t++) live = step(live, RULESET, inputs(t));
    expect(live.dots.length).toBeGreaterThan(0); // LIVE records resident at the round-trip point

    const restored = JSON.parse(JSON.stringify(live)) as SimState;
    const resumedTail: string[] = [];
    for (let t = MID; t < TICKS; t++) {
      step(restored, RULESET, inputs(t));
      resumedTail.push(hashSimState(restored));
    }
    expect(resumedTail).toEqual(refTrace.slice(MID));
    expect(JSON.stringify(restored)).toBe(JSON.stringify(refState));
  });
});
