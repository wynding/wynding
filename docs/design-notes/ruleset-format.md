# Design note — Ruleset data format and hashing

_Implements ADR 0007. Living implementation guidance for schema validation, parsing, and
hashing in `packages/sim` (`ruleset-schema.ts` / `ruleset.ts`), `packages/content` as the
artifact + registry seam, and `packages/engine` / `packages/sim` (hash and step). ADR 0007
owns the decisions; this note is the_ how.

## The step signature carries evolving state

A _match_ is pure over `(seed, ruleset, boardId, inputs)`, but a single **tick** must
consume the current simulation state:

```
step(state, ruleset, inputs) -> state
```

`state` carries the tick counter, creeps, towers, economy (bounty and lives), and the
**advanced `rngState`**. The ruleset is constant for the match and threaded in each tick;
the **initial** `state` derives from `(seed, boardId)`. Writing `step` as
`(seed, ruleset, inputs)` would drop the evolving state and is wrong. _(Addresses Codex
PR #6: "Preserve evolving state in the step contract.")_

## Field-level encoding discipline

Two independent loaders (client and server) must read identical numbers from the same
JSON, so the schema pins each numeric field:

- **integer** vs **fixed-point** (`FP_SHIFT = 8`, per `packages/engine/src/fixed.ts`);
- **unit** (tiles/tick, ticks, fixed-tiles, and so on);
- **signedness** and **min/max bounds**.

The loader rejects malformed, wrong-type, or out-of-range values. No floats in
sim-affecting fields.

## `rulesetHash`: normalize, then canonicalize, then digest

JSON-Schema validation alone does **not** define one hash input — it doesn't strip unknown
properties or resolve `null`-vs-omitted, and a Zod parse might transform differently. So
the procedure is fixed and identical on client and server:

1. **Normalize:** parse, apply schema defaults, **strip unknown fields**, **strip
   presentation-only fields** (below), and resolve `null`-vs-omitted to one canonical
   form.
2. **Canonicalize:** serialize the normalized object via **RFC 8785 JSON Canonicalization
   Scheme (JCS)** — object keys sorted by UTF-16 code unit, ECMAScript number formatting,
   UTF-8 output.
3. **Digest:** `rulesetHash = SHA-256(canonical UTF-8 bytes)` — a collision-resistant
   digest, **not** the engine's 32-bit `fnv1a` (too weak: accidental collisions appear at
   modest catalog scale, deliberate ones are trivial). The per-tick world-hash may stay on
   `fnv1a` — that's an internal determinism check, not an identity/security boundary.

_(Addresses Codex PR #6: "Specify normalization before canonicalizing rulesets.")_

### Presentation-only fields (excluded from the hash)

Localization keys (board names, tower/creep display names) and any other non-sim field.
Renaming a board must not invalidate replays, so only sim-affecting content is hashed.
_(SUPERSEDED 2026-08-12 — v2 resolves this by exclusion at the SCHEMA, not at the hash:
bundles carry no presentation fields at all (unknown properties are rejected, and board
`name` was deleted from the schema — see `normalizeForHash`'s header in
`packages/sim/src/ruleset.ts`), while display names live in the UI's `en` catalog
(`tower.<id>.name` / `creep.<id>.name`; a `board.<id>.name` key is deferred until a
second board first needs one — ADR 0004). The invariant this section wanted — renaming
must never invalidate replays — now holds trivially: there is nothing presentational in
the bundle to rename.)_

## Versioning

The ruleset carries `formatVersion` (schema evolution) and `rulesetId` + version
(leaderboard bucketing). Community rulesets and mods are the same bundle, loaded,
validated, and hashed identically.

## v2 load policy (M2 S1, 2026-07-27)

- The structural validator REJECTS unknown properties at load (strict) —
  normalization's strip-unknowns step is retained as defense in depth for
  the hash path, so the two never disagree.
- `immunities` is a set: parsing dedupes and sorts entries into enum order
  (`slow` before `stun`) — one canonical form, one hash.
- Parse input is capped at `MAX_RULESET_TEXT_UNITS` (1,048,576 UTF-16 code
  units — allocation-free and runtime-identical; an anti-absurd bound, not
  a wire protocol).
- Two independent loaders, one path: the server reads the artifact text
  from disk at cold start, the client carries the same file
  bundler-embedded as raw text; both feed `parseRulesetJson` →
  `validateRulesetShape` → `compileRuleset`, so their accepted domains
  cannot diverge.
