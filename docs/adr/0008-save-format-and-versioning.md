# ADR 0008 — Save format and versioning

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

No save format exists; `StorageDriver` is only _named_ in `apps/mobile/README.md`.
`docs/CONTEXT.md` draws the canonical distinction: a **save is a state snapshot**,
a **replay is an input log** — separate concerns. `SimState` is serializable and the
RNG has clean snapshot/restore, so the primitives are there. We must define the
persistence format and seam before gameplay code. Decided in the co-own session:
**meta-progress only for MVP** (no mid-run resume), **cloud-ready envelope**, **local
for MVP**.

## Decision

### 1. An async `StorageDriver` seam in a shared package

A small async interface — `get(key)`, `set(key, value)`, `remove(key)`, namespaced —
implemented per platform (web: IndexedDB / `localStorage`; mobile/desktop: native),
so saves work identically everywhere. **Async** because native storage is async; the
sim and UI depend on the interface, never a concrete backend.

### 2. The save is a versioned, cloud-ready envelope

`{ saveVersion, deviceId, updatedAt, data }`:

- **`saveVersion`** gates schema migration (distinct from `simVersion` and
  `rulesetHash`).
- **`deviceId` + `updatedAt`** are the **cloud-sync-ready** fields — present and
  written now (locally), so future sync + conflict resolution is a _wiring_ job, not
  a format migration. Cheap now, expensive to retrofit.

### 3. What persists at MVP — meta-progress only

- **Settings** — accessibility, audio, controls, locale.
- **Campaign progress** — levels cleared, best result / stars per level.
- **Best scores + seeds** per level.

**No mid-run resume at MVP.** But the envelope **reserves a `runInProgress` slot** so
resumable runs can be added later with no format break — a serialized `SimState`
snapshot plus the input-log-so-far (per ADR 0006).

### 4. Migration is forward-only and fails safe

Each `saveVersion` bump ships a forward migration; loading an older save migrates it
up. A save that can't be migrated (corrupt or too old) **fails safe** — fresh state,
never a crash or a silently wrong load.

### 5. Determinism-clean serialization (for the reserved run slot)

When run-resume lands, the saved `SimState` uses the **same stable-key-ordered,
integer/fixed-point serialization as the world-hash**, so a resumed run continues
byte-identically. Settings and progress are plain data.

### 6. Save ≠ replay

A save is a state snapshot for the player's own device; a replay is the input log for
server score validation. Separate formats, separate versions (`saveVersion` vs
`simVersion` + `rulesetHash`). Leaderboard scores are never derived from a save.

## Consequences

- **Positive:** one persistence seam across web / mobile / desktop; cloud sync
  becomes a later wiring job, not a migration; MVP stays simple (no mid-run
  serialization) while the door is held open.
- **Negative:** the async `StorageDriver` ripples through everything that reads/writes
  saves (all storage access is async); `deviceId` / `updatedAt` are carried before
  sync exists (a small unused-field cost).
- **Neutral:** cloud sync and run-resume are deferred but **format-reserved**; the
  exact settings/progress fields finalize with the Core Gameplay PRD + UX.
