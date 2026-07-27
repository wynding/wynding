# Milestone specs

This directory holds Wynding's **milestone specs** — one per Phase-1 milestone (M1…M5). A
milestone spec pins the **concrete, build-ready detail** for its slice: the actual boards, towers,
creeps, waves, economy, and scoring **numbers**, plus the story breakdown (the build plan).

Milestone specs sit **below** the PRDs in the planning hierarchy
([vision](../vision.md) → [roadmap](../roadmap.md) → [PRDs](../prd/README.md) → milestone specs):

- A **PRD** fixes the durable **shapes and invariants** of a system and deliberately defers numbers.
- A **milestone spec** fills those numbers in for one slice, so there is nothing to guess during
  implementation. Its values are **first-pass, to be tuned** — they live in the ruleset (ADR 0007),
  so re-tuning is a `rulesetHash` bump, not a code change.

They come out of the same **grill-me → doc** flow as PRDs (see [../prd/README.md](../prd/README.md)),
and keep terminology consistent with [../CONTEXT.md](../CONTEXT.md).

## Index

- [M1 — First Vertical Slice](m1.md) — one board / one tower / one creep / one wave, the whole
  [Core Gameplay](../prd/0001-core-gameplay.md) loop at its thinnest, playable end to end.
- [M2 — Breadth](m2.md) — the combat vocabulary completes: 9 towers / 8 creeps / a 10-wave
  showcase arc with live wave-clear + early-call bonuses, wave preview, and air + anti-air,
  on M1's board.

## Required: the completeness boundary

A spec that pins per-tick or ordering semantics can always be asked for one more rule, so any
milestone spec that pins them ships a **completeness boundary** section — in its first draft, not
after review asks for it. The boundary states three things: (a) what the spec deliberately does
**not** pin, named as a class rather than case by case; (b) who fixes the residual — normally the
implementing story, which decides it in code; and (c) which deterministic artifact **arbitrates**
it thereafter, so the answer is checkable rather than argued (the determinism golden and its
`simVersion` pin, a schema, a test). This is not a license to leave things vague: "nothing to
guess during implementation" still holds, because every question is either pinned here or handed,
by name, to the story and the artifact that settles it. A finding below the boundary is answered
by citing it. Specs written before this rule (M1) are not retrofitted — their residual semantics
were settled in implementation and are pinned by the determinism golden.
