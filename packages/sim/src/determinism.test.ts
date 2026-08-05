// determinism.test.ts — the determinism GATE.
//
// ADR 0001 §3: "identical inputs must reproduce an identical world-hash. This is
// a hard CI gate." This file is that gate. The existing sim tests prove the sim
// is *self-consistent* (two runs of the same code agree); this file additionally
// pins the canonical scenario to a committed golden digest, so a change in
// behavior — not just a loss of determinism — turns CI red.
//
// It asserts the byte-identity invariants the leaderboard's server-side
// re-simulation (ADR 0006) and save/resume (ADR 0008) depend on:
//
//   1. reproducibility       — same (seed, inputs) reproduces the same hash trace
//   2. golden regression      — the canonical scenario matches a pinned digest
//   3. serialize/restore      — a mid-run JSON round-trip continues byte-identically
//   4. frame-rate independence — irregular wall-clock chunks yield the same result
//
// If the GOLDEN values below change, that is BY DEFINITION a determinism-affecting
// behavior change: update them in the SAME commit that bumps SIM_VERSION, and say
// why in the message. A golden change with no version bump is a silent break — and
// because a runtime test cannot see "the same commit," that rule is enforced by a
// CI diff-check (scripts/check-determinism-version.mjs), not by an assertion here.
//
// M2-S2 regenerated the golden over a 3-WAVE test bundle (PLAN.md step 11 /
// PLAN-REVIEW-LOG G14): SIM_VERSION's bump to 6 already satisfied the CI guard's
// strict-increase requirement, and a 3-wave scenario is the only one that can
// exercise the new multi-wave lifecycle (wave handoff, a SECOND early call on a
// later wave, per-wave clear bonus, the early-call credit accumulator) at all.
//
// M2-S3 (SIM_VERSION 6 → 7) regenerates the golden AGAIN, over a v7 bundle that
// additionally exercises the status-effect framework: a SECOND tower catalog
// entry (`slow`, ground-scoped, direct-then-slow — mirrors the shipped bundle's
// authored order) built alongside `basic`, and wave 1 recomposed to spawn `fast`
// creeps (a second creep catalog entry) instead of `normal` — so the golden trace
// actually observes a creep's `slowMulFp` go nonzero at least once.
//
// M2-S4a (SIM_VERSION 7 → 8) re-pins the TRACE digest only: `Impact` becomes a
// `targeted`/`blast` discriminated union (every impact now serializes a `kind`
// field), which changes every mid-run world-hash that has a resident impact —
// this scenario's OWN bundle carries no AoE tower (AoE gets its own coverage in
// `story-aoe.test.ts`), so no blast is ever scheduled here; the hash moves purely
// because `targeted` impacts gained a discriminant field.
//
// M2-S5a P2 (still SIM_VERSION 9, the bump already happened in P1) re-pins BOTH
// the final hash and the trace digest: `Impact` gains a REQUIRED `sourceId` field
// on both variants — the firing tower's entity id, snapshotted at fire time — which
// changes every mid-run world-hash with a resident impact, including the FINAL
// tick this time (unlike M2-S4a's move, above). This packet adds STATE SHAPE ONLY
// (`SimState.dots`, canonicalized and returned unchanged by `runCombat` — no DoT
// primitive reaches `applyDot` or a tick step yet, both P3), so `dots` itself never
// contributes: this scenario's bundle carries no `dot` effect. The move is
// EXPECTED and driven purely by `sourceId` entering the hash — no behavioral
// number (leak count, lives, score, outcome) changed alongside it.
//
// M2-S5a P3 (still SIM_VERSION 9) re-pins both values AGAIN, and this time
// BEHAVIORAL numbers move too — legitimately, because THE SCENARIO ITSELF IS
// DIFFERENT rather than the semantics having drifted. The catalog gains `venom`
// (`TEST_DOT_TOWER`) and the input log gains a third build at tick 5, so a
// resident, ticking `SimState.dots` record now rides a long stretch of the trace:
// before this packet the canonical scenario carried no `dot` effect at all, so
// `dots` had never once appeared in the permanent golden and DoT would not have
// been part of the standing determinism witness for any later story. The terminal
// moves 452 → 454. `venom` joins `basic` in the tick-201 sell so that the
// scenario's two long-standing witnesses — `lives === 0` and a single surviving
// `slow` tower — are preserved EXACTLY; see `canonicalInputs`' own note for the
// measured reason.
//
// M2-S6 P5 (SIM_VERSION 9 → 10) re-pins BOTH values again, shape-only: this
// scenario's bundle carries no `stun` tower and never advances `state.rngState`
// past its seed, so nothing about the scenario's BEHAVIOR changed. The move is
// driven purely by the new `stunUntilTick` creep column (P1) joining every
// creep's serialized shape — `hashSimState` is `fnv1a(JSON.stringify(state))`,
// so a shape-only addition still moves every hash in the trace. `phase`,
// `lives` and `tick` (454) are unchanged; see the `v7-continuity witnesses`
// block below, which pins exactly those observables rather than a hash for
// this same reason.

import { describe, it, expect } from 'vitest';
import { createFixedLoop, DEFAULT_MS_PER_TICK, fnv1a } from '@wynding/engine';
import {
  createInitialState,
  step,
  hashSimState,
  deriveScore,
  deriveStars,
  type SimInput,
  type SimState,
} from './index';
import {
  testBundle,
  testRuleset,
  TEST_SLOW_TOWER,
  TEST_FAST_CREEP,
  TEST_DOT_TOWER,
} from './test-support';
import { compileRuleset, type CompiledRuleset } from './ruleset';

/** Fixed seed for the canonical determinism scenario. */
const SCENARIO_SEED = 0x5eed; // 24301
/** Scenario length — reaches the scenario's terminal (a loss at tick 454, once
 *  selling the basic and venom towers leaves the run thin enough) with trailing
 *  frozen ticks, so the golden also exercises the freeze-on-terminal path in-run. */
const SCENARIO_TICKS = 600;

const OPEN_28x24 = {
  widthTiles: 28,
  heightTiles: 24,
  entrance: { col: 0, row: 11 },
  exit: { col: 27, row: 11 },
} as const;

/**
 * The canonical ruleset — built INLINE from a board geometry (NOT imported from
 * @wynding/content, which would introduce a sim → content runtime edge). Mirrors
 * the M1 board (28×24, entrance/exit on row 11, so creeps run the full 27-cell
 * width) but grows to THREE waves (10 creeps each, spacing 20, clearBonus 4) with
 * both early-call divisors live (50/50) — the multi-wave engine's own vocabulary.
 * M2-S3: the tower catalog gains `slow` (`TEST_SLOW_TOWER`, `extraTowers`) beside
 * `basic`, and wave 1 (the one this scenario's second early call launches) spawns
 * `fast` creeps (`TEST_FAST_CREEP`, `extraCreeps`) instead of `normal` — so BOTH
 * new catalog axes (a second tower kind, a second creep kind) are exercised.
 * M2-S5a P3: the tower catalog gains `venom` (`TEST_DOT_TOWER`, `extraTowers`)
 * beside `basic`/`slow` — the scenario's THIRD build (tick 5), so the canonical
 * trace carries a resident, ticking `SimState.dots` record for a stretch of the
 * run (the scenario built no `dot` effect before this packet, so `dots` had never
 * once appeared in the permanent golden).
 */
const SCENARIO_RULESET: CompiledRuleset = compileRuleset(
  testBundle(OPEN_28x24, {
    waves: [
      { waveCount: 10, waveSpacing: 20, countdownTicks: 500, waveClearBonus: 4 },
      { waveCount: 10, waveSpacing: 20, countdownTicks: 300, waveClearBonus: 4, creepId: 'fast' },
      { waveCount: 10, waveSpacing: 20, countdownTicks: 300, waveClearBonus: 4 },
    ],
    earlyCallBountyDivisor: 50,
    earlyCallScoreDivisor: 50,
    extraTowers: [TEST_SLOW_TOWER, TEST_DOT_TOWER],
    extraCreeps: [TEST_FAST_CREEP],
  }),
  'test',
);

/**
 * The entity ids the canonical build receives: wave 0 (launched by the tick-0
 * call-early) spawns creep id 1 at tick 0; the `basic` tower placed at tick 2
 * (before the next spawn at tick 20) gets id 2, and the `slow` tower placed at
 * tick 3 gets id 3 — both from the shared entity-id space, both still ahead of
 * any later spawn.
 */
const BASIC_TOWER_ID = 2;
const SLOW_TOWER_ID = 3;
const VENOM_TOWER_ID = 4;

/**
 * The canonical input log: a pure function of the tick index. It exercises the FULL
 * command vocabulary — TWO `callWaveEarly` calls (tick 0 launches wave 0; tick 250,
 * mid-run, launches wave 1 — the `fast`-creep wave — early, both paying the
 * early-call bounty/credit from the undecremented countdown), THREE accepted builds
 * into the creeps' lane (`basic`, `slow`, then `venom` — forcing a visible re-route
 * AND combat kills AND a slow application AND a resident, ticking DoT record), a
 * rejected build (the deterministic-no-op path), an explicit `noop`, and a later
 * sell of BOTH the `basic` and `venom` towers (re-opening part of the lane; with
 * `slow` alone left standing, the scenario still ends in a loss once undefended
 * creeps overwhelm it).
 *
 * WHY `venom` joins `basic` in the tick-201 sell (measured, M2-S5a P3): leaving it
 * standing ALSO still reaches a loss — `phase` is `'lost'` either way — but it
 * overshoots to `lives === -1` (two creeps leak on the fatal tick; `index.ts`
 * deliberately applies no low clamp, since win/loss resolution reads `lives <= 0`)
 * and leaves `towers.id` as `[3, 4]`. Selling both keeps this scenario's two
 * long-standing witnesses EXACTLY as they were — `lives === 0` and a single
 * surviving `slow` tower — so P3 moves the hashes and the terminal tick without
 * quietly rewriting what the scenario asserts about itself.
 */
function canonicalInputs(tick: number): SimInput[] {
  if (tick === 0) return [{ kind: 'callWaveEarly' }]; // launch wave 0 now
  // Build a 2×2 wall across the straight lane (row 11 at cols 5-6): creeps re-route.
  if (tick === 2) return [{ kind: 'placeTower', anchor: { col: 5, row: 10 }, towerId: 'basic' }];
  // A second wall cell further down the (now-detoured) lane — clear of the basic
  // tower's footprint (cols 5-6) — so the slow tower gets its own hits in too.
  if (tick === 3) return [{ kind: 'placeTower', anchor: { col: 8, row: 10 }, towerId: 'slow' }];
  // A rejected build (border footprint) — pins the validation-no-op path.
  if (tick === 4) return [{ kind: 'placeTower', anchor: { col: 0, row: 0 }, towerId: 'basic' }];
  // A third wall cell (M2-S5a P3), further down the same detoured lane, clear of
  // both earlier footprints (cols 5-6, 8-9) — venom's own hits land, and its DoT
  // record rides resident in `SimState.dots` across a stretch of the trace.
  if (tick === 5) return [{ kind: 'placeTower', anchor: { col: 11, row: 10 }, towerId: 'venom' }];
  // Sell the basic AND venom walls — part of the lane re-opens; the slow tower
  // stands alone (M2-S5a P3: venom joins basic in this sell so the scenario still
  // reaches a loss, per this function's header comment).
  if (tick === 201) {
    return [
      { kind: 'sellTower', tower: BASIC_TOWER_ID },
      { kind: 'sellTower', tower: VENOM_TOWER_ID },
    ];
  }
  // A SECOND early call, well into the run and on a LATER (fast-creep) wave — the
  // multi-wave handoff + a second early-call bounty/credit payment.
  if (tick === 250) return [{ kind: 'callWaveEarly' }];
  if (tick % 7 === 0) return [{ kind: 'noop' }]; // exercise the noop path
  return [];
}

/** Run the canonical scenario, returning the final state and the per-tick hash trace. */
function runCanonical(
  seed = SCENARIO_SEED,
  ticks = SCENARIO_TICKS,
): { state: SimState; trace: string[] } {
  let state = createInitialState(seed, SCENARIO_RULESET);
  const trace: string[] = [];
  for (let t = 0; t < ticks; t++) {
    state = step(state, SCENARIO_RULESET, canonicalInputs(t));
    trace.push(hashSimState(state));
  }
  return { state, trace };
}

// --- GOLDEN — a behavior change here requires a SIM_VERSION bump (CI-enforced) --
// Recompute with: pnpm --filter @wynding/sim exec vitest run determinism
const GOLDEN = {
  finalHash: '31e0a94c', // re-pinned M2-S6 P5: the `stunUntilTick` column widens every creep's shape.
  traceDigest: '631be81b', // fnv1a(trace.join(':')) — re-pinned M2-S6 P5, same reason.
} as const;
// -------------------------------------------------------------------------------

describe('determinism gate', () => {
  it('reproduces a byte-identical trace from the same (seed, inputs)', () => {
    const a = runCanonical();
    const b = runCanonical();
    expect(a.trace).toEqual(b.trace);
    expect(hashSimState(a.state)).toBe(hashSimState(b.state));
  });

  it('matches the committed golden world-hash (bump SIM_VERSION if this changes)', () => {
    const { state, trace } = runCanonical();
    expect(hashSimState(state)).toBe(GOLDEN.finalHash);
    expect(fnv1a(trace.join(':'))).toBe(GOLDEN.traceDigest);
  });

  it('witnesses creeps crossing and leaking to a LOSS (selling the basic+venom towers leaves the lane thin)', () => {
    // The golden is only meaningful if the scenario actually exercises leaks;
    // selling the basic AND venom towers at tick 201 (the slow tower alone can't
    // hold the line) leaves the run undefended enough that lives fall all the way
    // to 0 (a loss) — the loss-priority resolution path (settlement before
    // terminal). Both are sold so `lives` lands exactly on 0 rather than
    // overshooting to -1; see `canonicalInputs`' note.
    const { state } = runCanonical();
    expect(state.phase).toBe('lost');
    expect(state.lives).toBe(0);
  });

  it('witnesses three builds (basic+slow+venom), a visible re-route, combat kills, a slow application, a RESIDENT TICKING DoT record, a sell, and the multi-wave early-call economy', () => {
    // The golden must exercise the full Story-3 + Story-4 + M2-S2 + M2-S3 + M2-S5a
    // vocabulary: the tick-2/3/5 builds land; live creeps visibly leave the
    // straight row-11 lane to route around them; the towers fire and KILL creeps,
    // each credit raising bounty while they stand; at least one creep is observed
    // SLOWED (`slowMulFp !== 0`) at some tick; at least one DoT record is observed
    // RESIDENT in `SimState.dots` and observed actually TICKING (its `nextTickTick`
    // advancing, i.e. damage dealt — a merely-resident record would prove the state
    // shape serializes but not that the tick step ever ran); the tick-201 sell
    // removes basic and venom (the slow tower survives); and BOTH early calls
    // (tick 0 + tick 250) pay into the cumulative early-call credit.
    let state = createInitialState(SCENARIO_SEED, SCENARIO_RULESET);
    let sawAllThreeTowers = false;
    let sawDetour = false;
    let sawKill = false;
    let sawSlowedCreep = false;
    let sawResidentDot = false;
    let sawDotTick = false;
    let prevNextTickByPair = new Map<string, number>();
    let prevBounty = state.bounty;
    for (let t = 0; t < SCENARIO_TICKS; t++) {
      state = step(state, SCENARIO_RULESET, canonicalInputs(t));
      if (state.towers.id.length === 3) sawAllThreeTowers = true;
      // Bounty rises only from a combat kill while at least one tower stands.
      if (state.towers.id.length >= 1 && state.bounty > prevBounty) sawKill = true;
      if (state.creeps.slowMulFp.some((m) => m !== 0)) sawSlowedCreep = true;
      if (state.creeps.headRow.some((r) => r !== undefined && r !== 11)) sawDetour = true;
      if (state.dots.length > 0) sawResidentDot = true;
      // A record whose `nextTickTick` ADVANCED between ticks was one the tick step
      // actually fired this tick — the witness that DoT is live in the golden, not
      // merely serialized into it.
      const nextByPair = new Map<string, number>();
      for (const r of state.dots) {
        const key = `${r.targetId}:${r.sourceId}`;
        nextByPair.set(key, r.nextTickTick);
        const prev = prevNextTickByPair.get(key);
        if (prev !== undefined && r.nextTickTick > prev) sawDotTick = true;
      }
      prevNextTickByPair = nextByPair;
      prevBounty = state.bounty;
    }
    expect(sawAllThreeTowers).toBe(true); // basic, slow and venom stood at once
    expect(sawDetour).toBe(true); // the straight-lane board never leaves row 11 unbuilt
    expect(sawKill).toBe(true); // a tower actually killed a creep and earned bounty
    expect(sawSlowedCreep).toBe(true); // the slow tower actually slowed a creep
    expect(sawResidentDot).toBe(true); // a DoT record rode the serialized state
    expect(sawDotTick).toBe(true); // and the tick step actually fired it
    expect(state.towers.id).toEqual([SLOW_TOWER_ID]); // basic+venom sold, slow survives
    // ⌊500/50⌋ = 10 (the tick-0 call at full countdown) + ⌊51/50⌋ = 1 (the tick-250
    // call: wave 1's 300-tick countdown began decrementing at tick 1, so 249
    // decrements leave rem = 51) — NOT ⌊300/50⌋: the second call is mid-countdown.
    expect(state.cumulativeEarlyCallCredit).toBe(11);
    // The terminal the header documents, pinned (tick freezes at the terminal):
    expect(state.phase).toBe('lost');
    expect(state.tick).toBe(454);
  });

  it('continues byte-identically after a mid-run serialize/restore (resume path)', () => {
    const half = SCENARIO_TICKS >> 1;
    const ref = runCanonical();

    // Step to the halfway point, JSON round-trip the state (the runInProgress
    // snapshot / server re-sim boundary, ADR 0008 §5), then continue.
    let live = createInitialState(SCENARIO_SEED, SCENARIO_RULESET);
    for (let t = 0; t < half; t++) live = step(live, SCENARIO_RULESET, canonicalInputs(t));
    const restored = JSON.parse(JSON.stringify(live)) as SimState;

    // Compare the WHOLE resumed tail, not just the final hash — a matching final
    // hash could otherwise mask a diverge-then-reconverge in between. And assert
    // the full serialized state, not just its digest.
    const resumedTail: string[] = [];
    for (let t = half; t < SCENARIO_TICKS; t++) {
      step(restored, SCENARIO_RULESET, canonicalInputs(t));
      resumedTail.push(hashSimState(restored));
    }
    expect(resumedTail).toEqual(ref.trace.slice(half));
    expect(JSON.stringify(restored)).toBe(JSON.stringify(ref.state));
  });

  it('is frame-rate independent — irregular wall-clock chunks yield the same result', () => {
    const ref = runCanonical();

    // Drive the tick sequence through the fixed-timestep loop, feeding a FIXED
    // total elapsed time in wildly irregular chunks so tick boundaries never align
    // to frames. Holding elapsed time fixed (rather than looping until a tick
    // counter is reached) means the loop must account for EXACTLY SCENARIO_TICKS
    // ticks — a regression that loses or invents ticks is caught — and the sim
    // advances only in whole ticks (ADR 0005), so the result must be identical.
    const state = createInitialState(SCENARIO_SEED, SCENARIO_RULESET);
    let tick = 0;
    const loop = createFixedLoop(
      () => {
        step(state, SCENARIO_RULESET, canonicalInputs(tick));
        tick++;
      },
      { msPerTick: DEFAULT_MS_PER_TICK },
    );

    // Exactly enough elapsed time for SCENARIO_TICKS ticks. Each chunk stays under
    // the spiral-of-death clamp (250 ms) so no ticks are dropped, and the last
    // chunk is trimmed so the total lands exactly on a tick boundary.
    const totalMs = SCENARIO_TICKS * DEFAULT_MS_PER_TICK;
    const jitter = [7, 3, 51, 99, 1, 44, 120, 6];
    let fed = 0;
    let ji = 0;
    while (fed < totalMs) {
      const chunk = Math.min(jitter[ji % jitter.length] ?? 1, totalMs - fed);
      loop.advance(chunk);
      fed += chunk;
      ji++;
    }

    expect(tick).toBe(SCENARIO_TICKS); // the loop accounted for every tick
    expect(loop.accumulatorMs).toBe(0); // exact — no partial tick left over
    expect(hashSimState(state)).toBe(hashSimState(ref.state));
  });
});

/**
 * v7-CONTINUITY WITNESSES (PLAN.md step 11 / PLAN-REVIEW-LOG G14, carried forward
 * from M2-S2's v5-continuity witnesses): a SINGLE-wave, SINGLE-tower ('basic'
 * only — no `slow`, no `fast`) bundle carrying M1's exact numbers (both
 * early-call divisors 0, survivalMul 25 — `test-support`'s defaults) — built
 * INLINE, mirroring `packages/content`'s shipped M1 artifact (`parity.test.ts`'s
 * pre-verified scenario A/B, whose literals this file duplicates by provenance,
 * not by import — sim must not depend on content). At these numbers no slow
 * effect and no `fast` creep is ever compiled or spawned, so wave-1's launch
 * tick, spawn ticks, movement, and combat are BYTE-IDENTICAL to v5/v6 (no second
 * wave, no early-call credit, no status effects): v7 reproduces the EXACT SAME
 * lives/terminal-tick/score outcomes as v5 did — only the world-hash's SHAPE
 * changes (three new creep columns, one new tower column), which is why this
 * witness pins the OBSERVABLE outcomes, not a hash.
 */
describe('v7-continuity witnesses (single-wave, single-tower M1-numbers bundle)', () => {
  const M1_RULESET = testRuleset(OPEN_28x24);

  it('scenario A (canonical inputs, 500 ticks): lives 2, terminal tick 446, score 52 (a win, 1 star)', () => {
    let state = createInitialState(SCENARIO_SEED, M1_RULESET);
    for (let t = 0; t < 500; t++) {
      // The single-wave M1 canonical input log (provenance: this file's OWN
      // pre-S2 canonicalInputs, and packages/content/src/parity.test.ts's
      // duplicate of it) — no second early call, since there is no second wave.
      const inputs: SimInput[] =
        t === 0
          ? [{ kind: 'callWaveEarly' }]
          : t === 2
            ? [{ kind: 'placeTower', anchor: { col: 5, row: 10 }, towerId: 'basic' }]
            : t === 4
              ? [{ kind: 'placeTower', anchor: { col: 0, row: 0 }, towerId: 'basic' }]
              : t === 201
                ? [{ kind: 'sellTower', tower: 2 }]
                : t % 7 === 0
                  ? [{ kind: 'noop' }]
                  : [];
      state = step(state, M1_RULESET, inputs);
    }
    expect(state.phase).toBe('won');
    expect(state.lives).toBe(2);
    expect(state.tick).toBe(446);
    expect(deriveScore(state, M1_RULESET)).toBe(52);
    expect(deriveStars(state, M1_RULESET)).toBe(1);
  });

  it('scenario B (hands-off, 1200 ticks): lives 0, tick 946, score 0 (a total loss)', () => {
    let state = createInitialState(SCENARIO_SEED, M1_RULESET);
    for (let t = 0; t < 1200; t++) state = step(state, M1_RULESET, []);
    expect(state.phase).toBe('lost');
    expect(state.lives).toBe(0);
    expect(state.tick).toBe(946);
    expect(deriveScore(state, M1_RULESET)).toBe(0);
    expect(deriveStars(state, M1_RULESET)).toBe(0);
  });
});

describe('compiled-board mutation regression (#21/P4)', () => {
  // A CI mutation-REGRESSION test — named as what it is, NOT a runtime tamper guard.
  // `Object.freeze` can't apply to non-empty typed arrays, and accessor indirection
  // would tax the Dijkstra/movement hot loops (ADR 0005) against a threat entirely
  // out of the model (hostile in-process code owns the heap regardless). What this
  // proves: no code path exercised by real matches mutates the compiled board
  // arrays — an accidental in-repo mutation is caught here in CI. P2 now memoizes
  // compiled rulesets across requests (LRU keyed by content digest), so an
  // accidental mutation would poison every later validation sharing that cache
  // entry — compiling ONCE and running ≥2 full matches on the SAME compiled object
  // below models that reuse directly (sim tests must not import replay; actual
  // cache-hit coverage lives in replay's own tests).
  it('board.field.dist/blockedMask and board.grid.baseMask are never mutated across 2 full matches on ONE compiled ruleset', () => {
    const distSnapshot = SCENARIO_RULESET.board.field.dist.slice();
    const blockedMaskSnapshot = SCENARIO_RULESET.board.field.blockedMask.slice();
    const baseMaskSnapshot = SCENARIO_RULESET.board.grid.baseMask.slice();

    // toEqual does a deep, element-by-element structural comparison meant for
    // arbitrary objects — far more than a flat numeric array needs, and slow enough
    // per-step across two full matches to time out CI (was 20.6s). These arrays are
    // flat and index-addressable, so a plain indexed loop that returns the first
    // mismatching index (or -1) gets the same exactness at a fraction of the cost,
    // and only builds the failure message when there actually is a mismatch.
    const firstMismatch = (actual: ArrayLike<number>, expected: ArrayLike<number>): number => {
      if (actual.length !== expected.length) return 0;
      for (let i = 0; i < actual.length; i++) {
        if (actual[i] !== expected[i]) return i;
      }
      return -1;
    };

    const assertUnmutated = (): void => {
      const checks: Array<[string, ArrayLike<number>, ArrayLike<number>]> = [
        ['board.field.dist', SCENARIO_RULESET.board.field.dist, distSnapshot],
        ['board.field.blockedMask', SCENARIO_RULESET.board.field.blockedMask, blockedMaskSnapshot],
        ['board.grid.baseMask', SCENARIO_RULESET.board.grid.baseMask, baseMaskSnapshot],
      ];
      for (const [name, actual, expected] of checks) {
        const idx = firstMismatch(actual, expected);
        const message =
          idx === -1
            ? undefined
            : `${name} mutated at index ${idx} (expected ${expected[idx]}, got ${actual[idx]})`;
        expect(idx, message).toBe(-1);
      }
    };

    for (let run = 0; run < 2; run++) {
      let state = createInitialState(SCENARIO_SEED + run, SCENARIO_RULESET);
      for (let t = 0; t < SCENARIO_TICKS; t++) {
        state = step(state, SCENARIO_RULESET, canonicalInputs(t));
        assertUnmutated(); // per-step — catches mutate-then-restore within a match
      }
    }
  }, 30_000); // explicit CI headroom; the fast comparator finishes well under this locally
});
