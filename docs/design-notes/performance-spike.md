# Design note — The ADR 0005 performance spike

_Implements ADR 0005's "early spike" and its **Measurement methodology** clause. ADR 0005
owns the budgets and the decision to validate them; this note is the_ how _and the_ what
was measured. _Recorded by M2 Story 4b (2026-07-30). Re-measured and extended by every
subsequent effect story (S5–S10); S11 runs the catalog-scale gate and the deferred
real-device pass._

**Read the two headline findings first — [What the spike found](#what-the-spike-found).**
They are numbered to match ADR 0005's amendment, which cites them by number.
Both are recorded as findings for the owner, not as accepted results.

## What is measured, and by what

Two harnesses, deliberately separate, because they answer different questions and one of
them can be trusted much further than the other.

| Harness  | Where                            | Answers                                      | Gates CI?                         |
| -------- | -------------------------------- | -------------------------------------------- | --------------------------------- |
| Headless | `packages/perf` (Node)           | `step()` time; is the scene the ADR's scene? | **Yes** — `pnpm run perf`         |
| Browser  | `apps/web/e2e-perf` (Playwright) | frame time, JS heap, input latency           | **No** — recorded-only this story |

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

| Knob (authored)  | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| Board            | 40 × 40 (1,444 buildable interior cells)              |
| Towers placed    | **exactly 150** (100 blast, 50 blast-plus-slow)       |
| Creeps scheduled | 16 entries × 19 = **304**                             |
| Creep speed      | 60 fp/tick; slowed to 41 under the catalog's 30% slow |
| Seed             | 1234                                                  |

| Property (measured) | Value                                     |
| ------------------- | ----------------------------------------- |
| Live creeps         | median **224**, peak **304** (min 32)     |
| Creeps under status | median **224**, peak **304**              |
| Due blasts per tick | median **1**, peak **8**                  |
| Route length        | **329 cells** — see finding 2             |
| Leftover bounty     | **0** (the maze consumes the whole purse) |

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

Ten assertions on the stress run — thresholds **committed before measurement**, except two
regression tripwires deliberately pinned to a measured value (the 329 route floor and the 200
median-creep floor, both named as such in `oracle.ts`) — plus six on the
CONTROL run — phase, 150 towers, zero leftover bounty, zero due blasts, median live creeps within
a band of the recorded 181, and non-zero peak slow coverage. The gate's _denominator_ needs
guarding too: a control that silently got heavier or lighter would move `R` and mask a real blast
regression, and "blast-free" was a comment before it was a checked fact.

Two of the ten cover route length, deliberately: one against the committed 600-cell floor (missed,
and waived as a named known-open finding) and one against the **329 actually measured**
(un-waivable). Without the second the waiver would have left every value below 329 unmonitored —
a maze with no path at all would have printed the same known-open line and exited 0. A peak alone is not enough —
a window of one tick at 304 creeps and 2,499 at one creep passes every peak-based check, so
the oracle asserts a **median** too. A missed floor is escalated as a finding, never lowered
to fit.

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
last spawn, where all 304 creeps are live), then sample real `requestAnimationFrame` deltas
over a **10-second** window. Frame **times** are reported, not frame rates: ADR 0005's
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

2,500 sustained samples; 1,671 of them had at least one blast landing.

| Statistic                          | p50   | p95   | p99       | max   |
| ---------------------------------- | ----- | ----- | --------- | ----- |
| Control scenario (blast-free)      | 0.183 | 0.287 | 0.393     | 1.193 |
| Stress — all samples               | 0.191 | 0.263 | 0.309     | 0.486 |
| Stress — due-blast ticks (n=1,671) | 0.207 | 0.271 | **0.323** | 0.486 |

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

```
R = p99(step() over the stress run's due-blast ticks) / p50(step() over the control run)
CI fails when R > R0 × 1.25
```

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

`R0 = 1.69`: the median of 8 consecutive runs (median 1.698, mean 1.706, **sd 0.045**, range
1.663–1.795), rounded down. Ceiling 2.113, against the worst run in that set (1.795) — about 18%
headroom, or roughly **seven** standard deviations. A second 8-run set taken later on the same
machine ranged 1.652–1.810 (sd 0.054), so read the spread as **≈ ±5%** rather than as the first
set's exact range; the ceiling clears both comfortably. p99 rather than p99.9, over a floor of ≥ 500
due-blast samples, so a single preempted tick cannot fail CI while a systematic regression in
blast cost still does.

The ratio cancels **CPU-speed scale** — a uniformly slower runner moves both terms together —
but it does **not** cancel tail variance, because the numerator is a p99 and the denominator a
median. That is why the tolerance is 25% and not something tighter.

### Frame time, heap and input latency — browser, emulated

| Metric                     | low-end (6×)  | mid-range (2×) | ADR 0005 budget         | Verdict      |
| -------------------------- | ------------- | -------------- | ----------------------- | ------------ |
| **Frame time p50**         | **91.8 ms**   | **33.1 ms**    | 33.3 ms / 16.7 ms       | **BREACHED** |
| **Frame time p95**         | **100.4 ms**  | **34.2 ms**    | (the ADR's statistic)   | **BREACHED** |
| fps at p50 frame time      | 10.9          | 30.2           | ≥ 30 floor / 60 target  | **BREACHED** |
| fps at p95 frame time      | 10.0          | 29.2           | ≥ 30 floor / 60 target  | **BREACHED** |
| JS heap                    | 47.4 MB       | 42.1 MB        | < ~256 MB (low-end)     | pass         |
| Input latency p50 / max    | 9.4 / 56.7 ms | 1.5 / 38.4 ms  | < 100 ms                | pass         |
| Frames sampled in 10 s     | 107           | 328            | —                       |              |
| Sim ticks advanced in 10 s | 205           | 203            | (200 expected at 20 Hz) |              |
| Scene setup to peak load   | 4.4 s         | 1.5 s          | —                       |              |

Towers placed **150** and leftover bounty **0** on both profiles; live creeps **304** when the maze finished
building and **224 / 272** at the sampling window's close (the 20 input-latency clicks run in
between, so the window opens later than the fast-forward tick); phase still `running` throughout. The numbers
describe a genuinely loaded scene that was still simulating when sampling ended.

Initial JS is **0.36 MB gzipped** against the < 3 MB budget — a **pass**, but measured by
`pnpm run size` over `apps/web/dist`, not by either harness. It is not a per-profile figure
and the browser harness builds a different artifact (`dist-perf/`) entirely.

## What the spike found

### Finding 1 — frame time is over budget on both profiles, and the sim is not why

ADR 0005 pins **≥ 30 fps on low-end** (33.3 ms/frame) and **60 fps on mid-range**
(16.7 ms/frame) under exactly this load. Measured p95 frame time: **100.4 ms** and **34.2 ms**
— 3× and 2× over. Both trigger the escalation formula with room to spare.

Three things sharpen rather than soften this:

1. **The sim is not the bottleneck.** `step()` costs 0.2–0.32 ms per 50 ms tick. Even the
   low-end profile advanced 205 ticks during its 10-second window — the sim kept perfect time
   while frames took 92 ms. The cost is in the presentation layer, not the deterministic core.
2. **The emulation flatters.** A 6× CPU throttle on an Apple M4 Pro with a Metal GPU is not a
   low-end Android webview; it is far faster, and its GPU is in a different class. A real
   low-end device should be expected to do **worse** than 92 ms/frame here, not better.
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

### Finding 2 — the scripted route is 329 cells against a committed floor of 600

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

Until then it is carried as a **named known-open finding** (`packages/perf/src/oracle.ts`'s
`KNOWN_OPEN_ASSERTIONS`). The threshold stays at 600, the assertion still runs, and it still
prints under `ESCALATION` — it simply does not, by itself, fail the CI job. That is deliberate:
this shortfall is a **constant**, so a permanently-red job would make every other oracle
assertion and the ratio gate invisible behind it, and a check that is always red is a check
people learn to ignore. Any other oracle failure, and any gate failure, still fails CI.

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
| fps, low-end          | 10.0     | ≤ 37.5     | **TRIGGERS** (breach) |
| fps, mid-range        | 29.2     | ≤ 75       | **TRIGGERS** (breach) |
| JS heap, low-end      | 47.4 MB  | ≥ 192 MB   | clear                 |
| Input latency, max    | 56.7 ms  | ≥ 75 ms    | clear                 |
| Initial JS gzipped    | 0.36 MB  | ≥ 2.25 MB  | clear                 |
| `step()` (indicative) | 0.323 ms | ≥ 1.5 ms   | clear, but see below  |

The `step()` row is listed for completeness. Per the results section above it is unthrottled and
speaks to neither device budget directly, so "clear" there means "nowhere near the trigger", not
"the budget is validated".

One caveat on the rule itself: the **mid-range fps trigger is degenerate**. `1.25 × 60 = 75`
fps, and `requestAnimationFrame` on a vsync-capped display cannot exceed ~60 — so that metric
triggers unconditionally and its margin logic carries no information beyond the outright
breach. The low-end trigger (≤ 37.5 against a 30 floor) is well-formed. Worth fixing in the
rule the next time ADR 0005 is amended; recorded here rather than silently worked around.

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

## Reproducing this

```
pnpm run perf                              # headless: oracle + step() percentiles + the ratio gate
pnpm -C apps/web run perf:e2e              # browser: both emulation profiles
```

Both print a machine-readable report line (`PERF-REPORT:` / `PERF-BROWSER-REPORT:`) carrying
every number in the two results tables above, so a re-measurement can be diffed against them
rather than eyeballed. The initial-JS figure comes from `pnpm run size` instead. Regenerate the
committed scenario after any `simVersion` bump — the replay envelope stamps `simVersion` and
`rulesetHash`, and S5–S10 are six more bumps:

```
pnpm -C packages/perf run gen:scenario
```
