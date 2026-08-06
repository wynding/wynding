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
(ground/air), effect-immunities, and role (e.g. a `boss`) — composed freely
rather than as fixed kinds.
_Avoid_: enemy, mob, monster, minion.

**Tower**:
A player-built structure that occupies a **2×2 block of cells** and either attacks
creeps in range or aids nearby towers (a support tower). Towers are also **walls**:
they reshape the maze. Towers upgrade in place
(per-run only — no permanent meta-progression).
_Avoid_: turret, unit, building, defense.

**Effect primitive**:
One of the composable tower behaviors — direct damage (single-target or AoE),
slow, stun, DoT, support, burst. A tower is a data-defined bundle of effect
primitives, not a fixed archetype.
_Avoid_: ability, power, spell.

**Status effect**:
An applied, timed instance of an effect primitive on a creep — a slow, stun, or
DoT record with a duration. Slow and stun never stack: the strongest magnitude
wins, and a weaker application neither extends nor overrides it. DoTs are
per-source: each source's DoT coexists, and only a re-application from the same
source refreshes it.
_Avoid_: debuff, ailment.

**Telegraph**:
The on-board visual cue that a status effect is active on a creep, dual-encoded
per the accessibility standard: a shape cue always (never color alone), plus a
motion cue that yields to reduced-motion — shape is the guaranteed channel.
_Avoid_: indicator, status icon.

**Ward**:
The on-board visual cue that a creep is **immune** to an effect. Distinct from a
Telegraph: a telegraph shows a timed status that is currently active, a ward shows
a permanent property of the creep kind — so it is present from spawn, never
expires, and is derived from the catalog rather than from sim state. Shape-cued
like a telegraph, but — unlike a telegraph — carries **no motion cue**: a ward is
not a timed status, so there is nothing for motion to communicate, and it renders
as one opaque ring regardless of `reducedMotion`.
_Avoid_: shield (reserved — in this genre it reads as a regenerating second health
pool, a mechanic we may yet want the word for), forcefield, badge, buff.

**Maze**:
The walkable route left over after towers are placed. The player builds the maze
out of towers to lengthen the creeps' path.
_Avoid_: labyrinth, layout.

**Path**:
The specific shortest route a creep follows from entrance to exit given the
current towers. **Invariant: the exit is always reachable** — the player can never
fully wall it off; a route must always remain.
_Avoid_: route (interchangeable in prose, but "path" is canonical in code).

**Pending**:
A build or sell accepted but not yet applied by a tick — the pause is the common
long-lived case. What the player sees — board, aim/selection, and bounty — always
reflects pending changes; they commit on the next tick that runs.
_Avoid_: queued, buffered.

**Tracer**:
The in-flight visual of a tower shot, travelling from tower to target over the
shot's real flight window. Purely decorative — damage outcomes are always carried
by the impact spark and HP pips, never by the tracer.
_Avoid_: projectile, bullet, missile.

**Impact**:
The landing of a fired shot — scheduled when a tower fires and resolved at the tick
it arrives, so a slow shot is dodgeable and its outcome always reads the fire-time
snapshot of the firing tower. An impact is either **target-locked** (bound to one
creep, wasted if that creep dies or leaks in flight) or a **blast**.
_Avoid_: damage event.

**Blast**:
A point-locked impact: it lands at a point that led the target along the creep's
path at fire-time speed, and affects every creep within its radius, whether or not
the original target is still alive. AoE names the effect form a tower authors; a
blast is one landing of it.
_Avoid_: explosion, area hit.

**Wave**:
A scheduled burst of creeps the player must survive. Waves come in a finite,
ordered sequence — a board's **wave schedule**.
_Avoid_: round, level, round-number.

**Wave preview**:
The countdown's readout of the _next_ wave's composition — creep types and
counts, one wave of lookahead only. What makes anti-air spend and an early call
informed choices rather than guesses.
_Avoid_: intel, forecast, wave list (that's a full-run roster, which this is not).

**Early call**:
Launching the counting-down wave before its countdown expires — the tempo
lever. Pays a bounty bonus and, from M2, earns **early-call score credit**;
an auto-launch (countdown expiry) pays and earns nothing.
_Avoid_: early send, rush, skip.

**Lives**:
The player's failure budget. Each creep that reaches the exit (a **leak**) costs
at least one life — a boss may cost more; the run ends when lives reach zero or below.
_Avoid_: health, HP (that's a creep stat), hearts.

**Bounty**:
In-run currency. Earned through play — killing creeps, plus wave-clear and
early-call bonuses — and spent building/upgrading towers. Purely per-run; it
does not persist across runs.
_Avoid_: gold, money, cash, credits.

**Armor**:
A creep durability stat: a **flat** reduction applied to each **direct** hit, so
armor favors few-big-hits over many-small-hits. Damage-over-time bypasses armor.
_Avoid_: defense, resistance (armor is flat and direct-hit-only).

**Domain**:
Whether a unit acts on the ground or in the air. Each creep has a domain
(ground/air); each **attacking** tower targets ground, air, or both, and only
hits creeps in a domain it targets. A support-only tower has no target domain.
An air creep is colloquially a _flyer_ — but `flying` is a catalog **creep id**,
not a domain value; the domain is `air`.
_Avoid_: layer, plane, type.

**Boss**:
A creep _role_: high durability, arrives as a wave's centerpiece, and may cost
more than one life on a leak (which can overshoot lives below zero).
_Avoid_: elite, miniboss, champion.

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

**Ruleset**:
The complete, schema-validated data bundle the sim reads — tower catalog,
creep catalog, board geometry, wave schedules, and balance constants
(ADR 0007). Authored as JSON, moddable without engine code; identified by
`rulesetHash`.
_Avoid_: config, game data, balance file.

**Replay**:
The minimal record that reproduces a match exactly — `{ seed, rulesetHash,
simVersion, boardId, tickInputs }` (`boardId` added by ADR 0006 so the scheduler
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

**P0–P3**:
The severity of a review finding, graded by impact rather than by category, P0 most
severe (there is no P4): **P0** a universal, release-blocking failure; **P1** systemic
(determinism, saves, replay compatibility) **or** urgent enough to fix this cycle even
if narrow; **P2** a genuine functional defect that is neither; **P3** minor — polish,
docs, micro-optimization. One scale for every reviewer; how each tier gates is in
[`ai-workflow.md`](ai-workflow.md).
_Avoid_: high/medium/low, blocker, critical, nit, P4.
