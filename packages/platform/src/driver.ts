// driver.ts — the `StorageDriver` seam (ADR 0008 §1), implemented exactly as
// `docs/design-notes/save-format.md` specifies it. Nothing here invents a contract: the
// interface, its four invariants and the `wynding:` namespace are all that note's.
//
// The sim never imports this file (ADR 0008 §1's dependency rule). This package sits
// beside the app layer, not inside the deterministic core, which is why it may touch
// wall-clock time and host storage at all.

/** The four-invariant persistence seam every platform adapter honours identically:
 *
 *  - **async**, and a **missing key resolves `undefined`** (never throws);
 *  - values are **opaque serialized strings** the caller encodes and decodes;
 *  - **I/O errors reject** the promise (surfaced, never swallowed);
 *  - keys are **namespaced** under a driver-owned `wynding:` prefix — callers pass bare
 *    keys and never see the prefix.
 *
 *  A Capacitor-Preferences or desktop-native adapter drops in behind this interface
 *  without any consumer changing, which is the whole reason the seam exists. */
export interface StorageDriver {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The driver-owned key namespace. This origin is shared with the wynding.net landing
 *  site (the same reason `install.ts` prefixes its one key), so an unprefixed key would
 *  be reaching into a namespace we do not own. */
export const STORAGE_NAMESPACE = 'wynding:';

/** An I/O failure inside a driver. Distinct from "key missing", which is `undefined`. */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
  }
}

/** The `Storage` surface this adapter needs, declared structurally so the package stays
 *  DOM-free (its tsconfig has no `DOM` lib) and so a test can pass a fake that throws. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The `localStorage`-backed baseline driver — the one the web build and the Capacitor
 * WebView both run on today.
 *
 * DELIBERATELY UNPROBED, unlike `apps/web/src/install.ts`. That module probes writability
 * once at construction because it must decide *synchronously*, at every later read,
 * whether to answer from a memory mirror. This seam is async and its errors are part of
 * the contract: a Safari-private-mode `setItem` throws, the promise rejects, and the
 * consumer decides what an unwritable store means for *its* data — fail closed for a
 * privacy opt-out, degrade to session-scoped for a display preference. Swallowing the
 * rejection here would take that decision away from every consumer at once.
 *
 * `storage` being absent is itself an I/O failure for all three operations, `get`
 * included: answering `undefined` would be indistinguishable from "no save yet", and a
 * consumer would silently initialise fresh state on a device whose save it never read.
 */
export function createWebStorageDriver(storage: WebStorageLike | null | undefined): StorageDriver {
  const namespaced = (key: string): string => `${STORAGE_NAMESPACE}${key}`;
  const backing = (): WebStorageLike => {
    if (storage === null || storage === undefined) {
      throw new StorageError('no web storage is available in this environment');
    }
    return storage;
  };

  return {
    get(key: string): Promise<string | undefined> {
      try {
        const raw = backing().getItem(namespaced(key));
        return Promise.resolve(raw === null ? undefined : raw);
      } catch (cause) {
        return Promise.reject(new StorageError(`could not read ${key}`, { cause }));
      }
    },
    set(key: string, value: string): Promise<void> {
      try {
        backing().setItem(namespaced(key), value);
        return Promise.resolve();
      } catch (cause) {
        return Promise.reject(new StorageError(`could not write ${key}`, { cause }));
      }
    },
    remove(key: string): Promise<void> {
      try {
        backing().removeItem(namespaced(key));
        return Promise.resolve();
      } catch (cause) {
        return Promise.reject(new StorageError(`could not remove ${key}`, { cause }));
      }
    },
  };
}
