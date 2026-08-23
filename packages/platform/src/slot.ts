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
   *  already been quarantined by the time you see it, and the slot is then empty. */
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
  /** Remove this slot's payload. Leaves any quarantined original alone. */
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
   * Copy an unreadable original aside, THEN empty the slot.
   *
   * The order is the whole of ADR 0008 §5's "fresh state is initialized only after the
   * original is safely preserved": a `set` that rejects propagates out of `load` and
   * therefore out of whatever operation called it, so the corrupt payload is still
   * sitting at `key` and no fresh write ever reached it. Removing it only after the copy
   * lands is what lets the next write start clean instead of refusing forever.
   */
  async function quarantine(): Promise<void> {
    const raw = await driver.get(key);
    if (raw === undefined) return; // vanished under us — nothing left to preserve
    await driver.set(quarantineKey(key), raw);
    await driver.remove(key);
  }

  /** Read + classify. Runs inside the critical section on the write path, so the
   *  classification and the write it guards cannot be separated by another writer. */
  async function load(): Promise<{ read: SlotRead<T>; envelope: SaveEnvelope | null }> {
    const decoded = decodeEnvelope(await driver.get(key));
    if (decoded.status === 'absent') return { read: { status: 'absent' }, envelope: null };
    if (decoded.status === 'future') {
      return { read: { status: 'incompatible', reason: 'future' }, envelope: null };
    }
    if (decoded.status === 'corrupt') {
      await quarantine();
      return { read: { status: 'incompatible', reason: 'corrupt' }, envelope: null };
    }
    const data = parse(decoded.envelope.data);
    if (data === undefined) {
      // Envelope-shaped but not THIS slot's data. Unmigratable is unmigratable.
      await quarantine();
      return { read: { status: 'incompatible', reason: 'corrupt' }, envelope: null };
    }
    return {
      read: { status: 'ok', data, revision: decoded.envelope.revision },
      envelope: decoded.envelope,
    };
  }

  return {
    read(): Promise<SlotRead<T>> {
      return serialize(async () => (await load()).read);
    },
    write(data: T): Promise<void> {
      return serialize(() =>
        lock(`${key}:write`, async () => {
          const { read, envelope } = await load();
          // ONLY `future` refuses. A corrupt payload has been quarantined by the line
          // above and the slot is now empty, which is exactly when fresh state may be
          // initialised (ADR 0008 §5).
          if (read.status === 'incompatible' && read.reason === 'future') {
            throw new Error(
              `refusing to overwrite ${key}: it was written by a newer saveVersion ` +
                `(ADR 0008 §5 preserves it read-only)`,
            );
          }
          await driver.set(
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
          );
        }),
      );
    },
    clear(): Promise<void> {
      return serialize(() => lock(`${key}:write`, () => driver.remove(key)));
    },
  };
}
