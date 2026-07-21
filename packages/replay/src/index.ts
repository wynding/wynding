// @wynding/replay — the replay format and its validator.
//
// A replay is the minimal record needed to reproduce a match exactly: the seed,
// the ruleset hash it was played under, the sim version, and the per-tick input
// log. Because the sim is deterministic, re-running these inputs reproduces the
// exact final state — which is how the server derives a trusted score from an
// untrusted client submission.

import { fnv1a } from '@wynding/engine';
import {
  createInitialState,
  step,
  hashSimState,
  SIM_VERSION,
  type SimInput,
  type BoardContext,
} from '@wynding/sim';

/** The wire format for a recorded match. */
export interface Replay {
  readonly seed: number;
  /** Hash of the ruleset/content the match was played under. */
  readonly rulesetHash: string;
  /** Sim behavior version the replay was recorded under. */
  readonly simVersion: number;
  /** Inputs applied on each tick, in order. `tickInputs[t]` runs at tick t. */
  readonly tickInputs: ReadonlyArray<readonly SimInput[]>;
}

/** Outcome of re-simulating a replay. */
export interface ValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
  /** Deterministic content-hash of the final world state. */
  readonly finalHash?: string;
  /** Score derived from the re-simulated final state. */
  readonly score?: number;
  readonly ticks?: number;
}

/** Placeholder ruleset hash for the current sim version (real ruleset digest TBD). */
export function currentRulesetHash(): string {
  return fnv1a(`wynding-ruleset-v${SIM_VERSION}`);
}

/** Score function: survival-based. Lives remaining dominate; ticks break ties. */
function deriveScore(lives: number, ticks: number): number {
  return Math.max(0, lives) * 1000 + ticks;
}

// Re-simulation budget caps. `tickInputs` is entirely attacker-controlled and
// reaches the replay loop after only the public, forgeable simVersion/rulesetHash
// checks, so without bounds a caller could submit millions of ticks (or inputs per
// tick, or spawns) to burn CPU until Lambda timeout on every request — an
// unauthenticated compute-exhaustion / cost-amplification vector. These caps turn
// that open-ended cost into a fixed budget; an over-limit replay is rejected before
// any re-simulation. Values are generous relative to a real match yet finite.
/** Max ticks in a replay: 30 minutes at the 50 ms (20 Hz) tick cadence. */
const MAX_TICKS = 36_000;
/** Max inputs applied on a single tick — far above any legitimate command burst. */
const MAX_INPUTS_PER_TICK = 64;
/** Max creeps spawned across the whole match; caps accumulating per-tick movement cost. */
const MAX_TOTAL_SPAWNS = 10_000;

/**
 * Re-simulate a replay from its seed and input log, deriving a trusted score.
 * This is a validating stub: it enforces the sim-version and ruleset-hash match
 * and replays every tick, but deeper anti-cheat checks (wall-clock bounds,
 * signature verification) are future work. The `board` is supplied by the caller —
 * a replay carries no board identity yet; Story 5 adds `boardId` to the replay and
 * binds a content-derived board hash into `currentRulesetHash`.
 */
export function validate(replay: Replay, board: BoardContext): ValidationResult {
  if (replay.simVersion !== SIM_VERSION) {
    return {
      ok: false,
      reason: `sim version mismatch: replay=${replay.simVersion} runtime=${SIM_VERSION}`,
    };
  }
  if (replay.rulesetHash !== currentRulesetHash()) {
    return {
      ok: false,
      reason: `ruleset hash mismatch: replay=${replay.rulesetHash} runtime=${currentRulesetHash()}`,
    };
  }

  // Bound the re-simulation before spending any CPU on it: reject an over-budget
  // input log (a compute-exhaustion DoS vector, since `tickInputs` is untrusted)
  // with a 4xx via the caller. See the MAX_* budget caps above.
  if (!Array.isArray(replay.tickInputs)) {
    return { ok: false, reason: 'tickInputs must be an array' };
  }
  if (replay.tickInputs.length > MAX_TICKS) {
    return {
      ok: false,
      reason: `too many ticks: ${replay.tickInputs.length} exceeds limit ${MAX_TICKS}`,
    };
  }
  let totalSpawns = 0;
  for (let t = 0; t < replay.tickInputs.length; t++) {
    const inputs = replay.tickInputs[t];
    if (!Array.isArray(inputs)) {
      return { ok: false, reason: `tick ${t} inputs must be an array` };
    }
    if (inputs.length > MAX_INPUTS_PER_TICK) {
      return {
        ok: false,
        reason: `too many inputs at tick ${t}: ${inputs.length} exceeds limit ${MAX_INPUTS_PER_TICK}`,
      };
    }
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      // Each element is untrusted: a non-object or missing-`kind` element would
      // throw a TypeError on the `.kind` read below (and again in `step`), turning
      // a malformed submission into a 500 instead of a clean 4xx. Reject it here.
      if (input == null || typeof input !== 'object' || !('kind' in input)) {
        return { ok: false, reason: `tick ${t} input ${i} is malformed` };
      }
      if (input.kind === 'spawnCreep' && ++totalSpawns > MAX_TOTAL_SPAWNS) {
        return { ok: false, reason: `too many spawns: exceeds limit ${MAX_TOTAL_SPAWNS}` };
      }
    }
  }

  let state = createInitialState(replay.seed);
  for (const inputs of replay.tickInputs) {
    state = step(state, inputs, board);
  }

  return {
    ok: true,
    finalHash: hashSimState(state),
    score: deriveScore(state.lives, state.tick),
    ticks: state.tick,
  };
}
