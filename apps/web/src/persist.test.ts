import { describe, expect, it, vi } from 'vitest';
import { createWebStorageDriver, encodeEnvelope, SAVE_VERSION } from '@wynding/platform';
import type { WebStorageLike } from '@wynding/platform';
import {
  DEVICE_ID_KEY,
  SETTINGS_KEY,
  createBrowserStorageDriver,
  loadSettings,
  parseStoredSettings,
  resolveDeviceId,
} from './persist';
import { createSettings } from './settings';

const NS = 'wynding:';

function fakeStorage(seed: Record<string, string> = {}): WebStorageLike & {
  map: Map<string, string>;
  failWrites: boolean;
} {
  const map = new Map(Object.entries(seed));
  return {
    map,
    failWrites: false,
    getItem: (key) => map.get(key) ?? null,
    setItem(key, value) {
      if (this.failWrites) throw new Error('QuotaExceededError');
      map.set(key, value);
    },
    removeItem: (key) => void map.delete(key),
  };
}

const settingsEnvelope = (data: unknown): string =>
  encodeEnvelope({
    saveVersion: SAVE_VERSION,
    deviceId: 'device-a',
    revision: 3,
    updatedAt: 0,
    data,
  });

const load = async (
  storage: WebStorageLike | null,
  prefersReducedMotion = false,
  onUnavailable?: () => void,
) => {
  const driver = createWebStorageDriver(storage);
  return loadSettings({
    driver,
    prefersReducedMotion,
    deviceId: await resolveDeviceId(driver, { randomUUID: () => 'fixed-device-id' }),
    now: () => 1000,
    onUnavailable,
  });
};

describe('persist — hydrating settings through the ADR 0008 seam', () => {
  it('seeds from a stored payload through createSettings', async () => {
    const storage = fakeStorage({
      [`${NS}${SETTINGS_KEY}`]: settingsEnvelope({ colourMode: 'protan', reducedMotion: true }),
    });
    const p = await load(storage);
    expect(createSettings(p.seed).get()).toEqual({ colourMode: 'protan', reducedMotion: true });
  });

  it('falls back to the OS preference only when nothing is stored', async () => {
    expect(createSettings((await load(fakeStorage(), true)).seed).get()).toEqual({
      colourMode: 'default',
      reducedMotion: true,
    });
    // A stored `false` OUTRANKS an OS "reduce": the player turned motion back on.
    const storage = fakeStorage({
      [`${NS}${SETTINGS_KEY}`]: settingsEnvelope({ colourMode: 'default', reducedMotion: false }),
    });
    expect(createSettings((await load(storage, true)).seed).get().reducedMotion).toBe(false);
  });

  it('COERCES a junk stored value rather than trusting it (the untyped-seed future)', async () => {
    const storage = fakeStorage({
      [`${NS}${SETTINGS_KEY}`]: settingsEnvelope({ colourMode: 'bogus', reducedMotion: 'yes' }),
    });
    const p = await load(storage);
    // `isColourMode` rejects the string; the `=== true` coercion rejects the truthy
    // non-boolean. Both guards are only reachable on this seed path.
    expect(createSettings(p.seed).get()).toEqual({ colourMode: 'default', reducedMotion: false });
  });

  it('mints and stores a deviceId on first run, then reuses it', async () => {
    const storage = fakeStorage();
    await load(storage);
    expect(storage.map.get(`${NS}${DEVICE_ID_KEY}`)).toBe('fixed-device-id');
    storage.map.set(`${NS}${DEVICE_ID_KEY}`, 'already-here');
    (await load(storage)).write({ colourMode: 'default', reducedMotion: false });
    await vi.waitFor(() => expect(storage.map.has(`${NS}${SETTINGS_KEY}`)).toBe(true));
    expect(storage.map.get(`${NS}${DEVICE_ID_KEY}`)).toBe('already-here');
    expect(JSON.parse(storage.map.get(`${NS}${SETTINGS_KEY}`)!).deviceId).toBe('already-here');
  });

  it('writes through on change, inside the versioned envelope', async () => {
    const storage = fakeStorage();
    const p = await load(storage);
    p.write({ colourMode: 'tritan', reducedMotion: true });
    await vi.waitFor(() => expect(storage.map.has(`${NS}${SETTINGS_KEY}`)).toBe(true));
    expect(JSON.parse(storage.map.get(`${NS}${SETTINGS_KEY}`)!)).toMatchObject({
      saveVersion: SAVE_VERSION,
      revision: 1,
      data: { colourMode: 'tritan', reducedMotion: true },
    });
  });

  it('FAILS CLOSED on an unwritable store: one report, then no further writes', async () => {
    const storage = fakeStorage();
    const onUnavailable = vi.fn();
    const p = await load(storage, false, onUnavailable);
    storage.failWrites = true;
    p.write({ colourMode: 'protan', reducedMotion: false });
    await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
    expect(p.durable()).toBe(false);
    // Storage recovering does not re-open the gate — the seam stopped claiming durability
    // for the session rather than retrying on every toggle.
    storage.failWrites = false;
    p.write({ colourMode: 'deutan', reducedMotion: true });
    await Promise.resolve();
    expect(storage.map.has(`${NS}${SETTINGS_KEY}`)).toBe(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('FAILS CLOSED with no storage at all, and still seeds from the OS preference', async () => {
    const onUnavailable = vi.fn();
    const p = await load(null, true, onUnavailable);
    expect(p.durable()).toBe(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(createSettings(p.seed).get().reducedMotion).toBe(true);
    p.write({ colourMode: 'protan', reducedMotion: false }); // no throw, no write
  });

  it('starts fresh (not crashed) on a corrupt payload, having quarantined it first', async () => {
    const storage = fakeStorage({ [`${NS}${SETTINGS_KEY}`]: '{not json' });
    const p = await load(storage);
    expect(createSettings(p.seed).get()).toEqual({ colourMode: 'default', reducedMotion: false });
    expect(storage.map.get(`${NS}${SETTINGS_KEY}.quarantine`)).toBe('{not json');
    expect(p.durable()).toBe(true);
  });
});

describe('resolveDeviceId', () => {
  it('never rejects: an unreadable store still yields a session identity', async () => {
    await expect(resolveDeviceId(createWebStorageDriver(null))).resolves.toMatch(/-/);
  });

  it('does not overwrite an id already on the device', async () => {
    const storage = fakeStorage({ [`${NS}${DEVICE_ID_KEY}`]: 'existing' });
    await expect(
      resolveDeviceId(storage === null ? storage : createWebStorageDriver(storage)),
    ).resolves.toBe('existing');
  });

  it('SERIALIZES first-run creation — two tabs cannot mint two device ids', async () => {
    // The race: both tabs read an empty key, both mint, both write, and the loser's
    // envelopes are afterwards stamped with an id that is no longer the device's —
    // which makes `deviceId` + `revision`, ADR 0008 §2's per-device write order, describe
    // two devices that are one. A single real lock, shared by both callers, is what
    // settles it; the second read INSIDE the lock is what makes the loser adopt the
    // winner's id instead of overwriting it.
    const storage = fakeStorage();
    const driver = createWebStorageDriver(storage);
    let held = Promise.resolve<unknown>(undefined);
    const lock = <R>(_name: string, fn: () => Promise<R>): Promise<R> => {
      const next = held.then(fn, fn);
      held = next.catch(() => undefined);
      return next;
    };
    let minted = 0;
    const crypto = { randomUUID: () => `minted-${String(++minted)}` };

    const [a, b] = await Promise.all([
      resolveDeviceId(driver, crypto, lock),
      resolveDeviceId(driver, crypto, lock),
    ]);
    expect(a).toBe(b);
    expect(storage.map.get(`${NS}${DEVICE_ID_KEY}`)).toBe(a);
  });

  it('mints one even when the store refuses the write', async () => {
    const storage = fakeStorage();
    storage.failWrites = true;
    await expect(
      resolveDeviceId(createWebStorageDriver(storage), { randomUUID: () => 'minted' }),
    ).resolves.toBe('minted');
  });
});

describe('parseStoredSettings', () => {
  it('accepts a settings-shaped object and passes its values through untouched', () => {
    expect(parseStoredSettings({ colourMode: 42, reducedMotion: 'x', extra: 1 })).toEqual({
      colourMode: 42,
      reducedMotion: 'x',
    });
  });

  it('rejects anything that is not an object', () => {
    for (const value of [null, undefined, 7, 'x', []]) {
      expect(parseStoredSettings(value)).toBeUndefined();
    }
  });
});

describe('createBrowserStorageDriver', () => {
  it('degrades to a rejecting driver when even READING the property throws', async () => {
    const view = {
      get localStorage(): WebStorageLike {
        throw new Error('blocked cookies');
      },
    } as unknown as Window;
    await expect(createBrowserStorageDriver(view).get('k')).rejects.toThrow();
  });

  it('degrades to a rejecting driver with no view at all', async () => {
    await expect(createBrowserStorageDriver(null).get('k')).rejects.toThrow();
  });
});
