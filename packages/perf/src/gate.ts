// gate.ts — the relative CI gate (PLAN step 21, Codex R1-6/R1-9/R2-3).
//
// Three flaws sank the earlier drafts, all documented in PLAN.md so they are not
// silently re-litigated here:
//   - A p95 CEILING cannot see a blast spike at all. `splash`'s cadence-60 blasts put
//     blast-heavy ticks at a small minority of samples (~1.7% in the drafting analysis)
//     — entirely below p95, so a regression in blast cost specifically would never
//     surface in a p95-gated number. THIS IS NOT THE STATISTIC `stressStat` USES BELOW
//     (PLAN step 21, revisiting the 2026-07-31 ruling — see that function's doc): that
//     rejection was p95 over ALL samples, where blast-heavy ticks are the ~1.7%
//     minority that sinks below the percentile. `stressStat` reads the due-blast
//     SUBSET, where every sample carries >= 1 due blast by construction, so there is
//     no minority to sink — the failure mode described here does not apply to it.
//   - An ABSOLUTE ceiling "with generous headroom" lets the threshold be picked AFTER
//     seeing results on `ubuntu-latest` — a runner that is not a stable reference CPU
//     across time. A number chosen post-hoc against one runner's noise floor is not a
//     methodology, it is a guess dressed as one.
//   - Gating raw `max` actively MAGNIFIES runner variance: `max` is the single most
//     noise-sensitive statistic available (one GC pause, one scheduler preemption, and
//     it moves), so an absolute ceiling on it would fail CI on noise alone.
//
// The fix: an IN-JOB CONTROL WORKLOAD. Every run executes a fixed control scenario —
// every AoE tower swapped for its blast-free single-form twin, `stress-blast` ->
// `stress-single`, `stress-chill` -> `stress-chill-single`; `stress-venom` maps to
// ITSELF, unchanged, since it is already blast-free and so has no single-form twin to
// map to — in the SAME process, then the stress scenario, and gates the RATIO `R =
// stressStat / controlStat` — not either statistic alone. This control is NOT a
// genuine one-dimension twin of the stress scenario: the twins also match the chill
// pair's `slow` effect definition (an earlier draft dropped it entirely), but a
// single-form tower cannot reproduce an area effect's slow COVERAGE, so the control
// unavoidably carries a lighter creep population too (measured median 181 vs the
// stress run's 224, peak slowed creeps 109 vs 304 — see `scenario.ts`'s
// `buildControlReplay` doc and this file's `R0` doc below for the full accounting).
// `R` therefore isolates blast cost plus blast-borne slow coverage together, not
// blast cost alone.
//
// A FINDING FROM THE VENOM ARM'S MEASUREMENT, AND WHY IT INVERTS THE HAZARD THAT
// MOTIVATED KEEPING `stress-venom` IN THE CONTROL AT ALL: the DoT workload is
// HEAVIER in the control arm than in the stress arm — 368 peak resident records
// against 175, and 127 peak DoT carriers against 19. `stress-chill`'s AoE slow
// bunches creeps in the stress arm, so its 50 venom towers re-hit the same small
// leading cohort (a refresh, not a new record) under sticky nearest-exit targeting;
// in the control, `stress-chill-single`'s thin coverage lets creeps stream past, so
// each shot seeds a fresh `(targetId, sourceId)` pair instead. So DoT-table cost
// sits predominantly in `R`'s DENOMINATOR, biasing `R` DOWNWARD — the opposite
// direction from the "DoT exclusively in the numerator" hazard that motivated giving
// the control a venom arm in the first place. Both facts are true and both belong on
// record: the venom arm is still correct (a DoT-free control would put DoT
// exclusively in the numerator, which is worse), and the residual asymmetry runs the
// other way. Magnitude caveat: `dot-bench`'s own curve is roughly 0.25ms per 1,000
// resident records, so a ~190-record gap is small in absolute terms — the DIRECTION
// is what needs stating here, not an alarm.
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

/** `stressStat` — p95 of `step()` wall-clock over the STRESS run's DUE-BLAST-TICK
 *  SUBSET within the sampled window (not the full stress sample set — a tick with no
 *  due blast this step is not exercising the blast membership scan at all, and mixing
 *  it in would dilute the statistic toward the maze's baseline cost, hiding exactly
 *  the regression this gate exists to catch).
 *
 * MOVED FROM p99 TO p95 (PLAN step 21) — a REVISIT of the 2026-07-31 ruling recorded
 * in `docs/adr/0005-performance-budgets.md` under **"Finding 3"** (the relative-gate
 * finding) and in `docs/milestones/m2.md`'s **M2-S4b** entry — cited by HEADING, not by
 * line number, because M2-S5b's own amendment to that ADR shifted the very lines an
 * earlier draft of this comment cited, leaving the pointer aimed at an unrelated table
 * within the same commit. This is not the closing of an open decision: that ruling was
 * to accept the gate's flake
 * rate and ship as-is, with ADR 0005 adding "Revisit if the job flakes in practice."
 * The job has NOT flaked in practice since that ruling — this is not that trigger
 * firing. The trigger here is different: S5b must re-record `R0` regardless, because
 * P9 changed the stress workload, which makes this the one moment the gate's statistic
 * can change without paying a second re-record. This file's own diagnosis already
 * named the numerator's tail as the noise's home ("the denominator is a median, so it
 * barely moves with tail noise by construction; the numerator absorbs all of it" —
 * see `R0`'s doc below), so a numerator statistic that gives up less of the upper tail
 * is the one the diagnosis points at. Owner ruling of 2026-08-02: this class of
 * decision (a statistic swap justified by a workload rebaseline, not by a fired ADR
 * trigger) is technical and Claude's to take.
 *
 * p95, NOT p99 (this move) and NOT p99.9 (Codex R3-3, unchanged reasoning): with the
 * oracle's >= 500-sample due-blast floor (`oracle.ts`'s `DUE_BLAST_SAMPLES_THRESHOLD`),
 * p95 discards the top ~5% of observations rather than p99's ~1% — MORE tail-noise
 * resistant, not less, while the fixture below (`gate-fixture.test.ts`) proves it does
 * not discard the regression signal a broad blast-cost regression produces. p99.9 over
 * a subset this size would often BE the maximum (the single noisiest tick),
 * reintroducing exactly the GC/scheduler sensitivity a relative gate exists to remove.
 *
 * THIS IS NOT THE STATISTIC THE FILE-TOP COMMENT REJECTS. That rejection is p95 over
 * ALL samples, where blast-heavy ticks are a ~1.7% minority that sinks below the
 * percentile entirely. `stressStat` reads the due-blast SUBSET — every sample here
 * carries >= 1 due blast by construction, so there is no minority to sink below the
 * rank; a broad blast-cost regression raises the whole subset and p95 sees it. See
 * the "DECLARED BLIND SPOT" doc below for what p95-over-the-subset still cannot see.
 *
 * `stressStatP99` (below) is kept and reported for audit: the previously-gating
 * statistic stays visible in `PERF-REPORT` and in `GateResult` even though it no
 * longer decides pass/fail, so the switch is never a one-way door taken silently.
 *
 * Throws (via `percentile`) if `dueBlastSamples` is empty — a caller must filter to
 * the due-blast subset first; an empty subset is an oracle failure
 * (`DUE_BLAST_SAMPLES_THRESHOLD`), not a gate that should silently report `NaN`.
 */
export function stressStat(dueBlastSamples: readonly SampledTick[]): number {
  return percentile(
    dueBlastSamples.map((s) => s.ms),
    95,
  );
}

/** `stressStatP99` — the STATISTIC `stressStat` USED BEFORE THIS REVISIT, over the
 *  same due-blast subset. Not used for gating (`evaluateGate` below computes it but
 *  does not compare it to anything) — kept purely so the rejected statistic stays
 *  auditable in `GateResult` and `PERF-REPORT` rather than disappearing from the
 *  record the moment it stops deciding pass/fail. See `stressStat`'s doc for why p95
 *  replaced it. */
export function stressStatP99(dueBlastSamples: readonly SampledTick[]): number {
  return percentile(
    dueBlastSamples.map((s) => s.ms),
    99,
  );
}

// `stressStat`'s DECLARED BLIND SPOT (PLAN step 21, §4) — reported, never gating. A `//`
// block on purpose: this is free-standing prose about the function above, not the doc of
// the declaration below, and a `/** */` here would attach itself to `TOLERANCE`.
//
// p95's insensitivity to tail-concentrated cost is the same property that suppresses
// tail noise — no test design separates them. What makes the trade acceptable is the
// subset: the rejection of p95 over ALL samples (file-top comment) was about blast
// ticks sinking below the percentile, and `stressStat` reads the due-blast subset
// where every sample carries >= 1 blast. A blast-cost regression raises cost across
// that whole subset — the broad injection `gate-fixture.test.ts` measures — and p95
// sees it, at a smaller `k` than p99 does.
//
// The blind spot is wider than "scheduler noise": a real AoE regression CAN
// concentrate in under 5% of due-blast ticks — one scaling with blast multiplicity
// would land mostly on the high-`dueBlasts` ticks — and p95 suppresses that as
// thoroughly as it suppresses a GC pause. Accepted deliberately under the owner's
// 2026-08-02 ruling that this class of decision is Claude's to take, with the
// measured `k` values on record in `gate-fixture.test.ts`.

/** CI fails when `R > R0 * TOLERANCE`. Predeclared, not tuned after seeing results
 *  (PLAN step 21): what is fixed BEFORE measurement is what matters methodologically —
 *  both statistics above, the >= 500 due-blast sample floor (`oracle.ts`), and this
 *  25% tolerance — so the gate can never be quietly adjusted to whatever the first
 *  run's numbers happened to be. */
export const TOLERANCE = 1.25;

/**
 * `R0` — the baseline ratio: **1.42**, re-recorded 2026-08-03 (M2-S5b P11) on the POST-P9
 * stress workload, with the p95 statistic, on the runner the gate actually runs on: image
 * **ubuntu-24.04**, GitHub Actions run **30851346335**, attempts **1-5** — five distinct
 * attempts with five distinct job ids (a first collection pass returned one run read four
 * times; re-verified before this table was written).
 *
 *   | attempt | job         | controlStat p50 | stressStat p95 | audit p99 | R (p95) | R (p99) |
 *   | ------- | ----------- | ---------------- | --------------- | --------- | ------- | ------- |
 *   | 1       | 91811842462 | 0.378234          | 0.540021         | 0.713615  | 1.4277  | 1.8867  |
 *   | 2       | 91815000367 | 0.394437          | 0.571298         | 0.719074  | 1.4484  | 1.8230  |
 *   | 3       | 91815560758 | 0.374028          | 0.494694         | 0.699456  | 1.3226  | 1.8701  |
 *   | 4       | 91816459609 | 0.376357          | 0.594722         | 0.756914  | 1.5802  | 2.0112  |
 *   | 5       | 91817201212 | 0.390022          | 0.512714         | 0.705933  | 1.3146  | 1.8100  |
 *
 * MEDIAN of the five R(p95) values, in the order taken (1.4277, 1.4484, 1.3226, 1.5802,
 * 1.3146), sorted (1.3146, 1.3226, 1.4277, 1.4484, 1.5802): median **1.427743**, rounded
 * DOWN to the nearer hundredth -> **R0 = 1.42**. Down, not to-nearest, for the same reason
 * as the earlier 2.49-era record below: a lower R0 makes the ceiling stricter, so the
 * rounding can only ever cost a false alarm, never hide a regression. Ceiling = 1.42 x
 * 1.25 = **1.7750** — the max sample, 1.5802, sits inside it. Span (max/min) = 1.5802 /
 * 1.3146 = **1.2021**, within `TOLERANCE`, so the pre-committed "if the five span more than
 * `TOLERANCE`" escalation is NOT triggered. Fixed cohort: exactly five samples, no sixth
 * sample and no widened tolerance.
 *
 * THE SIXTH OBSERVATION, AND THE DIAGNOSIS IT BOUGHT (2026-08-03, owner-ruled to ship
 * as-is). The very next CI run after this cohort was recorded — the run validating the
 * new `R0` — came in at **R = 1.7595 against the 1.7750 ceiling: a 0.88% margin**, and
 * 11.3% ABOVE the recorded cohort's maximum. It is NOT a sixth sample (the cohort stays
 * fixed at five, per the plan: no re-record, no widened `TOLERANCE`), but it is on record
 * because ignoring it would make this doc a lie by omission.
 *
 * Including it, the p95 spread is **33.8%** (1.3146 -> 1.7595) against the historical
 * pre-S5b p99 population's 37.7%. So, stated without softening: **the switch to p95 did
 * not reduce the flake.** The gate is expected to flake, and that outcome is inside the
 * 2026-07-31 ruling, which accepted exactly this (`perf` is not a required check).
 *
 * But the OPERANDS explain WHY, and this is the first real diagnosis this gate has had:
 *
 *     quantity            cohort range        the 1.7595 run
 *     controlStat p50     0.374 - 0.394       0.3876   <- NORMAL
 *     stressStat  p95     0.495 - 0.595       0.6819   <- 15% above cohort max
 *
 * The denominator barely moved. **The whole stress-arm distribution shifted UP — a
 * LOCATION shift, not a heavier tail.** That is why no percentile choice helps: p95 and
 * p99 are both location statistics of the same shifted distribution, and under p99 this
 * run would sit at R = 2.2951 against a p99-derived ceiling of 2.3375 — a 1.8% margin,
 * equally marginal. Choosing a different rank cannot fix a shift in the whole
 * distribution's level.
 *
 * So the "the numerator absorbs the tail noise" framing below, which motivated the
 * statistic swap, was aiming at the wrong thing. Whatever eventually fixes this gate has
 * to target the stress arm's RUN-TO-RUN LEVEL, not the shape of its upper tail. Recorded
 * here for whichever story picks up the perf diagnosis (unassigned as of S5b, S6-S10).
 *
 * THE FINDING THAT MUST NOT BE SOFTENED. On the recorded cohort, p95's spread is nearly
 * DOUBLE p99's: `(max - min) / min` over the five R(p95) values is **20.2%** (1.5802 vs
 * 1.3146), against **11.1%** for the five R(p99) values in the audit column above (2.0112
 * vs 1.8100) — computed on the exact same five runs, same attempts, same job. This file's
 * own diagnosis, a few paragraphs below, is that the denominator is a median and barely
 * moves with tail noise BY CONSTRUCTION, so the numerator absorbs all of it — which
 * predicts that a numerator statistic discarding MORE of the tail (p95 drops the top ~5%,
 * p99 the top ~1%) should be QUIETER. **This data does not support that. It contradicts
 * it.**
 *
 * The switch to p95 still stands, but on a narrower footing than "it's quieter": it is
 * justified by REGRESSION SENSITIVITY, not noise reduction. The pinned fixture
 * (`gate-fixture.test.ts`) measured p95 catching a broad blast-cost regression at
 * `k = 0.020` at every legal subset size while p99 caught it at none — THAT was the
 * pre-committed reversal condition, and it passed decisively. The NOISE-SUPPRESSION half
 * of the original rationale is NOT supported by this five-sample cohort, and this doc says
 * so plainly rather than hedging it into invisibility. This does not resolve the cause of
 * the spread, which remains unknown — and there is now positive evidence AGAINST the
 * tail-noise hypothesis that motivated the statistic choice in the first place.
 *
 * Comparability caveats on that finding, stated rather than used as an escape hatch: five
 * samples here against the historical eight below; a DIFFERENT workload (P9 changed the
 * stress scene, so this cohort and the 2.49-era one below are not measuring the same
 * thing); and the historical 37.7% spread was measured across distinct runner instances
 * (eight distinct `runner_name`s, eight separate Actions jobs) while these five are
 * re-runs of ONE run on ONE runner (five attempts of job 30851346335). So this is NOT a
 * controlled comparison in either direction — it neither vindicates nor condemns p95 on
 * noise. It is what was measured.
 *
 * WHY R0 MOVED — MEASUREMENT ONLY, NO MODEL. An earlier draft of this doc modelled the
 * move as `R' = (S - b + c_s)/(C + c_c)`. That is INVALID and does not appear here: `S`
 * and `C` are percentiles of two different distributions, percentiles are not additive,
 * and no such expression can establish causation or predict a direction for `R0`. What
 * goes on record instead is measured, never derived:
 *
 * - The five samples in the table above, absolute operands as well as the ratio.
 * - PR A's pre-change baselines, on the UNCHANGED workload with the OLD scene (run
 *   30828066588, job 91734721525, `ubuntu-24.04` image 20260720.247.2):
 *
 *   |          | controlStat p50 | due-blast p99 | due-blast p95 | R (p99) | R (p95) |
 *   | -------- | ---------------- | -------------- | -------------- | ------- | ------- |
 *   | before-1 | 0.286896          | 0.718915        | 0.495136        | 2.5058  | 1.7258  |
 *   | before-2 | 0.282686          | 0.703900        | 0.488650        | 2.4900  | 1.7286  |
 *
 *   Both statistics recorded on both sides, so a p99-before is never compared against a
 *   p95-after.
 * - Both arms' DoT activity, measured: stress 175 peak resident records / 19 peak DoT
 *   carriers; control 368 / 127 — the numbers behind the file-top comment's "DoT activity
 *   is HEAVIER in the control arm" finding, which is what makes the arms' differing DoT
 *   workload visible rather than merely asserted.
 *
 * And two qualitative facts, stated as what they are — not derived, not modelled, not a
 * prediction of direction: the AoE-producing tower population fell **150 -> 100** (P9's
 * three-way split), and `R` is now a COMPOSITE of AoE cost and a DIFFERENTIAL DoT
 * workload — the two arms carry different creep populations (median 181 control vs 224
 * stress), so an identical `stress-venom` definition does not do identical work on each
 * side. The file-top comment already says this; this doc does not contradict it.
 *
 * ==========================================================================================
 * HISTORICAL RECORD — the pre-P9, p99-statistic era, `R0 = 2.49`. SUPERSEDED by the
 * re-record above (both the workload and the statistic changed), kept in full because the
 * runner-variance finding it documents is still true and still the reason this gate is a
 * ratio with a 25% tolerance rather than a tight absolute number.
 * ==========================================================================================
 *
 * `R0` was **2.49**, recorded on `ubuntu-latest`.
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
 * THE CEILING HAD ALREADY BEEN EXCEEDED ON UNCHANGED CODE. R0 was chosen from the first
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
 * So the gate's flake rate was not "comfortable". Stated precisely, because the two
 * readings differ: the shipped 2.49 ceiling was EVALUATED three times (samples 5, 7, 8)
 * and passed all three; but of the eight samples measured on this runner class, ONE would
 * have failed it. "Roughly 1-in-8" is that counterfactual, not an observed failure rate.
 * `perf` is NOT a required check on `main` (branch protection requires `verify` and
 * `codex-freshness` only), so a flake is noise rather than something that stops a merge —
 * but it is noise people learn to ignore, and that was this gate's real risk. Ruled
 * 2026-07-31 (`docs/milestones/m2.md`'s S4 flags): accept the flake, with the rate on
 * record. The p95 move above is a DATED REVISIT of that ruling's substance, not a reopening
 * of it — see `stressStat`'s doc for what changed and why.
 *
 * WHY R0 WAS NOT MOVED AGAIN AT THE TIME. This doc's own pre-declared response to flake is
 * "more samples and a re-recorded median, never a wider tolerance". Applying it then: the
 * median of all eight was 2.5533 -> R0 2.55, ceiling 3.1875 — which still would not have
 * accommodated sample 6. It changed no observed sample's verdict, so re-recording bought
 * nothing but a second threshold edit under pressure on one branch, which is the pattern
 * this file warns against. The value stayed at 2.49 and the finding was escalated instead
 * — until P9 changed the workload and forced the re-record above regardless.
 *
 * TWO CONSEQUENCES, both real costs of this design, stated rather than papered over:
 *   1. A LOCAL `pnpm run perf` CANNOT PREDICT THE GATE — and, measured, cannot even
 *      predict ITSELF across sessions. On a quiet authoring machine R sat at 1.66-1.79
 *      (8 runs); hours later, same commit, same machine, but under ordinary background
 *      load, the same command measured 2.21-2.36 (6 runs); a later 32-run interleaved
 *      series on that machine spanned 1.638-2.560, **56%** (an uncommitted review harness,
 *      both arms of an ordering A/B pooled). So a local R is only
 *      comparable to other local runs taken back to back, and never to this gate's
 *      ceiling — this still holds under the 1.42 baseline above.
 *   2. R0 must be re-recorded whenever the RUNNER class changes (a GitHub image bump, a
 *      move to larger runners), not only when blast cost changes — against the resolved
 *      image recorded under PROVENANCE above, not against the `ubuntu-latest` alias. That
 *      is a maintenance obligation this gate creates.
 *
 * What was pre-declared before any measurement is unchanged, and is what matters
 * methodologically: both statistics, the >= 500 due-blast sample floor, and the 25%
 * tolerance. TOLERANCE has never been widened to fit a bad sample — at the 2.49-era ceiling
 * the worst sample sat 30.4% above R0 (3.2478 / 2.49), needing TOLERANCE >= 1.31 to absorb,
 * and a gate that permits a 31% regression in blast cost before it complains is not worth
 * the CI minutes. (The 37.7% figure above is max/min across the eight — the right measure
 * of how noisy the runner is, but NOT the number to compare against a tolerance that
 * multiplies a median.)
 *
 * Changing this value at all requires an explicit, reviewed commit with justification in
 * the PR. It is never inferred and never auto-updated by a later run: a gate that
 * rebaselines itself measures nothing.
 */
export const R0: number | null = 1.42;

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
      /** AUDIT ONLY — the pre-revisit p99 over the same subset. Never compared to
       *  anything; carried so the rejected statistic stays visible in `PERF-REPORT`
       *  rather than vanishing the moment it stops deciding pass/fail. */
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
  // Computed but never compared — audit only, so the statistic this revisit replaced
  // stays on the record beside the one that replaced it.
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
    stressStatP99: sStatP99,
  };
}
