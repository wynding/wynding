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
