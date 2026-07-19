# ADR 0008 — Save format and versioning

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

No save format exists; `StorageDriver` is only _named_ in `apps/mobile/README.md`.
`docs/CONTEXT.md` draws the canonical distinction: a **save is a state snapshot**, a
**replay is an input log**. `SimState` is already serializable (it includes its
`rngState`), so the primitives exist. We decide the persistence format and seam before
gameplay code. Co-own decisions: **meta-progress only for MVP**, **cloud-ready
envelope**, **local for MVP**. _(This ADR predates [`docs/roadmap.md`](../roadmap.md) and
its delivery vocabulary; read "MVP" here as this persistence scope. Per the roadmap it is
built in **Phase 2**, not the Phase 1 single-player release — the decisions below are
unchanged.)_ The `StorageDriver` contract and write-serialization mechanics live in
`docs/design-notes/save-format.md`.

## Decision

### 1. Persistence is an app/platform concern, not a sim dependency

`packages/sim` stays a **pure** function over serializable state and does **no I/O**
(dependency graph `types <- engine <- sim <- {render, replay, content} <- apps`). An
async `StorageDriver` seam lives in a shared **platform** package that the app/UI
orchestration uses — it hands serialized snapshots to and from the sim. **The sim never
imports storage.** This keeps the determinism gate intact.

### 2. The save is a versioned, cloud-ready envelope

A save wraps its data in a versioned envelope carrying a schema version (`saveVersion`,
distinct from `simVersion` / `rulesetHash`) and per-device write-ordering metadata. MVP
is **local — no sync, no conflicts**; "cloud-ready" means the conflict-resolution scheme
is cleanly _decidable_ later and the envelope can be extended to carry what it needs —
**not** that the MVP metadata already resolves cross-device merges. The ordering
primitive and its atomicity requirements are specified in the design note.

### 3. MVP persists meta-progress only; a run-resume slot is reserved

What persists at MVP: settings (accessibility, audio, controls, locale), campaign
progress, and best scores + seeds per level. **No mid-run resume at MVP**, but a
`runInProgress` slot is **reserved** in the format. When built, a resumable run carries
the full **replay identity** `{ seed, rulesetHash, simVersion, levelId }` plus a
tick-boundary `simState` snapshot — the original `seed` isn't recoverable from advanced
RNG state, so it's stored explicitly.

### 4. Resume is valid only within the same `simVersion` and `rulesetHash`

A determinism-affecting app update (new `simVersion`) or a content/balance change (new
`rulesetHash`) **invalidates an in-progress run** — it's discarded with a clean fallback,
not resumed. Byte-identical continuation across a behavior change would require pinning
the old simulator _and_ old ruleset (out of scope); losing a reserved, post-MVP
in-progress run across an infrequent determinism-affecting update is an acceptable cost.

### 5. Migration is forward-only; incompatible saves are preserved, never reset

Older `saveVersion` than the reader is migrated up. A newer `saveVersion` (app rollback
or staggered multi-device deploy) is preserved read-only and surfaced as an
incompatibility — **not** overwritten, so a newer device's valid save survives. Corrupt
or unmigratable data is **quarantined** (the original payload kept) and an incompatibility
surfaced; fresh state is initialized **only after** the original is safely preserved.
Never a silent discard.

### 6. Save ≠ replay

A save is a state snapshot for the player's own device; a replay is the input log for
server score validation. Separate formats, separate versions; leaderboard scores are
never derived from a save.

## Consequences

- **Positive:** the sim stays pure (dependency graph intact); one persistence seam across
  web/mobile/desktop; cloud sync becomes a later wiring job on a reserved envelope; no
  silent progress loss.
- **Negative:** async storage ripples through the app layer; per-device ordering metadata
  is carried before sync exists; quarantine plus incompatibility handling is more than a
  naive reset.
- **Neutral:** cloud sync and run-resume are deferred but **format-reserved**; exact
  settings/progress fields finalize with the Core Gameplay PRD and UX; the `StorageDriver`
  contract and write-serialization mechanics live in `docs/design-notes/save-format.md`.
