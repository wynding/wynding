// oracle.ts — the workload oracle (PLAN step 18, HANDOFF-M2-S4B.md "The workload
// oracle is the point of the whole story"). A passing perf run proves nothing about
// what it measured: `placeTower` on an illegal anchor or with insufficient bounty is a
// deterministic no-op, and `step()` freezes on terminal, so a mis-authored scenario can
// silently degrade into an idle or near-empty benchmark and still report excellent
// percentiles. Every assertion below closes one specific way that could happen — see
// PLAN step 18's list.
//
// EVERY THRESHOLD HERE WAS COMMITTED BEFORE MEASUREMENT (Codex R2-2), WITH TWO NAMED
// EXCEPTIONS. If a measured value misses a threshold, that is a finding to escalate to
// the owner (PLAN step 18: "escalated as a finding, never lowered to fit") — never a cue
// to edit the threshold.
//
// The two exceptions are REGRESSION TRIPWIRES PINNED TO A MEASURED VALUE, which is a
// different kind of number and is called out as such where each is declared:
// `ROUTE_LENGTH_FLOOR` (329, what this maze actually achieves) and
// `MEDIAN_LIVE_CREEPS_THRESHOLD` (200, set below the measured 224). Neither asserts that
// the scene meets ADR 0005's target — the pre-committed thresholds do that — they assert
// that it has not got WORSE than what S4b recorded. Calling them "committed before
// measurement" would be false, and the distinction is the whole methodological point:
// a target chosen after seeing results is post-hoc tuning; a tripwire pinned to a result
// is a regression guard.
//
// Beyond `KNOWN_OPEN_ASSERTIONS` below — a narrow, owner-acknowledged, by-value-pinned
// list — there is deliberately no waiver, override, or skip mechanism: a threshold that
// can be bypassed is not a threshold.

import { percentile } from './stats';
import type { SampledTick } from './harness';

/** Accepted tower placements must be EXACTLY 150 — the layout's full anchor count
 *  (`layout.ts`'s `stressAnchors()`). Fewer means at least one placement was rejected
 *  (illegal anchor or insufficient bounty); more is impossible given the replay only
 *  issues 150 `placeTower` commands, so this also catches a corrupted replay. */
export const TOWERS_PLACED_THRESHOLD = 150;

/** Peak concurrent live creeps, over the sampled window, must be at least 280 — ADR
 *  0005's "~300 concurrent" target, with headroom for the natural ebb of a wave
 *  clearing before the next stacks on top of it. */
export const PEAK_LIVE_CREEPS_THRESHOLD = 280;

/** MEDIAN live creeps across the window must be at least 200 (QC round 1).
 *
 *  The peak floor above is necessary but not sufficient, and on its own it is
 *  exploitable: a window of one tick at 304 creeps followed by 2,499 ticks at ONE creep
 *  passes every other assertion in this file, including "qualifying sustained samples"
 *  (which only asks `liveCreeps > 0`). That was verified against a synthetic window —
 *  all eight assertions PASSED over a board that was 99.96% empty. The gate would pass
 *  too, and in the worst way: `stressStat` would be a p99 over near-empty ticks, so R
 *  would FALL and read as an improvement.
 *
 *  Nothing exploits it today (the real run measures a median of 224), but S5–S10 each
 *  make towers stronger, and any change that kills creeps faster or shortens the ramp
 *  collapses the median while one peak tick survives. A peak is a moment; ADR 0005 asks
 *  for load that is SUSTAINED, so the oracle should assert the sustained thing too. 200
 *  sits below the measured 224 with room for ordinary drift, and far above the ~1 a
 *  degenerate window would produce.
 *
 *  ("all eight assertions PASSED" above describes the eight that existed at the time
 *  this paragraph was written — this file has since grown more; read it as a historical
 *  count of that measurement, not a present count of this file's assertion list.) */
export const MEDIAN_LIVE_CREEPS_THRESHOLD = 200;

/** The scripted maze's entrance-to-exit route must be at least 600 cells — otherwise
 *  creeps clear the board too fast for 304 spawns (16 × 19, staggered) to ever be
 *  concurrently on the board at once, silently undershooting the ADR's concurrency
 *  target regardless of how many creeps are scheduled to spawn. */
export const ROUTE_LENGTH_THRESHOLD = 600;

/** The measured route-length FLOOR — 329 cells, the value this maze actually
 *  achieves — and, unlike `ROUTE_LENGTH_THRESHOLD` above, deliberately NOT eligible for
 *  `KNOWN_OPEN_ASSERTIONS` (see that list's doc: the 600-cell shortfall is the one
 *  waived entry today). `run.ts`'s `[KNOWN-OPEN]` tag on the 600-cell assertion prints
 *  under ESCALATION but exits 0 — that waiver is correct for the gap between 329 and
 *  600 (an owner-acknowledged, not-yet-resolved shortfall), but on its own it left
 *  EVERYTHING below 329 unmonitored too: a regression from 329 down to, say, 1 would
 *  print under the same `[KNOWN-OPEN]` tag and exit 0, invisible to CI. This second,
 *  un-waivable assertion pins the floor we actually measured, under a DISTINCT name
 *  from the 600-cell one, so it is never added to `KNOWN_OPEN_ASSERTIONS` by a future
 *  edit that means to waive the other one. The waiver covers 329..600; it covers
 *  nothing below 329. */
export const ROUTE_LENGTH_FLOOR = 329;

/** Every sample in the window must have `phase === 'running'`. A single non-`running`
 *  sample means the scenario reached a terminal state INSIDE the sampling window —
 *  `step()` freezes on terminal, so every subsequent sampled tick in that run would be
 *  a trivial early return, not a measurement of the sustained workload. */
export const REQUIRE_ALL_RUNNING = true;

/**
 * Assertions in this list are OWNER-ACKNOWLEDGED OPEN FINDINGS (QC round 1) — a
 * narrow, named exception to "there is deliberately no waiver, override, or skip
 * mechanism" above, not a reopening of it:
 *   - An entry here does NOT lower its threshold. The assertion still runs, still
 *     reports measured-vs-threshold exactly as before, and still prints under
 *     `run.ts`'s `ESCALATION` block.
 *   - It only stops THAT ONE finding from masking every other signal in the exit code
 *     (`run.ts`'s `evaluateEscalation`, `escalation.ts`). Any OTHER oracle failure, and
 *     ANY gate failure, still exits `run.ts` non-zero.
 *   - If a known-open assertion starts PASSING, `run.ts` says so LOUDLY and tells the
 *     reader to remove it — a stale waiver is its own defect, silently accreting scope
 *     for a finding that has already been fixed.
 *   - The list is emptied by an OWNER RULING, not by a passing run. A green local run
 *     is not authorization to delete an entry.
 *
 * Currently: the scripted maze's route length (`ROUTE_LENGTH_THRESHOLD` above), a
 * real, measured shortfall (329 cells vs the committed 600-cell floor) escalated to
 * the owner per PLAN step 18 — "never lowered to fit" — and not yet resolved.
 */
export const KNOWN_OPEN_ASSERTIONS: readonly string[] = ['scripted maze route length'];

/** At least 500 samples (an ABSOLUTE count, not a ratio of the window) must have at
 *  least one due blast. This is deliberately a count, not a percentage: it is ALSO the
 *  sample size the gate's p99 (`gate.ts`, PLAN step 21) is computed over, and a
 *  percentage floor could pass while leaving that subset too small for a p99 to mean
 *  anything (e.g. a 20% floor over a short window could still be a handful of
 *  samples). ~150 blast towers at cadence 60, staggered across the build ticks, put a
 *  due blast on the large majority of ticks — this floor is comfortably reachable if
 *  the scene is tuned as ADR 0005 intends. */
export const DUE_BLAST_SAMPLES_THRESHOLD = 500;

/** At peak, at least 100 creeps must carry an active status (`slowMulFp !== 0`) — the
 *  restated form of Codex finding R1-2: a scene with towers but no live status effects
 *  does not exercise ADR 0005's "active mix" at all, regardless of how busy it looks. */
export const PEAK_ACTIVE_STATUS_THRESHOLD = 100;

/** At least 2,000 samples must QUALIFY (see `isQualifyingSample` below). This is the
 *  headline "was the sim actually doing sustained work" floor — a run that idles for
 *  most of the window (terminal, or a swept board) still needs comfortably fewer than
 *  2,000/2,500 qualifying samples to fail here. */
export const QUALIFYING_SAMPLES_THRESHOLD = 2_000;

/** Leftover bounty after the build-tick prefix must be exactly 0 — the independent
 *  SECOND oracle on placement acceptance (`layout.ts`'s `towerIdAt` doc): 150
 *  placements × cost 12 exactly matches `startingBounty`, so ANY leftover means at
 *  least one placement was silently rejected (a rejected `placeTower` is a no-op that
 *  leaves the spent bounty unspent, never throws) even if `towersPlacedAfterBuild`
 *  somehow still read 150 by coincidence of a different failure. */
export const LEFTOVER_BOUNTY_THRESHOLD = 0;

/** A sample QUALIFIES when the sim was actually simulating a populated board this
 *  tick: `phase === 'running'` AND at least one creep is live. A `running` tick with
 *  zero live creeps (e.g. between waves, or after every spawned creep has already
 *  leaked/died) is real simulation time but not the SUSTAINED workload ADR 0005's
 *  budgets describe — counting it toward the floor would let an otherwise-idle window
 *  pass by riding on ticks where `step()` had almost nothing to do. */
/** A sample where at least one blast landed. Exported so `run.ts`'s gate subset and this
 *  file's `DUE_BLAST_SAMPLES_THRESHOLD` count are provably THE SAME SET — `gate.ts`'s p99
 *  reasoning leans on that ("with the oracle's >= 500-sample due-blast floor, p99 discards
 *  roughly the top 5 observations"), which is only true if the floor counts what the
 *  statistic is computed over. It was a hand-copied `s.dueBlasts >= 1` in both files; this
 *  repo has already removed three other copies of exactly this kind. */
export function isDueBlastSample(sample: SampledTick): boolean {
  return sample.dueBlasts >= 1;
}

export function isQualifyingSample(sample: SampledTick): boolean {
  return sample.phase === 'running' && sample.liveCreeps > 0;
}

/** One assertion's result: the measured value, the committed threshold, and whether it
 *  passed. `measured`/`threshold` are `number | boolean` so the phase assertion (a
 *  pure yes/no over the whole window) and the numeric assertions share one shape. */
export interface OracleAssertion {
  readonly name: string;
  readonly measured: number | boolean;
  readonly threshold: number | boolean;
  readonly pass: boolean;
}

/** The oracle's full result: every assertion, plus the overall pass/fail (AND of all
 *  of them) so a caller never has to re-derive it from the list. */
export interface OracleResult {
  readonly assertions: readonly OracleAssertion[];
  readonly pass: boolean;
}

/** Inputs the oracle needs beyond the sampled-tick series — facts pinned by
 *  construction (the scripted layout) or measured once, outside the per-run harness
 *  (`routeLength`, from `layout.ts`'s `stressRouteLength`; passed in here rather than
 *  recomputed so `runOracle` stays a pure function of its arguments, with no
 *  dependency on `@wynding/sim`'s pathfinding module).
 *
 *  `routeLength` is derived from the INTENDED layout (`stressAnchors()`/`towerIdAt()`
 *  fed through `materializeTowerMask`) — NOT from the run's realized `state.towers`.
 *  That means this assertion cannot detect a realized maze that differs from the
 *  intended one (e.g. a placement silently rejected mid-build, leaving a gap the
 *  intended layout doesn't have): it is a static property of the scripted anchors, not
 *  a live property of the sampled run. The "accepted tower placements" and "leftover
 *  bounty" assertions above are what catch a rejected placement; this one is purely
 *  about whether the INTENDED maze is long enough. */
export interface OracleInput {
  readonly samples: readonly SampledTick[];
  readonly towersPlacedAfterBuild: number;
  readonly leftoverBountyAfterBuild: number;
  readonly routeLength: number;
}

/** Runs every PLAN step 18 assertion against one stress run's sampled-tick series and
 *  post-build facts. Pure — no I/O, no sim invocation — so it is unit-testable against
 *  synthetic sample arrays (`oracle.test.ts`) without ever running the sim. */
export function runOracle(input: OracleInput): OracleResult {
  const { samples, towersPlacedAfterBuild, leftoverBountyAfterBuild, routeLength } = input;

  // `samples.every(...)` on an EMPTY array is vacuously `true` — the one assertion in
  // this file that would otherwise NOT fail closed (QC: the vacuous-pass on an empty window). An empty
  // sampling window is itself a broken run (nothing was measured at all), so require a
  // non-empty window explicitly rather than let `Array.prototype.every`'s vacuous-truth
  // semantics quietly report "every sample passed" over zero samples.
  const allRunning = samples.length > 0 && samples.every((s) => s.phase === 'running');
  const peakLiveCreeps = samples.reduce((max, s) => Math.max(max, s.liveCreeps), 0);
  // Guarded against an empty window for the same fail-closed reason as `allRunning`
  // above: `percentile` throws on an empty set, and a 0 here reads as a real, failing
  // measurement rather than an absent one.
  const medianLiveCreeps =
    samples.length > 0
      ? percentile(
          samples.map((s) => s.liveCreeps),
          50,
        )
      : 0;
  const dueBlastSampleCount = samples.reduce((n, s) => n + (isDueBlastSample(s) ? 1 : 0), 0);
  const peakActiveStatus = samples.reduce((max, s) => Math.max(max, s.slowedCreeps), 0);
  const qualifyingSampleCount = samples.reduce((n, s) => n + (isQualifyingSample(s) ? 1 : 0), 0);

  const assertions: OracleAssertion[] = [
    {
      name: 'accepted tower placements',
      measured: towersPlacedAfterBuild,
      threshold: TOWERS_PLACED_THRESHOLD,
      pass: towersPlacedAfterBuild === TOWERS_PLACED_THRESHOLD,
    },
    {
      name: 'leftover bounty after build',
      measured: leftoverBountyAfterBuild,
      threshold: LEFTOVER_BOUNTY_THRESHOLD,
      pass: leftoverBountyAfterBuild === LEFTOVER_BOUNTY_THRESHOLD,
    },
    {
      name: 'peak concurrent live creeps',
      measured: peakLiveCreeps,
      threshold: PEAK_LIVE_CREEPS_THRESHOLD,
      pass: peakLiveCreeps >= PEAK_LIVE_CREEPS_THRESHOLD,
    },
    {
      name: 'median live creeps (sustained load)',
      measured: medianLiveCreeps,
      threshold: MEDIAN_LIVE_CREEPS_THRESHOLD,
      pass: medianLiveCreeps >= MEDIAN_LIVE_CREEPS_THRESHOLD,
    },
    {
      name: 'scripted maze route length',
      measured: routeLength,
      threshold: ROUTE_LENGTH_THRESHOLD,
      pass: routeLength >= ROUTE_LENGTH_THRESHOLD,
    },
    {
      name: 'scripted maze route length — measured floor',
      measured: routeLength,
      threshold: ROUTE_LENGTH_FLOOR,
      pass: routeLength >= ROUTE_LENGTH_FLOOR,
    },
    {
      name: 'phase === running for every sample',
      measured: allRunning,
      threshold: REQUIRE_ALL_RUNNING,
      pass: allRunning === REQUIRE_ALL_RUNNING,
    },
    {
      name: 'samples with >= 1 due blast',
      measured: dueBlastSampleCount,
      threshold: DUE_BLAST_SAMPLES_THRESHOLD,
      pass: dueBlastSampleCount >= DUE_BLAST_SAMPLES_THRESHOLD,
    },
    {
      name: 'creeps with an active status, at peak',
      measured: peakActiveStatus,
      threshold: PEAK_ACTIVE_STATUS_THRESHOLD,
      pass: peakActiveStatus >= PEAK_ACTIVE_STATUS_THRESHOLD,
    },
    {
      name: 'qualifying sustained samples',
      measured: qualifyingSampleCount,
      threshold: QUALIFYING_SAMPLES_THRESHOLD,
      pass: qualifyingSampleCount >= QUALIFYING_SAMPLES_THRESHOLD,
    },
  ];

  return { assertions, pass: assertions.every((a) => a.pass) };
}
