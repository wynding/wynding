// slot.ts — the app-layer save manager the design note specifies: a per-key serialized
// write queue that makes `revision` allocation atomic, plus ADR 0008 §5's
// migrate-or-preserve rules. The bare `StorageDriver` `get`/`set` are NOT assumed atomic
// on their own — serialization is this module's job, exactly as the note says.

import type { StorageDriver } from './driver';
import { SAVE_VERSION, decodeEnvelope, encodeEnvelope, type SaveEnvelope } from './envelope';

/** Mutual exclusion around a read-modify-write, across whatever contexts share the
 *  store. On the web that is the **Web Locks API** (two tabs, overlapping autosaves);
 *  inside a single-WebView host there is nothing to contend with and the in-process
 *  queue alone suffices. */
export type LockFn = <R>(name: string, fn: () => Promise<R>) => Promise<R>;

/** The `navigator.locks` surface, declared structurally so this package stays DOM-free. */
export interface LockManagerLike {
  request<R>(name: string, callback: () => Promise<R>): Promise<R>;
}

/** Wrap a host `navigator.locks` as a {@link LockFn}. Falls back to running the callback
 *  directly where the API is absent (older WebKit, a non-secure context): the in-process
 *  queue below still serializes this document's own writes, which is the whole of the
 *  contention that exists when there is only one context. */
export function webLockFn(locks: LockManagerLike | null | undefined): LockFn {
  if (locks === null || locks === undefined) {
    return <R>(_name: string, fn: () => Promise<R>): Promise<R> => fn();
  }
  return <R>(name: string, fn: () => Promise<R>): Promise<R> => locks.request(name, fn);
}

export type SlotRead<T> =
  | { readonly status: 'ok'; readonly data: T; readonly revision: number }
  | { readonly status: 'absent' }
  /** ADR 0008 §5, surfaced rather than silently repaired. `future` is permanent for as
   *  long as the newer payload sits there — it is never overwritten. `corrupt` has
   *  already been copied to the quarantine key by the time you see it; the original stays
   *  at its own key until a write replaces it, so nothing is ever deleted. */
  | { readonly status: 'incompatible'; readonly reason: 'future' | 'corrupt' };

export interface SaveSlot<T> {
  /** Read this slot. Rejects on an I/O error (the driver's contract) — a MISSING key is
   *  `{ status: 'absent' }`, not a rejection. */
  read(): Promise<SlotRead<T>>;
  /** Write `data`, allocating the next `revision` atomically. Rejects on an I/O error
   *  and on a refusal to overwrite a newer save; a failed write does not advance
   *  `revision`, because the counter lives in the stored envelope and is re-read inside
   *  the critical section rather than cached here. */
  write(data: T): Promise<void>;
  /** Remove this slot's payload. Leaves any quarantined original alone, and REFUSES a
   *  payload written by a newer `saveVersion` exactly as {@link SaveSlot.write} does —
   *  a deletion the ADR forbids overwriting is worse, not better. */
  clear(): Promise<void>;
}

export interface SaveSlotOptions<T> {
  readonly driver: StorageDriver;
  /** Bare key — the driver owns the `wynding:` namespace. */
  readonly key: string;
  readonly deviceId: string;
  /** Validate the envelope's `data` for THIS slot. Returning `undefined` classifies the
   *  payload as corrupt, so a slot never hands a consumer a shape it did not check. */
  readonly parse: (data: unknown) => T | undefined;
  /** Wall-clock source for the envelope's informational `updatedAt`. */
  readonly now?: () => number;
  readonly lock?: LockFn;
}

/** Where a corrupt original is preserved before fresh state is initialised. */
export const quarantineKey = (key: string): string => `${key}.quarantine`;

export function createSaveSlot<T>(options: SaveSlotOptions<T>): SaveSlot<T> {
  const { driver, key, deviceId, parse } = options;
  const now = options.now ?? ((): number => Date.now());
  const lock: LockFn = options.lock ?? (<R>(_n: string, fn: () => Promise<R>) => fn());

  // The per-key serialized write queue. Every critical section links onto this chain, so
  // two overlapping writes in THIS context can never both read `N` and write `N + 1`
  // (a lost update). `.catch` on the stored tail — not on the returned promise — keeps a
  // rejected operation from poisoning the queue while still surfacing to its own caller.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <R>(op: () => Promise<R>): Promise<R> => {
    const next = chain.then(op, op);
    chain = next.catch(() => undefined);
    return next;
  };

  /**
   * Copy an unreadable original aside.
   *
   * TAKES THE BYTES IT WAS CLASSIFIED FROM, and never re-reads the key. An earlier
   * revision fetched the payload again in here, which was a lost-update bug with the
   * quarantine on the wrong side of it: between the classifying read and this one,
   * another context could land a perfectly good envelope, and the re-read would then
   * copy THAT to the quarantine slot — overwriting the corrupt original it exists to
   * preserve, with data that was never corrupt. Passing `raw` down makes the two
   * physically the same bytes.
   *
   * IT ALSO NEVER DELETES. The corrupt payload stays at `key` until a write overwrites
   * it, which is ADR 0008 §5's "fresh state is initialized ONLY AFTER the original is
   * safely preserved" with nothing destructive in the path at all: a `set` that rejects
   * propagates out of `load` and out of whatever operation called it, so a failed
   * quarantine leaves the original exactly where it was.
   *
   * FIRST PRESERVED WINS. The write is conditional on the quarantine slot being empty,
   * because "never deletes" has to survive a SECOND corruption: quarantine a corrupt
   * payload, let a fresh write land, let that one corrupt too, and an unconditional copy
   * would overwrite the first preserved original with the second — destroying data
   * through the very mechanism that exists to keep it. Overwriting is a delete wearing a
   * different verb. The earliest original is also the one most likely to explain how the
   * slot went wrong in the first place.
   */
  async function quarantine(raw: string): Promise<void> {
    if ((await driver.get(quarantineKey(key))) !== undefined) return;
    await driver.set(quarantineKey(key), raw);
  }

  /** Read + classify. Callers run it INSIDE the `${key}:write` lock — both of them, since
   *  the corrupt branch mutates — so the classification and anything it guards cannot be
   *  separated by another writer. It never takes that lock itself: Web Locks are not
   *  reentrant, so a lock request in here would deadlock against the one `write` holds. */
  async function load(): Promise<{ read: SlotRead<T>; envelope: SaveEnvelope | null }> {
    const raw = await driver.get(key);
    const decoded = decodeEnvelope(raw);
    if (decoded.status === 'absent') return { read: { status: 'absent' }, envelope: null };
    if (decoded.status === 'future') {
      return { read: { status: 'incompatible', reason: 'future' }, envelope: null };
    }
    // Both incompatible branches below are reached only with `raw` defined — `absent` is
    // the only classification a missing key can produce.
    if (decoded.status === 'corrupt') {
      await quarantine(raw as string);
      return { read: { status: 'incompatible', reason: 'corrupt' }, envelope: null };
    }
    const data = parse(decoded.envelope.data);
    if (data === undefined) {
      // Envelope-shaped but not THIS slot's data. Unmigratable is unmigratable.
      await quarantine(raw as string);
      return { read: { status: 'incompatible', reason: 'corrupt' }, envelope: null };
    }
    return {
      read: { status: 'ok', data, revision: decoded.envelope.revision },
      envelope: decoded.envelope,
    };
  }

  /**
   * THE ONE MUTATION PATH: lock → load/classify → guard → mutate.
   *
   * Every operation that changes this slot goes through here, and that is the point
   * rather than a tidiness preference. `clear` used to take the lock and then delete
   * WITHOUT the classification `write` performs, so a payload `write` politely refused to
   * overwrite could be destroyed outright by `clear` — deletion being strictly the worse
   * of the two. One path means a future operation cannot forget the guard, because there
   * is nowhere else to put it.
   *
   * `verb` only shapes the message; the refusal is identical either way.
   */
  function mutate<R>(verb: string, run: (envelope: SaveEnvelope | null) => Promise<R>): Promise<R> {
    return serialize(() =>
      lock(`${key}:write`, async () => {
        const { read, envelope } = await load();
        // ONLY `future` refuses. A corrupt payload has been copied aside by `load` —
        // successfully, or that would have rejected out of here — so retiring it now IS
        // "fresh state initialised after the original is safely preserved" (ADR 0008 §5).
        if (read.status === 'incompatible' && read.reason === 'future') {
          throw new Error(
            `refusing to ${verb} ${key}: it was written by a newer saveVersion ` +
              `(ADR 0008 §5 preserves it read-only)`,
          );
        }
        return run(envelope);
      }),
    );
  }

  return {
    read(): Promise<SlotRead<T>> {
      // UNDER THE LOCK, like every mutation — not because a read changes anything in the
      // ordinary case, but because the corrupt branch does, and a mutation outside the
      // lock would make this module's serialization claim false exactly where it matters
      // most. No `future` guard here: a newer save must be REPORTED, not thrown at.
      return serialize(() => lock(`${key}:write`, async () => (await load()).read));
    },
    write(data: T): Promise<void> {
      return mutate('overwrite', (envelope) =>
        driver.set(
          key,
          encodeEnvelope({
            saveVersion: SAVE_VERSION,
            deviceId,
            // Re-read inside the critical section, never cached: a failed write leaves
            // the stored envelope untouched, so the counter simply does not advance.
            revision: (envelope?.revision ?? 0) + 1,
            updatedAt: now(),
            data,
          }),
        ),
      );
    },
    clear(): Promise<void> {
      // Refuses a newer build's save for the same reason `write` does, and with more at
      // stake: this one cannot be undone by the next write. Nothing in the shipped app
      // calls `clear` today, so there is no wipe path that needs to override the refusal;
      // if one ever arrives it gets its own explicitly-named destructive API rather than
      // quietly widening this one.
      return mutate('clear', () => driver.remove(key));
    },
  };
}
