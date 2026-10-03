# ADR 0005 — Performance budgets

- **Status:** Accepted
- **Date:** 2026-07-18
- **Amended:** 2026-07-30 (M2-S4b — the spike ran; see the Amendment below); 2026-08-03
  (M2-S5b P11 — numerator p99 → p95, `R0` 1.42); 2026-08-04 (M2-S6 — the stress scene is
  not extended for the stun story; see the Amendment below); 2026-08-05 (M2-S6 QC —
  numerator p95 → p50, `TOLERANCE` 1.10, `R0` re-recorded 1.42 → 1.00, **provisional**);
  2026-08-06 (M2-S7 — the stress scene is not extended for the air story; see the
  Amendment below); 2026-08-08 (M2-S10 P8 — the frame-time diagnosis the 2026-07-31
  ruling ordered ran; see the Finding at the end of this document)
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
work. S4 measures under Chrome emulation only, which keeps the story unblocked by
hardware. _(2026-08-23, #114: S11 shipped **two** catalog-scale things, and this clause is
easy to misread as one. The `perf:catalog` **oracle** is state-derived and untimed, and it is
the one that joined CI's `perf` job. The timed catalog-scale **measurement** did land as well —
`apps/web/e2e-perf/catalog.perf.spec.ts`, the browser frame-time spike — still under the pinned
emulation profiles. What did **not** happen is the real-hardware device pass this clause moves
here: its absence was re-accepted at the S11 close-out and it is still outstanding. This clause
is dated 2026-07-30, so it describes what was planned, not what landed. Two interim wordings
were wrong in opposite directions — one called the oracle a "CI-run oracle" here, twelve days
before it was; the other denied a timed catalog measurement existed at all.)_

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
   1.427743 rounded down. Ceiling 1.7750.

   **The cohort itself, moved here from `gate.ts` when that file's rewrite cut its
   superseded-era provenance (#86).** This is now the record's only home: the p95 era is
   history, and history lives in this ADR rather than in the gate's doc comment — but the
   figures below are still quoted (the 20.2%/11.1% finding immediately after this table is
   computed from nothing else), and CI logs expire on a 90-day retention with no artifact
   upload, so publishing the operands rather than only the ratios is what keeps them
   checkable at all. Five distinct attempts with five distinct job ids — a first collection
   pass returned one run read four times, and was re-verified before the table was written.

   | attempt | job         | controlStat p50 | stressStat p95 | audit p99 | R (p95) | R (p99) |
   | ------- | ----------- | --------------- | -------------- | --------- | ------- | ------- |
   | 1       | 91811842462 | 0.378234        | 0.540021       | 0.713615  | 1.4277  | 1.8867  |
   | 2       | 91815000367 | 0.394437        | 0.571298       | 0.719074  | 1.4484  | 1.8230  |
   | 3       | 91815560758 | 0.374028        | 0.494694       | 0.699456  | 1.3226  | 1.8701  |
   | 4       | 91816459609 | 0.376357        | 0.594722       | 0.756914  | 1.5802  | 2.0112  |
   | 5       | 91817201212 | 0.390022        | 0.512714       | 0.705933  | 1.3146  | 1.8100  |

   Median of the five R(p95) values, in the order taken (1.4277, 1.4484, 1.3226, 1.5802,
   1.3146) and sorted (1.3146, 1.3226, 1.4277, 1.4484, 1.5802): **1.427743**, rounded DOWN
   to the nearer hundredth → `R0` = 1.42. Down, not to-nearest: a lower `R0` makes the
   ceiling stricter, so the rounding can only ever cost a false alarm, never hide a
   regression. Ceiling = 1.42 × 1.25 = **1.7750**, and the max sample 1.5802 sits inside it.
   Span (max/min) = 1.5802 / 1.3146 = **1.2021**, within `TOLERANCE`, so the pre-committed
   "if the five span more than `TOLERANCE`" escalation did not fire. Fixed cohort: exactly
   five samples, no sixth and no widened tolerance.

   **PR A's pre-change baselines**, on the UNCHANGED workload with the OLD scene (run
   30828066588, job 91734721525, `ubuntu-24.04` image 20260720.247.2) — kept beside the
   cohort because the comparison between them is what "`R0` moved" means, and because both
   statistics are recorded on both sides, so a p99-before is never compared against a
   p95-after:

   |          | controlStat p50 | due-blast p99 | due-blast p95 | R (p99) | R (p95) |
   | -------- | --------------- | ------------- | ------------- | ------- | ------- |
   | before-1 | 0.286896        | 0.718915      | 0.495136      | 2.5058  | 1.7258  |
   | before-2 | 0.282686        | 0.703900      | 0.488650      | 2.4900  | 1.7286  |

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
   must target the stress arm's run-to-run **level**. ~~The perf diagnosis remains unassigned
   (S6–S10).~~ **The frame-time diagnosis ran at S10 (M2-S10 P8, 2026-08-08) — see the
   Finding at the end of this document.** (The run-to-run level shift in THIS finding
   remains unexplained and was explicitly out of the diagnosis's scope.)

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

   **RECORDED 2026-08-05: `R0` = 1.00 (PROVISIONAL)**, ceiling **1.1000** — the median of **17** CI samples
   (run 31041932972, attempts 1–17, head `a1600c9`, `ubuntu-24.04`) rounded DOWN. The null
   window is closed, and it closed inside this PR rather than in a follow-up, which was the
   commitment.

   **Provisional, for three reasons, all raised in review and none declined.** (1) It is not a
   runner-class calibration: every sample is an attempt of one workflow run on one
   `ubuntu-24.04` image within a few hours. The only other reading is the four diagnostic runs
   of 2026-08-03/05 (median 1.0063 against 1.0065), but their provenance was never captured —
   no run or job ids — so whether they are four separate runs or four attempts of one is
   UNKNOWN, and if the latter they carry the identical defect. They are not cross-occasion
   evidence. (2) The flake-rate figures
   below are model outputs, not measured rates — a Student-t predictive tail assumes i.i.d.
   normal sampling around a mean, while `R0` is a floored median and this cohort is clustered
   and left-skewed; they are illustrative and are **not** part of the acceptance rationale.
   (3) The escalation rule was selected in-sample: drafts 1 and 2 were rejected for failing
   against these 17 samples and draft 3's pass is reported on the same 17, which is fitting
   rather than validation. **What the baseline rests on instead** — an argument that needs no
   distributional assumption anywhere in it, because the cohort cannot support one. First,
   **`perf` is advisory**: branch protection requires `verify`, `codex-freshness`, and — since
   2026-08-12 (#106) — `e2e (functional + axe)`, but never `perf` (as configured at the time of
   writing — this repo cannot assert that, and if `perf` is ever made required this argument
   voids silently), so a wrong baseline costs a red non-blocking job and a human look. Second, a **purely descriptive margin**: the largest `R` ever observed under
   this statistic, across BOTH readings on record, is **1.0493** (from the four diagnostic runs;
   this cohort's own max is 1.0362) against a **1.1000** ceiling — a **4.8%** gap in the raw
   measurement, offered as a fact and not as a flake rate. An earlier draft quoted 1.0362 /
   6.2%, which dropped the four-run cohort from the max while the next clause cites its median. Third, the **median reproduces**
   across the two readings on record (1.0063, 1.0065) — medians only; the sd agreement is
   dropped, being a coincidence at n = 4 (95% CI 1.45–9.51%), and the earlier "3.61 sample-sds
   with nothing near it" is dropped too, being a tail claim from an estimated σ, which is what
   limit 2 says this cohort cannot support. Enough to enforce a gate that currently enforces
   nothing; not enough to call it calibrated.

   **Discharging the provisional status.** Dispersion and fleet-representativeness are
   different measurements and need different cohorts, so do not pool. For dispersion, the
   escalation rule stands as written (one head, one image, ≥10 samples) — pooling across heads
   mixes workload drift into `sd(R)`, which would _loosen_ the rule. For fleet coverage, the
   standing "re-record when the runner class changes" rule already yields one baseline per
   image; agreement between per-image baselines is the evidence, disagreement is the finding.
   PROVISIONAL retires when both limit 1 and limit 3 clear: a second image has its own baseline
   and the two agree, and the rule has been applied once to a cohort that did not select it.
   Limit 2 never clears — the flake figures are model outputs permanently, whatever the sample
   size. An earlier draft of this plan asked for "≥30 runs spanning ≥10 workflow runs and ≥2
   images", which the escalation rule's own precondition forbids; it is recorded here so it is
   not proposed again. **The weaknesses of the plan that replaced it, stated rather than left
   to `gate.ts`:** it has no owner and no date; the raw `R` values live only in CI logs under a
   90-day retention with no artifact upload, so the data expires; a second runner image arrives
   on GitHub's schedule, not this project's, so the timing is outside our control; and nothing
   in CI represents the provisional status — `ci.yml`'s alarm checks only that `r0` is a
   positive finite number, which a provisional baseline satisfies exactly as a calibrated one
   would. Treat the next runner image bump as the trigger.

   Closing the window inside this PR mattered because a null `R0` is a GREEN state: the gate reports, `perf`
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
   same substitution this paragraph indicts one sentence earlier.) **Illustrative only** — both figures assume i.i.d. normal
   sampling around a mean, and this cohort is clustered, left-skewed and summarised by a
   floored median. They are not the acceptance argument; see the provisional paragraph above
   for what is. These
   seventeen are also attempts of ONE workflow run, clustered in time, and the cohort is
   left-skewed (g1 = −1.36), which the χ² bound above assumes away.

   **Replacement rule, third draft — the first two failed against this cohort.** Draft 1 used
   `TOLERANCE − 1`, which is not the margin (flooring `R0` discards up to 0.01 before the gate
   exists, 0.25σ here). Draft 2 tested against the σ upper bound, which this very cohort fails
   at 2.37 and which is unsatisfiable below n ≈ 68. **What ships: ≥10 samples on one head and
   image; compute both `(R0 × TOLERANCE − median) / sd ≥ 3` and the same margin against the
   97.5% two-sided χ² upper bound ≥ 2, and escalate if EITHER fails.** Here: 3.61 and 2.37, both pass —
   IN-SAMPLE, on the same 17 that rejected drafts 1 and 2, so this is the rule's arithmetic on
   the data that selected it, not a validation of it. The bound test is the stricter one below n = 18 — it implies a point margin of
   3.65 at n = 10 and 3.04 at n = 17 — so both are tests, not a test plus a disclosure. It is
   also curable by adding samples, since the bound tightens with n. It remains blind to image-bump drift,
   constrains dispersion but not location creep, and has 50% power against a 9.3% regression
   needing 13.6% for 95% power. **Note also that the original span condition is still met at
   n = 17 (1.1058 > 1.10); the baseline ships on the acceptance argument above — advisory blast
   radius, a raw 4.8% margin, a reproducing median — with the owner informed, **not** on the σ
   argument (limit 2 retracts it) and not
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
3. **S11 is the pinned catch-all.** m2.md already assigns the catalog-scale measurement to S11,
   over the finished catalog. _(Corrected 2026-08-22, #114: this bullet used to attribute a
   quoted sentence to m2.md calling S11's catalog work a final ADR 0005 stress **gate** — a
   sentence m2.md does not contain, naming a gate the catalog scene never became. What S11
   shipped is the `perf:catalog` oracle, now run in CI's `perf` job; its row count is not
   repeated here. (Nor is that count pinned anywhere executable — `oracle-catalog.test.ts`
   asserts only a lower bound, and two of the rows are appended by `run-catalog.ts` rather than
   by `oracle-catalog.ts`. So the copies of it already in this file are unbound prose, and this
   bullet declines to add another.) The quotation marks were the tell: a quoted citation is
   checkable, and this one had rotted.)_

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
is now p50, `TOLERANCE` is 1.10, and `R0` is 1.00 (ceiling 1.1000, provisional). The `1.42` / `1.7750`
pair recorded here is what S6's own PR ran against, not the live gate.)_

## Amendment — 2026-08-06 (M2-S7, the air story) — the stress scene is NOT extended

S7 takes the same dated exception S6 took, on the same reasoning and with one addition S6 did
not have available: **evidence that the workload is provably unchanged**, rather than an argument
that it should be.

1. **The change that could move perf is measured better by the UNCHANGED scene.** The domain
   check is a per-candidate test in the targeting loop (`covered = def.domain === 'both' ||
def.domain === c.domain`), paid unconditionally on every tower's acquisition scan whether or
   not any flyer exists. The existing scene runs that loop 150 towers deep against ~200 creeps,
   so it exercises the new cost directly. Adding an air arm would change the workload at the same
   time as the code — the confound S6's entry above already describes.
2. **`R0` is provisional, and extending the scene would restart its clock.** It was re-recorded
   at 1.00 on 2026-08-05 with a stated discharge criterion (a second per-image baseline agreeing
   within 0.02, plus one out-of-sample application of the escalation rule). Neither has been
   satisfied yet. A workload change invalidates the in-flight calibration and buys nothing S11
   does not already own.
3. **A fourth arm still breaks the scene's second oracle** — the `150 × 12 = 1800 ==
startingBounty` equality `layout.ts` documents as an independent proof that every placement
   was accepted. Unchanged from S6's entry.

**A rejected middle option, recorded because it looks reasonable and is not.** An earlier draft
of S7's plan proposed extending the scene but leaving the new rows _reported, not gated_ — the
oracle already distinguishes the two. That does not work: adding creeps to the stress arm moves
`step()` cost on the **measured** arms, so `R0` is invalidated whether the new rows are gated or
not. It would need a separate third arm, which is new gate machinery, not the existing
reported-row mechanism.

**What the exception does NOT claim.** The unchanged scene contains no air creep and no
air-targeting tower, so it executes none of the air-specific paths: no `airLineFollowNeighbor`
step, no `isqrt` in the air metric branch, no terrain-independent occupancy skip, no domain
rejection at impact time. It measures the cost paid unconditionally — the per-candidate domain
comparison and the widened `Impact` record — and is silent on the air-specific cost. As with S6,
that is a judgment about magnitude, not a proof.

**What is NOT a judgment: the workload is byte-identical.** Regenerating the committed stress and
control replays after the `simVersion` bump moved **exactly two lines** — `"simVersion": 10 → 11`,
one per file. Every placement, the seed, and the stress board's own `rulesetHash`
(`99a45084c1cedecb49dbb95f12dac13bd39d11a1273d63e4de59720f3167c046`) are unchanged. The stress
bundle is separate from `wynding-core`, so S7's catalog additions (`flying`, `antiair`, `slow`
going both-domain) and its new wave index 5 do not reach it. So `R0` describes the same workload
it described before this story.

**What S7 does instead:** re-run `pnpm run perf` on the unchanged scene as smoke evidence, and
let the CI perf job on the PR be the real gate, against `R0 = 1.00` / ceiling `1.1000`. A local
`R` is not comparable to the CI-recorded `R0` (S5b measured local runs landing far below CI), so
the local number can show an outright collapse and nothing finer.

**The smoke run, 2026-08-06, local:** `R = 0.9675` against the 1.1000 ceiling (control p50
0.439 ms, stress due-blast p50 0.425 ms; audit-only p95 0.568 ms, p99 0.726 ms). All 16 stress-arm
oracle assertions and all 8 control-arm assertions pass, the scripted route is still exactly
**329** cells, dropped DoT applications are **0** on both arms, and both committed replays are
accepted by the real replay validator. Read this as "nothing collapsed", not as a gate result —
the local/CI gap is exactly why `R0` lives on the runner. **Escalate, do not improvise:**
if CI breaches the ceiling, stop and report — do not re-record `R0`, do not widen the ceiling.
That rule fired once already, at S6, and reporting it rather than improvising is what produced
the p50 re-baseline.

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

## Finding — 2026-08-08 (M2-S10 P8): where the frame time actually goes

The diagnosis the 2026-07-31 ruling ordered ("establishing where the frame time actually
goes", before S11) ran at S10, the last story in its window. It is a MEASUREMENT, not an
optimisation: nothing found here was acted on, per the ruling's own sequencing — S11's
real-device pass is where action belongs.

**Scope, narrowed on purpose.** This diagnosis covers **the renderer's hot path on the
unchanged controlled stress scene** — `stress-runner`/`stress-armored` and five
`stress-*` towers at 150 towers / ~300 creeps — which is what this ADR's budget has
always been about. The stress bundle contains **no `boss` and no `frost-splash`**, and it
was deliberately not extended: changing the scene changes the perf workload, and `R0` is
a pinned baseline that is never re-recorded for a diagnosis. S10's own render additions
(one boolean catalog join, one size scale factor, one footprint-mark arm — all O(1) per
entity) are therefore **not measured here**.

**Method (reproducible).** `WY_TRACE=1 pnpm -C apps/web run perf:e2e` records a DevTools
trace per pinned emulation profile via CDP (`Tracing.start`, `transferMode:
'ReturnAsStream'`), started during warm-up ≥ 1s before the 10s sampling window;
`node scripts/analyze-trace.mjs test-results/wy-trace-<profile>.json` (in `apps/web`)
post-processes it. Environment for the recorded runs: Chrome 149.0.7827.55, ANGLE Metal
(Apple M4 Pro), the two pinned profiles (6× / 2× CPU throttle), display cadence 8.3 ms
(120 Hz — both profiles' cadence calibration out-of-band, which affects only the
missed-refresh signal, not this diagnosis). Method rules, all validated against these
traces:

- **Trace categories:** `devtools.timeline` (the not-disabled-by-default one — without
  it `Layout`/`Paint`/`FunctionCall`/`FireAnimationFrame`/`MinorGC` come back empty),
  `disabled-by-default-devtools.timeline`, `disabled-by-default-devtools.timeline.frame`,
  `blink.user_timing`, `disabled-by-default-v8.gc`, `gpu`, and
  `disabled-by-default-v8.cpu_profiler` (ruling 7 — name functions, not just the lump).
  `toplevel` is deliberately excluded: `ThreadControllerImpl::RunTask` nests around
  `RunTask` and double-counts under name-based bucketing.
- **Attribution window ≠ trace window:** all attribution is clipped to the
  `wy:window:start`/`wy:window:end` marks the harness emits around the sampling window;
  warm-up (including `cpu_profiler`'s one-off V8 attach storm on the first traced
  `step`) and teardown are discarded, not bucketed.
- **Markers:** `wy:step`/`wy:derive` via `createController`'s perf-only `ControllerHooks`
  seam, `wy:draw` by wrapping the `RenderHandle` in `main-perf.ts`'s `sceneFactory`;
  surfaced as `blink.user_timing` `ph:'b'`/`'e'` async pairs and synthesized by FIFO
  matching per name (0 unmatched pairs in both traces). They are never `X` events with
  `dur`.
- **Bucketing on SELF (exclusive) time** by event name, on `CrRendererMain` (identified
  via `TracingStartedInBrowser`'s `frames[]` url match — `process_labels` metadata was
  again absent). `RunTask` `ph:'I'` zero-duration variants are skipped; trailing
  unmatched `ph:'B'` events at trace end are closed at trace end and counted (3 in each
  trace).
- **Shares, not absolute times:** a traced run is perturbed by definition (frame times
  under tracing are worse than the untraced S4b figures), so everything below is a share
  of main-thread busy time — never a traced absolute against an untraced budget.

**Event-name → bucket table** (the reproducibility record; `analyze-trace.mjs` is its
executable form):

| bucket          | event names (self time)                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| script          | `FireAnimationFrame`, `FunctionCall`, `RunMicrotasks`, `EvaluateScript`, `v8.callFunction`, `TimerFire`, `EventDispatch`                                                          |
| layout          | `Layout`, `UpdateLayoutTree`, `PrePaint`, `Layerize`, `HitTest`                                                                                                                   |
| paint           | `Paint`, `UpdateLayer`                                                                                                                                                            |
| compositing     | `Commit`, `BeginCommitCompositorFrame`, `BeginMainThreadFrame`                                                                                                                    |
| gc              | `MinorGC`, `MajorGC`, `V8.GC_*` (dominated by `V8.GC_SCAVENGER`)                                                                                                                  |
| task-overhead   | `RunTask` self time                                                                                                                                                               |
| instrumentation | `UserTiming::Measure` / `UserTiming::Mark` — the marker CALL cost, not the span. Observed to carry cat `devtools.timeline`, NOT `blink.user_timing`, so they are bucketed by name |
| unclassified    | everything else, reported by name, never dropped                                                                                                                                  |

**Results (2026-08-08, one recorded run per profile).** `CrRendererMain` is essentially
saturated on both profiles: busy **99.97%** of the window (mid-range) / **99.92%**
(low-end). Buckets, as shares of main-thread busy time:

| bucket (self time)             | mid-range | low-end |
| ------------------------------ | --------- | ------- |
| script                         | 95.58%    | 93.08%  |
| gc                             | 1.69%     | 2.17%   |
| layout                         | 1.48%     | 2.70%   |
| task-overhead (`RunTask` self) | 0.51%     | 0.88%   |
| paint                          | 0.40%     | 0.60%   |
| compositing                    | 0.19%     | 0.23%   |
| instrumentation                | 0.05%     | 0.15%   |
| unclassified                   | 0.10%     | 0.19%   |

**Signed residual (buckets + unclassified vs main-thread busy time): +0.000% on both
profiles**, within the pinned ±2% tolerance. Honesty note on what that figure can and
cannot say in this implementation: self times telescope to the top-level task sum by
construction, so the residual here detects **top-level double-counting or overlap**
(exactly the failure `toplevel`'s nesting wrapper would cause) rather than mis-nesting
inside a task. The 2026-08-08 pilot's post-processor read 100.4% / 101.2% on the same
check; this implementation's cleaner closure is a divergence recorded below, not a
superior result.

**The `FireAnimationFrame` split — the answer.** Three rAF chains run per display frame
(equal counts per chain in-window: 269 each on mid-range, 81 each on low-end). Inclusive
time per chain, as a share of main-thread busy time:

| rAF chain                                    | mid-range  | low-end    |
| -------------------------------------------- | ---------- | ---------- |
| Phaser's internal loop (no `wy:draw` inside) | **92.09%** | **85.02%** |
| the app's loop (`wy:draw` nests inside)      | 5.27%      | 10.51%     |
| the sampler's loop                           | 0.08%      | 0.09%      |

**Classification rule, stated in full so the split is reproducible.** Only the APP's chain
is identified by the documented nesting rule (a `wy:draw` measure falls inside the
`FireAnimationFrame`). The two chains with no `wy:draw` inside them — Phaser's and the
sampler's — are separated from each other by a **duration threshold of 2 ms**
(`apps/web/scripts/analyze-trace.mjs`): the sampler's callback only reads counters and
runs ~0.01 ms, while Phaser's renders the scene graph. The headline 92.09% / 0.08% split
depends on that constant, so it is recorded here rather than left in the script. The three
chains' equal in-window counts (269/269/269, 81/81/81) are the independent check that the
partition is clean.

The app's own three spans confirm the split from the other side: `wy:step` 2.37% of busy
(p50 1.124 ms), `wy:draw` 1.90% (p50 0.686 ms), `wy:derive` 0.23% (p50 0.058 ms) on
mid-range — **4.50% combined** (9.12% on low-end: 6.38% / 2.05% / 0.69%, `wy:step` p50
3.084 ms under the 6× throttle). The S4b spike's conclusion sharpens rather than moves:
the sim is not where the frame time goes, and neither is the app's draw call —
`RenderHandle.draw` only re-records Graphics command lists; `Phaser.Game` then renders
the scene graph in its own rAF loop, and that loop is where ~9 of every 10 busy
milliseconds are spent.

**Named functions (ruling 7, `cpu_profiler` self time, mid-range).** Phaser's method
names survive minification: `batchLine` 11.27%, `batchQuad` 9.17%, `batchFillPath`
8.15%, `batchStrokePath` 3.59%, `bufferSubData` 1.04%, `bufferData` 0.99%, `render`
1.00% — ~35% of main-thread busy time in named Phaser WebGL batching/upload methods
alone, i.e. **CPU-side tessellation of Graphics geometry and vertex-buffer upload**. The
largest frames are minified (`c` 22.14%, `r` 13.45%, `i` 11.88%, `T` 6.18%); they sit
under the same Phaser-internal rAF chain per the split above, but this finding does not
name what it cannot read. Low-end ranks the same names in the same order. Not sim, not
GC (1.7–2.2%), not layout (1.5–2.7%), not paint (0.4–0.6%), not compositing (~0.2%), not
the GPU process (2.93% mid-range — the workstation GPU is nowhere near saturated).

**Non-additive side measures** (reported separately, never summed with the buckets):
renderer `Compositor` thread 0.72% / 0.39% of the window; GPU process `CrGpuMain` 2.93%
/ 1.24%; main-thread idle 0.03% / 0.08%. `ThreadPoolForegroundWorker` (parallel GC,
`RasterTask`) observed and excluded, as in the pilot.

**Divergences from the 2026-08-08 pilot's pins, each corrected against these traces:**

1. **Signed residual +0.000% both profiles vs the pilot's +0.4% / +1.2%.** Same sign
   family (non-negative), both within ±2%; the difference is implementation — see the
   honesty note above. Recorded, not reconciled away.
2. **GPU process busy 1.24% on low-end vs the pilot's 2.6–3.2% band** (mid-range's
   2.93% reproduces the band). Corrected to the observed value; plausibly the smaller
   low-end viewport (740×360) at work, but no cause is claimed.
3. **Low-end three-span share 9.12% vs the pilot's 8.8%**; mid-range 4.50% vs 4.4%.
   Own-trace values recorded.
4. **Phaser-internal chain 85.02% on low-end** against the pilot's "~92%" (which these
   traces reproduce exactly on mid-range, 92.09%): under the 6× throttle the app chain
   grows to 10.51% because `wy:step` costs 3.08 ms p50 there. Recorded as measured.
5. **Instrumentation cost is visible at this throttle**: the sampled profiler attributes
   0.99% (mid) / 1.56% (low-end) of busy self time to the `measure` function — well
   above the pilot's ~5.6 µs per traced measure, and well above the timeline's own
   `UserTiming::Measure` X events (0.05% / 0.15%), which cover only part of the call.
   The markers are perf-build-only, so nothing ships; recorded so a future reader does
   not mistake `measure` in a profile for app work.
6. **Trailing unmatched `ph:'B'`: 3 per trace** vs the pilot's "a trailing unmatched
   `ph:'B'`" (singular). Handled identically (closed at trace end), count recorded.

**The cross-ADR tension, recorded and NOT acted on.** The answer lands where the pilot
pointed: the frame budget is spent CPU-tessellating stroked/filled Graphics and
uploading WebGL batches inside Phaser's own render loop. That sits directly against ADR
0003's cue architecture, which is stroked Graphics almost throughout — seven concentric
cue rings, eight footprint marks, chevrons, wingspans, wards — and whose accessibility
vocabulary chose shape and stroke over colour deliberately. The frame budget may be
paying for that choice. **This finding proposes nothing**: weighing an accessibility
architecture against a performance budget is an owner decision on S11's real-device
evidence, not a content story's to pre-empt.

**Out of scope, per the packet:** optimising anything named here, and Finding 3's
still-unexplained run-to-run level shift (see the 2026-08-05 amendment above), which
this diagnosis did not touch.

## Amendment — 2026-08-09 (M2-S11, docs close-out) — rulings 4–6, landed and pending

Carries the outcomes of Act 1 rulings 4, 5, and 6 (`.claude/plan-archive/m2-s11/APPROVED-PLAN.md`)
into this ADR. One state is still open at the end of this story; it is recorded here as a
single bounded paragraph so a later ruling can amend it without rewriting the section.

**Ruling 4 — the catalog scene (`catalog-40x40`), a fourth scene, not an extension.** S11
authors its own bundle, board, placement mapping, replay pair, and processes, carrying the
five primitives the stress scene's own ratio arm never exercises (stun, support, burst, air,
immunities/`leakCost`). It shares only `catalogTowerIdAt` with the stress scene — the ratio
harness never runs in the same process, so it cannot be warmed or contaminated by it. Its
purpose is narrower than the ratio gate's: it emits no `R` and feeds no gate. It exists for
the browser spike this ADR's own S10 finding (above) left unresolved — where the frame time
actually goes under a workload that, unlike the ratio scene, actually exercises air, stun,
burst, and support at once — via a purpose-built `perf:catalog` Node oracle and a dedicated
Playwright page/spec. **Trace filenames, report records, and analyzer inputs are keyed by
scene id + profile**, not profile alone — `stress.perf.spec.ts`'s existing keying (profile
alone) would silently overwrite the catalog scene's own traces if reused unchanged, since two
scenes now exist where one did before.

**Ruling 4, continued — the pre-committed load, the geometry amendment, and the TWO open
floor values.** The scene's schedule, board, and mine placement were fully precommitted
before any measurement (five rounds plus a post-cap audit plus three ratification rounds of
adversarial review, 78 findings raised and accepted, 0 rejected — full record in
`PLAN-REVIEW-LOG.md`). Building against that precommitment surfaced **three proven
impossibilities in the plan's mine geometry on the reused stress maze**, each pinned as a
standing test: no anchor is out of trigger range of every route cell; every anchor is
load-bearing (removing any one reroutes the maze); and no legal route-neutral pad exists
within trigger range of any route cell earlier than index 290 — the early route threads
one-cell-wide corridors. The plan's own constraints therefore force the applied amendment:
the 15 mines stand on 15 authored **route-neutral pads** off the anchor set (the 150 anchors
fill by the same continued round-robin), detonators sit in range of **late** route cells
(indices 310–323), so the window's tower count strengthens to **== 165 at every sampled
tick** and the ten detonations (165 → 155, each at a continuous-path route-cost-predicted
tick) plus the route cell-sequence identity are witnessed during the untimed leak-probe
extension rather than warm-up. Build 165 placements at the pinned 3/tick = 55 ticks; the
warm-up constant holds and the window follows its stated relative semantics to
[1055, 3554]. The scene is **landed**: 32 of 34 oracle rows green, the stress scene and both
its replays byte-identical throughout. **The two proposed floor VALUES were re-pinned by owner ruling
(Rob, 2026-08-09, S11 close-out)**: both measured under their estimates for a diagnosed
reason (the ground family travels as a ~27-cell convoy on the 329-cell route, so only ~1–2
stun and ~6 venom towers engage at any instant, where the estimates assumed all sources
simultaneous) — stunned-samples measured 531 against the proposed ≥ 1000, peak resident DoT
records measured 12 against the proposed ≥ 20. Per the plan's rule the scene was not retuned
after measurement; the owner re-pinned the floors to the measurement-backed ≥ 400 and ≥ 10,
and the oracle passes all 34 rows. Nothing in this amendment remains open.

**Ruling 5 — `R0`'s out-of-sample re-record clears what `gate.ts`'s own criterion allows, and
no more.** The re-record packet declared its statistic and cohort before taking any sample
(one head, one image, ≥ 10 samples, both dispersion tests from `gate.ts`'s "What ships"
re-record criterion — the sd-margin and chi-square-upper-bound gates), then found,
before recording, that the only machine available to it was a local development machine —
not the documented `ubuntu-24.04` GitHub Actions runner image the file's own vocabulary keys
"image" to throughout. `gate.ts`'s `R0` doc, under **THE TWO CONSEQUENCES**, independently
and explicitly disclaims any comparability between a local run and the CI ceiling it gates
(cited by block name, not by line: the line-number form of this citation had already rotted
once — see #86). No sample was recorded, and
**limit 3 (in-sample rule selection) stays open** — this is reported as a finding, not
absorbed as a re-record, and `TOLERANCE`/the ceiling were not widened to compensate (the move
this repo has declined twice). What DID change: `gate.ts`'s `R0` doc comment gained an M2-S11
FINDING paragraph recording this outcome, and an OWNER AND TRIGGER paragraph answering the
file's own "no owner or date" complaint — **owner: Rob; limit 3's trigger: the next
opportunity to take ≥ 10 fresh attempts of the same documented `ubuntu-24.04` image in CI**
(this repo's own PR CI runs, since a local cohort is disqualified per the finding just
recorded); **limit 1's trigger is unchanged** — a second runner image getting its own
baseline under the same rule, medians agreeing within 0.02, which arrives on GitHub's
schedule (the next `ubuntu-latest` bump), not this project's. `gate.ts`'s "provisional"
language is narrowed by these two paragraphs, not deleted: neither limit is claimed cleared,
and `R0`, `TOLERANCE` (1.10), and the ceiling (1.1000) are byte-identical to before this
story.

**Ruling 6 — the real low-end Android pass still does not run, and its absence is
re-accepted, not re-litigated.** The owner re-affirms the branch this ADR and m2.md's
S12-scope bullet on #36 (the real-device pass that "cannot close at S12") both already
provide for: the pinned Chrome emulation profiles remain the reference device
through M2's close-out, the S10 Finding's Phaser-vs-accessibility tension above rests on
emulation evidence alone, and **#36 cannot close at S12** — its real-device evidence spans
every story from S3 on, all still deferred. The architecture decision this ADR's S10 Finding
raised (whether the cue vocabulary's stroked-Graphics cost is worth revisiting) stays outside
S11's PR regardless of this re-acceptance; it remains an owner decision on real-device
evidence this milestone does not yet have. See `docs/milestones/m2.md`'s Open questions and
`docs/accessibility-checklist.md`'s Story 11 conformance audit for the same ruling recorded
in each document's own convention.

## Amendment — 2026-10-02 (visual pass V2, #181) — the S10 decision is taken: static art is baked

The S10 Finding above ended on an open architecture question, left as an owner decision: the
frame budget was being spent CPU-tessellating `Graphics` geometry inside Phaser's own render
loop (`batchLine`/`batchQuad`/`batchFillPath`/`batchStrokePath`). **The owner took that decision
on 2026-10-02 by picking item V2 of the visual pass (#181)**: draw the board and the towers once
into cached textures, and keep per-frame drawing for what moves. This entry records what that
changed and what it measured. It changes no budget, no trigger, `R0`, `TOLERANCE` or the CI
ratio gate, and amends no earlier finding or ruling.

**What is baked.** Two textures, painted with Canvas2D through the same `GraphicsLike` geometry
code that drew the art every frame before (`packages/render/src/canvas-graphics.ts`), so the
board looks the same by construction rather than by a second copy of the shapes:

- the **board** — floor, border ring, entrance, exit — one texture sized to the board in device
  pixels, shown as one image;
- one **atlas** — the towers' art: the plate every tower but the mine stands on, the mine's
  floor-coloured pad, each tower look's head as committed and as boosted (the boost glow
  baked into the boosted head), each look's whole translucent Pending picture with its dashed
  rim, and the scorch a spent mine leaves; and every creep silhouette shape at normal and
  low-health tint, standard and boss size — shown by pooled sprites placed each frame.
  (_Updated by R2, the visual pass's tower art:_ the atlas first baked each tower footprint
  mark as committed, buffed with the recipient ✦, and pending with its outline.)

Both are repainted only when the cell size, the effective dpr or the colour mode changes,
never per frame; a texture that would exceed the renderer's maximum size is baked at a lower
scale instead of failing.

**What stays live.** Everything that moves or comes and goes is still drawn each frame, into
three `Graphics` objects at fixed depths (`packages/render/src/layers.ts`): the aura shells
under the towers; the selection cue and tracers between the pending builds and the creeps;
health pips, status cues, the build ghost and sparks over everything. ADR 0003's cue
vocabulary — the choice the S10 Finding said the frame budget may be paying for — is split
between the two by what it marks, not by kind. The cues that belong to a piece's own art are
baked with it: a tower's silhouette and glyph (its head) and two tower STATE cues, the boost
glow (the boosted head's frame) and the Pending picture with its dashed rim (a frame per
look); and two creep cues, the low-health tint and the boss size — each an atlas variant of
its tower's or creep's frame. A spent mine's scorch is a frame too, its fade the sprite's
opacity. (_Updated by R2:_ the tower STATE cues were first the buffed recipient's ✦ and the
pending-build outline.) Everything else stays stroked `Graphics`, drawn per frame: the
status rings and pips, the airborne chevron, the aura shells, the selection cue, the ghost
and the sparks.

**Measured before/after.** The record-only browser perf suite (`playwright.perf.config.ts`: the
`catalog` and `stress` scenes on the `mid-range` and `low-end` emulation profiles), run twice
at the base commit (`9c3b524`) before any change and twice at `710bc8f`, all on one machine
within three hours: Chrome 149.0.7827.55, `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro,
Unspecified Version)`. Frame time in milliseconds; each cell gives run 1 / run 2.

| scene   | profile   | p50 before    | p50 after   | p95 before    | p95 after   | p99 before    | p99 after   |
| ------- | --------- | ------------- | ----------- | ------------- | ----------- | ------------- | ----------- |
| catalog | mid-range | 26.4 / 26.3   | 8.3 / 8.3   | 34.6 / 34.7   | 10.2 / 10.2 | 35.2 / 35.1   | 10.4 / 10.3 |
| stress  | mid-range | 33.4 / 33.4   | 16.6 / 16.6 | 41.6 / 41.7   | 18.6 / 18.5 | 43.1 / 43.2   | 25.3 / 24.7 |
| catalog | low-end   | 93.3 / 92.8   | 23.8 / 23.8 | 101.7 / 101.1 | 31.8 / 33.3 | 109.7 / 108.2 | 33.8 / 35.1 |
| stress  | low-end   | 110.3 / 108.7 | 50.8 / 50.3 | 118.2 / 118.1 | 60.1 / 59.9 | 141.0 / 125.0 | 67.1 / 68.0 |

The medians agree within about 2% run to run on both sides, so the change is far outside
run-to-run noise; the tails are noisier. The catalog scene on mid-range now sits at 8.3 ms, one
refresh of the 120 Hz display, so that figure is the display's floor rather than the remaining
cost. Both perf scenes were screenshotted at `710bc8f` to confirm every tower and creep is still
drawn — a bake that silently drew nothing would also make frames cheap.

**Missed-refresh proportion: not available from these runs.** The suite evaluates it only for
the stress scene on mid-range, and the display cadence calibrated at 8.3 ms (a 120 Hz panel),
outside the calibration band, so all four runs report it NOT EVALUATED (low-end: not
applicable by design; catalog: not computed) — the same condition the S10 Finding recorded.
The stress scene's p95-breach signal still fires on both profiles after the change (mid-range
p95 18.6 / 18.5 ms against the 16.7 ms budget; low-end 60.1 / 59.9 ms against 33.3 ms).

**What this evidence is.** Emulation on one development machine — the same class of evidence
as the S10 Finding, with the 6× / 2× CPU throttles slowing JavaScript but not the GPU. It does
not stand in for the real-device pass that ruling 6 above still holds open.

## Amendment — 2026-10-03 (visual pass T3, #181) — what towers that aim cost

Visual pass item T3 turns the heads of the towers that aim (basic, venom, stun and antiair, and any
tower the catalog has never heard of, which looks like basic) toward their target every frame, and
shows each shot: a recoil and a muzzle flash, or a ring pulse for a tower that does not aim. Both
run per frame, on the render clock, in Phaser-free trackers (`packages/render/src/tower-aim.ts`,
`tower-fire.ts`); the flash and the pulse are drawn live into the effects layer. This entry records
what that costs on the record-only browser suite, what was done about it, and what remains. It
changes no budget, no trigger, `R0`, `TOLERANCE` or the CI ratio gate.

**Attributed (QC round 1, at `335689b`).** Three builds of the same head, each run gated on one
worker: the head as built; B, the head with no flash or pulse drawn; and C, T3 off, where the
trackers take nothing in, so every head stays as R2 drew it. Frame time in ms, p50 / p95 / p99:

| scene   | profile   | head               | B: no flash or pulse | C: T3 off          |
| ------- | --------- | ------------------ | -------------------- | ------------------ |
| catalog | mid-range | 8.3 / 10.2 / 10.3  | 8.3 / 10.2 / 10.3    | 8.3 / 10.2 / 10.4  |
| stress  | mid-range | 16.6 / 18.8 / 25.0 | 16.6 / 18.5 / 25.0   | 16.6 / 18.5 / 25.0 |
| catalog | low-end   | 24.8 / 33.6 / 35.0 | 24.8 / 33.4 / 35.0   | 23.9 / 33.2 / 34.7 |
| stress  | low-end   | 58.3 / 66.5 / 75.0 | 58.1 / 66.8 / 75.1   | 58.0 / 60.1 / 74.6 |

Read by percentile, B matched the head, and aiming alone looked like it added almost a millisecond
to the catalog scene's low-end p50 and about 6 ms to the stress scene's low-end p95.

**Why the percentiles jump, and a steadier measure.** On this machine's display, which refreshes
every 8.33 ms, a frame lasts a whole number of refreshes whenever its own work is what holds it up,
as it is at low-end. The stress scene's low-end p50 of 58.3 ms is seven refreshes, and its p95 lands
a little over seven or on eight from run to run. Across the runs in this entry, it was 59.6 and 60.1
ms with T3 off; with T3 on, 65.4–67.8 ms in four runs and 60.3 ms in the fifth. The catalog scene's
low-end p95 is four refreshes, 33.2–33.6 ms, in every run with T3 on or off: on the 33.3 ms budget
line either way. A small cost moves a percentile by a whole refresh or not at all, so the
percentiles overstate it in some runs and miss it in others. The mean frame time over the sampling
window (the window's length over the frames counted in it) moves smoothly, so it is the better
measure of a cost this size. Mean frame time in ms, from the runs above and the two after the change
(below):

| scene   | profile   | head at `335689b` | head at `2322e24` | B: no flash or pulse | C: T3 off     |
| ------- | --------- | ----------------- | ----------------- | -------------------- | ------------- |
| catalog | mid-range | 8.36 / 8.33       | 8.34 / 8.37       | 8.35                 | 8.35 / 8.36   |
| stress  | mid-range | 15.95 / 15.95     | 15.85 / 15.97     | 15.87                | 15.72 / 15.67 |
| catalog | low-end   | 23.81 / 23.92     | 23.87 / 23.70     | 23.58                | 22.62 / 22.22 |
| stress  | low-end   | 56.18 / 57.47     | 59.52 / 55.25     | 56.82                | 53.48 / 55.56 |

T3 costs the catalog scene about 1.4 ms a frame at low-end, about 6%, and every run shows it. It
costs the stress scene about 2.6 ms at low-end on average, though that scene's runs spread almost as
widely (55.25 to 59.52 ms for the head), and about a quarter of a millisecond at mid-range. The
catalog scene at mid-range sits on one refresh either way, so it shows nothing. B sits within the
head's spread: the flash and the pulse cost little or nothing.

**Where it went, in Node.** A profile of the real per-frame path in Node rather than the browser:
each perf scene built as its page builds it (the real controller, the same placements and the same
fast-forward), two hundred frames of it recorded at each profile's pace (a tick a frame for low-end,
a frame per display refresh for mid-range), then replayed twelve times through the real
`drawBoardFrame` — the real trackers, the real sprite pools over stand-in sprites — under V8's
sampling profiler. Unthrottled, the board frame's JavaScript took about a fifth of a millisecond a
frame in every scene and profile. T3's trackers were 14.5% of it in the stress scene at low-end and
8.1% in the catalog scene, and most of that was bookkeeping, not aiming: a map of every tower's
footprint centre, keyed by strings and rebuilt on almost every low-end frame to match new shots to
their towers (6.2% and 4.9% on its own), a string key built for every tracer in flight every frame,
and a new map of head angles every frame. Turning the heads, the angle arithmetic itself, was a
small part of it. Garbage collection was 1.3–1.6% of the replay either way.

**What changed (`e5d3454`).**

- The fire tracker passes over a shot it has already taken in on its launch tick alone. The
  controller lists every shot a sim tick fires together, from the first frame after that tick
  (`apps/web/src/controller.ts`), so a shot launched no later than the latest launch tick taken in
  has been seen already. Only a new shot is matched to its tower, by a scan of the towers, and the
  towers that just fired are pruned in place.
- The aim tracker keeps each head and updates it in place, and on a frame whose render time has not
  moved — a paused game — it turns and computes nothing.
- The map of where each creep is drawn holds the interpolated creeps themselves, not a copy of each
  creep's point.
- `wrapAngle` skips its floating-point remainder for an angle already in range, which every angle
  the tracker keeps is, and `towerAims` keeps each tower id's answer.

On the same recorded frames, T3's part of the board frame's JavaScript (the frame with T3, less the
same frame without it) fell from about 71 µs to half that at stress low-end, and from about 43 to 13
µs at catalog low-end. These Node figures move by about 5 µs from run to run.

**After (`2322e24`).** Two runs of the record-only suite, gated, one worker, on AC power. Frame time
in ms, p50 / p95 / p99:

| scene   | profile   | first run          | second run         |
| ------- | --------- | ------------------ | ------------------ |
| catalog | mid-range | 8.3 / 10.2 / 10.3  | 8.3 / 10.3 / 10.4  |
| stress  | mid-range | 16.6 / 18.6 / 25.1 | 16.6 / 23.3 / 25.1 |
| catalog | low-end   | 24.9 / 33.3 / 35.2 | 24.7 / 33.3 / 35.1 |
| stress  | low-end   | 58.4 / 67.8 / 92.1 | 57.3 / 60.3 / 73.9 |

The browser does not see the saving: the means (the second table above) are where they were before
the change. What Node saved comes to about a fifth of a millisecond at the low-end profile's 6×
throttle, below what this suite resolves. The second run's stress mid-range p95 of 23.3 ms is the
same tail as an earlier head run's, which a repeat put back at 18.8. The stress scene's p95-breach
signal fires on both profiles, as it did before T3 (V2's entry above).

**What remains: a cost the Node profile does not show.** At catalog low-end T3 costs the browser
about 1.4 ms a frame, about 230 µs before the 6× throttle. That is more than fifteen times what the
Node profile puts on T3 in that scene (about 13 µs), and more than the whole board frame's
JavaScript takes there in Node (about 180 µs). So most of it is not in the per-frame JavaScript as
the Node replay runs it. What that replay leaves out is Phaser itself — its sprite setters and its
own render loop, which the S10 Finding found is where most frame time goes — and the browser's
garbage collection under the whole app's allocation. Turning a head should not make it dearer for
Phaser to draw: `batchSprite` builds every sprite's transform from its rotation, upright or not.
Where the rest goes is not established. The S10 Finding's traced method (`WY_TRACE=1`,
`apps/web/scripts/analyze-trace.mjs`) on the catalog scene at low-end, with T3 on and off, would
show it: if the `wy:draw` span — the app's own draw, which holds the trackers, the placement and the
sprite pools — grows by the gap, the cost is in that JavaScript under the browser's conditions; if
it does not, it is in Phaser's loop or in garbage collection.

**Outside T3: the frame keys.** The single largest cost in the board frame's JavaScript, in every
scene and with T3 on or off, is `anchorOf` in `placement.ts`, at about a fifth of it: every frame
builds each creep's and each head's atlas frame key as a new string and looks it up in the frame
map, so every lookup hashes a fresh string. It predates T3 (R1 and R2), and is left for a later
pass; the creep frame keys change with the creep art (R4) anyway.

**What this evidence is.** Emulation on one development machine (Chrome 149.0.7827.55, ANGLE Metal
on an Apple M4 Pro), the same class of evidence as V2's entry: the CPU throttles slow JavaScript,
not the GPU. It does not stand in for the real-device pass that ruling 6 above still holds open.
