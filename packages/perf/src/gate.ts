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
 * divided by the MEDIAN of the four values. IT IS A RANGE STATISTIC AND THEREFORE DEPENDS
 * ON n: the expected range of a fixed distribution grows with the sample count, so these
 * figures are comparable to each other (all four rows are n = 4) and NOT to a cohort of a
 * different size. Comparing the 2.8% below against a 17-run cohort's 4.92% produced a false
 * alarm during the `R0` re-record; converted to sigma the two agree at ~2.7%. When comparing
 * across cohort sizes use sigma — see `R0`'s doc. (It used to offer the two cohorts' direct
 * sample sds, 2.55% and 2.57%, as a stronger check; it no longer does — at n = 4 the sd
 * carries a 95% CI of 1.45%-9.51%, so that agreement is coincidence.) Stating it matters, because on a MEAN basis the
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
 *  roughly 1.6x the noise to roughly 3.6x. The gate becomes both stricter in what it
 *  permits and more reliable about when it fires, and it is the statistic's low noise that
 *  makes the combination possible — 1.10 would be unusable under p95. Not tighter than
 *  1.10: at that headroom the false-alarm rate is already the binding constraint, and this
 *  gate's whole history is of a ceiling sitting too close to its own error bar.
 *
 *  TWO CAVEATS ON THOSE HEADROOM FIGURES, both established by the `R0` re-record below and
 *  recorded here so this paragraph is not read as more precise than it is. They are
 *  half-spread ratios, and half-spread is a RANGE statistic that grows with sample count,
 *  so a 4-run figure and a 17-run figure are not comparable. And they are measured against
 *  `TOLERANCE - 1` rather than against the real margin from the distribution's centre,
 *  which the floored `R0` shrinks. The properly computed headroom at the committed baseline
 *  is **3.61 sigma** on the point estimate and 2.37 at the sigma upper bound — both in-sample
 *  on the cohort that selected the rule, and both tail statements from an estimated sigma, so
 *  read them as the rule's arithmetic rather than as safety margins (see `R0`'s three limits). Do not read the
 *  numerical closeness of "3.6x" and "3.61 sigma" as confirmation — the 1.6x/3.6x pair was
 *  never a sigma comparison. Recomputed on the sigma basis, the old gate scores 0.78 on the
 *  SAME four diagnostic runs the 1.6x came from (the like-for-like pairing, 0.78 -> 3.61)
 *  and 3.20 on S5b's five-sample cohort. Each pair is internally consistent; do not mix a
 *  member of one with a member of the other. */
export const TOLERANCE = 1.1;

/**
 * SUPERSEDED 2026-08-05 (M2-S6 QC) — the whole record below describes the **p95/p50**
 * era and is kept verbatim as provenance, not as the current baseline. It does not
 * apply to the p50/p50 statistic now shipping, and its 1.42 must not be restored: see
 * the live `R0` declaration further down for the re-recorded value and its provenance.
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
 * RE-RECORDED 2026-08-05 (M2-S6 QC) at **1.00**, for the p50/p50 statistic at
 * `TOLERANCE` 1.10 — ceiling **1.1000**. **PROVISIONAL**, and the three reasons are stated
 * up front rather than buried, because each of them limits what this number can be used to
 * claim (all three raised by CodeRabbit on PR #85 and none of them declined):
 *
 *   1. THIS IS NOT A RUNNER-CLASS CALIBRATION. Every sample is an attempt of ONE workflow
 *      run on ONE `ubuntu-24.04` image, inside a few hours. `R0` is applied to every future
 *      job on whatever the fleet allocates, so it is being used beyond the population it was
 *      measured on. The only other evidence is the four diagnostic runs of 2026-08-03/05,
 *      whose median is 1.0063 against this cohort's 1.0065 — but their own provenance was
 *      never captured (no run or job ids; see the PROVENANCE note below), so whether they are
 *      four separate runs or four attempts of one is UNKNOWN. If the latter, they carry the
 *      same defect as these 17 and are not an independent occasion at all. Do not lean on
 *      them as cross-workflow evidence; they are a second reading, of unknown structure,
 *      taken within days on the same image.
 *   2. THE FLAKE-RATE FIGURES BELOW ARE MODEL OUTPUTS, NOT MEASURED RATES. The Student-t
 *      predictive tail assumes i.i.d. normal sampling and is centred on a MEAN; `R0` is a
 *      floored MEDIAN, and this same record documents temporal clustering and left skew
 *      (g1 = -1.36). Read "1 in 690" and "12-24 a year" as illustrative arithmetic under
 *      assumptions this cohort violates. They are NOT part of the acceptance rationale.
 *   3. THE ESCALATION RULE WAS SELECTED IN-SAMPLE. Drafts 1 and 2 were rejected because they
 *      failed against THESE 17 samples, and draft 3's 3.61/2.37 are then reported as passing
 *      on the same 17. That is fitting, not validation. Draft 3's first out-of-sample test is
 *      the next re-record.
 *
 * WHY THIS SHIPS ANYWAY, argued from what survives the three limits rather than from what
 * was left over after deleting the model. An earlier version of this paragraph gave three
 * reasons and two of them did not hold: it cited the two cohorts' sd agreement to 0.02
 * percentage points, which this same block calls coincidence further down; and it cited the
 * ceiling sitting "3.61 sample-sds above the median with nothing near it", which is a TAIL
 * claim from a sigma estimate — precisely what limit 2 says this cohort cannot support.
 *
 * The argument that does not need the cohort to be anything it isn't:
 *
 *   - **`perf` is ADVISORY.** Branch protection requires `verify` and `codex-freshness` only
 *     as configured at the time of writing,
 *     so a baseline that is wrong in either direction costs a red non-blocking job and a
 *     human look. This is the whole of the risk case, and it does not depend on the sample
 *     being representative, i.i.d., or normally distributed. (It DOES depend on repository
 *     config this repo cannot see or assert: if `perf` is ever added to the required checks,
 *     this argument voids silently. Anyone making that change must re-read this block first.)
 *   - **A purely descriptive margin**, with no distributional assumption anywhere in it: the
 *     largest `R` ever observed under this statistic, across BOTH readings on record, is
 *     **1.0493** (from the four diagnostic runs; this cohort's own max is 1.0362), against a
 *     ceiling of **1.1000** — a **4.8%** gap in the raw measurement. An earlier version of
 *     this bullet quoted 1.0362 / 6.2%, which silently dropped the four-run cohort while the
 *     bullet below cites that same cohort's median. Do not take the max from one cohort and
 *     the centre from two. It says nothing about the tail and is not a flake-rate estimate.
 *   - **The central value reproduces on a second cohort**: medians 1.0063 (2026-08-03/05) and
 *     1.0065 (this one). Only the MEDIANS are offered here — the sd pair is dropped for the
 *     reason given above. And see limit 1 for how little separation those two cohorts have.
 *
 * That is enough to enforce a gate that currently enforces nothing. It is not enough to call
 * the gate calibrated, and nothing above should be read as a probability.
 *
 * HOW THE PROVISIONAL STATUS GETS DISCHARGED. A first draft of this plan said "re-record from
 * >= 30 gated runs spanning >= 10 workflow runs and at least two runner images", which is
 * INCOHERENT with the escalation rule shipped in this same block and is recorded here so it is
 * not proposed again. That rule requires ONE head and ONE image, because pooling across heads
 * mixes workload drift into `sd(R)` — this file's own history is the argument (P9 changed the
 * workload and forced a re-record; the S6 failure was the DENOMINATOR moving 23%) — and a
 * dispersion estimate inflated by workload drift LOOSENS branch (a). A cohort that violates
 * the rule's precondition cannot be judged by the rule's thresholds, and would bias the result
 * permissive.
 *
 * Dispersion and fleet-representativeness are different measurements and need different
 * cohorts. So:
 *
 *   - FOR DISPERSION, keep the rule as written: one head, one image, >= 10 samples. That is
 *     what draft 3's thresholds are for, and its first OUT-of-sample application is the next
 *     time this is run — the current 3.61/2.37 are in-sample.
 *   - FOR FLEET REPRESENTATIVENESS, do not pool images into one cohort. The standing rule
 *     above already requires a re-record when the runner class changes, which yields one
 *     baseline PER image. Agreement BETWEEN those per-image baselines is the fleet evidence,
 *     and disagreement is the finding. That is a comparison across cohorts, never a merge of
 *     them. ONE HONEST WEAKNESS: two per-image baselines are necessarily separated in time and
 *     a workload change can force a re-record in between, so a disagreement is confounded by
 *     workload drift and cannot be attributed to the image alone. The dispersion leg refuses
 *     pooling precisely to keep workload drift out; this leg cannot fully do the same. Read a
 *     disagreement as "something changed", then find out what.
 *   - Production supplies the raw material for the first of these but not the second: every
 *     completed run prints its `R` in `PERF-REPORT`, so `R` values accumulate on their own —
 *     though not from runs that throw before reporting (see `run.ts`'s header for the five
 *     paths that emit no report line, which are exactly the anomalous runs a cohort would
 *     want). A SECOND IMAGE, by contrast, arrives only when GitHub bumps `ubuntu-latest`, on
 *     their schedule and not this project's — and when it does, the standing rule fires and
 *     the new image gets its own baseline rather than joining this one.
 *
 * WHAT ACTUALLY RETIRES THE WORD "PROVISIONAL", since a plan without a completion criterion
 * is a wish. Take the three limits one at a time: limit 3 (in-sample rule selection) clears
 * the first time the rule is applied to a cohort that did not select it, i.e. the next
 * re-record — concretely, an out-of-sample application on >= 10 FRESH attempts of the SAME
 * documented image (`ubuntu-24.04`, run 31041932972's successor). Limit 1 (not a
 * runner-class calibration) clears when a SECOND image has its own baseline under the same
 * rule and their MEDIANS agree to within |median_A - median_B| <= 0.02
 * (~1 sigma at the spread measured here). Compare MEDIANS, not the committed `R0` values:
 * `R0` is floored to a hundredth, so two baselines would both read 1.00 across a band far
 * wider than any difference worth detecting, and comparing them would pass by construction.
 * A larger disagreement does NOT clear limit 1 — it is a real finding about the fleet AND a
 * delay, and an earlier draft calling it "a finding, not a delay" had it wrong.
 * Limit 2 NEVER clears: the flake figures are model outputs at any sample size, so it is a
 * permanent statement about how to read them rather than a condition to discharge. So:
 * provisional retires on limits 1 and 3 together, and a re-record alone is not sufficient —
 * a re-record under the one-head/one-image rule reproduces limit 1 exactly.
 *
 * M2-S11 FINDING (2026-08-09, P8): the milestone's own re-record packet attempted exactly
 * this — declare the statistic and cohort per the criterion above, then take >= 10 fresh
 * attempts. It discovered, before taking a single sample, that the machine available to
 * that packet was a local development machine, not the documented `ubuntu-24.04` GitHub
 * Actions image, and declined to record: per THE TWO CONSEQUENCES / §626-633 above, a local
 * run is not merely "a different image" but is not even self-consistent across sessions (a
 * 32-run local series spanned 56% on one machine), so a local cohort cannot be evidence for
 * either the point-estimate or the chi-square-bound dispersion test above and would not
 * validly clear limit 3. Recorded as a finding, not a re-record: LIMIT 3 STAYS OPEN. Neither
 * `R0`, `TOLERANCE`, nor the ceiling moved. The re-record is deferred to the next opportunity
 * that actually satisfies "one head, one image" against the documented image — see the
 * OWNER AND TRIGGER paragraph immediately below.
 *
 * OWNER AND TRIGGER, filled in at M2-S11 (both were previously unstated — see "THIS PLAN HAS
 * NO OWNER OR DATE" immediately below, which this paragraph answers rather than deletes).
 * Owner: Rob. Limit 3's trigger: the next opportunity to take >= 10 fresh attempts of the
 * SAME documented image (`ubuntu-24.04`) in CI — concretely, this repo's own PR CI runs are
 * the first such opportunity going forward (mirroring run 31041932972's attempt-based
 * provenance), since a local machine is disqualified for the reason recorded in the M2-S11
 * FINDING above. Limit 1's trigger is UNCHANGED: a SECOND runner image getting its own
 * baseline under the same rule, with medians agreeing within 0.02 — which arrives on
 * GitHub's schedule (the next `ubuntu-latest` image bump), not this project's.
 *
 * Until either limit clears, this number is a working baseline, and the "re-record when the
 * runner class changes" rule — stated in the SUPERSEDED provenance block above and still
 * live in `docs/design-notes/performance-spike.md` — is the binding one. The original
 * record's own complaint — "THIS PLAN HAS NO OWNER OR DATE, which is a real weakness: the
 * data lives in CI logs under a 90-day retention with no artifact upload, and nothing
 * triggers the re-record automatically" — is preserved here as the superseded text it now
 * is (M2-S11 answered it; owner and both triggers are named above). Treat the next
 * runner image bump as limit 1's trigger, and the next >= 10-fresh-attempt CI opportunity on
 * the documented image as limit 3's — both now named above rather than left as a gap. The
 * superseded 1.42 baselined p95/p50 and was meaningless for the new statistic; the `null`
 * window between the statistic change and this record is closed.
 *
 * PROVENANCE, in the form the four diagnostic runs above could not supply: GitHub Actions
 * run **31041932972**, **attempts 1-17**, head **a1600c9**, runner image **ubuntu-24.04**
 * (resolved from `ubuntu-latest`, read out of each job's own setup log). All 17 R values,
 * sorted:
 *
 *   0.9371 0.9525 0.9842 0.9925 1.0017 1.0029 1.0029 1.0039 1.0065
 *   1.0094 1.0135 1.0149 1.0151 1.0168 1.0265 1.0355 1.0362
 *
 * PER-ARM OPERANDS, in attempt order, so every derived figure below is checkable — the
 * cancellation numbers in particular need `controlStat`, and publishing only `R` would
 * repeat the provenance failure this same doc records against the four diagnostic runs
 * (attempts 1-5 are the cohort on which the escalation rule fired). Each cell is the
 * reported 4 dp value and `R` was computed from unrounded milliseconds, so recomputing
 * `stress / control` from the printed operands differs by up to 2e-4 — within the 3.9e-4
 * that rounding two operands permits, and not an inconsistency:
 *
 *   | att | control p50 | stress p50 |   R    |
 *   | --- | ----------- | ---------- | ------ |
 *   |  1  |   0.3855    |   0.3992    |  1.0355  |
 *   |  2  |   0.3642    |   0.3413    |  0.9371  |
 *   |  3  |   0.3855    |   0.3862    |  1.0017  |
 *   |  4  |   0.4025    |   0.4085    |  1.0151  |
 *   |  5  |   0.3970    |   0.4007    |  1.0094  |
 *   |  6  |   0.3928    |   0.3943    |  1.0039  |
 *   |  7  |   0.4041    |   0.4053    |  1.0029  |
 *   |  8  |   0.3963    |   0.4016    |  1.0135  |
 *   |  9  |   0.4177    |   0.4204    |  1.0065  |
 *   | 10  |   0.3775    |   0.3875    |  1.0265  |
 *   | 11  |   0.3966    |   0.4110    |  1.0362  |
 *   | 12  |   0.3983    |   0.3953    |  0.9925  |
 *   | 13  |   0.4016    |   0.3826    |  0.9525  |
 *   | 14  |   0.2990    |   0.3035    |  1.0149  |
 *   | 15  |   0.3852    |   0.3863    |  1.0029  |
 *   | 16  |   0.3758    |   0.3821    |  1.0168  |
 *   | 17  |   0.2556    |   0.2516    |  0.9842  |
 *
 * Median **1.0065**, rounded DOWN to the nearer hundredth per the procedure = **1.00**.
 * Rounding down is the conservative direction: it lowers the ceiling, so the recorded
 * baseline can only make the gate stricter than the measurement requires.
 *
 * SEVENTEEN SAMPLES, NOT THE FIVE THE PROCEDURE ASKED FOR. At n = 5 the span was 1.1050
 * against a `TOLERANCE` of 1.10, so the pre-committed escalation rule fired. It was
 * escalated to the owner rather than reinterpreted — that part was right — and the owner
 * authorised collecting more. Stating the rest carefully, because the convenient story is
 * available and wrong:
 *
 *   - the rule specified a FIXED COHORT of exactly five (see the superseded record above).
 *     At its own n it is a coarse screen with roughly a 7% false-alarm rate against this
 *     noise level — crude, but not ill-formed. Extending the cohort is what introduced the
 *     n-dependence, and that extension was an authorised deviation from the protocol, not a
 *     discovery about the rule.
 *   - the n-dependence is real and matters for the REPLACEMENT: span is a range statistic,
 *     and expected range grows with sample count, so any fixed span threshold gets easier
 *     to trip the more evidence is gathered. Simulated at this noise level, P(span > 1.10)
 *     is 4.5% at n = 4, 6.8% at n = 5, 21% at n = 10 and 42% at n = 17. A rule to be applied
 *     at a chosen n must not be a bare span threshold.
 *   - the threshold is also COUPLED to `TOLERANCE`, which this same change tightened
 *     1.25 -> 1.10. At 1.25 neither this cohort (1.1058) nor S5b's (1.2021) would have
 *     fired. So the firing owes at least as much to the tightening as to the sample count,
 *     and the replacement below inherits that coupling — tighten `TOLERANCE` again and the
 *     escalation trigger silently tightens with it.
 *   - the same n-dependence applies to the "half-spread" figures throughout this file.
 *     They are comparable only BETWEEN COHORTS OF EQUAL SIZE. `stressStat`'s table is a
 *     valid comparison (four rows, all n = 4); comparing its 2.8% against this cohort's
 *     range-based 4.92% is not, and doing exactly that produced a false alarm.
 *
 * A SECOND COHORT IS CONSISTENT WITH THIS BASELINE, by a direct comparison rather than the
 * range conversion below: the four diagnostic runs' own SAMPLE SD is **2.55%** of their
 * median against these seventeen runs' **2.57%**, with no range statistic involved at all;
 * and the two cohorts' medians are **1.0063** and **1.0065**.
 *
 * DO NOT OVER-READ THAT. The diagnostic runs are from 2026-08-03/05 — DAYS apart on the same
 * image, triggered by the same failure that caused this amendment — so there is no
 * months-apart corroboration on record. And the n = 4 sd carries a 95% CI of 1.45%-9.51%, so
 * agreement to 0.02 percentage points is coincidence, not confirmation. What the two cohorts
 * support is "consistent with the same centre and spread, from a second sample of the same
 * runner population over a few days" — worth having, not decisive.
 *
 * The range conversion is kept because it explains the n = 5 excursion rather than
 * establishing the baseline (`E[range] = d2(n) * sigma`; d2 = 2.059 / 2.326 / 3.588):
 *
 *   | cohort | range-based half-spread | implied sigma |
 *   | ------ | ----------------------- | ------------- |
 *   | n = 4  | 2.758%                  | 2.68%         |
 *   | n = 5  | 4.874%                  | 4.19%         |
 *   | n = 17 | 4.923%                  | 2.74%         |
 *
 * (The n = 4 row is computed from the UNROUNDED 2.758%, not the 2.8% published in
 * `stressStat`'s table; feeding the rounded figure in gives 2.72% and violates this file's
 * own rule about deriving from unrounded inputs.) Direct sample sd over the 17 is **2.58%**
 * of the mean, 95% CI **1.92%-3.93%**. The n = 5 excursion was an early-arriving extreme:
 * those five captured 99.3% of the eventual 17-run range.
 *
 * HEADROOM. Two things that are easy to get wrong, and were:
 *
 *   - the margin is measured from the DISTRIBUTION'S CENTRE, not from `R0`. `R0` is the
 *     median FLOORED to a hundredth, deliberately below centre, so "a 10% margin" claims
 *     the conservatism and spends it. Real margin: **3.61 sigma** from the median (3.75
 *     from the mean), not the 3.86 that floor produces.
 *   - sigma is ESTIMATED from 17 points, not known, so the tail is Student-t, not normal.
 *     Predictive tail for a new run: t = 3.51 on 16 df, **P ~ 1 in 690** (1 in 910 centred
 *     on the mean).
 *
 * Get BOTH of those wrong together and the answer is 1 in 18,000. Decomposed as
 * probabilities, which is what a failure RATE is: floored-margin-and-normal 5.6e-5 ->
 * centred-and-normal 1.5e-4 (the centring, x2.7) -> centred-and-t 1.4e-3 (the t, x9.6). The
 * t step is 93% of the increase; the centring is the remaining 7%.
 *
 * THE PESSIMISTIC BRANCH, quantified rather than gestured at. At the sigma CI's upper bound
 * (3.93%) the margin is **2.37 sigma**, which is **1 in 114** normal and **1 in 58** under
 * the same t treatment insisted on above — use t on the pessimistic branch too, not just
 * the optimistic one, and do not round a downside toward comfort. So, at 700-1,400 gated runs a year and using the t figure on BOTH branches: **1-2 failures
 * a year** if sigma is near the point estimate, and **12-24 a year — monthly to twice
 * monthly** if it is near the upper bound. ("Every other month" would be the answer from the
 * normal 1-in-114 at the low end of the run rate; both substitutions flatter.) ILLUSTRATIVE ONLY — see
 * limit 2 at the top of this block: both figures assume i.i.d. normal sampling around a mean,
 * and this cohort is clustered, skewed, and summarised by a floored median. They bound the
 * arithmetic, not the gate. The acceptance rationale is the "WHY THIS SHIPS ANYWAY"
 * paragraph at the top of this block, which does not use them; what carries the risk is that `perf`
 * is not a required check, so being wrong costs a red advisory job.
 *
 * Two more caveats that do not resolve: these 17 are attempts of ONE workflow run, clustered
 * in time, not an i.i.d. draw from the population the gate faces over months; and the cohort
 * is left-skewed (g1 = -1.36, max z = +1.28), which thins the upper tail in our favour, but
 * n = 17 cannot establish tail shape and the chi-square sigma bound above assumes the
 * normality the skew questions.
 *
 * WHAT THE 17 RUNS SHOW ABOUT CANCELLATION, scoped honestly. Raw control p50 spanned 63%
 * across the cohort while `R` spanned 10.6% — but that 63% rests on TWO fast runners; drop
 * them and the remaining fifteen span 14.7%. The direct test, `corr(R, control p50)`, is
 * **+0.14** (n = 17, not significant): consistent with cancellation, and badly underpowered.
 * Note also that `R = stress / control` cancels any MULTIPLICATIVE machine factor by
 * construction, so this measurement can only ever fail to show cancellation if the machine
 * effect is non-multiplicative. Read it as "no residual speed dependence detected", not as
 * a demonstration. (On "0 of 17 samples exceed the ceiling": the ceiling was fitted to these
 * points, so in-sample agreement is expected and says little about the next run. It is weak
 * evidence, not none — a sample above 1.1000 would have exceeded it, as one did in the
 * 2.49 era.)
 *
 * THE REPLACEMENT RULE, third draft. The two earlier drafts are recorded because each failed
 * against this cohort's own data, which is the test any such rule has to survive:
 *
 *   - draft 1: "escalate if `TOLERANCE - 1` is under 3 sigma". Wrong quantity. `R0` is
 *     FLOORED, so up to 0.01 of margin is discarded before the gate exists (0.25 sigma here),
 *     and that phrasing reports 3.86 where the truth is 3.61.
 *   - draft 2 fixed the quantity but tested it against the 97.5% two-sided UPPER BOUND on sigma. Applied
 *     to this very cohort that gives **2.37** and demands escalation — the rule failed the
 *     baseline it was written to bless, and the draft did not notice. It is also
 *     unsatisfiable in practice: clearing 3 sigma on the upper bound at this noise needs
 *     sigma_hi/sigma_hat <= 1.20, i.e. n around 68 (~49 one-sided). A rule whose own stated
 *     floor of ">= 10 samples" can never satisfy it is not a rule.
 *
 * What ships:
 *
 *     take >= 10 samples, all on one head and one runner image;
 *     compute BOTH, and escalate if EITHER fails:
 *         (a) (R0 * TOLERANCE - median(R)) / sd(R)        >= 3
 *         (b) the same margin against the 97.5% two-sided chi-square upper bound on
 *             sigma                                        >= 2      -- and publish it.
 *
 * At this record: (a) **3.61**, (b) **2.37**. Both pass — IN-SAMPLE, on the 17 samples that
 * rejected drafts 1 and 2. That is not validation of the rule (limit 3 at the top); it is the
 * arithmetic of the rule on the data that produced it.
 *
 * WHICH BRANCH ACTUALLY BINDS — (b), for every n below 18, so it is a test and not a
 * formality. It implies a point margin of 2 * sigma_hi/
 * sigma_hat, which is 3.65 at the rule's own floor of n = 10 and 3.04 at n = 17 — so the
 * operative threshold there is not the advertised 3. They cross at n = 18. Both are tests;
 * neither is decoration.
 *
 * Naming the quantile matters: sigma_hi/sigma_hat is 1.826 at n = 10 on the 97.5%
 * TWO-SIDED bound (which is what the 3.65 above uses) and 1.645 on a literal one-sided 95%
 * bound. A rule that does not say which it means is two rules.
 *
 * WHAT THIS RULE STILL DOES NOT DO, recorded so it is not mistaken for covered. It measures
 * within-session variance on ONE image, so it is blind to image-bump and fleet drift — which
 * this file's own history names as the dominant risk. It constrains dispersion only, so
 * nothing in it stops the median creeping upward with the ceiling following on each
 * re-record. It fixes a flake rate without fixing detection power: at this sigma and margin
 * the gate has 50% power against a **9.3%** p50 regression and needs **13.6%** for 95% power
 * — quote the second when asking what this gate can actually catch. And branch (b) is
 * CURABLE BY COLLECTING MORE SAMPLES: sigma_hi/sigma_hat shrinks with n, so a cohort failing
 * it at n = 10 can be brought into compliance by adding attempts with no change in the
 * underlying noise. That is statistically principled where the old span rule's n-dependence
 * was not — a confidence bound SHOULD tighten with evidence — but given that this record's
 * own provenance is "the rule fired at n = 5, so we collected 17", it must be named rather
 * than discovered later. If a future
 * cohort fails either test, escalate; do not widen `TOLERANCE`, which is the failure this
 * whole change diagnosed.
 *
 * ONE THING THIS RECORD DOES NOT HIDE: the ORIGINAL span condition is still met at n = 17
 * (1.1058 > 1.10). The baseline ships anyway on the "WHY THIS SHIPS ANYWAY" argument at the
 * top of this block — advisory blast radius, a raw 4.8% margin to the largest observation, a
 * reproducing median — and with the owner informed. NOT on the sigma argument, which limit 2
 * retracts, and not because the trigger stopped firing.
 *
 * `ci.yml`'s null-`r0` alarm is now dormant by design: it fires only on a DEFAULT-BRANCH
 * run whose report carries no usable baseline. With a number committed there is nothing for
 * it to catch, which is the state it exists to restore. Note what that alarm CANNOT see: it
 * checks only that `r0` is a positive finite number, so a PROVISIONAL baseline satisfies it
 * exactly as a calibrated one would. Nothing in CI distinguishes the two — the provisional
 * status lives in this doc and nowhere else, which is why the discharge trigger above is
 * written down rather than left to memory. See `run.ts`.
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
