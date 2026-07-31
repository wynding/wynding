// harness.ts — drives the sim directly, tick by tick, timing each `step()` call (PLAN
// step 19). Deliberately NOT `@wynding/replay`'s `validate()`: that function is total
// in its result (ok/reason/score) but gives no per-tick instrumentation — no wall-clock,
// no due-blast count, no live-creep count, nothing this package's oracle (`oracle.ts`)
// or gate (`gate.ts`) needs. What IS reused from the replay path is the committed
// replay's `tickInputs` — the harness's only input source — so the measured run applies
// the exact same command log the real replay validator would, not a bespoke drive.
//
// `performance.now()` is legal in this file. `packages/perf/src/**` is deliberately
// OUTSIDE `eslint.config.mjs`'s determinism-boundary guard (which covers
// `engine`/`sim`/`replay`/`content` — the replay-verified core) — this package measures
// wall-clock on purpose and ships nowhere, so a later reader should not "fix" this file
// to route through the seeded `Rng` or otherwise remove `performance.now()`.

import {
  compileRuleset,
  createInitialState,
  step,
  countValidTowers,
  type CompiledRuleset,
  type SimPhase,
  type SimState,
  type StepEvents,
} from '@wynding/sim';
import type { Replay } from '@wynding/replay';
import type { Ruleset } from '@wynding/types';

// ADR 0005's measurement methodology, pinned here as named, exported constants —
// PLAN step 19, "it warms up, runs sustained".
/** Ticks 0..199 — the 50 build ticks (each carrying THREE `placeTower` inputs
 *  (`scenario.ts`'s `PLACEMENTS_PER_TICK`), each one triggering a grid-wide Dijkstra
 *  rebuild of the effective distance field) plus the rest of the 100-tick
 *  countdown and the wave's opening. Recorded (so a caller CAN inspect them) but
 *  excluded from every statistic the oracle/gate compute — the build/opening window
 *  is not representative of the sustained workload ADR 0005 budgets. */
export const WARMUP_TICKS = 200;
/** The sustained sampling window: ticks 200..2699 (2,500 ticks), the ticks every
 *  statistic in `oracle.ts`/`gate.ts` is computed over. */
export const SAMPLE_TICKS = 2_500;

/** One sampled tick's raw measurement — everything the oracle and gate need, and
 *  nothing derived (percentiles, subsetting, and pass/fail all happen downstream, in
 *  `stats.ts`/`oracle.ts`/`gate.ts`, so this stays a plain measurement record). */
export interface SampledTick {
  readonly tick: number;
  /** Wall-clock around `step()` ONLY — see `runSampled`'s loop body for why the fresh
   *  `StepEvents` collector is allocated OUTSIDE the timed region. */
  readonly ms: number;
  /** Count of `events.impactPoints` entries with `radiusFp > 0` this tick — a
   *  `targeted` impact (spark) reports `radiusFp === 0` (see `StepEvents`'s doc in
   *  `@wynding/sim`), so this counts blast impacts only, which is the workload the
   *  gate's due-blast subset (`gate.ts`) isolates. */
  readonly dueBlasts: number;
  /** `state.creeps.id.length` after this tick's `step()` — the live creep count. */
  readonly liveCreeps: number;
  /** Count of creeps with `slowMulFp !== 0` — an ACTIVE slow status, ADR 0005's
   *  "status effects live, per the active mix" requirement made countable. */
  readonly slowedCreeps: number;
  readonly phase: SimPhase;
}

/** The post-build facts the oracle needs beyond the sampled-tick series (PLAN step
 *  18's "accepted tower placements" and "leftover bounty" assertions) — snapshotted
 *  right after the replay's build-tick prefix resolves, before any creep spawns. */
export interface RunSampledResult {
  /** Every warm-up tick's measurement (ticks 0..`WARMUP_TICKS`-1), recorded for
   *  inspection but never fed into a statistic. */
  readonly warmup: readonly SampledTick[];
  /** The sustained sampling window's measurements — ticks `WARMUP_TICKS`..
   *  `WARMUP_TICKS + SAMPLE_TICKS - 1`. This is the array the oracle and gate read. */
  readonly samples: readonly SampledTick[];
  /** Valid tower rows immediately after the replay's build-tick prefix
   *  (`replay.tickInputs.length` ticks) resolves — PLAN step 18's "accepted tower
   *  placements" assertion reads this. */
  readonly towersPlacedAfterBuild: number;
  /** `state.bounty` at that same snapshot point — PLAN step 18's independent
   *  second oracle on placement acceptance (see `layout.ts`'s `towerIdAt` doc: 150
   *  placements × cost 12 exactly matches `startingBounty`, so any non-zero leftover
   *  means at least one placement was silently rejected). */
  readonly leftoverBountyAfterBuild: number;
}

/**
 * Runs `replay.tickInputs` against `bundle` for `WARMUP_TICKS + SAMPLE_TICKS` ticks,
 * UNCONDITIONALLY — never stopping early at a terminal phase. This is the entire
 * point of the un-short-circuited loop: `step()` itself freezes on terminal
 * (`@wynding/sim`'s `index.ts`: `if (isTerminalPhase(state.phase)) return state`), so
 * a scenario that reaches `won`/`lost` inside the sampling window would otherwise have
 * every remaining sampled `step()` measure a trivial early return and report
 * superb-looking percentiles over a sim that had already stopped simulating anything.
 * By stepping the full window regardless, a real early termination leaves non-
 * `running` samples in `samples` for `oracle.ts`'s `phase === 'running'` assertion to
 * catch, rather than hiding it.
 *
 * `tickInputs` past the replay's own length are treated as empty — both committed
 * replays are shorter than `WARMUP_TICKS + SAMPLE_TICKS`, so almost the entire run
 * plays no further commands, exactly like the real replay path treats a log shorter
 * than the ticks it re-simulates.
 */
export function runSampled(replay: Replay, bundle: Ruleset): RunSampledResult {
  const ruleset: CompiledRuleset = compileRuleset(bundle, replay.boardId);
  let state: SimState = createInitialState(replay.seed, ruleset);

  const totalTicks = WARMUP_TICKS + SAMPLE_TICKS;
  const warmup: SampledTick[] = [];
  const samples: SampledTick[] = [];
  let towersPlacedAfterBuild = 0;
  // -1, NOT 0 (QC round 1). `LEFTOVER_BOUNTY_THRESHOLD` is 0 — the maze consumes the
  // bundle's entire starting bounty — so initialising this to 0 made the snapshot's own
  // ABSENCE indistinguishable from its success: a replay whose `tickInputs` never reach
  // the snapshot tick reported "leftover bounty: PASS" having never measured anything.
  // Verified: an empty-`tickInputs` replay failed the tower-count assertion (correctly)
  // while passing the bounty one. A sentinel no real bounty can take fails closed.
  let leftoverBountyAfterBuild = -1;

  for (let tick = 0; tick < totalTicks; tick++) {
    const inputs = replay.tickInputs[tick] ?? [];
    // Allocated OUTSIDE the timed region (below): `StepEvents`'s two arrays are
    // per-tick presentational out-params (`@wynding/sim`'s combat.ts), unrelated to
    // `step()`'s own cost — timing their allocation would measure this harness's
    // bookkeeping, not the workload ADR 0005 budgets.
    const events: StepEvents = { impactPoints: [], fired: [] };
    const start = performance.now();
    state = step(state, ruleset, inputs, events);
    const ms = performance.now() - start;

    if (tick === replay.tickInputs.length - 1) {
      towersPlacedAfterBuild = countValidTowers(
        ruleset.board.grid,
        state.towers,
        ruleset.towerById,
      );
      leftoverBountyAfterBuild = state.bounty;
    }

    let dueBlasts = 0;
    for (const point of events.impactPoints) {
      if (point.radiusFp > 0) dueBlasts++;
    }
    let slowedCreeps = 0;
    for (const mul of state.creeps.slowMulFp) {
      if (mul !== 0) slowedCreeps++;
    }
    const record: SampledTick = {
      tick,
      ms,
      dueBlasts,
      liveCreeps: state.creeps.id.length,
      slowedCreeps,
      phase: state.phase,
    };
    if (tick < WARMUP_TICKS) {
      warmup.push(record);
    } else {
      samples.push(record);
    }
  }

  return { warmup, samples, towersPlacedAfterBuild, leftoverBountyAfterBuild };
}
