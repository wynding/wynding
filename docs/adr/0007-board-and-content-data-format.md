# ADR 0007 — Board and content data format (the ruleset)

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

`rulesetHash` is currently a placeholder over `SIM_VERSION`, disconnected from any
content, and the content schema in `packages/content` is minimal. Wynding's vision is a
**community-tuned, moddable** game, so balance and content must be tunable **without
engine code**. We decide what the "ruleset" _is_ and the shape of its format before
gameplay code; the encoding and hashing mechanics live in
`docs/design-notes/ruleset-format.md`.

## Decision

### 1. The ruleset is the complete, data-driven content the sim reads

A single validated data bundle — the **tower catalog**, the **creep catalog**,
**board geometry**, **wave schedules**, and **global balance constants**. **No
balance magic-numbers live in engine code**; the sim reads all tuning from the ruleset.
A match outcome is a pure function of `(seed, ruleset, boardId, inputs)`.

### 2. Format: schema-validated JSON, moddable without a build step

Content is authored as **JSON** (data, not code) and validated at load against a schema
— so it's moddable without engine code or a build step. To keep two independent loaders
(client and server) from interpreting the same data differently, the schema pins each
field's encoding; that discipline is specified in the design note. **No floats in
sim-affecting data.**

### 3. `rulesetHash` is a collision-resistant digest of a canonical form

`rulesetHash` identifies the exact sim-affecting content a replay ran against and buckets
leaderboard scores, so it must be **collision-resistant** (a cryptographic digest, not
the engine's 32-bit world-hash) and computed over a **canonical form that excludes
presentation-only fields** — localization keys and the like, so renaming a board never
invalidates replays. Client and server must produce byte-identical hashes from
equivalent content; the canonicalization procedure is fixed in the design note.
`rulesetHash` is the _content/balance_ version; `simVersion` is the _engine-behavior_
version — a balance tweak bumps the former, an engine change the latter.

### 4. Rulesets are versioned and moddable — mods are first-class

The ruleset carries a `formatVersion` (schema evolution) and a `rulesetId` + version
(leaderboards bucket by ruleset). Official rulesets ship in `packages/content`;
**community rulesets and mods are the same kind of thing** — loaded, validated, and
hashed identically. This is the moddability substrate behind the working agreement's
"community proposes, guardrails screen, owner arbitrates."

### 5. Display strings are localization keys

Board names and any player-facing text are **localization keys** resolved at the UI layer
(ADR 0004) — never baked literals, never in the sim, and never in the hash.

## Consequences

- **Positive:** the community retunes balance and authors content/mods with no engine
  code; `rulesetHash` becomes meaningful and hard to spoof (per-ruleset leaderboards);
  balance changes are reviewable **data** PRs.
- **Negative:** a schema plus a load-time validator to build and maintain, and a precise
  canonical digest to implement; balance-as-data means the sim reads _all_ tuning from
  the ruleset.
- **Neutral:** the exact tower/creep/balance _fields and numbers_ finalize with the Core
  Gameplay PRD; this ADR fixes the **format, hash contract, and ruleset concept**; the
  encoding and canonicalization mechanics live in `docs/design-notes/ruleset-format.md`.
