// gate.ts — the relative CI gate (PLAN step 21, Codex R1-6/R1-9/R2-3).
//
// Three flaws sank the earlier drafts, all documented in PLAN.md so they are not
// silently re-litigated here:
//   - A p95 CEILING over ALL SAMPLES cannot see a blast spike at all. `splash`'s
//     cadence-60 blasts put blast-heavy ticks at a small minority of samples (~1.7% in
//     the drafting analysis) — entirely below p95, so a regression in blast cost
//     specifically would never surface. The fix for this is POPULATION, not percentile:
//     `stressStat` reads the due-blast SUBSET, where every sample carries >= 1 due
//     blast by construction, so there is no minority left to sink below any rank.
//     (M2-S6 corrects a conflation here: having fixed the population, the gate went on
//     keeping a high percentile as though the percentile were still doing the finding.
//     It is not, and a high percentile over an already-filtered population buys no
//     signal while admitting the runner's whole tail as noise. See `stressStat`.)
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
// roughly the same factor, so `R` survives the move roughly intact. Whether it also
// cancels TAIL VARIANCE depends entirely on the two statistics being LIKE FOR LIKE in
// robustness, and this is where the gate was wrong for two milestones.
//
// An earlier wording, "cancels the noise out", overclaimed. Its replacement then
// UNDER-claimed in a more damaging way: it recorded that a like-for-like p99/p99
// comparison swung "only ±0.7%" against `R`'s own ±6%, measured across three runs ON
// ONE QUIET MACHINE. That does not survive contact with CI: over four consecutive CI
// runs whose workload oracles are byte-identical, p99/p99 swings ±11.7% and p95/p95
// ±16.4%, against p50/p50's ±2.8%.
//
// THE MECHANISM. A tempting story is that the tails "are independent draws that compound
// rather than cancel"; these four runs do not support it. Across them the two arms' p95s
// correlate +0.88, which is consistent with tail
// noise also largely cancelling rather than compounding (that correlation is not separable
// at n = 4 — see below — so read it as the direction the data leans, not as established).
// What separates the statistics is how MUCH is left:
//
//   - the arms' MEDIANS co-move almost perfectly (+0.99) and carry small per-arm spread,
//     so the ratio is left with close to pure workload;
//   - the arms' TAILS are both noisier per arm AND less well correlated, so more survives
//     the division: 1.65x-2.55x the per-arm half-spread (see `stressStat`'s per-run table),
//     on top of the +0.88-vs-+0.99 correlation drop.
//
// HOW MUCH OF THIS n = 4 ACTUALLY SETTLES, since this file insists on that discipline
// everywhere else and an earlier draft of this block did not apply it here. Only the +0.99
// excludes zero (95% CI [0.68, 1.00]). At n = 4 the +0.88 carries a CI of roughly
// [-0.52, 0.998] and is not separable from either of the others. So the honest statement is
// that these four runs do NOT support the compounding story, not that they refute it — the
// load-bearing evidence for the design is the R table below, where the median ratio's
// advantage is 4.2x-5.9x, not the correlations, which are offered as mechanism.
//
// (An illustration, not a check, and it is a selected one: within the CONTROL arm across
// the four jobs, p50 and p95 correlate only +0.64 — lower than the cross-arm p95
// correlation. The same quantity in the STRESS arm is +0.36, weaker still. Tail behaviour
// is simply not well predicted by the level a run executes at.)
//
// The conclusion is unchanged and is what the design rests on: a ratio of two ROBUST
// statistics is the stable one. Both arms are medians over >= 500 samples, so neither can be
// moved MATERIALLY by a single GC pause or scheduler preemption — stated with that qualifier
// because the unqualified form is false: changing one sample shifts a median to an adjacent
// order statistic — a real but negligible move, not no move. That is the design as of M2-S6,
// and it is what makes the tolerance below affordable at 10%.

import { percentile } from './stats';
import type { SampledTick } from './harness';

/** `controlStat` — p50 of `step()` wall-clock over the CONTROL scenario's sampled
 *  ticks. A median over a blast-free run: robust to runner noise BY CONSTRUCTION (a
 *  single slow tick from GC/scheduler preemption can shift a median computed over 2,500
 *  samples by at most one order statistic, which is negligible — not literally zero, and the
 *  claim is worth stating in the bounded form), and blast-free so it measures the maze's
 *  baseline busy-board cost
 *  with no AoE membership-scan cost mixed in.
 *
 *  Since M2-S6 this robustness is the gate's DESIGN PRINCIPLE rather than a property of
 *  one arm: `stressStat` is now also a median, and a ratio only cancels runner noise
 *  when BOTH terms respond to it the same way. Pairing this median with a tail
 *  statistic is what made `R` swing ±15.5% run-to-run on identical work. Do not change
 *  either arm to a tail statistic without re-reading `stressStat`'s measurement table. */
export function controlStat(controlSamples: readonly SampledTick[]): number {
  return percentile(
    controlSamples.map((s) => s.ms),
    50,
  );
}

/** `stressStat` — p50 of `step()` wall-clock over the STRESS run's DUE-BLAST-TICK
 *  SUBSET within the sampled window (not the full stress sample set — a tick with no
 *  due blast this step is not exercising the blast membership scan at all, and mixing
 *  it in would dilute the statistic toward the maze's baseline cost, hiding exactly
 *  the regression this gate exists to catch).
 *
 * MOVED FROM p95 TO p50 (M2-S6 QC, 2026-08-05), and the reasoning corrects a
 * conflation this file carried through three statistic choices (p99 -> p95 -> p50).
 *
 * THE TWO JOBS. Finding blast ticks and choosing where in their cost distribution to
 * read are SEPARATE jobs, and a percentile can only do the second. The file-top
 * comment's original rejection — "a p95 CEILING cannot see a blast spike at all" —
 * was true of p95 over ALL samples, where blast ticks are a ~1.7% minority that sinks
 * below the rank. S5b fixed that by restricting the POPULATION to the due-blast
 * subset. But it then kept the high percentile on top, as though the percentile were
 * still doing the finding. It is not: every sample in the subset carries >= 1 due
 * blast by construction, so there is no minority left to sink. Once the population
 * does the finding, a high percentile adds no signal — only variance.
 *
 * MEASURED, not argued (four consecutive CI runs on `ubuntu-24.04`, workload oracles
 * byte-identical across all four — 304 peak creeps, 224 median, 1,427 due-blast
 * samples, 175 DoT records, route length 329 — so every difference below is runner
 * noise, not workload):
 *
 * "Half-spread" throughout this file and ADR 0005's ratio tables means `(max - min) / 2`
 * divided by the MEDIAN of the four values. Stating it matters, because on a MEAN basis the
 * four rows below read 15.4 / 16.1 / 11.7 / 2.7 — three of them differ in the first decimal,
 * including the headline 2.8, so a reader recomputing any of them could think it wrong.
 *
 *   | ratio statistic                   | R across the four runs        | half-spread |
 *   | --------------------------------- | ----------------------------- | ----------- |
 *   | p95(subset) / p50(control) [old]  | 1.3444 1.7522 1.4214 1.8348   | +/- 15.5%   |
 *   | p95(subset) / p95(control)        | 0.6524 0.6119 0.7461 0.8411   | +/- 16.4%   |
 *   | p99(subset) / p99(control)        | 0.5406 0.5816 0.6855 0.6622   | +/- 11.7%   |
 *   | p50(subset) / p50(control) [new]  | 0.9962 0.9938 1.0164 1.0493   | +/-  2.8%   |
 *
 * THE PER-ARM VALUES THOSE RATIOS ARE BUILT FROM, in the same run order (ms):
 *
 *   | run | control p50 | control p95 | stress p50 | stress p95 |
 *   | --- | ----------- | ----------- | ---------- | ---------- |
 *   |  1  |   0.3863    |   0.7960    |   0.3848   |   0.5193   |
 *   |  2  |   0.4102    |   1.1746    |   0.4077   |   0.7188   |
 *   |  3  |   0.4048    |   0.7711    |   0.4114   |   0.5753   |
 *   |  4  |   0.3128    |   0.6824    |   0.3282   |   0.5739   |
 *
 * THIS TABLE IS RECONSTRUCTED, NOT TRANSCRIBED, and that has to be said plainly. What the
 * M2-S6 diagnosis recorded was the four ratio series above plus ADR 0005's per-arm MIN/MAX
 * — never the per-run arms. Those are recoverable because the ratios over-determine them:
 * `stress p95 = A * control p50`, `control p95 = A * control p50 / B`, `stress p50 =
 * D * control p50`, leaving one free scale per run, which the eight recorded endpoints pin.
 * The assignment is UNIQUE — each run is fixed by a different endpoint it attains (run 1 by
 * the stress-p95 min, run 2 by the control-p50 max, run 3 by the stress-p50 max, run 4 by
 * the control-p50 min), leaving no run with a free interval.
 *
 * SEVEN of the eight endpoints reproduce to 4 dp; the eighth, control p95's max, comes out
 * 1.17462 against a recorded 1.1747 — one in the last place, which is what independently
 * rounding three 4 dp inputs costs. Worst endpoint error across all eight is 7.6e-5. Said
 * exactly rather than as "reproduces all eight", because a reader checking will find that
 * cell.
 *
 * EVERY CELL AND EVERY DERIVED FIGURE HERE IS COMPUTED FROM THE UNROUNDED SCALES, not from
 * the 4 dp values printed above, so recomputing from the printed table can differ in the
 * last place — run 3 is where it shows: from the printed `control p50` 0.4048 the chain
 * gives 0.5754 / 0.7712 where the unrounded scale gives 0.5753 / 0.7711. Neither is a
 * different measurement; it is one rounding applied at two different points. The same
 * applies to the half-spreads below (stress p95 is 17.35% unrounded, 17.36% off the printed
 * cells). Quoting a figure to a precision the inputs do not carry is the failure this whole
 * amendment is about, so: these are 4 dp reconstructions of 4 dp records, and the last
 * digit of anything derived from them is not load-bearing. As CORROBORATION FROM OUTSIDE ITS OWN CONSTRAINTS, two figures that were not inputs
 * to the fit: the numerator pair this change's commit message cites as 0.5753 -> 0.5739
 * (runs 3 -> 4 above, exactly) and the "denominator ran 23% faster" that triggered the whole
 * investigation (0.4048 -> 0.3128 is 22.7%).
 *
 * It is published because without it NOTHING derived per-arm is checkable: a reader given
 * only min/max cannot apply the half-spread convention this file declares, which is how an
 * earlier draft came to quote per-arm figures on a THIRD convention (midpoint-relative)
 * without noticing, and then to delete a "~2.5x" multiplier as unreproducible when under the
 * declared convention it reproduces at 2.55x. Under that convention the per-arm half-spreads
 * are control p50 12.31%, control p95 31.41%, stress p50 10.50%, stress p95 17.35% — tails
 * 1.65x-2.55x the medians.
 *
 * PROVENANCE GAP, recorded rather than papered over: unlike the S5b cohort (run 30851346335,
 * attempts 1-5) and the S4b cohort (eight job IDs with timestamps), the four M2-S6 runs were
 * recorded without run or job IDs and those are not recoverable. The numbers are falsifiable
 * — anyone can recompute every derived figure from the two tables — but they cannot be
 * traced back to the jobs that produced them. Do not repeat that: the re-record below names
 * its runs.
 *
 * What n = 4 does and does not resolve, stated so the table is not over-read. The gap
 * between p50/p50 and every tail ratio is 4.2x-5.9x, which is significant at this sample
 * size (and the series are PAIRED — same four runs — which makes the real test stronger
 * still). The gaps AMONG the tail ratios are not: p95/p95 versus p99/p99 is 1.41x and
 * versus p95/p50 is 1.06x, both well inside the noise of a four-sample range estimate. So
 * the honest reading is "the median ratio is decisively quieter than any tail ratio", NOT
 * "matching percentiles is worse than mixing them" — an earlier draft claimed the latter
 * and it is not supported.
 *
 * The prior claim that a like-for-like p99/p99 ratio swung "only +/- 0.7%" was measured on
 * ONE QUIET MACHINE and does not survive contact with CI: it is +/- 11.7% here.
 *
 * WHAT THE STATISTIC BUYS, AND WHAT IT COSTS — stated in the right causal order, because
 * an earlier draft of this comment got it backwards and credited p50 with a gain it did
 * not produce.
 *
 * The statistic does not buy sensitivity. It buys NOISE, and at EQUAL tolerance p50 is
 * the LESS sensitive of the two: on `gate-fixture.test.ts`'s broad injection at the full
 * sample count, p95 fires at k = 0.00745 where p50 needs k = 0.00922 — a ~24% larger
 * regression.
 *
 * What the low noise buys is a TOLERANCE that was previously unaffordable:
 *
 *   old: p95 @ 1.25 fires at k = 0.01536, against +/- 15.5% noise — 1.6x headroom
 *   new: p50 @ 1.10 fires at k = 0.00922, against +/-  2.8% noise — 3.6x headroom
 *
 * ALL FOUR `k` FIGURES ABOVE ARE FROM A CONTINUOUS SWEEP (step 1e-5) OVER THE FIXTURE'S
 * BROAD INJECTION, not from `gate-fixture.test.ts`'s `KS` grid, and they are quoted
 * UNROUNDED for a reason: the grid's nearest points are 0.0075 and 0.0100, the swept
 * crossings are 0.00745 and 0.00922, and rounding the swept pair to the grid's precision
 * turns the ~24% gap into 23%. An earlier draft of this very paragraph declared the sweep
 * and then quoted the grid's 0.0075 anyway — the same substitution, one layer down, that
 * turned a 1.67x end-to-end gain into a claimed 2.00x (`0.020 -> 0.010`). Read the
 * fixture's assertions as ORDERING and these numbers as MAGNITUDES; never move one into
 * the other's role.
 *
 * p95 CANNOT be run at 1.10: its own run-to-run spread exceeds that threshold, so it
 * would fail on quiet runners rather than on regressions. So the chain is — p50 cuts the
 * noise 5.6x (from the unrounded 15.452 / 2.758 — dividing the rounded figures gives 5.5),
 * the lower noise makes 1.10 affordable, and
 * the tighter tolerance is what converts that into an end-to-end sensitivity gain
 * (k = 0.01536 -> 0.00922, 1.67x) the old pairing could not reach. The sensitivity belongs
 * to the tolerance; the tolerance is only available because of the statistic. It is a 1.67x
 * gain, not a doubling, and it is bought with the ~24% loss above plus the blind spot below
 * — this move is worth making on the noise alone, and it should not be sold as more.
 *
 * The old pairing was calibrated to its own noise floor rather than to any regression
 * size worth catching: at +/- 15.5% run-to-run variance a 25% tolerance cannot reliably
 * separate a real regression from a quiet runner. That is not a strict gate; it is a loose
 * one whose looseness was invisible because it was expressed as a large tolerance rather
 * than as a large error bar.
 *
 * TWO UNIT CAVEATS, since the prose above is in percentages.
 *
 * First: `R` is now near 1.00, which means both arms are dominated by the same baseline
 * per-tick cost and the due-blast median is close to the control median. A 10% move in
 * `R` is therefore NOT a 10% blast-cost regression — it is ~10% of TOTAL tick cost, and
 * blast cost is only part of that.
 *
 * Second, and this is where an earlier draft over-reached: do NOT convert the two
 * tolerances into an "Nx tighter in absolute ms" claim. 1.25 bounded a **p95** of the
 * due-blast subset and 1.10 bounds a **median** of it, so the two headrooms are headroom
 * on DIFFERENT statistics of the same population, and their ratio is not a gate-strength
 * comparison — it is a category error with a plausible number attached. The `k` values
 * above are the honest comparison, because they are read off ONE common injection.
 *
 * WHAT p50 GIVES UP, and it is not nothing. A regression CONCENTRATED on the blast-heaviest
 * ticks — the shape an O(n^2) in blast membership scanning would take — moves p95 far more
 * than p50: on the fixture's `dueBlasts >= 3` injection (~11% of samples) p95 moves +35.5%
 * and p50 only +2.2%, which against each statistic's own noise is a signal-to-noise of 2.2
 * versus 0.8. p95 detects that regression; this median does not. See the DECLARED BLIND
 * SPOT block below for the full accounting and for why the trade is still the right one —
 * in short, the ordering reverses on the BROAD regression this gate primarily exists to
 * catch, where p50 scores 3.9 and p95 only 0.8.
 *
 * `stressStatP95`/`stressStatP99` (below) are kept and reported for audit: a statistic that
 * stops deciding pass/fail stays visible in `PERF-REPORT` and `GateResult`, so this is never
 * a one-way door taken silently.
 *
 * Throws (via `percentile`) if `dueBlastSamples` is empty — a caller must filter to
 * the due-blast subset first; an empty subset is an oracle failure
 * (`DUE_BLAST_SAMPLES_THRESHOLD`), not a gate that should silently report `NaN`.
 */
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

/** `stressStatP99` — the statistic `stressStat` used BEFORE M2-S5b P11, over the
 *  same due-blast subset. Not used for gating (`evaluateGate` below computes it but
 *  does not compare it to anything) — kept purely so the rejected statistic stays
 *  auditable in `GateResult` and `PERF-REPORT` rather than disappearing from the
 *  record the moment it stops deciding pass/fail. See `stressStat`'s doc for the full
 *  p99 -> p95 -> p50 history. Named absolutely, not as "the previous revisit": there have
 *  been two, and a relative reference does not survive the second. */
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
// A median's insensitivity to tail-concentrated cost is the same property that makes it
// immune to tail noise — no test design separates them. This is the one real cost of the
// M2-S6 move and it is not hidden here.
//
// What makes the trade acceptable is the POPULATION, not the percentile. `stressStat`
// reads the due-blast subset, where every sample carries >= 1 blast by construction, so
// a blast-cost regression raises cost across the WHOLE subset — it is broad by nature,
// which is exactly the shape `gate-fixture.test.ts` injects, and a median sees a broad
// shift in full. Precisely: a MULTIPLICATIVE 10% shift applied to every sample moves every
// percentile by exactly 10%, medians included. The fixture's injection is ADDITIVE and
// scaled by `dueBlasts` rather than multiplicative, so it does not land on that identity —
// at k = 0.010 it moves p50 by +10.82%. Do not quote the identity's exact 10.00% against this
// fixture — they are different injection shapes.
//
// THE BLIND SPOT, AT FULL STRENGTH — this move buys its noise immunity with real
// coverage, and the price is not small. On `gate-fixture.test.ts`'s workload-correlated
// injection at `dueBlasts >= 3` (270 of 2,500 samples, ~11% — the shape an O(n^2) in
// blast membership scanning would take), measured at k = 0.020:
//
//     p95 (superseded)  +35.5%     p50 (gating)  +2.2%     p99  +1.9%
//
// Against each statistic's own CI noise from the table above, that is a signal-to-noise
// of 2.2 for p95 and 0.8 for p50: p95 detects this regression and the gating median
// CANNOT. An earlier draft of this comment put the gap at "~0.8 points" — that figure
// came from a different injection model (k * dueBlasts applied to EVERY sample, which is
// broad, not concentrated) and understated the loss by an order of magnitude. The
// fixture's numbers are the ones that count and they are the ones above.
//
// WHY THE TRADE IS STILL RIGHT. On the BROAD regression this gate primarily exists to
// catch, the signal-to-noise ordering reverses: at k = 0.010 it is 3.9 for p50 and 0.8
// for p95. So p95 cannot reliably catch the COMMON case, and it false-alarms on quiet
// runners besides — the M2-S6 CI failure came in at R = 1.8348 against a 1.7750 ceiling
// on byte-identical work, with the numerator essentially unchanged and the DENOMINATOR
// 23% faster. A gate that reliably catches the common case beats one that unreliably
// catches both and cries wolf. The uncovered case stays REPORTED — `stressStatP95` rides
// in every `PERF-REPORT` — so a human reading a suspicious run still sees it, and
// `gate-fixture.test.ts` pins the blind spot as an assertion so it cannot be rediscovered
// by accident. Accepted under the owner's 2026-08-02 ruling that this class of decision
// is Claude's to take.

/** CI fails when `R > R0 * TOLERANCE`. Predeclared, not tuned after seeing results
 *  (PLAN step 21): what is fixed BEFORE measurement is what matters methodologically —
 *  both statistics above, the >= 500 due-blast sample floor (`oracle.ts`), and this
 *  tolerance — so the gate can never be quietly adjusted to whatever the first run's
 *  numbers happened to be.
 *
 *  TIGHTENED 1.25 -> 1.10 (M2-S6 QC, 2026-08-05), together with `stressStat`'s move to
 *  p50 and DECLARED BEFORE the new `R0` was recorded — the order matters, and it is the
 *  same order S5b used. A tolerance is a statement about how much run-to-run noise the
 *  gate must tolerate, so it is chosen from the STATISTIC's measured variance, never
 *  from the baseline's value: 1.25 was right for a statistic whose ratio swung +/- 15.5%
 *  run-to-run, and is far too loose for one that swings +/- 2.8% (both measured over the
 *  same four CI runs, see `stressStat`).
 *
 *  This is a deliberate CHANGE of posture, not a preservation of one: headroom goes from
 *  1.6x the half-spread to 3.6x. The gate becomes both stricter in what it permits and
 *  more reliable about when it fires, and it is the statistic's low noise that makes the
 *  combination possible — 1.10 would be unusable under p95. Not tighter than 1.10: at
 *  3.6x the noise the false-alarm rate is already the binding constraint, and this gate's
 *  whole history is of a ceiling sitting too close to its own error bar. */
export const TOLERANCE = 1.1;

/**
 * SUPERSEDED 2026-08-05 (M2-S6 QC) — the whole record below describes the **p95/p50**
 * era and is kept verbatim as provenance, not as the current baseline. It does not
 * apply to the p50/p50 statistic now shipping, and its 1.42 must not be restored: see
 * the live `R0` declaration further down for the pending re-record and its procedure.
 *
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
 * ratio rather than a tight absolute number. (The tolerance it names, 25%, is history: it
 * is 1.10 as of M2-S6. The RATIO is what that finding motivates and what survives.)
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
/**
 * PENDING RE-RECORD (M2-S6 QC, 2026-08-05). Deliberately `null` — the gate REPORTS `R`
 * and does not enforce it — because `stressStat` moved from p95 to p50 and `TOLERANCE`
 * from 1.25 to 1.10 in this same change. `R0 = 1.42` was recorded against p95/p50 and
 * is meaningless for the new statistic (the four diagnostic CI runs put the p50/p50
 * ratio near 1.00, not 1.42), and carrying it forward would have been the one thing
 * this gate's own doc forbids: a baseline that does not correspond to the statistic it
 * baselines.
 *
 * `null` is the honest state between a statistic change and its re-record, and it is
 * why the `'unset'` arm exists. Restore enforcement by collecting FIVE CI samples from
 * the `perf` job and committing their MEDIAN rounded DOWN to the nearer hundredth —
 * the identical procedure the superseded table below records, including the
 * pre-committed escalation: if the five span more than `TOLERANCE`, stop and escalate
 * rather than widening anything.
 *
 * RECORD THE RUN IDS AND THE RESOLVED RUNNER IMAGE. `ci.yml`'s `perf` job says
 * `runs-on: ubuntu-latest`, which is an ALIAS — the cohorts above are labelled
 * `ubuntu-24.04` because that is what the alias resolved to on the day, and a procedure
 * that asks for "five samples on ubuntu-24.04" cannot be satisfied as written, since
 * nothing in this repo pins it. Take the image from each run's own log ("Runner Image"
 * in the job's setup step) and record it alongside the run ID, so a future reader can
 * tell a genuine baseline shift from an image bump. The four M2-S6 diagnostic runs in
 * `stressStat`'s table were recorded without run IDs and cannot be traced; do not repeat
 * that here, where the number actually gates.
 *
 * While `R0` is null the gate REPORTS and does not enforce, which is a green state that no
 * test goes red for. `ci.yml` carries an alarm for it, and the alarm's limits are worth
 * stating exactly: the `perf` job fails on any DEFAULT-BRANCH run whose report does not
 * carry a usable baseline — `r0` absent, null, non-numeric, or not a positive finite
 * number — or that carries no report line at all, since an absent report cannot prove
 * enforcement. That trigger is `push`, which fires AFTER a merge lands, and `perf` is not a
 * required check (branch protection requires `verify` and `codex-freshness` only — see the
 * 2026-07-31 flake ruling below) — so it DETECTS an unenforced gate
 * on `main` and makes it loudly red; it cannot prevent one from getting there. Prevention
 * would mean failing the pull request, which would fail the very PR collecting the samples.
 * See `run.ts`.
 */
export const R0: number | null = null;

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
