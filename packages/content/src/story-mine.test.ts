// story-mine.test.ts — M2 Story 9: the `mine` burst tower, measured against the shipped
// bundle.
//
// LOCATION NOTE, same reasoning as `story-support.test.ts`'s own header: this file lives
// beside `parity.test.ts` (not in `packages/sim`, which cannot import `@wynding/content`)
// so every scenario below runs the REAL shipped `wynding-core` bundle through
// `compileRuleset` → `step()`, not a hand-assembled replica of the mine.
//
// Boundary cases that belong in SIM unit tests, already covered by
// `packages/sim/src/story-burst.test.ts` and NOT duplicated here: the `inRange`
// inclusive edge at the raw predicate level, the `MAX_IN_FLIGHT_IMPACTS`-full no-op, and
// simultaneous-multi-mine ordering.
//
// PURPOSE: witnessing M2 Story 9's own done-criteria (m2.md Story 9, `mine`'s ruled
// numbers — trigger 2.25 tiles / 576 fp, blast radius 2.5 tiles / 640 fp, damage 45)
// against the shipped bundle:
//   1. a triggered mine deletes its own row at the fire tick;
//   2. creeps re-route from the NEXT movement step, with no stale-maze step;
//   3. the discharge still lands at T+1, for 45, from a tower that no longer exists;
//   4. pre-fire sell refunds 4, and a sell at tick T beats a trigger at T;
//   5. the blast is centred on the MINE, not the creep that tripped it;
//   6. the trigger boundary, both sides — a diagonal-elbow creep trips it, a two-rings-out
//      creep does not;
//   7. `armored` dies (45 lands 39 through armor 6, hp 36 — 3 to spare);
//   8. a beacon-adjacent mine deals 67, composing with zero special-casing.
//
// Regenerate every literal below with:
//   pnpm --filter @wynding/content exec vitest run story-mine
// The goldens are `console.log`'d on every run — they are MEASURED, never hand-computed.

import { describe, it, expect } from 'vitest';
import {
  compileRuleset,
  createInitialState,
  step,
  projectCreep,
  computeDistanceField,
  shortestPath,
  type SimInput,
  type SimState,
  type Grid,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';

/** Fixed-point cell size (`FP_ONE`, `@wynding/engine`), inlined rather than imported —
 *  same reasoning as `story-flying-wave.test.ts`'s own inlined constant: pulling in the
 *  engine package for one constant would add a runtime dependency edge this file
 *  doesn't otherwise need. Used only to derive footprint centres in fixed-point. */
const FP_ONE = 256;

/** One snapshotted effect on an in-flight impact — same derivation as
 *  `story-support.test.ts`'s `EffectPrimitive`: `EffectPrimitive` is sim-internal, so this
 *  type is DERIVED from the exported `SimState` rather than imported, and cannot drift. */
type EffectPrimitive = SimState['impacts'][number]['effects'][number];

/** Fixed seed — same convention as parity.test.ts / story-support.test.ts. */
const SCENARIO_SEED = 0x5eed;

interface Placement {
  readonly tick: number;
  readonly anchor: { readonly col: number; readonly row: number };
  readonly towerId: string;
}

interface Sell {
  readonly tick: number;
  readonly placementIndex: number;
}

interface CapturedImpact {
  readonly tick: number; // tick the impact was CREATED (fired)
  readonly impactTick: number; // tick it RESOLVES
  readonly sourceId: number;
  readonly kind: string;
  readonly x?: number; // 'blast' only
  readonly y?: number; // 'blast' only
  readonly effects: readonly EffectPrimitive[];
}

interface TowerSnapshot {
  readonly id: number;
  readonly col: number;
  readonly row: number;
}

interface CreepSnapshot {
  readonly id: number;
  readonly creepId: string;
  readonly hp: number;
  /** The DERIVED point (`projectCreep`, the same seam presentation reads) — `null` for a
   *  non-canonical row, which no legal run produces. */
  readonly point: { readonly x: number; readonly y: number } | null;
}

interface SceneResult {
  readonly impacts: readonly CapturedImpact[];
  /** Tower rows standing AFTER the step at each tick, keyed by tick. */
  readonly towersByTick: ReadonlyMap<number, readonly TowerSnapshot[]>;
  /** Live creep snapshots AFTER the step at each tick, keyed by tick. */
  readonly creepsByTick: ReadonlyMap<number, readonly CreepSnapshot[]>;
  /** `state.bounty` AFTER the step at each tick, keyed by tick. */
  readonly bountyByTick: ReadonlyMap<number, number>;
  /** `state.lives` AFTER the step at each tick, keyed by tick. */
  readonly livesByTick: ReadonlyMap<number, number>;
  readonly state: SimState;
  readonly idByPlacement: readonly (number | undefined)[];
}

/**
 * Run the shipped bundle for `untilTick` ticks, placing `placements` on their scheduled
 * ticks, selling on `sells`, and buffering `callWaveEarly` on `earlyCallTicks` — capturing
 * every impact, and the full tower/creep/bounty state, after every tick's step.
 *
 * Impacts are captured by `(sourceId, impactTick)` rather than object identity — mirrors
 * `story-support.test.ts`'s own `runScene`, same reasoning (an impact stays resident in
 * `SimState.impacts` for its whole flight; `snapshotEffects` builds a fresh array per fire,
 * so captured arrays are never aliased by a later shot).
 */
function runScene(
  placements: readonly Placement[],
  untilTick: number,
  sells: readonly Sell[] = [],
  earlyCallTicks: readonly number[] = [],
): SceneResult {
  const bundle = getBundledRuleset();
  const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
  let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
  const seen = new Set<string>();
  const impacts: CapturedImpact[] = [];
  const towersByTick = new Map<number, readonly TowerSnapshot[]>();
  const creepsByTick = new Map<number, readonly CreepSnapshot[]>();
  const bountyByTick = new Map<number, number>();
  const livesByTick = new Map<number, number>();
  // Entity ids are assigned by the sim, so a sell has to name the id the placement
  // actually got — resolved by anchor after each step rather than assumed.
  const idByPlacement: (number | undefined)[] = placements.map(() => undefined);

  for (let tick = 0; tick < untilTick; tick++) {
    const inputs: SimInput[] = [];
    for (const p of placements) {
      if (p.tick === tick)
        inputs.push({ kind: 'placeTower', anchor: p.anchor, towerId: p.towerId });
    }
    for (const s of sells) {
      if (s.tick !== tick) continue;
      const id = idByPlacement[s.placementIndex];
      if (id === undefined) throw new Error(`sell at tick ${tick}: placement never resolved`);
      inputs.push({ kind: 'sellTower', tower: id });
    }
    if (earlyCallTicks.includes(tick)) inputs.push({ kind: 'callWaveEarly' });
    state = step(state, ruleset, inputs);

    for (let i = 0; i < placements.length; i++) {
      if (idByPlacement[i] !== undefined) continue;
      const a = placements[i]!.anchor;
      for (let r = 0; r < state.towers.id.length; r++) {
        if (state.towers.col[r] === a.col && state.towers.row[r] === a.row) {
          idByPlacement[i] = state.towers.id[r] as number;
        }
      }
    }
    for (const im of state.impacts) {
      const key = `${im.sourceId}|${im.impactTick}`;
      if (seen.has(key)) continue;
      seen.add(key);
      impacts.push({
        tick,
        impactTick: im.impactTick,
        sourceId: im.sourceId,
        kind: im.kind,
        x: im.kind === 'blast' ? im.x : undefined,
        y: im.kind === 'blast' ? im.y : undefined,
        effects: [...im.effects],
      });
    }
    towersByTick.set(
      tick,
      state.towers.id.map((id, i) => ({
        id,
        col: state.towers.col[i]!,
        row: state.towers.row[i]!,
      })),
    );
    creepsByTick.set(
      tick,
      state.creeps.id.map((id, i) => ({
        id,
        creepId: state.creeps.creepId[i]!,
        hp: state.creeps.hp[i]!,
        point: projectCreep(state.creeps, i, ruleset.board.grid),
      })),
    );
    bountyByTick.set(tick, state.bounty);
    livesByTick.set(tick, state.lives);
  }
  return { impacts, towersByTick, creepsByTick, bountyByTick, livesByTick, state, idByPlacement };
}

/** The snapshotted amounts of an impact's `direct` primitives, in authored order. */
function directAmounts(impact: CapturedImpact): number[] {
  return impact.effects.filter((e) => e.kind === 'direct').map((e) => e.amount);
}

/** The 2×2 footprint centre for an anchor — the shared corner of its four cells, in
 *  fixed-point tile units. Same formula `combat.ts` itself uses for a burst tower's
 *  detonation point. */
function footprintCenter(col: number, row: number): { x: number; y: number } {
  return { x: (col + 1) * FP_ONE, y: (row + 1) * FP_ONE };
}

/** The first tick at which a tower row `id` is present in `towersByTick.get(tick - 1)` but
 *  gone from `towersByTick.get(tick)` — the tower's fire (or sell) tick. `undefined` if it
 *  never disappears — a scenario bug, not a legitimate outcome for any scene below. */
function findConsumptionTick(
  towersByTick: SceneResult['towersByTick'],
  id: number,
  untilTick: number,
): number | undefined {
  let wasStanding = false;
  for (let t = 0; t < untilTick; t++) {
    const standing = towersByTick.get(t)!.some((r) => r.id === id);
    if (wasStanding && !standing) return t;
    wasStanding = standing;
  }
  return undefined;
}

/** The `extraBlocked` mask `computeDistanceField` expects — one flag per grid cell, set
 *  for every cell any 2×2 tower footprint in `towers` occupies. The same rule
 *  `tower.ts`'s own placement/maze-invariant check applies to a candidate build, replayed
 *  here on a REAL captured tower snapshot so the reroute proof (criterion 2) uses the
 *  sim's own pathfinding entry point rather than a hand-rolled maze walk. */
function blockedMaskFor(grid: Grid, towers: readonly TowerSnapshot[]): Uint8Array {
  const mask = new Uint8Array(grid.width * grid.height);
  for (const t of towers) {
    for (const dc of [0, 1]) {
      for (const dr of [0, 1]) {
        const c = t.col + dc;
        const r = t.row + dr;
        if (c >= 0 && r >= 0 && c < grid.width && r < grid.height) mask[r * grid.width + c] = 1;
      }
    }
  }
  return mask;
}

// ---------------------------------------------------------------------------------
// GEOMETRY. The shipped board is 28×24 with entrance (0,11) and exit (27,11), so the
// undisturbed lane runs straight along row 11.
//
// LANE_MINE blocks that lane outright (anchor (5,10) → footprint cols 5-6, rows 10-11 —
// the SAME wall `determinism.test.ts`'s canonical scenario builds, proven to force a
// visible re-route): every wave-0 creep must detour around it, which is what criteria 1-3
// need (a mine that is itself an obstacle, tripped by the creep rounding it).
//
// OFF_LANE_MINE stands clear of the lane (anchor (10,9) → footprint cols 10-11, rows 9-10)
// but close enough (perpendicular distance 1.5 tiles) that a straight-lane creep still
// enters its 2.25-tile trigger ring — criteria 4/5/8 use this shape because it needs NO
// detour: the sell-vs-trigger race, the blast-centre proof, and the beacon composability
// check are all about the mine's OWN numbers, not about routing.
// ---------------------------------------------------------------------------------
const LANE_MINE = { col: 5, row: 10 } as const;
const OFF_LANE_MINE = { col: 10, row: 9 } as const;
const RUN_TICKS = 400;

describe('M2-S9 — the `mine` burst tower, measured against the shipped bundle', () => {
  describe('1/2/3 — the lane-blocking mine: self-deletion, the reroute boundary, the discharge', () => {
    const scene = runScene([{ tick: 0, anchor: LANE_MINE, towerId: 'mine' }], RUN_TICKS, [], [0]);
    const mineId = scene.idByPlacement[0]!;
    const fireTick = findConsumptionTick(scene.towersByTick, mineId, RUN_TICKS);

    it('1. the triggered mine deletes its own row at the fire tick', () => {
      // Mid-trace proof the feature engaged, BEFORE the terminal claims below: the mine
      // actually fired (produced an impact) rather than sitting armed for the whole run.
      console.log(`[story-mine] fire tick: ${fireTick}, impacts: ${scene.impacts.length}`);
      expect(scene.impacts.length).toBeGreaterThan(0);
      expect(fireTick).toBeDefined();
      const t = fireTick!;
      expect(scene.towersByTick.get(t - 1)!.some((r) => r.id === mineId)).toBe(true); // standing
      expect(scene.towersByTick.get(t)!.some((r) => r.id === mineId)).toBe(false); // gone
    });

    it('2. creeps re-route from the NEXT movement step — not the same step, not two later', () => {
      const t = fireTick!;
      const grid = compileRuleset(getBundledRuleset(), defaultBoardId(getBundledRuleset())).board
        .grid;
      // `t`'s OWN movement step precedes the consumption (combat runs after movement, same
      // tick) and reads the tower snapshot as it stood at the END of `t - 1` — still walled.
      const preField = computeDistanceField(
        grid,
        blockedMaskFor(grid, scene.towersByTick.get(t - 1)!),
      );
      // `t + 1`'s movement step reads the tower snapshot as it stood at the END of `t` —
      // the mine's row is already gone, so the wall cells are open.
      const postField = computeDistanceField(
        grid,
        blockedMaskFor(grid, scene.towersByTick.get(t)!),
      );
      const prePath = shortestPath(grid, preField)!;
      const postPath = shortestPath(grid, postField)!;
      console.log(
        `[story-mine] pre-consumption path near the wall: ` +
          `${JSON.stringify(prePath.filter((c) => c.col >= 3 && c.col <= 8))}`,
      );
      console.log(
        `[story-mine] post-consumption path near the wall: ` +
          `${JSON.stringify(postPath.filter((c) => c.col >= 3 && c.col <= 8))}`,
      );
      // The scenario is vacuous unless the wall genuinely forced a detour while standing.
      // `t`'s own field (still walled) detours through row 12 at the blocked columns —
      // the "not the same step" half: the fire tick's own movement still sees the wall.
      expect(prePath.some((c) => c.col === 5 && c.row === 12)).toBe(true);
      expect(prePath.some((c) => c.col === 6 && c.row === 12)).toBe(true);
      // The very next tick's field is already straight through — the "not two ticks
      // later" half: no extra tick of a stale maze.
      expect(postPath.every((c) => c.row === 11)).toBe(true);

      // …and CREEPS ACTUALLY WALK IT (ship-review, M2-S9). Everything above is derived
      // from captured tower snapshots, so on its own it proves the MAZE changed, not
      // that movement read the change — a stale-field bug in the movement phase would
      // leave every assertion above green. So observe the real creep positions the run
      // recorded: the mine's own four footprint cells (cols 5-6, rows 10-11) are a WALL
      // while it stands, so no creep can be inside them at any tick up to and including
      // the fire tick, and at least one must be afterwards once the gap opens.
      const inFootprint = (t2: number): boolean =>
        scene.creepsByTick
          .get(t2)!
          .some(
            (c) =>
              c.point !== null &&
              Math.floor(c.point.x / FP_ONE) >= LANE_MINE.col &&
              Math.floor(c.point.x / FP_ONE) <= LANE_MINE.col + 1 &&
              Math.floor(c.point.y / FP_ONE) >= LANE_MINE.row &&
              Math.floor(c.point.y / FP_ONE) <= LANE_MINE.row + 1,
          );
      const occupiedBefore: number[] = [];
      const occupiedAfter: number[] = [];
      for (let t2 = 0; t2 < RUN_TICKS; t2++) {
        if (!inFootprint(t2)) continue;
        (t2 <= t ? occupiedBefore : occupiedAfter).push(t2);
      }
      console.log(
        `[story-mine] ticks with a creep inside the mine's footprint — ` +
          `before/at fire tick ${t}: ${JSON.stringify(occupiedBefore)}, ` +
          `after: ${occupiedAfter.length} (first ${occupiedAfter[0] ?? 'none'})`,
      );
      expect(occupiedBefore).toEqual([]); // it was a wall — nothing could stand there
      expect(occupiedAfter.length).toBeGreaterThan(0); // the gap is genuinely walked
    });

    it('3. the discharge still lands at T+1, for 45, from a tower that no longer exists', () => {
      const t = fireTick!;
      const mineImpact = scene.impacts.find((i) => i.sourceId === mineId)!;
      expect(mineImpact).toBeDefined();
      console.log(`[story-mine] mine impact: ${JSON.stringify(mineImpact)}`);
      expect(mineImpact.kind).toBe('blast');
      expect(mineImpact.impactTick).toBe(t + 1);
      expect(directAmounts(mineImpact)).toEqual([45]);
      // The row is gone for good, including at the resolution tick.
      expect(scene.towersByTick.get(t + 1)!.some((r) => r.id === mineId)).toBe(false);
      // And it actually killed the creep that tripped it: whoever was standing at `t`
      // within the blast is gone by `t + 1`, with no life lost (a kill, not a leak).
      const beforeIds = new Set(scene.creepsByTick.get(t)!.map((c) => c.id));
      const afterIds = new Set(scene.creepsByTick.get(t + 1)!.map((c) => c.id));
      const vanished = [...beforeIds].filter((id) => !afterIds.has(id));
      console.log(`[story-mine] creeps vanishing at T+1: ${JSON.stringify(vanished)}`);
      expect(vanished.length).toBeGreaterThan(0);
      // "A kill, not a leak" is the load-bearing half — a creep also vanishes by
      // reaching the exit, which would cost a life and mean the blast did nothing.
      // Assert it rather than only saying it in a comment (ship-review, M2-S9).
      console.log(
        `[story-mine] lives at T=${scene.livesByTick.get(t)} T+1=${scene.livesByTick.get(t + 1)}`,
      );
      expect(scene.livesByTick.get(t + 1)).toBe(scene.livesByTick.get(t));
    });
  });

  describe('4 — pre-fire sell: refund 4, and a sell at tick T beats a trigger at T', () => {
    const baseline = runScene(
      [{ tick: 0, anchor: OFF_LANE_MINE, towerId: 'mine' }],
      RUN_TICKS,
      [],
      [0],
    );
    const mineId = baseline.idByPlacement[0]!;
    const fireTick = findConsumptionTick(baseline.towersByTick, mineId, RUN_TICKS)!;

    it('the baseline mine (no sell) fires on schedule — the contrast criterion 4 needs', () => {
      console.log(`[story-mine] off-lane mine fire tick: ${fireTick}`);
      expect(baseline.impacts.some((i) => i.sourceId === mineId)).toBe(true);
    });

    it('a same-tick sell beats the trigger: no impact, and the refund is 4', () => {
      const sold = runScene(
        [{ tick: 0, anchor: OFF_LANE_MINE, towerId: 'mine' }],
        RUN_TICKS,
        [{ tick: fireTick, placementIndex: 0 }],
        [0],
      );
      const soldMineId = sold.idByPlacement[0]!;
      // Mid-trace proof the sell landed on the SAME tick the trigger would have: the row
      // is gone starting exactly `fireTick`, matching the baseline's own fire tick.
      const soldConsumptionTick = findConsumptionTick(sold.towersByTick, soldMineId, RUN_TICKS);
      console.log(`[story-mine] sold-arm consumption tick: ${soldConsumptionTick}`);
      expect(soldConsumptionTick).toBe(fireTick);
      // It never fired — the input phase (sells) precedes combat (triggers) in `step()`.
      expect(sold.impacts.some((i) => i.sourceId === soldMineId)).toBe(false);

      // The refund is read as a WHOLE-TICK bounty delta, so it is only the refund if
      // nothing else paid out on that tick (ship-review, M2-S9). Kill bounty and the
      // wave-clear bonus are the two other sources; both require a creep to leave the
      // SoA, so an unchanged creep roster across the boundary rules out both, and the
      // delta is then attributable to the sell alone. Guard it rather than rely on the
      // scene happening to be quiet — a wave-schedule edit could make this test report
      // a wrong refund as a pass.
      const creepsBefore = sold.creepsByTick.get(fireTick - 1)!.length;
      const creepsAfter = sold.creepsByTick.get(fireTick)!.length;
      const bountyBeforeSell = sold.bountyByTick.get(fireTick - 1)!;
      const bountyAfterSell = sold.bountyByTick.get(fireTick)!;
      console.log(
        `[story-mine] bounty before sell=${bountyBeforeSell} after=${bountyAfterSell} ` +
          `(delta ${bountyAfterSell - bountyBeforeSell}); creeps ${creepsBefore}→${creepsAfter}`,
      );
      expect(creepsAfter).toBe(creepsBefore); // no kill bounty, no wave clear, on this tick
      expect(bountyAfterSell - bountyBeforeSell).toBe(4); // floor(0.75 x 6)
    });
  });

  describe('5 — the blast is centred on the mine, not the creep that tripped it', () => {
    it('the mine footprint centre and the triggering creep’s own point genuinely differ, yet the blast lands on the mine', () => {
      const scene = runScene(
        [{ tick: 0, anchor: OFF_LANE_MINE, towerId: 'mine' }],
        RUN_TICKS,
        [],
        [0],
      );
      const mineId = scene.idByPlacement[0]!;
      const fireTick = findConsumptionTick(scene.towersByTick, mineId, RUN_TICKS)!;
      const mineImpact = scene.impacts.find((i) => i.sourceId === mineId)!;
      const center = footprintCenter(OFF_LANE_MINE.col, OFF_LANE_MINE.row);

      // The creep that tripped it: alive at the fire tick, gone the tick after (test 3's
      // own proof, replayed here) — its own point at the moment it tripped the mine.
      const survivorsNextTick = new Set(scene.creepsByTick.get(fireTick + 1)!.map((c) => c.id));
      const triggeringCreep = scene.creepsByTick
        .get(fireTick)!
        .find((c) => !survivorsNextTick.has(c.id))!;
      expect(triggeringCreep).toBeDefined();
      console.log(
        `[story-mine] mine footprint centre: ${JSON.stringify(center)}, ` +
          `triggering creep's own point at the fire tick: ${JSON.stringify(triggeringCreep.point)}`,
      );
      // The scenario is vacuous unless these two points genuinely differ.
      expect(triggeringCreep.point!.x !== center.x || triggeringCreep.point!.y !== center.y).toBe(
        true,
      );
      expect(mineImpact.x).toBe(center.x);
      expect(mineImpact.y).toBe(center.y);
    });
  });

  describe('6 — the trigger boundary, both sides', () => {
    it('DOES trip: a creep rounding the mine’s own 2×2 corner — the diagonal-elbow dead zone ruling 2 closed', () => {
      // Reuses criteria 1-3's lane-blocking scene: the triggering creep's closest real
      // approach, over its WHOLE path (not just the fire tick), is the measured proof
      // that the spec's first-authored 2.0-tile trigger would have left this exact mine
      // inert forever (a diagonal corner-round never gets closer than 2.121 tiles), while
      // the ruled 2.25 correctly catches it.
      const scene = runScene([{ tick: 0, anchor: LANE_MINE, towerId: 'mine' }], RUN_TICKS, [], [0]);
      const mineId = scene.idByPlacement[0]!;
      const fireTick = findConsumptionTick(scene.towersByTick, mineId, RUN_TICKS)!;
      const center = footprintCenter(LANE_MINE.col, LANE_MINE.row);
      const survivorsNextTick = new Set(scene.creepsByTick.get(fireTick + 1)!.map((c) => c.id));
      const triggeringId = scene.creepsByTick
        .get(fireTick)!
        .find((c) => !survivorsNextTick.has(c.id))!.id;

      let minDistFp = Infinity;
      for (let t = 0; t <= fireTick; t++) {
        const row = scene.creepsByTick.get(t)!.find((c) => c.id === triggeringId);
        if (row?.point === null || row?.point === undefined) continue;
        const dx = row.point.x - center.x;
        const dy = row.point.y - center.y;
        minDistFp = Math.min(minDistFp, Math.sqrt(dx * dx + dy * dy));
      }
      console.log(
        `[story-mine] triggering creep's closest real approach: ${minDistFp.toFixed(2)} fp ` +
          `(${(minDistFp / 256).toFixed(3)} tiles) — old spec trigger 512 fp / 2.0 tiles, ` +
          `ruled trigger 576 fp / 2.25 tiles`,
      );
      // The dead-zone proof: this creep's real path never comes within the OLD 2.0-tile
      // trigger (512 fp) — an unruled mine would have sat inert for this exact creep —
      // yet it stays within the RULED 2.25-tile trigger (576 fp), which is why it fires.
      expect(minDistFp).toBeGreaterThan(512);
      expect(minDistFp).toBeLessThanOrEqual(576);
    });

    it('does NOT trip: a creep whose continuous minimum distance is 2.5 tiles / 640 fp — real margin on both sides', () => {
      // A mine standing 2.5 tiles perpendicular off the straight, undisturbed lane (no
      // detour: this mine does not block the lane) never comes within its own 2.25-tile
      // trigger from ANY point on that lane — the perpendicular offset alone already
      // exceeds the trigger, so no tick's discretization can accidentally cross it.
      const OFF_LANE_RING2 = { col: 10, row: 8 } as const; // footprint centre dy = 640 fp
      const center = footprintCenter(OFF_LANE_RING2.col, OFF_LANE_RING2.row);
      const scene = runScene(
        [{ tick: 0, anchor: OFF_LANE_RING2, towerId: 'mine' }],
        RUN_TICKS,
        [],
        [0],
      );
      const mineId = scene.idByPlacement[0]!;

      // Mid-trace proof this is a real, populated scene (not vacuously creep-free): the
      // wave actually ran past the mine's column range. ASSERTED, not just logged
      // (ship-review, M2-S9): every claim below is satisfiable by an empty scene — a
      // creep-free run leaves `minDistFp` at `Infinity` (which passes `>= 640`), emits
      // no impact, and leaves the mine standing, so all three would pass while proving
      // nothing about the trigger boundary. Every sibling test in this file carries an
      // explicit vacuity guard; this one was the outlier.
      const lastTickCreeps = scene.creepsByTick.get(RUN_TICKS - 1)!;
      console.log(
        `[story-mine] ring-2 scene: ${lastTickCreeps.length} creeps live at the final tick`,
      );
      expect(lastTickCreeps.length).toBeGreaterThan(0);

      // Confirm the construction: the CLOSEST any GROUND creep ever gets is >= 640 fp, so
      // the trigger boundary is never even approached, let alone crossed.
      //
      // Ground only, and the scoping is load-bearing rather than tidy (ship-review): the
      // mine's mask is `ground`, so `runCombat`'s domain filter means an AIR creep INSIDE
      // the 576 fp ring correctly does not trip it either. Measuring flyers here would
      // constrain a distance the behaviour under test does not depend on — and it passes
      // today only because `RUN_TICKS` stops short of the `flying` wave. A wave retune, a
      // longer window, or an air entry in an earlier wave would then turn this red for a
      // non-bug, reading as "the trigger boundary broke" while the sim behaved correctly.
      const bundle = getBundledRuleset();
      const catalog = compileRuleset(bundle, defaultBoardId(bundle)).creepById;
      const isGround = (creepId: string): boolean => catalog[creepId]?.domain === 'ground';
      let minDistFp = Infinity;
      let groundSamples = 0;
      for (let t = 0; t < RUN_TICKS; t++) {
        for (const row of scene.creepsByTick.get(t)!) {
          if (row.point === null || !isGround(row.creepId)) continue;
          groundSamples++;
          const dx = row.point.x - center.x;
          const dy = row.point.y - center.y;
          minDistFp = Math.min(minDistFp, Math.sqrt(dx * dx + dy * dy));
        }
      }
      console.log(
        `[story-mine] ring-2 scene: closest any GROUND creep ever got: ` +
          `${minDistFp.toFixed(2)} fp over ${groundSamples} samples (trigger 576 fp)`,
      );
      expect(groundSamples).toBeGreaterThan(0); // a ground-creep measurement really happened
      expect(Number.isFinite(minDistFp)).toBe(true); // a real measurement, not the Infinity seed
      expect(minDistFp).toBeGreaterThanOrEqual(640);

      // The mine never fires and is never consumed.
      expect(scene.impacts.some((i) => i.sourceId === mineId)).toBe(false);
      expect(scene.towersByTick.get(RUN_TICKS - 1)!.some((r) => r.id === mineId)).toBe(true);
    });
  });

  describe('7 — `armored` dies: 45 lands 39 through armor 6, hp 36 — 3 to spare', () => {
    // The SAME `basic` wall shape proven (story-support.test.ts's own comment, citing
    // `story-armored-wave.test.ts`) to clear waves 0-2 with zero leaks — relocated to
    // columns 20/22/24 (same relative spacing, so the same flanking mechanics apply) so
    // its towers' 4-tile range never reaches the entrance-side approach. The mine stands
    // there instead (off-lane, col 1, clear of the wall's own footprints even by column),
    // so the `armored` creep that trips it has taken NO prior fire — full 36 HP — which
    // is what isolates the mine's own 45-vs-armor-6 arithmetic from the wall's own
    // (separately proven) damage. Its build is held until tick 1350 — MEASURED to be
    // clear of every wave-0/1/2 creep still lingering near column 1 (the relocated wall
    // pulls the whole route up off row 11 well before column 20, so wave 2's `fast`
    // creeps are still passing near column 1 as late as tick ~1150; building the mine
    // any earlier fires it on one of THEM instead, consumed before the tick-by-tick
    // capture below ever sees it standing) and before wave 3 (armored, launching
    // ~tick 1400) arrives — so only an `armored` creep ever enters its trigger ring.
    const basicAnchors: { col: number; row: number }[] = [
      { col: 20, row: 10 },
      { col: 20, row: 12 },
      { col: 22, row: 10 },
      { col: 22, row: 12 },
      { col: 24, row: 10 },
      { col: 24, row: 12 },
    ];
    const ARMORED_MINE = { col: 1, row: 7 } as const; // off-lane, entrance side, untouched by the wall

    it('the mine kills the first armored creep to reach it, at full HP', () => {
      const placements: Placement[] = [
        { tick: 1350, anchor: ARMORED_MINE, towerId: 'mine' },
        ...basicAnchors.map((anchor, i) => ({ tick: i * 10, anchor, towerId: 'basic' })),
      ];
      const RUN_TICKS_ARMORED = 2000; // past wave 3's launch and full traversal
      const scene = runScene(placements, RUN_TICKS_ARMORED, [], []);
      const mineId = scene.idByPlacement[0]!;
      const fireTick = findConsumptionTick(scene.towersByTick, mineId, RUN_TICKS_ARMORED);
      console.log(`[story-mine] armored scene: fire tick ${fireTick}`);
      expect(fireTick).toBeDefined();
      const t = fireTick!;

      const mineImpact = scene.impacts.find((i) => i.sourceId === mineId)!;
      expect(mineImpact).toBeDefined();
      console.log(`[story-mine] armored scene: mine impact ${JSON.stringify(mineImpact)}`);
      expect(directAmounts(mineImpact)).toEqual([45]);

      // The triggering creep: alive at `t`, gone at `t + 1` — and its catalog id and HP
      // at the moment it tripped the mine, MEASURED (not assumed).
      const beforeRow = scene.creepsByTick.get(t)!;
      const afterIds = new Set(scene.creepsByTick.get(t + 1)!.map((c) => c.id));
      const triggeringCreep = beforeRow.find((c) => !afterIds.has(c.id))!;
      expect(triggeringCreep).toBeDefined();
      console.log(
        `[story-mine] armored scene: triggering creep ${JSON.stringify(triggeringCreep)}`,
      );
      expect(triggeringCreep.creepId).toBe('armored');
      // Full HP at the moment of impact — the exact arithmetic the ruling banks on: 45
      // damage - armor 6 = 39 through, against 36 HP, kills with 3 to spare. (At m2.md's
      // first-authored 40 damage, 34 through would have left it alive on 2 HP.)
      expect(triggeringCreep.hp).toBe(36);
      // Lives are unchanged across the resolution tick — a kill, not a leak.
      console.log(
        `[story-mine] armored scene: lives at t=${scene.livesByTick.get(t)} ` +
          `t+1=${scene.livesByTick.get(t + 1)}`,
      );
      expect(scene.livesByTick.get(t + 1)).toBe(scene.livesByTick.get(t));
    });
  });

  // m2.md claims the blast radius "deliberately exceeds the trigger range, so the creep
  // that trips it is always inside the kill zone". That is a DERIVED guarantee, not a
  // free one, and nothing pinned it until ship-review pointed out the gap (M2-S9).
  //
  // The creep gets a full movement phase between the two tests: the trigger fires during
  // tick T's combat (`inRange` at ≤ rangeFp), then tick T+1's MOVEMENT runs before the
  // impact resolves (`blastMembers`, the same `inRange` at ≤ radiusFp). So the creep can
  // walk `speedFp × travelTicks` away from the mine in between, and the guarantee holds
  // only while that is ≤ `radiusFp − rangeFp`. Derived from the shipped catalog rather
  // than hardcoded, so S10's `boss`, any faster ground creep, or a `travelTicks` bump
  // inside the profile's own 8-tick ceiling turns this red instead of quietly falsifying
  // the spec.
  describe("the kill-zone guarantee's own inequality, derived from the shipped catalog", () => {
    it('the fastest ground creep cannot outrun the blast in travelTicks', () => {
      const bundle = getBundledRuleset();
      const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
      const mine = ruleset.towerById['mine']!;
      expect(mine.attack?.mode).toBe('burst');
      const attack = mine.attack!;
      const blast = mine.effects.find((e) => e.kind === 'aoe');
      if (blast === undefined || blast.kind !== 'aoe') throw new Error('mine must carry an aoe');
      // Ground only — the mine's mask is `ground`, so a flyer's speed is irrelevant here.
      const groundSpeeds = Object.values(ruleset.creepById)
        .filter((c) => c !== undefined && c.domain === 'ground')
        .map((c) => c!.speedFp);
      const fastest = Math.max(...groundSpeeds);
      const margin = blast.radiusFp - attack.rangeFp;
      const drift = fastest * attack.travelTicks;
      console.log(
        `[story-mine] kill-zone inequality: fastest ground creep ${fastest} fp/tick × ` +
          `travelTicks ${attack.travelTicks} = ${drift} fp drift, against a ` +
          `${blast.radiusFp} − ${attack.rangeFp} = ${margin} fp margin ` +
          `(ground speeds: ${JSON.stringify(groundSpeeds.sort((a, b) => a - b))})`,
      );
      expect(groundSpeeds.length).toBeGreaterThan(0); // a catalog with no ground creep would pass vacuously
      expect(drift).toBeLessThanOrEqual(margin);
    });
  });

  describe('8 — a beacon-adjacent mine deals 67, composing with zero special-casing', () => {
    it('measures the buffed damage: floor(45 x 1.5) = 67', () => {
      // BEACON shares a full cell edge with OFF_LANE_MINE's footprint (row 8/9 boundary,
      // cols 10-11) — the same adjacency rule `story-support.test.ts` proves elsewhere;
      // `burst/aoe` compiles to the same `aoe` kind `snapshotEffects` already buffs, so no
      // special-casing is needed for the buff to reach it.
      const BEACON = { col: 10, row: 7 } as const;
      const scene = runScene(
        [
          { tick: 0, anchor: OFF_LANE_MINE, towerId: 'mine' },
          { tick: 1, anchor: BEACON, towerId: 'beacon' },
        ],
        RUN_TICKS,
        [],
        [0],
      );
      const mineId = scene.idByPlacement[0]!;
      const beaconId = scene.idByPlacement[1]!;
      // Both placements really stand (not silently rejected for overlap/cost).
      expect(scene.towersByTick.get(1)!.some((r) => r.id === beaconId)).toBe(true);

      const mineImpact = scene.impacts.find((i) => i.sourceId === mineId)!;
      expect(mineImpact).toBeDefined();
      console.log(`[story-mine] beacon-buffed mine impact: ${JSON.stringify(mineImpact)}`);
      expect(directAmounts(mineImpact)).toEqual([67]);
    });
  });
});
