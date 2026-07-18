// @wynding/replay — the replay format and its validator.
//
// A replay is the minimal record needed to reproduce a match exactly: the seed,
// the ruleset hash it was played under, the sim version, and the per-tick input
// log. Because the sim is deterministic, re-running these inputs reproduces the
// exact final state — which is how the server derives a trusted score from an
// untrusted client submission.

import { fnv1a } from '@wynding/engine';
import { createInitialState, step, hashSimState, SIM_VERSION, type SimInput } from '@wynding/sim';

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

/**
 * Re-simulate a replay from its seed and input log, deriving a trusted score.
 * This is a validating stub: it enforces the sim-version match and replays every
 * tick, but deeper anti-cheat checks (wall-clock bounds, ruleset verification)
 * are future work.
 */
export function validate(replay: Replay): ValidationResult {
  if (replay.simVersion !== SIM_VERSION) {
    return {
      ok: false,
      reason: `sim version mismatch: replay=${replay.simVersion} runtime=${SIM_VERSION}`,
    };
  }

  let state = createInitialState(replay.seed);
  for (const inputs of replay.tickInputs) {
    state = step(state, inputs);
  }

  return {
    ok: true,
    finalHash: hashSimState(state),
    score: deriveScore(state.lives, state.tick),
    ticks: state.tick,
  };
}
