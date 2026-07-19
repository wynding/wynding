# Design note — Ruleset data format and hashing

_Implements ADR 0007. Living implementation guidance for `packages/content` (schema) and
`packages/engine` / `packages/sim` (hash and step). ADR 0007 owns the decisions; this
note is the_ how.

## The step signature carries evolving state

A _match_ is pure over `(seed, ruleset, levelId, inputs)`, but a single **tick** must
consume the current simulation state:

```
step(state, ruleset, inputs) -> state
```

`state` carries the tick counter, creeps, towers, economy (bounty and lives), and the
**advanced `rngState`**. The ruleset is constant for the match and threaded in each tick;
the **initial** `state` derives from `(seed, levelId)`. Writing `step` as
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

Localization keys (level names, tower/creep display names) and any other non-sim field.
Renaming a level must not invalidate replays, so only sim-affecting content is hashed.

## Versioning

The ruleset carries `formatVersion` (schema evolution) and `rulesetId` + version
(leaderboard bucketing). Community rulesets and mods are the same bundle, loaded,
validated, and hashed identically.
