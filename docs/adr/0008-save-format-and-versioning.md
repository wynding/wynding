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

```
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
  bumped on every write. **Conflict resolution uses `revision` + `deviceId`, not
  wall-clock `updatedAt`** (device clocks drift, move backward, or tie on concurrent
  offline writes). `updatedAt` is carried as informational only. The exact merge
  policy is fixed when sync is built, but the monotonic primitive is present now so it
  is _decidable_ — the point of a cloud-ready envelope.

### 4. What persists at MVP — meta-progress only

Settings (accessibility, audio, controls, locale), campaign progress (levels cleared,
best result/stars per level), best scores + seeds per level. **No mid-run resume at
MVP**, but a **`runInProgress` slot is reserved** (see §5).

### 5. The reserved `runInProgress` slot carries full replay identity, not just a blob

To resume byte-identically after an app or content update, the slot stores
`{ seed, rulesetHash, simVersion, levelId, simState, tickInputsSoFar }`:

- the `simState` snapshot **including its `rngState`** (RNG state is part of
  `SimState`), captured **only at a tick boundary** (between whole ticks) so
  continuation is byte-identical;
- the **replay identity** from ADR 0006 — the original `seed` is _not_ recoverable
  from the advanced RNG, and `rulesetHash` + `simVersion` + `levelId` are needed to
  resume under the same behavior. Resume refuses (falls back cleanly) if `simVersion`
  or `rulesetHash` no longer match.

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
