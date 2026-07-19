# Design note — Save format and versioning

_Implements ADR 0008. Living implementation guidance for the shared platform package
(`StorageDriver`) and the app-layer save manager. ADR 0008 owns the decisions; this note
is the_ how.

## `StorageDriver` contract

```typescript
interface StorageDriver {
  get(key: string): Promise<string | undefined>; // missing key -> undefined, not an error
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
```

Invariants every adapter (web IndexedDB / `localStorage`; mobile and desktop native)
honors identically:

- **async**, and a **missing key resolves `undefined`** (never throws);
- values are **opaque serialized strings** the caller encodes and decodes;
- **I/O errors reject** the promise (surfaced, never swallowed);
- keys are **namespaced** under a driver-owned `wynding:` prefix.

The sim never imports this interface (ADR 0008 §1).

## The envelope

`{ saveVersion, deviceId, revision, updatedAt, data }`:

- **`saveVersion`** — schema-migration gate (distinct from `simVersion` / `rulesetHash`).
- **`deviceId` + `revision`** — `revision` is a **monotonic per-device counter** bumped on
  every write; with `deviceId` it gives a per-device write order, preferred over wall-clock
  `updatedAt` (which drifts, moves backward, or ties on concurrent offline writes — so it
  is informational only). This is the local write-ordering primitive; it does **not** by
  itself establish causal order _across_ devices (that scheme — a version vector / causal
  metadata, or an explicit last-writer policy — is designed when sync is built).

## Atomic revision allocation

All save writes go through a **single-writer path** — a per-key serialized write queue in
the app-layer save manager; cross-tab concurrency (two web tabs, overlapping autosaves)
uses a lock, e.g. the **Web Locks API**. This makes `revision` allocation atomic: two
writers can't both read `N` and write `N + 1` (a lost update). A **failed write does not
advance `revision`.** The bare `StorageDriver` `get` / `set` are not assumed atomic on
their own — serialization is the save manager's job.

## The reserved `runInProgress` slot

`{ seed, rulesetHash, simVersion, levelId, simState, tickInputsSoFar }`:

- the `simState` snapshot **including its `rngState`**, captured **only at a tick
  boundary** (between whole ticks) so continuation is byte-identical;
- the replay identity from ADR 0006 — the original `seed` is **not** recoverable from the
  advanced RNG, and `levelId` selects the scheduler input.

Resume is valid only within the same `simVersion` and `rulesetHash` (ADR 0008 §4).

## Migration and quarantine

- Older `saveVersion` is migrated up.
- Newer `saveVersion` (rollback or staggered deploy) is preserved read-only and surfaced
  as incompatible — **not** overwritten.
- Corrupt or unmigratable data is **quarantined** (the original payload kept) and an
  incompatibility surfaced; fresh state is initialized **only after** the original is
  safely preserved. Never a silent discard.
