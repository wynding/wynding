# ADR 0007 — Level and content data format (the ruleset)

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

`rulesetHash` is currently a placeholder over `SIM_VERSION`, disconnected from any
content (`packages/replay`), and the content schema (`Level` / `Wave` in
`packages/content`) is minimal. Wynding's vision is a **community-tuned, moddable**
game, so balance and content must be tunable **without engine code**. We must define
the data format the sim reads — and what the "ruleset" _is_ — before gameplay code.

`AGENTS.md` already describes the sim as "a pure function of `(seed, ruleset,
inputs)`," but no ruleset object is threaded into `step()` yet. This ADR makes that
real.

## Decision

### 1. The "ruleset" is the complete, data-driven content the sim reads

The **ruleset** is a single validated data bundle containing:

- the **tower catalog** — per tower: cost, damage, range, fire rate, upgrade tiers,
  targeting, per-creep-kind modifiers (all integer / fixed-point);
- the **creep catalog** — per creep: hp, speed, armor, immunities, bounty;
- **board / level geometry** — grid size, entrance/exit cells, blocked cells (using
  `Cell`);
- **wave schedules** — the ordered spawns per level (drives the scheduler in ADR 0006);
- **global balance constants** — starting lives/bounty, sell-refund basis, interest,
  etc.

`step` becomes a pure function of **`(seed, ruleset, inputs)`** — the ruleset is
threaded in explicitly. **No balance magic-numbers live in engine code**; the sim
reads all tuning from the ruleset.

### 2. Format: JSON data files validated by a schema

Content is authored as **JSON** (data, not code), validated at load against a schema
(e.g. Zod / JSON Schema). This makes content **moddable without a build step or
engine code** — the community-tuning vision — while the schema keeps it typed and
safe. Determinism-clean: **integers / fixed-point only, no floats**; the load-time
validator rejects malformed or out-of-range data.

### 3. `rulesetHash` = a canonical hash of the active ruleset

Serialize the ruleset with **stable key ordering** and hash it (the engine
`fnv1a`/hash). This connects `rulesetHash` to real content: a replay is valid only
against the exact ruleset it was recorded under, so a balance change (a new ruleset)
invalidates old-ruleset replays for leaderboard purposes — which is correct, because
**scores are per-ruleset**.

**`rulesetHash` vs `simVersion`:** `simVersion` is the sim _engine_ behavior version
(code); `rulesetHash` is the _content/balance_ version (data). A balance tweak bumps
`rulesetHash` but not `simVersion`; a sim-engine change bumps `simVersion`.

### 4. Versioned and moddable — rulesets are first-class

The ruleset carries a `formatVersion` (schema evolution) and a `rulesetId` +
version (so leaderboards bucket by ruleset). Official rulesets ship in
`packages/content`; **community rulesets / mods are the same kind of thing** — a data
bundle loaded, validated, and hashed identically. This is the moddability substrate
and the mechanism behind the working agreement's "community proposes → guardrails
screen → owner arbitrates" balance path.

### 5. Content display strings are localization keys

Level names and any player-facing text in content are **localization keys** resolved
at the UI layer (ADR 0004) — never baked literals, and never enter the sim.

## Consequences

- **Positive:** the community can retune balance and author content/mods with no
  engine code — the moddability vision made concrete; `rulesetHash` becomes
  meaningful (per-ruleset leaderboards); balance changes are reviewable **data** PRs.
- **Negative:** a schema + load-time validator to build and maintain; balance-as-data
  means the sim must read _all_ tuning from the ruleset (no shortcuts to a code
  constant); careful canonical serialization for the hash.
- **Neutral:** the exact tower/creep/balance _fields and numbers_ finalize with the
  Core Gameplay PRD; this ADR fixes the **format and the ruleset concept**.
