import { describe, expect, it, vi } from 'vitest';
import type { SimInput } from '@wynding/sim';
import { MAX_INPUTS_PER_TICK, validate, type Replay } from '@wynding/replay';
import { getBundledRuleset } from '@wynding/content';
import {
  createSaveSlot,
  createWebStorageDriver,
  encodeEnvelope,
  SAVE_VERSION,
  type WebStorageLike,
} from '@wynding/platform';
import {
  MAX_RECENT_AGE_MS,
  MAX_RECENT_RUNS,
  OPT_OUT_KEY,
  PLAYTRACE_VERSION,
  browserDelivery,
  buildPlaytrace,
  createPlaytraceRecorder,
  formatPlaytraceExport,
  loadPlaytraceOptOut,
  parseStoredOptOut,
  playtraceFilename,
  playtraceReplay,
  type Playtrace,
  type PlaytraceSource,
  type StoredOptOut,
} from './playtrace';
import { createController } from './controller';

/**
 * THE ALLOWLIST, restated here as data.
 *
 * This list is the falsifiable half of "the allowlist is serialized EXPLICITLY, never an
 * object by reference" (#99 note 6, and ADR 0014 §4's `runId` rider). It is written out
 * by hand rather than derived from the type, because a derived list would move in
 * lock-step with the very drift it exists to catch. Adding a field to `Playtrace` fails
 * here first, which is exactly the review moment the note asks for.
 */
const ALLOWLIST = [
  'boardId',
  'capturedAt',
  'pendingInputs',
  'pendingInputsTruncated',
  'rulesetHash',
  'runId',
  'seed',
  'simVersion',
  'stateHash',
  'tickInputs',
  'ticksCompleted',
  'viewport',
] as const;

const replay = (tickInputs: readonly (readonly SimInput[])[] = []): Replay => ({
  seed: 7,
  boardId: 'board-1',
  rulesetHash: 'a'.repeat(64),
  simVersion: 15,
  tickInputs,
});

const source = (overrides: Partial<PlaytraceSource> = {}): PlaytraceSource => ({
  runId: 'run-abc',
  capturedAt: 1_000,
  replay: replay(),
  ticksCompleted: 0,
  stateHash: 'deadbeef',
  pendingInputs: [],
  viewport: 'standard',
  ...overrides,
});

describe('the payload allowlist (#99 note 6, ADR 0014 §4)', () => {
  it('is exactly these fields, and no more', () => {
    expect(Object.keys(buildPlaytrace(source())).sort()).toEqual([...ALLOWLIST]);
  });

  it('carries runId — the one field ADR 0014 asks of this capture', () => {
    expect(buildPlaytrace(source({ runId: 'r-42' })).runId).toBe('r-42');
    expect(ALLOWLIST).toContain('runId');
  });

  it('does NOT let a field added upstream ride in by inheriting into the payload', () => {
    // The trap the note names: a source object carrying a field nobody allowed. A
    // spread-based build would leak all three of these into the export.
    const leaky = {
      ...source(),
      colourMode: 'protan',
      keybindings: { pause: 'KeyP' },
      deviceId: 'device-uuid',
    } as unknown as PlaytraceSource;
    const built = buildPlaytrace(leaky) as unknown as Record<string, unknown>;
    expect(Object.keys(built).sort()).toEqual([...ALLOWLIST]);
    // Named individually, because these three are the ones ADR 0011 bans by name.
    expect(built.colourMode).toBeUndefined();
    expect(built.keybindings).toBeUndefined();
    expect(built.deviceId).toBeUndefined();
  });

  it('re-projects each command per variant, so an upstream field cannot ride a SimInput', () => {
    const leakyCommand = {
      kind: 'placeTower',
      anchor: { col: 1, row: 2, secretDepth: 9 },
      towerId: 'arrow',
      internalNote: 'should not travel',
    } as unknown as SimInput;
    const built = buildPlaytrace(
      source({ replay: replay([[leakyCommand]]), pendingInputs: [leakyCommand] }),
    );
    for (const cmd of [built.tickInputs[0]![0]!, built.pendingInputs[0]!]) {
      expect(Object.keys(cmd).sort()).toEqual(['anchor', 'kind', 'towerId']);
      expect(Object.keys((cmd as { anchor: object }).anchor).sort()).toEqual(['col', 'row']);
    }
  });

  it('carries the named viewport BUCKET, never raw dimensions (#99)', () => {
    expect(buildPlaytrace(source({ viewport: 'compact' })).viewport).toBe('compact');
    expect(ALLOWLIST).not.toContain('width');
    expect(ALLOWLIST).not.toContain('devicePixelRatio');
  });

  it('carries boardId, because seed + rulesetHash + versions do not pin the board (#99)', () => {
    expect(buildPlaytrace(source()).boardId).toBe('board-1');
  });

  it('treats ticksCompleted as a COUNT — 0 is legal and meaningful (#99 note 1)', () => {
    const built = buildPlaytrace(source({ ticksCompleted: 0 }));
    expect(built.ticksCompleted).toBe(0);
    expect(built.tickInputs).toEqual([]);
  });
});

describe('the pending-buffer cap (#99 note 3)', () => {
  const fill = (n: number): SimInput[] =>
    Array.from({ length: n }, (): SimInput => ({ kind: 'callWaveEarly' }));

  it('caps against the bound that actually governs a PER-TICK buffer', () => {
    // Not the run-wide `MAX_TOTAL_TOWER_COMMANDS` (1,000) #99 note 3 named: this buffer is
    // the controller's per-tick one, which `effectiveCap()` bounds by MAX_INPUTS_PER_TICK.
    // A cap 15x looser than the thing it bounds can never bind, and would have waved a
    // corrupted 999-entry buffer through while claiming to be bounded.
    const built = buildPlaytrace(source({ pendingInputs: fill(MAX_INPUTS_PER_TICK + 25) }));
    expect(built.pendingInputs).toHaveLength(MAX_INPUTS_PER_TICK);
  });

  it('flags a truncation rather than discarding silently', () => {
    expect(buildPlaytrace(source({ pendingInputs: fill(1) })).pendingInputsTruncated).toBe(false);
    expect(
      buildPlaytrace(source({ pendingInputs: fill(MAX_INPUTS_PER_TICK + 1) }))
        .pendingInputsTruncated,
    ).toBe(true);
  });

  it('carries the buffer under a NAMED key with a declared shape', () => {
    const built = buildPlaytrace(source({ pendingInputs: [{ kind: 'sellTower', tower: 3 }] }));
    expect(built.pendingInputs).toEqual([{ kind: 'sellTower', tower: 3 }]);
  });
});

describe('the recent-runs ring — bounded by run count AND elapsed time', () => {
  const trace = (runId: string): Omit<PlaytraceSource, 'capturedAt'> => ({
    runId,
    replay: replay(),
    ticksCompleted: 1,
    stateHash: 'h',
    pendingInputs: [],
    viewport: 'standard',
  });

  it('records the ratified bounds', () => {
    expect(MAX_RECENT_RUNS).toBe(10);
    expect(MAX_RECENT_AGE_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('keeps the most recent N runs and drops the oldest (#98: two runs later)', () => {
    let clock = 0;
    const recorder = createPlaytraceRecorder({ now: () => clock });
    for (let i = 0; i < MAX_RECENT_RUNS + 3; i++) {
      clock += 1_000;
      recorder.capture(trace(`run-${String(i)}`));
    }
    const runs = recorder.recent();
    expect(runs).toHaveLength(MAX_RECENT_RUNS);
    expect(runs[0]!.runId).toBe('run-3');
    expect(runs.at(-1)!.runId).toBe('run-12');
  });

  it('drops runs older than the elapsed-time bound even when the count is under the cap', () => {
    let clock = 0;
    const recorder = createPlaytraceRecorder({ now: () => clock });
    recorder.capture(trace('stale'));
    clock += MAX_RECENT_AGE_MS - 1;
    recorder.capture(trace('fresh'));
    expect(recorder.recent().map((r) => r.runId)).toEqual(['stale', 'fresh']);
    // One millisecond past the bound and the first run leaves — without a new capture.
    clock += 1;
    expect(recorder.recent().map((r) => r.runId)).toEqual(['fresh']);
  });

  it('EXPIRES ON SCHEDULE EVEN IF THE WALL CLOCK GOES BACKWARD', async () => {
    // ADR 0011 §3 rests the whole upload posture on linkage being BOUNDED, so a bound that
    // can be defeated is a promise that can be broken. Measured against `Date.now()` it
    // could be: step the wall clock backward and `now - capturedAt` goes negative, which is
    // smaller than any bound, so every run stayed eligible forever and nothing surfaced it.
    let wall = 1_000_000;
    let mono = 0;
    const recorder = createPlaytraceRecorder({
      now: () => wall,
      monotonicNow: () => mono,
    });
    recorder.capture(trace('run-1'));
    expect(recorder.recent()).toHaveLength(1);

    // The device's clock jumps a day into the past (an NTP correction, a bad RTC on wake).
    wall -= 24 * 60 * 60 * 1000;
    // Monotonic time advances past the bound regardless — it cannot regress.
    mono += MAX_RECENT_AGE_MS;

    expect(recorder.recent(), 'a backward wall clock kept the run alive').toEqual([]);
    expect(recorder.buildExport().runs).toEqual([]);
  });

  it('a backward wall step does NOT drop a run the monotonic clock says is fresh', async () => {
    // Monotonic cannot be moved by a clock correction, so when it says the entry is fresh,
    // it IS fresh. An earlier revision clamped ANY negative wall elapsed to expired, which
    // on Android — where `Date.now()` stepping back a few ms at NTP sync or RTC wake is
    // routine — would have wiped the whole ring in ordinary operation for no privacy gain.
    let wall = 1_000_000;
    const recorder = createPlaytraceRecorder({ now: () => wall, monotonicNow: () => 0 });
    recorder.capture(trace('run-1'));
    expect(recorder.recent()).toHaveLength(1);

    wall -= 1; // the smallest possible backward step, monotonic unmoved and fresh
    expect(recorder.recent()).toHaveLength(1);
  });

  it('a backward wall step DOES expire when the monotonic clock is unusable', async () => {
    // Where monotonic is absent or has itself regressed, wall time is all there is — and a
    // negative elapsed then means we cannot tell how old the entry is, so it expires. The
    // conservative direction, applied where it is the only information available.
    let wall = 1_000_000;
    const recorder = createPlaytraceRecorder({
      now: () => wall,
      monotonicNow: () => Number.NaN, // no usable monotonic source
    });
    recorder.capture(trace('run-1'));
    expect(recorder.recent()).toHaveLength(1);

    wall -= 1;
    expect(recorder.recent()).toEqual([]);
  });

  it('the WALL clock still expires a run the monotonic clock slept through', async () => {
    // The belt's real justification: `performance.now()` does not advance across system
    // suspend, so a WebView that sleeps eight hours wakes with a monotonic elapsed well
    // under the bound. Wall time is what catches that.
    let wall = 1_000_000;
    const recorder = createPlaytraceRecorder({ now: () => wall, monotonicNow: () => 0 });
    recorder.capture(trace('run-1'));
    wall += MAX_RECENT_AGE_MS; // eight hours of suspend; monotonic never moved
    expect(recorder.recent()).toEqual([]);
  });

  it('the count bound and the age bound compose, in that order', async () => {
    // Neither bound had ever seen the other: the count test used a clock that expires
    // nothing, and every age test used at most two runs. Age is filtered BEFORE the count
    // trim, so an expired entry cannot occupy one of the surviving slots.
    let mono = 0;
    const recorder = createPlaytraceRecorder({
      now: () => 1_000_000 + mono,
      monotonicNow: () => mono,
      maxRuns: 3,
      maxAgeMs: 100,
    });
    recorder.capture(trace('old-1'));
    recorder.capture(trace('old-2'));
    mono = 150; // both of the above are now past the age bound
    recorder.capture(trace('fresh-1'));
    recorder.capture(trace('fresh-2'));
    expect(recorder.recent().map((r) => r.runId)).toEqual(['fresh-1', 'fresh-2']);
  });

  it('uses a monotonic source BY DEFAULT, not the wall clock', async () => {
    // The default is the fallback production lands on if `main.ts`'s wiring is ever
    // dropped, and it was untested — swapping it to `Date.now()` survived every test.
    const spy = vi.spyOn(performance, 'now');
    try {
      const recorder = createPlaytraceRecorder({ now: () => 1_000_000 });
      recorder.capture(trace('run-1'));
      recorder.recent();
      expect(spy, 'the default bound is not reading a monotonic clock').toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('the monotonic bound expires a run whose wall clock has not moved at all', async () => {
    // The mirror case: a frozen or coarse wall clock must not keep a run alive either.
    let mono = 0;
    const recorder = createPlaytraceRecorder({ now: () => 1_000_000, monotonicNow: () => mono });
    recorder.capture(trace('run-1'));
    mono = MAX_RECENT_AGE_MS - 1;
    expect(recorder.recent()).toHaveLength(1);
    mono = MAX_RECENT_AGE_MS;
    expect(recorder.recent()).toEqual([]);
  });

  it('never exports a run past the bound, under either clock', async () => {
    // The export path is the one that would carry a run off-device, so the bound has to
    // hold there specifically — `buildExport` prunes before assembling the payload.
    for (const [name, advance] of [
      ['monotonic elapsed', (s: { wall: number; mono: number }) => (s.mono += MAX_RECENT_AGE_MS)],
      [
        'wall elapsed (suspend)',
        (s: { wall: number; mono: number }) => (s.wall += MAX_RECENT_AGE_MS),
      ],
    ] as const) {
      const state = { wall: 1_000_000, mono: 0 };
      const recorder = createPlaytraceRecorder({
        now: () => state.wall,
        monotonicNow: () => state.mono,
      });
      recorder.capture(trace('run-1'));
      advance(state);
      expect(recorder.buildExport().runs, `${name} let an expired run reach the export`).toEqual(
        [],
      );
    }
  });

  it('a backward wall clock alone does not empty an export the player asked for', async () => {
    // The other half of the same rule, asserted so the trade is explicit rather than
    // inherited: with monotonic saying the run is fresh, a clock correction must not turn
    // Export into a silent empty payload.
    const state = { wall: 1_000_000, mono: 0 };
    const recorder = createPlaytraceRecorder({
      now: () => state.wall,
      monotonicNow: () => state.mono,
    });
    recorder.capture(trace('run-1'));
    state.wall -= 1;
    expect(recorder.buildExport().runs.map((r) => r.runId)).toEqual(['run-1']);
  });

  it('exports every run still inside the window, under a versioned wrapper', () => {
    let clock = 5;
    const recorder = createPlaytraceRecorder({ now: () => clock });
    recorder.capture(trace('a'));
    clock = 9;
    recorder.capture(trace('b'));
    const payload = recorder.buildExport();
    expect(payload.playtraceVersion).toBe(PLAYTRACE_VERSION);
    expect(payload.exportedAt).toBe(9);
    expect(payload.runs.map((r) => r.runId)).toEqual(['a', 'b']);
    expect(payload.runs[0]!.capturedAt).toBe(5);
  });

  it('is in-memory only — the recorder persists nothing', () => {
    const recorder = createPlaytraceRecorder({ now: () => 0 });
    recorder.capture(trace('a'));
    expect(createPlaytraceRecorder({ now: () => 0 }).recent()).toEqual([]);
  });
});

describe('the durable opt-out (ADR 0011 condition 2)', () => {
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

  const settingsShapedOptOut = (data: unknown): string =>
    encodeEnvelope({
      saveVersion: SAVE_VERSION,
      deviceId: 'device-a',
      revision: 1,
      updatedAt: 0,
      data,
    });

  const slotFor = (storage: WebStorageLike | null) =>
    createSaveSlot<StoredOptOut>({
      driver: createWebStorageDriver(storage),
      key: OPT_OUT_KEY,
      deviceId: 'device-a',
      parse: parseStoredOptOut,
      now: () => 0,
    });

  it('defaults to opted IN on a device that has never chosen (the ADR’s posture)', async () => {
    expect((await loadPlaytraceOptOut(slotFor(fakeStorage()))).optedOut()).toBe(false);
  });

  it('persists a choice across a fresh load — NOT a session-scoped toggle', async () => {
    const storage = fakeStorage();
    await (await loadPlaytraceOptOut(slotFor(storage))).setOptedOut(true);
    expect((await loadPlaytraceOptOut(slotFor(storage))).optedOut()).toBe(true);
    // And back again.
    await (await loadPlaytraceOptOut(slotFor(storage))).setOptedOut(false);
    expect((await loadPlaytraceOptOut(slotFor(storage))).optedOut()).toBe(false);
  });

  it('FAILS CLOSED where storage exists but is unwritable', async () => {
    const storage = fakeStorage();
    storage.failWrites = true;
    const optOut = await loadPlaytraceOptOut(slotFor(storage));
    expect(optOut.optedOut()).toBe(false); // read succeeded: absent, so no choice yet
    await optOut.setOptedOut(false); // the player says "keep sending" — and it cannot be recorded
    expect(optOut.optedOut()).toBe(true); // so the protective answer wins
  });

  it('FAILS CLOSED where there is no storage at all', async () => {
    const optOut = await loadPlaytraceOptOut(slotFor(null));
    expect(optOut.optedOut()).toBe(true);
    await optOut.setOptedOut(false);
    expect(optOut.optedOut()).toBe(true);
  });

  it('FAILS CLOSED on an unreadable stored choice', async () => {
    const storage = fakeStorage({ [`${NS}${OPT_OUT_KEY}`]: '{not json' });
    expect((await loadPlaytraceOptOut(slotFor(storage))).optedOut()).toBe(true);
  });

  it('gates NOTHING about local capture or export (ADR 0011: local is ungated)', async () => {
    const optOut = await loadPlaytraceOptOut(slotFor(null));
    const recorder = createPlaytraceRecorder({ now: () => 0, optOut });
    recorder.capture({
      runId: 'r',
      replay: replay(),
      ticksCompleted: 0,
      stateHash: 'h',
      pendingInputs: [],
      viewport: 'standard',
    });
    expect(recorder.uploadOptedOut()).toBe(true);
    expect(recorder.recent()).toHaveLength(1);
    expect(recorder.buildExport().runs).toHaveLength(1);
  });

  it('parseStoredOptOut REJECTS a malformed record rather than reading it as consent', () => {
    // The bug this pins: coercing with `optOut === true` turned every malformed payload
    // into a valid record reading `false` — so a truncated write or a hand-edited value
    // came back as "happy to be uploaded". Corruption must never become permission.
    expect(parseStoredOptOut({ optOut: true })).toEqual({ optOut: true });
    expect(parseStoredOptOut({ optOut: false })).toEqual({ optOut: false });
    expect(parseStoredOptOut({ optOut: 'true' })).toBeUndefined();
    expect(parseStoredOptOut({ optOut: 1 })).toBeUndefined();
    expect(parseStoredOptOut({})).toBeUndefined();
    expect(parseStoredOptOut(null)).toBeUndefined();
    expect(parseStoredOptOut([])).toBeUndefined();
    expect(parseStoredOptOut(7)).toBeUndefined();
  });

  it('FAILS CLOSED on a malformed stored record — it does not read as opted IN', async () => {
    // End to end through the slot: an unreadable choice routes to `incompatible`, which
    // `loadPlaytraceOptOut` answers protectively. Asserted for both shapes a corrupted
    // record realistically takes.
    for (const data of [{}, { optOut: 'true' }]) {
      const storage = fakeStorage({ [`${NS}${OPT_OUT_KEY}`]: settingsShapedOptOut(data) });
      expect((await loadPlaytraceOptOut(slotFor(storage))).optedOut()).toBe(true);
    }
  });
});

describe('round-trip: the replay validator accepts an exported payload', () => {
  it('validates a real captured run back out of the export', () => {
    const controller = createController(1234);
    controller.callWaveEarly();
    controller.start();
    // Run to a terminal state — a no-tower run resolves as a loss.
    for (let i = 0; i < 40_000 && !controller.isTerminal(); i++) controller.advance(50);
    expect(controller.isTerminal()).toBe(true);

    const snapshot = controller.capture();
    // #99 note 1, asserted rather than assumed: the count IS the number of recorded
    // entries applied, so an analyzer stepping that many never applies one slot too many.
    expect(snapshot.ticksCompleted).toBe(controller.buildReplay().tickInputs.length);

    const recorder = createPlaytraceRecorder({ now: () => 42 });
    recorder.capture({
      runId: 'run-round-trip',
      replay: controller.buildReplay(),
      ticksCompleted: snapshot.ticksCompleted,
      stateHash: snapshot.stateHash,
      pendingInputs: snapshot.pendingInputs,
      viewport: 'standard',
    });

    // Through the wire form and back, exactly as an exported file would travel.
    const parsed = JSON.parse(formatPlaytraceExport(recorder.buildExport())) as {
      runs: Playtrace[];
    };
    const result = validate(playtraceReplay(parsed.runs[0]!), getBundledRuleset());
    expect(result.reason ?? '').toBe('');
    expect(result.ok).toBe(true);
  });
});

describe('export mechanics', () => {
  it('serializes compactly — the interim delivery is a paste into an issue form', () => {
    const text = formatPlaytraceExport({ playtraceVersion: 1, exportedAt: 0, runs: [] });
    expect(text).toBe('{"playtraceVersion":1,"exportedAt":0,"runs":[]}');
  });

  it('names the file so two exports in one session do not collide', () => {
    expect(playtraceFilename(1750000000000)).toBe('wynding-playtrace-1750000000000.json');
    expect(playtraceFilename(1)).not.toBe(playtraceFilename(2));
  });

  it('browser delivery copies through the clipboard API', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    try {
      await browserDelivery(document).copy('payload');
      expect(writeText).toHaveBeenCalledWith('payload');
    } finally {
      // In `finally`: a failed assertion above would otherwise leave a fake clipboard
      // installed on the SHARED navigator, and the very next test — the one asserting
      // that a missing clipboard rejects — would find it and pass for the wrong reason.
      Reflect.deleteProperty(window.navigator, 'clipboard');
    }
  });

  it('browser delivery REJECTS where there is no clipboard API, rather than pretending', async () => {
    await expect(browserDelivery(document).copy('payload')).rejects.toThrow(/clipboard/);
  });

  it('browser delivery saves via an object URL it revokes AFTER the click, not during', async () => {
    const createObjectURL = vi.fn(() => 'blob:fake');
    const revokeObjectURL = vi.fn();
    // A SEPARATE object, never `Object.assign(globalThis.URL, …)`: that mutates the real
    // URL constructor in place, so `vi.unstubAllGlobals()` restores a reference to an
    // object that is still carrying these two spies. They then survive into every later
    // test in the process — the leak being fixed here, not a hypothetical one.
    const urlStub = Object.assign(
      function URLStub(...args: ConstructorParameters<typeof URL>) {
        return new globalThis.URL(...args);
      } as unknown as typeof URL,
      { createObjectURL, revokeObjectURL },
    );
    const clicked: HTMLAnchorElement[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
      clicked.push(this);
    };
    vi.stubGlobal('URL', urlStub);
    try {
      browserDelivery(document).save('run.json', '{}');
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
      vi.unstubAllGlobals();
    }
    expect(globalThis.URL).not.toBe(urlStub); // the restore actually restored
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe('run.json');
    expect(clicked[0]!.getAttribute('href')).toBe('blob:fake');
    // Detached: never appended to the document, so it cannot enter the dialog's tab order.
    expect(clicked[0]!.isConnected).toBe(false);
    // NOT YET revoked: a synchronous revoke can invalidate the blob before the engine has
    // begun fetching it, and the download then silently does nothing.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    // ...but it IS revoked, on the next task, so the blob is not leaked for the page's life.
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake'));
  });
});
