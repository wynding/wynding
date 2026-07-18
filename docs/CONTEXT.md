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
_Avoid_: map, field, level (a level is board + waves + economy).

**Creep**:
An enemy unit that walks the board from an entrance toward the exit. Creeps have
hit points and a kind (`normal`, `fast`, `armored`, `flying`, `boss`).
_Avoid_: enemy, mob, monster, minion.

**Tower**:
A player-built structure that occupies a tile and attacks creeps in range.
Towers are also **walls**: they reshape the maze. Towers upgrade in place
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
A scheduled burst of creeps the player must survive. A level is a finite,
ordered sequence of waves.
_Avoid_: round, level, round-number.

**Lives**:
The player's failure budget. Each creep that reaches the exit (a **leak**) costs
one life; at zero lives the run ends.
_Avoid_: health, HP (that's a creep stat), hearts.

**Bounty**:
In-run currency. Earned by killing creeps and spent building/upgrading towers.
Purely per-run; it does not persist between levels.
_Avoid_: gold, money, cash, credits.

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
simVersion, tickInputs }`. Re-simulated server-side to derive a trusted score.
_Avoid_: recording, demo, save (a save is a state snapshot, not an input log).

**World-hash**:
A deterministic content-hash of the serialized world, computed per tick. Two
runs that diverge produce different hashes — the determinism gate.
_Avoid_: checksum, digest (fine in prose; "world-hash" is canonical).

**simVersion**:
The behavior version stamped on a replay; bumped on any determinism-affecting
change so a replay is validated against the version it was recorded under.
_Avoid_: game version, schema version.
