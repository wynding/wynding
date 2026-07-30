// gate.ts — the relative CI gate (PLAN step 21, Codex R1-6/R1-9/R2-3).
//
// Three flaws sank the earlier drafts, all documented in PLAN.md so they are not
// silently re-litigated here:
//   - A p95 CEILING cannot see a blast spike at all. `splash`'s cadence-60 blasts put
//     blast-heavy ticks at a small minority of samples (~1.7% in the drafting analysis)
//     — entirely below p95, so a regression in blast cost specifically would never
//     surface in a p95-gated number.
//   - An ABSOLUTE ceiling "with generous headroom" lets the threshold be picked AFTER
//     seeing results on `ubuntu-latest` — a runner that is not a stable reference CPU
//     across time. A number chosen post-hoc against one runner's noise floor is not a
//     methodology, it is a guess dressed as one.
//   - Gating raw `max` actively MAGNIFIES runner variance: `max` is the single most
//     noise-sensitive statistic available (one GC pause, one scheduler preemption, and
//     it moves), so an absolute ceiling on it would fail CI on noise alone.
//
// The fix: an IN-JOB CONTROL WORKLOAD. Every run executes a fixed control scenario —
// every tower swapped for its blast-free single-form twin, `stress-blast` ->
// `stress-single`, `stress-chill` -> `stress-chill-single` — in the SAME process, then
// the stress scenario, and gates the RATIO `R = stressStat / controlStat` — not either
// statistic alone. This control is NOT a genuine one-dimension twin of the stress
// scenario: the twins also match the chill pair's `slow` effect definition (QC: an
// earlier draft dropped it entirely), but a single-form tower cannot reproduce an
// area effect's slow COVERAGE, so the control unavoidably carries a lighter creep
// population too (measured median 181 vs the stress run's 224, peak slowed creeps 109
// vs 304 — see `scenario.ts`'s `buildControlReplay` doc and this file's `R0` doc below
// for the full accounting). `R` therefore isolates blast cost plus blast-borne slow
// coverage together, not blast cost alone.
//
// A slow or noisy runner scales both terms together, which cancels CPU-SPEED SCALE: a
// machine that is uniformly 2x slower moves both `controlStat` and `stressStat` by
// roughly the same factor, so `R` survives the move roughly intact. It does NOT cancel
// TAIL VARIANCE (QC: an earlier wording, "cancels the noise out", overclaimed this):
// measured across three runs on one quiet machine, `R` itself swung ±6% run to run,
// while a like-for-like p99/p99 comparison over the same runs swung only ±0.7%. A
// p99-over-p50 ratio cancels scale, not the tail's own run-to-run jitter — which is
// exactly why the tolerance below is 25%, not something tight enough to assume the
// ratio is noise-free.

import { percentile } from './stats';
import type { SampledTick } from './harness';

/** `controlStat` — p50 of `step()` wall-clock over the CONTROL scenario's sampled
 *  ticks. A median over a blast-free run: robust to runner noise BY CONSTRUCTION (a
 *  single slow tick from GC/scheduler preemption cannot move a median computed over
 *  2,500 samples), and blast-free so it measures the maze's baseline busy-board cost
 *  with no AoE membership-scan cost mixed in. */
export function controlStat(controlSamples: readonly SampledTick[]): number {
  return percentile(
    controlSamples.map((s) => s.ms),
    50,
  );
}

/** `stressStat` — p99 of `step()` wall-clock over the STRESS run's DUE-BLAST-TICK
 *  SUBSET within the sampled window (not the full stress sample set — a tick with no
 *  due blast this step is not exercising the blast membership scan at all, and mixing
 *  it in would dilute the statistic toward the maze's baseline cost, hiding exactly
 *  the regression this gate exists to catch).
 *
 * p99, NOT p99.9 (Codex R3-3): with the oracle's >= 500-sample due-blast floor
 * (`oracle.ts`'s `DUE_BLAST_SAMPLES_THRESHOLD`), p99 discards roughly the top 5
 * observations — enough that a single preempted tick (one GC pause, one scheduler
 * hiccup) cannot fail CI on its own, while a SYSTEMATIC regression in blast cost still
 * shifts the whole upper tail and fails it. p99.9 over a subset this size would often
 * BE the maximum (the single noisiest tick), reintroducing exactly the GC/scheduler
 * sensitivity a relative gate exists to remove.
 *
 * Throws (via `percentile`) if `dueBlastSamples` is empty — a caller must filter to
 * the due-blast subset first; an empty subset is an oracle failure
 * (`DUE_BLAST_SAMPLES_THRESHOLD`), not a gate that should silently report `NaN`.
 */
export function stressStat(dueBlastSamples: readonly SampledTick[]): number {
  return percentile(
    dueBlastSamples.map((s) => s.ms),
    99,
  );
}

/** CI fails when `R > R0 * TOLERANCE`. Predeclared, not tuned after seeing results
 *  (PLAN step 21): what is fixed BEFORE measurement is what matters methodologically —
 *  both statistics above, the >= 500 due-blast sample floor (`oracle.ts`), and this
 *  25% tolerance — so the gate can never be quietly adjusted to whatever the first
 *  run's numbers happened to be. */
export const TOLERANCE = 1.25;

/**
 * `R0` — the baseline ratio recorded by S4b: **1.69**.
 *
 * The MEDIAN of 8 consecutive recording runs (1.6627, 1.6700, 1.6740, 1.6819, 1.7145,
 * 1.7145, 1.7393, 1.7948 — median 1.6982, mean 1.7065, sd 0.045), rounded DOWN to the
 * nearer hundredth. Down, not to-nearest: a lower R0 makes the ceiling stricter, so the
 * rounding can only ever cost a false alarm, never hide a regression.
 *
 * WHY A MEDIAN OF 8 AND NOT "the first run" (QC round 1). The first draft took R0 from
 * n = 2. A review then measured this statistic's actual run-to-run spread and found the
 * two-sample baseline was calibrating a number it had no business calibrating: with the
 * ORIGINAL control workload, R ranged 1.71–2.39 (sd 0.136) across 23 runs on one idle
 * machine. Two things fixed that. First, QC: the control had been dropping the chill
 * pair's `slow` effect entirely (0 peak slowed creeps vs the stress run's 304), running
 * a ~28.6% lighter live-creep population (median 160 vs 224) than the stress scenario.
 * Matching the chill pair's slow definition NARROWED that gap — to ~19.2% (median 181 vs
 * 224) — it did not close it, and structurally cannot: a single-form twin can never
 * reproduce an area effect's coverage (`scenario.ts`'s `buildControlReplay` doc has the
 * full accounting). That narrowing alone cut the sd to 0.045 — roughly 3x tighter —
 * because numerator and denominator now move closer together, though not identically.
 * Second, taking the median of 8 rather than one lucky observation. What was
 * pre-declared before any measurement, and is what matters methodologically, is
 * unchanged: both statistics, the >= 500 due-blast sample floor, and the 25% tolerance.
 *
 * Ceiling is therefore 1.69 x 1.25 = 2.1125, against a worst observed run of 1.7948 —
 * about 18% headroom. A SECOND 8-run set taken later on the same machine ranged
 * 1.652-1.810 (sd 0.054), so the honest worst-observed is 1.810, not 1.7948: against that,
 * headroom is ~17% and the ceiling sits ~5.6 standard deviations out. Read the spread as
 * roughly +/-5% rather than as either set's exact range. A gate that trips at 5-6 sigma on
 * this machine is not going to flap here; whether it flaps on a shared-vCPU runner with a
 * fatter tail is the open question the next paragraph names.
 *
 * PROVENANCE, stated plainly because it bounds what this number means: every run was
 * taken on the AUTHOR'S DEV MACHINE (Node v26.0.0, macOS 26.5.2, Apple M4 Pro), not on
 * the `ubuntu-latest` runner where the gate actually executes. Cross-machine transfer is
 * exactly what the ratio is *designed* for — a slower runner scales `controlStat` and
 * `stressStat` together — but "designed for" is a claim, and S4b's first CI run is its
 * first real test. A shared-vCPU runner also has a fatter tail than this machine, and the
 * numerator is a p99 while the denominator is a median, so the ratio cancels CPU-speed
 * SCALE but not the tail's own jitter. If CI's observed R lands outside the ceiling, that
 * is a finding ABOUT THE METHODOLOGY, not a regression in blast cost, and the honest
 * response is to re-record R0 from the runner — with the sample count and spread stated,
 * as above — never to widen TOLERANCE until it fits.
 *
 * Changing this value at all requires an explicit, reviewed commit with justification in
 * the PR. It is never inferred and never auto-updated by a later run: a gate that
 * rebaselines itself measures nothing.
 */
export const R0: number | null = 1.69;

/** One of two outcomes: `'unset'` (R0 has not been committed yet — this run only
 *  records `R`, the gate cannot enforce anything) or `'evaluated'` (R0 is committed,
 *  and `pass` reflects whether `R <= R0 * TOLERANCE`). A discriminated union rather
 *  than a boolean `pass` alone, so a caller can never mistake "the gate was not
 *  enforced this run" for "the gate passed". */
export type GateResult =
  | {
      readonly status: 'unset';
      readonly r: number;
      readonly controlStat: number;
      readonly stressStat: number;
    }
  | {
      readonly status: 'evaluated';
      readonly r: number;
      readonly r0: number;
      readonly tolerance: number;
      readonly ceiling: number;
      readonly pass: boolean;
      readonly controlStat: number;
      readonly stressStat: number;
    };

/** Computes `R = stressStat / controlStat` and evaluates it against `R0 * TOLERANCE`
 *  when `r0` is committed (defaults to the module's `R0` constant; a caller may pass
 *  an explicit value in tests to pin the boundary without editing the committed
 *  constant). `R = R0 * TOLERANCE` itself PASSES — the gate fails on `R > R0 *
 *  TOLERANCE` strictly, not `>=` (see `gate.test.ts` for the pinned boundary case). */
export function evaluateGate(
  controlSamples: readonly SampledTick[],
  dueBlastSamples: readonly SampledTick[],
  r0: number | null = R0,
): GateResult {
  const cStat = controlStat(controlSamples);
  const sStat = stressStat(dueBlastSamples);
  if (cStat === 0) {
    // A zero-ms control median makes `R = sStat / 0` -> `Infinity` (or `NaN`, if
    // `sStat` is also 0). Both already fail closed — `Infinity`/`NaN` compare `>` any
    // finite ceiling — but a caller would see only the bare non-finite value in the
    // report, with no clue why. Name the diagnosis instead of leaving a reader to
    // reverse-engineer it from an opaque `NaN`: a zero-ms control median is itself a
    // broken measurement (the control run measured nothing), not a real "infinitely
    // fast blast cost" result.
    throw new Error(
      'evaluateGate: controlStat is 0ms — the control scenario recorded a zero-millisecond ' +
        'median step(), which makes R uninterpretable. This is a broken control ' +
        'measurement, not a real result.',
    );
  }
  const r = sStat / cStat;

  if (r0 === null) {
    return { status: 'unset', r, controlStat: cStat, stressStat: sStat };
  }

  const ceiling = r0 * TOLERANCE;
  return {
    status: 'evaluated',
    r,
    r0,
    tolerance: TOLERANCE,
    ceiling,
    pass: r <= ceiling,
    controlStat: cStat,
    stressStat: sStat,
  };
}
