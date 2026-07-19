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
inputs)`," but no ruleset is threaded into `step()` yet. This ADR makes that real.

## Decision

### 1. The "ruleset" is the complete, data-driven content the sim reads

A single validated data bundle: the **tower catalog** (cost, damage, range, fire
rate, upgrade tiers, targeting, per-creep-kind modifiers), the **creep catalog** (hp,
speed, armor, immunities, bounty), **board/level geometry** (grid size, entrance/exit
cells, blocked cells), **wave schedules**, and **global balance constants**. The
**match outcome** is a pure function of `(seed, ruleset, levelId, inputs)`; concretely
a single tick is **`step(state, ruleset, inputs) → state`** — the ruleset is threaded
in each tick (it's constant for the match) and the initial `state` derives from the
`seed` and `levelId`. **No balance magic-numbers live in engine code** — the sim reads
all tuning from the ruleset.

### 2. Format: JSON validated by a schema, with explicit field-level encoding

Content is authored as **JSON** (data, not code), validated at load against a schema
(e.g. Zod / JSON Schema) — **moddable without a build step or engine code**. To keep
two independent loaders from interpreting the same JSON differently, **every numeric
field declares its encoding in the schema**: whether it's a plain **integer** or
**fixed-point** (`FP_SHIFT = 8`, per `packages/engine/src/fixed.ts`), its **unit**
(e.g. tiles/tick, ticks, fixed-tiles), **signedness**, and **min/max bounds**. The
loader rejects malformed, wrong-type, or out-of-range data. **No floats.**

### 3. `rulesetHash` = a collision-resistant hash of a precisely canonical form

- **Normalize, then canonicalize.** A defined **normalization** step runs first —
  part of the spec, identical on client and server, **not** an incidental effect of
  whichever validator (JSON-Schema validation alone doesn't strip unknown properties
  or resolve `null`-vs-omitted; a Zod parse might transform differently): parse →
  apply schema defaults → **strip unknown fields** → **strip presentation-only
  fields** (below) → resolve `null`-vs-omitted to one canonical form. The normalized
  object is then serialized via **RFC 8785 JSON Canonicalization Scheme (JCS)** —
  object keys sorted by **UTF-16 code unit**, ECMAScript **number formatting**
  (unambiguous for our bounded integers / fixed-point), **UTF-8** output. Explicit
  normalization + a named canonicalization standard leave no room for two loaders to
  disagree on key order, number serialization, or string encoding.
- **Presentation-only data is excluded from the hash.** Localization keys (level
  names, etc.) and other non-sim fields do **not** participate — they can't affect the
  sim, so renaming a level must not invalidate replays. Only sim-affecting content is
  hashed.
- **Digest:** `rulesetHash` = **SHA-256 over those canonical (JCS) UTF-8 bytes** — a
  collision-resistant digest, not the engine's 32-bit `fnv1a`. Because the replay carries only this value to identify the
  exact content and bucket scores, a 32-bit hash is too weak — accidental collisions
  appear at modest catalog scale and deliberate ones are trivial. (The per-tick
  world-hash may stay on fast `fnv1a`; that's an internal determinism check, not a
  security/identity boundary.)

**`rulesetHash` vs `simVersion`:** `simVersion` is the sim _engine_ behavior version
(code); `rulesetHash` is the _content/balance_ version (data). A balance tweak bumps
`rulesetHash`; a sim-engine change bumps `simVersion`.

### 4. Versioned and moddable — rulesets are first-class

The ruleset carries a `formatVersion` (schema evolution) and a `rulesetId` + version
(leaderboards bucket by ruleset). Official rulesets ship in `packages/content`;
**community rulesets / mods are the same kind of thing** — a data bundle loaded,
validated, and hashed identically. This is the moddability substrate behind the
working agreement's "community proposes → guardrails screen → owner arbitrates".

### 5. Content display strings are localization keys

Level names and any player-facing text are **localization keys** resolved at the UI
layer (ADR 0004) — never baked literals, never in the sim, and (per §3) never in the
hash.

## Consequences

- **Positive:** the community can retune balance and author content/mods with no
  engine code; `rulesetHash` becomes meaningful and hard to spoof (per-ruleset
  leaderboards); balance changes are reviewable **data** PRs.
- **Negative:** a schema + load-time validator to build and maintain; a precise
  canonicalization + SHA-256 digest to implement; balance-as-data means the sim reads
  _all_ tuning from the ruleset.
- **Neutral:** the exact tower/creep/balance _fields and numbers_ finalize with the
  Core Gameplay PRD; this ADR fixes the **format, encoding discipline, hash contract,
  and the ruleset concept**.
