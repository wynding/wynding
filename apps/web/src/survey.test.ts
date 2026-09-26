import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from '@wynding/engine';
import {
  createSaveSlot,
  createWebStorageDriver,
  encodeEnvelope,
  SAVE_VERSION,
  type WebStorageLike,
} from '@wynding/platform';
import { UNKNOWN_GAME_VERSION } from '../build-config';
import { createController } from './controller';
import {
  MAX_ANSWERED_VERSIONS,
  SESSION_MAX_AGE_MS,
  SESSION_MAX_RUNS,
  SURVEY_ASK_KEY,
  SURVEY_TEXT_MAX,
  SURVEY_VERSION,
  buildSurveyPayload,
  createSessionIdentity,
  createSurvey,
  isSubmittableGameVersion,
  loadSurveyAsk,
  parseStoredSurveyAsk,
  replayDigest,
  validateSurveyPayload,
  type StoredSurveyAsk,
  type SurveyAnswers,
  type SurveyAsk,
  type SurveyPayload,
  type SurveyRunIdentity,
  type SurveySendResult,
  type SurveyTransport,
} from './survey';

const UUID = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

/** A run identity built from a REAL controller's replay, so the formats the validator checks
 *  are the formats the app actually produces — not ones a fixture happened to spell. */
function realIdentity(): SurveyRunIdentity {
  const controller = createController(12345);
  const replay = controller.buildReplay();
  const snapshot = controller.capture();
  return {
    runId: UUID(1),
    sessionId: UUID(2),
    gameVersion: SHA,
    simVersion: replay.simVersion,
    rulesetHash: replay.rulesetHash,
    boardId: replay.boardId,
    seed: replay.seed,
    outcome: 'lost',
    score: 0,
    stars: 0,
    waveCursor: 0,
    finalTick: snapshot.ticksCompleted,
    finalHash: snapshot.stateHash,
    replayDigest: replayDigest(replay.tickInputs),
  };
}

const ANSWERS: SurveyAnswers = { rating: 4, difficulty: null, somethingBroke: false, text: '' };

function payload(overrides: Partial<SurveyAnswers> = {}): SurveyPayload {
  return buildSurveyPayload({
    answers: { ...ANSWERS, ...overrides },
    run: realIdentity(),
    idempotencyKey: UUID(3),
  });
}

/** A deep copy with one path replaced (or deleted with `undefined` + `del`). */
function mutate(base: SurveyPayload, fn: (draft: Record<string, unknown>) => void): unknown {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  fn(draft);
  return draft;
}

describe('replayDigest (ADR 0014 §4 — pinned, not described)', () => {
  it('is exactly sha256Hex(canonicalJson(tickInputs)) through the shared helpers', () => {
    const tickInputs = [[], [{ type: 'callWaveEarly' }], []] as never;
    expect(replayDigest(tickInputs)).toBe(sha256Hex(canonicalJson(tickInputs)));
    expect(replayDigest(tickInputs)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is a function of the log alone: a different log differs, the same log agrees', () => {
    const a = [[], []] as never;
    const b = [[], [], []] as never;
    expect(replayDigest(a)).toBe(replayDigest(JSON.parse(JSON.stringify(a)) as never));
    expect(replayDigest(a)).not.toBe(replayDigest(b));
  });
});

describe('buildSurveyPayload — the explicit allowlist (§4)', () => {
  it('carries exactly the ADR’s fields, at every level, and nothing else', () => {
    const p = payload({ difficulty: 2, somethingBroke: true, text: 'the tower vanished' });
    expect(Object.keys(p).sort()).toEqual(['answers', 'idempotencyKey', 'run', 'surveyVersion']);
    expect(Object.keys(p.answers).sort()).toEqual([
      'difficulty',
      'rating',
      'somethingBroke',
      'text',
    ]);
    expect(Object.keys(p.run).sort()).toEqual(
      [
        'boardId',
        'finalHash',
        'finalTick',
        'gameVersion',
        'outcome',
        'replayDigest',
        'rulesetHash',
        'runId',
        'score',
        'seed',
        'sessionId',
        'simVersion',
        'stars',
        'waveCursor',
      ].sort(),
    );
    expect(p.surveyVersion).toBe(SURVEY_VERSION);
  });

  it('never lets an upstream field ride in by reference', () => {
    // A future field on the identity object must not reach the payload unlisted.
    const run = { ...realIdentity(), deviceId: 'leak', colourMode: 'protan' } as SurveyRunIdentity;
    const p = buildSurveyPayload({ answers: ANSWERS, run, idempotencyKey: UUID(3) });
    expect(p.run).not.toHaveProperty('deviceId');
    expect(p.run).not.toHaveProperty('colourMode');
    expect(p.run).not.toBe(run);
  });

  it('omits difficulty when unanswered rather than sending null', () => {
    expect(payload()).not.toHaveProperty('answers.difficulty');
    expect(payload({ difficulty: 5 }).answers.difficulty).toBe(5);
  });

  it('refuses answers the UI should never have allowed', () => {
    expect(() => payload({ rating: null })).toThrow(RangeError);
    expect(() => payload({ difficulty: 6 as never })).toThrow(RangeError);
    expect(() => payload({ text: 'x'.repeat(SURVEY_TEXT_MAX + 1) })).toThrow(RangeError);
  });

  it('produces payloads the server-side validation accepts, from a real run', () => {
    for (const overrides of [
      {},
      { difficulty: 1 as const },
      { somethingBroke: true, text: 'x'.repeat(SURVEY_TEXT_MAX) },
    ]) {
      const result = validateSurveyPayload(JSON.parse(JSON.stringify(payload(overrides))));
      expect(result).toMatchObject({ ok: true });
    }
  });
});

describe('validateSurveyPayload — §5’s server-side check, unknown fields rejected', () => {
  const base = payload({ difficulty: 3 });
  const reject = (data: unknown): string => {
    const result = validateSurveyPayload(data);
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.reason;
  };

  it('rejects an unknown field at every level', () => {
    expect(reject(mutate(base, (d) => (d['extra'] = 1)))).toMatch(/unknown field: extra/);
    expect(
      reject(mutate(base, (d) => ((d['answers'] as Record<string, unknown>)['email'] = 'x'))),
    ).toMatch(/answers\.email/);
    expect(
      reject(mutate(base, (d) => ((d['run'] as Record<string, unknown>)['deviceId'] = 'x'))),
    ).toMatch(/run\.deviceId/);
  });

  it('requires rating as an integer 1–5', () => {
    for (const bad of [undefined, null, 0, 6, 2.5, '3', true]) {
      reject(
        mutate(base, (d) => {
          const answers = d['answers'] as Record<string, unknown>;
          if (bad === undefined) delete answers['rating'];
          else answers['rating'] = bad;
        }),
      );
    }
  });

  it('allows difficulty absent, but not present-and-invalid (null included)', () => {
    expect(
      validateSurveyPayload(
        mutate(base, (d) => delete (d['answers'] as Record<string, unknown>)['difficulty']),
      ).ok,
    ).toBe(true);
    for (const bad of [null, 0, 6, '2']) {
      reject(mutate(base, (d) => ((d['answers'] as Record<string, unknown>)['difficulty'] = bad)));
    }
  });

  it('caps text in UTF-16 code units — the unit maxlength counts, never stricter', () => {
    const astral = '😀'.repeat(SURVEY_TEXT_MAX / 2); // two code units each
    expect(astral.length).toBe(SURVEY_TEXT_MAX);
    expect(
      validateSurveyPayload(
        mutate(base, (d) => ((d['answers'] as Record<string, unknown>)['text'] = astral)),
      ).ok,
    ).toBe(true);
    reject(mutate(base, (d) => ((d['answers'] as Record<string, unknown>)['text'] = `${astral}x`)));
  });

  it('checks every envelope field against its declared format', () => {
    const cases: [string, unknown][] = [
      ['runId', 'not-a-uuid'],
      ['sessionId', UUID(1).toUpperCase().replace('0000', 'ZZZZ')],
      ['gameVersion', 'v1.2.3'],
      ['gameVersion', SHA.slice(0, 12)],
      ['simVersion', 0],
      ['simVersion', 1.5],
      ['rulesetHash', 'abc'],
      ['replayDigest', 'z'.repeat(64)],
      ['boardId', 'Bad Board'],
      ['seed', -1],
      ['seed', 0x100000000],
      ['outcome', 'draw'],
      ['score', -1],
      ['stars', 1.5],
      ['stars', 4],
      ['waveCursor', '2'],
      ['finalTick', null],
      ['finalHash', 'deadbeef00'],
    ];
    for (const [field, value] of cases) {
      reject(mutate(base, (d) => ((d['run'] as Record<string, unknown>)[field] = value)));
    }
  });

  it('accepts a SHA-256 repository’s 64-hex revision as gameVersion', () => {
    const ok = mutate(
      base,
      (d) => ((d['run'] as Record<string, unknown>)['gameVersion'] = 'b'.repeat(64)),
    );
    expect(validateSurveyPayload(ok).ok).toBe(true);
  });

  it('rejects a wrong version, a malformed key and non-object shapes', () => {
    reject(mutate(base, (d) => (d['surveyVersion'] = SURVEY_VERSION + 1)));
    reject(mutate(base, (d) => (d['idempotencyKey'] = 'k')));
    for (const bad of [null, [], 'payload', 7]) reject(bad);
    reject(mutate(base, (d) => (d['answers'] = [])));
    reject(mutate(base, (d) => (d['run'] = null)));
    reject(mutate(base, (d) => ((d['answers'] as Record<string, unknown>)['somethingBroke'] = 1)));
    reject(mutate(base, (d) => ((d['answers'] as Record<string, unknown>)['text'] = 7)));
  });
});

describe('createSessionIdentity — ADR 0011 §3’s bounded, never-persisted id', () => {
  function fixture() {
    const clock = { wall: 1_000_000, mono: 0 };
    const ids: string[] = [];
    const session = createSessionIdentity({
      mint: () => {
        ids.push(UUID(ids.length + 1));
        return ids[ids.length - 1] as string;
      },
      now: () => clock.wall,
      monotonicNow: () => clock.mono,
    });
    return { clock, ids, session };
  }

  it('has no id before a run begins, then holds one steady for the whole run', () => {
    const { session } = fixture();
    expect(() => session.current()).toThrow();
    session.beginRun();
    expect(session.current()).toBe(UUID(1));
    expect(session.current()).toBe(UUID(1));
  });

  it('groups a few runs, then rotates on the run count', () => {
    const { session } = fixture();
    for (let run = 1; run <= SESSION_MAX_RUNS; run++) {
      session.beginRun();
      expect(session.current()).toBe(UUID(1));
    }
    session.beginRun();
    expect(session.current()).toBe(UUID(2));
  });

  it('rotates on elapsed time, whichever bound bites first', () => {
    const { clock, session } = fixture();
    session.beginRun();
    clock.mono = SESSION_MAX_AGE_MS - 1;
    clock.wall += SESSION_MAX_AGE_MS - 1;
    session.beginRun();
    expect(session.current()).toBe(UUID(1));
    clock.mono = SESSION_MAX_AGE_MS;
    clock.wall += 1;
    session.beginRun();
    expect(session.current()).toBe(UUID(2));
  });

  it('rotates across a system suspend, when only the WALL clock moved', () => {
    const { clock, session } = fixture();
    session.beginRun();
    clock.wall += 3 * SESSION_MAX_AGE_MS; // asleep for days; performance.now() stood still
    clock.mono += 1_000;
    session.beginRun();
    expect(session.current()).toBe(UUID(2));
  });

  it('does not rotate on a small backward wall step while the monotonic clock is usable', () => {
    const { clock, session } = fixture();
    session.beginRun();
    clock.wall -= 5; // NTP / RTC correction — routine on Android
    clock.mono += 1_000;
    session.beginRun();
    expect(session.current()).toBe(UUID(1));
  });

  it('rotates when neither clock can say how old the id is', () => {
    for (const mono of [Number.NaN, -1]) {
      const { clock, session } = fixture();
      session.beginRun();
      clock.mono = mono;
      clock.wall -= 5;
      session.beginRun();
      expect(session.current()).toBe(UUID(2));
    }
    const { clock, session } = fixture();
    session.beginRun();
    clock.mono = Number.NaN;
    clock.wall = Number.NaN;
    session.beginRun();
    expect(session.current()).toBe(UUID(2));
  });
});

// --- §3: the ask ----------------------------------------------------------------------------

const NS = 'wynding:';
function fakeStorage(seed: Record<string, string> = {}): WebStorageLike & {
  map: Map<string, string>;
  failWrites: boolean;
  failReads: boolean;
} {
  const map = new Map(Object.entries(seed));
  return {
    map,
    failWrites: false,
    failReads: false,
    getItem(key) {
      if (this.failReads) throw new Error('SecurityError');
      return map.get(key) ?? null;
    },
    setItem(key, value) {
      if (this.failWrites) throw new Error('QuotaExceededError');
      map.set(key, value);
    },
    removeItem: (key) => void map.delete(key),
  };
}
const slotFor = (storage: WebStorageLike | null) =>
  createSaveSlot<StoredSurveyAsk>({
    driver: createWebStorageDriver(storage),
    key: SURVEY_ASK_KEY,
    deviceId: 'device-a',
    parse: parseStoredSurveyAsk,
    now: () => 0,
  });
const stored = async (storage: WebStorageLike): Promise<StoredSurveyAsk | undefined> => {
  const read = await slotFor(storage).read();
  return read.status === 'ok' ? read.data : undefined;
};

describe('loadSurveyAsk — once per gameVersion, and a dismissal that sticks (§3)', () => {
  it('offers on a device that has never answered, and records nothing by offering', async () => {
    const storage = fakeStorage();
    const ask = await loadSurveyAsk(slotFor(storage), SHA);
    expect(ask.offered()).toBe(true);
    expect(ask.offered()).toBe(true);
    expect(storage.map.size).toBe(0); // presence consumes nothing — "never on mere display"
  });

  it('Not now / an accepted Send consumes THIS version’s ask, durably, and only this version', async () => {
    const storage = fakeStorage();
    await (await loadSurveyAsk(slotFor(storage), SHA)).commit(false);
    expect((await loadSurveyAsk(slotFor(storage), SHA)).offered()).toBe(false); // across a reload
    expect((await loadSurveyAsk(slotFor(storage), OTHER_SHA)).offered()).toBe(true); // next version
  });

  it('don’t-ask-again, committed, is honoured forever — across versions', async () => {
    const storage = fakeStorage();
    await (await loadSurveyAsk(slotFor(storage), SHA)).commit(true);
    expect((await loadSurveyAsk(slotFor(storage), OTHER_SHA)).offered()).toBe(false);
  });

  it('the same-dialog undo: committing UNCHECKED clears a stored dismissal (the write, directly)', async () => {
    const storage = fakeStorage();
    const ask = await loadSurveyAsk(slotFor(storage), SHA);
    await ask.commit(true); // check → commit via Not now
    expect(await stored(storage)).toEqual({ dismissed: true, answeredVersions: [SHA] });
    await ask.commit(false); // reopen → uncheck → commit again
    expect(await stored(storage)).toEqual({ dismissed: false, answeredVersions: [SHA] });
    // The two cross-reload observables, which together separate the two rules:
    expect((await loadSurveyAsk(slotFor(storage), SHA)).offered()).toBe(false); // Not now's
    expect((await loadSurveyAsk(slotFor(storage), OTHER_SHA)).offered()).toBe(true); // "forever" cleared
  });

  it('fails toward not asking — IN MEMORY — when storage cannot be written', async () => {
    const storage = fakeStorage();
    storage.failWrites = true;
    const ask = await loadSurveyAsk(slotFor(storage), SHA);
    await expect(ask.commit(true)).resolves.toBeUndefined(); // never rejects
    expect(ask.offered()).toBe(false); // not asked again in the session where they said no
    // Across sessions an unrecorded dismissal is one we do not know about.
    storage.failWrites = false;
    expect((await loadSurveyAsk(slotFor(storage), SHA)).offered()).toBe(true);
  });

  it('offers nothing — and touches no storage — in a build with no revision identity', async () => {
    const storage = fakeStorage();
    const ask = await loadSurveyAsk(slotFor(storage), UNKNOWN_GAME_VERSION);
    expect(ask.offered()).toBe(false);
    await ask.commit(true);
    expect(storage.map.size).toBe(0);
    expect((await loadSurveyAsk(slotFor(storage), SHA)).offered()).toBe(true);
    expect(isSubmittableGameVersion('a'.repeat(64))).toBe(true); // a SHA-256 repository
    expect(isSubmittableGameVersion(SHA.slice(0, 12))).toBe(false);
  });

  it('never withholds the feature wholesale: no storage, or unreadable storage, still offers', async () => {
    expect((await loadSurveyAsk(slotFor(null), SHA)).offered()).toBe(true);
    const unreadable = fakeStorage();
    unreadable.failReads = true;
    expect((await loadSurveyAsk(slotFor(unreadable), SHA)).offered()).toBe(true);
    const corrupt = fakeStorage({ [`${NS}${SURVEY_ASK_KEY}`]: '{not json' });
    expect((await loadSurveyAsk(slotFor(corrupt), SHA)).offered()).toBe(true);
  });

  it('a rollback restores the prior revision’s consumed ask (§4) — answered versions are history', async () => {
    const storage = fakeStorage();
    await (await loadSurveyAsk(slotFor(storage), SHA)).commit(false); // answer A
    await (await loadSurveyAsk(slotFor(storage), OTHER_SHA)).commit(false); // answer B
    expect((await loadSurveyAsk(slotFor(storage), SHA)).offered()).toBe(false); // back to A
    expect((await loadSurveyAsk(slotFor(storage), OTHER_SHA)).offered()).toBe(false);
  });

  it('remembers a bounded history, most recent kept, re-committing without duplicating', async () => {
    const storage = fakeStorage();
    const version = (n: number): string => n.toString(16).padStart(40, '0');
    for (let n = 1; n <= MAX_ANSWERED_VERSIONS + 1; n++) {
      await (await loadSurveyAsk(slotFor(storage), version(n))).commit(false);
    }
    const history = (await stored(storage))?.answeredVersions ?? [];
    expect(history).toHaveLength(MAX_ANSWERED_VERSIONS);
    expect(history[history.length - 1]).toBe(version(MAX_ANSWERED_VERSIONS + 1));
    expect((await loadSurveyAsk(slotFor(storage), version(1))).offered()).toBe(true); // evicted
    expect((await loadSurveyAsk(slotFor(storage), version(2))).offered()).toBe(false);
    // Committing an already-answered version moves it to the recent end, once.
    await (await loadSurveyAsk(slotFor(storage), version(2))).commit(false);
    const after = (await stored(storage))?.answeredVersions ?? [];
    expect(after.filter((v) => v === version(2))).toHaveLength(1);
    expect(after[after.length - 1]).toBe(version(2));
  });

  it('parseStoredSurveyAsk accepts only the declared shape', () => {
    expect(parseStoredSurveyAsk({ dismissed: true, answeredVersions: [SHA] })).toEqual({
      dismissed: true,
      answeredVersions: [SHA],
    });
    expect(parseStoredSurveyAsk({ dismissed: false, answeredVersions: [] })).toEqual({
      dismissed: false,
      answeredVersions: [],
    });
    for (const bad of [
      null,
      [],
      7,
      {},
      { dismissed: 'true', answeredVersions: [] },
      { dismissed: false },
      { dismissed: false, answeredVersions: SHA },
      { dismissed: false, answeredVersions: [3] },
    ]) {
      expect(parseStoredSurveyAsk(bad)).toBeUndefined();
    }
    // An over-long history is trimmed to the most recent, keeping the dismissal.
    const long = Array.from({ length: MAX_ANSWERED_VERSIONS + 2 }, (_, n) => String(n));
    expect(parseStoredSurveyAsk({ dismissed: true, answeredVersions: long })).toEqual({
      dismissed: true,
      answeredVersions: long.slice(2),
    });
    // End to end: a malformed record through the slot reads as never-answered.
    const envelope = encodeEnvelope({
      saveVersion: SAVE_VERSION,
      deviceId: 'device-a',
      revision: 1,
      updatedAt: 0,
      data: { dismissed: 'yes' },
    });
    const storage = fakeStorage({ [`${NS}${SURVEY_ASK_KEY}`]: envelope });
    return expect(loadSurveyAsk(slotFor(storage), SHA).then((a) => a.offered())).resolves.toBe(
      true,
    );
  });
});

// --- §1/§3/§5: the flow ---------------------------------------------------------------------

interface Pending {
  readonly payload: SurveyPayload;
  readonly signal: AbortSignal;
  resolve(result: SurveySendResult): void;
  reject(error: unknown): void;
}

function harness(options: { offered?: boolean } = {}) {
  const commits: boolean[] = [];
  const ask: SurveyAsk = {
    offered: () => options.offered ?? true,
    commit: vi.fn(async (dontAskAgain: boolean) => {
      commits.push(dontAskAgain);
    }),
  };
  const pending: Pending[] = [];
  const transport: SurveyTransport = {
    send: (payload, signal) =>
      new Promise((resolve, reject) => {
        pending.push({ payload, signal, resolve, reject });
      }),
  };
  let keys = 0;
  const survey = createSurvey({ ask, transport, mintKey: () => UUID(100 + ++keys) });
  const compose = (idempotencyKey: string): SurveyPayload =>
    buildSurveyPayload({ answers: survey.state().answers, run: realIdentity(), idempotencyKey });
  const openDialog = (): void => {
    survey.beginDialog();
    survey.open();
  };
  const last = (): Pending => pending[pending.length - 1] as Pending;
  return { survey, ask, commits, pending, last, compose, openDialog };
}

async function sendAndSettle(
  h: ReturnType<typeof harness>,
  result: SurveySendResult,
): Promise<SurveySendResult | 'cancelled'> {
  const attempt = h.survey.send(h.compose);
  if (attempt.kind !== 'sending') throw new Error(`expected sending, got ${attempt.kind}`);
  h.last().resolve(result);
  return attempt.done;
}

describe('createSurvey — presence, expansion and the form (§1, §3)', () => {
  it('is absent when this version’s ask is consumed, collapsed (present) when offered', () => {
    const absent = harness({ offered: false });
    absent.survey.beginDialog();
    expect(absent.survey.state().phase).toBe('absent');
    expect(absent.survey.open()).toBe(false);

    const present = harness();
    present.survey.beginDialog();
    expect(present.survey.state().phase).toBe('collapsed');
    expect(present.survey.open()).toBe(true);
    expect(present.survey.state().phase).toBe('open');
  });

  it('expansion consumes nothing — opening and walking away commits nothing', () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(3);
    h.survey.endDialog();
    expect(h.commits).toEqual([]);
  });

  it('refuses edits unless the form is open', () => {
    const h = harness();
    h.survey.beginDialog();
    expect(h.survey.setRating(3)).toBe(false);
    expect(h.survey.setDontAskAgain(true)).toBe(false);
    expect(h.survey.state().answers.rating).toBeNull();
  });

  it('carries difficulty through to the payload, and Not now from a closed form does nothing', async () => {
    const h = harness();
    h.survey.beginDialog();
    await h.survey.notNow(); // collapsed: nothing to commit
    expect(h.commits).toEqual([]);
    h.survey.open();
    h.survey.setRating(3);
    expect(h.survey.setDifficulty(5)).toBe(true);
    h.survey.send(h.compose);
    expect(h.last().payload.answers.difficulty).toBe(5);
  });

  it('refuses text past the cap', () => {
    const h = harness();
    h.openDialog();
    expect(h.survey.setText('x'.repeat(SURVEY_TEXT_MAX))).toBe(true);
    expect(h.survey.setText('x'.repeat(SURVEY_TEXT_MAX + 1))).toBe(false);
    expect(h.survey.state().answers.text).toHaveLength(SURVEY_TEXT_MAX);
  });

  it('Send with no rating sends nothing and says what is missing', () => {
    const h = harness();
    h.openDialog();
    expect(h.survey.send(h.compose)).toEqual({ kind: 'needsRating' });
    expect(h.pending).toHaveLength(0);
    expect(h.survey.state().phase).toBe('open');
  });

  it('Send is refused from any state but open', () => {
    const h = harness();
    h.survey.beginDialog();
    expect(h.survey.send(h.compose)).toEqual({ kind: 'refused' });
  });
});

describe('createSurvey — what consumes the ask (§3)', () => {
  it('Not now collapses, leaves the button live, and commits the checkbox’s current state', async () => {
    const h = harness();
    h.openDialog();
    h.survey.setDontAskAgain(true);
    await h.survey.notNow();
    expect(h.survey.state().phase).toBe('collapsed'); // reopening is allowed
    expect(h.commits).toEqual([true]);
    // The same-dialog undo: reopen, uncheck, commit again.
    expect(h.survey.open()).toBe(true);
    expect(h.survey.state().dontAskAgain).toBe(true); // the modifier is still armed on reopen
    h.survey.setDontAskAgain(false);
    await h.survey.notNow();
    expect(h.commits).toEqual([true, false]);
  });

  it('an ACCEPTED Send retires the button and commits', async () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(5);
    h.survey.setDontAskAgain(true);
    await expect(sendAndSettle(h, 'accepted')).resolves.toBe('accepted');
    expect(h.survey.state().phase).toBe('retired');
    expect(h.survey.open()).toBe(false);
    expect(h.commits).toEqual([true]);
  });

  it('a rejected or offline Send consumes NOTHING and re-opens the form with the text kept', async () => {
    for (const outcome of ['rejected', 'offline'] as const) {
      const h = harness();
      h.openDialog();
      h.survey.setRating(2);
      h.survey.setText('it froze on wave 3');
      await expect(sendAndSettle(h, outcome)).resolves.toBe(outcome);
      expect(h.survey.state()).toMatchObject({
        phase: 'open',
        failure: outcome,
        answers: { rating: 2, text: 'it froze on wave 3' },
      });
      expect(h.commits).toEqual([]);
    }
  });

  it('a transport error reads as rejected', async () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(3);
    const attempt = h.survey.send(h.compose);
    if (attempt.kind !== 'sending') throw new Error('expected sending');
    h.last().reject(new TypeError('boom'));
    await expect(attempt.done).resolves.toBe('rejected');
    expect(h.survey.state().failure).toBe('rejected');
  });

  it('a transport that throws SYNCHRONOUSLY still settles as rejected — never stuck sending', async () => {
    const commits: boolean[] = [];
    const survey = createSurvey({
      ask: { offered: () => true, commit: async (d) => void commits.push(d) },
      transport: {
        send: () => {
          throw new Error('sync boom');
        },
      },
      mintKey: () => UUID(1),
    });
    survey.beginDialog();
    survey.open();
    survey.setRating(3);
    const attempt = survey.send((key) =>
      buildSurveyPayload({
        answers: survey.state().answers,
        run: realIdentity(),
        idempotencyKey: key,
      }),
    );
    if (attempt.kind !== 'sending') throw new Error('expected sending');
    await expect(attempt.done).resolves.toBe('rejected');
    expect(survey.state()).toMatchObject({ phase: 'open', failure: 'rejected' });
  });

  it('a result outside the declared union reads as rejected', async () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(3);
    await expect(sendAndSettle(h, 'weird' as SurveySendResult)).resolves.toBe('rejected');
    expect(h.survey.state().failure).toBe('rejected');
  });

  it('an accepted Send reports its outcome without waiting on the storage write (§6)', async () => {
    let commitCalls = 0;
    const survey = createSurvey({
      ask: {
        offered: () => true,
        commit: () => {
          commitCalls++;
          return new Promise<void>(() => {}); // a hung driver
        },
      },
      transport: { send: async () => 'accepted' },
      mintKey: () => UUID(1),
    });
    survey.beginDialog();
    survey.open();
    survey.setRating(5);
    const attempt = survey.send((key) =>
      buildSurveyPayload({
        answers: survey.state().answers,
        run: realIdentity(),
        idempotencyKey: key,
      }),
    );
    if (attempt.kind !== 'sending') throw new Error('expected sending');
    await expect(attempt.done).resolves.toBe('accepted');
    expect(commitCalls).toBe(1);
    expect(survey.state().phase).toBe('retired');
  });

  it('a run start collapses WITHOUT committing, even with don’t-ask-again armed', () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(3);
    h.survey.setDontAskAgain(true);
    h.survey.endDialog();
    expect(h.commits).toEqual([]);
    expect(h.survey.state()).toMatchObject({
      phase: 'collapsed',
      dontAskAgain: false,
      answers: { rating: null },
    });
  });
});

describe('createSurvey — the in-flight operation and its cancellation (§1)', () => {
  it('composes the payload SYNCHRONOUSLY inside Send — no pre-request window', () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(4);
    const compose = vi.fn(h.compose);
    h.survey.send(compose);
    expect(compose).toHaveBeenCalledTimes(1); // before send() returned
    expect(h.pending).toHaveLength(1);
  });

  it('refuses every edit and action while in flight', () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(4);
    h.survey.send(h.compose);
    expect(h.survey.state().phase).toBe('sending');
    expect(h.survey.setRating(1)).toBe(false);
    expect(h.survey.setText('late')).toBe(false);
    expect(h.survey.setSomethingBroke(true)).toBe(false);
    expect(h.survey.setDontAskAgain(true)).toBe(false);
    expect(h.survey.send(h.compose)).toEqual({ kind: 'refused' });
    expect(h.survey.state().answers).toMatchObject({ rating: 4, text: '', somethingBroke: false });
  });

  it('a run start aborts the operation, and a late success never lands', async () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(4);
    const attempt = h.survey.send(h.compose);
    if (attempt.kind !== 'sending') throw new Error('expected sending');
    const { signal } = h.last();
    h.survey.endDialog(); // Play again → hideResults()
    expect(signal.aborted).toBe(true);
    h.last().resolve('accepted'); // delivered anyway — the abort cannot un-send
    await expect(attempt.done).resolves.toBe('cancelled');
    expect(h.survey.state().phase).not.toBe('retired');
    expect(h.commits).toEqual([]); // cancelled consumes nothing
  });

  it('a new dialog cancels whatever the previous one left in flight', async () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(4);
    const attempt = h.survey.send(h.compose);
    if (attempt.kind !== 'sending') throw new Error('expected sending');
    h.survey.beginDialog();
    h.last().resolve('rejected');
    await expect(attempt.done).resolves.toBe('cancelled');
    expect(h.survey.state()).toMatchObject({ phase: 'collapsed', failure: null });
  });
});

describe('createSurvey — the idempotency key (§5)', () => {
  it('is reused unchanged by a retry', async () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(4);
    await sendAndSettle(h, 'offline');
    await sendAndSettle(h, 'accepted');
    expect(h.pending.map((p) => p.payload.idempotencyKey)).toEqual([UUID(101), UUID(101)]);
  });

  it('rotates on an edit event — even an edit that returns to the original answers', async () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(4);
    await sendAndSettle(h, 'rejected');
    h.survey.setRating(2); // A → B
    h.survey.setRating(4); // → back to A: still a new logical submission
    await sendAndSettle(h, 'rejected');
    expect(h.pending.map((p) => p.payload.idempotencyKey)).toEqual([UUID(101), UUID(102)]);
  });

  it('does not rotate for a no-op edit or for the don’t-ask-again modifier', async () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(4);
    await sendAndSettle(h, 'rejected');
    h.survey.setRating(4); // same value — not an edit event
    h.survey.setDontAskAgain(true); // not an answer
    await sendAndSettle(h, 'rejected');
    expect(h.pending.map((p) => p.payload.idempotencyKey)).toEqual([UUID(101), UUID(101)]);
    expect(h.survey.state().failure).toBe('rejected');
  });

  it('keeps Try again through an edit — the relabel is in place, not flipped while typing', async () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(4);
    await sendAndSettle(h, 'rejected');
    h.survey.setSomethingBroke(true);
    expect(h.survey.state().failure).toBe('rejected');
    await sendAndSettle(h, 'accepted');
    expect(h.survey.state().failure).toBeNull();
  });

  it('survives Not now within the dialog: rejected → Not now → reopen → retry reuses the key', async () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(4);
    await sendAndSettle(h, 'offline');
    await h.survey.notNow();
    h.survey.open();
    await sendAndSettle(h, 'accepted');
    expect(h.pending.map((p) => p.payload.idempotencyKey)).toEqual([UUID(101), UUID(101)]);
  });

  it('a fresh dialog starts a fresh submission', async () => {
    const h = harness();
    h.openDialog();
    h.survey.setRating(4);
    await sendAndSettle(h, 'rejected');
    h.openDialog();
    expect(h.survey.state().answers).toEqual({
      rating: null,
      difficulty: null,
      somethingBroke: false,
      text: '',
    });
    h.survey.setRating(4);
    await sendAndSettle(h, 'rejected');
    expect(h.pending.map((p) => p.payload.idempotencyKey)).toEqual([UUID(101), UUID(102)]);
  });
});
