# ADR 0006 — Input-command and replay schema

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

The replay envelope `{ seed, rulesetHash, simVersion, tickInputs }` is defined (ADR
0001 §3, `packages/replay`) and the server re-simulates `tickInputs` to derive a
trusted score. But the command vocabulary is a placeholder — `packages/sim`'s
`SimInput` is only `spawnCreep | noop`, and creep-spawning is currently (wrongly) in
the _input log_ rather than driven by the wave schedule. The command schema is the
**anti-cheat and determinism contract**, so it must be pinned before gameplay code:
what a command is, what enters the replay, and how commands are validated.

## Decision

### 1. `tickInputs` records only sim-affecting **player** commands

A command is a discrete player intent that changes simulation state — e.g.
`placeTower`, `sellTower`, `upgradeTower`, `setTargetPriority`, and (if the mode has
it) manual `startWave`. This ADR fixes the **shape and rules**, not the final list;
the exact command set finalizes with the Core Gameplay PRD.

**Excluded from the log:** playback speed (2×/4×), pause, camera, and UI actions.
These are cosmetic/presentation — they don't change sim results — so they never
enter `tickInputs`. Recording them would break replay portability and let cosmetic
choices affect the world-hash.

### 2. Scheduled creep spawns come from the ruleset, not the input log

Wave spawns are a deterministic function of `(ruleset, tick)` computed by the sim's
wave scheduler (see ADR 0007), **not** player input. This corrects the current
placeholder, keeps `tickInputs` purely player-authored, and keeps replays small.

### 3. Command shape — determinism-clean

Each command is a discriminated union on `kind`, carrying only integer/enum fields
(no floats, no display strings). Commands reference entities by stable `EntityId`
and cells by integer `Cell { col, row }`. **`tickInputs[t]` is the ordered list of
commands applied at the start of tick `t`**, before the tick advances.

### 4. The sim validates every command; invalid commands are rejected deterministically

Placing a tower you can't afford, on an occupied/illegal cell, or that would fully
block the exit (the no-block invariant) → the command is rejected by the **same rule
on client and server**. This is the anti-cheat spine: a doctored replay that issues
illegal commands re-sims to a different (or rejected) result, so the server catches
it. Validation lives _inside_ the deterministic sim (same inputs → same accept/reject
decision → same world-hash).

### 5. The client records `tickInputs` as it plays

The web/app input layer maps raw pointer / keyboard / touch events → commands,
applies them to the running sim, **and appends them to the per-tick log**. That log
plus `seed`, `rulesetHash`, and `simVersion` _is_ the replay. (Today the web app
records nothing — this is greenfield.)

### 6. `simVersion` gates determinism-affecting changes

Any change to command semantics, the scheduler, or sim math bumps `simVersion`, so
an old replay validates against the version it was recorded under (existing rule).

## Consequences

- **Positive:** small, portable, tamper-evident replays; a clean anti-cheat property
  (illegal commands can't yield a valid score); cosmetic choices can't affect the
  hash.
- **Negative:** every player action needs a command **and** a deterministic
  validator — real discipline; the input layer must record precisely in tick order.
- **Neutral:** the exact command list finalizes with the Core Gameplay PRD; today's
  `spawnCreep` placeholder is replaced by content-driven scheduling (ADR 0007).
