# Wynding — Domain Glossary

The project's ubiquitous language: the terms specific to Wynding, each with a
tight definition of what it **is**. When several words mean the same thing, this
file picks the canonical one — match it in code, comments, tests, commits, and
PRs. This is vocabulary only; for _why_ decisions were made see the ADRs.

> Keep entries tight (1–2 sentences, define what it IS) and project-specific.
> General programming concepts don't belong here.

## Core gameplay

**Board**:
The open playfield — a rectangular grid of tiles with one or more creep entrances
and an exit. Unlike fixed-lane defense, the board starts empty and the player
shapes the route by building.
_Avoid_: map, field, level.

**Creep**:
An enemy unit that travels the board from an entrance toward the exit. Creeps vary
along **axes** — speed, durability (hit points + **armor**), **domain**
(ground/flying), effect-immunities, and role (e.g. a `boss`) — composed freely
rather than as fixed kinds.
_Avoid_: enemy, mob, monster, minion.

**Tower**:
A player-built structure that occupies a **2×2 block of cells** and attacks creeps
in range. Towers are also **walls**: they reshape the maze. Towers upgrade in place
(per-run only — no permanent meta-progression).
_Avoid_: turret, unit, building, defense.

**Maze**:
The walkable route left over after towers are placed. The player builds the maze
out of towers to lengthen the creeps' path.
_Avoid_: labyrinth, layout.

**Path**:
The specific shortest route a creep follows from entrance to exit given the
current towers. **Invariant: the exit is always reachable** — the player can never
fully wall it off; a route must always remain.
_Avoid_: route (interchangeable in prose, but "path" is canonical in code).

**Wave**:
A scheduled burst of creeps the player must survive. Waves come in a finite,
ordered sequence — a board's **wave schedule**.
_Avoid_: round, level, round-number.

**Lives**:
The player's failure budget. Each creep that reaches the exit (a **leak**) costs
at least one life — a boss may cost more; at zero lives the run ends.
_Avoid_: health, HP (that's a creep stat), hearts.

**Bounty**:
In-run currency. Earned by killing creeps and spent building/upgrading towers.
Purely per-run; it does not persist across runs.
_Avoid_: gold, money, cash, credits.

**Armor**:
A creep durability stat: a **flat** reduction applied to each **direct** hit, so
armor favors few-big-hits over many-small-hits. Damage-over-time bypasses armor.
_Avoid_: defense, resistance (armor is flat and direct-hit-only).

**Domain**:
Whether a unit acts on the ground or in the air. Each creep has a domain
(ground/flying); each tower targets ground, air, or both, and only hits creeps in
a domain it targets.
_Avoid_: layer, plane, type.

**Difficulty tier**:
One of the selectable difficulty settings (Easy/Medium/Hard). Each board × tier is
a distinct content entry with its own tuning and its own best-score.
_Avoid_: mode, level.

**Score**:
The deterministic numeric result of a run, computed from sim state (so the server
can re-derive it). A leaderboard input and badge — never a spendable currency.
_Avoid_: points, rating.

**Star grade**:
The casual-legible performance grade for a run, derived from lives remaining (a
near-flawless run earns the top grade). A badge, never a currency; never gates content.
_Avoid_: medal, rank.

## Simulation

**Sim / simulation** (`packages/sim`):
The pure, deterministic game logic — takes inputs, produces state. No Phaser, no
DOM, no floats, no `Math.random`, no `Date`.
_Avoid_: engine (that's the determinism toolkit), backend, model.

**Tick**:
One fixed simulation step — 50 ms, 20 Hz. Game time is `tick × 50 ms`.
_Avoid_: frame (that's a render concept), update, step-count.

**Engine** (`packages/engine`):
The determinism toolkit: seeded RNG, fixed-point math, the fixed-timestep loop,
and hashing. The byte-identity core, not gameplay.
_Avoid_: core, framework, runtime.

**Fixed-point**:
Integer encoding of fractional quantities (1 tile = 256 units, `FP_SHIFT = 8`).
Sim math is integer-only for determinism.
_Avoid_: float position, decimal.

**Replay**:
The minimal record that reproduces a match exactly — `{ seed, rulesetHash,
simVersion, levelId, tickInputs }` (`levelId` added by ADR 0006 so the scheduler
input is unambiguous). Re-simulated server-side to derive a trusted score.
_Avoid_: recording, demo, save (a save is a state snapshot, not an input log).

**World-hash**:
A deterministic content-hash of the serialized world, computed per tick. Two
runs that diverge produce different hashes — the determinism gate.
_Avoid_: checksum, digest (fine in prose; "world-hash" is canonical).

**simVersion**:
The behavior version stamped on a replay; bumped on any determinism-affecting
change so a replay is validated against the version it was recorded under.
_Avoid_: game version, schema version.

## Delivery

How we break work down and ship it. See [`roadmap.md`](roadmap.md) for the actual
phase sequence.

**Phase**:
The largest planning unit — a coherent stage of the product, "what the game _is_"
at that point. Phases are sequenced; each yields a numbered release line (Phase 1 →
the R1.x releases).
_Avoid_: epic, stage.

**Milestone**:
A feature-sized capability inside a phase; milestones roll up into a phase.
_Avoid_: deliverable (feature is fine in prose).

**Story**:
One focused, reviewable unit of work — in practice, one PR (which is one or more
commits). Stories roll up into a milestone.
_Avoid_: task, ticket.

**Release**:
A public build, tagged by maturity — **alpha** (rough, expect breakage) → **beta**
(stabilizing) → **stable**. The major number is the phase (R1.0, then R1.1 for a
Phase 1 bugfix); early milestones ship as alphas ahead of the stable release.
_Avoid_: launch (version is fine in prose).
