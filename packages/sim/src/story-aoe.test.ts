// story-aoe.test.ts — M2 Story 4a: direct damage's AREA form. Blast resolution
// (inclusive-boundary radius membership, creep-id traversal order, the fire-time
// lead-and-clamp prediction, dead-target-in-flight, zero-member events, no-status-
// on-a-lethal-hit), the sv8 form-uniform/radius-uniform/AOE_SCAN_CEILING compiler
// gates, forged-blast totality, and the done-criterion showcase scenario (a wave of
// fragile `swarm`-like creeps cleared by one well-placed blast tower).

import { describe, it, expect } from 'vitest';
import { createInitialState, step, isTerminalPhase, hashSimState } from './index';
import { runCombat, emptyCreeps, type CombatCreeps, type Impact, type StepEvents } from './combat';
import { emptyTowers, MAX_TOWERS } from './tower';
import { compileRuleset, RulesetError, AOE_SCAN_CEILING } from './ruleset';
import { testBundle, testRuleset, TEST_AOE_TOWER, TEST_SWARM_CREEP } from './test-support';

const LANE = {
  widthTiles: 14,
  heightTiles: 14,
  entrance: { col: 0, row: 6 },
  exit: { col: 13, row: 6 },
} as const;

const cx = (col: number): number => col * 256 + 128;
const cy = (row: number): number => row * 256 + 128;

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
  };
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
      effects: [{ kind: 'direct', amount: 10 }],
    };
    const onResult = runCombat(
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
    const beyondResult = runCombat(
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
      effects: [{ kind: 'direct', amount: 15 }],
    };
    const result = runCombat(
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
      effects: [{ kind: 'direct', amount: 15 }],
    };
    const resultA = runCombat(
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
    const resultB = runCombat(
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
});

describe('blast resolution — lead-and-clamp (fire-time prediction reuses advanceCreep)', () => {
  it('a target whose predicted flight would leak lands the blast at the EXIT CENTRE', () => {
    const towers = { ...emptyTowers() };
    towers.id.push(100);
    towers.col.push(5);
    towers.row.push(5);
    towers.spend.push(TEST_AOE_TOWER.cost);
    towers.targetId.push(0);
    towers.nextFireTick.push(0);
    towers.towerId.push('aoe');

    // A creep in range (tower footprint centre (1536,1536), rangeFp 1024) with an
    // enormous per-tick speed: `travelTicks(8) × effectiveSpeedFp(huge)` vastly
    // exceeds the board's max route length, so `advanceCreep`'s walk reaches the
    // exit and the predicted point clamps there (the loop-bound argument,
    // `predictBlastPoint`'s doc, combat.ts).
    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 10_000 }]);
    creeps.speed[0] = 1_000_000;

    const result = runCombat(
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
});

describe('blast resolution — fired StepEvents carries the scheduled destination (M2-S4a step 12)', () => {
  it('a blast tower firing emits a kind:"blast" fired event whose destX/destY match the resolved impact point', () => {
    const towers = { ...emptyTowers() };
    towers.id.push(100);
    towers.col.push(5);
    towers.row.push(5);
    towers.spend.push(TEST_AOE_TOWER.cost);
    towers.targetId.push(0);
    towers.nextFireTick.push(0);
    towers.towerId.push('aoe');

    const creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 10_000 }]);
    const events: StepEvents = { impactPoints: [], fired: [] };
    const result = runCombat(
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
    const towers = { ...emptyTowers() };
    towers.id.push(100);
    towers.col.push(5);
    towers.row.push(5);
    towers.spend.push(TEST_AOE_TOWER.cost);
    towers.targetId.push(0);
    towers.nextFireTick.push(0);
    towers.towerId.push('aoe');

    // Tick 0: fire at a resting, in-range creep (id 1).
    const t0Creeps = restingCreeps([{ id: 1, col: 7, row: 6, hp: 10_000 }]);
    const t0 = runCombat(
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
    const result = runCombat(
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
    expect(result.creeps.hp[0]).toBeLessThan(100); // creep 2 was hit — the blast was NOT wasted
    expect(events.impactPoints).toEqual([{ x: blast.x, y: blast.y, radiusFp: blast.radiusFp }]);
  });

  it('a zero-member blast (nobody in radius) still emits exactly one impactPoints event', () => {
    const impact: Impact = {
      kind: 'blast',
      impactTick: 0,
      x: cx(7),
      y: cy(6),
      radiusFp: 50,
      effects: [{ kind: 'direct', amount: 10 }],
    };
    const events: StepEvents = { impactPoints: [], fired: [] };
    const result = runCombat(
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

describe('blast resolution — a lethal blast applies no statuses', () => {
  it('a creep killed by the direct pass gets no slow from the same blast; a surviving sibling does', () => {
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
      effects: [
        { kind: 'direct', amount: 8 },
        { kind: 'slow', mulFp: 128, durationTicks: 30 },
      ],
    };
    const result = runCombat(
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
      result = runCombat(
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

describe('the done-criterion scenario (Codex R1-13): one blast tower clears a wave of fragile swarm-like creeps', () => {
  // A minimal synthetic ruleset fixture, built INLINE (never importing
  // `@wynding/content` — the real `splash`/`swarm` catalog entries are Phase 2's,
  // someone else's work, not yet in `wynding-core.json`): one `aoe` tower
  // (`TEST_AOE_TOWER`, mirroring `splash`'s exact numbers) and a wave of 16
  // `swarm`-shaped creeps (`TEST_SWARM_CREEP`: hp 7, speed 30 — dies to one blast
  // whose damage is 8), spaced tightly (5 ticks) so several are caught by one
  // blast's radius.
  const SHOWCASE = testRuleset(LANE, {
    towers: [TEST_AOE_TOWER],
    extraCreeps: [TEST_SWARM_CREEP],
    waves: [{ waveCount: 16, waveSpacing: 5, countdownTicks: 1, creepId: 'swarm' }],
  });

  function runShowcase(): { state: ReturnType<typeof createInitialState>; ticks: number } {
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
    return { state, ticks };
  }

  it('reaches a terminal state with a pinned world-hash', () => {
    const { state, ticks } = runShowcase();
    expect(isTerminalPhase(state.phase)).toBe(true);
    expect(ticks).toBeLessThan(5_000);
    // GOLDEN — a behavior change here requires re-pinning both values together.
    expect(state.phase).toBe('won');
    expect(hashSimState(state)).toBe('586d1afa');
  });
});
