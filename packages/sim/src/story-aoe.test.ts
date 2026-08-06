// story-aoe.test.ts — M2 Story 4a: direct damage's AREA form. Blast resolution
// (inclusive-boundary radius membership, creep-id traversal order, the fire-time
// lead-and-clamp prediction, dead-target-in-flight, zero-member events, no-status-
// on-a-lethal-hit), the sv8 form-uniform/radius-uniform/AOE_SCAN_CEILING compiler
// gates, forged-blast totality, and the done-criterion showcase scenario (a wave of
// fragile `swarm`-like creeps that SURVIVES one well-placed blast tower — 5 of 16 leak
// through even at this fixture's best anchor, an owner-ratified pinned measurement, not
// a bug; see the block comment on that scenario for how it relates to the real board's
// 521-anchor sweep).

import { describe, it, expect } from 'vitest';
import { createInitialState, step, isTerminalPhase, hashSimState } from './index';
import {
  runCombat,
  emptyCreeps,
  blastMembers,
  type CombatCreeps,
  type Impact,
  type StepEvents,
} from './combat';
import { emptyTowers, MAX_TOWERS, type TowerArrays } from './tower';
import { compileRuleset, RulesetError, AOE_SCAN_CEILING } from './ruleset';
import {
  testBundle,
  testRuleset,
  TEST_AOE_TOWER,
  TEST_SWARM_CREEP,
  runCombatT,
} from './test-support';
import { advanceCreep, cellCenterX, cellCenterY, deriveValidCreepPosition } from './movement';
import { effectiveSpeedFp } from './ruleset-shared';

const LANE = {
  widthTiles: 14,
  heightTiles: 14,
  entrance: { col: 0, row: 6 },
  exit: { col: 13, row: 6 },
} as const;

const cx = (col: number): number => col * 256 + 128;
const cy = (row: number): number => row * 256 + 128;

// `runCombat` gained a REQUIRED `creepById` armor-lookup parameter at M2-S5a P1, then
// a `dots` parameter at P2 — `runCombatT` (imported from `./test-support`, shared
// verbatim with `combat.test.ts`/`story-slow.test.ts`) defaults both (`{}`/`[]`) so
// this file's ~17 existing call sites, which exercise pre-armor/pre-DoT behaviour,
// don't need one-by-one edits.

/** A creep whose DERIVED point is exactly `(px,py)` — a progress-0 transitional row
 *  (mirrors `combat.test.ts`'s `creepAtPoint`). */
function creepAtPoint(id: number, px: number, py: number, hp: number): CombatCreeps {
  const col = Math.floor(px / 256);
  const row = Math.floor(py / 256);
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
    stunUntilTick: [0],
  };
}

/** Build a resting-creeps SoA from `(id, col, row, hp)` rows, in ARRAY order — the
 *  order under test never carries semantic weight (`runCombat`'s blast resolution
 *  sorts explicitly), so callers may hand rows in any order, including duplicate ids. */
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

/** A single fresh AoE tower, anchored at (5,5), id 100, untargeted, ready to fire —
 *  the shared fixture behind the lead-and-clamp/fired-event/dead-target-in-flight
 *  cases below (all five wanted the exact same row). */
function aoeTower(): TowerArrays {
  const towers = { ...emptyTowers() };
  towers.id.push(100);
  towers.col.push(5);
  towers.row.push(5);
  towers.spend.push(TEST_AOE_TOWER.cost);
  towers.targetId.push(0);
  towers.nextFireTick.push(0);
  towers.towerId.push('aoe');
  return towers;
}

const RULESET = testRuleset(LANE, { extraTowers: [TEST_AOE_TOWER] });
const FIELD = RULESET.board.field;
const GRID = RULESET.board.grid;
const SF_NUM = RULESET.balance.slowFloorNum;
const SF_DEN = RULESET.balance.slowFloorDen;

describe('blast resolution — inclusive-boundary radius membership', () => {
  it('a creep exactly AT the radius is hit; one unit beyond is not', () => {
    const RADIUS = 300;
    const CENTER = { x: 1536, y: 1536 };
    const onBoundary = creepAtPoint(1, CENTER.x + RADIUS, CENTER.y, 100);
    const impact: Impact = {
      kind: 'blast',
      impactTick: 0,
      x: CENTER.x,
      y: CENTER.y,
      radiusFp: RADIUS,
      sourceId: 1,
      domain: 'ground',
      effects: [{ kind: 'direct', amount: 10 }],
    };
    const onResult = runCombatT(
      onBoundary,
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
    );
    expect(onResult.creeps.hp[0]).toBe(90); // hit — inclusive boundary

    const beyond = creepAtPoint(1, CENTER.x + RADIUS + 1, CENTER.y, 100);
    const beyondResult = runCombatT(
      beyond,
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
    );
    expect(beyondResult.creeps.hp[0]).toBe(100); // one unit past — untouched
  });

  // QC round-1 #5: the case above sits at dy = 0, where the quadratic membership
  // test degenerates to `|dx| ≤ r` — indistinguishable from a SQUARE bound, and
  // `dx = 301` is already rejected by `inRange`'s Chebyshev early-out
  // (`Math.abs(dx) > range`) before the circle math even runs. A mutant that
  // replaces `inRange`'s body with `return true` still passes every assertion
  // above. A genuine off-axis 3-4-5 pair — `dy ≠ 0`, and both deltas individually
  // under `range` so the early-out never fires — is the only shape that actually
  // exercises `dx² + dy² ≤ range²` and tells a circle from a square.
  it('a genuine off-axis 3-4-5 point is hit exactly on the circle, one unit further out misses (not a square bound)', () => {
    const RADIUS = 300; // 3-4-5 scaled ×60: 180² + 240² = 300²
    const CENTER = { x: 1536, y: 1536 };
    const impact: Impact = {
      kind: 'blast',
      impactTick: 0,
      x: CENTER.x,
      y: CENTER.y,
      radiusFp: RADIUS,
      sourceId: 1,
      domain: 'ground',
      effects: [{ kind: 'direct', amount: 10 }],
    };

    const onCircle = creepAtPoint(1, CENTER.x + 180, CENTER.y + 240, 100);
    const onResult = runCombatT(
      onCircle,
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
    );
    expect(onResult.creeps.hp[0]).toBe(90); // 180² + 240² === 300² — inclusive boundary hit

    // Both individual deltas (181, 240) stay under `range` (300), so the Chebyshev
    // early-out cannot reject this on its own — only the true circle test can.
    const justOutside = creepAtPoint(1, CENTER.x + 181, CENTER.y + 240, 100);
    const outsideResult = runCombatT(
      justOutside,
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
    );
    expect(outsideResult.creeps.hp[0]).toBe(100); // 181² + 240² === 90,361 > 90,000 — untouched
  });
});

describe('blast resolution — creep-id ascending traversal order, row-index tiebreak', () => {
  it('every member row applies independently — duplicate ids are DISTINCT rows, not merged by entity id', () => {
    // Two rows share id 10 (a forged/duplicate-id SoA) alongside two other ids, all
    // within radius, deliberately NOT in id order in the array.
    const creeps = restingCreeps([
      { id: 50, col: 7, row: 6, hp: 100 },
      { id: 10, col: 7, row: 6, hp: 100 },
      { id: 10, col: 7, row: 6, hp: 100 }, // duplicate id — a second, distinct row
      { id: 30, col: 7, row: 6, hp: 100 },
    ]);
    const impact: Impact = {
      kind: 'blast',
      impactTick: 0,
      x: cx(7),
      y: cy(6),
      radiusFp: 50,
      sourceId: 1,
      domain: 'ground',
      effects: [{ kind: 'direct', amount: 15 }],
    };
    const result = runCombatT(
      creeps,
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
    );
    // All FOUR rows took the hit independently — the duplicate id was not deduped
    // to one application.
    expect(result.creeps.hp).toEqual([85, 85, 85, 85]);
  });

  it('the resolved outcome is independent of the SoA’s array order (the explicit sort, not array/spawn order, decides application order)', () => {
    const rowsA = [
      { id: 50, col: 7, row: 6, hp: 100 },
      { id: 10, col: 7, row: 6, hp: 100 },
      { id: 10, col: 7, row: 6, hp: 100 },
      { id: 30, col: 7, row: 6, hp: 100 },
    ];
    const rowsB = [rowsA[2]!, rowsA[0]!, rowsA[3]!, rowsA[1]!]; // same multiset, shuffled
    const impact: Impact = {
      kind: 'blast',
      impactTick: 0,
      x: cx(7),
      y: cy(6),
      radiusFp: 50,
      sourceId: 1,
      domain: 'ground',
      effects: [{ kind: 'direct', amount: 15 }],
    };
    const resultA = runCombatT(
      restingCreeps(rowsA),
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
    );
    const resultB = runCombatT(
      restingCreeps(rowsB),
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
    );
    // Compare by id (both surviving arrays are dense, no deaths here) — the hp each
    // id ends with must match regardless of which array position it started at.
    const byId = (r: typeof resultA): Record<number, number[]> => {
      const out: Record<number, number[]> = {};
      r.creeps.id.forEach((id, i) => {
        (out[id as number] ??= []).push(r.creeps.hp[i] as number);
      });
      for (const v of Object.values(out)) v.sort((a, b) => a - b);
      return out;
    };
    expect(byId(resultA)).toEqual(byId(resultB));
  });

  // QC round-1 #6: the two tests above only prove the RESULT is order-independent —
  // deleting, reversing, or inverting the tiebreak in `blastMembers`'s sort leaves
  // both green, since nothing about `runCombat`'s own outcome today observes the
  // traversal order (see `blastMembers`'s doc comment, combat.ts). Asserting the
  // returned SoA row-index order DIRECTLY, against the same shuffled/duplicate-id
  // fixture below, is what actually pins ASCENDING-ID order and catches an
  // INVERTED tiebreak.
  //
  // QC round-2: it does NOT catch a DELETED tiebreak (`|| a.idx - b.idx` simply
  // removed). `members` is always pushed in ascending SoA-index order (the `for (let
  // i = 0; ...)` loop in `blastMembers`), and `Array.prototype.sort` has been
  // required stable since ES2019 — so for equal-id rows, sorting by `id` ALONE
  // already reproduces the identical ascending-index order the explicit tiebreak
  // asserts. No fixture built from `blastMembers`'s own inputs can distinguish
  // "tiebreak present" from "tiebreak absent, relying on stable sort + push order";
  // only INVERTING it is observable. The explicit `|| a.idx - b.idx` is kept anyway
  // as an EXPLICIT total order the function's contract can name and rely on, rather
  // than an implicit dependency on `sort`'s stability guarantee and this loop's
  // push order — both true today, but neither is what the tiebreak clause itself
  // is FOR.
  it('blastMembers returns rows in ascending creep-id order, ties broken by SoA row index (directly pinned)', () => {
    const rowsA = [
      { id: 50, col: 7, row: 6, hp: 100 },
      { id: 10, col: 7, row: 6, hp: 100 },
      { id: 10, col: 7, row: 6, hp: 100 }, // duplicate id — a second, distinct row
      { id: 30, col: 7, row: 6, hp: 100 },
    ];
    const rowsB = [rowsA[2]!, rowsA[0]!, rowsA[3]!, rowsA[1]!]; // same multiset, shuffled
    const imp = { x: cx(7), y: cy(6), radiusFp: 50, domain: 'both' as const };

    // rowsA array order: [id50@0, id10@1, id10@2, id30@3] — sorted by (id, idx):
    // id10@1, id10@2, id30@3, id50@0.
    expect(blastMembers(restingCreeps(rowsA), GRID, {}, imp)).toEqual([1, 2, 3, 0]);
    // rowsB array order: [id10@0, id50@1, id30@2, id10@3] — sorted by (id, idx):
    // id10@0, id10@3, id30@2, id50@1. The duplicate id's own two rows keep their
    // ORIGINAL relative order (row-index tiebreak), even though the array as a
    // whole was shuffled — proof the tiebreak is row index, not e.g. array order
    // reversed or first-occurrence-only.
    expect(blastMembers(restingCreeps(rowsB), GRID, {}, imp)).toEqual([0, 3, 2, 1]);
  });
});

// QC round-2: `blastMembers`'s three eligibility guards (`combat.ts`) were only
// ORDER-tested (above) — every one of the three `continue`s below is deletable with
// the whole suite green, since the order tests' fixtures are all live, on-lattice,
// safe-integer rows. Each guard gets its own witness here.
describe('blastMembers — eligibility guards (membership, not ordering)', () => {
  it('a dead row inside the blast radius is excluded — bounty and killBounty stay 0, not the paid-out amount', () => {
    // Deleting `if (!isLiveHp(creeps.hp[i])) continue;` would let this dead row pay
    // its bounty — HASH-RELEVANT: `killBounty` feeds `cumulativeKillBounty`, which
    // feeds score, which feeds `hashSimState` (`runCombat`'s own comment, combat.ts
    // §(2): "a forged non-positive-hp row is swept with no bounty").
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 0 }]);
    creeps.bounty[0] = 7;
    const impact: Impact = {
      kind: 'blast',
      impactTick: 0,
      x: cx(7),
      y: cy(6),
      radiusFp: 50,
      sourceId: 1,
      domain: 'ground',
      effects: [{ kind: 'direct', amount: 15 }],
    };
    const result = runCombatT(
      creeps,
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
    );
    expect(result.bounty).toBe(0);
    expect(result.killBounty).toBe(0);
  });

  it('a live row with a non-safe-integer id (a forged/restored SoA — coerceSoa validates only wave/creepId, never id) is excluded from membership', () => {
    // Deleting `if (!Number.isSafeInteger(id)) continue;` would let this row into
    // `members` carrying a NaN sort key. The mechanism is NOT "the comparator returns
    // NaN" (QC round-3): `NaN - b.id` is NaN, which is FALSY, so `||` falls through to
    // the `a.idx - b.idx` tiebreak and the comparator never returns NaN at all. The
    // damage is that it goes NON-TRANSITIVE against the other rows — for ids
    // [50, NaN, 10] at idx [0,1,2]: cmp(0,1) = −1, cmp(1,2) = −1, but cmp(0,2) = +40 —
    // and a non-transitive comparator makes `Array.prototype.sort`'s output
    // engine-dependent, which is precisely what the determinism contract forbids.
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 100 }]);
    creeps.id[0] = NaN;
    const imp = { x: cx(7), y: cy(6), radiusFp: 50, domain: 'both' as const };
    expect(blastMembers(creeps, GRID, {}, imp)).toEqual([]);
  });

  it('a live row whose headCol sits 3 cells from fromCol — deriveValidCreepPosition returns null — is excluded from membership', () => {
    // Deleting `if (geom === null) continue;` would crash on `geom.point.x` instead
    // of skipping a row whose position cannot be derived.
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 100 }]);
    creeps.headCol[0] = 10; // |10 − 7| = 3 > 1, so deriveValidCreepPosition rejects it
    const imp = { x: cx(7), y: cy(6), radiusFp: 50, domain: 'both' as const };
    expect(blastMembers(creeps, GRID, {}, imp)).toEqual([]);
  });
});

describe('blast resolution — lead-and-clamp (fire-time prediction reuses advanceCreep)', () => {
  it('a target whose predicted flight would leak lands the blast at the EXIT CENTRE', () => {
    const towers = aoeTower();

    // A creep in range (tower footprint centre (1536,1536), rangeFp 1024) with an
    // enormous per-tick speed: `travelTicks(8) × effectiveSpeedFp(huge)` vastly
    // exceeds the board's max route length, so `advanceCreep`'s walk reaches the
    // exit and the predicted point clamps there (the loop-bound argument,
    // `predictBlastPoint`'s doc, combat.ts).
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 10_000 }]);
    creeps.speed[0] = 1_000_000;

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
    expect(imp.x).toBe(cx(FIELD.exit.col));
    expect(imp.y).toBe(cy(FIELD.exit.row));
  });

  // QC round-1 #4: `predictBlastPoint`'s SLOW term had no tripwire — swapping its
  // `effectiveSpeedFp(...)` call for the raw `speed` column left every existing test
  // (including both goldens) green, yet `slow` and `splash` both ship in the same
  // bundle, so a slowed creep under a blast tower is reachable in ordinary play. These
  // two cases independently RECOMPUTE the expected lead point (never by calling
  // `predictBlastPoint` itself, which is unexported) via the exact same public seam it
  // is documented to use — `effectiveSpeedFp` then `advanceCreep` — so a mutant that
  // drops the slow term changes the PRODUCTION point while this test's independently
  // computed expectation stays keyed to the true slowed budget.
  it('a slowed target’s predicted lead point matches advanceCreep’s own output for the SLOWED budget', () => {
    const towers = aoeTower();

    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 10_000 }]);
    creeps.speed[0] = 640;
    creeps.slowMulFp[0] = 64; // quarter-speed multiplier (mulFp/256)
    creeps.slowUntilTick[0] = 1_000; // still active at fire time (tick 0)

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

    // Independently recompute the SLOWED budget and expected point.
    const slowedSpeed = effectiveSpeedFp(640, 64, SF_NUM, SF_DEN);
    expect(slowedSpeed).toBeLessThan(640); // sanity: the slow actually reduced speed
    const budget = TEST_AOE_TOWER.attack!.travelTicks * slowedSpeed;
    const outcome = advanceCreep(FIELD, 1, 10_000, cx(7), cy(6), 8, 6, 0, budget, 'ground');
    let expectedX: number;
    let expectedY: number;
    if (outcome.kind === 'leak') {
      expectedX = cellCenterX(FIELD.exit.col);
      expectedY = cellCenterY(FIELD.exit.row);
    } else if (outcome.kind === 'move') {
      const geom = deriveValidCreepPosition(
        outcome.fromX,
        outcome.fromY,
        outcome.headCol,
        outcome.headRow,
        outcome.progress,
        GRID,
      );
      if (geom === null) throw new Error('expected a valid derived position');
      expectedX = geom.point.x;
      expectedY = geom.point.y;
    } else {
      throw new Error('expected a move or leak outcome, not drop');
    }
    expect(imp.x).toBe(expectedX);
    expect(imp.y).toBe(expectedY);
  });

  it('an UNSLOWED target’s predicted lead point is a pinned fixed value (regression anchor alongside the slowed case)', () => {
    const towers = aoeTower();

    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 10_000 }]);
    creeps.speed[0] = 100;

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
    // PINNED: travelTicks(8) × speed(100) = 800 fp of unslowed budget spent from
    // (7,6) toward the exit along the straight row-6 lane — a genuine mid-lane lead
    // point (not an exit clamp), computed once by running the real code.
    expect(imp.x).toBe(2720);
    expect(imp.y).toBe(cy(6));
  });
});

describe('blast resolution — fired StepEvents carries the scheduled destination (M2-S4a step 12)', () => {
  it('a blast tower firing emits a kind:"blast" fired event whose destX/destY match the resolved impact point', () => {
    const towers = aoeTower();

    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 10_000 }]);
    const events: StepEvents = { impactPoints: [], fired: [] };
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
      events,
    );
    expect(result.impacts).toHaveLength(1);
    const imp = result.impacts[0]!;
    if (imp.kind !== 'blast') throw new Error('expected a blast impact');
    // The fired event's destination is the SAME lead point the impact itself carries —
    // a render-layer tracer interpolating toward `destX`/`destY` lands exactly where the
    // blast will resolve, unlike a `targeted` tracer chasing a creep's live position.
    expect(events.fired).toEqual([
      {
        kind: 'blast',
        originX: 1536, // footprint centre of a tower anchored at (5,5): (5+1)·256
        originY: 1536,
        targetId: 1,
        destX: imp.x,
        destY: imp.y,
        launchTick: 0,
        impactTick: TEST_AOE_TOWER.attack!.travelTicks, // TEST_AOE_TOWER is a fixed attacking-tower fixture
      },
    ]);
  });
});

describe('blast resolution — dead-target-in-flight still blasts; zero-member still emits its event', () => {
  it('the fire-time target vanishing before impactTick does not waste the blast — it still resolves by radius', () => {
    const towers = aoeTower();

    // Tick 0: fire at a resting, in-range creep (id 1).
    const t0Creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 10_000 }]);
    const t0 = runCombatT(
      t0Creeps,
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
    expect(t0.impacts).toHaveLength(1);
    const blast = t0.impacts[0]!;
    if (blast.kind !== 'blast') throw new Error('expected a blast impact');

    // At the impact tick, creep 1 (the fire-time target) is ENTIRELY GONE (dead by
    // other means) — but creep 2 sits AT the blast's own predicted point (a valid
    // transitional row, `creepAtPoint` — the predicted point is rarely a cell
    // centre, so a "resting" row there would fail position validation), well
    // within its radius.
    const resolveCreeps = creepAtPoint(2, blast.x, blast.y, 100);

    const events: StepEvents = { impactPoints: [], fired: [] };
    const result = runCombatT(
      resolveCreeps,
      towers,
      t0.impacts,
      blast.impactTick,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      SF_NUM,
      SF_DEN,
      events,
    );
    // PINNED (QC round-1 #11): TEST_AOE_TOWER's single aoe effect deals exactly 8 —
    // 100 − 8 = 92, not merely "some damage happened".
    expect(result.creeps.hp[0]).toBe(92); // creep 2 was hit — the blast was NOT wasted
    expect(events.impactPoints).toEqual([{ x: blast.x, y: blast.y, radiusFp: blast.radiusFp }]);
  });

  it('a zero-member blast (nobody in radius) still emits exactly one impactPoints event', () => {
    const impact: Impact = {
      kind: 'blast',
      impactTick: 0,
      x: cx(7),
      y: cy(6),
      radiusFp: 50,
      sourceId: 1,
      domain: 'ground',
      effects: [{ kind: 'direct', amount: 10 }],
    };
    const events: StepEvents = { impactPoints: [], fired: [] };
    const result = runCombatT(
      emptyCreeps(),
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
      events,
    );
    expect(result.creeps.id).toHaveLength(0);
    expect(events.impactPoints).toEqual([{ x: cx(7), y: cy(6), radiusFp: 50 }]);
  });
});

// QC round-2: this describe's title and this test's title both claimed to prove "a
// lethal blast applies no statuses". They don't — the killed row is swept before
// its slow columns could be read, so this only verifies the SURVIVOR clause
// (`result.creeps.slowMulFp[0]`, the one remaining row). The actual "no statuses on
// a lethal hit" rule is pinned directly, pre-sweep, in `combat.test.ts`'s
// `applyImpactToCreep` describe block, which calls the function itself instead of
// going through `runCombat`'s sweep.
describe('blast resolution — a lethal blast still kills and sweeps; a surviving sibling in the same blast still gets slowed', () => {
  it('a creep killed by the direct pass is dead+swept; a surviving sibling in the same blast still gets its slow', () => {
    const creeps = restingCreeps([
      { id: 1, col: 7, row: 6, hp: 8 }, // dies to the direct pass
      { id: 2, col: 7, row: 6, hp: 100 }, // survives
    ]);
    const impact: Impact = {
      kind: 'blast',
      impactTick: 0,
      x: cx(7),
      y: cy(6),
      radiusFp: 50,
      sourceId: 1,
      domain: 'ground',
      effects: [
        { kind: 'direct', amount: 8 },
        { kind: 'slow', mulFp: 128, durationTicks: 30 },
      ],
    };
    const result = runCombatT(
      creeps,
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
    );
    expect(result.creeps.id).toEqual([2]); // creep 1 dead + swept
    expect(result.creeps.slowMulFp[0]).toBe(128); // the survivor got its slow
  });
});

describe('sv8 capability gates — form-uniform, radius-uniform, AOE_SCAN_CEILING', () => {
  it('rejects a tower mixing single and aoe direct forms', () => {
    const bundle = testBundle(LANE, {
      towers: [
        {
          ...TEST_AOE_TOWER,
          effects: [
            { kind: 'direct', form: 'single', damage: 10 },
            { kind: 'direct', form: 'aoe', damage: 8, radiusFp: 300 },
          ],
        },
      ],
    });
    expect(() => compileRuleset(bundle, 'test')).toThrow(RulesetError);
    expect(() => compileRuleset(bundle, 'test')).toThrow('form-uniform');
  });

  it('rejects two aoe effects on one tower with different radii', () => {
    const bundle = testBundle(LANE, {
      towers: [
        {
          ...TEST_AOE_TOWER,
          effects: [
            { kind: 'direct', form: 'aoe', damage: 8, radiusFp: 300 },
            { kind: 'direct', form: 'aoe', damage: 4, radiusFp: 301 },
          ],
        },
      ],
    });
    expect(() => compileRuleset(bundle, 'test')).toThrow(RulesetError);
    expect(() => compileRuleset(bundle, 'test')).toThrow('radii');
  });

  it('AOE_SCAN_CEILING derivation is pinned: MAX_TOWERS × totalScheduledSpawns ≤ 2,000,000 admits ≤ 2,000 spawns', () => {
    expect(AOE_SCAN_CEILING).toBe(2_000_000);
    expect(Math.floor(AOE_SCAN_CEILING / MAX_TOWERS)).toBe(2_000);
  });

  it('rejects a catalog containing an aoe tower whose worst-legal workload exceeds AOE_SCAN_CEILING', () => {
    const overCeiling = testBundle(LANE, {
      towers: [TEST_AOE_TOWER],
      waveCount: Math.floor(AOE_SCAN_CEILING / MAX_TOWERS) + 1, // 2,001 — one over the admitted max
      waveSpacing: 1,
      countdownTicks: 1,
    });
    expect(() => compileRuleset(overCeiling, 'test')).toThrow(RulesetError);
    expect(() => compileRuleset(overCeiling, 'test')).toThrow('AoE scan-work ceiling');
  });

  it('the SAME workload compiles fine without any aoe tower in the catalog (the ceiling is aoe-gated)', () => {
    const noAoe = testBundle(LANE, {
      waveCount: Math.floor(AOE_SCAN_CEILING / MAX_TOWERS) + 1,
      waveSpacing: 1,
      countdownTicks: 1,
    });
    expect(() => compileRuleset(noAoe, 'test')).not.toThrow();
  });

  it('admits exactly the pinned boundary (2,000 spawns) with an aoe tower present', () => {
    const atCeiling = testBundle(LANE, {
      towers: [TEST_AOE_TOWER],
      waveCount: Math.floor(AOE_SCAN_CEILING / MAX_TOWERS), // exactly 2,000
      waveSpacing: 1,
      countdownTicks: 1,
    });
    expect(() => compileRuleset(atCeiling, 'test')).not.toThrow();
  });
});

describe('forged-blast bounds (Codex R1-16) — dropped with no unsafe arithmetic, no hash contamination', () => {
  it('drops out-of-board coordinates, non-positive/over-cap radii, safe-integer-domain-leaving deltas, and mixed malformed variants — never throws', () => {
    const malformed: unknown[] = [
      // Out-of-board (well beyond any real board, but still a "coordinate" shape).
      {
        kind: 'blast',
        impactTick: 0,
        x: 999_999,
        y: 999_999,
        radiusFp: 50,
        effects: [{ kind: 'direct', amount: 1 }],
      },
      // Non-positive radius.
      {
        kind: 'blast',
        impactTick: 0,
        x: cx(7),
        y: cy(6),
        radiusFp: 0,
        effects: [{ kind: 'direct', amount: 1 }],
      },
      {
        kind: 'blast',
        impactTick: 0,
        x: cx(7),
        y: cy(6),
        radiusFp: -50,
        effects: [{ kind: 'direct', amount: 1 }],
      },
      // Over-cap radius (combat.ts's structural MAX_BLAST_RADIUS_FP, 2048).
      {
        kind: 'blast',
        impactTick: 0,
        x: cx(7),
        y: cy(6),
        radiusFp: 2049,
        effects: [{ kind: 'direct', amount: 1 }],
      },
      // A coordinate delta that would leave the safe-integer domain if it reached
      // unguarded arithmetic (dropped by validImpact's coordinate bound instead).
      {
        kind: 'blast',
        impactTick: 0,
        x: Number.MAX_SAFE_INTEGER,
        y: Number.MAX_SAFE_INTEGER,
        radiusFp: 50,
        effects: [{ kind: 'direct', amount: 1 }],
      },
      // Malformed targeted variants mixed into the SAME queue.
      {
        kind: 'targeted',
        impactTick: 0,
        targetId: 'not-a-number',
        effects: [{ kind: 'direct', amount: 1 }],
      },
      { kind: 'targeted', impactTick: 0, targetId: 1 }, // effects missing entirely
      // Unrecognized kind.
      {
        kind: 'nuke',
        impactTick: 0,
        x: 0,
        y: 0,
        radiusFp: 50,
        effects: [{ kind: 'direct', amount: 1 }],
      },
      null,
      42,
      'not an impact',
    ];
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 100 }]);
    const events: StepEvents = { impactPoints: [], fired: [] };
    let result!: ReturnType<typeof runCombat>;
    expect(() => {
      result = runCombatT(
        creeps,
        emptyTowers(),
        malformed,
        0,
        0,
        FIELD,
        GRID,
        {},
        SF_NUM,
        SF_DEN,
        events,
      );
    }).not.toThrow();
    expect(result.impacts).toHaveLength(0); // every entry dropped — none kept for a future tick
    expect(result.creeps.hp[0]).toBe(100); // no arithmetic ever touched the live creep
    expect(events.impactPoints).toHaveLength(0); // nothing resolved — nothing emitted
  });
});

describe('the done-criterion scenario (Codex R1-13): one blast tower SURVIVES a wave of fragile swarm-like creeps', () => {
  // A minimal synthetic ruleset fixture, built INLINE. It never imports
  // `@wynding/content` — `packages/sim` sits UPSTREAM of `content` in the one-way
  // dependency graph, so it cannot, and the real `splash`/`swarm` entries (which DID land
  // in `wynding-core.json` earlier on this branch) are unreachable from here by design:
  // one `aoe` tower
  // (`TEST_AOE_TOWER`, mirroring `splash`'s exact numbers) and a wave of 16
  // `swarm`-shaped creeps (`TEST_SWARM_CREEP`: hp 7, speed 30 — dies to one blast
  // whose damage is 8), spaced tightly (5 ticks) so several are caught by one
  // blast's radius.
  const SHOWCASE = testRuleset(LANE, {
    towers: [TEST_AOE_TOWER],
    extraCreeps: [TEST_SWARM_CREEP],
    waves: [{ waveCount: 16, waveSpacing: 5, countdownTicks: 1, creepId: 'swarm' }],
  });

  function runShowcase(): { state: ReturnType<typeof createInitialState> } {
    let state = createInitialState(0xf00d, SHOWCASE);
    // Pinned anchor: (5,5) — off the straight row-6 lane, footprint centre
    // (1536,1536), well within the tower's rangeFp (1024) of the lane.
    state = step(state, SHOWCASE, [
      { kind: 'callWaveEarly' },
      { kind: 'placeTower', anchor: { col: 5, row: 5 }, towerId: 'aoe' },
    ]);
    let ticks = 1;
    const CAP = 5_000; // generous — well under MAX_MATCH_TICKS, loud if never terminal
    while (!isTerminalPhase(state.phase) && ticks < CAP) {
      state = step(state, SHOWCASE, []);
      ticks++;
    }
    return { state }; // `ticks` is bounded by CAP below and pinned by the golden's tick field
  }

  // OWNER-RATIFIED PINNED EXPECTATION (QC round-1 #1, provenance corrected at round 2):
  // this scenario does NOT clear the wave, and that is the accepted outcome, not a bug.
  //
  // TWO SEPARATE MEASUREMENTS, kept distinct because round 1's comment conflated them:
  //   - THIS fixture is the 14×14 synthetic `LANE` above, which has 117 legal anchors.
  //     Its best also leaks 5, which is why the number below is 5.
  //   - The exhaustive sweep behind the OWNER'S RULING ran over the real 28×24 board and
  //     the shipped bundle: 521 legal anchors, of which **ZERO** clear the wave; the best
  //     leaks 5 of 16. It takes **TWO** towers — e.g. (4,9) + (5,12) — to clear it. (Round
  //     1's comment said "only two of the 521 anchors clear", which is impossible and was a
  //     mis-transcription of "two towers".) That sweep is recorded in `docs/milestones/m2.md`'s
  //     flags section, not reproduced here — this test pins one fixture, not the sweep.
  //
  // The ruling was to pin the MEASURED outcome: no balance number (splash's damage/radius,
  // swarm's hp/spacing, or the wave itself) was tuned to make this anchor clear. The three
  // assertions below pin those numbers directly — `leakedCount === 5`, `lives === 5`
  // (10 starting − 5 leaks × 1 leakCost), `cumulativeKillBounty === 11` (11 of 16 kills at
  // 1 bounty each) — so a degradation fails on a NAMED value rather than only on the golden
  // hash, which is re-pinned wholesale at every `simVersion` bump and so cannot be relied on
  // as this rule's guard for the six bumps M2 still has left.
  it('reaches a terminal WIN state that still leaked 5 of 16 — the measured, owner-ratified outcome', () => {
    const { state } = runShowcase();
    expect(isTerminalPhase(state.phase)).toBe(true);
    expect(state.phase).toBe('won');
    expect(state.leakedCount).toBe(5);
    expect(state.lives).toBe(5);
    expect(state.cumulativeKillBounty).toBe(11);
    // GOLDEN — a behavior change here requires re-pinning this alongside the three
    // measured values above. Re-pinned M2-S5a P2: `Impact.sourceId` enters the
    // world-hash; the three measured values above are UNCHANGED, so this is a
    // hash-only move, not a behavior change.
    // Re-pinned M2-S6 P5: the new `stunUntilTick` creep column (P1) widens every
    // creep's serialized shape; this scenario carries no `stun` tower, so the
    // three measured values above are again UNCHANGED — another hash-only move.
    expect(hashSimState(state)).toBe('34ee3f5f');
  });
});
