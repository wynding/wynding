// gate.ts — the relative CI gate for `step()` cost on blast-heavy ticks (ADR 0005).
//
// The gate computes `R = stressStat / controlStat` and fails when `R > R0 * TOLERANCE`.
// Everything below argues for those four names: the two statistics, the baseline, and
// the tolerance.
//
// WHERE THE NUMBERS LIVE. Every figure in this file that is also copied into
// `docs/adr/0005-performance-budgets.md`, `docs/design-notes/performance-spike.md`,
// `docs/milestones/m2.md` or this package's tests is a row in `claims.ts`, and
// `claims.test.ts` resolves each row at every named site and fails when the copies
// disagree. Edit the table row first, then its sites. Cross-file propagation — a fix
// applied here and not to the ADR that duplicates it — is the defect this file's history
// is made of (issue #86); the table is what turns it from a review catch into a red test.
// Figures that appear only here are not in the table: the table exists for claims with
// copies, not for every number.
//
// WHY A RATIO. Three absolute designs were tried first. Each fails for its own reason,
// and they are recorded because they are the designs a reader reaches for:
//   - A p95 CEILING OVER ALL SAMPLES cannot see blast cost at all. `splash`'s cadence-60
//     blasts put blast-heavy ticks in a small minority of samples, entirely below p95, so
//     a regression in blast cost specifically would never surface. The fix is POPULATION,
//     not percentile — see `stressStat`.
//   - AN ABSOLUTE CEILING "with generous headroom" lets the threshold be picked AFTER
//     seeing results, on a runner that is not a stable reference CPU across time. A number
//     chosen post-hoc against one runner's noise floor is a guess dressed as a methodology.
//   - GATING RAW `max` actively MAGNIFIES runner variance: one GC pause or one scheduler
//     preemption moves it, so an absolute ceiling on it fails CI on noise alone.
//
// A ratio against an IN-JOB CONTROL WORKLOAD answers all three. Every run executes a fixed
// control scenario in the SAME process — every AoE tower swapped for its blast-free
// single-form twin, `stress-blast` -> `stress-single` and `stress-chill` ->
// `stress-chill-single`; `stress-venom` maps to ITSELF, unchanged, since it is already
// blast-free and has no single-form twin to map to — then the stress scenario, and gates
// the ratio rather than either statistic alone. A machine that is uniformly slower moves
// both terms by roughly the same factor, so CPU-SPEED SCALE cancels by construction.
//
// THE CONTROL WORKLOAD IS NOT A ONE-DIMENSION TWIN, so `R` is not "blast cost". The twins
// match the chill pair's `slow` effect definition (an earlier draft dropped it entirely),
// but a single-form tower cannot reproduce an area effect's slow COVERAGE, so the control
// unavoidably carries a lighter creep population — measured median 181 against the stress
// run's 224, peak slowed creeps 109 against 304 (`scenario.ts`'s `buildControlReplay`).
// `R` therefore isolates blast cost PLUS blast-borne slow coverage, together.
//
// THE VENOM ARM'S ASYMMETRY RUNS THE OPPOSITE WAY FROM THE HAZARD THAT MOTIVATED IT, and
// both facts belong on record. A DoT-free control would put DoT cost exclusively in `R`'s
// numerator, which is why the control keeps a venom arm at all. But measured, the DoT
// workload is HEAVIER in the CONTROL arm — 368 peak resident records against the stress
// arm's 175, and 127 peak DoT carriers against 19 — because `stress-chill`'s AoE slow
// bunches creeps in the stress arm, so its venom towers re-hit one small leading cohort
// under sticky nearest-exit targeting (a refresh, not a new record), while the control's
// thin coverage lets creeps stream past and each shot seeds a fresh `(targetId, sourceId)`
// pair. So DoT-table cost sits predominantly in the DENOMINATOR and biases `R` DOWNWARD.
// Magnitude, so this reads as a direction rather than an alarm: `dot-bench`'s own curve is
// roughly 0.25ms per 1,000 resident records, so a ~190-record gap is small in absolute
// terms.
//
// WHAT THE RATIO DOES NOT CANCEL. Scale cancels; TAIL VARIANCE cancels only if the two
// statistics are LIKE FOR LIKE in robustness, and that is where this gate was wrong for
// two milestones. Both arms are therefore medians over >= 500 samples, so neither can be
// moved MATERIALLY by a single GC pause or scheduler preemption — stated with that
// qualifier because the unqualified form is false: changing one sample shifts a median to
// an adjacent order statistic, a real but negligible move rather than no move. That is
// what makes the tolerance below affordable at 10%.

import { percentile } from './stats';
import type { SampledTick } from './harness';

/** `controlStat` — p50 of `step()` wall-clock over the CONTROL scenario's sampled ticks.
 *  A median over a blast-free run: robust to runner noise BY CONSTRUCTION, and blast-free
 *  so it measures the maze's baseline busy-board cost with no AoE membership-scan cost
 *  mixed in.
 *
 *  Robustness here is the gate's DESIGN PRINCIPLE, not a property of one arm: `stressStat`
 *  is a median too, and a ratio only cancels runner noise when BOTH terms respond to it the
 *  same way. Pairing this median with a tail statistic is what made `R` swing more than
 *  five times as far run-to-run on identical work. Do not change either arm to a tail
 *  statistic without re-reading `stressStat`'s measurement table. */
export function controlStat(controlSamples: readonly SampledTick[]): number {
  return percentile(
    controlSamples.map((s) => s.ms),
    50,
  );
}

/** `stressStat` — p50 of `step()` wall-clock over the STRESS run's DUE-BLAST-TICK SUBSET
 *  within the sampled window. Not the full stress sample set: a tick with no due blast is
 *  not exercising the blast membership scan at all, and mixing it in would dilute the
 *  statistic toward the maze's baseline cost, hiding exactly the regression this gate
 *  exists to catch.
 *
 *  THE STATISTIC. Finding blast ticks and choosing where in their cost distribution to read
 *  are SEPARATE jobs, and a percentile can only do the second. Restricting the POPULATION to
 *  the due-blast subset does the finding: every sample in it carries >= 1 due blast by
 *  construction, so there is no minority left to sink below any rank. Once the population
 *  does the finding, a high percentile adds no signal — only variance. Measured over four
 *  consecutive CI runs on `ubuntu-24.04` whose workload oracles are byte-identical across all
 *  four — so every difference below is runner noise, not workload:
 *
 *    | ratio statistic            | R across the four runs      | half-spread |
 *    | -------------------------- | --------------------------- | ----------- |
 *    | p95(subset) / p50(control) | 1.3444 1.7522 1.4214 1.8348 | +/- 15.5%   |
 *    | p95(subset) / p95(control) | 0.6524 0.6119 0.7461 0.8411 | +/- 16.4%   |
 *    | p99(subset) / p99(control) | 0.5406 0.5816 0.6855 0.6622 | +/- 11.7%   |
 *    | p50(subset) / p50(control) | 0.9962 0.9938 1.0164 1.0493 | +/-  2.8%   |
 *
 *  THE PER-ARM VALUES THOSE RATIOS ARE BUILT FROM, same run order (ms). Published because
 *  without them nothing derived per-arm is checkable, and because `TOLERANCE` 1.10 rests on
 *  the +/- 2.8% row above rather than on the 17-run `R0` cohort — so these four runs, not
 *  that cohort, are what makes the tolerance recomputable. ADR 0005's per-arm range table
 *  cites this table by name for exactly that reason:
 *
 *    | run | control p50 | control p95 | stress p50 | stress p95 |
 *    | --- | ----------- | ----------- | ---------- | ---------- |
 *    |  1  |   0.3863    |   0.7960    |   0.3848   |   0.5193   |
 *    |  2  |   0.4102    |   1.1746    |   0.4077   |   0.7188   |
 *    |  3  |   0.4048    |   0.7711    |   0.4114   |   0.5753   |
 *    |  4  |   0.3128    |   0.6824    |   0.3282   |   0.5739   |
 *
 *  TWO CAVEATS ON THAT TABLE, both load-bearing for anyone recomputing from it.
 *  (1) IT IS RECONSTRUCTED, NOT TRANSCRIBED. What the diagnosis recorded was the four ratio
 *  series above plus ADR 0005's per-arm MIN/MAX, never the per-run arms; the ratios
 *  over-determine them, and the assignment is unique because each run attains a different
 *  recorded endpoint. Seven of the eight endpoints reproduce to 4 dp; the eighth, control
 *  p95's max, comes out 1.17462 against a recorded 1.1747 — worst endpoint error 7.6e-5.
 *  Said exactly rather than as "reproduces all eight", because a reader checking will find
 *  that cell. (2) EVERY DERIVED FIGURE IS COMPUTED FROM THE UNROUNDED SCALES, so recomputing
 *  from the printed 4 dp cells can move a last digit — run 3 is where it shows (the printed
 *  control p50 0.4048 gives 0.5754 / 0.7712 where the unrounded scale gives 0.5753 / 0.7711),
 *  and stress p95's per-arm half-spread is 17.35% unrounded against 17.36% off the printed
 *  cells. Under this file's declared half-spread convention the per-arm figures are control
 *  p50 12.31%, control p95 31.41%, stress p50 10.50%, stress p95 17.35% — tails 1.65x-2.55x
 *  the medians, which is the multiplier ADR 0005 quotes.
 *
 *  PROVENANCE GAP, recorded rather than papered over: these four runs were recorded without
 *  run or job ids and those are not recoverable. Every figure above is falsifiable by
 *  recomputation, but none of it is traceable to the jobs that produced it — which is why
 *  `R0`'s own record names its run, and why limit 1 below refuses to lean on this cohort as
 *  independent evidence.
 *
 *  WHAT n = 4 SETTLES AND WHAT IT DOES NOT. The gap between p50/p50 and every tail ratio is
 *  4.2x-5.9x, and the four series are PAIRED — same four runs — which makes that gap
 *  decisive at this sample size. The gaps AMONG the tail ratios are not: p95/p95 against
 *  p99/p99 is 1.41x, well inside the noise of a four-sample range estimate. So the honest
 *  reading is "the median ratio is decisively quieter than any tail ratio", never "matching
 *  percentiles is worse than mixing them".
 *
 *  WHAT THE STATISTIC BUYS AND WHAT IT COSTS, in the right causal order, because an earlier
 *  draft credited p50 with a gain it did not produce. The statistic does NOT buy
 *  sensitivity: at EQUAL tolerance p50 is the LESS sensitive of the two, firing on
 *  `gate-fixture.test.ts`'s broad injection at k = 0.00922 where p95 fires at 0.00745 — a
 *  ~24% larger regression needed. What the low noise buys is a TOLERANCE that was previously
 *  unaffordable: p95 CANNOT be run at 1.10, because its own run-to-run spread exceeds that
 *  threshold and it would fail on quiet runners rather than on regressions. The end-to-end
 *  gain therefore belongs to the tolerance, and it is 1.67x (k = 0.01536 -> 0.00922) — not a
 *  doubling. Do NOT convert the two tolerances into an "Nx tighter in absolute ms" claim:
 *  1.25 bounded a p95 of the due-blast subset and 1.10 bounds a MEDIAN of the same
 *  population, so their ratio is a category error with a plausible number attached. The `k`
 *  values are the honest comparison, because they are read off ONE common injection.
 *
 *  A UNIT CAVEAT, since the prose above is in percentages. `R` is near 1.00, which means
 *  both arms are dominated by the same baseline per-tick cost. A 10% move in `R` is
 *  therefore NOT a 10% blast-cost regression — it is ~10% of TOTAL tick cost, and blast cost
 *  is only part of that.
 *
 *  `stressStatP95` and `stressStatP99` below are kept and reported for audit: a statistic
 *  that stops deciding pass/fail stays visible in `PERF-REPORT` and `GateResult`, so this is
 *  never a one-way door taken silently.
 *
 *  Throws (via `percentile`) if `dueBlastSamples` is empty — a caller must filter to the
 *  due-blast subset first, and an empty subset is an oracle failure (`oracle.ts`'s
 *  `DUE_BLAST_SAMPLES_THRESHOLD`, 500), not a gate that should silently report `NaN`. */
export function stressStat(dueBlastSamples: readonly SampledTick[]): number {
  return percentile(
    dueBlastSamples.map((s) => s.ms),
    50,
  );
}

/** `stressStatP95` — the statistic `stressStat` used between M2-S5b and M2-S6, over the
 *  same due-blast subset. Not used for gating — kept so the superseded statistic stays
 *  auditable in `GateResult` and `PERF-REPORT`. See `stressStat` for why p50 replaced it. */
export function stressStatP95(dueBlastSamples: readonly SampledTick[]): number {
  return percentile(
    dueBlastSamples.map((s) => s.ms),
    95,
  );
}

/** `stressStatP99` — the statistic `stressStat` used BEFORE M2-S5b, over the same
 *  due-blast subset. Not used for gating (`evaluateGate` computes it but compares it to
 *  nothing) — kept purely so a rejected statistic stays auditable rather than disappearing
 *  from the record the moment it stops deciding pass/fail. Named absolutely, not as "the
 *  previous revisit": there have been two, and a relative reference does not survive the
 *  second. */
export function stressStatP99(dueBlastSamples: readonly SampledTick[]): number {
  return percentile(
    dueBlastSamples.map((s) => s.ms),
    99,
  );
}

// `stressStat`'s DECLARED BLIND SPOT (ADR 0005) — reported, never gating. A `//` block on
// purpose: this is free-standing prose about the function above, not the doc of the
// declaration below, and a `/** */` here would attach itself to `TOLERANCE`.
//
// A median's insensitivity to tail-concentrated cost is the same property that makes it
// immune to tail noise — no test design separates them. This is the one real cost of the
// median pairing, and it is not hidden here.
//
// WHAT MAKES THE TRADE ACCEPTABLE IS THE POPULATION, NOT THE PERCENTILE. `stressStat` reads
// the due-blast subset, where every sample carries >= 1 blast by construction, so a
// blast-cost regression raises cost across the WHOLE subset — broad by nature, which is the
// shape `gate-fixture.test.ts` injects, and a median sees a broad shift in full. Precisely:
// a MULTIPLICATIVE shift applied to every sample moves every percentile by that same
// factor, medians included. The fixture's injection is ADDITIVE and scaled by `dueBlasts`
// rather than multiplicative, so it does not land on that identity — do not quote the
// identity's exact figure against this fixture; they are different injection shapes.
//
// THE BLIND SPOT, AT FULL STRENGTH — this pairing buys its noise immunity with real
// coverage, and the price is not small. On `gate-fixture.test.ts`'s workload-correlated
// injection at `dueBlasts >= 3` (~11% of samples — the shape an O(n^2) in blast membership
// scanning would take), measured at k = 0.020, p95 moves +35.5% where the gating
// p50 moves +2.2%. Against each statistic's own noise that is a signal-to-noise of 2.2 for
// p95 and 0.8 for p50: p95 detects this regression and the gating median CANNOT.
//
// WHY THE TRADE IS STILL RIGHT. On the BROAD regression this gate primarily exists to
// catch, the signal-to-noise ordering reverses: at k = 0.010 it is 3.9 for p50 and 0.8 for
// p95. So p95 cannot reliably catch the COMMON case, and it false-alarms on quiet runners
// besides. A gate that reliably catches the common case beats one that unreliably catches
// both and cries wolf. The uncovered case stays REPORTED — `stressStatP95` rides in every
// `PERF-REPORT`, so a human reading a suspicious run still sees it — and
// `gate-fixture.test.ts` pins the blind spot as an assertion so it cannot be rediscovered
// by accident. Accepted under the owner's 2026-08-02 ruling that this class of decision is
// Claude's to take.

/** CI fails when `R > R0 * TOLERANCE`. Predeclared, not tuned after seeing results: what is
 *  fixed BEFORE measurement is what matters methodologically — both statistics above, the
 *  >= 500 due-blast sample floor (`oracle.ts`), and this tolerance — so the gate can never
 *  be quietly adjusted to whatever the first run's numbers happened to be.
 *
 *  A tolerance is a statement about how much run-to-run noise the gate must tolerate, so it
 *  is chosen from the STATISTIC's measured variance, never from the baseline's value. 1.10
 *  is affordable because matched medians swing +/- 2.8%, and it would be unusable under a
 *  tail statistic. Not tighter than 1.10 either: at that headroom the false-alarm rate is
 *  already the binding constraint, and this gate's whole history is of a ceiling sitting too
 *  close to its own error bar.
 *
 *  NEVER WIDEN IT TO ABSORB A BAD SAMPLE. The pre-declared response to flake is more samples
 *  and a re-recorded median — never a wider tolerance, which is the move this repo has
 *  declined twice and the failure the current pairing was adopted to fix. */
export const TOLERANCE = 1.1;

// READING THE NUMBERS IN THIS FILE — two conventions, each of which has already produced a
// false alarm. Both are traps a reader re-enters, not mistakes made once.
//
// SWEPT VALUES ARE NOT GRID POINTS. The `k` figures in `stressStat` come from a CONTINUOUS
// SWEEP (step 1e-5) over `gate-fixture.test.ts`'s broad injection, not from that file's `KS`
// grid. The grid's nearest points are 0.0075 and 0.0100; the swept crossings are 0.00745 and
// 0.00922. Rounding the swept pair to the grid's precision turns the ~24% gap into 23%, and
// quoting the grid where the sweep was declared is what once turned a 1.67x end-to-end gain
// into a claimed 2.00x. Read the fixture's assertions as ORDERING and these numbers as
// MAGNITUDES; never move one into the other's role.
//
// "HALF-SPREAD" MEANS `(max - min) / 2` DIVIDED BY THE MEDIAN, AND IT DEPENDS ON n. The
// expected range of a fixed distribution grows with the sample count, so half-spreads are
// comparable only BETWEEN COHORTS OF EQUAL SIZE. `stressStat`'s table is a valid comparison
// (four rows, all n = 4); comparing its 2.8% against the 17-run cohort's range-based 4.92%
// is NOT, and doing exactly that produced a false alarm during the `R0` re-record. Converted
// to sigma the two agree at ~2.7%. When comparing across cohort sizes, use sigma.

/**
 * `R0` — the committed baseline ratio: **1.00**, recorded 2026-08-05 for the p50/p50
 * statistic at `TOLERANCE` 1.10, giving a ceiling of **1.1000**. **PROVISIONAL**, in the
 * precise sense set out under THE THREE LIMITS below.
 *
 * PROVENANCE. GitHub Actions run **31041932972**, **attempts 1-17**, head **a1600c9**,
 * runner image **ubuntu-24.04** (resolved from the `ubuntu-latest` alias, read out of each
 * job's own setup log). All 17 `R` values, sorted:
 *
 *   0.9371 0.9525 0.9842 0.9925 1.0017 1.0029 1.0029 1.0039 1.0065
 *   1.0094 1.0135 1.0149 1.0151 1.0168 1.0265 1.0355 1.0362
 *
 * Median **1.0065**, rounded DOWN to the nearer hundredth = **1.00**. Down, not to-nearest:
 * a lower `R0` makes the ceiling stricter, so the rounding can only ever cost a false alarm,
 * never hide a regression. The raw values are published because CI logs expire on a 90-day
 * retention with no artifact upload — every figure this record derives FROM THIS COHORT is
 * recomputable from these seventeen numbers alone, which is the standard it holds itself to.
 * Figures below that come from elsewhere say so and name their source: the four diagnostic
 * runs (limit 1, and the 1.0493 observed max), and consequence 1's local series, which lives
 * in `performance-spike.md`. The per-arm operands behind these seventeen live there too.
 *
 * SEVENTEEN SAMPLES, NOT THE FIVE THE PROCEDURE ASKED FOR. At n = 5 the pre-committed span
 * rule fired. It was escalated to the owner rather than reinterpreted — that part was right
 * — and the owner authorised collecting more. The rule specified a FIXED cohort of five, so
 * extending it was an authorised deviation from the protocol, not a discovery about the
 * rule; what the extension introduced is an n-dependence, since span is a range statistic
 * whose expected value grows with sample count. That is why the replacement rule below is
 * not a bare span threshold. And the span condition is STILL MET at n = 17 (1.1058 > 1.10):
 * the baseline ships on the argument under WHY IT SHIPS ANYWAY and with the owner informed,
 * not because the trigger stopped firing.
 *
 * THE THREE LIMITS on what this number can be used to claim. All three were raised in review
 * and none was declined:
 *   1. THIS IS NOT A RUNNER-CLASS CALIBRATION. Every sample is an attempt of ONE workflow
 *      run on ONE image within a few hours, while `R0` is applied to every future job on
 *      whatever the fleet allocates. The only other reading — four diagnostic runs of
 *      2026-08-03/05, median **1.0063** against this cohort's 1.0065 — recorded no run or
 *      job ids, so whether they are four separate occasions or four attempts of one is
 *      UNKNOWN. If the latter, they carry the same defect as these seventeen. Do not lean on
 *      them as cross-workflow evidence.
 *   2. DO NOT CONVERT THIS COHORT INTO A FLAKE RATE. Any such figure is a model output: a
 *      Student-t predictive tail assumes i.i.d. normal sampling centred on a MEAN, while
 *      `R0` is a floored MEDIAN and this cohort is clustered in time and left-skewed
 *      (g1 = -1.36). Illustrative arithmetic under assumptions the cohort
 *      violates is not an acceptance argument. This limit NEVER clears — it is a permanent
 *      statement about how to read the data, not a condition to discharge.
 *   3. THE ESCALATION RULE WAS SELECTED IN-SAMPLE. Drafts 1 and 2 were rejected for failing
 *      against THESE 17 samples, and draft 3's figures are then reported as passing on the
 *      same 17. That is fitting, not validation.
 *
 * WHY IT SHIPS ANYWAY, argued from what survives those three limits rather than from what
 * was left over after deleting a model. No distributional assumption appears anywhere in it,
 * because the cohort cannot support one:
 *   - **`perf` is ADVISORY.** Branch protection requires `verify`, `codex-freshness` and —
 *     since 2026-08-12, #106 — `e2e (functional + axe)`, never `perf`, so a baseline that is
 *     wrong in either direction costs a red non-blocking job and a human look. This is the
 *     whole of the risk case, and it does not depend on the sample being representative,
 *     i.i.d., or normally distributed. It DOES depend on repository config this repo cannot
 *     see or assert: if `perf` is ever added to the required checks, this argument voids
 *     silently, and whoever makes that change must re-read this block first.
 *   - **A purely descriptive margin**, with no distributional assumption in it: the largest
 *     `R` ever observed under this statistic, across BOTH readings on record, is **1.0493**
 *     (from the four diagnostic runs; this cohort's own max is **1.0362**), against a
 *     ceiling of **1.1000** — a **4.8%** gap in the raw measurement. It says nothing about
 *     the tail and is not a flake-rate estimate. Do not take the max from one cohort and the
 *     centre from two, which an earlier draft did.
 *   - **The central value reproduces on a second cohort**: medians **1.0063** and
 *     **1.0065**. Medians only — at n = 4 a sample sd carries a 95% CI of 1.45%-9.51%, so
 *     any agreement between the two cohorts' sds is coincidence rather than confirmation.
 *     And see limit 1 for how little separation the two cohorts have.
 *
 * That is enough to enforce a gate that currently enforces nothing. It is not enough to call
 * the gate calibrated, and nothing above should be read as a probability.
 *
 * THE ESCALATION RULE, third draft — what any future re-record is judged by. The two earlier
 * drafts are recorded because each failed against this cohort's own data, which is the test
 * any such rule has to survive:
 *   - draft 1: "escalate if `TOLERANCE - 1` is under 3 sigma". Wrong quantity — `R0` is
 *     FLOORED, so up to 0.01 of margin is discarded before the gate exists.
 *   - draft 2 fixed the quantity but tested it against the 97.5% two-sided UPPER BOUND on
 *     sigma. Applied to this very cohort that demands escalation — the rule failed the
 *     baseline it was written to bless, and the draft did not notice. It is also
 *     unsatisfiable in practice, needing n around 68 at this noise level; a rule whose own
 *     stated floor of ">= 10 samples" can never satisfy it is not a rule.
 *
 * What ships:
 *
 *     take >= 10 samples, all on one head and one runner image;
 *     compute BOTH, and escalate if EITHER fails:
 *         (a) (R0 * TOLERANCE - median(R)) / sd(R)        >= 3
 *         (b) the same margin against the 97.5% two-sided chi-square upper bound on
 *             sigma                                       >= 2   -- and publish it.
 *
 * At this record: (a) **3.61**, (b) **2.37**. Both pass — IN-SAMPLE, on the 17 samples that
 * rejected drafts 1 and 2 (limit 3). ONE HEAD AND ONE IMAGE is a precondition, not a
 * convenience: pooling across heads mixes workload drift into `sd(R)`, and a dispersion
 * estimate inflated by workload drift LOOSENS branch (a).
 *
 * BRANCH (b) IS THE ONE THAT BINDS for every n below 18, so it is a test and not a
 * formality. It implies a point margin of 2 x sigma_hi/sigma_hat, which is 3.65 at the
 * rule's own floor of n = 10 and 3.04 at n = 17 — so the operative threshold there is not
 * the advertised 3. They cross at n = 18. Naming the quantile matters: sigma_hi/sigma_hat is
 * 1.826 at n = 10 on the 97.5% TWO-SIDED bound and 1.645 on a literal one-sided 95% bound,
 * and a rule that does not say which it means is two rules.
 *
 * WHAT THE RULE STILL DOES NOT DO, recorded so it is not mistaken for covered. It measures
 * within-session variance on ONE image, so it is blind to image-bump and fleet drift — which
 * consequence 2 below names as the dominant risk. It constrains dispersion only, so nothing
 * in it stops the median creeping upward with the ceiling following on each re-record. And
 * it fixes a flake rate without fixing detection power: at this dispersion and margin the
 * gate has 50% power against a **9.3%** p50 regression and needs **13.6%** for 95% power —
 * quote the second when asking what this gate can actually catch. Branch (b) is also CURABLE
 * BY COLLECTING MORE SAMPLES, since sigma_hi/sigma_hat shrinks with n. That is principled
 * where the superseded span rule's n-dependence was not — a confidence bound SHOULD tighten
 * with evidence — but given that this record's own provenance is "the rule fired at n = 5,
 * so we collected 17", it is named here rather than discovered later. If a future cohort
 * fails either test, escalate; do not widen `TOLERANCE`.
 *
 * THE TWO CONSEQUENCES of gating a ratio against a CI-recorded baseline. Both are real costs
 * of this design, and both are standing rules rather than history:
 *   1. A LOCAL `pnpm run perf` CANNOT PREDICT THIS GATE — and, measured, cannot even predict
 *      ITSELF across sessions. On one quiet authoring machine `R` sat at 1.66-1.79 over 8
 *      runs; hours later, same commit and same machine but under ordinary background load,
 *      the same command measured 2.21-2.36 over 6 runs; a later 32-run interleaved series on
 *      that machine spanned **56%**. So a local `R` is comparable only to other local runs
 *      taken back to back, and never to this gate's ceiling.
 *   2. `R0` MUST BE RE-RECORDED WHENEVER THE RUNNER CLASS CHANGES — a GitHub image bump, a
 *      move to larger runners — not only when blast cost changes, and against the RESOLVED
 *      image (`ubuntu-24.04`) rather than the `ubuntu-latest` alias that happens to resolve
 *      to it. That is a maintenance obligation this gate creates, and it is the rule that
 *      binds until the provisional status is discharged.
 *
 * DISCHARGING PROVISIONAL. Dispersion and fleet representativeness are different
 * measurements and need different cohorts, so do not pool them:
 *   - LIMIT 3 clears the first time the escalation rule is applied to a cohort that did not
 *     select it — concretely, >= 10 FRESH attempts of the SAME documented image
 *     (`ubuntu-24.04`) in CI. OWNER: Rob. TRIGGER: the next such opportunity, which is this
 *     repo's own PR CI runs. M2-S11 (2026-08-09) attempted exactly this and discovered,
 *     before taking a single sample, that the only machine available to it was a local
 *     development machine; per consequence 1 above a local run is not merely "a different
 *     image" but is not even self-consistent across sessions, so a local cohort could not
 *     validly clear limit 3. Recorded as a finding, not a re-record: `R0`, `TOLERANCE` and
 *     the ceiling all stayed where they were.
 *   - LIMIT 1 clears when a SECOND image has its own baseline under the same rule and their
 *     MEDIANS agree to within |median_A - median_B| <= 0.02 (~1 sigma at the spread measured
 *     here). Compare MEDIANS, never the committed `R0` values: `R0` is floored to a
 *     hundredth, so two baselines would both read 1.00 across a band far wider than any
 *     difference worth detecting, and comparing them would pass by construction. A larger
 *     disagreement does NOT clear limit 1 — it is a real finding about the fleet AND a delay.
 *     TRIGGER: the next `ubuntu-latest` image bump, which arrives on GitHub's schedule and
 *     not this project's.
 *   - LIMIT 2 never clears, for the reason given above. So PROVISIONAL retires on limits 1
 *     and 3 TOGETHER, and a re-record alone is not sufficient — a re-record under the
 *     one-head/one-image rule reproduces limit 1 exactly.
 *
 * NOTHING IN CI DISTINGUISHES A PROVISIONAL BASELINE FROM A CALIBRATED ONE. `ci.yml`'s
 * null-`r0` alarm fires only on a DEFAULT-BRANCH run whose report carries no usable
 * baseline, and it checks only that `r0` is a positive finite number — which a provisional
 * baseline satisfies exactly as a calibrated one would. With a number committed there is
 * nothing for it to catch, which is the state it exists to restore. The provisional status
 * lives in this doc and nowhere else, which is why the triggers above are written down
 * rather than left to memory. See `run.ts`.
 *
 * CHANGING THIS VALUE at all requires an explicit, reviewed commit with justification in the
 * PR. It is never inferred and never auto-updated by a later run: a gate that rebaselines
 * itself measures nothing.
 */
export const R0: number | null = 1.0;

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
      /** AUDIT ONLY — the two superseded statistics over the same subset (p95 gated
       *  between S5b and S6; p99 before that). Never compared to anything; carried so
       *  a statistic stays visible in `PERF-REPORT` rather than vanishing the moment
       *  it stops deciding pass/fail. */
      readonly stressStatP95: number;
      readonly stressStatP99: number;
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
      /** AUDIT ONLY — see the `'unset'` arm above. */
      readonly stressStatP95: number;
      readonly stressStatP99: number;
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
  // Computed but never compared — audit only, so each statistic this gate has
  // replaced stays on the record beside the one that replaced it.
  const sStatP95 = stressStatP95(dueBlastSamples);
  const sStatP99 = stressStatP99(dueBlastSamples);
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
    return {
      status: 'unset',
      r,
      controlStat: cStat,
      stressStat: sStat,
      stressStatP95: sStatP95,
      stressStatP99: sStatP99,
    };
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
    stressStatP95: sStatP95,
    stressStatP99: sStatP99,
  };
}
