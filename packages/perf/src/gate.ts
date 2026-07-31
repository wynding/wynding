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
// scenario: the twins also match the chill pair's `slow` effect definition (an
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
// TAIL VARIANCE (an earlier wording, "cancels the noise out", overclaimed this):
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
 * `R0` — the baseline ratio: **2.49**, recorded on `ubuntu-latest`.
 *
 * The MEDIAN of the first 3 CI samples — in the order they were taken, 2.3585, 2.5129,
 * 2.4978, so the median is 2.4978 — rounded DOWN to the nearer hundredth. Down, not
 * to-nearest: a lower R0 makes the ceiling stricter, so the rounding can only ever cost a
 * false alarm, never hide a regression. Ceiling = 2.49 x 1.25 = 3.1125. (A fourth sample,
 * 2.4915, had already landed when this was chosen and was not used; including it leaves
 * R0 at 2.49 either way.)
 *
 * PROVENANCE. `ubuntu-latest` is a moving alias, so consequence 2 below ("re-record when
 * the runner class changes") is unactionable without the resolved identity: image
 * **ubuntu-24.04**, release **ubuntu24/20260720.247**, **`node-version: 22`** (`ci.yml`'s
 * `perf` job), repo `wynding/wynding`, all samples 2026-07-30. The local runs it is
 * contrasted with below were **Node 26** — a different V8 major, and an unmeasured
 * confound in the local-vs-CI gap, which the rest of this doc attributes to tail variance
 * alone.
 *
 * RECORDED ON THE RUNNER, NOT THE LAPTOP, AND THAT DISTINCTION IS THE WHOLE FINDING.
 * S4b first recorded R0 = 1.69 from 8 runs on the authoring machine (range 1.663-1.795,
 * sd 0.045) on the theory this file still states above: a ratio should cancel CPU-speed
 * scale, so a baseline taken anywhere should transfer. **It did not.** The first CI run
 * measured 2.3585 against that 2.1125 ceiling and failed the gate, and re-runs landed at
 * 2.5129 and 2.4978 — the ratio moved 1.47x across machines (the two committed R0 values,
 * 2.49/1.69; median-to-median it is 1.48), while `controlStat`, which is
 * EXPECTED to scale with machine speed, moved ~1.53x (0.183ms local -> 0.272/0.279/0.290ms
 * on the three CI runs, median 0.279; the ratio spans 1.49-1.58 across them). A quantity
 * built to be scale-invariant moved almost as much as the raw statistic it was built to
 * normalise.
 *
 * The cause is the limitation this file already names but had not yet measured: a p99
 * numerator over a p50 denominator cancels SCALE but not TAIL VARIANCE, and a hosted runner
 * has a far fatter tail than a quiet workstation. "Hosted", not "shared": each job gets its
 * own VM (see below) — what it shares is the PHYSICAL HOST, with tenants it cannot see, and
 * that is where the tail comes from. The denominator is a median, so it barely moves with
 * tail noise by construction; the numerator absorbs all of it. So R is not machine-portable,
 * and R0 is only meaningful for the machine class it was taken on.
 *
 * THE CEILING HAS ALREADY BEEN EXCEEDED ON UNCHANGED CODE. R0 was chosen from the first
 * three samples; S4b's branch went on to produce eight in total, and the full record is
 * the honest one to read this gate against:
 *
 *   |  # | Actions job | started (UTC) | commit      |      R |
 *   |----|-------------|---------------|-------------|--------|
 *   |  1 | 91025915959 |      22:53:11 | 9e5b7b8 a1  | 2.3585 |
 *   |  2 | 91026954496 |      22:59:02 | 9e5b7b8 a2  | 2.5129 |
 *   |  3 | 91027669811 |      23:03:03 | 9e5b7b8 a3  | 2.4978 |
 *   |  4 | 91028220425 |      23:06:13 | 9e5b7b8 a4  | 2.4915 |
 *   |  5 | 91028488168 |      23:07:48 | 2cccfc4     | 3.0331 |
 *   |  6 | 91029071138 |      23:11:22 | 9e5b7b8 a5  | 3.2478 |
 *   |  7 | 91029800584 |      23:15:44 | 93c3f90     | 2.5937 |
 *   |  8 | 91030969809 |      23:22:51 | f420491     | 2.6050 |
 *
 * Samples 1-4 and 6 are the SAME COMMIT re-run five times: 2.3585 to 3.2478, a **37.7%
 * spread on byte-identical code**. Sample 6 is ABOVE the 3.1125 ceiling this constant
 * creates; sample 5 is ~2.5% under it. NOTHING VISIBLE SEPARATES THE TWO HIGH SAMPLES FROM
 * THE OTHERS. The obvious hypothesis was chased twice — concurrent load from this
 * repo's own jobs — and it survives neither the model nor the data. The model: these eight
 * perf jobs report eight DISTINCT `runner_name`s, so no two shared a machine, and a
 * sibling job in the same run was never contending for this one's CPU. (Multi-core
 * GitHub-hosted runners get a VM each; only single-CPU runners share one, and
 * `ubuntu-latest` is not single-CPU.) The data agrees: the most-overlapped sample of the
 * eight has the LOWEST R. What would actually explain it — which physical host each VM
 * landed on, and what else was running there — is exactly what the Actions API cannot
 * show. Treat the 37.7% as unexplained runner variance, and do not let a plausible story
 * stand in for a measurement.
 *
 * So the gate's flake rate is not "comfortable". Stated precisely, because the two
 * readings differ: the shipped ceiling has been EVALUATED three times (samples 5, 7, 8)
 * and passed all three; but of the eight samples measured on this runner class, ONE would
 * have failed it. "Roughly 1-in-8" is that counterfactual, not an observed failure rate.
 * `perf` is NOT a required check on `main` (branch protection requires `verify` and
 * `codex-freshness` only), so a flake is noise rather than something that stops a merge —
 * but it is noise people learn to ignore, and that is this gate's real risk. Left OPEN for
 * an owner ruling; see `docs/milestones/m2.md`'s S4 flags.
 *
 * WHY R0 IS NOT BEING MOVED AGAIN. This doc's own pre-declared response to flake is "more
 * samples and a re-recorded median, never a wider tolerance". Applying it: the median of
 * all eight is 2.5533 -> R0 2.55, ceiling 3.1875 — which still would not have accommodated
 * sample 6. It changes no observed sample's verdict, so re-recording buys nothing but a
 * second threshold edit under pressure on one branch, which is the pattern this file warns
 * against. The value stays at 2.49 and the finding is escalated instead.
 *
 * TWO CONSEQUENCES, both real costs of this design, stated rather than papered over:
 *   1. A LOCAL `pnpm run perf` CANNOT PREDICT THE GATE — and, measured, cannot even
 *      predict ITSELF across sessions. On a quiet authoring machine R sat at 1.66-1.79
 *      (8 runs); hours later, same commit, same machine, but under ordinary background
 *      load, the same command measured 2.21-2.36 (6 runs); a later 32-run interleaved
 *      series on that machine spanned 1.638-2.560, **56%** (an uncommitted review harness,
 *      both arms of an ordering A/B pooled). So a local R is only
 *      comparable to other local runs taken back to back, and never to this gate's
 *      ceiling.
 *   2. R0 must be re-recorded whenever the RUNNER class changes (a GitHub image bump, a
 *      move to larger runners), not only when blast cost changes — against the resolved
 *      image recorded under PROVENANCE above, not against the `ubuntu-latest` alias. That
 *      is a maintenance obligation this gate creates.
 *
 * What was pre-declared before any measurement is unchanged, and is what matters
 * methodologically: both statistics, the >= 500 due-blast sample floor, and the 25%
 * tolerance. Only R0 — explicitly defined as "the ratio this scene records" — moved, and
 * it moved to the machine the gate actually runs on. TOLERANCE was NOT widened to fit, and
 * should not be: the worst sample sits 30.4% above R0 (3.2478 / 2.49), so absorbing it
 * needs TOLERANCE >= 1.31. A gate that permits a 31% regression in blast cost before it
 * complains is not worth the CI minutes. (The 37.7% figure above is max/min across the
 * eight — the right measure of how noisy the runner is, but NOT the number to compare
 * against a tolerance that multiplies a median.)
 *
 * Changing this value at all requires an explicit, reviewed commit with justification in
 * the PR. It is never inferred and never auto-updated by a later run: a gate that
 * rebaselines itself measures nothing.
 */
export const R0: number | null = 2.49;

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
    // fast blast cost" result. And "fails closed" holds only for the EXIT CODE — the
    // report would not even show the non-finite value, because `JSON.stringify` turns
    // `Infinity` and `NaN` into `null`, so `PERF-REPORT`'s `r` would read `null` beside
    // `"pass": false` with nothing naming the cause. Throwing is what keeps the
    // diagnosis visible.
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
