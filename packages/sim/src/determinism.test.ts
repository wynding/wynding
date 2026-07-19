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
import { createInitialState, step, hashSimState, type SimInput, type SimState } from './index';

/** Fixed seed for the canonical determinism scenario. */
const SCENARIO_SEED = 0x5eed; // 24301
/** Scenario length — long enough for creeps to cross the board and leak lives. */
const SCENARIO_TICKS = 300;

/**
 * The canonical input log: a pure function of the tick index (no external RNG —
 * the sim's own seeded RNG supplies in-sim randomness). Spawns creeps on a fixed
 * cadence with cycling lane and hp, so the scenario exercises spawning, movement,
 * and leaking rather than an idle board.
 */
function canonicalInputs(tick: number): SimInput[] {
  if (tick % 5 !== 0) return [];
  const lane = tick % 3; // 0, 1, 2 cycling
  const hp = 8 + (tick % 4) * 2; // 8, 10, 12, 14 cycling
  return [{ kind: 'spawnCreep', hp, lane }];
}

/** Run the canonical scenario, returning the final state and the per-tick hash trace. */
function runCanonical(
  seed = SCENARIO_SEED,
  ticks = SCENARIO_TICKS,
): { state: SimState; trace: string[] } {
  let state = createInitialState(seed);
  const trace: string[] = [];
  for (let t = 0; t < ticks; t++) {
    state = step(state, canonicalInputs(t));
    trace.push(hashSimState(state));
  }
  return { state, trace };
}

// --- GOLDEN — a behavior change here requires a SIM_VERSION bump (CI-enforced) --
// Recompute with: pnpm --filter @wynding/sim exec vitest run determinism
const GOLDEN = {
  finalHash: '3b5bca16',
  traceDigest: 'd47dedf1', // fnv1a(trace.join(':'))
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

  it('continues byte-identically after a mid-run serialize/restore (resume path)', () => {
    const half = SCENARIO_TICKS >> 1;
    const ref = runCanonical();

    // Step to the halfway point, JSON round-trip the state (the runInProgress
    // snapshot / server re-sim boundary, ADR 0008 §5), then continue.
    let live = createInitialState(SCENARIO_SEED);
    for (let t = 0; t < half; t++) live = step(live, canonicalInputs(t));
    const restored = JSON.parse(JSON.stringify(live)) as SimState;

    // Compare the WHOLE resumed tail, not just the final hash — a matching final
    // hash could otherwise mask a diverge-then-reconverge in between. And assert
    // the full serialized state, not just its digest.
    const resumedTail: string[] = [];
    for (let t = half; t < SCENARIO_TICKS; t++) {
      step(restored, canonicalInputs(t));
      resumedTail.push(hashSimState(restored));
    }
    expect(resumedTail).toEqual(ref.trace.slice(half));
    expect(JSON.stringify(restored)).toBe(JSON.stringify(ref.state));
  });

  it('is frame-rate independent — irregular wall-clock chunks yield the same result', () => {
    const ref = runCanonical();

    // Drive the identical tick sequence through the fixed-timestep loop, feeding
    // wildly irregular dt so tick boundaries never align to frames. The sim
    // advances only in whole ticks (ADR 0005), so the result must be identical.
    const state = createInitialState(SCENARIO_SEED);
    let tick = 0;
    const loop = createFixedLoop(
      () => {
        if (tick >= SCENARIO_TICKS) return; // ignore any overshoot tick
        step(state, canonicalInputs(tick));
        tick++;
      },
      { msPerTick: DEFAULT_MS_PER_TICK },
    );

    // Each chunk is < the spiral-of-death clamp (250 ms), so no ticks are dropped.
    const jitter = [7, 3, 51, 99, 1, 44, 120, 6];
    let ji = 0;
    while (tick < SCENARIO_TICKS) {
      loop.advance(jitter[ji % jitter.length] ?? 1);
      ji++;
    }

    expect(tick).toBe(SCENARIO_TICKS);
    expect(hashSimState(state)).toBe(hashSimState(ref.state));
  });
});
