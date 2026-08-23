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
- **`deviceId` + `revision`** — `revision` is a **monotonic counter per `(device, slot)`**
  bumped on every write to that slot; with `deviceId` it orders one device's writes to one
  slot, preferred over wall-clock `updatedAt` (which drifts, moves backward, or ties on
  concurrent offline writes — so it is informational only). This is the local
  write-ordering primitive; it does **not** by itself establish causal order _across_
  devices (that scheme — a version vector / causal metadata, or an explicit last-writer
  policy — is designed when sync is built), and it is **not** a device-wide sequence
  across slots — see the two scope limits under _Atomic revision allocation_.

## Atomic revision allocation

All save writes go through a **single-writer path** — a per-key serialized write queue in
the app-layer save manager; cross-tab concurrency (two web tabs, overlapping autosaves)
uses a lock, e.g. the **Web Locks API**. This makes `revision` allocation atomic: two
writers can't both read `N` and write `N + 1` (a lost update). A **failed write does not
advance `revision`.** The bare `StorageDriver` `get` / `set` are not assumed atomic on
their own — serialization is the save manager's job.

Two scope limits, recorded because the unqualified claim above was read as stronger than
the implementation can be (Codex, PR #165):

- **The counter is per `(device, slot)`, not per device.** Each slot derives its next
  revision from its own stored envelope, so a device's first write to two different slots
  produces `(D, 1)` twice. That is deliberate: conflict resolution is per slot — a
  settings envelope and a playtrace envelope describe different data and can never be in
  conflict — so comparing revisions _across_ slots is a category error, and nothing does
  it. A shared per-device counter would buy a device-wide order no consumer wants, at the
  price of one more cross-context mutable on every write.
- **Cross-context atomicity is a property of the host.** Within a context the serialized
  queue always holds. Across contexts it holds only where the host provides Web Locks;
  where it does not, the fallback runs each context's critical section independently and
  concurrent writers are **last-write-wins**, with duplicate revisions possible and one
  update lost. A `localStorage`-based mutex is not the fix — it is itself a read-then-write
  and races the same way. The shipped Host is unaffected (the Capacitor WebView is modern
  Chromium in a secure context); this describes legacy web only.

## The reserved `runInProgress` slot

`{ seed, rulesetHash, simVersion, boardId, simState, tickInputsSoFar }`:

- the `simState` snapshot **including its `rngState`**, captured **only at a tick
  boundary** (between whole ticks) so continuation is byte-identical;
- the replay identity from ADR 0006 — the original `seed` is **not** recoverable from the
  advanced RNG, and `boardId` selects the scheduler input.

Resume is valid only within the same `simVersion` and `rulesetHash` (ADR 0008 §4).

## Migration and quarantine

- Older `saveVersion` is migrated up.
- Newer `saveVersion` (rollback or staggered deploy) is preserved read-only and surfaced
  as incompatible — **not** overwritten.
- Corrupt or unmigratable data is **quarantined** (the original payload kept) and an
  incompatibility surfaced; fresh state is initialized **only after** the original is
  safely preserved. Never a silent discard.
