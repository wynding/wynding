# ADR 0005 — Performance budgets

- **Status:** Accepted
- **Date:** 2026-07-18
- **Amended:** 2026-07-30 (M2-S4b — the spike ran; see the Amendment below)
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

**They are independent, not ordered.** 6% of frames at 20 ms breaches `p95 > 16.7` while
producing no frames above 25 ms, so neither implies the other. Either firing is a trigger.

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

| Parameter        | Value                                                                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordering         | calibrated **before** `Emulation.setCPUThrottlingRate` is called (`apps/web/e2e-perf/stress.perf.spec.ts`), at CDP's default (unthrottled) rate                                                                                                    |
| Estimator        | **median** rAF delta, discarding the **first 5** frames (startup transient)                                                                                                                                                                        |
| Page             | a **blank page** (`about:blank`), navigated and sampled **before** the perf page is ever loaded                                                                                                                                                    |
| Window           | **2.0 s** of idle rAF sampling                                                                                                                                                                                                                     |
| Acceptable band  | median in **[15.0, 18.5] ms** → nominal 60 Hz, cutoff = **1.5 × measured median**                                                                                                                                                                  |
| Outside the band | the run reports `cadenceCalibration: "out-of-band"` with the measured median, and the missed-refresh signal is reported as **NOT EVALUATED** — never silently applied with a 60 Hz constant. The p95 breach signal is unaffected and still applies |

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
denominator (frames sampled), the proportion, and `cadenceCalibration` — so the trigger is
reproducible from the artifact rather than recomputed by hand.

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
   dressed up as that: M2-S5b P9 changed the stress workload (the scene gained a DoT arm and
   an armored population, and the AoE-producing tower population fell 150 → 100), which
   forces an `R0` re-record regardless. That makes this the one moment the statistic can
   change without paying a second re-record. Owner ruling of 2026-08-02: this class of
   decision — a statistic swap justified by a workload rebaseline rather than by a fired
   trigger — is technical and Claude's to take.

   **The substance of the 2026-07-31 ruling is untouched**: `perf` stays non-required, a
   flake still does not block a merge, and nothing here claims the cause of the 37.7% spread
   has been identified. It has not. p95 was preselected because this finding's own diagnosis
   names the numerator's tail as where the noise lives — not because the cause is known.

   The declined alternative "switching to p99/p99" above is likewise superseded rather than
   revived: the change adopted is p95 on the numerator, on the strength of a pinned
   injected-regression fixture (`packages/perf/src/gate-fixture.test.ts`) rather than the
   three-local-runs reasoning this finding rightly rejected. That fixture measured p95
   catching a broad blast-cost regression at `k = 0.020` at every legal subset size while
   p99 caught it at none — so the switch is more sensitive to the regression the gate exists
   to catch, not less. Its declared blind spot, also measured, is cost concentrated in the
   top ~2% _by duration_, where p95 is unchanged by construction. See `gate.ts`.

Everything else measured clear, with margin: JS heap **42.1 MB** on the low-end profile (the one
the ~256 MB budget is written for), worst-of-20 input latency **34.4 ms** against 100 ms, and
initial JS **0.36 MB** gzipped against 3 MB — **JS only, and that is the whole payload:
this build ships no wasm**, so the budget's "JS (+ wasm)" and the measurement cover the same
bytes. If a wasm module ever lands, `scripts/size-limit.mjs` must be widened before this figure
is quoted against the budget again. `step()` measured 0.32 ms against the tighter 2 ms
budget, but that figure is **indicative only** — the headless harness is unthrottled by design,
so it speaks to neither device budget directly, per (d) above.

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
