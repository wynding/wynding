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

import { MAX_DOT_RECORDS } from '@wynding/sim';
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
 *  too, and in the worst way: `stressStat` would be a percentile over near-empty ticks, so
 *  R would FALL and read as an improvement.
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

/** The scripted maze's entrance-to-exit route floor: **329 cells**, the value this maze
 *  actually achieves. A route that is too short lets creeps clear the board faster than
 *  304 staggered spawns (16 × 19) can accumulate, silently undershooting the ADR's
 *  concurrency target regardless of how many creeps are scheduled.
 *
 *  RE-PINNED FROM 600 BY OWNER RULING, 2026-07-31. S4b committed 600 before measuring,
 *  carried the 329 shortfall as a known-open finding, and escalated it rather than
 *  lowering it to fit. The escalation was answered: 600 is not reachable at ADR 0005's
 *  own ~150-tower figure on any board size (a 2×2 tower buys ≈2.2 cells of route, capping
 *  near 330; measured 307/298/308/329 on 40×40/50×50/60×60/80×80), and on the committed
 *  40×40 board it is unreachable at ANY tower count — twelve bands is all that fits,
 *  capping at 459. Reaching 600 needs both a larger board and roughly 270 towers, which
 *  would make the scene less like real play, not more. So the floor is now the measured
 *  value, with that reasoning recorded here and in ADR 0005's finding 2.
 *
 *  This is a REGRESSION TRIPWIRE with zero slack, and that is deliberate: the sim is
 *  fully deterministic against a committed replay, so an unchanged layout reproduces 329
 *  exactly. Any drop fails CI. There is no longer a waiver above it — the previous
 *  arrangement (a waived 600 assertion plus this un-waivable floor beneath it) existed
 *  only to stop the 329..600 gap masking everything below 329, and collapses to a single
 *  assertion now that the gap is closed by ruling. */
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
 * **Currently EMPTY**, and that is the intended resting state. Its one entry — the
 * scripted maze's 329-vs-600 route shortfall — was resolved by owner ruling on
 * 2026-07-31 (see `ROUTE_LENGTH_FLOOR` above): the floor was re-pinned to the measured
 * value, so the assertion passes on its own terms and needs no waiver. The mechanism
 * stays because the next escalated-but-unresolved finding will need it; an empty list
 * means every oracle assertion currently fails CI on its own merits, which is the
 * healthy state.
 */
export const KNOWN_OPEN_ASSERTIONS: readonly string[] = [];

/** At least 500 samples (an ABSOLUTE count, not a ratio of the window) must have at
 *  least one due blast. This is deliberately a count, not a percentage: it is ALSO the
 *  sample size the gate's p95 (`gate.ts`, PLAN step 21 — p99 until M2-S5b P11) is
 *  computed over, and a percentage floor could pass while leaving that subset too small
 *  for that percentile to mean anything (e.g. a 20% floor over a short window could still be a handful of
 *  samples). ~150 blast towers at cadence 60, staggered across the build ticks, put a
 *  due blast on the large majority of ticks — this floor is comfortably reachable if
 *  the scene is tuned as ADR 0005 intends. */
export const DUE_BLAST_SAMPLES_THRESHOLD = 500;

/** At peak, at least 100 creeps must carry an active SLOW status (`slowMulFp !== 0`) —
 *  the restated form of Codex finding R1-2: a scene with towers but no live status
 *  effects does not exercise ADR 0005's "active mix" at all, regardless of how busy it
 *  looks.
 *
 *  RENAMED from `PEAK_ACTIVE_STATUS_THRESHOLD` at M2-S5b P10. The old name's assertion
 *  read "creeps with an active status, at peak" but only ever counted `slowedCreeps`
 *  (`harness.ts`'s `if (mul !== 0) slowedCreeps++`). With DoT shipped, a
 *  poisoned-but-unslowed creep genuinely has an active status and was NOT counted, so
 *  the old name was false. The rename is a NAME fix only — the metric itself is not
 *  widened to also count DoT-carrying creeps, which would silently change what this
 *  pre-committed floor means. `dotTicks`/`dotRecords`/`dotCarriers` get their own,
 *  separate assertions below instead. */
export const PEAK_SLOWED_CREEPS_THRESHOLD = 100;

/** Peak concurrent DoT records (`dotRecords`, `state.dots.length` post-step), over the
 *  sampled window — at least 150. The ratio gate caps one source at
 *  `floor((240-1)/30)+1 = 8` live records (`stress-venom`'s `durationTicks`/
 *  `cadenceTicks`, `layout.ts`'s doc), so 50 venom towers give an arithmetic ceiling of
 *  400 concurrent records. 150 is comfortably below that ceiling while still proving
 *  sustained DoT residency, not a handful of transient hits. */
export const PEAK_DOT_RECORDS_THRESHOLD = 150;

/** Record depth per carrier, `dotRecords / dotCarriers` AT THE SAMPLED TICK WITH PEAK
 *  `dotRecords` — at least 6.
 *
 *  OWNER AMENDMENT, 2026-08-03 — REPLACES, not lowers, PLAN.md step 17's "peak creeps
 *  carrying >= 1 DoT record: >= 100" (ceiling 304, "a carrier is a creep, so the
 *  ceiling is the spawn count"). That derivation was mis-derived, not merely
 *  unreachable-by-bad-luck: "a carrier is a creep" bounds nothing about how many
 *  DISTINCT creeps a scene's targeting will actually spread records across, and this
 *  scene doesn't — the stress arm's measured peak is 19 carriers, far below the
 *  deleted floor.
 *
 *  MEASURED, both arms, same board/seed/anchors/targeting, same run (packet
 *  M2-S5b P10 §1):
 *
 *      arm       peak dotRecords   peak dotCarriers   record depth @ peak-records tick
 *      stress    175               19                 9.211
 *      control   368               127                2.921
 *
 *  THE CAUSE, established by the control arm's own numbers, is NOT sticky targeting.
 *  (An earlier draft of this comment blamed `combat.ts`'s sticky "first" targeting and
 *  said "neither lever the plan authorized can move it" — both claims were wrong, and
 *  this paragraph replaces them.) Both arms run the identical 50 `stress-venom`
 *  towers, at identical anchors, on the identical board and seed, under the IDENTICAL
 *  sticky targeting — and the control reaches 127 carriers, well above the deleted
 *  >= 100 floor. If sticky targeting suppressed carrier count, it would suppress it
 *  equally in both arms; it does not, so it is not the cause.
 *
 *  The real cause is the OTHER 100 towers' composition. The stress arm runs
 *  `stress-chill`'s AoE slow, which bunches creeps into a tight leading cohort — the
 *  venom towers' sticky targets stay inside that cohort, so most shots REFRESH an
 *  existing `(targetId, sourceId)` pair instead of seeding a new one, and depth
 *  (records per carrier) climbs while carrier count stays flat. The control runs
 *  `stress-chill-single`'s thin single-target slow instead, which lets creeps stream
 *  past uncondensed, so each shot is far more likely to land on a creep that isn't
 *  already carrying that source's record — a fresh pair, a fresh carrier — and
 *  dispersion climbs instead of depth.
 *
 *  CHANGING THE TOWER SHARE IS A LIVE LEVER that could plausibly push carriers past
 *  100 on this scene. PLAN step 12 routes exactly this decision to the owner
 *  ("Escalate to Rob before changing the tower share, since that moves what `R`
 *  measures") — because reshaping the AoE/single-target mix would also move the ratio
 *  gate's numerator/denominator composition, not just this oracle's carrier count. It
 *  was escalated, CONSIDERED, and DECLINED on 2026-08-03 in favour of the depth floor
 *  below: the tower share stays as PR B / P9 shaped it.
 *
 *  Rob's ruling, 2026-08-03: the >= 100 carriers floor is REPLACED, not lowered, by a
 *  RECORD-DEPTH floor, which pins what this scene actually stresses. 175 records over
 *  19 carriers is ~9.2 records per creep — and that per-creep record list is exactly
 *  what `applyDot`'s `(targetId, sourceId)` pair lookup scans on every application, so
 *  it is a STRONGER DoT stressor than dispersion, not a weaker one.
 *
 *  KNOWN BLIND SPOT, also owner-accepted 2026-08-03 (packet §2) — DISPERSION IS
 *  DELIBERATELY UNGATED, not merely unmeasured. Depth is a ratio whose DENOMINATOR is
 *  the thing that can collapse, so depth RISES as dispersion FALLS:
 *  `PEAK_DOT_RECORDS_THRESHOLD` (>= 150) needs only >= 3 carriers to also satisfy this
 *  floor (<= 50 records per creep x 50 venom towers), so a scene where carriers fell
 *  19 -> 4 while records held at 200 would report BOTH floors green — depth 50,
 *  records 200 — on a run whose DoT dispersion had collapsed nearly 5x. This run's own
 *  two arms demonstrate the two axes moving in OPPOSITE directions on real data: the
 *  control's depth (2.921) would FAIL this floor outright while carrying 6.7x the
 *  stress arm's dispersion (127 vs 19 peak carriers) — which is exactly why one floor
 *  cannot cover both axes at once. Rob's ruling: accept the gap rather than invent a
 *  post-hoc carriers threshold to close it. `dotCarriers` is reported, not gated, for
 *  BOTH arms (`run.ts`'s preflight output, and a reported-not-gated row alongside each
 *  arm's oracle/control-sanity assertions) so a reviewer can always see the number
 *  even though nothing fails on it.
 *
 *  `dotCarriers` is NOT deleted — it is still collected and reported (`SampledTick`,
 *  `run.ts`'s summaries) — it is simply not the gated quantity here. */
export const DOT_RECORD_DEPTH_THRESHOLD = 6;

/** At least 500 samples must have `dotTicks >= 1` (an ABSOLUTE count, like the
 *  due-blast floor above, and for the same reason: it is also a candidate sample size
 *  for any future DoT-focused statistic, so a percentage floor could pass while leaving
 *  too few samples for that to mean anything). */
export const DOT_ACTIVE_SAMPLES_THRESHOLD = 500;

/** Peak concurrent live creeps with nonzero CATALOG armor (`armoredLive`) — at least
 *  50. 114 `stress-armored` creeps spawn (`layout.ts`'s wave-entry doc); the floor sits
 *  well under that.
 *
 *  LIMIT, recorded not fixed (packet §6): this gates CATALOG armor only, i.e. that
 *  armored creeps are PRESENT, not that armor MITIGATION is actually being applied. A
 *  regression that deleted armor mitigation in `applyImpactToCreep` would leave
 *  `armoredLive` at its measured peak (114) and this assertion would still pass —
 *  there is no armor analogue of `dotTicks` (a count of applications actually
 *  applied) to close that gap. */
export const PEAK_ARMORED_LIVE_THRESHOLD = 50;

/** Dropped DoT applications, WHOLE RUN (warm-up + sampled ticks, `harness.ts`'s
 *  `RunSampledResult.dotDroppedTotal`) — must be EXACTLY 0, for the stress arm. The
 *  control arm gets its own copy of this same threshold as a sanity check in `run.ts`
 *  (mirroring how `TOWERS_PLACED_THRESHOLD`/`LEFTOVER_BOUNTY_THRESHOLD` are echoed
 *  there for the control run). A below-cap post-step `dotRecords` count proves nothing
 *  on its own: the same tick's expiry can mask a drop that happened earlier in the same
 *  tick — `dotDropped === 0` is the only thing that actually proves no application was
 *  silently discarded for want of table capacity (`combat.ts`'s `applyDot`,
 *  `MAX_DOT_RECORDS`).
 *
 *  LIMIT, recorded not fixed (packet §6): `MAX_DOT_RECORDS` is 9,000 and the measured
 *  peak `dotRecords` is 175 (stress) / 368 (control) — ~24x away from the only
 *  condition that can make this counter nonzero. The assertion is correct as
 *  specified and stays as the guard row, but a green result here is not evidence the
 *  warm-up-inclusive drop-aggregation path has ever actually been exercised: no run
 *  to date has come remotely close to triggering it. */
export const DOT_DROPPED_THRESHOLD = 0;

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

/** A sample where at least one blast landed. Exported so `run.ts`'s gate subset and this
 *  file's `DUE_BLAST_SAMPLES_THRESHOLD` count are provably THE SAME SET — `gate.ts`'s
 *  numerator reasoning leans on that (it now reads "with the oracle's >= 500-sample
 *  due-blast floor, p95 discards the top ~5%"; it said p99 until M2-S5b P11), which is only true if the floor counts what the
 *  statistic is computed over. It was a hand-copied `s.dueBlasts >= 1` in both files; this
 *  repo has already removed three other copies of exactly this kind. */
export function isDueBlastSample(sample: SampledTick): boolean {
  return sample.dueBlasts >= 1;
}

/** A sample QUALIFIES when the sim was actually simulating a populated board this
 *  tick: `phase === 'running'` AND at least one creep is live. A `running` tick with
 *  zero live creeps (e.g. between waves, or after every spawned creep has already
 *  leaked/died) is real simulation time but not the SUSTAINED workload ADR 0005's
 *  budgets describe — counting it toward the floor would let an otherwise-idle window
 *  pass by riding on ticks where `step()` had almost nothing to do. */
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
  /** `RunSampledResult.dotDroppedTotal` — the WHOLE-RUN dropped-DoT-application total
   *  (warm-up + sampled ticks), not a value derived from `samples` alone. DoT activity
   *  begins inside `WARMUP_TICKS`, so a total computed only over `samples` would be
   *  blind to a drop during warm-up (M2-S5b P10). */
  readonly dotDroppedTotal: number;
}

// --- DoT reductions, shared with `run.ts`'s preflight report (M2-S5b P10 packet §3).
//
// `run.ts`'s `dotPreflight` block used to re-implement `dotRecordDepthAtPeak`,
// `peakDotRecords`, `dotActiveSampleCount`, and `peakArmoredLive` independently of
// this file's own reductions, and `PERF-REPORT` published both under different keys
// — currently identical, but with nothing revealing they were separately derived.
// This repo has a standing policy against exactly this kind of hand-copy
// (`isDueBlastSample`'s doc above: "this repo has already removed three other copies
// of exactly this kind"). These are now the ONE derivation; `run.ts` imports and
// calls them rather than re-deriving.

/** Internal: peak `dotRecords` (`state.dots.length` post-step) over the sampled
 *  window, AND the `dotCarriers` value AT that same tick — the shared loop every
 *  exported peak-dotRecords-tick reduction below reads from, so "the tick with peak
 *  records" is computed once, not once per reduction. `>` (not `>=`) so a tie keeps
 *  the FIRST tick reaching the max, matching `peakLiveCreeps`-style reductions in
 *  `runOracle` below. */
function peakDotRecordsTick(samples: readonly SampledTick[]): {
  peakDotRecords: number;
  carriersAtPeak: number;
} {
  let peakDotRecords = 0;
  let carriersAtPeak = 0;
  for (const s of samples) {
    if (s.dotRecords > peakDotRecords) {
      peakDotRecords = s.dotRecords;
      carriersAtPeak = s.dotCarriers;
    }
  }
  return { peakDotRecords, carriersAtPeak };
}

/** Peak `dotRecords` over the sampled window — the quantity
 *  `PEAK_DOT_RECORDS_THRESHOLD` gates and the headroom row reports against
 *  `MAX_DOT_RECORDS`. */
export function peakDotRecords(samples: readonly SampledTick[]): number {
  return peakDotRecordsTick(samples).peakDotRecords;
}

/** `dotCarriers` AT the tick with peak `dotRecords` — the denominator
 *  `dotRecordDepthAtPeak` divides by. Exported so `run.ts`'s preflight line can print
 *  the SAME value the depth ratio was computed from, rather than the plain
 *  window-wide peak of `dotCarriers` (`peakDotCarriers` below) — a DIFFERENT
 *  reduction that need not land on the same tick. See `DOT_RECORD_DEPTH_THRESHOLD`'s
 *  doc and packet §5 for why conflating the two is exactly the ambiguity this split
 *  exists to remove. */
export function dotCarriersAtPeakDotRecords(samples: readonly SampledTick[]): number {
  return peakDotRecordsTick(samples).carriersAtPeak;
}

/** Record depth per carrier, `dotRecords / dotCarriers`, AT the tick with peak
 *  `dotRecords` — see `DOT_RECORD_DEPTH_THRESHOLD`'s doc. Guarded against division by
 *  zero the same fail-closed way as `medianLiveCreeps` in `runOracle` below: a window
 *  with no DoT records at all reports a depth of 0, which correctly fails the
 *  threshold rather than throwing or reading `NaN`. */
export function dotRecordDepthAtPeak(samples: readonly SampledTick[]): number {
  const { peakDotRecords: peak, carriersAtPeak } = peakDotRecordsTick(samples);
  return carriersAtPeak > 0 ? peak / carriersAtPeak : 0;
}

/** Window-wide peak `dotCarriers` — the DISPERSION axis `DOT_RECORD_DEPTH_THRESHOLD`
 *  deliberately does not gate (its doc, packet §2). This is the plain max over every
 *  sampled tick, independent of which tick `dotRecords` itself peaked on — the number
 *  the measured-facts table and the reported-not-gated dispersion row below both use.
 *  Shared with `run.ts`'s copy of the same row for the control arm, rather than
 *  becoming a fifth hand-copy the moment the other four are fixed. */
export function peakDotCarriers(samples: readonly SampledTick[]): number {
  return samples.reduce((max, s) => Math.max(max, s.dotCarriers), 0);
}

/** Count of samples with `dotTicks >= 1` — DoT activity actually APPLIED that tick,
 *  as opposed to merely resident (`dotRecords`). */
export function dotActiveSampleCount(samples: readonly SampledTick[]): number {
  return samples.reduce((n, s) => n + (s.dotTicks >= 1 ? 1 : 0), 0);
}

/** Peak concurrent live creeps with nonzero CATALOG armor, taken POST-`step()`. See
 *  `PEAK_ARMORED_LIVE_THRESHOLD`'s doc for what this does and does not prove. */
export function peakArmoredLive(samples: readonly SampledTick[]): number {
  return samples.reduce((max, s) => Math.max(max, s.armoredLive), 0);
}

/** Runs every PLAN step 18 assertion against one stress run's sampled-tick series and
 *  post-build facts. Pure — no I/O, no sim invocation — so it is unit-testable against
 *  synthetic sample arrays (`oracle.test.ts`) without ever running the sim. */
export function runOracle(input: OracleInput): OracleResult {
  const {
    samples,
    towersPlacedAfterBuild,
    leftoverBountyAfterBuild,
    routeLength,
    dotDroppedTotal,
  } = input;

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
  const peakSlowedCreeps = samples.reduce((max, s) => Math.max(max, s.slowedCreeps), 0);
  const qualifyingSampleCount = samples.reduce((n, s) => n + (isQualifyingSample(s) ? 1 : 0), 0);

  const dotRecordsPeak = peakDotRecords(samples);
  const dotRecordDepth = dotRecordDepthAtPeak(samples);
  const dotCarriersPeak = peakDotCarriers(samples);
  const dotSamplesActive = dotActiveSampleCount(samples);
  const armoredLivePeak = peakArmoredLive(samples);

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
      // RENAMED from "creeps with an active status, at peak" (M2-S5b P10,
      // `PEAK_SLOWED_CREEPS_THRESHOLD`'s doc) — this has only ever counted
      // `slowedCreeps`, so with DoT shipped the old name was false.
      name: 'creeps with an active slow status, at peak',
      measured: peakSlowedCreeps,
      threshold: PEAK_SLOWED_CREEPS_THRESHOLD,
      pass: peakSlowedCreeps >= PEAK_SLOWED_CREEPS_THRESHOLD,
    },
    {
      name: 'qualifying sustained samples',
      measured: qualifyingSampleCount,
      threshold: QUALIFYING_SAMPLES_THRESHOLD,
      pass: qualifyingSampleCount >= QUALIFYING_SAMPLES_THRESHOLD,
    },
    {
      name: 'peak concurrent DoT records',
      measured: dotRecordsPeak,
      threshold: PEAK_DOT_RECORDS_THRESHOLD,
      pass: dotRecordsPeak >= PEAK_DOT_RECORDS_THRESHOLD,
    },
    {
      // OWNER AMENDMENT, 2026-08-03 — see `DOT_RECORD_DEPTH_THRESHOLD`'s doc for the
      // full derivation, including the measured stress-vs-control comparison that
      // established the real cause (blast/chill composition, not sticky targeting).
      // This REPLACES PLAN.md step 17's "peak creeps carrying >= 1 DoT record: >=
      // 100", which was mis-derived, not merely unreachable.
      name: 'DoT record depth per carrier, at the tick with peak dotRecords',
      measured: dotRecordDepth,
      threshold: DOT_RECORD_DEPTH_THRESHOLD,
      pass: dotRecordDepth >= DOT_RECORD_DEPTH_THRESHOLD,
    },
    {
      name: 'samples with >= 1 DoT tick applied',
      measured: dotSamplesActive,
      threshold: DOT_ACTIVE_SAMPLES_THRESHOLD,
      pass: dotSamplesActive >= DOT_ACTIVE_SAMPLES_THRESHOLD,
    },
    {
      name: 'peak concurrent live creeps with nonzero armor',
      measured: armoredLivePeak,
      threshold: PEAK_ARMORED_LIVE_THRESHOLD,
      pass: armoredLivePeak >= PEAK_ARMORED_LIVE_THRESHOLD,
    },
    {
      name: 'dropped DoT applications, whole run (stress arm)',
      measured: dotDroppedTotal,
      threshold: DOT_DROPPED_THRESHOLD,
      pass: dotDroppedTotal === DOT_DROPPED_THRESHOLD,
    },
    {
      // REPORTED, NOT GATED (PLAN.md step 17's headroom row) — the gated row above
      // (`peak concurrent DoT records`) is the FLOOR on this same quantity; this is
      // the CEILING side. Two ceilings exist and are labelled separately in
      // `PEAK_DOT_RECORDS_THRESHOLD`'s neighbourhood: 400 post-sweep (8 residents per
      // source, 50 venom towers) and 450 at insertion time (the transient ninth,
      // `RATIO + 1`). Neither is truncation evidence on its own — the "dropped DoT
      // applications" assertion above is what actually proves nothing was silently
      // discarded — which is why `pass` here is unconditionally `true`: this row
      // exists to be READ, not to gate. The name spells out the fraction (packet
      // §5, PLAN step 17's "peak records as a fraction of 9,000") rather than
      // leaving the reader to compute measured/threshold themselves.
      name: `peak DoT records vs MAX_DOT_RECORDS (headroom, reported not gated) — ${dotRecordsPeak}/${MAX_DOT_RECORDS} = ${(dotRecordsPeak / MAX_DOT_RECORDS).toFixed(4)} of cap`,
      measured: dotRecordsPeak,
      threshold: MAX_DOT_RECORDS,
      pass: true,
    },
    {
      // REPORTED, NOT GATED (packet §2, owner ruling 2026-08-03) — the DISPERSION
      // axis `DOT_RECORD_DEPTH_THRESHOLD` deliberately does not gate; see its doc
      // for the full reasoning (depth rises as dispersion falls, so one floor
      // cannot cover both). Printed alongside the headroom row above so the number
      // a reviewer needs is visible even though nothing fails on it. `run.ts` adds
      // the control arm's copy of this same row.
      name: 'peak DoT carriers (dispersion, reported not gated)',
      measured: dotCarriersPeak,
      threshold: true,
      pass: true,
    },
  ];

  return { assertions, pass: assertions.every((a) => a.pass) };
}
