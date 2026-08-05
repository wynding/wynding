# Design note — The ADR 0005 performance spike

_Implements ADR 0005's "early spike" and its **Measurement methodology** clause. ADR 0005
owns the budgets and the decision to validate them; this note is the_ how _and the_ what
was measured. _Recorded by M2 Story 4b (2026-07-30). Re-measured and extended by every
subsequent effect story (S5–S10); S11 runs the catalog-scale gate and the deferred
real-device pass._

**Read the three headline findings first — [What the spike found](#what-the-spike-found).**
They are numbered to match ADR 0005's amendment, which cites them by number. All three were
recorded as findings for the owner rather than as accepted results, and **all three were ruled on
2026-07-31**; each finding below carries its ruling.

## What is measured, and by what

Two harnesses, deliberately separate, because they answer different questions and one of
them can be trusted much further than the other.

| Harness  | Where                            | Answers                                      | Gates CI?                                             |
| -------- | -------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| Headless | `packages/perf` (Node)           | `step()` time; is the scene the ADR's scene? | Runs on every PR (`pnpm run perf`) — **not required** |
| Browser  | `apps/web/e2e-perf` (Playwright) | frame time, JS heap, input latency           | **No** — recorded-only this story                     |

"Not required" is exact: `main`'s branch protection requires `verify (format, typecheck, lint,
test)` and `codex-freshness`, and nothing else. A red `perf` job is visible on the PR but does not
stop a merge — which is why the ratio gate's flake rate below is a nuisance rather than an
outage, and equally why a true positive there needs someone to look.

The headless harness is the trustworthy one: `step()` is pure integer simulation with no
GPU, no compositor, and no device dependence beyond raw CPU. The browser harness measures
a real Phaser scene, but through Chrome DevTools emulation on a developer workstation —
see [what emulation cannot tell us](#what-emulation-cannot-tell-us).

## The scene

ADR 0005 asks for "~300 concurrent creeps + ~150 towers **at the fps floor** … under an
active behaviour mix —
creeps pathfinding along a near-maze-length route, towers acquiring targets and firing, and
the resulting scheduled damage events / status effects live", as a **fixed seed + scripted
scenario**. That scene is `packages/content/src/rulesets/stress-40x40.json` plus the
committed replay at `packages/perf/src/scenarios/stress-40x40.replay.json`.

It runs on a **purpose-built synthetic 40×40 board**, not the shipped `field-01`, because
the shipped board arithmetically cannot host the ADR's own worst case: 28×24 with a blocked
border ring leaves 26 × 22 = 572 buildable interior cells, and 150 towers at a 2×2 footprint
need **600**. The specced 10-wave arc — authored at S11, not shipped today — only ever spawns
117 creeps, against the ADR's ~300 concurrent. The synthetic board serves the ADR's actual
purpose, validating the Phaser bet at a genuine ceiling before five more effect stories pile
on, at the cost that **these numbers are a ceiling, not a description of real M2 play.**

| Knob (authored)  | Value                                                  |
| ---------------- | ------------------------------------------------------ |
| Board            | 40 × 40 (1,444 buildable interior cells)               |
| Towers placed    | **exactly 150** (50 blast, 50 blast-plus-slow, 50 DoT) |
| Creeps scheduled | 16 entries × 19 = **304**                              |
| Creep speed      | 60 fp/tick; slowed to 41 under the catalog's 30% slow  |
| Seed             | 1234                                                   |

| Property (measured) | Value                                     |
| ------------------- | ----------------------------------------- |
| Live creeps         | median **224**, peak **304** (min 32)     |
| Creeps under status | median **224**, peak **304**              |
| Due blasts per tick | median **1**, peak **7**                  |
| Route length        | **329 cells** — see finding 2             |
| Leftover bounty     | **0** (the maze consumes the whole purse) |

> **2026-08-03, M2-S5b P9.** The scene changed: the tower split moved from 100
> `stress-blast` + 50 `stress-chill` to a three-way 50 `stress-blast` + 50 `stress-chill` +
> 50 `stress-venom` (DoT), and the wave gained a `stress-armored` population — 114 of the
> 304 scheduled spawns, armor 6, blanking every stress tower's direct damage to 0 so it
> stresses only the DoT/status path. The due-blast peak moved with it: fewer
> AoE-producing towers (100, down from 150) means fewer can come due on the same tick, so
> the sampled window's busiest tick now carries 7 due blasts instead of 8, and the mean
> moved 1.51 → 1.068 (`harness.test.ts`). This table describes the scene's AUTHORED
> knobs, not a dated measurement, so it tracks the scene as it stands today rather than
> recording P9 as a historical delta.

Creeps carry 1,000,000 hp and the board starts with 1,000,000 lives, both **on purpose**: a
creep that dies is a creep the scene is no longer stressing, and `step()` freezes on a
terminal phase, so ordinary lives would turn every later sample into a trivial early return
posting superb percentiles. Balance is not modelled here and no number in this document
says anything about whether the game is fun.

### The workload oracle

A passing perf run proves nothing about _what it measured_. `placeTower` with insufficient
bounty is a deterministic no-op, `step()` freezes on terminal, and a short route or a
too-fast kill rate never reaches target concurrency — each of which yields an almost-empty
or wholly inert sim that passes every budget with excellent numbers. So the harness asserts
the scene before believing any timing (`packages/perf/src/oracle.ts`), and the browser spec
carries the same checks (150 towers, 0 leftover bounty, ≥ 280 creeps live, phase still
`running`, and the sim tick genuinely advancing across the window).

**16** assertions on the stress run (15 gated + reported) — thresholds **committed before
measurement**, except two regression tripwires deliberately pinned to a measured value (the 329
route floor and the 200 median-creep floor, both named as such in `oracle.ts`) — plus **8** on the
CONTROL run — phase, 150 towers, zero leftover bounty, zero due blasts, median live creeps within
a band of the recorded 181, non-zero peak slow coverage, zero dropped DoT applications, and peak
DoT carriers (reported, not gated). Two more assert that the real replay validator accepts each
committed replay. The gate's _denominator_ needs guarding too: a control that silently got heavier
or lighter would move `R` and mask a real blast regression, and "blast-free" was a comment before
it was a checked fact. **M2-S5b P9/P10 grew both counts** (the DoT arm and armored population
added five new gated stress-arm rows — peak DoT records, DoT record depth per carrier, samples
with a DoT tick applied, peak armored live creeps, and dropped DoT applications — plus the two
control-arm DoT rows above); an earlier "nine … plus six" count here predates those stories.

Route length is **one** un-waivable assertion at the measured 329, since the owner ruling of
2026-07-31 re-pinned the floor (finding 2). The story shipped two — a waived 600 and a floor
beneath it — because a waiver with nothing under it left every value below 329 unmonitored: a
maze with no path at all would have printed the same known-open line and exited 0. With the gap
closed by ruling there is nothing to waive, and **`KNOWN_OPEN_ASSERTIONS` is now empty**. A peak
alone is not enough either — a window of one tick at 304 creeps and 2,499 at one creep passes
every peak-based check, so the oracle asserts a **median** too. A missed floor is escalated as a
finding, never lowered to fit.

## Methodology (the parameters ADR 0005 says the spike pins)

**Headless.** Warm-up **200 ticks** — the 50 build ticks (each placing three towers, and
each running a grid-wide Dijkstra for the maze invariant), the rest of the 100-tick
countdown, and the wave's opening 100 ticks — then a sustained window of **2,500 ticks**.
Wall clock is taken around `step()` only; the events collector is allocated outside the
timed region. The blast-free **control** scenario runs first in the same process — it is
both the gate's calibration workload and the JIT warm-up the ADR's methodology requires.
Percentiles are nearest-rank, in both harnesses.

**Browser.** Per profile: build the 150-tower maze through the real player-intent API
(`armTower` + `clickAt`, 3 per tick), fast-forward the sim to **tick 1,950** (just past the
last spawn, where all 304 creeps are live), then immediately sample real
`requestAnimationFrame` deltas over a **10-second** window. Frame sampling runs **before** the
input-latency clicks, so both profiles open their window at the same tick over the same board —
sampling after them was the first pass's mistake, and it made the two profiles incomparable. Frame **times** are reported, not frame rates: ADR 0005's
budget is a floor, and an fps percentile runs the wrong way — a "p99 fps" is the _best_
frame of the window. Input latency is 20 real pointer interactions, each paired FIFO with
its own observed response, timed entirely in-browser so no Playwright IPC round trip
contaminates the sample; with n = 20 the tail figure reported is the honest **max**, not a
dressed-up p99.

### Pinned profiles

Recorded in full because DevTools throttling shifts between Chrome versions and the WebGL
backend shifts between machines — an unversioned, unlabelled profile makes the S5–S10
re-measurements incomparable.

| Profile       | CPU throttle | Viewport   | DSF | Touch | Chrome        | WebGL renderer                                    |
| ------------- | ------------ | ---------- | --- | ----- | ------------- | ------------------------------------------------- |
| **low-end**   | 6×           | 740 × 360  | 3   | yes   | 149.0.7827.55 | ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro) |
| **mid-range** | 2×           | 1280 × 800 | 1   | no    | 149.0.7827.55 | ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro) |

Both profiles are **landscape**: the app's rotate prompt is a modal that fires on
`(orientation: portrait)` and `(pointer: coarse)` together, so a portrait touch profile
measures a rotate dialog rather than the game. Phones play this game in landscape by design.

Both run with `--enable-gpu`. Playwright's Chromium defaults to ANGLE-over-SwiftShader — a
pure software rasterizer — and the first run of this harness reported 6 fps / 10 fps for
exactly that reason. Measuring Phaser on a software rasterizer measures SwiftShader, not the
Phaser bet ADR 0005 exists to validate.

**Host machine:** Apple M4 Pro (14 cores), 24 GB, macOS 26.5.2, Node v26.0.0. This is a
**developer workstation, not a reference device** — see the caveats below.

## Measured results

### `step()` time — headless, unthrottled

2,500 sustained samples; 1,427 of them had at least one blast landing.

| Statistic                          | p50   | p95   | p99       | max   |
| ---------------------------------- | ----- | ----- | --------- | ----- |
| Control scenario (blast-free)      | 0.183 | 0.287 | 0.393     | 1.193 |
| Stress — all samples               | 0.191 | 0.263 | 0.309     | 0.486 |
| Stress — due-blast ticks (n=1,427) | 0.207 | 0.271 | **0.323** | 0.486 |

_(milliseconds)_

A tick is **50 ms** at 20 Hz, so `step()` occupies well under 1% of it — leaving the headroom
ADR 0005 wants for 2×/4× speed and for server-side re-sim. (The comparison is to the tick, not
to a rendered frame: they are different clocks, which is the whole point of the render/sim
decoupling.)

**Which budget does this speak to?** Neither of ADR 0005's `step()` budgets directly — it is
unthrottled, on a fast workstation. It is **indicative only**: it establishes that the sim is
nowhere near the bottleneck, and it is the number the CI ratio gate tracks for regressions.

### The CI regression gate

Absolute ceilings on a `ubuntu-latest` runner would let the threshold be picked after seeing
results on a CPU that is not a stable reference, and gating raw `max` magnifies runner
variance. So the gate is a **ratio**, computed in one process:

```text
R = p99(step() over the stress run's due-blast ticks) / p50(step() over the control run)
CI fails when R > R0 × 1.25
```

_(SUPERSEDED TWICE — 2026-08-03, M2-S5b P11: the numerator moved to p95 and `R0` was re-recorded
to 1.42 on the post-P9 workload. Then 2026-08-05, M2-S6 QC: the numerator moved again to **p50**,
making both arms medians, `TOLERANCE` tightened **1.25 → 1.10**, and `R0` is **`null` pending a
re-record**. So NEITHER the statistic nor the tolerance in the block above is current — the gate
is now `p50(stress due-blast ticks) / p50(control)`, failing when `R > R0 × 1.10`. This
definition, and everything below it through the end of this section, describes the pre-P9,
p99-statistic, `R0 = 2.49` era; it is kept as the runner-variance record it still is. See
[Finding 3](#finding-3--the-relative-ci-gate-is-noisier-than-its-own-tolerance)'s amendments below
and `packages/perf/src/gate.ts`'s `R0` doc for the current definition and value.)_

The control is the **same scenario with every tower swapped for its single-form twin** —
same board, same anchors, same wave schedule, same slow effect — so the axis that changes is
the direct effect's **form**.

It is **not**, however, a clean one-dimension control, and claiming so would be false. Flipping
the chill tower from `aoe` to `single` necessarily changes _how many_ creeps receive the slow,
which changes how fast they traverse, which changes the population: measured, the control runs a
median of **181** live creeps against the stress run's **224**, and peaks at **109** creeps under
status against **304**. A single-form twin cannot reproduce an area effect's coverage, so this
residual is structural rather than tunable. `R` therefore isolates blast cost **plus blast-borne
slow coverage**, not blast cost alone. Round 1's fix narrowed the population gap from −28.6% to
−19.2% and took slow coverage from zero; it did not close either.

`R0 = 2.49`, **recorded on `ubuntu-latest`** — the median of the first 3 CI samples, in the order
taken 2.3585, 2.5129, 2.4978, rounded down. Ceiling 3.1125. The runner identity that baseline belongs to is
image `ubuntu-24.04`, release `ubuntu24/20260720.247`, Node 22; the local runs below were Node
26, a different V8 major and an unmeasured confound in the gap.

**R does not transfer between machines, and finding that out is one of this story's results.**
R0 was first recorded at 1.69 from 8 runs on the authoring machine (range 1.663–1.795, sd 0.045)
on the theory that a ratio cancels CPU-speed scale. The first CI run measured **2.3585** and
failed the 2.1125 ceiling; re-runs gave 2.5129 and 2.4978. So the ratio moved 1.47× across
machines, while `controlStat` — which is _expected_ to scale with machine speed — moved ~1.53×
(0.183 ms local → 0.272/0.279/0.290 ms on the three CI runs, a 1.49–1.58× span). A quantity built
to be scale-invariant moved almost as much as the raw statistic it was built to normalise.

The cause is the limitation the gate already carried but had not measured: a p99 numerator over a
p50 denominator (p95 at M2-S5b P11, p50 as of M2-S6 — this diagnosis is restated, not retested,
below) cancels
**scale** but not **tail variance**, and a hosted runner has a much fatter
tail than a quiet workstation. "Hosted", not "shared": each job gets its own VM (below) — what it
shares is the **physical host**, with tenants it cannot see, and that is where the tail comes from.
The median denominator barely moves with tail noise by construction; the numerator absorbs all of
it.

It is worse than cross-machine drift: R is not stable on **one** machine either. The same
commit, on the same laptop, measured 1.66–1.79 across 8 runs when it was quiet and 2.21–2.36
across 6 runs hours later under ordinary background load — **≈ 30% from ambient load alone, no
code change**. A later 32-run interleaved series on that machine spanned 1.638–2.560, **56%** —
measured in an uncommitted review harness, with both arms of an ordering A/B pooled.

**And the CI runner is no steadier — the committed ceiling has already been exceeded on
unchanged code.** R0 was chosen from the first three CI samples; the branch went on to produce
eight, and the full record is the honest one to read this gate against:

| #   | Actions job | started (UTC) | commit     | R          |
| --- | ----------- | ------------- | ---------- | ---------- |
| 1   | 91025915959 | 22:53:11      | 9e5b7b8 a1 | 2.3585     |
| 2   | 91026954496 | 22:59:02      | 9e5b7b8 a2 | 2.5129     |
| 3   | 91027669811 | 23:03:03      | 9e5b7b8 a3 | 2.4978     |
| 4   | 91028220425 | 23:06:13      | 9e5b7b8 a4 | 2.4915     |
| 5   | 91028488168 | 23:07:48      | 2cccfc4    | **3.0331** |
| 6   | 91029071138 | 23:11:22      | 9e5b7b8 a5 | **3.2478** |
| 7   | 91029800584 | 23:15:44      | 93c3f90    | 2.5937     |
| 8   | 91030969809 | 23:22:51      | f420491    | 2.6050     |

The eight rows above are the population every figure in this section and in `gate.ts`'s `R0` doc
is derived from — a snapshot taken when the ruling below was made, not a closed set. A ninth run
(`408412e`) has since measured **2.3355**, a new low that widens the observed span to 39.1% and
changes no conclusion here. Every CI run adds a sample; do not re-derive the statistics per run,
and if the set is ever recomputed, recompute **all four copies** of them together.

Samples 1–4 and 6 are the **same commit re-run five times**: 2.3585 → 3.2478, a **37.7% spread
on byte-identical code**. Sample 6 is _above_ the 3.1125 ceiling; sample 5 is ~2.5% under it.

**Nothing visible distinguishes the two high samples from the other six.** The obvious hypothesis
is concurrent load from this repo's own jobs, and it survives neither the model nor the data. The
eight perf jobs report eight **distinct `runner_name`s**, so no two shared a machine and a sibling
job in the same run was never contending for this one's CPU — multi-core GitHub-hosted runners get
a VM each, and only single-CPU runners share one. The data agrees: the most-overlapped sample has
the **lowest** R. What _would_ explain it — which physical host each VM landed on, and what else
was running there — is precisely what the Actions API cannot show. The honest reading is
unexplained runner variance: chasing it twice produced a plausible story both times and evidence
neither time.

So the earlier reading — "three samples span 6.5%, comfortably inside 25%" — described a window,
not the population. Three consecutive samples cannot bound a shared-runner tail; the local set
made exactly that inference from 8 samples spanning 8%, and it failed. State the flake rate
precisely, because the two readings differ: the shipped ceiling has been **evaluated three times
(samples 5, 7, 8) and passed all three**, but **one of the eight samples measured on this runner
class would have failed it**. "Roughly 1-in-8" is that counterfactual, not an observed failure
rate. R0 is **not** being moved again to chase it: the median of all eight is 2.5533 → R0 2.55,
ceiling 3.1875, which still would not have accommodated sample 6 and changes no observed sample's
verdict. The tolerance is not being widened either: the worst sample sits **30.4% above R0**
(3.2478 / 2.49), so absorbing it needs `TOLERANCE ≥ 1.31` — a gate that permits a 31% regression
in blast cost before complaining is not worth the CI minutes. (The 37.7% above is max/min, the
right measure of runner noise but not the one to compare against a tolerance that multiplies a
median.) **Ruled 2026-07-31: accept the flake, with the rate on record** (Finding 3, below) —
stale text here previously read "Left OPEN for an owner ruling"; the ruling is CLOSED, not open,
and the p95 statistic change amended into Finding 3 below is a dated _revisit_ of it, not a
reopening.

Two costs follow, and they are real. **A local `pnpm run perf` cannot reliably preflight the CI
result** — it runs the same gate and is still a useful local regression check, it simply cannot
predict the runner's verdict — and it
cannot even reproduce itself across sessions; read a local R only against other local runs taken
back to back, never against the ceiling. And **R0 must be re-recorded when the runner class
changes** — against the resolved image recorded above, not the `ubuntu-latest` alias — not only
when blast cost does.

The statistic was p99 rather than p99.9, over a floor of ≥ 500 due-blast samples, so a single
preempted tick could not fail CI while a systematic regression in blast cost still could. The
ratio cancels **CPU-speed scale** — a uniformly slower runner moves both terms together — but it
does **not** cancel tail variance, because the numerator was a p99 (then p95, M2-S5b P11) and the
denominator a median. That is the design's known limit, and the table above is what it cost in
practice under the p99 era; the same ≥ 500-sample floor applies throughout.

_(SUPERSEDED 2026-08-05, M2-S6 QC — the numerator is now a **p50** over the same subset, making
both arms medians, with `TOLERANCE` 1.10. This paragraph's "does not cancel tail variance" is
exactly the limit that move removes: measured over four byte-identical CI runs, `R` swings ±15.5%
with a tail numerator and ±2.8% with matched medians. The MAGNITUDE of the spreads left
unexplained below is accounted for by ADR 0005's 2026-08-05 amendment; the p95-vs-p99 ordering
within them is not, and remains unattributed.)_

### Frame time, heap and input latency — browser, emulated

| Metric                     | low-end (6×)  | mid-range (2×) | ADR 0005 budget         | Verdict      |
| -------------------------- | ------------- | -------------- | ----------------------- | ------------ |
| **Frame time p50**         | **58.4 ms**   | **16.8 ms**    | 33.3 ms / 16.7 ms       | **BREACHED** |
| **Frame time p95**         | **66.8 ms**   | **25.6 ms**    | (the ADR's statistic)   | **BREACHED** |
| Frame time p99             | 67.5 ms       | 25.9 ms        | —                       |              |
| fps at p50 frame time      | 17.1          | 59.5           | ≥ 30 floor / 60 target  | **BREACHED** |
| fps at p95 frame time      | 15.0          | 39.1           | ≥ 30 floor / 60 target  | **BREACHED** |
| JS heap                    | 42.1 MB       | 50.4 MB        | < ~256 MB (low-end)     | pass         |
| Input latency p50 / max    | 4.8 / 34.4 ms | 0.9 / 2.3 ms   | < 100 ms                | pass         |
| Frames sampled in 10 s     | 167           | 528            | —                       |              |
| Sim ticks advanced in 10 s | 204           | 201            | (200 expected at 20 Hz) |              |
| Scene setup to peak load   | 3.0 s         | 1.0 s          | —                       |              |

Towers placed **150**, leftover bounty **0**, and live creeps **304** on both profiles at the
moment each sampling window opened — tick 1968 low-end and 1960 mid-range. Phase `running`
throughout; **256 / 288** creeps still live after the window and the 20 latency clicks. The
numbers describe a genuinely loaded scene that was still simulating when sampling ended.

> **These figures supersede a first set, and the correction is worth knowing.** The original run
> sampled frames _after_ the 20 input-latency clicks, which take profile-dependent wall time while
> the sim keeps advancing — so the two profiles opened their windows at different ticks over
> different boards and were not comparable with each other. Sampling now runs first, pinning both
> to tick ~1960 with all 304 creeps live. The measured effect was large and in the opposite
> direction to the one predicted when the flaw was found: low-end p95 moved **100.4 → 66.8 ms** and
> mid-range **34.2 → 25.6 ms**, i.e. the post-click numbers were _worse_, not better, even though
> the post-click board carried fewer creeps. Why post-click sampling measures slower is **not
> established** — it is not the creep count, and no further claim is made here.

Initial JS is **0.36 MB gzipped** against the < 3 MB budget — a **pass**, but measured by
`pnpm run size` over `apps/web/dist`, not by either harness. It is not a per-profile figure
and the browser harness builds a different artifact (`dist-perf/`) entirely.

## What the spike found

### Finding 1 — frame time is over budget on both profiles, and the sim is not why

ADR 0005 pins **≥ 30 fps on low-end** (33.3 ms/frame) and **60 fps on mid-range**
(16.7 ms/frame) under exactly this load. Measured p95 frame time: **66.8 ms** and **25.6 ms**
— 2.0× and 1.5× over. Both trigger the escalation formula.

The margin is narrower than the spike's first pass reported (100.4 / 34.2 ms, since superseded —
see the note under the results table), and on mid-range the **median** frame now lands at 16.8 ms,
essentially on the 60 fps target; it is the p95 tail, at 39 fps, that breaches. The ADR's named
statistic is the p95, so the finding stands, but "mid-range holds 60 fps until it doesn't" is a
materially different problem from "mid-range runs at 30 fps", and worth knowing before anyone
acts on it.

Three things sharpen rather than soften this:

1. **The sim is not the bottleneck.** `step()` costs 0.2–0.32 ms per 50 ms tick. Even the
   low-end profile advanced 204 ticks during its 10-second window against ~200 expected at
   20 Hz — the sim held cadence to within a few ticks of real time (the small overshoot is
   window-boundary rounding, not drift)
   while frames took 58 ms. The cost is in the presentation layer, not the deterministic core.
2. **The emulation flatters.** A 6× CPU throttle on an Apple M4 Pro with a Metal GPU is not a
   low-end Android webview; it is far faster, and its GPU is in a different class. A real
   low-end device should be expected to do **worse** than 58 ms/frame here, not better.
3. **This is the ceiling scene, not real M2 play.** The specced arc never reaches 300
   concurrent creeps. The breach says the stack cannot hold the ADR's stated worst case; it
   does not say M2's actual content is unplayable.

ADR 0005 names this outcome explicitly: "If the stack cannot hit these numbers, that is an
early signal to revisit the Phaser bet — cheap to act on now, catastrophic to discover after
the game is built." **This is that signal, and it is the owner's call to act on.** What this
spike deliberately does not do is diagnose or optimize: S4b is a measurement story, and tuning
before the numbers exist optimizes the wrong thing. The first question for whoever picks it up
is where the frame time actually goes — Phaser draw calls, the per-frame view-model derivation
over 304 creeps, or the DOM overlay.

### Finding 2 — the scripted route is 329 cells against a committed floor of 600 (ruled: re-pinned to 329)

The workload oracle's route-length floor is **not met**, and cannot be met at ADR 0005's own
~150-tower figure. This is measured, not estimated:

- The committed 150-tower layout measures **329** cells: 307 from the eight structural
  serpentine bands (144 towers), plus 22 more from six tail baffles found by a greedy search
  over every remaining legal anchor.
- A greedy hill-climb from an empty board plateaus at 115 — lengthening a serpentine requires
  committing a whole band of towers, each individually worth zero, so single-step search
  cannot find it. The hand-authored structure beats greedy by nearly 3× (329 vs 115),
  which is why 329 rather than 115 is the honest ceiling estimate.
- The binding constraint is **the tower budget, not the board**: a 2×2 tower buys ≈ 2.2 cells
  of route. Measured over band-only layouts under a ≤ 150-tower budget: 40×40 → 307 (144
  towers used), 50×50 → 298 (138), 60×60 → 308 (140), 80×80 → 329 (148). Quadrupling the board
  area buys nothing.
- On the 40×40 board specifically, even an **unlimited** budget caps at **459** — twelve bands
  is all that fits at the 2-cell wall / 1-cell corridor pitch. So 600 is unreachable on this
  board at any tower count, and reaching it anywhere would need roughly 270 towers **and** a
  larger board.

Per the plan's own rule, this is escalated rather than lowered to fit: the scene should conform
to the ADR's target, not the target to the scene. **The decision is the owner's** — accept 329
as the measured near-maze-length route and re-pin the floor with that reasoning recorded, or
raise the tower count above the ADR's ~150 and enlarge the board.

**Ruled 2026-07-31: the first branch.** The floor is re-pinned to the measured 329, with the
reasoning above recorded in `oracle.ts`'s `ROUTE_LENGTH_FLOOR` and ADR 0005's finding 2. Reaching
600 would need a larger board and roughly 270 towers, making the scene less like real play rather
than more.

The oracle now carries **one** route assertion, un-waivable, at 329, with zero slack — the sim is
deterministic against a committed replay, so an unchanged maze reproduces it exactly and any drop
fails CI. During the story it carried two (a waived 600 plus a floor beneath it), because a waiver
with nothing under it left every value below 329 unmonitored: a maze with no path at all would
have printed the same `[KNOWN-OPEN]` line and exited 0. With the gap closed by ruling there is
nothing left to waive, and **`KNOWN_OPEN_ASSERTIONS` is now empty** — every oracle assertion fails
CI on its own merits.

### Finding 3 — the relative CI gate is noisier than its own tolerance

The ratio `R` was designed so that measuring both terms in one process would cancel runner speed
and let one baseline transfer anywhere. It cancels **scale** and not **tail variance**, and the
difference is not academic: the baseline recorded on the authoring machine had to be re-recorded
on the runner (1.69 → 2.49), and the branch then produced **eight CI samples spanning 2.3585–3.2478
(37.7%), five of them on byte-identical code** — one of which is _above_ the ceiling the committed
`R0` creates.

**Ruled 2026-07-31: ship as-is and live with the flake**, with the rate on record. A dedicated
runner costs infrastructure for a job that is not required. The declined "switching to p99/p99"
alternative below is superseded, not revived, by the amendment that follows. Revisit if it
flakes in practice; expect roughly 1 run in 8.

Widening the tolerance is not the fix: absorbing that sample needs `TOLERANCE ≥ 1.31`, and a gate
that permits a 31% regression in blast cost before complaining is not worth running. Re-recording
`R0` from all eight changes no sample's verdict. **The decision is the owner's** — accept the flake
rate, move the job to a dedicated runner and re-record, or change the statistic so numerator and
denominator carry tail alike.

The full eight-sample record, the runner provenance, and why the obvious explanations do not hold
are in [The CI regression gate](#the-ci-regression-gate) above and in
`packages/perf/src/gate.ts`'s `R0` doc.

**AMENDED 2026-08-03 (M2-S5b P11).** The numerator moved from p99 to p95, and `R0` was
re-recorded to **1.42** — the median of five CI samples on the POST-P9 workload (GitHub Actions
run 30851346335, attempts 1–5, `ubuntu-24.04`), ceiling **1.7750**. This is not the "revisit if
it flakes in practice" trigger above firing: the job has not flaked since the 2026-07-31 ruling.
It is different in kind — M2-S5b P9 changed the stress workload itself (a DoT arm and an armored
population joined the scene; the AoE-producing tower count fell 150 → 100), so the workload the
old `R0 = 2.49` described no longer exists, and moving `R0` for a **changed workload** is not the
same act as moving it to chase noise on an **unchanged** one — this note does not conflate them.
The declined "p99/p99" alternative above is superseded rather than revived: what was actually
adopted is p95 on the numerator, on the strength of a pinned injected-regression fixture
(`packages/perf/src/gate-fixture.test.ts`) — p95 caught a broad blast-cost regression at
`k = 0.020` at every legal subset size while p99 caught it at none — not the three-local-runs
reasoning this finding rightly rejected.

**A finding from that same five-sample cohort belongs on record here, plainly, because it cuts
against the diagnosis two paragraphs above this one.** Over the five re-recorded samples, p95's
spread is nearly DOUBLE p99's: `(max − min) / min` is **20.2%** for the five R(p95) values against
**11.1%** for the five R(p99) values, computed on the exact same five runs. The diagnosis that a
numerator discarding more tail should be quieter predicts the opposite of this. **The
noise-suppression half of the original rationale is not supported by this cohort**, and the switch
to p95 does not rest on it — it rests on the fixture result above. This does not identify the
cause of the spread. As recorded at the time, five samples of a different (post-P9) workload on one
re-run runner are also not a controlled comparison against the historical eight-job, pre-P9
population, so this neither vindicates nor condemns p95 on noise — it is what was measured. Full
record in `packages/perf/src/gate.ts`'s `R0` doc and ADR 0005's amended Finding 3.

**AMENDED 2026-08-05 (M2-S6 QC).** The numerator moved again, from p95 to a **p50** over the same
due-blast subset, `TOLERANCE` tightened 1.25 → 1.10, and `R0` is `null` pending a re-record. The
trigger was ADR 0005's 2026-08-04 escalation rule firing ("if CI breaches the ceiling, stop and
report; do not re-record `R0`, do not widen the ceiling" — that rule lives in the ADR, not in this
document): CI returned `R = 1.8348` against the `1.7750`
ceiling on a commit whose only delta was a compile-time function outside the measured loop, with
byte-identical workload oracles, the numerator unmoved (0.5753 → 0.5739) and the DENOMINATOR 23%
faster. Measured over four consecutive byte-identical CI runs, `R` swings ±15.5% with a tail
numerator and ±2.8% with matched medians.

What that identifies, and what it does not. It identifies the **magnitude** of tail-ratio spread —
the arms' medians co-move (+0.99) and cancel almost entirely, while the tails are 1.65×–2.55× noisier
per arm and correlate only +0.88, so a tail numerator leaves several times more residue in the
ratio. It does **not** resolve the p95-vs-p99 anomaly recorded two paragraphs above, and does not
re-test it: that anomaly compares p95/p50 against p99/p50 — mixed pairings over one denominator —
whereas the new cohort's nearest offering, p95/p95 against p99/p99 (16.4% vs 11.7%), varies both
terms. No p99/p50 row was recorded. Even at face value that 1.41× gap is not separable at n = 4, so
the anomaly stands as measured with its cause unattributed. Full record in ADR 0005's 2026-08-05
amendment and `packages/perf/src/gate.ts`.

## The escalation trigger

Pinned **before** measurement, evaluated per metric. **ADR 0005 is normative for this rule**;
it is restated here only as it applies to the results above. ADR 0005 carries budgets in both
directions, so a single "within 25%" rule would be directionally meaningless and would miss a
result 50% over an upper budget: an **upper** bound triggers at `measured ≥ 0.75 × limit`, a
**lower** bound at `measured ≤ 1.25 × floor`. Both are satisfied _a fortiori_ by an outright
violation, so a breach can never slip through the margin logic.

Evaluated against the results above:

| Metric                | Measured | Trigger at | Result                |
| --------------------- | -------- | ---------- | --------------------- |
| fps, low-end          | 15.0     | ≤ 37.5     | **TRIGGERS** (breach) |
| fps, mid-range        | 39.1     | ≤ 75       | **TRIGGERS** (breach) |
| JS heap, low-end      | 42.1 MB  | ≥ 192 MB   | clear                 |
| Input latency, max    | 34.4 ms  | ≥ 75 ms    | clear                 |
| Initial JS gzipped    | 0.36 MB  | ≥ 2.25 MB  | clear                 |
| `step()` (indicative) | 0.323 ms | ≥ 1.5 ms   | clear, but see below  |

The `step()` row is listed for completeness. Per the results section above it is unthrottled and
speaks to neither device budget directly, so "clear" there means "nowhere near the trigger", not
"the budget is validated".

One caveat on the rule itself: the **mid-range fps trigger is degenerate**. `1.25 × 60 = 75`
fps, and `requestAnimationFrame` on a vsync-capped display cannot exceed ~60 — so that metric
triggers unconditionally and its margin logic carries no information beyond the outright
breach. The low-end trigger (≤ 37.5 against a 30 floor) is well-formed.

**Replaced, not open.** ADR 0005 pinned a replacement mid-range trigger on 2026-08-03
(M2-S5b P11), before the browser re-run below that measures against it: two independent
signals — a missed-refresh proportion (share of frames exceeding 1.5× the nominal refresh
interval, firing above 2%) and an outright p95 frame-time breach (> 16.7 ms) — either of which
trips the trigger. See ADR 0005's amendment for the full derivation, the cadence-calibration
guard, and why the generic `0.75 × limit` margin rule cannot be reused for a vsync-quantized
metric. The re-run below reports both signals per profile.

## Re-run, 2026-08-03 (M2-S5b P11) — Chrome 149, the replacement mid-range trigger evaluated

**No new diagnosis in S5b.** The p95 breach below is consistent with ADR 0005's already-recorded
Finding 1 (frame time over budget, the sim is not why); no analysis is added here beyond what
that finding already states.

Measured against the pinned profiles above, both Chrome **149.0.7827.55**, WebGL renderer
`ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)`:

|                                 | low-end              | mid-range            |
| ------------------------------- | -------------------- | -------------------- |
| frame time p50 / p95 / p99 (ms) | 66.7 / 74.9 / 75.6   | 24.1 / 25.8 / 25.9   |
| p95-breach budget               | 33.33 ms (`1000/30`) | 16.7 ms              |
| p95 breach signal               | **FIRED** (2.25×)    | **FIRED** (1.54×)    |
| calibrated rAF cadence          | 8.30 ms              | 8.30 ms              |
| cadence in `[15.0, 18.5]` band? | **no — out-of-band** | **no — out-of-band** |
| missed-refresh signal           | **NOT APPLICABLE**   | **NOT EVALUATED**    |
| JS heap                         | 24.5 MB              | 60.3 MB              |
| input latency p50 / max (ms)    | 5.8 / 37.7           | 1.0 / 18.9           |
| setup                           | 3095 ms              | 1066 ms              |

**Why the missed-refresh signal is not evaluated on mid-range** (low-end has its own, prior
reason — see correction 2 below)**.** The measuring machine calibrates at ~120 Hz
(8.30 ms median rAF delta), outside the pinned 60 Hz band (`[15.0, 18.5]` ms) that ADR 0005's
replacement trigger requires. Applying a 60 Hz-derived 1.5×-interval cutoff to a ~120 Hz cadence
would be meaningless, so the trigger reports `cadenceCalibration: "out-of-band"` and stands
down rather than silently misapplying a 60 Hz constant. That is the calibration guard working as
designed, not a failure of the run — and it means **this trigger is inert on any display faster
than ~65 Hz**, worth stating plainly as a limitation of the design rather than a gap in this
measurement. The p95 breach signal has no such dependency and fired on both profiles regardless.

**Two corrections to the trigger, after this run, that do not change the numbers above.** Both
were review findings on the same defect — a mid-range budget applied to low-end — and are
recorded here because a reader comparing this table against the current code would otherwise see
a discrepancy:

1. **The low-end p95-breach budget is `1000/30` ≈ 33.33 ms, not the rounded 33.3 ms** the prose
   above and ADR 0005 both write. 30 fps is 33.333… ms/frame and the comparison is a strict `>`,
   so the rounded constant would report a run sitting exactly on the floor as a breach. The
   measured 74.9 ms clears either number, so the **FIRED (2.25×)** result is unaffected.
2. **The missed-refresh signal does not apply to low-end at all** — ADR 0005 defines it as the
   replacement _mid-range_ trigger. As executed, this run reported NOT EVALUATED for _both_
   profiles, because the cadence was out of band on both; the low-end row above has been
   restated as **NOT APPLICABLE**, which is what the current code emits. The two are not
   interchangeable and the ordering is why: applicability is now checked **before**
   calibration, so on low-end the signal stands down whatever the cadence did — NOT APPLICABLE
   _supersedes_ NOT EVALUATED there rather than sitting alongside it. Nothing measured changed;
   only which of the two reasons the artifact gives. Had the signal been applied, a low-end run
   _meeting_ its 30 fps floor would have fired it on nearly every frame — the same degeneracy
   the replacement trigger exists to remove.

## What emulation cannot tell us

The real low-end Android pass moved to S11 (ADR 0005's 2026-07-30 amendment). Until it runs,
the pinned profiles above **are** the reference this spike fixes — with these gaps, which no
amount of emulation closes:

- **Thermal throttling.** A phone that holds 30 fps for ten seconds may not hold it for ten
  minutes. Every number here is from a 10-second window on a machine that never got warm.
- **Real GPU fill-rate.** A Metal-backed M4 Pro is not a low-end Adreno/Mali. Fill-rate,
  bandwidth and shader throughput are where mobile GPUs actually fall over.
- **Webview-specific compositing.** An Android WebView composites differently from desktop
  Chrome; ADR 0005's binding constraint is the webview, and nothing here exercises one.
- **`step()` under real device CPU.** The headless harness is unthrottled by design (it is a
  regression gate, not a device measurement), so the < 2 ms / < 5 ms budgets are not directly
  measured on any device-like profile.
- ~~**The two profiles did not sample the same scene.**~~ **Fixed by owner ruling, 2026-07-31**,
  and the numbers above are the re-measurement. Frame sampling used to run after the 20
  input-latency clicks, which take profile-dependent wall time while the sim advances, so each
  profile opened its window at a different tick over a different board. Sampling now runs first,
  pinning both to tick ~1960 with all 304 creeps live. Worth recording that the predicted
  _direction_ of the error was wrong: the post-click windows carried fewer creeps but measured
  **worse** frame times, not better. See the note under the results table.

## A note on measuring instrumented tests

Recorded here because getting it wrong cost three review rounds, and the trap is not specific
to this repo.

The `validate()` re-simulation now in `run.ts` was originally a test in
`packages/perf/src/scenario.test.ts`, and the note explaining its move carried a wrong number
three times running. The measured truth, all on the authoring machine:

| what                                 | cost            |
| ------------------------------------ | --------------- |
| `validate()` under `tsx`             | ~0.65 s         |
| `validate()` inside vitest           | ~1.15 s         |
| the whole test, vitest, no coverage  | ~1.15 s         |
| the whole test, vitest, `--coverage` | ~7.5 s          |
| the whole test on `ubuntu-latest`    | 21.2 s / 28.1 s |

Three things fall out. **Vitest's module runner alone makes the simulation ~1.8× slower** before
instrumentation is involved — so a `tsx`-measured function call and a vitest-measured test are not
comparable, and the difference is big enough to invert a conclusion. **v8 coverage costs ~6.5×
on top of that**, and `verify` turns it on. And **the re-simulation is essentially the whole of
the instrumented 7.5 s** — uninstrumented it is ~0.65 s, roughly a tenth — which is why excluding
a sim-heavy path from coverage is the cheap fix, and why misdiagnosing the cost as "the
simulation is slow" hides that fix rather than pointing at it.

The practical rule: **measure both halves in one harness, and measure with and without coverage,
before concluding a test is too expensive for `verify`.** The original estimate here was accurate
within ~6%; two successive attempts to "correct" it were not, and both failed the same way — by
dividing a number from one harness by a number from another.

## Reproducing this

```sh
pnpm run perf                              # headless: oracle + step() percentiles + the ratio gate
pnpm -C apps/web run perf:e2e              # browser: both emulation profiles
```

Both print a machine-readable report line (`PERF-REPORT:` / `PERF-BROWSER-REPORT:`) carrying
every number in the two results tables above, so a re-measurement can be diffed against them
rather than eyeballed — plus fields those tables don't show: `PERF-REPORT` carries each arm's
`dotPreflight` and `dotDroppedTotal` (M2-S5b P10's DoT-oracle additions), and
`PERF-BROWSER-REPORT` carries `frameTimeTrigger` (ADR 0005's replacement mid-range trigger,
M2-S5b P11) — the cadence-calibration fields, plus `missedRefreshStatus`, which records
whether the missed-refresh signal was evaluated, not applicable to the profile, or
unevaluable because the cadence fell outside the 60 Hz band. The initial-JS figure
comes from `pnpm run size` instead. Regenerate the
committed scenario after any `simVersion` bump — the replay envelope stamps `simVersion` and
`rulesetHash`, and S5–S10 are six more bumps:

```sh
pnpm -C packages/perf run gen:scenario
```
