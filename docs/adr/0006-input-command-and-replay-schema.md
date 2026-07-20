# ADR 0006 — Input-command and replay schema

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

The replay envelope `{ seed, rulesetHash, simVersion, tickInputs }` is defined (ADR
0001 §3, `packages/replay`) and the server re-simulates `tickInputs` to derive a
trusted score. But the command vocabulary is a placeholder (`packages/sim`'s `SimInput`
is only `spawnCreep | noop`), and creep-spawning currently lives in the _input log_
rather than the wave schedule. The command log is the **anti-cheat and determinism
contract**, so we decide _what it records and what rules govern it_ before gameplay
code. The exact command list finalizes with the Core Gameplay PRD; the schema,
encoding, and bounding mechanics live in `docs/design-notes/replay-and-commands.md`.

## Decision

### 1. The log records only sim-affecting player commands

`tickInputs` records discrete player intents that change simulation state — placing,
selling, or upgrading a tower, setting targeting, and (where the mode has it) a manual
wave-start. Presentation actions — playback speed, pause, camera, UI — are **excluded**:
they don't change sim results, and recording them would break replay portability and
let cosmetic choices affect the world-hash.

### 2. Wave content comes from the ruleset, not the log

What each wave spawns comes from the ruleset schedule (ADR 0007), not free player input,
and the scheduler runs **inside the deterministic sim** — its timing depends on evolving
sim state (when the previous wave clears) and on any recorded wave-timing command. So
spawns are a deterministic function of `(seed, ruleset, inputs)` and re-simulation is
exact, with no creep spawns in the input log.

### 3. Replay identity selects the board

A replay's initial conditions are `{ seed, rulesetHash, simVersion, boardId }` — this
adds `boardId` to the ADR 0001 §3 envelope (envelope and `docs/CONTEXT.md` updated to
match). Those four plus the ruleset fully determine the re-simulation; `tickInputs` is
the ordered command log.

### 4. The sim is total: malformed rejected, illegal no-ops

Structurally malformed input (unknown command, out-of-domain value) makes the replay
**invalid and rejected** — the sim won't interpret it. A well-formed but illegal command
(unaffordable, illegal placement, one that would fully block the exit) is a
**deterministic no-op**, applying the same rule on client and server. The sim always has
a defined result.

### 5. The server bounds untrusted work and derives the score

The server treats a submitted replay as hostile input: it **bounds the work** a replay
can demand (both before and during re-simulation) and runs the sim to its
**deterministic terminal state** — finite waves won, or lives exhausted — then derives
the **authoritative score from that terminal state**. It never trusts a client-supplied
score, and it rejects replays padded past termination. This is the anti-cheat spine:
illegal commands can't inflate the result, and the only score that validates is the one
the recorded inputs actually produce. (Replays are **not** tamper-evident — no signature
proves a log was human-played; signatures, anti-bot, and input-timing checks are
separate, deferred defenses.)

### 6. `simVersion` gates which replays validate

`simVersion` stamps the sim-behavior version a replay was recorded under. **Today the
validator accepts only the current `simVersion`** and rejects any mismatch; executing
_historical_ simulators (a registry keyed by `simVersion`) is deferred. Any
determinism-affecting change bumps `simVersion`.

## Consequences

- **Positive:** small, portable replays; the server re-derives the true score of the
  submitted inputs; cosmetic choices can't affect the hash; the anti-cheat boundary is
  explicit.
- **Negative:** every player action needs a command _and_ a deterministic validator; the
  input layer must record precisely in tick order; historical-version replay is unsolved
  (deferred).
- **Neutral:** the exact command list finalizes with the Core Gameplay PRD; the
  command-shape, ordering, and DoS-bounding mechanics live in
  `docs/design-notes/replay-and-commands.md`.
