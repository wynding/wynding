// story-support.test.ts — the M2-S8 pinned support-aura measurement (PLAN.md §P7).
//
// LOCATION NOTE, same reasoning as `story-armored-wave.test.ts`'s own header: this file
// lives beside `parity.test.ts` (not in `packages/sim`, which cannot import
// `@wynding/content`) so every scenario below runs the REAL shipped `wynding-core`
// bundle through `compileRuleset` → `step()`, not a hand-assembled replica of the
// beacon.
//
// PURPOSE: witnessing M2 Story 8's own done-criteria (m2.md Story 8) against the shipped
// bundle now that `beacon` is in the catalog —
//   1. an adjacent attacker's single-target damage is buffed ×1.5 (floor-rounded);
//   2. an adjacent BLAST is buffed too (`aoe` is a distinct compiled kind; the
//      single-target case does not cover it, and an unbuffed `splash` would silently
//      disable the boss-armor lever this story exists to prove);
//   3. an adjacent DoT's per-tick amount is buffed, at FIRE time;
//   4. two overlapping auras do not stack — strongest single aura wins;
//   5. no chaining — a beacon never fires, so a beacon beside a beacon buffs nothing;
//   6. selling the beacon returns the recipient to base damage on its next fire;
//   7. ARMOR PIERCING — because armor is subtracted at impact from the ALREADY buffed
//      amount, the buff is worth far more than +50% against an armored wave.
//
// WHAT IS MEASURED, and why it is the right observable: every assertion below reads
// `SimState.impacts` — the fire-time snapshot itself. That is the exact seam the buff
// enters through (`combat.ts`'s `snapshotEffects`), so an assertion on the snapshotted
// amount cannot pass with the feature deleted. Criterion 7 is the exception and reads a
// whole-run scalar (`lives`), because "armor piercing" is a claim about the impact's
// downstream effect, not about the snapshot.
//
// Regenerate every literal below with:
//   pnpm --filter @wynding/content exec vitest run story-support
// The goldens are `console.log`'d on every run — they are MEASURED, never hand-computed.

import { describe, it, expect } from 'vitest';
import {
  compileRuleset,
  createInitialState,
  step,
  type SimInput,
  type SimState,
} from '@wynding/sim';

/** One snapshotted effect on an in-flight impact. DERIVED from the exported `SimState`
 *  rather than imported: `EffectPrimitive` is sim-internal, and widening the barrel for a
 *  test's convenience would make a private shape public. This spelling also cannot drift
 *  — it IS the shape the sim stores. */
type EffectPrimitive = SimState['impacts'][number]['effects'][number];
import { getBundledRuleset, defaultBoardId } from './registry';

/** Fixed seed — same convention as parity.test.ts / story-armored-wave.test.ts. */
const SCENARIO_SEED = 0x5eed;

interface Placement {
  readonly tick: number;
  readonly anchor: { readonly col: number; readonly row: number };
  readonly towerId: string;
}

interface CapturedImpact {
  readonly tick: number;
  readonly sourceId: number;
  readonly kind: string;
  readonly effects: readonly EffectPrimitive[];
}

interface SceneResult {
  readonly impacts: readonly CapturedImpact[];
  readonly state: SimState;
}

/**
 * Run the shipped bundle for `untilTick` ticks, placing `placements` on their scheduled
 * ticks and selling on `sells`, capturing every impact the moment it is created.
 *
 * Impacts are captured by `(sourceId, impactTick)` rather than by object identity: an
 * impact stays resident in `SimState.impacts` for its whole flight, so a naive per-tick
 * sweep would record the same shot once per travel tick. `snapshotEffects` builds a
 * FRESH effect array per fire (combat.ts's own contract), so the captured arrays are
 * never aliased by a later shot.
 */
function runScene(
  placements: readonly Placement[],
  untilTick: number,
  sells: readonly { readonly tick: number; readonly placementIndex: number }[] = [],
  /** Mutate the live state just BEFORE the step at `tick` — the only way to witness the
   *  sim's handling of a FORGED or restored `SimState`, which no sequence of legal inputs
   *  can produce. Mirrors `render.test.ts`'s own `s.creeps.creepId[0] = 'fast'` posture. */
  forge: readonly { readonly tick: number; readonly apply: (state: SimState) => void }[] = [],
): SceneResult {
  const bundle = getBundledRuleset();
  const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
  let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
  const seen = new Set<string>();
  const impacts: CapturedImpact[] = [];
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
    for (const f of forge) if (f.tick === tick) f.apply(state);
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
      impacts.push({ tick, sourceId: im.sourceId, kind: im.kind, effects: [...im.effects] });
    }
  }
  return { impacts, state };
}

/** The snapshotted amounts of an impact's `direct` primitives, in authored order. */
function directAmounts(impact: CapturedImpact): number[] {
  return impact.effects.filter((e) => e.kind === 'direct').map((e) => e.amount);
}

/** The snapshotted per-tick amounts of an impact's `dot` primitives, in authored order. */
function dotAmounts(impact: CapturedImpact): number[] {
  return impact.effects.filter((e) => e.kind === 'dot').map((e) => e.amount);
}

// ---------------------------------------------------------------------------------
// GEOMETRY. The shipped board is 28×24 with entrance (0,11) and exit (27,11), so creeps
// walk the row-11 lane and every tower below stands within `basic`'s 4-tile range of it.
//
// The three anchors form the L-SHAPE criterion 4 needs, and the shape is load-bearing:
// two beacons merely FLANKING a recipient stamp DISJOINT cells, so a per-cell sum would
// equal the per-cell max and a `max` → `+` mutation would survive the test. Here both
// beacons stamp the SAME cell — (6,13), inside the recipient's own footprint — so the
// two operators give different answers (384 vs 768) and the test can tell them apart.
//
//   BEACON_LEFT  (4,12) occupies cols 4-5, rows 12-13 → its ring includes (6,12),(6,13)
//   BEACON_BELOW (6,14) occupies cols 6-7, rows 14-15 → its ring includes (6,13),(7,13)
//   RECIPIENT    (6,12) occupies cols 6-7, rows 12-13 — contains the shared cell (6,13)
//
// All three 2×2 footprints are disjoint, so all three placements are legal together.
// ---------------------------------------------------------------------------------
const RECIPIENT = { col: 6, row: 12 } as const;
const BEACON_LEFT = { col: 4, row: 12 } as const;
const BEACON_BELOW = { col: 6, row: 14 } as const;

/** Long enough for the first waves to reach the wall and for the recipient to land
 *  several shots — every single-tower scenario below shares it. */
const SHORT_RUN_TICKS = 760;

/** Assert the scenario actually produced shots, BEFORE any assertion about their
 *  contents. Without this, a scenario that silently fired nothing at all (a geometry
 *  slip, a range change, a wave-timing change) would make every `.every(...)` assertion
 *  below vacuously true — the classic way a golden test stops testing anything. */
function expectEngaged(impacts: readonly CapturedImpact[], label: string): void {
  console.log(`[story-support] ${label}: ${impacts.length} impacts captured`);
  expect(impacts.length).toBeGreaterThan(0);
}

describe('M2-S8 — the `beacon` support aura, measured against the shipped bundle', () => {
  it('1. an adjacent single-target attacker fires for x1.5 (floor-rounded) — 10 becomes 15', () => {
    const base = runScene([{ tick: 0, anchor: RECIPIENT, towerId: 'basic' }], SHORT_RUN_TICKS);
    const buffed = runScene(
      [
        { tick: 0, anchor: RECIPIENT, towerId: 'basic' },
        { tick: 10, anchor: BEACON_LEFT, towerId: 'beacon' },
      ],
      SHORT_RUN_TICKS,
    );
    expectEngaged(base.impacts, 'unbuffed basic');
    expectEngaged(buffed.impacts, 'buffed basic');

    // MID-TRACE PROOF THE FEATURE ENGAGED, asserted before the terminal claims below:
    // the very first shot of the buffed arm already differs from the unbuffed arm's.
    // If the aura never reached the recipient, this fails here rather than surviving
    // into an `.every(...)` that a zero-length array would satisfy.
    console.log(
      `[story-support] first shot: unbuffed=${JSON.stringify(directAmounts(base.impacts[0]!))} ` +
        `buffed=${JSON.stringify(directAmounts(buffed.impacts[0]!))}`,
    );
    expect(directAmounts(base.impacts[0]!)).toEqual([10]);
    expect(directAmounts(buffed.impacts[0]!)).toEqual([15]);

    // ... and EVERY shot, not merely the first: the buff is derived per combat phase, so
    // a version that stamped once and went stale would pass a first-shot-only check.
    expect(base.impacts.every((i) => directAmounts(i)[0] === 10)).toBe(true);
    expect(buffed.impacts.every((i) => directAmounts(i)[0] === 15)).toBe(true);
  });

  it('2. an adjacent BLAST is buffed too — `splash` fires for 12, not 8', () => {
    // `aoe` is a DISTINCT `CompiledEffect` kind that only collapses into the `direct`
    // primitive inside `snapshotEffects`. Code keying the buff on `kind === 'direct'`
    // compiles clean and ships an unbuffed `splash` — the exact boss-armor lever
    // (m2.md) this story exists to prove. The single-target test above cannot see that.
    const base = runScene([{ tick: 0, anchor: RECIPIENT, towerId: 'splash' }], SHORT_RUN_TICKS);
    const buffed = runScene(
      [
        { tick: 0, anchor: RECIPIENT, towerId: 'splash' },
        { tick: 10, anchor: BEACON_LEFT, towerId: 'beacon' },
      ],
      SHORT_RUN_TICKS,
    );
    expectEngaged(base.impacts, 'unbuffed splash');
    expectEngaged(buffed.impacts, 'buffed splash');

    // The impacts must actually be blasts — otherwise this is test 1 again under a
    // different tower name, and the `aoe` path would stay unwitnessed.
    expect(base.impacts.every((i) => i.kind === 'blast')).toBe(true);
    expect(buffed.impacts.every((i) => i.kind === 'blast')).toBe(true);

    console.log(
      `[story-support] blast: unbuffed=${JSON.stringify(directAmounts(base.impacts[0]!))} ` +
        `buffed=${JSON.stringify(directAmounts(buffed.impacts[0]!))}`,
    );
    expect(directAmounts(base.impacts[0]!)).toEqual([8]);
    expect(directAmounts(buffed.impacts[0]!)).toEqual([12]);
    expect(buffed.impacts.every((i) => directAmounts(i)[0] === 12)).toBe(true);
  });

  it('3. an adjacent DoT is buffed at FIRE time — `venom` applies 6/tick, not 4', () => {
    const base = runScene([{ tick: 0, anchor: RECIPIENT, towerId: 'venom' }], SHORT_RUN_TICKS);
    const buffed = runScene(
      [
        { tick: 0, anchor: RECIPIENT, towerId: 'venom' },
        { tick: 10, anchor: BEACON_LEFT, towerId: 'beacon' },
      ],
      SHORT_RUN_TICKS,
    );
    expectEngaged(base.impacts, 'unbuffed venom');
    expectEngaged(buffed.impacts, 'buffed venom');

    console.log(
      `[story-support] venom: unbuffed direct=${JSON.stringify(directAmounts(base.impacts[0]!))} ` +
        `dot=${JSON.stringify(dotAmounts(base.impacts[0]!))} | buffed direct=` +
        `${JSON.stringify(directAmounts(buffed.impacts[0]!))} dot=` +
        `${JSON.stringify(dotAmounts(buffed.impacts[0]!))}`,
    );
    expect(directAmounts(base.impacts[0]!)).toEqual([2]);
    expect(dotAmounts(base.impacts[0]!)).toEqual([4]);
    // Both halves of the bundle are buffed independently: floor(2 x 1.5) = 3 and
    // floor(4 x 1.5) = 6. The DoT's cadence and duration are NOT touched — m2.md:
    // "Non-damage magnitudes and durations ... are never buffed".
    expect(directAmounts(buffed.impacts[0]!)).toEqual([3]);
    expect(dotAmounts(buffed.impacts[0]!)).toEqual([6]);
    const dotEffect = buffed.impacts[0]!.effects.find((e) => e.kind === 'dot');
    expect(dotEffect).toBeDefined();
    if (dotEffect?.kind === 'dot') {
      expect(dotEffect.cadenceTicks).toBe(10);
      expect(dotEffect.durationTicks).toBe(60);
    }
  });

  it('4. two overlapping auras do NOT stack — the strongest single aura wins', () => {
    // The L-shape (see the GEOMETRY block above) makes both beacons stamp cell (6,13),
    // which the recipient's footprint contains. A summing implementation would put 768
    // there and fire for floor(10 x 768/256) = 30; `max` puts 384 there and fires for 15.
    const one = runScene(
      [
        { tick: 0, anchor: RECIPIENT, towerId: 'basic' },
        { tick: 10, anchor: BEACON_LEFT, towerId: 'beacon' },
      ],
      SHORT_RUN_TICKS,
    );
    const two = runScene(
      [
        { tick: 0, anchor: RECIPIENT, towerId: 'basic' },
        { tick: 10, anchor: BEACON_LEFT, towerId: 'beacon' },
        { tick: 20, anchor: BEACON_BELOW, towerId: 'beacon' },
      ],
      SHORT_RUN_TICKS,
    );
    expectEngaged(one.impacts, 'one beacon');
    expectEngaged(two.impacts, 'two beacons (L-shape, shared cell)');

    // Both beacons really are standing (the second placement was not silently rejected
    // for overlap or cost) — otherwise this test would be test 1 with extra steps and
    // would pass under a summing implementation.
    expect(two.state.towers.id.length).toBe(3);
    expect(two.state.towers.towerId.filter((id) => id === 'beacon')).toHaveLength(2);

    console.log(
      `[story-support] stacking: one=${JSON.stringify(directAmounts(one.impacts[0]!))} ` +
        `two=${JSON.stringify(directAmounts(two.impacts[0]!))} (a summing aura would read 30)`,
    );
    expect(directAmounts(two.impacts[0]!)).toEqual(directAmounts(one.impacts[0]!));
    expect(two.impacts.every((i) => directAmounts(i)[0] === 15)).toBe(true);
  });

  it('5. no chaining — a beacon never fires, so a beacon beside a beacon buffs nothing', () => {
    // The mechanism, not merely the outcome: support towers are skipped in the fire step
    // before any attack field is read, so they produce no impacts at all. That is WHY
    // chaining is unrepresentable rather than merely unimplemented — a beacon is inside
    // its neighbour's stamped ring, but nothing ever reads its own stamp.
    const both = runScene(
      [
        { tick: 0, anchor: RECIPIENT, towerId: 'beacon' },
        { tick: 10, anchor: BEACON_LEFT, towerId: 'beacon' },
      ],
      SHORT_RUN_TICKS,
    );
    console.log(`[story-support] beacon-beside-beacon: ${both.impacts.length} impacts`);
    expect(both.state.towers.id.length).toBe(2);
    // The scene DID run long enough for an attacker to have fired here — test 1 proves
    // it, on the same anchor over the same tick budget. So zero impacts is a fact about
    // beacons, not about the scene being too short.
    expect(both.impacts).toHaveLength(0);
  });

  it('5b. a beacon’s forged combat columns are ZEROED, not left resident in the world hash', () => {
    // This is the witness for the `targetId`/`nextFireTick` zeroing in the fire step's
    // support skip, and it has to start from a FORGED state to be one. A beacon placed
    // legally pushes both columns as 0 and the skip returns before any write path, so
    // asserting "they are 0" after an ordinary run passes identically with the zeroing
    // deleted — a vacuous test dressed as a guard. `coerceSoa`'s `safeCombatColumn` does
    // admit a restored beacon row carrying nonzero values in either column, and without
    // the zeroing those stay resident in the world hash forever.
    const FORGE_TICK = 600; // mid-run, phase `running`, so the combat phase actually runs
    const forged = runScene(
      [
        { tick: 0, anchor: RECIPIENT, towerId: 'beacon' },
        { tick: 10, anchor: BEACON_LEFT, towerId: 'beacon' },
      ],
      SHORT_RUN_TICKS,
      [],
      [
        {
          tick: FORGE_TICK,
          apply: (state) => {
            for (let i = 0; i < state.towers.id.length; i++) {
              state.towers.targetId[i] = 4242;
              state.towers.nextFireTick[i] = 9999;
            }
          },
        },
      ],
    );
    expect(forged.state.towers.id.length).toBe(2);
    console.log(
      `[story-support] forged beacon columns after the run: ` +
        `targetId=${JSON.stringify([...forged.state.towers.targetId])} ` +
        `nextFireTick=${JSON.stringify([...forged.state.towers.nextFireTick])}`,
    );
    expect([...forged.state.towers.targetId]).toEqual([0, 0]);
    expect([...forged.state.towers.nextFireTick]).toEqual([0, 0]);
    // Still no impacts — zeroing the columns must not have made a beacon fireable.
    expect(forged.impacts).toHaveLength(0);
  });

  it('6. selling the beacon returns the recipient to base damage on its next fire', () => {
    const { impacts } = runScene(
      [
        { tick: 0, anchor: RECIPIENT, towerId: 'basic' },
        { tick: 10, anchor: BEACON_LEFT, towerId: 'beacon' },
      ],
      900,
      [{ tick: 700, placementIndex: 1 }],
    );
    expectEngaged(impacts, 'sell sequence');
    const amounts = impacts.map((i) => directAmounts(i)[0]);
    console.log(`[story-support] sell sequence amounts=${JSON.stringify(amounts)}`);

    // The sequence must contain BOTH phases — a run that only ever fired buffed (or only
    // ever unbuffed) would satisfy a naive "the last shot is 10" check while proving
    // nothing about the transition.
    expect(amounts.some((a) => a === 15)).toBe(true);
    expect(amounts.some((a) => a === 10)).toBe(true);
    // ... and it must be a clean transition, never an alternation: every buffed shot
    // precedes every unbuffed one.
    const firstUnbuffed = amounts.indexOf(10);
    expect(amounts.slice(0, firstUnbuffed).every((a) => a === 15)).toBe(true);
    expect(amounts.slice(firstUnbuffed).every((a) => a === 10)).toBe(true);
    // The buff is derived per combat phase, never stored, so the drop is immediate on
    // the tick after the sell — not carried by a stale column.
    expect(amounts[amounts.length - 1]).toBe(10);
  });

  it('7. ARMOR PIERCING — the buff is worth far more than +50% against wave 3 (`armored`)', () => {
    // Armor is subtracted at impact from the ALREADY-buffed amount (`combat.ts`), so the
    // buff is mul-THEN-subtract. Against `armored`'s armor 6, a `basic` goes 10 -> 15
    // nominal, i.e. 4 -> 9 THROUGH armor: +125%, not +50%. m2.md banks on exactly this
    // ("the boss demands DoT/support/mine"), and S10 will author the boss assuming it
    // works — so this story measures it rather than asserting it.
    //
    // Two arms over the same six-tower `basic` wall (columns 2/6/10, rows 10 and 12 —
    // the flanking geometry `story-armored-wave.test.ts` already proved clears waves
    // 0-2). The second arm adds two beacons at column 4, each edge-adjacent to the two
    // `basic` towers on its own row, so four of the six are buffed.
    const wall: readonly { col: number; row: number }[] = [
      { col: 2, row: 10 },
      { col: 2, row: 12 },
      { col: 6, row: 10 },
      { col: 6, row: 12 },
      { col: 10, row: 10 },
      { col: 10, row: 12 },
    ];
    const wallPlacements: Placement[] = wall.map((anchor, i) => ({
      tick: i * 10,
      anchor,
      towerId: 'basic',
    }));
    const RUN_TICKS = 2000; // past wave 3's launch (tick 1400) and its full traversal

    const plain = runScene(wallPlacements, RUN_TICKS);
    const withBeacons = runScene(
      [
        ...wallPlacements,
        { tick: 100, anchor: { col: 4, row: 10 }, towerId: 'beacon' },
        { tick: 110, anchor: { col: 4, row: 12 }, towerId: 'beacon' },
      ],
      RUN_TICKS,
    );

    // Both arms reached the same point in the schedule — otherwise a lives comparison is
    // comparing two different amounts of game.
    expect(plain.state.waveCursor).toBe(withBeacons.state.waveCursor);
    expect(plain.state.creeps.id.length).toBe(0);
    expect(withBeacons.state.creeps.id.length).toBe(0);
    // And the beacons are genuinely standing (8 rows: 6 basic + 2 beacon).
    expect(withBeacons.state.towers.id.length).toBe(8);

    console.log(
      `[story-support] armor piercing: lives plain=${plain.state.lives} ` +
        `withBeacons=${withBeacons.state.lives} (of 10)`,
    );
    expect(plain.state.lives).toBe(4);
    expect(withBeacons.state.lives).toBe(8);
    // The headline: two beacons (30 bounty) cut the leak damage across the run in half.
    expect(withBeacons.state.lives).toBeGreaterThan(plain.state.lives);
  });
});
