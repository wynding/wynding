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

import { describe, it, expect } from 'vitest';
import { createFixedLoop, DEFAULT_MS_PER_TICK, fnv1a } from '@wynding/engine';
import {
  createInitialState,
  step,
  hashSimState,
  loadBoard,
  type BoardContext,
  type SimInput,
  type SimState,
} from './index';

/** Fixed seed for the canonical determinism scenario. */
const SCENARIO_SEED = 0x5eed; // 24301
/** Scenario length — long enough for ≥2 creeps to cross the board and leak lives
 *  (a 27-cell crossing takes ≈266 ticks at the movement budget of 26/tick). */
const SCENARIO_TICKS = 300;

/**
 * The canonical board — defined inline (NOT imported from @wynding/content, which
 * would introduce a sim → content runtime edge). Mirrors the M1 board geometry: a
 * 28×24 grid with entrance and exit on row 11, so creeps run the full 27-cell width.
 */
const SCENARIO_BOARD: BoardContext = loadBoard({
  widthTiles: 28,
  heightTiles: 24,
  entrance: { col: 0, row: 11 },
  exit: { col: 27, row: 11 },
});

/**
 * The entity id the canonical build receives: ids 1 and 2 go to the two creeps
 * spawned at tick 0, so the tower placed at tick 2 (before any further spawn)
 * gets id 3 from the shared entity-id space.
 */
const SCENARIO_TOWER_ID = 3;

/**
 * The canonical input log: a pure function of the tick index (no external RNG —
 * the sim's own seeded RNG supplies in-sim randomness). It exercises the FULL
 * command vocabulary that exists today — single spawns, a multi-command tick, an
 * explicit `noop`, an accepted build into the creeps' lane (forcing a visible
 * re-route), a rejected build (the deterministic-no-op path), and a later sell
 * (re-opening the lane) — so the golden reacts to a behavior change in any of
 * those paths. (The scenario grows as the vocabulary does; a single golden can't
 * cover an unbounded input space, so new commands must be added here when they
 * land.)
 */
function canonicalInputs(tick: number): SimInput[] {
  // Build a 2×2 wall across the straight lane (row 11 at cols 5-6): live creeps
  // must re-route around it.
  if (tick === 2) return [{ kind: 'placeTower', anchor: { col: 5, row: 10 } }];
  // A rejected build (border footprint) — pins the validation-no-op path.
  if (tick === 4) return [{ kind: 'placeTower', anchor: { col: 0, row: 0 } }];
  // Sell the wall — the lane re-opens and later creeps run straight again.
  if (tick === 201) return [{ kind: 'sellTower', tower: SCENARIO_TOWER_ID }];
  // Multi-command tick: two spawns applied in array order (id/order sensitivity).
  if (tick % 15 === 0) {
    return [
      { kind: 'spawnCreep', hp: 12 },
      { kind: 'spawnCreep', hp: 9 },
    ];
  }
  if (tick % 5 === 0) {
    const hp = 8 + (tick % 4) * 2; // 8, 10, 12, 14 cycling
    return [{ kind: 'spawnCreep', hp }];
  }
  if (tick % 7 === 0) return [{ kind: 'noop' }]; // exercise the noop path
  return [];
}

/** Run the canonical scenario, returning the final state and the per-tick hash trace. */
function runCanonical(
  seed = SCENARIO_SEED,
  ticks = SCENARIO_TICKS,
): { state: SimState; trace: string[] } {
  let state = createInitialState(seed);
  const trace: string[] = [];
  for (let t = 0; t < ticks; t++) {
    state = step(state, canonicalInputs(t), SCENARIO_BOARD);
    trace.push(hashSimState(state));
  }
  return { state, trace };
}

// --- GOLDEN — a behavior change here requires a SIM_VERSION bump (CI-enforced) --
// Recompute with: pnpm --filter @wynding/sim exec vitest run determinism
const GOLDEN = {
  finalHash: 'b0636da4',
  traceDigest: '25a976b4', // fnv1a(trace.join(':'))
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

  it('witnesses creeps crossing and leaking (lives fall below the starting count)', () => {
    // The golden is only meaningful if the scenario actually exercises a leak; at
    // least two creeps reach the exit within SCENARIO_TICKS and decrement lives.
    const { state } = runCanonical();
    expect(state.lives).toBeLessThanOrEqual(8); // started at 10 ⇒ ≥2 leaks
  });

  it('witnesses a build, a visible re-route, combat kills, and a sell', () => {
    // The golden must exercise the full Story-3 + Story-4 vocabulary: the tick-2
    // build lands (bounty 80→75, one tower); live creeps visibly leave the straight
    // row-11 lane to route around it; the tower fires and KILLS creeps, each credit
    // raising bounty by KILL_BOUNTY while the tower stands; and the tick-201 sell
    // refunds 3 and removes the tower. Final bounty = 75 + 4 kills + 3 refund = 82.
    let state = createInitialState(SCENARIO_SEED);
    let sawTower = false;
    let towerFirstBounty = -1;
    let sawDetour = false;
    let sawKill = false;
    let prevBounty = state.bounty;
    for (let t = 0; t < SCENARIO_TICKS; t++) {
      state = step(state, canonicalInputs(t), SCENARIO_BOARD);
      if (state.towers.id.length === 1) {
        if (!sawTower) {
          sawTower = true;
          towerFirstBounty = state.bounty; // captured before any kill credits
          expect(state.towers.id[0]).toBe(SCENARIO_TOWER_ID);
        }
        // Bounty rises only from a combat kill while the tower stands (the sell's
        // refund lands the same tick the tower is removed, so towers.length is 0).
        if (state.bounty > prevBounty) sawKill = true;
      }
      if (state.creeps.headRow.some((r) => r !== undefined && r !== 11)) sawDetour = true;
      prevBounty = state.bounty;
    }
    expect(sawTower).toBe(true);
    expect(towerFirstBounty).toBe(75); // 80 − TOWER_COST, rejected build spent nothing
    expect(sawDetour).toBe(true); // the straight-lane board never leaves row 11 unbuilt
    expect(sawKill).toBe(true); // the tower actually killed a creep and earned bounty
    expect(state.towers.id).toHaveLength(0); // sold
    expect(state.bounty).toBe(82); // 75 + 4·KILL_BOUNTY + floor(5·3/4)
  });

  it('continues byte-identically after a mid-run serialize/restore (resume path)', () => {
    const half = SCENARIO_TICKS >> 1;
    const ref = runCanonical();

    // Step to the halfway point, JSON round-trip the state (the runInProgress
    // snapshot / server re-sim boundary, ADR 0008 §5), then continue.
    let live = createInitialState(SCENARIO_SEED);
    for (let t = 0; t < half; t++) live = step(live, canonicalInputs(t), SCENARIO_BOARD);
    const restored = JSON.parse(JSON.stringify(live)) as SimState;

    // Compare the WHOLE resumed tail, not just the final hash — a matching final
    // hash could otherwise mask a diverge-then-reconverge in between. And assert
    // the full serialized state, not just its digest.
    const resumedTail: string[] = [];
    for (let t = half; t < SCENARIO_TICKS; t++) {
      step(restored, canonicalInputs(t), SCENARIO_BOARD);
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
    const state = createInitialState(SCENARIO_SEED);
    let tick = 0;
    const loop = createFixedLoop(
      () => {
        step(state, canonicalInputs(tick), SCENARIO_BOARD);
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
