# Design note — Replay and command schema

_Implements ADR 0006. Living implementation guidance for `packages/sim` (command
vocabulary) and `packages/replay` / `apps/server` (validation). ADR 0006 owns the
decisions; this note is the_ how _and will be superseded by the code and its tests._

## Command shape

- Each command is a discriminated union on `kind`, carrying only **integer or enum**
  fields — no floats, no display strings.
- Entities are referenced by stable `EntityId`; board cells by integer `Cell { col, row }`.
- Placeholder vocabulary (finalizes with the Core Gameplay PRD): `placeTower`,
  `sellTower`, `upgradeTower`, `setTargetPriority`, `startWave`.

## Application order

`tickInputs[t]` is the ordered list of commands applied at the **start of tick `t`**, in
array order, before the tick advances. Order is significant, and duplicate commands are
each re-validated against the then-current state (a second `placeTower` on a now-occupied
cell no-ops).

## Validation is two-stage and total

1. **Structural** (before re-sim, in `packages/replay`): an unknown `kind`, an
   out-of-domain enum, or an out-of-bounds integer means the replay is **malformed and
   rejected**.
2. **Game-rule** (inside the sim): a well-formed but illegal command — unaffordable,
   illegal placement, or one that would fully block the exit — is a **deterministic
   no-op**, applying the same rule on client and server.

## Bounding untrusted work (anti-DoS)

A submitted replay is hostile input. Structural validation bounds individual _values_ but
must also bound _dimensions_, **before** re-simulation:

- reject if `tickInputs.length` exceeds the level's **maximum match length** (derived
  from the ruleset);
- reject if any tick's command count exceeds a fixed **per-tick cap**.

And enforce that same maximum **during** re-simulation as a **hard tick ceiling**: finite
waves plus remaining lives do **not** guarantee that active creeps ever clear (e.g. a
stalled board where creeps loop and lives never reach zero), so the sim must abort as a
timeout if it hasn't reached a terminal state by the ceiling. Bounding only the log length
is insufficient — both the up-front dimension check and the runtime ceiling are required.
_(Addresses Codex PR #6: "Bound untrusted replay dimensions before re-simulation" and
"Enforce the match-length cap during re-simulation.")_

## Terminal condition and scoring

- A run has three terminal outcomes: **win** (finite waves all cleared), **loss** (lives
  reach zero), or **timeout** (the hard tick ceiling from the anti-DoS section is hit
  first). Well-formed play under a valid ruleset reaches win or loss; the ceiling exists
  because hostile input — or a pathological ruleset — can stall so that neither is ever
  reached.
- The server runs the sim to the terminal tick **regardless of log length**: `tickInputs[t]`
  supplies tick `t`'s commands (empty if absent); if the log ends before terminal, the sim
  continues with **empty inputs** until win, loss, or the ceiling.
- A **timeout is not a scorable result** — the replay is rejected, not assigned a score.
- Entries **at or beyond** the terminal tick are rejected (padding).
- The **authoritative score is derived from the terminal state** of a win or loss; a
  client-supplied score is never trusted.

## `simVersion` handling

- Today: accept only the current `simVersion`; reject any mismatch.
- Deferred: a registry of pinned historical simulators keyed by `simVersion`, to
  re-validate old replays (or bucket them under versioned leaderboards).
- Any determinism-affecting change bumps `simVersion`.

## Not yet in scope

Replays are not tamper-evident: no signature or MAC proves a log was human-played or
original. Signatures, anti-bot heuristics, and input-timing analysis are separate,
deferred defenses; `validate()` should flag them as future work.

## Client recording

The web/app input layer maps raw pointer / keyboard / touch events to commands, applies
them to the running sim, and appends them in tick order to the log. That log plus the
initial conditions `{ seed, rulesetHash, simVersion, levelId }` _is_ the replay.
