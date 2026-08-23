import { describe, expect, it } from 'vitest';
import {
  createSaveSlot,
  createWebStorageDriver,
  decodeEnvelope,
  encodeEnvelope,
  quarantineKey,
  SAVE_VERSION,
  StorageError,
  STORAGE_NAMESPACE,
  webLockFn,
  type SaveSlot,
  type SaveSlotOptions,
  type WebStorageLike,
} from './index';

/** A `localStorage` stand-in with per-operation failure injection. */
function fakeStorage(seed: Record<string, string> = {}): WebStorageLike & {
  map: Map<string, string>;
  failWrites: boolean;
  failReads: boolean;
  failRemoves: boolean;
} {
  const map = new Map(Object.entries(seed));
  return {
    map,
    failWrites: false,
    failReads: false,
    failRemoves: false,
    getItem(key) {
      // The shape Safari private mode / a blocked-cookies profile actually throws with.
      if (this.failReads) throw new Error('SecurityError: read blocked');
      return map.get(key) ?? null;
    },
    setItem(key, value) {
      if (this.failWrites) throw new Error('QuotaExceededError');
      map.set(key, value);
    },
    removeItem(key) {
      if (this.failRemoves) throw new Error('SecurityError: remove blocked');
      map.delete(key);
    },
  };
}

const stringSlot = (
  storage: WebStorageLike | null,
  overrides: Partial<SaveSlotOptions<string>> = {},
): SaveSlot<string> =>
  createSaveSlot<string>({
    driver: createWebStorageDriver(storage),
    key: 'settings',
    deviceId: 'device-a',
    parse: (data) => (typeof data === 'string' ? data : undefined),
    now: () => 1000,
    ...overrides,
  });

describe('StorageDriver — the four invariants (design note)', () => {
  it('namespaces every key under the driver-owned prefix', async () => {
    const storage = fakeStorage();
    const driver = createWebStorageDriver(storage);
    await driver.set('settings', 'v');
    expect([...storage.map.keys()]).toEqual([`${STORAGE_NAMESPACE}settings`]);
    expect(await driver.get('settings')).toBe('v');
    await driver.remove('settings');
    expect(storage.map.size).toBe(0);
  });

  it('resolves undefined for a missing key rather than throwing', async () => {
    await expect(createWebStorageDriver(fakeStorage()).get('nope')).resolves.toBeUndefined();
  });

  it('REJECTS on an I/O error rather than swallowing it', async () => {
    const storage = fakeStorage();
    storage.failWrites = true;
    await expect(createWebStorageDriver(storage).set('settings', 'v')).rejects.toBeInstanceOf(
      StorageError,
    );
    storage.failWrites = false;
    storage.failReads = true;
    await expect(createWebStorageDriver(storage).get('settings')).rejects.toBeInstanceOf(
      StorageError,
    );
  });

  it('treats an absent store as an I/O failure on GET too, never as "no save yet"', async () => {
    await expect(createWebStorageDriver(null).get('settings')).rejects.toBeInstanceOf(StorageError);
  });
});

describe('the envelope (ADR 0008 §2)', () => {
  it('round-trips and carries the version, device and ordering metadata', () => {
    const raw = encodeEnvelope({
      saveVersion: SAVE_VERSION,
      deviceId: 'device-a',
      revision: 7,
      updatedAt: 42,
      data: { colourMode: 'protan' },
    });
    const decoded = decodeEnvelope(raw);
    expect(decoded).toEqual({
      status: 'ok',
      envelope: {
        saveVersion: SAVE_VERSION,
        deviceId: 'device-a',
        revision: 7,
        updatedAt: 42,
        data: { colourMode: 'protan' },
      },
    });
  });

  it('classifies a NEWER saveVersion as future — the rollback case §5 must not overwrite', () => {
    const raw = encodeEnvelope({
      saveVersion: SAVE_VERSION + 1,
      deviceId: 'device-b',
      revision: 1,
      updatedAt: 0,
      data: null,
    });
    expect(decodeEnvelope(raw)).toEqual({ status: 'future', saveVersion: SAVE_VERSION + 1 });
  });

  it('classifies absent, unparseable and non-envelope payloads', () => {
    expect(decodeEnvelope(undefined)).toEqual({ status: 'absent' });
    expect(decodeEnvelope('{not json')).toEqual({ status: 'corrupt' });
    expect(decodeEnvelope('[]')).toEqual({ status: 'corrupt' });
    expect(decodeEnvelope('{"saveVersion":0}')).toEqual({ status: 'corrupt' });
    expect(decodeEnvelope('{"saveVersion":1,"deviceId":"","revision":1,"updatedAt":0}')).toEqual({
      status: 'corrupt',
    });
    expect(decodeEnvelope('{"saveVersion":1,"deviceId":"d","revision":-1,"updatedAt":0}')).toEqual({
      status: 'corrupt',
    });
    // A bare JSON PRIMITIVE parses fine and is not an envelope — `5` is the one that would
    // slip past a `typeof parsed === 'object'` test written without the null/array guards.
    expect(decodeEnvelope('5')).toEqual({ status: 'corrupt' });
    expect(decodeEnvelope('"a string"')).toEqual({ status: 'corrupt' });
    expect(decodeEnvelope('null')).toEqual({ status: 'corrupt' });
    // A NON-INTEGER saveVersion: `1.5` is neither this version nor a future one, so it
    // must not sail through the `> SAVE_VERSION` comparison as "current".
    expect(decodeEnvelope('{"saveVersion":1.5,"deviceId":"d","revision":1,"updatedAt":0}')).toEqual(
      { status: 'corrupt' },
    );
    // `updatedAt` is informational, but a MISSING or non-finite one still means the
    // payload is not envelope-shaped — the field was previously validated with no test.
    expect(decodeEnvelope('{"saveVersion":1,"deviceId":"d","revision":1}')).toEqual({
      status: 'corrupt',
    });
    expect(
      decodeEnvelope('{"saveVersion":1,"deviceId":"d","revision":1,"updatedAt":"soon"}'),
    ).toEqual({ status: 'corrupt' });
  });
});

describe('the save slot — serialized writes and atomic revision allocation', () => {
  it('reads absent, then round-trips through the envelope', async () => {
    const storage = fakeStorage();
    const slot = stringSlot(storage);
    expect(await slot.read()).toEqual({ status: 'absent' });
    await slot.write('protan');
    expect(await slot.read()).toEqual({ status: 'ok', data: 'protan', revision: 1 });
  });

  it('allocates revision atomically: two overlapping writes cannot both read N', async () => {
    const storage = fakeStorage();
    const slot = stringSlot(storage);
    await Promise.all([slot.write('a'), slot.write('b'), slot.write('c')]);
    expect(await slot.read()).toMatchObject({ revision: 3 });
  });

  it('takes the cross-context lock around the read-modify-write', async () => {
    const storage = fakeStorage();
    const held: string[] = [];
    const slot = stringSlot(storage, {
      lock: async (name, fn) => {
        held.push(name);
        return fn();
      },
    });
    await slot.write('a');
    expect(held).toEqual(['settings:write']);
  });

  it('WITHOUT a real cross-context lock, concurrent contexts are last-write-wins', async () => {
    // The narrowed guarantee, pinned so it stays honest. Two SLOTS over one store is two
    // tabs: each has its own in-process queue, and `webLockFn(null)` — the fallback on a
    // host with no Web Locks — excludes nothing between them. Both read revision 1 and
    // both write 2; the later write wins and the earlier is lost.
    //
    // This is a supported configuration, not a defect, and the shipped Host never reaches
    // it (the Capacitor WebView is modern Chromium in a secure context). What must not
    // happen is the module claiming atomicity it cannot deliver — so the honest behaviour
    // is asserted rather than the aspirational one.
    const storage = fakeStorage();
    const seed = stringSlot(storage, { lock: webLockFn(null) });
    await seed.write('original');

    const tabA = stringSlot(storage, { lock: webLockFn(null) });
    const tabB = stringSlot(storage, { lock: webLockFn(null) });
    // CONCURRENT, which is the whole point — awaiting them in turn would let the second
    // read the first's envelope and produce a perfectly correct 1 → 2 → 3. In flight
    // together, with nothing excluding them, both read revision 1 and both write 2.
    await Promise.all([tabA.write('from A'), tabB.write('from B')]);

    const final = await seed.read();
    expect(final).toMatchObject({ status: 'ok', data: 'from B', revision: 2 });
    // A's write is GONE — not merged, not detectable from the envelope. That is what
    // "last-write-wins" means, and why the module documents it instead of implying a
    // localStorage mutex would fix it (it would race the same way).
  });

  it('does NOT advance revision when the write fails', async () => {
    const storage = fakeStorage();
    const slot = stringSlot(storage);
    await slot.write('a');
    storage.failWrites = true;
    await expect(slot.write('b')).rejects.toBeInstanceOf(StorageError);
    storage.failWrites = false;
    expect(await slot.read()).toEqual({ status: 'ok', data: 'a', revision: 1 });
  });

  it('a rejected write does not poison the queue', async () => {
    const storage = fakeStorage();
    const slot = stringSlot(storage);
    storage.failWrites = true;
    await expect(slot.write('a')).rejects.toBeInstanceOf(StorageError);
    storage.failWrites = false;
    await expect(slot.write('b')).resolves.toBeUndefined();
    expect(await slot.read()).toMatchObject({ data: 'b', revision: 1 });
  });

  it('preserves a NEWER save read-only and refuses to overwrite it (ADR 0008 §5)', async () => {
    const stored = encodeEnvelope({
      saveVersion: SAVE_VERSION + 1,
      deviceId: 'device-b',
      revision: 9,
      updatedAt: 0,
      data: 'from the future',
    });
    const storage = fakeStorage({ [`${STORAGE_NAMESPACE}settings`]: stored });
    const slot = stringSlot(storage);
    expect(await slot.read()).toEqual({ status: 'incompatible', reason: 'future' });
    await expect(slot.write('mine')).rejects.toThrow(/newer saveVersion/);
    expect(storage.map.get(`${STORAGE_NAMESPACE}settings`)).toBe(stored);
  });

  it('quarantines a corrupt original BEFORE fresh state is written, never discarding it', async () => {
    const storage = fakeStorage({ [`${STORAGE_NAMESPACE}settings`]: '{not json' });
    const slot = stringSlot(storage);
    expect(await slot.read()).toEqual({ status: 'incompatible', reason: 'corrupt' });
    expect(storage.map.get(`${STORAGE_NAMESPACE}${quarantineKey('settings')}`)).toBe('{not json');
    await slot.write('fresh');
    expect(await slot.read()).toMatchObject({ data: 'fresh', revision: 1 });
  });

  it('treats a wrong-shaped `data` as corrupt — a slot never hands back an unchecked shape', async () => {
    const stored = encodeEnvelope({
      saveVersion: SAVE_VERSION,
      deviceId: 'device-a',
      revision: 1,
      updatedAt: 0,
      data: { not: 'a string' },
    });
    const storage = fakeStorage({ [`${STORAGE_NAMESPACE}settings`]: stored });
    expect(await stringSlot(storage).read()).toEqual({ status: 'incompatible', reason: 'corrupt' });
    expect(storage.map.get(`${STORAGE_NAMESPACE}${quarantineKey('settings')}`)).toBe(stored);
  });

  it('initialises nothing while the corrupt original cannot be quarantined', async () => {
    const storage = fakeStorage({ [`${STORAGE_NAMESPACE}settings`]: '{not json' });
    storage.failWrites = true;
    const slot = stringSlot(storage);
    await expect(slot.read()).rejects.toBeInstanceOf(StorageError);
    await expect(slot.write('fresh')).rejects.toBeInstanceOf(StorageError);
    // The original is still exactly where it was — no fresh state landed on top of it.
    expect(storage.map.get(`${STORAGE_NAMESPACE}settings`)).toBe('{not json');
    expect(storage.map.has(`${STORAGE_NAMESPACE}${quarantineKey('settings')}`)).toBe(false);
  });

  it('clear() removes the payload and leaves the quarantined original alone', async () => {
    const storage = fakeStorage({ [`${STORAGE_NAMESPACE}settings`]: '{not json' });
    const slot = stringSlot(storage);
    await slot.read();
    await slot.clear();
    expect(storage.map.get(`${STORAGE_NAMESPACE}settings`)).toBeUndefined();
    expect(storage.map.get(`${STORAGE_NAMESPACE}${quarantineKey('settings')}`)).toBe('{not json');
  });

  it('clear() REFUSES a newer save — deleting one is worse than the overwrite write refuses', async () => {
    // The asymmetry this closes: `write` politely declined to overwrite a future payload
    // while `clear` deleted it outright, so the gentler operation was guarded and the
    // destructive one was not. Both now run the same guard, because there is only one
    // mutation path left to put it on.
    const stored = encodeEnvelope({
      saveVersion: SAVE_VERSION + 1,
      deviceId: 'device-b',
      revision: 9,
      updatedAt: 0,
      data: 'from the future',
    });
    const storage = fakeStorage({ [`${STORAGE_NAMESPACE}settings`]: stored });
    const slot = stringSlot(storage);
    await expect(slot.clear()).rejects.toThrow(/newer saveVersion/);
    expect(storage.map.get(`${STORAGE_NAMESPACE}settings`)).toBe(stored);
  });

  it('clear() surfaces an I/O failure rather than reporting a removal that did not happen', async () => {
    // A VALID envelope, so the only thing that can reject is `removeItem`. Seeding a
    // non-JSON payload sent `load()` down the corrupt branch first, which quarantined
    // before `remove` ran — the test then covered two paths and proved neither, and the
    // `parse` override never even executed.
    const stored = encodeEnvelope({
      saveVersion: SAVE_VERSION,
      deviceId: 'device-a',
      revision: 1,
      updatedAt: 0,
      data: 'x',
    });
    const storage = fakeStorage({ [`${STORAGE_NAMESPACE}settings`]: stored });
    const slot = stringSlot(storage);
    storage.failRemoves = true;
    await expect(slot.clear()).rejects.toBeInstanceOf(StorageError);
    expect(storage.map.get(`${STORAGE_NAMESPACE}settings`)).toBe(stored);
    // And nothing was quarantined on the way — this path never classified anything corrupt.
    expect(storage.map.has(`${STORAGE_NAMESPACE}${quarantineKey('settings')}`)).toBe(false);
  });

  it('the FIRST quarantined original wins — a second corruption never overwrites it', async () => {
    // "Never deletes" has to survive a second corruption. Overwriting the preserved
    // original with a later one is a delete wearing a different verb, and it destroys the
    // copy most likely to explain how the slot went wrong in the first place.
    const storage = fakeStorage({ [`${STORAGE_NAMESPACE}settings`]: '{first corruption' });
    const slot = stringSlot(storage);
    await slot.read();
    expect(storage.map.get(`${STORAGE_NAMESPACE}${quarantineKey('settings')}`)).toBe(
      '{first corruption',
    );

    // A fresh write lands, and is then corrupted again by something outside this slot.
    await slot.write('healthy');
    storage.map.set(`${STORAGE_NAMESPACE}settings`, '{second corruption');
    await slot.read();

    expect(storage.map.get(`${STORAGE_NAMESPACE}${quarantineKey('settings')}`)).toBe(
      '{first corruption',
    );
  });

  it('quarantines the bytes it CLASSIFIED, never a re-read (the two-tab race)', async () => {
    // The race this pins: tab A reads a corrupt payload, and before it can preserve that
    // payload, tab B writes a perfectly good envelope over the key. A quarantine that
    // re-read the key would then copy TAB B'S VALID DATA into the quarantine slot —
    // destroying the corrupt original it exists to preserve, and destroying it with
    // something that was never corrupt. The driver below IS that interleave: the first
    // `get` answers corrupt, every later one answers the valid envelope tab B wrote.
    const valid = encodeEnvelope({
      saveVersion: SAVE_VERSION,
      deviceId: 'device-b',
      revision: 4,
      updatedAt: 0,
      data: 'tab B got here first',
    });
    const CORRUPT = '{not json';
    const written = new Map<string, string>();
    let gets = 0;
    const racingDriver = {
      get: (k: string): Promise<string | undefined> => {
        if (k !== 'settings') return Promise.resolve(written.get(k));
        gets += 1;
        return Promise.resolve(gets === 1 ? CORRUPT : valid);
      },
      set: (k: string, v: string): Promise<void> => {
        written.set(k, v);
        return Promise.resolve();
      },
      remove: (k: string): Promise<void> => {
        written.delete(k);
        return Promise.resolve();
      },
    };
    const slot = createSaveSlot<string>({
      driver: racingDriver,
      key: 'settings',
      deviceId: 'device-a',
      parse: (data) => (typeof data === 'string' ? data : undefined),
      now: () => 1000,
    });

    expect(await slot.read()).toEqual({ status: 'incompatible', reason: 'corrupt' });
    // The CORRUPT bytes are what was preserved — not tab B's envelope.
    expect(written.get(quarantineKey('settings'))).toBe(CORRUPT);
    expect(written.get(quarantineKey('settings'))).not.toBe(valid);
    // And tab B's valid write survives: the read path deletes nothing at all.
    expect(written.has('settings')).toBe(false); // never written by US
    expect(gets).toBe(1); // one read, so there is no second value to be confused by
  });

  it('takes the cross-context lock on the READ path too, since its corrupt branch mutates', async () => {
    const storage = fakeStorage({ [`${STORAGE_NAMESPACE}settings`]: '{not json' });
    const held: string[] = [];
    const slot = stringSlot(storage, {
      lock: async (name, fn) => {
        held.push(name);
        return fn();
      },
    });
    await slot.read();
    expect(held).toEqual(['settings:write']);
  });

  it('TWO INSTANCES on the same driver+key share one queue — a handle is not a lock', async () => {
    // `createSaveSlot` is a cheap handle and nothing stops a second consumer building its
    // own for the same bytes. When the queue was per INSTANCE that made the within-context
    // guarantee vacuous exactly where it matters: two handles to the same key could both
    // read revision N and both write N+1. The queue now hangs off (driver, key) — the
    // identity of the DATA — so a second instance joins the first's chain.
    const storage = fakeStorage();
    const driver = createWebStorageDriver(storage);
    const mk = (): SaveSlot<string> =>
      createSaveSlot<string>({
        driver,
        key: 'settings',
        deviceId: 'device-a',
        parse: (data) => (typeof data === 'string' ? data : undefined),
        now: () => 1000,
      });
    const a = mk();
    const b = mk();

    // Interleaved and concurrent: with private chains these both read 0 and both write 1.
    await Promise.all([a.write('a1'), b.write('b1'), a.write('a2'), b.write('b2')]);
    expect(await mk().read()).toMatchObject({ revision: 4 });
  });

  it('first-preserved-wins holds ACROSS instances too', async () => {
    const storage = fakeStorage({ [`${STORAGE_NAMESPACE}settings`]: '{first corruption' });
    const driver = createWebStorageDriver(storage);
    const mk = (): SaveSlot<string> =>
      createSaveSlot<string>({
        driver,
        key: 'settings',
        deviceId: 'device-a',
        parse: (data) => (typeof data === 'string' ? data : undefined),
        now: () => 1000,
      });
    // Two handles racing to classify the same corrupt payload must not clobber each
    // other's quarantine — the shared queue is what makes the conditional write atomic.
    await Promise.all([mk().read(), mk().read()]);
    expect(storage.map.get(`${STORAGE_NAMESPACE}${quarantineKey('settings')}`)).toBe(
      '{first corruption',
    );
  });

  it('revisions are per (device, SLOT) — independence is deliberate, not a bug', async () => {
    // Two slots on one device, written once each, both land on revision 1. That reads
    // like an ambiguous device-wide order, and it would be — if anything ever compared
    // revisions across slots. Nothing does, and nothing should: a settings envelope and a
    // playtrace envelope describe different data and can never be in conflict, so
    // resolution is per slot and comparing across them is a category error.
    //
    // Pinned as INTENT rather than left as an observation, because the obvious "fix" —
    // one shared per-device counter — would introduce a mutable value every slot must
    // read-modify-write, i.e. exactly the cross-context shared state whose atomicity the
    // test above shows cannot be guaranteed on every host.
    const storage = fakeStorage();
    const settings = stringSlot(storage, { key: 'settings' });
    const playtrace = stringSlot(storage, { key: 'playtrace' });

    await settings.write('a');
    await playtrace.write('b');
    expect(await settings.read()).toMatchObject({ revision: 1 });
    expect(await playtrace.read()).toMatchObject({ revision: 1 });

    // And they advance independently: one slot's traffic never moves the other's counter.
    await settings.write('a2');
    await settings.write('a3');
    expect(await settings.read()).toMatchObject({ data: 'a3', revision: 3 });
    expect(await playtrace.read()).toMatchObject({ data: 'b', revision: 1 });
  });
});

describe('webLockFn', () => {
  it('delegates to navigator.locks when the host has one', async () => {
    const names: string[] = [];
    const locks = {
      request<R>(name: string, cb: () => Promise<R>): Promise<R> {
        names.push(name);
        return cb();
      },
    };
    await expect(webLockFn(locks)('k', () => Promise.resolve(7))).resolves.toBe(7);
    expect(names).toEqual(['k']);
  });

  it('runs the callback directly where the API is absent', async () => {
    await expect(webLockFn(null)('k', () => Promise.resolve(7))).resolves.toBe(7);
    await expect(webLockFn(undefined)('k', () => Promise.resolve(8))).resolves.toBe(8);
  });
});
