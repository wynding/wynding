# ADR 0008 — Save format and versioning

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

No save format exists; `StorageDriver` is only _named_ in `apps/mobile/README.md`.
`docs/CONTEXT.md` draws the canonical distinction: a **save is a state snapshot**, a
**replay is an input log**. `SimState` is serializable (and already includes its
`rngState`) and the RNG has clean snapshot/restore, so the primitives exist. We must
define the persistence format and seam before gameplay code. Decided in the co-own
session: **meta-progress only for MVP** (no mid-run resume), **cloud-ready envelope**,
**local for MVP**.

## Decision

### 1. Persistence is an app/platform concern — **not** a sim dependency

`packages/sim` stays a **pure** function that produces/consumes **serializable**
state and does **no I/O** (AGENTS.md dependency graph: `types <- engine <- sim <-
{render, replay, content} <- apps`). The async `StorageDriver` lives in a shared
**platform** package that the **app/UI orchestration** uses — it reads a serialized
snapshot from storage and hands it to the sim, and writes the sim's serialized state
back. The sim never imports the storage interface.

### 2. The `StorageDriver` contract

```typescript
interface StorageDriver {
  get(key: string): Promise<string | undefined>; // missing key -> undefined, not an error
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
```

Invariants every platform adapter (web IndexedDB/`localStorage`; mobile/desktop
native) must honor identically: **async**; a **missing key resolves `undefined`**
(never throws); values are **opaque serialized strings** the caller encodes/decodes;
**I/O errors reject** the promise (surfaced, never swallowed); keys are **namespaced**
under a driver-owned `wynding:` prefix.

### 3. The save is a versioned, cloud-ready envelope

`{ saveVersion, deviceId, revision, updatedAt, data }`:

- **`saveVersion`** gates schema migration (distinct from `simVersion` / `rulesetHash`).
- **`deviceId` + `revision`** — `revision` is a **monotonic per-device counter**
  bumped on every write; with `deviceId` it gives a per-device write order, preferred
  over wall-clock `updatedAt` (which drifts, moves backward, or ties on concurrent
  offline writes — so it's informational only). **This is the local write-ordering
  primitive, not a complete cross-device conflict resolver:** a per-device counter
  can't by itself establish causal order _across_ devices. MVP is **local — no sync,
  no conflicts**; when sync is built, the merge scheme (a version vector / causal
  metadata, or an explicit last-writer policy) is designed then and the envelope is
  extended to carry what it needs. "Cloud-ready" means that's cleanly _decidable_
  later, not that `(revision, deviceId)` already resolves it.

**Atomic revision allocation.** All save writes go through a **single-writer path** (a
per-key serialized write queue in the app-layer save manager; cross-tab concurrency —
two web tabs, overlapping autosaves — uses a lock, e.g. the Web Locks API). This makes
`revision` allocation atomic: two writers can't both read `N` and write `N + 1` (a lost
update). A **failed write does not advance `revision`.** The bare `StorageDriver`
`get`/`set` are not assumed atomic on their own — serialization is the save manager's
job.

### 4. What persists at MVP — meta-progress only

Settings (accessibility, audio, controls, locale), campaign progress (levels cleared,
best result/stars per level), best scores + seeds per level. **No mid-run resume at
MVP**, but a **`runInProgress` slot is reserved** (see §5).

### 5. The reserved `runInProgress` slot carries replay identity, not just a blob

A resumable run stores `{ seed, rulesetHash, simVersion, levelId, simState,
tickInputsSoFar }`:

- the `simState` snapshot **including its `rngState`** (RNG state is part of
  `SimState`), captured **only at a tick boundary** (between whole ticks) so
  continuation is byte-identical;
- the **replay identity** from ADR 0006 — the original `seed` is _not_ recoverable
  from the advanced RNG, and `levelId` selects the scheduler input.

**Resume is valid only within the same `simVersion` and `rulesetHash`.** A
determinism-affecting app update (new `simVersion`) or a content/balance change (new
`rulesetHash`) **invalidates the in-progress run** — it's discarded with a clean
fallback, not resumed. Byte-identical continuation across a behavior change would
require pinning the old simulator _and_ old ruleset (out of scope); losing an
in-progress run across an infrequent determinism-affecting update is an acceptable
cost for a reserved, post-MVP feature.

### 6. Migration is forward-only; incompatible saves are preserved, never silently reset

- **Older `saveVersion`** than the reader → migrated up.
- **Newer `saveVersion`** than the reader (app rollback / staggered multi-device
  deploy) → **not** treated as fresh, and **not overwritten** — preserved read-only
  and surfaced as an incompatibility, so a newer device's valid save survives.
- **Corrupt / unmigratable** → the original payload is **quarantined** (kept) and an
  explicit incompatibility result is surfaced; fresh state is initialized **only
  after** the original is safely preserved. Never a silent discard.

### 7. Save ≠ replay

A save is a state snapshot for the player's own device; a replay is the input log for
server score validation. Separate formats, separate versions; leaderboard scores are
never derived from a save.

## Consequences

- **Positive:** the sim stays pure (dependency graph intact); one persistence seam
  across web/mobile/desktop; cloud sync becomes a later wiring job with a sound
  conflict primitive (`revision`); no silent progress loss.
- **Negative:** async storage ripples through the app layer (all storage access is
  async); `deviceId` / `revision` carried before sync exists; quarantine +
  incompatibility handling is more than a naive reset.
- **Neutral:** cloud sync and run-resume are deferred but **format-reserved**; exact
  settings/progress fields finalize with the Core Gameplay PRD + UX.
