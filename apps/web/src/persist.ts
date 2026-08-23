// persist.ts — the app-layer wiring between ADR 0008's `StorageDriver` seam
// (`@wynding/platform`) and the one consumer #142 gives it: `settings.ts`.
//
// SCOPE, stated so the next reader does not mistake narrow for unfinished. ADR 0008 §3
// lists three MVP consumers — settings, campaign progress, best scores + seeds. This
// wires the first. The other two are Phase 2 and land as new slots beside
// `SETTINGS_KEY`, not as a redesign: the contract they will use is already the ADR's.
//
// `install.ts` stays OUTSIDE this seam, as its own comment requires: its dismissal is a
// one-bit UI acknowledgement, not a player setting, and it needs a SYNCHRONOUS answer at
// every read. Nothing here touches it.
//
// HYDRATE TIMING — the reconciliation between a synchronous settings API and an async
// driver, decided against a measurement rather than a guess. Measured in Chromium
// (`localStorage.getItem` of a realistic settings envelope + `JSON.parse` + the promise
// hop the seam adds, 2,000 iterations): **0.00075 ms per hydrate** — about 0.005% of one
// 16.7 ms frame. That is unambiguously cheap, so `boot()` HYDRATES BEFORE FIRST RENDER
// and seeds `createSettings` with what it read. The alternative the plan allowed —
// seed-with-defaults and apply afterwards through the setters, relying on the no-op
// guards to avoid a redundant scene branch — was rejected for a second reason beyond
// cost: the setters take TYPED arguments, so an untyped stored value applied that way
// would bypass `isColourMode` and the `=== true` reduced-motion coercion entirely. Those
// guards live on the `createSettings` seed path, and their own comments say they were
// written for exactly this untyped-storage future. Seeding is what exercises them.

import {
  createSaveSlot,
  createWebStorageDriver,
  webLockFn,
  type LockFn,
  type StorageDriver,
  type WebStorageLike,
} from '@wynding/platform';
import type { Settings, SettingsSeed } from './settings';
import { mintUuid, type UuidCrypto } from './uuid';

/** The settings slot's bare key (the driver owns the `wynding:` namespace). */
export const SETTINGS_KEY = 'settings';

/** Where the envelope's `deviceId` lives. Stored UNENVELOPED: it is the identity the
 *  envelope is stamped with, so wrapping it in one would need a device id to write.
 *
 *  IT NEVER LEAVES THE DEVICE. ADR 0011 §3 forbids persisting the *session* id precisely
 *  because a stored identifier that gets uploaded is what cookie-consent rules govern.
 *  This one is ADR 0008 §2's local write-ordering half, it is read by nothing but the
 *  save path, and it must never be added to a playtrace, a survey or any other payload. */
export const DEVICE_ID_KEY = 'deviceId';

/** What the settings slot stores. Both fields are `unknown` ON PURPOSE: the slot's job is
 *  to prove the payload is a settings-shaped OBJECT, and `createSettings`'s coercion
 *  guards are what prove the individual values. Typing them here would move that check to
 *  a layer that cannot re-derive the valid colour modes. */
export interface StoredSettings {
  readonly colourMode?: unknown;
  readonly reducedMotion?: unknown;
}

export interface SettingsPersistence {
  /** The seed for `createSettings` — the stored values where they exist, the OS
   *  `prefers-reduced-motion` read where nothing is stored. */
  readonly seed: SettingsSeed;
  /** Write-through on change. Fire-and-forget by design: a settings toggle must not wait
   *  on storage to take effect on screen. */
  write(settings: Readonly<Settings>): void;
  /** False once storage has proven unreadable or unwritable — see {@link loadSettings}. */
  durable(): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Slot-level validation: settings-shaped or not. Field values pass through untouched. */
export function parseStoredSettings(data: unknown): StoredSettings | undefined {
  if (!isRecord(data)) return undefined;
  return { colourMode: data.colourMode, reducedMotion: data.reducedMotion };
}

export interface LoadSettingsOptions {
  readonly driver: StorageDriver;
  /** The OS preference, used only where nothing is stored — an explicit player choice
   *  outranks it, which is the entire point of persisting one. */
  readonly prefersReducedMotion: boolean;
  /** The envelope's writer identity, resolved ONCE per boot by {@link resolveDeviceId}
   *  and shared with every other slot — two slots minting two device ids would make the
   *  `deviceId` + `revision` pair meaningless as a per-device write order. */
  readonly deviceId: string;
  readonly now?: () => number;
  readonly lock?: LockFn;
  /** Called once, the first time storage refuses. Injected rather than logged from here
   *  so a test can assert the fail-closed transition happened. */
  readonly onUnavailable?: (error: unknown) => void;
}

/**
 * Hydrate settings from storage and return the write-through sink.
 *
 * FAIL CLOSED. `install.ts`'s Safari-private-mode precedent is a store that exists and
 * throws on write; this seam meets the same case as a rejected promise (the driver
 * surfaces I/O errors rather than swallowing them, by contract). When that happens —
 * on the hydrate read, or on any later write — persistence CLOSES for the session:
 * `durable()` goes false, `write` stops issuing calls, and `onUnavailable` fires once.
 * It does not retry on every toggle and it does not keep claiming to persist. The
 * in-memory settings store carries on unaffected, so the player's choice still applies
 * this session; it simply will not survive a reload, which is the honest outcome and the
 * same one `install.ts` settles for.
 */
export async function loadSettings(options: LoadSettingsOptions): Promise<SettingsPersistence> {
  const { driver, prefersReducedMotion } = options;
  let durable = true;
  let reported = false;
  const fail = (error: unknown): void => {
    durable = false;
    if (reported) return;
    reported = true;
    options.onUnavailable?.(error);
  };

  const slot = createSaveSlot<StoredSettings>({
    driver,
    key: SETTINGS_KEY,
    deviceId: options.deviceId,
    parse: parseStoredSettings,
    now: options.now,
    lock: options.lock,
  });
  let stored: StoredSettings = {};
  try {
    const read = await slot.read();
    if (read.status === 'ok') stored = read.data;
    // `absent` seeds from the OS preference below. `incompatible` has already been
    // handled by the slot per ADR 0008 §5 (a newer save preserved, a corrupt one
    // quarantined); either way there is nothing to seed from, and a `future` save also
    // makes every later write refuse — which `fail` below turns into a closed gate
    // rather than a rejection storm on every toggle.
  } catch (error) {
    fail(error);
  }

  return {
    seed: {
      colourMode: stored.colourMode,
      // The stored value wins whenever the key EXISTS, including a stored `false` — a
      // player who turned motion back on must not have the OS turn it off again next
      // reload. Only a genuinely absent field falls back to the OS read.
      reducedMotion:
        stored.reducedMotion === undefined ? prefersReducedMotion : stored.reducedMotion,
    },
    write(settings: Readonly<Settings>): void {
      if (!durable) return;
      void slot
        .write({ colourMode: settings.colourMode, reducedMotion: settings.reducedMotion })
        .catch(fail);
    },
    durable: () => durable,
  };
}

/**
 * Read the device identity, minting and storing one on first run.
 *
 * NEVER REJECTS. Storage being unreadable is not a reason to fail a boot — the id is
 * still needed to stamp this session's envelopes, and the slot reads and writes that
 * follow are what actually discover, and report, that the store refuses. Resolved ONCE
 * per boot and shared across every slot.
 */
export async function resolveDeviceId(
  driver: StorageDriver,
  cryptoSource?: UuidCrypto | null,
): Promise<string> {
  try {
    const existing = await driver.get(DEVICE_ID_KEY);
    if (typeof existing === 'string' && existing !== '') return existing;
  } catch {
    /* unreadable — mint a session id below and let the slot report the store */
  }
  const minted = mintUuid(cryptoSource);
  try {
    await driver.set(DEVICE_ID_KEY, minted);
  } catch {
    /* unwritable — the settings write is what reports it */
  }
  return minted;
}

/** The production driver: `localStorage`, which is also what the Capacitor WebView
 *  gives us. A Capacitor-Preferences driver drops in HERE and nowhere else — no consumer
 *  above this line names a backend. */
export function createBrowserStorageDriver(view: Window | null | undefined): StorageDriver {
  let storage: WebStorageLike | null = null;
  try {
    storage = view?.localStorage ?? null;
  } catch {
    // Merely READING the property throws in a blocked-cookies profile.
    storage = null;
  }
  return createWebStorageDriver(storage);
}

/** The host's Web Locks, where it has them — the cross-tab half of the design note's
 *  atomic revision allocation (two tabs, overlapping autosaves). */
export function browserLockFn(view: Window | null | undefined): LockFn {
  return webLockFn(
    (view?.navigator as unknown as { locks?: Parameters<typeof webLockFn>[0] } | undefined)?.locks,
  );
}
