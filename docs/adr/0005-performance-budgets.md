# ADR 0005 — Performance budgets

- **Status:** Accepted
- **Date:** 2026-07-18
- **Amended:** 2026-07-30 (M2-S4b — the spike ran; see the Amendment below); 2026-08-03
  (M2-S5b P11 — numerator p99 → p95, `R0` 1.42); 2026-08-04 (M2-S6 — the stress scene is
  not extended for the stun story; see the Amendment below); 2026-08-05 (M2-S6 QC —
  numerator p95 → p50, `TOLERANCE` 1.10, `R0` re-recorded 1.42 → 1.00)
- **Rulings:** 2026-07-31 (all three findings answered; see Findings from the spike)

## Context

Performance debt is hard to claw back once gameplay is built on top of it. The
binding constraint is the **low-end Android webview** (the weakest target the web
core must run well on), and the core stack bet — Phaser 3 (WebGL2) inside a
webview — is not yet validated at scale.

We cannot fully benchmark without a representative simulation, so we set
**provisional guardrail budgets now** and validate/refine them with an **early
spike** (the "provisional budgets now + spike early" decision).

## Decision

### Provisional budgets (to be validated/refined by the spike)

- **Frame rate:** 60 fps on mid-range devices; **≥ 30 fps floor** on a low-end
  Android webview under worst-case load.
- **Render/sim decoupling (precise claim):** the sim advances **only in whole fixed
  20 Hz ticks** (`packages/engine` fixed-timestep loop), so a given tick's result is
  identical regardless of frame rate, and **replay / server re-sim — driven by the
  input log, not wall-clock — is fully frame-rate-independent.** During _live_ play,
  a stall longer than the loop's spiral-of-death clamp (`msPerTick × maxCatchUpTicks`,
  default **250 ms**) discards unconsumed real-time: bounded catch-up, i.e. the game
  effectively skips real time, **not** divergent state.
- **Worst-case load — a defined, seeded scenario (not just a count):** sustain
  **~300 concurrent creeps + ~150 towers** at the fps floor, **under an active
  behaviour mix** — creeps pathfinding along a near-maze-length route, towers
  acquiring targets and firing, and the resulting scheduled damage events / status
  effects live. The stress scene is a **fixed seed + scripted scenario** reused by
  both the spike and CI, so budgets can't pass against an unrealistically idle
  450-entity scene. Projectiles are render-only/cosmetic (per the combat model), so
  they load the renderer, not the sim.
- **Sim step time:** a full `step()` at the worst-case scenario **< 2 ms** on
  mid-range and **< 5 ms** on low-end — comfortably inside the 50 ms tick, leaving
  headroom for 2×/4× speed and for server-side re-sim throughput.
- **Initial load:** the **gzipped JS (+ wasm) delivered before first interaction**,
  **excluding lazy-loaded assets and the service worker's precached payload**,
  is **< 3 MB** (Phaser is ≈ 1 MB of that _uncompressed_ —
  M2-S4b measured the whole initial chunk at 0.36 MB gzipped). To be enforced by a size-budget check
  in CI (e.g. `size-limit`) against the named initial entry chunk(s); assets
  lazy-loaded; PWA-cached for instant repeat loads.
- **Memory:** stay under **~256 MB** JS heap on low-end.
- **Input latency:** tap/click-to-response **< 100 ms**.

**Measurement methodology (exact parameters fixed by the spike):** runtime budgets
(frame rate, `step()` time, memory, input latency) are measured on the canonical
reference device under the seeded stress scenario, after a warm-up, over a sustained
run, and reported as a **percentile** (not a lucky best frame) — e.g. the
95th-percentile frame time must clear the floor. The reference device profile,
warm-up, run duration, sampling rule, and thermal/power state are pinned by the
spike and recorded with it, so spike and CI results are comparable.

### Validation

An **early spike** runs the seeded stress scenario on a real low-end Android device
(through the webview) plus Chrome low-end emulation, and fixes the reference device.

> **Correction (2026-07-30, M2-S4b) — applies to the two sentences above and the two
> below, and to nothing else in this section.** The spike ran under Chrome emulation
> only: the real-device pass moved to S11, and the pinned emulation profiles are the
> reference _provisionally_ until it runs (Amendment (b) and (c)). Both gates named
> below are now wired: the bundle-size check shipped first, as planned, and this
> amendment's story adds the sim-timing gate (`.github/workflows/ci.yml`'s `perf` job).

~~**No perf gate is wired yet** (CI runs `verify` + `build`); the **bundle-size check
is the first to add** — a `size-limit`-style gate wired as soon as `apps/web`
produces a meaningful production build — followed by frame/sim timing once the
scripted scenario exists.~~

**If the stack cannot hit these numbers, that is an early signal to revisit the Phaser
bet** — cheap to act on now, catastrophic to discover after the game is built. _(Still
normative, and now load-bearing: see the Amendment's Finding 1.)_

## Amendment — 2026-07-30 (M2 Story 4b, when the spike actually ran)

The spike above is now built and recorded:
[`docs/design-notes/performance-spike.md`](../design-notes/performance-spike.md) carries the
pinned parameters and every measured number. Four things changed against what this ADR
assumed, and three findings came back. (b) is the substantive scope
change; (c) and (d) follow from it.

**(a) The scenario runs on a purpose-built synthetic 40×40 board, not the shipped one.** The
worst case this ADR names is arithmetically impossible on `field-01`: 28×24 with a blocked
border ring leaves **572** buildable interior cells, and 150 towers at a 2×2 footprint need
**600**. The specced 10-wave arc — authored at S11, not shipped today — also only ever spawns
117 creeps against "~300 concurrent".
Accepted cost: the numbers are a **ceiling**, not a description of real M2 play, and the spike
document says so at the top.

**(b) The real low-end Android device pass moves to S11**, where it joins the catalog-scale
stress gate. S4 measures under Chrome emulation only, which keeps the story unblocked by
hardware.

**(c) Until that pass runs, the pinned emulation profiles ARE the reference device** this ADR
says the spike fixes. Both profiles are recorded in full in the spike document; the
throttle, viewport, device scale factor and touch flag are pinned as committed data in
`apps/web/e2e-perf/profiles.ts`, while the Chrome version and the WebGL renderer are
captured per run by `stress.perf.spec.ts` (they are properties of the machine, not of the
profile, so pinning them as data would be a lie the next run would tell). The renderer string is part of the profile on purpose:
Playwright's Chromium silently falls back to a SwiftShader software rasterizer where no GPU is
available, and an fps figure whose renderer is unrecorded cannot be interpreted at all.

**(d) What emulation-only leaves unvalidated**, explicitly, because these are exactly where a
low-end webview actually fails: **thermal throttling** (every number is from a 10-second window
on a machine that never got warm), **real GPU fill-rate** (a Metal-backed workstation GPU is not
a low-end Adreno/Mali), **webview-specific compositing** (this ADR's binding constraint is the
webview, and nothing measured here exercises one), and **`step()` under real device CPU** (the
headless harness is unthrottled by design — it is a regression gate, not a device measurement).
One further gap against this ADR's own Measurement-methodology clause, which asks for
**thermal/power state** to be pinned and recorded alongside the other parameters: no thermal
or power state is pinned by this pass. Every figure is a 10-second window on a mains-powered
workstation that never got warm, which is precisely why thermal throttling heads the list above.

### Escalation trigger

Pinned **before** measurement and evaluated per metric. This ADR carries budgets in **both**
directions, so a single "within 25%" rule would be directionally meaningless and would miss a
result 50% over an upper budget:

| Budget kind                                                        | Triggers when             |
| ------------------------------------------------------------------ | ------------------------- |
| **Upper bound** — `step()` ms, JS heap, input latency, bundle size | `measured ≥ 0.75 × limit` |
| **Lower bound** — fps floor, fps target                            | `measured ≤ 1.25 × floor` |

Both forms are satisfied _a fortiori_ by an outright violation, so a breach can never slip
through the margin logic. On trigger, the measuring story raises it as a **blocking
recommendation to the owner**, who takes one of two branches: the real-device pass runs **at
S11 at the latest**, or an explicit dated acceptance is recorded here. The scope call stays
🔴 Owner rather than being auto-decided by a threshold.

**Status of that recommendation: the S11 branch is taken (owner ruling, 2026-07-31).** The fps
trigger fired (Finding 1 below); the owner's answer is the real-device pass at S11, **not** an
acceptance of the numbers. One addition to the rule as written: the owner also directs that the
_diagnosis_ — establishing where the frame time actually goes — happen **before** S11 rather than
at it, since five more effect stories land on this renderer in between and the spike deliberately
measured without diagnosing. The deadline
reads "at S11 at the latest" rather than the drafting note's "before the next effect story"
because (b) already moved the pass to S11; a rule demanding it before S5 would have been
unsatisfiable the moment it was written.

One defect in the rule itself, recorded rather than silently worked around: the **mid-range fps
trigger is degenerate**. `1.25 × 60 = 75` fps, and `requestAnimationFrame` on a vsync-capped
display cannot exceed ~60, so that metric triggers unconditionally and its margin carries no
information beyond the outright breach. The low-end trigger (≤ 37.5 against a 30 floor) is
well-formed.

**Owner ruling, 2026-07-31: fix it, as a separate deliberate edit.** Not folded into S4b — the
same reasoning that kept it unfixed here applies to fixing it in the same breath as reporting the
results it fired on. The replacement must be a well-formed trigger for a vsync-capped metric
(e.g. margin against the 16.7 ms frame-time budget rather than against an unreachable 75 fps).
Until that lands, read the mid-range fps row as carrying no information beyond the outright
breach.

It was **deliberately not fixed here**. The trigger was pinned before any measurement, and
re-cutting a threshold after seeing the results it fired on is exactly what this amendment
and the spike forbid everywhere else. Recorded now, changed by a later story that pins its
replacement before measuring again.

**Replacement mid-range trigger, pinned 2026-08-03 (M2-S5b), before the browser run that
measures against it.** Two independent signals replace the degenerate fps trigger:

| Signal                                                                                                                    | Fires when    |
| ------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **Missed-refresh proportion** — share of sampled frames exceeding **1.5 × the nominal refresh interval** (25 ms at 60 Hz) | **> 2%**      |
| **Outright breach** — p95 frame time                                                                                      | **> 16.7 ms** |

Both figures in that table are the **mid-range** ones, this being the mid-range trigger. See
Scope below for what carries over to low-end and what does not.

**They are independent, not ordered.** 6% of frames at 20 ms breaches `p95 > 16.7` while
producing no frames above 25 ms, so neither implies the other. Either firing is a trigger.

**Scope, stated because the first implementation got it wrong.** The missed-refresh signal
is the **mid-range** trigger and has no low-end definition — the low-end 30 fps floor is a
separate budget this replacement never touched. Applying the 60 Hz-derived ~25 ms cutoff to
low-end reproduces the exact degeneracy being replaced: a low-end run _meeting_ its 30 fps
floor produces ~33.3 ms frames, every one of which clears 25 ms, so the signal fires on a
passing run. `stress.perf.spec.ts` reports it as **not applicable** on low-end, distinctly
from **not evaluated** (cadence out of band). The outright-breach signal _does_ apply to
both profiles, each against its own budget: `> 16.7 ms` on mid-range, and `> 1000/30 ms` on
low-end — expressed exactly, because 30 fps is 33.333… ms and a constant rounded _down_ to
33.3 puts the boundary inside the passing region under the strict `>`.

**Why 1.5× the interval and not the budget itself:** a healthy 60 Hz interval is ~16.667 ms
and ordinary scheduling jitter crosses 16.7 constantly, so counting frames above the budget
measures noise. 1.5× is the midpoint to the next refresh, so a frame above it genuinely
missed one.

**The 2% is a judgement, pinned before measuring — not derived.** Its basis: at 60 Hz over a
~10 s window, 2% is on the order of a dozen missed refreshes — few enough that a user would
not call it stuttering, many enough that it is not one unlucky GC pause.

**The generic `measured ≥ 0.75 × limit` margin rule (this ADR's own escalation trigger,
above) cannot be reused here.** Frame time under vsync is quantized, so a healthy profile
sits _at_ the budget and a 0.75 margin fires unconditionally — the same degeneracy this
replaces.

**It is normalized, not machine-independent.** A fixed 25 ms cutoff only separates the
16.7/33.3 ms buckets on a 60 Hz display; at 90 or 120 Hz it means something else entirely,
and the emulation profiles (`apps/web/e2e-perf/profiles.ts`) do not currently validate
refresh rate. This trigger is read against a 60 Hz assumption, not a measured one — the
calibration below only confirms the assumption holds; it does not generalize the trigger to
other refresh rates.

**Cadence calibration — every parameter pinned here, before measuring.**

| Parameter        | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordering         | calibrated **before** `Emulation.setCPUThrottlingRate` is called (`apps/web/e2e-perf/stress.perf.spec.ts`), at CDP's default (unthrottled) rate                                                                                                                                                                                                                                                                                                                             |
| Estimator        | **median** rAF delta, discarding the **first 5** frames (startup transient)                                                                                                                                                                                                                                                                                                                                                                                                 |
| Page             | a **blank page** (`about:blank`), navigated and sampled **before** the perf page is ever loaded                                                                                                                                                                                                                                                                                                                                                                             |
| Window           | **2.0 s** of idle rAF sampling                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Acceptable band  | median in **[15.0, 18.5] ms** → nominal 60 Hz, cutoff = **1.5 × measured median**                                                                                                                                                                                                                                                                                                                                                                                           |
| Outside the band | the run reports `cadenceCalibration: "out-of-band"` with the measured median, and the missed-refresh signal is reported as **NOT EVALUATED** — never silently applied with a 60 Hz constant. The p95 breach signal is unaffected and still applies. Calibration is only consulted **for this signal's status** on the profile the signal applies to (see Scope above) — it is still performed and reported on both: on low-end it reports **NOT APPLICABLE** at any cadence |

**Calibrated on an idle, unthrottled page — never from the stressed frame deltas.** A profile
that is missing refreshes _because the app is slow_ would, calibrated from its own stressed
deltas, be read as a display with a slow native cadence; the cutoff would scale up with the
regression, and the regression would normalize itself away — worst on the low-end profile,
which is exactly where it matters. CDP CPU throttling slows JS execution, not the
compositor's vsync cadence, so an unthrottled calibration measures the same nominal refresh
the throttled run is judged against.

`about:blank`, not `apps/web/perf/index.html` at rate 1: that page loads `main-perf.ts` as a
module, which builds the scene and fast-forwards on import — there is no pre-scene seam on
it, and adding one would put a test-only branch in the measured path.

The browser spec emits, per profile, into its machine-readable report: the cutoff actually
used, the observed rAF cadence (the calibrated median), the long-frame count, the
denominator (frames sampled), the proportion, `cadenceCalibration`, and
`missedRefreshStatus` — so the trigger is reproducible from the artifact rather than
recomputed by hand. `missedRefreshStatus` is the one that says _why_ a signal stood down:
`not-applicable-for-profile` (low-end, per Scope above) reads differently from
`not-evaluated` (cadence out of band), and collapsing them would leave a reader unable to
tell a budget that does not exist from one that could not be measured.

### Findings from the spike — all three ruled on 2026-07-31

1. **Frame time is over budget on both profiles, and the sim is not why.** Measured **95th-percentile
   frame time** — the statistic the Measurement methodology section above names: **66.8 ms**
   low-end (budget 33.3 ms, the 30 fps floor) and **25.6 ms** mid-range (budget 16.7 ms, the
   60 fps target). Both trigger the rule above; both are outright breaches, 2.0× and 1.5× over.
   (These supersede a first pass that read 100.4 / 34.2 ms and sampled frames after the
   input-latency clicks; see the spike's results table for the correction. Note mid-range's
   **median** frame is now 16.8 ms — on target — so the breach there is a p95 tail at 39 fps,
   not a uniformly slow profile.)
   `step()` costs 0.2–0.32 ms per **50 ms tick** — and the low-end profile advanced 205 sim
   ticks during its 10-second window against ~200 expected at 20 Hz, holding cadence to within a
   few ticks of real time while frames took 92 ms — so the
   cost sits in the presentation layer, not the deterministic core. The emulation flatters rather than penalizes — a 6× CPU
   throttle on an Apple M4 Pro is far faster than a low-end Android webview — so a real device
   should be expected to do worse. This is the "early signal to revisit the Phaser bet" the
   Validation section above names. S4b deliberately measures without diagnosing or optimizing;
   the first question for whoever picks it up is where the frame time actually goes.
2. **The scripted route is 329 cells against a committed floor of 600 — RESOLVED by ruling,
   2026-07-31: the floor is re-pinned to the measured 329.** The 600 could not be met at this
   ADR's own ~150-tower figure: a 2×2 tower buys ≈ 2.2 cells of route, so 150 towers cap near 330
   on _any_ board size (measured over band-only layouts under a ≤ 150-tower budget: 40×40 → 307,
   50×50 → 298, 60×60 → 308, 80×80 → 329; the committed 40×40 layout reaches 329 with six
   additional tail baffles). On the 40×40 board, 600 is unreachable at **any** tower count —
   twelve bands is all that fits, capping at 459 — so reaching it needs both a larger board and
   roughly 270 towers, which would make the scene less like real play rather than more. S4b
   escalated rather than lowered to fit, as PLAN step 18 requires; the escalation is now
   answered. The oracle carries **one** un-waivable assertion at 329 with zero slack (the sim is
   deterministic, so an unchanged maze reproduces it exactly), the waived twin is gone, and
   `KNOWN_OPEN_ASSERTIONS` is **empty**.

3. **The relative CI gate is noisier than its own tolerance — ACCEPTED as-is by ruling,
   2026-07-31, with the flake rate on record.** This ADR asked for a regression
   gate that would not be hostage to runner variance, and the answer was a ratio —
   `R = p99(stress due-blast ticks) / p50(control)`, both measured in one process, so a uniformly
   slower machine moves both terms and cancels out. **The cancellation is real for scale and
   absent for tail.** A p99 numerator over a p50 denominator: the median denominator barely moves
   with tail noise by construction, and the numerator absorbs all of it. Consequences, measured:
   the baseline recorded on the authoring machine (1.69, 8 runs, sd 0.045) did not transfer and
   had to be re-recorded on the runner (2.49); the branch then produced **eight CI samples
   spanning 2.3585–3.2478 (37.7%), five of them on byte-identical code**, one of which is _above_
   the ceiling that `R0` creates. Widening the tolerance is not the fix: absorbing that sample
   needs `TOLERANCE ≥ 1.31`, and a gate that permits a 31% regression in blast cost before
   complaining is not worth running. Re-recording `R0` from all eight changes no sample's verdict.
   The ruling is to **ship as-is and live with the flake** (`perf` is not a required check, so a
   flake is noise rather than something that stops a merge), with the full record in
   `packages/perf/src/gate.ts`. The two alternatives were weighed and declined for now: a
   dedicated runner costs infrastructure for a non-required job, and switching to p99/p99 rests
   on a ±0.7% figure from **three local runs on a quiet machine that has never been measured on
   CI** — adopting it as the fix would repeat the exact reasoning that produced the untransferable
   `R0 = 1.69`. Revisit if the job flakes in practice; the honest expectation, from the only
   population measured, is roughly 1 run in 8.

   **AMENDED 2026-08-03 (M2-S5b P11) — the numerator statistic moved to p95, and `R0` was
   re-recorded.** The definition above is superseded: `R` is now
   `p95(stress due-blast ticks) / p50(control)`. Everything the original finding says about
   the ratio's structure still holds — the cancellation is still real for scale and absent
   for tail, and the denominator is still a median — but the numerator now discards the top
   ~5% of the due-blast subset rather than the top ~1%.

   **This is not ADR 0005's own "revisit if the job flakes in practice" trigger firing.** The
   job has not flaked since the 2026-07-31 ruling. The reason is different and should not be
   dressed up as that: M2-S5b P9 changed the stress workload — the scene gained a DoT arm
   (50 of the 150 tower anchors now run `stress-venom`) and an armored population (114 of the
   304 scheduled spawns, armor 6), and the AoE-producing tower population fell 150 → 100 —
   which forces an `R0` re-record regardless. That makes this the one moment the statistic can
   change without paying a second re-record. Owner ruling of 2026-08-02: this class of
   decision — a statistic swap justified by a workload rebaseline rather than by a fired
   trigger — is technical and Claude's to take. **Moving `R0` for a changed workload is a
   different act from moving it to chase noise on an unchanged one** (dated 2026-08-03): the
   2026-07-31 ruling explicitly declined to re-record `R0` from all eight same-workload
   samples because doing so changed no sample's verdict — that was chasing noise. P9 changing
   the scene is not that; the workload the old `R0 = 2.49` was measured against no longer
   exists, so re-recording here is not a reopening of the earlier ruling under a different
   name.

   **`R0` re-recorded at 1.42** — five CI samples on the post-P9 workload with the p95
   statistic (GitHub Actions run 30851346335, attempts 1–5, `ubuntu-24.04`), median
   1.427743 rounded down. Ceiling 1.7750. Full table, provenance, and the comparison against
   PR A's pre-P9 baselines are in `packages/perf/src/gate.ts`'s `R0` doc.

   **A finding from that same five-sample cohort belongs on record here, plainly: p95's
   spread is nearly DOUBLE p99's.** `(max − min) / min` over the five R(p95) values is
   **20.2%**; over the five R(p99) values, computed on the exact same five runs, it is
   **11.1%**. This finding's own diagnosis — the denominator is a median and barely moves
   with tail noise, so the numerator absorbs it — predicts a statistic that discards _more_
   tail (p95) should be _quieter_ than one that discards less (p99). **This data does not
   support that; it contradicts it.** The switch to p95 does not rest on that prediction
   holding: it rests on the pinned fixture below, which is a regression-sensitivity result,
   not a noise result. The noise-suppression half of the original rationale is not supported
   by this cohort, the cause of the 37.7%/20.2% spread remains unidentified, and five samples
   of a different (post-P9) workload on one re-run runner are not a controlled comparison
   against the historical eight-job, pre-P9 population — this neither vindicates nor condemns
   p95 on noise, it is what was measured.

   **The substance of the 2026-07-31 ruling is untouched**: `perf` stays non-required, a
   flake still does not block a merge, and nothing here claims the cause of the 37.7% spread
   has been identified. It has not. p95 was preselected because this finding's own diagnosis
   names the numerator's tail as where the noise lives — not because the cause is known, and
   the paragraph above is exactly why that diagnosis is not itself confirmed.

   The declined alternative "switching to p99/p99" above is likewise superseded rather than
   revived: the change adopted is p95 on the numerator, on the strength of a pinned
   injected-regression fixture (`packages/perf/src/gate-fixture.test.ts`) rather than the
   three-local-runs reasoning this finding rightly rejected. That fixture measured p95
   catching a broad blast-cost regression at `k = 0.020` at every legal subset size while
   p99 caught it at none — so the switch is more sensitive to the regression the gate exists
   to catch, not less. Its declared blind spot, also measured, is cost concentrated in the
   top ~2% _by duration_, where p95 is unchanged by construction. See `gate.ts`.

   **And the switch did not reduce the flake — recorded 2026-08-03, shipped as-is by
   ruling.** The first CI run after `R0 = 1.42` was recorded came in at **R = 1.7595
   against the 1.7750 ceiling, a 0.88% margin** — above the five-sample cohort's maximum.
   Including it, the p95 spread is **33.8%**, against the 37.7% this finding originally
   recorded for p99. The cohort stays fixed at five: no re-record, no widened `TOLERANCE`.

   That run bought the first real diagnosis, and it is the durable result of this exercise:
   `controlStat` was normal (0.3876 against a cohort range of 0.374–0.394) while
   `stressStat` sat 15% above the cohort maximum (0.6819 against 0.495–0.595). **The stress
   arm's whole distribution shifts run to run — a location shift, not a heavier tail.** No
   percentile choice can fix that: under p99 the same run would have sat 1.8% under its own
   ceiling, equally marginal. So this finding's original "the numerator absorbs the tail
   noise" reasoning was aiming at the wrong thing, and whatever eventually fixes this gate
   must target the stress arm's run-to-run **level**. The perf diagnosis remains unassigned
   (S6–S10).

   **AMENDED 2026-08-05 (M2-S6 QC) — the numerator moved to p50, `TOLERANCE` tightened to
   1.10, and the MAGNITUDE of the spread left unexplained above is now accounted for**
   (the p95-vs-p99 ordering within it is not — see "What this does and does not explain"
   below). The gate is `p50(stress due-blast ticks) / p50(control)`.

   The trigger was a CI failure, not a preference: `R = 1.8348` against the 1.7750 ceiling
   on a commit whose only delta from the previous PASSING head was a compile-time function
   that never runs inside the measured loop. Every workload oracle was byte-identical across
   the two runs (304 peak creeps, 224 median, 1,427 due-blast samples, 175 DoT records,
   route length 329), and the numerator barely moved (0.5753 → 0.5739). What moved was the
   DENOMINATOR: the control arm ran 23% faster, and since `R` divides by it, a faster
   control fails the build.

   **The mechanism, measured over four consecutive CI runs on byte-identical work:**

   | series (spread here is `(max−min)/min`, NOT the half-spread used for ratios above — the two differ by 2.2×–2.5× row by row, so do not read 31.1% against ±2.8%; per-run values are in `gate.ts`'s `stressStat` table) | range           | spread |
   | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------ |
   | control p50                                                                                                                                                                                                           | 0.3128 – 0.4102 | 31.1%  |
   | stress p50                                                                                                                                                                                                            | 0.3282 – 0.4114 | 25.3%  |
   | control p95                                                                                                                                                                                                           | 0.6824 – 1.1747 | 72.1%  |
   | stress p95                                                                                                                                                                                                            | 0.5193 – 0.7188 | 38.4%  |

   Both arms' MEDIANS shift together, by similar amounts — that is the runner's speed
   varying between jobs, and it is **common-mode**, which is exactly what a ratio cancels
   (cross-arm correlation **+0.99**). The tails are much noisier, and the tempting story is
   that they are independent per arm and therefore compound rather than cancel. **These four
   runs do not support that story** (they do not refute it either — see "How much n = 4
   settles" below): the two arms' p95s correlate **+0.88**, so tail noise also largely
   cancels. What differs is how much is LEFT: the tails are both
   noisier per arm and less well correlated, so more survives the division — **1.65×–2.55×**
   the per-arm half-spread (control p95 31.41% against control p50 12.31%; stress p95 17.35%
   against stress p50 10.50%), on top of the +0.88-versus-+0.99 correlation drop.

   Two corrections to how this was first written, both worth keeping because the second one
   is the reusable lesson. An earlier draft compressed the per-arm term into "roughly 2.5×
   larger per-arm variance"; a QC pass then deleted that as unreproducible and replaced it
   with 26.5/13.5/16.1/11.3 — figures computed on a **midpoint** basis, a third convention
   neither document declares, while `gate.ts` declares a **median** basis two paragraphs
   from where they were quoted. Under the declared convention the numbers are the ones above
   and the multiplier reaches 2.55×, so the original "~2.5×" was reproducible all along. The
   underlying defect was neither number: this table records only min/max, so no reader could
   apply either convention to it. That is fixed at the source — `gate.ts`'s `stressStat` doc
   now carries the **per-run** values for all four arms, and every figure here is derivable
   from them to within the last printed digit. Two caveats stated there and not repeated in
   full: the reconstruction misses one endpoint (this table's control-p95 max, 1.1747, comes
   out 1.17462), and the derived figures are computed from unrounded scales, so recomputing
   from the printed 4 dp cells can move a last digit.

   An illustration, not a check, and a selected one: within the CONTROL arm across the four
   jobs, p50 and p95 correlate only **+0.64** — lower than the cross-arm p95 correlation. The
   same quantity in the STRESS arm is **+0.36**. Tail behaviour is not well predicted by the
   level a run executes at.

   **How much n = 4 settles here.** Only the +0.99 excludes zero (95% CI [0.68, 1.00]); the
   +0.88 carries a CI of roughly [−0.52, 0.998] and is not separable from the others. So
   these four runs do **not support** the "tails are independent draws that compound" story —
   they do not refute it, and an earlier wording of this paragraph said "refutes", which is
   the same over-reading this amendment corrects elsewhere. The design rests on the R table's
   4.2×–5.9× advantage, not on the correlations, which are mechanism rather than evidence.

   **What this does and does not explain.** It explains the MAGNITUDE of the 37.7% / 20.2% /
   33.8% spreads this finding recorded and could not account for: they are all ratios with a
   tail numerator, and a tail numerator leaves several times more residue than a median one.
   It does **not** explain the p95-versus-p99 ORDERING inside those figures — the
   20.2%-against-11.1% anomaly recorded below, where the statistic discarding MORE tail came
   out noisier — and it does not even re-test it. That anomaly compares **p95/p50 against
   p99/p50**: mixed pairings sharing one denominator. The closest thing the new cohort offers
   is **p95/p95 against p99/p99** (16.4% vs 11.7%), which agrees on sign but varies both
   terms; no p99/p50 row was recorded, so the like-for-like comparison does not exist here.
   Even taken at face value that gap is 1.41× at n = 4, which the paragraph above places
   inside a four-sample estimate's own error. The anomaly stands as recorded, with its cause
   unattributed.

   **What four samples do and do not establish.** The gap between the median ratio and
   every tail ratio is 4.2×–5.9× and the four runs are paired, so that ordering is
   solid. The gaps _among_ the tail ratios are not — p95/p95 versus p99/p99 is 1.41×,
   versus p95/p50 is 1.06× — so nothing here should be read as "matching percentiles is
   worse than mixing them". The defensible claim is narrower and sufficient: **the median
   ratio is decisively quieter than any tail ratio.**

   It follows that the prior diagnosis is **half right and half wrong**, and the wrong half
   matters. There is a run-to-run location shift — but it is in BOTH arms, not "the stress
   arm's whole distribution", which is precisely why a ratio can work at all. And "no
   percentile choice can fix that" is refuted by measurement: matched medians give
   `R` a **±2.8%** half-spread (0.9938 – 1.0493) over the same four runs, against ±15.5%
   for the previously shipped p95/p50 and ±16.4% for a like-for-like p95/p95.

   **`TOLERANCE` 1.25 → 1.10, declared before the new `R0` was recorded.** A tolerance is a
   statement about admitted noise, so it is set from the statistic's variance, never from
   the baseline's value. This is a deliberate CHANGE of posture: headroom goes from 1.6×
   the half-spread to 3.6×.

   **The causal order matters and is easy to state backwards.** The statistic does not buy
   sensitivity — at equal tolerance the median is the LESS sensitive of the two, firing at
   k = 0.00922 on `gate-fixture.test.ts`'s broad injection where p95 fires at 0.00745, a ~24%
   larger regression needed. What it buys is noise, and the low noise makes a tolerance
   available that was previously unaffordable: p95 cannot be run at 1.10, because its own
   ±16.4% spread exceeds that threshold and it would fail on quiet runners. The end-to-end
   gain — old gate k = 0.01536, new gate k = 0.00922, **1.67×** — belongs to the tolerance;
   the tolerance is only available because of the statistic.

   **Those `k` figures are swept, not read off the fixture's grid, and they are quoted
   unrounded deliberately.** `gate-fixture.test.ts` evaluates a five-point `KS` grid, so its
   pinned 0.0075 and 0.0100 are the nearest grid points above each true threshold — right for
   the ORDERING it asserts, wrong as magnitudes. Quoting them as thresholds is what produced
   this amendment's original "k = 0.020 → 0.010", a claimed 2.00× where the swept answer
   (step 1e-5, n = 2,500) is 1.67×; and the first attempt to correct that quoted the sweep by
   name while still printing the grid's 0.0075, which turns the ~24% gap into 23%. Rounding a
   swept value to the grid's precision reintroduces the error at one decimal place lower.

   **A unit caveat, since these are percentages.** `R` is now near 1.00, so both arms are
   dominated by the same baseline per-tick cost. A 10% move in `R` is therefore **not** a
   10% blast-cost regression — it is ~10% of total tick cost. Nor should the two tolerances
   be converted into an "N× tighter in absolute milliseconds" claim (this amendment said
   ~3.4×): 1.25 bounded a **p95** of the due-blast subset and 1.10 bounds a **median** of
   it, so those are headrooms on different statistics and their ratio compares nothing.
   Reason about the `k` values, which are read off one common injection.

   **The price, stated plainly.** A regression concentrated on the blast-heaviest ticks —
   the shape an O(n²) in blast membership scanning would take — is now invisible to the
   gate. On the fixture's `dueBlasts >= 3` injection (~11% of samples) p95 moves +35.5%
   where the gating median moves +2.2%; against each statistic's own noise that is a
   signal-to-noise of 2.2 versus 0.8. p95 detects it and the median cannot. The trade is
   taken because the ordering REVERSES on the broad regression the gate primarily exists to
   catch (p50 scores 3.9, p95 scores 0.8): the statistic that catches the concentrated case
   cannot reliably catch the common one, and false-alarms besides. A gate that reliably
   catches the common case beats one that unreliably catches both. `stressStatP95` is still
   computed and reported in every `PERF-REPORT`, and the blind spot is pinned as an
   assertion in `gate-fixture.test.ts` so it cannot be rediscovered by accident.

   **`R0` was set to `null` at this amendment and RE-RECORDED at 1.00 before it shipped** —
   see the record immediately below, which is the current state. 1.42 baselines p95/p50 and
   says nothing about p50/p50, so the gate reported `R` without enforcing it for the length
   of the recording window (that is what the `'unset'` status exists for) and no longer does.
   The procedure written here asked for five samples with each run's ID and RESOLVED runner
   image recorded, since `ci.yml` says `ubuntu-latest` and nothing here pins an image; the
   record below explains why it took seventeen and replaces the span-based escalation rule.

   **RECORDED 2026-08-05: `R0` = 1.00**, ceiling **1.1000** — the median of **17** CI samples
   (run 31041932972, attempts 1–17, head `a1600c9`, `ubuntu-24.04`) rounded DOWN. The null
   window is closed, and it closed inside this PR rather than in a follow-up, which was the
   commitment. That mattered because a null `R0` is a GREEN state: the gate reports, `perf`
   exits 0, and every check passes while nothing is enforced. `ci.yml`'s default-branch alarm
   is the backstop and it only fires AFTER a merge — detection, not prevention.

   **The escalation rule fired at n = 5.** It was escalated to the owner rather than
   reinterpreted, which was right, and the owner authorised more samples. The rule specified
   a FIXED cohort of five, and at that n it is a coarse screen (~7% false-alarm rate against
   this noise level) — crude, not ill-formed. Extending the cohort is what introduced the
   n-dependence, and that was an authorised deviation from the protocol, not a discovery
   about the rule. The n-dependence is nonetheless real and disqualifies a bare span
   threshold for the REPLACEMENT: simulated here, P(span > 1.10) is 4.5% at n = 4, 6.8% at
   n = 5, 21% at n = 10 and 42% at n = 17. The threshold is also coupled to `TOLERANCE`,
   which this same change tightened 1.25 → 1.10 — at 1.25 neither this cohort (1.1058) nor
   S5b's (1.2021) would have fired, so the firing owes as much to the tightening as to n.

   **A second cohort is consistent with the baseline — but do not over-read it.** The four
   diagnostic runs' own sample sd is **2.55%** of their median against these seventeen runs'
   **2.57%**, and their medians are **1.0063** and **1.0065**. The n = 4 sd carries a 95% CI
   of 1.45%–9.51%, so agreement to 0.02 percentage points is coincidence rather than
   confirmation; and the two cohorts are days apart on the same image, not independent
   samples of the runner fleet over time. Read it as "consistent with", not "settles it".
   (The d2 conversion — n = 4 → 2.68%, n = 17 → 2.74% — explains the n = 5
   excursion rather than establishing anything; the n = 4 figure must be derived from the
   unrounded 2.758%, not the published 2.8%.)

   **Headroom, stated without flattering itself.** The margin is measured from the
   distribution's centre, not from `R0` — `R0` is the median FLOORED, deliberately below
   centre, so "a 10% margin" claims the conservatism and spends it. Real headroom is
   **3.61σ** from the median (3.75σ from the mean). And σ is estimated from 17 points, so the
   predictive tail is Student-t, not normal: **~1 noise-only failure in 690 runs** (1 in 910
   mean-centred). An earlier draft claimed 1 in 18,000, which needed BOTH the normal
   approximation and the floored-`R0` margin. As probabilities: 5.6e-5 → 1.5e-4 (the
   centring, ×2.7) → 1.4e-3 (the t, ×9.6), so the t step is 93% of the increase.
   **The pessimistic branch, quantified:** at the σ CI's upper bound (3.93%) the margin is
   **2.37σ** — 1 in 114 normal, **1 in 58** under the same t treatment. At 700–1,400 gated runs a year, using
   the t figure on BOTH branches: **1–2 failures a year** near the point estimate, **12–24 —
   monthly to twice monthly** near the upper bound. (An earlier draft said "every other
   month", reachable only by using the normal 1-in-114 and the low end of the run rate — the
   same substitution this paragraph indicts one sentence earlier.) Acceptable because `perf`
   is not required, and that verdict has to hold on the pessimistic branch. These
   seventeen are also attempts of ONE workflow run, clustered in time, and the cohort is
   left-skewed (g1 = −1.36), which the χ² bound above assumes away.

   **Replacement rule, third draft — the first two failed against this cohort.** Draft 1 used
   `TOLERANCE − 1`, which is not the margin (flooring `R0` discards up to 0.01 before the gate
   exists, 0.25σ here). Draft 2 tested against the σ upper bound, which this very cohort fails
   at 2.37 and which is unsatisfiable below n ≈ 68. **What ships: ≥10 samples on one head and
   image; compute both `(R0 × TOLERANCE − median) / sd ≥ 3` and the same margin against the
   97.5% two-sided χ² upper bound ≥ 2, and escalate if EITHER fails.** Here: 3.61 and 2.37,
   both pass. The bound test is the stricter one below n = 18 — it implies a point margin of
   3.65 at n = 10 and 3.04 at n = 17 — so both are tests, not a test plus a disclosure. It is
   also curable by adding samples, since the bound tightens with n. It remains blind to image-bump drift,
   constrains dispersion but not location creep, and has 50% power against a 9.3% regression
   needing 13.6% for 95% power. **Note also that the original span condition is still met at
   n = 17 (1.1058 > 1.10); the baseline ships on the σ argument with the owner informed, not
   because the trigger stopped firing.**

   On cancellation, scoped honestly: raw control p50 spanned **63%** across the cohort while
   `R` spanned **10.6%** — but that 63% rests on two fast runners; drop them and the other
   fifteen span 14.7%. `corr(R, control p50)` is **+0.14** (n = 17, not significant). Read it
   as "no residual speed dependence detected", not as a demonstration — a ratio cancels any
   multiplicative machine factor by construction. "0 of 17 exceed the ceiling" is weak,
   in-sample evidence: the ceiling was fitted to those same 17, so agreement is expected —
   though not _forced_, since any sample above 1.1000 would have exceeded it, as one did in
   the 2.49 era.

**The substance of the 2026-07-31 ruling is still untouched**: `perf` stays non-required
and a flake does not block a merge.

Everything else measured clear, with margin: JS heap **42.1 MB** on the low-end profile (the one
the ~256 MB budget is written for), worst-of-20 input latency **34.4 ms** against 100 ms, and
initial JS **0.36 MB** gzipped against 3 MB — **JS only, and that is the whole payload:
this build ships no wasm**, so the budget's "JS (+ wasm)" and the measurement cover the same
bytes. If a wasm module ever lands, `scripts/size-limit.mjs` must be widened before this figure
is quoted against the budget again. `step()` measured 0.32 ms against the tighter 2 ms
budget, but that figure is **indicative only** — the headless harness is unthrottled by design,
so it speaks to neither device budget directly, per (d) above.

## Amendment — 2026-08-04 (M2-S6, the stun story) — the stress scene is NOT extended, and `R0` is NOT re-recorded

> **The `R0` half of this heading was overtaken the next day.** The scene-extension exception
> below stands unchanged. The "`R0` is not re-recorded" half did not survive: the CI run this
> amendment authorised came back over the ceiling, and Finding 3's **2026-08-05** amendment
> moved the numerator to p50, `TOLERANCE` to 1.10, and re-recorded `R0` at 1.00 (ceiling 1.1000).
> Read everything below about `R0`, the ceiling, and "do not re-record" as the state S6's own
> PR ran under, not as instructions.

m2.md's S4 entry commits the stress scene to being "extended and re-measured by every
subsequent effect story." S6 takes an explicit, dated exception (Rob's ratification, ahead
of the packet sequence that depends on it), because on this story the obligation's usual
justification inverts:

1. **The change that could move perf is measured better by the UNCHANGED scene.** Stun's only
   hot-path costs are one new SoA column (`stunUntilTick`) pushed and read for every creep on
   every tick, and one widened catalog lookup per impacted creep — both paid whether or not any
   stun tower exists, and the existing chill/venom arms exercise the widened lookup and its
   `includes('slow')` test directly. Re-running the _existing_ scene against the new sim is a
   controlled comparison: same workload, same anchors, same seed, one variable changed. Adding
   a stun arm would change the workload at the same time as the code, confounding exactly the
   measurement wanted.
2. **A fourth arm would break the scene's own second oracle.** `towerIdAt` splits 150 anchors
   three ways (50/50/50), and all three towers cost 12 so that `150 × 12 = 1800` exactly equals
   `startingBounty` — an equality `layout.ts` documents as an independent proof that every
   placement was accepted. A fourth arm forces re-deriving the split, the costs, and that
   invariant, for a mechanic whose marginal cost is ~1.25 applications per tick.
3. **S11 is the pinned catch-all.** m2.md already owns a "final catalog-scale ADR 0005 stress
   gate" at S11, over the finished catalog.

**What the exception does NOT claim.** The unchanged scene contains no stun tower, so it
executes **none** of the new stun paths — no RNG draw, no `applyStun`, no active-stun write, no
zero-budget movement. It measures the three costs paid unconditionally — the column, the widened
catalog lookup, and the per-tick `new Rng(state.rngState)` construction plus writeback on
**every advancing tick, stun tower or not** — which is the bulk of what could regress; it is
silent on the stun-specific cost, which is bounded by roughly 1.25 applications per tick against
150 towers and ~200 creeps. That is a judgment about magnitude, not a proof, and it should be
read as one.

**What S6 does instead:** re-run `pnpm run perf` on the unchanged scene. A **local `R` is not
comparable to the CI-recorded `R0`** (S5b measured local runs landing far below CI), so the
local number is smoke evidence only, not a gate: it can show an outright collapse, but no
local baseline is recorded to compare it against. The real gate is the
CI perf job on the PR, against `R0 = 1.42` / ceiling `1.7750` (unchanged from the S5b re-record
above — S6 does not touch the scene, so it does not move `R0` either). Escalate, do not
improvise: if CI breaches the ceiling, stop and report; do not re-record `R0`, do not widen the
ceiling.

_(SUPERSEDED 2026-08-05, M2-S6 QC — that escalation rule fired: CI came in at `R = 1.8348`
against the `1.7750` ceiling on work whose oracles were byte-identical. It was reported rather
than improvised around, and the outcome is Finding 3's 2026-08-05 amendment above: the numerator
is now p50, `TOLERANCE` is 1.10, and `R0` is 1.00 (ceiling 1.1000). The `1.42` / `1.7750`
pair recorded here is what S6's own PR ran against, not the live gate.)_

## Consequences

- **Positive:** guardrails exist from day one; the core stack bet is validated
  before we build on it; perf regressions get caught against explicit numbers and a
  reproducible scenario. — **Corrected 2026-07-30 (M2-S4b): the bet was validated
  before we built on it, and it came back BREACHED at the stress scene (Amendment,
  Finding 1). The mechanism worked; the result is not the one this bullet assumed.**
- **Negative:** the numbers are provisional and may prove wrong (deliberately
  flagged as such); the seeded scenario, spike, and perf-CI harness are real work to
  schedule.
- **Neutral:** the exact reference device and the automated perf harness are
  finalized with the spike. — **Corrected 2026-07-30 (M2-S4b): the harness is
  finalized; the reference device is NOT. It is provisional emulation until S11's
  real-device pass (Amendment, (b) and (c)).**
