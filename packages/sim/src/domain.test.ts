// domain.test.ts — M2-S7 P3: the domain axis in combat — the air remaining-
// route-distance metric, acquisition filtering, the fire-time impact mask
// enforced again at impact time, and the shared `resolveCreepDomain` totality
// rail. There are FIVE domain-lookup sites, not four: targeting, movement, impact
// resolution and blast membership are covered here; the fifth — PLACEMENT
// (`canPlaceTower`'s clauses 3 and 5, added in P4 after this file was written) — is
// covered in `tower.test.ts`, which calls `canPlaceTower` directly. Movement-side
// domain tests (the terrain-independent occupancy skip and the line-follow heading
// rule) live in movement.test.ts; this file covers everything downstream of
// `LiveCreep`.

import { describe, it, expect } from 'vitest';
import type { CreepDef, TowerDef } from '@wynding/types';
import { Rng } from '@wynding/engine';
import { createInitialState, step } from './index';
import { advanceCreep, cellCenterX, cellCenterY } from './movement';
import { computeDistanceField, type DistanceField } from './pathfinding';
import { emptyTowers, type TowerArrays } from './tower';
import { runCombat, blastMembers, type CombatCreeps, type Impact, type StepEvents } from './combat';
import { resolveCreepDomain } from './domain';
import { testRuleset, pushCreep, TEST_RNG_SEED } from './test-support';

// A 14×14 board, axis-aligned entrance→exit (row 6) — mirrors combat.test.ts's
// geometry. None of these fixtures SCHEDULE an air creep via the wave (creeps
// are injected directly into the SoA), so P1's axis-alignment gate (scoped to a
// board whose wave schedule references an air creep) does not apply here; the
// size gate (≤1024/side, catalog-wide whenever ANY air creep exists) is
// satisfied trivially at 14×14.
const SPEC = {
  widthTiles: 14,
  heightTiles: 14,
  entrance: { col: 0, row: 6 },
  exit: { col: 13, row: 6 },
} as const;

const cx = (col: number): number => col * 256 + 128;
const cy = (row: number): number => row * 256 + 128;

const FLYER_DEF: CreepDef = {
  id: 'flyer',
  hp: 20,
  speedFp: 26,
  armor: 0,
  domain: 'air',
  immunities: [],
  leakCost: 1,
  bounty: 1,
};

const GROUND_TOWER: TowerDef = {
  id: 'ground-tower',
  cost: 5,
  attack: { domain: 'ground', rangeFp: 8192, cadenceTicks: 30, travelTicks: 1 },
  effects: [{ kind: 'direct', form: 'single', damage: 10 }],
};
const AIR_TOWER: TowerDef = {
  id: 'air-tower',
  cost: 7,
  attack: { domain: 'air', rangeFp: 8192, cadenceTicks: 30, travelTicks: 1 },
  effects: [{ kind: 'direct', form: 'single', damage: 8 }],
};
const AOE_GROUND_TOWER: TowerDef = {
  id: 'aoe-ground-tower',
  cost: 12,
  attack: { domain: 'ground', rangeFp: 8192, cadenceTicks: 60, travelTicks: 1 },
  effects: [{ kind: 'direct', form: 'aoe', damage: 8, radiusFp: 384 }],
};

/** An AoE tower that targets AIR — needed to witness the blast-lead path for a flyer,
 *  which `AOE_GROUND_TOWER` can never reach. */
const AOE_AIR_TOWER: TowerDef = {
  id: 'aoe-air-tower',
  cost: 12,
  // travelTicks MUST match `AOE_GROUND_TOWER`'s: the air-vs-ground comparison below is
  // only meaningful if flight time is held constant, or the lead points differ because
  // the shots take different times rather than because they follow different paths.
  attack: { domain: 'air', rangeFp: 8192, cadenceTicks: 60, travelTicks: 1 },
  effects: [{ kind: 'direct', form: 'aoe', damage: 8, radiusFp: 384 }],
};

const RULESET = testRuleset(SPEC, {
  extraCreeps: [FLYER_DEF],
  extraTowers: [GROUND_TOWER, AIR_TOWER, AOE_GROUND_TOWER, AOE_AIR_TOWER],
});
const FIELD = RULESET.board.field;
const GRID = RULESET.board.grid;
const SF_NUM = RULESET.balance.slowFloorNum;
const SF_DEN = RULESET.balance.slowFloorDen;

/** One tower at (5,5) — footprint centre (1536,1536) — of the given catalog id,
 *  generous range so acquisition tests need not fuss over exact geometry. */
function oneTower(towerId: string, targetId = 0, nextFireTick = 0): TowerArrays {
  const def = RULESET.towerById[towerId];
  if (def === undefined) throw new Error(`oneTower: unresolved towerId '${towerId}'`);
  return {
    id: [100],
    col: [5],
    row: [5],
    spend: [def.cost], // `forEachValidTower` requires `spend === def.cost` exactly
    targetId: [targetId],
    nextFireTick: [nextFireTick],
    towerId: [towerId],
  };
}

/** A resting-creeps SoA row builder, `creepId` overridable (mirrors
 *  story-stun.test.ts's own extension of story-aoe.test.ts's `restingCreeps`). */
function restingCreeps(
  rows: ReadonlyArray<{
    readonly id: number;
    readonly col: number;
    readonly row: number;
    readonly hp: number;
    readonly creepId?: string;
  }>,
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
    creepId: rows.map((r) => r.creepId ?? 'normal'),
    slowMulFp: rows.map(() => 0),
    slowUntilTick: rows.map(() => 0),
    stunUntilTick: rows.map(() => 0),
  };
}

/** A creep whose DERIVED point is exactly `(px,py)` — a progress-0 transitional
 *  row (mirrors combat.test.ts's `creepAtPoint`), `creepId` overridable. */
function creepAtPoint(
  id: number,
  px: number,
  py: number,
  hp: number,
  creepId: string,
): CombatCreeps {
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
    creepId: [creepId],
    slowMulFp: [0],
    slowUntilTick: [0],
    stunUntilTick: [0],
  };
}

describe('domain filtering on the sticky-HOLD path, not just fresh acquisition (M2-S7)', () => {
  // `covered` gates BOTH the hold check and the acquire candidate, and combat.ts's own
  // comment says why: "the two must agree or a tower could hold a target it may not fire
  // on." Every other domain-acquisition test builds its tower with the default
  // `targetId = 0`, so they all exercise the fresh-acquire branch only — narrowing the
  // filter to acquisition alone left the whole suite green (ship-review, M2-S7).
  //
  // This is a determinism concern, not a cosmetic one: `targetId` and `nextFireTick` are
  // hashed SimState columns, so a forged or restored lock on an out-of-domain creep would
  // keep firing once per cadence and diverge the world hash with no witness.
  it('an air-domain tower drops a pre-existing lock on a GROUND creep instead of firing on it', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 50, creepId: 'normal' }]);
    const towers = oneTower('air-tower', 1); // already locked onto the ground creep
    const out = runCombat(
      creeps,
      towers,
      [],
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    expect(towers.targetId[0]).toBe(0); // the lock is cleared, not held
    expect(out.impacts).toHaveLength(0); // and nothing was fired at it
    expect(out.creeps.hp[0]).toBe(50); // the ground creep is untouched
  });

  it('a ground-domain tower drops a pre-existing lock on a FLYER, the mirror case', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 50, creepId: 'flyer' }]);
    const towers = oneTower('ground-tower', 1);
    const out = runCombat(
      creeps,
      towers,
      [],
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    expect(towers.targetId[0]).toBe(0);
    expect(out.impacts).toHaveLength(0);
    expect(out.creeps.hp[0]).toBe(50);
  });
});

describe("predictBlastPoint's domain argument — a blast leads a flyer along the LINE, not the field", () => {
  // Without this, hardcoding `predictBlastPoint`'s `domain` to 'ground' keeps every other
  // test green (ship-review, M2-S7): the lead point is only observable through a blast
  // impact, and no existing blast test targets a flyer. The discriminator is a creep
  // placed OFF the entrance→exit row, where the octile flow-field route and the straight
  // line to the exit genuinely diverge — on the row itself they coincide and nothing
  // could be witnessed.
  // A wall down col 6, rows 0-4. A GROUND creep at (5,2) must detour around it (its
  // first descent step turns south); a flyer ignores it and continues east along the
  // line. On an OPEN board the octile field and the straight line coincide almost
  // everywhere, so without terrain there is nothing to witness.
  const walled = (() => {
    const mask = new Uint8Array(GRID.width * GRID.height);
    for (let row = 0; row <= 4; row++) mask[row * GRID.width + 6] = 1;
    return computeDistanceField(GRID, mask);
  })();

  function blastAt(creepId: string): { x: number; y: number } {
    const creeps = restingCreeps([{ id: 1, col: 5, row: 2, hp: 50, creepId }]);
    const towers = oneTower(creepId === 'flyer' ? 'aoe-air-tower' : 'aoe-ground-tower');
    const out = runCombat(
      creeps,
      towers,
      [],
      [],
      0,
      0,
      walled,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    const blast = out.impacts.find((i) => i.kind === 'blast');
    if (blast === undefined || blast.kind !== 'blast') throw new Error('no blast impact fired');
    return { x: blast.x, y: blast.y };
  }

  it('leads a flyer to a different point than the identical ground creep at the same cell', () => {
    const air = blastAt('flyer');
    const ground = blastAt('normal');
    // The whole point: if the domain argument were ignored, these would be identical.
    expect(air).not.toEqual(ground);
    // The air lead advances along the line toward the exit…
    expect(air.x).toBeGreaterThan(cx(5));
    // …and does so FLAT here, which is the rule working rather than a bug: the ray from
    // (5,2) to exit (13,6) is (8,4), so the orthogonal step E and the diagonal SE tie at
    // |cross| = 4, and E precedes SE in the canonical neighbour order. A 2:1 ray is
    // walked as flat steps interleaved with diagonals, not as a diagonal run. The GROUND
    // route from the same cell descends the octile field instead, which is exactly the
    // divergence the inequality above pins.
    expect(air.y).toBe(cy(2));
    expect(ground.y).not.toBe(air.y);
  });
});

describe('a flyer traverses the board end-to-end through step() (M2-S7)', () => {
  // The only other air-movement test asserts a single `advanceCreep` call is `!== 'drop'`
  // (ship-review, M2-S7). That proves a flyer is not deleted over a tower; it does NOT
  // prove one actually crosses a board and reaches the exit under the real tick loop —
  // the line-follow rule could stall, oscillate, or never terminate and that assertion
  // would still hold. This is the end-to-end witness.
  it('flies the entrance→exit line over a tower standing in its path, and leaks', () => {
    const s = createInitialState(1, RULESET);
    // A ground tower planted ON the row-6 flight line. A ground creep would have to
    // route around it; a flyer goes straight over.
    step(s, RULESET, [{ kind: 'placeTower', anchor: { col: 5, row: 6 }, towerId: 'basic' }]);
    expect(s.towers.id).toHaveLength(1);

    const livesBefore = s.lives;
    pushCreep(s, { id: 900, hp: 50, col: 0, row: 6, creepId: FLYER_DEF.id });

    // Bounded loop — if the heading rule fails to terminate, this exits and the
    // assertions below fail loudly rather than hanging the suite.
    let ticks = 0;
    while (s.creeps.id.includes(900) && ticks < 400) {
      step(s, RULESET, []);
      ticks++;
    }

    expect(s.creeps.id).not.toContain(900); // gone from the board
    expect(s.lives).toBe(livesBefore - 1); // by LEAKING at the exit, not by being dropped
    expect(ticks).toBeLessThan(400); // it actually converged
  });
});

describe('resolveCreepDomain — the shared totality rail', () => {
  it('an unresolved creepId (absent from creepById) falls back to ground', () => {
    expect(resolveCreepDomain(RULESET.creepById, 'ghost-creep-id')).toBe('ground');
  });
  it('a non-string creepId (forged/ragged column) falls back to ground', () => {
    expect(resolveCreepDomain(RULESET.creepById, undefined)).toBe('ground');
    expect(resolveCreepDomain(RULESET.creepById, 42)).toBe('ground');
  });
  it('a resolved air creepId returns air', () => {
    expect(resolveCreepDomain(RULESET.creepById, 'flyer')).toBe('air');
  });
});

describe('remainingRouteDist (air) — metric boundaries', () => {
  it('equal converted distances (identical points) tie-break to the lower creep id', () => {
    // Two flyers at the EXACT same point — trivially equal converted distance.
    const creeps: CombatCreeps = {
      id: [5, 2],
      hp: [20, 20],
      bounty: [1, 1],
      speed: [26, 26],
      fromX: [cx(7), cx(7)],
      fromY: [cy(6), cy(6)],
      headCol: [7, 7],
      headRow: [6, 6],
      progress: [0, 0],
      wave: [0, 0],
      creepId: ['flyer', 'flyer'],
      slowMulFp: [0, 0],
      slowUntilTick: [0, 0],
      stunUntilTick: [0, 0],
    };
    const towers = oneTower('air-tower');
    runCombat(
      creeps,
      towers,
      [],
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    expect(towers.targetId[0]).toBe(2); // lower id wins the tie
  });

  it('floors a non-perfect-square straight-line distance to tie with an exact one — not the strictly-nearer raw distance', () => {
    // Exit centre (13,6) = (3456,1664). Flyer A sits exactly 500 fp from the exit
    // (dx=-300, dy=-400 ⇒ dx²+dy²=250000=500², isqrt EXACT). Flyer B sits at
    // dx=-300, dy=-401 ⇒ dx²+dy²=250801 — NOT a perfect square (500²=250000 ≤
    // 250801 < 501²=251001) — so `isqrt` FLOORS it to 500 too: the two converted
    // distances are EQUAL despite B's raw distance being strictly larger. Without
    // flooring, A (exactly nearer) would win regardless of id; assigning the
    // LOWER id to B and asserting B wins is what proves the metric floors rather
    // than orders by exact distance.
    const exitX = 13 * 256 + 128;
    const exitY = 6 * 256 + 128;
    const a = creepAtPoint(9, exitX - 300, exitY - 400, 20, 'flyer'); // exact 500
    const b = creepAtPoint(3, exitX - 300, exitY - 401, 20, 'flyer'); // floors to 500
    const creeps: CombatCreeps = {
      id: [...a.id, ...b.id],
      hp: [...a.hp, ...b.hp],
      bounty: [...a.bounty, ...b.bounty],
      speed: [...a.speed, ...b.speed],
      fromX: [...a.fromX, ...b.fromX],
      fromY: [...a.fromY, ...b.fromY],
      headCol: [...a.headCol, ...b.headCol],
      headRow: [...a.headRow, ...b.headRow],
      progress: [...a.progress, ...b.progress],
      wave: [...a.wave, ...b.wave],
      creepId: [...a.creepId, ...b.creepId],
      slowMulFp: [...a.slowMulFp, ...b.slowMulFp],
      slowUntilTick: [...a.slowUntilTick, ...b.slowUntilTick],
      stunUntilTick: [...a.stunUntilTick, ...b.stunUntilTick],
    };
    const towers = oneTower('air-tower');
    runCombat(
      creeps,
      towers,
      [],
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    expect(towers.targetId[0]).toBe(3); // B (lower id) wins the FLOORED tie
  });
});

describe('a ground blast leaves a flyer inside its radius untouched', () => {
  it('damages the ground creep but not the flyer sharing the same point', () => {
    const creeps: CombatCreeps = {
      id: [1, 2],
      hp: [100, 20],
      bounty: [1, 1],
      speed: [26, 26],
      fromX: [cx(7), cx(7)],
      fromY: [cy(6), cy(6)],
      headCol: [7, 7],
      headRow: [6, 6],
      progress: [0, 0],
      wave: [0, 0],
      creepId: ['normal', 'flyer'], // ground, air — same point, same blast radius
      slowMulFp: [0, 0],
      slowUntilTick: [0, 0],
      stunUntilTick: [0, 0],
    };
    const impact: Impact = {
      kind: 'blast',
      impactTick: 0,
      x: cx(7),
      y: cy(6),
      radiusFp: 300,
      sourceId: 100,
      domain: 'ground',
      effects: [{ kind: 'direct', amount: 15 }],
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
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    const groundIdx = result.creeps.id.indexOf(1);
    const flyerIdx = result.creeps.id.indexOf(2);
    expect(result.creeps.hp[groundIdx]).toBe(100 - 15);
    expect(result.creeps.hp[flyerIdx]).toBe(20); // untouched
  });

  it('blastMembers itself excludes the flyer from a ground-masked radius scan', () => {
    const creeps = restingCreeps([
      { id: 1, col: 7, row: 6, hp: 100, creepId: 'normal' },
      { id: 2, col: 7, row: 6, hp: 20, creepId: 'flyer' },
    ]);
    const imp = { x: cx(7), y: cy(6), radiusFp: 50, domain: 'ground' as const };
    expect(blastMembers(creeps, GRID, RULESET.creepById, imp)).toEqual([0]); // ground only
  });
});

describe('a targeted impact from a sold source still carries its mask', () => {
  it('resolves against an air creep purely from the fire-time snapshot, with no live tower present', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 20, creepId: 'flyer' }]);
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 999_999, // no tower with this id exists — simulates a sold source
      domain: 'air',
      effects: [{ kind: 'direct', amount: 8 }],
    };
    const result = runCombat(
      creeps,
      emptyTowers(), // NO live towers — the mask must not be re-derived from tower state
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    expect(result.creeps.hp[0]).toBe(20 - 8); // still landed — the mask travelled with the impact
  });
});

describe('a ground-mask targeted impact against an air creep: no effect, no event, RNG unchanged', () => {
  it('the flyer takes no damage, no impact event is emitted, and the RNG state does not advance', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 20, creepId: 'flyer' }]);
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 100,
      domain: 'ground', // does not cover the air creep
      effects: [
        { kind: 'direct', amount: 8 },
        { kind: 'stun', chanceNum: 256, durationTicks: 20 }, // would ALWAYS draw+land if reached
      ],
    };
    const events: StepEvents = { impactPoints: [], fired: [] };
    const rng = new Rng(TEST_RNG_SEED);
    const before = rng.getState();
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      rng,
      events,
    );
    expect(result.creeps.hp[0]).toBe(20); // no effect
    expect(events.impactPoints).toEqual([]); // no event
    expect(rng.getState()).toBe(before); // no RNG draw — the wasted-shot rule, no desync
  });
});

describe('domain filtering at acquisition', () => {
  it('an air-domain tower cannot acquire a ground creep, and a ground-domain tower cannot acquire a flyer', () => {
    const creeps = restingCreeps([
      { id: 1, col: 7, row: 6, hp: 100, creepId: 'normal' },
      { id: 2, col: 7, row: 6, hp: 20, creepId: 'flyer' },
    ]);
    const groundTowers = oneTower('ground-tower');
    runCombat(
      creeps,
      groundTowers,
      [],
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    expect(groundTowers.targetId[0]).toBe(1); // never the flyer

    const airTowers = oneTower('air-tower');
    runCombat(
      creeps,
      airTowers,
      [],
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    expect(airTowers.targetId[0]).toBe(2); // never the ground creep
  });
});

describe('an unresolved creepId falls back to ground at the four call sites in this file (the fifth, placement, is in tower.test.ts)', () => {
  it('TARGETING: an unresolved-creepId row is acquired by a ground tower, never by an air-only tower', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 100, creepId: 'ghost-creep-id' }]);
    const groundTowers = oneTower('ground-tower');
    runCombat(
      creeps,
      groundTowers,
      [],
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    expect(groundTowers.targetId[0]).toBe(1);

    const airTowers = oneTower('air-tower');
    runCombat(
      creeps,
      airTowers,
      [],
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    expect(airTowers.targetId[0]).toBe(0); // not acquired — unresolved defaults ground
  });

  it('MOVEMENT: the resolver composed with advanceCreep drops an unresolved row on blocked terrain, exactly like a ground row', () => {
    // WHY THIS IS A DIRECT-CALL TEST AND NOT A `step()` TEST (ship-review, M2-S7).
    // An earlier draft ran this through `step()` with a forged unresolved-creepId row
    // and asserted the row vanished. That test could not fail: `step()` calls
    // `coerceSoa` (index.ts) FIRST, and its creepId totality pass unconditionally drops
    // any row whose id does not resolve in `creepById` — before the movement phase runs
    // at all. The row disappeared no matter what domain the movement site resolved, so
    // the assertion witnessed `coerceSoa`, not the fallback. Mutating the resolver to
    // `?? 'air'` left that draft GREEN while five sibling tests went red.
    //
    // So the movement call site's ground fallback is UNREACHABLE in the authoritative
    // path by construction — which is a fact worth recording rather than papering over.
    // What remains genuinely testable is the composition itself: the resolver returns
    // `ground` for an unresolved id, and `advanceCreep` given `ground` drops a row
    // standing on blocked/unreachable terrain. Both halves are exercised below, and the
    // `?? 'air'` mutation now turns this red.
    const width = 5;
    const height = 5;
    const blockedMask = new Uint8Array(width * height);
    blockedMask[2 * width + 2] = 1; // (2,2) — a tower footprint
    const dist = new Int32Array(width * height).fill(-1);
    dist[2 * width + 4] = 0; // (4,2) exit
    const field: DistanceField = { width, height, exit: { col: 4, row: 2 }, dist, blockedMask };

    // The resolver's own output is the input to movement — no hand-passed literal, or
    // the composition is not what is under test.
    const resolved = resolveCreepDomain({ normal: { domain: 'ground' } }, 'unresolved-ghost-id');
    expect(resolved).toBe('ground');

    const outcome = advanceCreep(
      field,
      500,
      50,
      cellCenterX(2),
      cellCenterY(2),
      2,
      2,
      0,
      26,
      resolved,
    );
    expect(outcome).toEqual({ kind: 'drop' });

    // Control: the SAME row resolved as air survives — which is exactly what a wrong
    // fallback would produce, and what makes the assertion above load-bearing.
    expect(
      advanceCreep(field, 500, 50, cellCenterX(2), cellCenterY(2), 2, 2, 0, 26, 'air').kind,
    ).not.toBe('drop');
  });

  it('IMPACT RESOLUTION: a targeted impact with an air mask is rejected against an unresolved-creepId row; a ground mask lands', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 100, creepId: 'ghost-creep-id' }]);
    const airMasked: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 100,
      domain: 'air',
      effects: [{ kind: 'direct', amount: 10 }],
    };
    const rejected = runCombat(
      creeps,
      emptyTowers(),
      [airMasked],
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    expect(rejected.creeps.hp[0]).toBe(100); // rejected — unresolved defaults ground

    const groundMasked: Impact = { ...airMasked, domain: 'ground' };
    const accepted = runCombat(
      creeps,
      emptyTowers(),
      [groundMasked],
      [],
      0,
      0,
      FIELD,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(TEST_RNG_SEED),
    );
    expect(accepted.creeps.hp[0]).toBe(100 - 10); // accepted — ground mask covers the fallback
  });

  it('BLAST MEMBERSHIP: an unresolved-creepId row is excluded from an air-masked scan, included in a ground-masked one', () => {
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 100, creepId: 'ghost-creep-id' }]);
    const airImp = { x: cx(7), y: cy(6), radiusFp: 50, domain: 'air' as const };
    expect(blastMembers(creeps, GRID, RULESET.creepById, airImp)).toEqual([]);
    const groundImp = { x: cx(7), y: cy(6), radiusFp: 50, domain: 'ground' as const };
    expect(blastMembers(creeps, GRID, RULESET.creepById, groundImp)).toEqual([0]);
  });
});
