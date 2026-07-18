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
  Android webview under worst-case load. Rendering is decoupled from the fixed
  **20 Hz** sim, so a render dip never changes simulation results.
- **Worst-case entity load (stress target):** sustain **~300 concurrent creeps +
  ~150 towers** at the fps floor. Projectiles are render-only/cosmetic (per the
  combat model), so they load the renderer, not the sim.
- **Sim step time:** a full `step()` at worst-case load **< 2 ms** on mid-range and
  **< 5 ms** on low-end — comfortably inside the 50 ms tick, leaving headroom for
  2×/4× speed and for server-side re-sim throughput.
- **Initial load:** first-interaction JS **< 3 MB gzipped** (Phaser is ≈ 1 MB of
  that); assets lazy-loaded; PWA-cached for instant repeat loads.
- **Memory:** stay under **~256 MB** JS heap on low-end.
- **Input latency:** tap/click-to-response **< 100 ms**.

### Validation

An **early spike** runs a representative synthetic sim load on a real low-end
Android device (through the webview) plus Chrome low-end emulation, and fixes the
reference device. Budgets become CI-checkable where feasible — **bundle size now**;
frame/sim timing once a representative sim slice exists. **If the stack cannot hit
these numbers, that is an early signal to revisit the Phaser bet** — cheap to act
on now, catastrophic to discover after the game is built.

## Consequences

- **Positive:** guardrails exist from day one; the core stack bet is validated
  before we build on it; perf regressions get caught against explicit numbers.
- **Negative:** the numbers are provisional and may prove wrong (deliberately
  flagged as such); the spike and a perf-CI harness are real work to schedule.
- **Neutral:** the exact reference device and the automated perf harness are
  finalized with the spike.
