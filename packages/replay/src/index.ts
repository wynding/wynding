// @wynding/replay — the replay format and its validator.
//
// A replay is the minimal record needed to reproduce a match exactly: the seed, the
// board id, the ruleset hash it was played under, the sim version, and the per-tick
// input log. Because the sim is deterministic, re-running these inputs to a terminal
// state reproduces the exact final world — which is how the server derives a trusted
// score from an untrusted client submission (ADR 0006 anti-cheat spine).

import {
  createInitialState,
  step,
  hashSimState,
  compileRuleset,
  rulesetDigest,
  deriveScore,
  deriveStars,
  isTerminalPhase,
  RulesetError,
  SIM_VERSION,
  MAX_MATCH_TICKS,
  type SimInput,
  type CompiledRuleset,
} from '@wynding/sim';
import type { Ruleset } from '@wynding/types';

/** The wire format for a recorded match. */
export interface Replay {
  readonly seed: number;
  /** Content id of the board the match was played on (selects a board in the ruleset). */
  readonly boardId: string;
  /** Collision-resistant content digest of the ruleset (ADR 0007 §3 — SHA-256 hex). */
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
  /** Authoritative score derived from the terminal state. */
  readonly score?: number;
  /** Star grade derived from the terminal state. */
  readonly stars?: number;
  readonly ticks?: number;
}

/** The ruleset content digest (`rulesetHash`) for a bundle — the shared identity API
 *  (ADR 0007 §3). Used at replay creation to stamp the envelope, and here to bind it. */
export function currentRulesetHash(bundle: Ruleset): string {
  return rulesetDigest(bundle);
}

// Re-simulation budget caps. `tickInputs` is entirely attacker-controlled and reaches
// the replay loop after only the public, forgeable simVersion/rulesetHash checks, so
// without bounds a caller could submit millions of ticks (or inputs per tick) to burn
// CPU until timeout on every request — an unauthenticated compute-exhaustion vector.
/** Absolute hard ceiling on total simulated ticks (log + empty catch-up to terminal).
 *  THE SAME constant `compileRuleset` bounds a bundle's baseline run against — imported,
 *  not duplicated, so the two can never drift into a compiles-but-times-out gap. */
const ABSOLUTE_MAX_CEILING = MAX_MATCH_TICKS;
/** Max ticks in a replay log (30 min at 20 Hz) — the log-length cap, same magnitude. */
const MAX_TICKS = MAX_MATCH_TICKS;
/** Max inputs applied on a single tick — far above any legitimate command burst. */
export const MAX_INPUTS_PER_TICK = 64;
/**
 * Max tower commands (placeTower/sellTower) across the whole match. Each placeTower
 * that reaches the maze-invariant check runs a full grid-wide Dijkstra, and a rejected
 * placement is a free no-op (no bounty spent), so the economy cannot rate-limit
 * repeats — without this cap an attacker could pack minutes of CPU into one replay.
 */
const MAX_TOTAL_TOWER_COMMANDS = 1_000;

/** A 64-char lowercase-hex SHA-256 digest. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The hard tick ceiling the re-simulation may run to. `compileRuleset` already
 * guarantees a bundle's BASELINE run (launch + spawn + slowest full traversal) reaches
 * a terminal state within this bound, so a legitimate replay always terminates below
 * it; the absolute cap then bounds any adversarial build/sell juggling (a finite but
 * pathological extension) and, with it, the validator's CPU per request. A ruleset-
 * derived formula here would only ever saturate to this cap (the juggling term
 * dominates), so the constant is the honest bound.
 */
function tickCeiling(_ruleset: CompiledRuleset): number {
  return ABSOLUTE_MAX_CEILING;
}

/**
 * Domain-validate one (already object-shaped) input against the command union (ADR
 * 0006 §4: a malformed or unknown command makes the replay INVALID). Returns an error
 * description, or null when well-formed. Creep spawns are NOT a command — they come
 * from the ruleset wave schedule (a `spawnCreep` in a log is an unknown command).
 */
function inputDomainError(input: object, ruleset: CompiledRuleset): string | null {
  const kind = (input as { kind?: unknown }).kind;
  switch (kind) {
    case 'noop':
    case 'callWaveEarly':
      return null;
    case 'sellTower': {
      const tower = (input as { tower?: unknown }).tower;
      if (!Number.isSafeInteger(tower)) return 'sellTower.tower must be a safe integer';
      return null;
    }
    case 'placeTower': {
      const anchor = (input as { anchor?: unknown }).anchor;
      if (anchor === null || typeof anchor !== 'object') {
        return 'placeTower.anchor must be a cell';
      }
      const { col, row } = anchor as { col?: unknown; row?: unknown };
      if (!Number.isSafeInteger(col) || !Number.isSafeInteger(row)) {
        return 'placeTower.anchor must have safe-integer col/row';
      }
      const { width, height } = ruleset.board.grid;
      if (
        (col as number) < 0 ||
        (col as number) >= width ||
        (row as number) < 0 ||
        (row as number) >= height
      ) {
        return 'placeTower.anchor is out of bounds';
      }
      return null;
    }
    default:
      return `unknown command kind ${JSON.stringify(kind)}`;
  }
}

const EMPTY_INPUTS: readonly SimInput[] = [];

/**
 * Re-simulate a replay against its ruleset bundle, deriving a trusted terminal score.
 *
 * ADR 0006 terminal contract: (1) strictly validate the envelope (seed, boardId,
 * simVersion, 64-hex rulesetHash) before touching the sim; (2) bind identity — the
 * bundle's digest must equal `replay.rulesetHash`, and `boardId` must resolve; (3)
 * re-run the log then empty ticks until a terminal `phase` or the bounded tick
 * ceiling (a run that never terminates is a timeout — rejected); (4) reject any log
 * input past the terminal transition (padding); (5) derive the score/stars from the
 * terminal state. The sim's freeze-on-terminal makes the final hash independent of
 * trailing empty ticks.
 */
export function validate(replay: Replay, bundle: Ruleset): ValidationResult {
  // (1) Envelope structural validation — before any lookup or simulation.
  if (replay == null || typeof replay !== 'object') {
    return { ok: false, reason: 'replay must be an object' };
  }
  if (!Number.isSafeInteger(replay.seed) || replay.seed < 0 || replay.seed > 0xffffffff) {
    return { ok: false, reason: 'seed must be a uint32 (0..2^32−1)' };
  }
  if (typeof replay.boardId !== 'string' || replay.boardId.length === 0) {
    return { ok: false, reason: 'boardId must be a non-empty string' };
  }
  if (replay.simVersion !== SIM_VERSION) {
    return {
      ok: false,
      reason: `sim version mismatch: replay=${replay.simVersion} runtime=${SIM_VERSION}`,
    };
  }
  if (typeof replay.rulesetHash !== 'string' || !SHA256_HEX.test(replay.rulesetHash)) {
    return { ok: false, reason: 'rulesetHash must be a 64-char hex SHA-256 digest' };
  }

  // (2) Bind identity: the bundle digest must match, and the board must compile. Any
  // malformed bundle (a float that trips canonicalJson, a non-array boards, an
  // unplayable board) surfaces as a RulesetError → a clean rejection, never an
  // unhandled throw out of the validator (validate() is total in its result).
  let digest: string;
  let ruleset: CompiledRuleset;
  try {
    digest = rulesetDigest(bundle);
    ruleset = compileRuleset(bundle, replay.boardId);
  } catch (err) {
    if (err instanceof RulesetError)
      return { ok: false, reason: `invalid ruleset: ${err.message}` };
    return { ok: false, reason: `invalid ruleset: ${(err as Error).message}` };
  }
  if (replay.rulesetHash !== digest) {
    return {
      ok: false,
      reason: `ruleset hash mismatch: replay=${replay.rulesetHash} runtime=${digest}`,
    };
  }

  // (3a) Bound the log before spending CPU (untrusted `tickInputs`).
  if (!Array.isArray(replay.tickInputs)) {
    return { ok: false, reason: 'tickInputs must be an array' };
  }
  if (replay.tickInputs.length > MAX_TICKS) {
    return {
      ok: false,
      reason: `too many ticks: ${replay.tickInputs.length} exceeds limit ${MAX_TICKS}`,
    };
  }
  let totalTowerCommands = 0;
  for (let t = 0; t < replay.tickInputs.length; t++) {
    const inputs = replay.tickInputs[t];
    if (!Array.isArray(inputs)) {
      return { ok: false, reason: `tick ${t} inputs must be an array` };
    }
    if (inputs.length > MAX_INPUTS_PER_TICK) {
      return {
        ok: false,
        reason: `too many inputs at tick ${t}: ${inputs.length} exceeds ${MAX_INPUTS_PER_TICK}`,
      };
    }
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if (input == null || typeof input !== 'object' || !('kind' in input)) {
        return { ok: false, reason: `tick ${t} input ${i} is malformed` };
      }
      const domainError = inputDomainError(input, ruleset);
      if (domainError !== null) {
        return { ok: false, reason: `tick ${t} input ${i}: ${domainError}` };
      }
      if (
        (input.kind === 'placeTower' || input.kind === 'sellTower') &&
        ++totalTowerCommands > MAX_TOTAL_TOWER_COMMANDS
      ) {
        return {
          ok: false,
          reason: `too many tower commands: exceeds limit ${MAX_TOTAL_TOWER_COMMANDS}`,
        };
      }
    }
  }

  // (3b/4) Re-run the log; reject any real COMMAND past the terminal transition. A
  // trailing `noop` or empty tick is benign log padding (the sim is frozen, so it
  // changes nothing) and must NOT reject a legitimately-won replay whose client kept
  // logging (code-review) — only a meaningful command past termination is rejected.
  let state = createInitialState(replay.seed, ruleset);
  let terminalReached = false;
  for (let t = 0; t < replay.tickInputs.length; t++) {
    if (terminalReached) {
      // A canonical replay ENDS at the terminal tick (PLAN §9 / ADR 0006 "rejects
      // replays padded past termination"). ANY further logged tick — even an empty or
      // noop-only one — is padding and rejected; the recording client truncates the log
      // at the win/loss transition. (This is the strict contract the plan specified;
      // the sim's freeze makes trailing ticks inert, but the replay identity must be
      // canonical, so padding is not silently accepted.)
      return { ok: false, reason: `tick ${t} is logged past match termination` };
    }
    state = step(state, ruleset, replay.tickInputs[t]);
    if (isTerminalPhase(state.phase)) terminalReached = true;
  }

  // (3c) If the log ended before terminal, drive empty ticks to terminal or the ceiling.
  if (!terminalReached) {
    const ceiling = tickCeiling(ruleset);
    while (state.tick < ceiling && !isTerminalPhase(state.phase)) {
      state = step(state, ruleset, EMPTY_INPUTS);
    }
    if (!isTerminalPhase(state.phase)) {
      return { ok: false, reason: `replay did not terminate within ${ceiling} ticks (timeout)` };
    }
  }

  // (5) Authoritative score/stars from the terminal state.
  return {
    ok: true,
    finalHash: hashSimState(state),
    score: deriveScore(state, ruleset),
    stars: deriveStars(state, ruleset),
    ticks: state.tick,
  };
}
