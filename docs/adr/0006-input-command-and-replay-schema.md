# ADR 0006 — Input-command and replay schema

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

The replay envelope `{ seed, rulesetHash, simVersion, tickInputs }` is defined (ADR
0001 §3, `packages/replay`) and the server re-simulates `tickInputs` to derive a
trusted score. But the command vocabulary is a placeholder — `packages/sim`'s
`SimInput` is only `spawnCreep | noop`, and creep-spawning is currently (wrongly) in
the _input log_ rather than driven by the wave schedule. The command schema is the
**anti-cheat and determinism contract**, so its _shape and rules_ must be pinned
before gameplay code (the exact command list finalizes with the Core Gameplay PRD).

## Decision

### 1. `tickInputs` records only sim-affecting **player** commands

A command is a discrete player intent that changes simulation state — e.g.
`placeTower`, `sellTower`, `upgradeTower`, `setTargetPriority`, and (if the mode has
it) manual `startWave`. **Excluded from the log:** playback speed (2×/4×), pause,
camera, UI — cosmetic/presentation actions that don't change sim results; recording
them would break replay portability and let cosmetic choices affect the world-hash.

### 2. Wave spawns come from the ruleset schedule (timing may be advanced by a recorded command)

The _content_ of each wave — what spawns, and its default timing — is a deterministic
function of the ruleset schedule and the tick, **not** free player input. The one
player lever is **wave timing**: if the mode allows sending a wave early, that
`startWave` / `sendEarly` is a **recorded command** in `tickInputs` that advances the
schedule deterministically. So the scheduler is a pure function of
`(ruleset, levelId, tick, recorded wave-timing commands)` — every input is in the
replay, so re-simulation is exact. (This resolves the apparent tension: manual
wave-start is allowed precisely because it's a recorded, replayed command, not hidden
state.)

### 3. Match identity — the replay must select the level

The scheduler input is ambiguous unless the replay names its level. The replay's
**initial conditions** are `{ seed, rulesetHash, simVersion, levelId }` (a `levelId`
is added to the envelope), and `tickInputs` is the ordered command log. Given those
four plus the ruleset, re-simulation is fully determined.

### 4. Command shape and ordering — determinism-clean

Each command is a discriminated union on `kind` carrying only **integer/enum
fields** (no floats, no display strings); entities are referenced by stable
`EntityId`, cells by integer `Cell { col, row }`. **`tickInputs[t]` is applied in
array order at the start of tick `t`** (before the tick advances); order is
significant and duplicates are each re-validated against the then-current state.

### 5. Validation, the match-end condition, and the authoritative score

- **Structural validation** (before re-sim): an unknown command `kind`, an
  out-of-domain enum, or an out-of-bounds integer means the replay is **malformed**
  and is **rejected** — the sim can't safely interpret it.
- **Game-rule validation** (inside the sim): a well-formed but illegal command —
  unaffordable, illegal placement, or one that would fully block the exit — is a
  **deterministic no-op**, applying the **same rule on client and server**. The sim
  is total.
- **Deterministic match end:** a match ends at a terminal state defined by the
  ruleset — all waves cleared (win) or lives at zero (loss). **`tickInputs` beyond the
  terminal tick are rejected**, so a client can't pad the log.
- **The server derives the authoritative score from the terminal state of the
  re-sim — it never trusts a client-supplied score.**

This is the anti-cheat spine: illegal commands no-op (they can't inflate the result),
padded ticks are rejected, and the only score that validates is the true one the
recorded inputs actually produce. Malformed or version/ruleset-mismatched replays are
rejected outright.

### 6. `simVersion` gating (current reality + deferred work)

`simVersion` stamps the sim-behavior version a replay was recorded under. **Today the
validator accepts only the current `simVersion` and rejects any mismatch** — so a
replay recorded under an older version is not re-validated (it's rejected, or later
bucketed under a versioned leaderboard). Executing _historical_ versions (a registry
of pinned historical simulators selected by `simVersion`) is **deferred** — noted so
the "validates against its recorded version" goal isn't mistaken for current
behavior. Any determinism-affecting change bumps `simVersion`.

### 7. The client records `tickInputs` as it plays

The web/app input layer maps raw pointer / keyboard / touch events → commands,
applies them to the running sim, **and appends them (in tick order) to the log**.
That log plus the initial conditions (§3) _is_ the replay. (Today the web app records
nothing — greenfield.)

## Consequences

- **Positive:** small, portable, tamper-evident replays; a clean, total anti-cheat
  model (malformed → reject, illegal → no-op); cosmetic choices can't affect the hash.
- **Negative:** every player action needs a command **and** a deterministic
  validator; the input layer must record precisely in tick order; historical-version
  replay execution is unsolved (deferred).
- **Neutral:** the exact command list finalizes with the Core Gameplay PRD; today's
  `spawnCreep` placeholder is replaced by content-driven scheduling (ADR 0007).
