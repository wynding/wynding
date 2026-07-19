# ADR 0005 — Performance budgets

- **Status:** Accepted
- **Date:** 2026-07-18

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
  is **< 3 MB** (Phaser is ≈ 1 MB of that). To be enforced by a size-budget check
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
**No perf gate is wired yet** (CI runs `verify` + `build`); the **bundle-size check
is the first to add** — a `size-limit`-style gate wired as soon as `apps/web`
produces a meaningful production build — followed by frame/sim timing once the
scripted scenario exists. **If the stack cannot hit these numbers, that is an early
signal to revisit the Phaser bet** — cheap to act on now, catastrophic to discover
after the game is built.

## Consequences

- **Positive:** guardrails exist from day one; the core stack bet is validated
  before we build on it; perf regressions get caught against explicit numbers and a
  reproducible scenario.
- **Negative:** the numbers are provisional and may prove wrong (deliberately
  flagged as such); the seeded scenario, spike, and perf-CI harness are real work to
  schedule.
- **Neutral:** the exact reference device and the automated perf harness are
  finalized with the spike.
