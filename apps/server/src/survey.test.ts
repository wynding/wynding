import { describe, expect, it, vi } from 'vitest';
import {
  buildSurveyPayload,
  replayDigest,
  SURVEY_TEXT_MAX,
  type SurveyPayload,
} from '@wynding/feedback';
import {
  createSurveyHandler,
  handler,
  ORIGIN_SECRET_HEADER,
  readSurveyConfig,
  SURVEY_MAX_BODY_BYTES,
  type HttpApiEvent,
  type SurveyConfig,
} from './survey';
import {
  classifyFailure,
  createDynamoSurveyStore,
  QUOTA_TTL_DAYS,
  SURVEY_TTL_DAYS,
  surveyTransaction,
  type PutOutcome,
  type SurveySubmission,
} from './survey-store';

// The survey endpoint's handler (wynding-site ADR 0001) and its DynamoDB store. The handler is
// tested against a fake store, the store against a fake client, so every outcome is reachable
// without AWS.

const UUID = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SECRET = 'origin-secret-value';
const CONFIG: SurveyConfig = {
  tableName: 'wynding-feedback',
  originSecret: SECRET,
  noticeVersion: '2026-09-28',
  dailyCeiling: 50,
};
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

function payload(text = 'the maze held'): SurveyPayload {
  return buildSurveyPayload({
    answers: { rating: 4, difficulty: 2, somethingBroke: false, text },
    idempotencyKey: UUID(3),
    run: {
      runId: UUID(1),
      sessionId: UUID(2),
      gameVersion: '0123456789abcdef0123456789abcdef01234567',
      simVersion: 1,
      rulesetHash: 'a'.repeat(64),
      boardId: 'first-light',
      seed: 12345,
      outcome: 'lost',
      score: 10,
      stars: 1,
      waveCursor: 3,
      finalTick: 100,
      finalHash: '0badf00d',
      replayDigest: replayDigest([[]] as never),
    },
  });
}

function event(overrides: Partial<HttpApiEvent> = {}, body: unknown = payload()): HttpApiEvent {
  return {
    requestContext: { http: { method: 'POST' } },
    headers: { [ORIGIN_SECRET_HEADER]: SECRET, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    ...overrides,
  };
}

function setup(outcome: PutOutcome | Error = 'stored', config: SurveyConfig | null = CONFIG) {
  const puts: SurveySubmission[] = [];
  const logs: string[] = [];
  const store = {
    put: vi.fn(async (s: SurveySubmission): Promise<PutOutcome> => {
      puts.push(s);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
  const run = createSurveyHandler({ config, store, now: () => NOW, log: (l) => logs.push(l) });
  return { run, puts, logs, store };
}

const statusOf = (body: string): unknown => (JSON.parse(body) as { status: unknown }).status;

describe('survey handler — what reaches storage (ADR 0001 §4)', () => {
  it('stores a valid submission with the server-stamped notice version, and says accepted', async () => {
    const h = setup();
    const res = await h.run(event());
    expect(res.statusCode).toBe(200);
    expect(statusOf(res.body)).toBe('accepted');
    expect(h.puts).toHaveLength(1);
    const put = h.puts[0]!;
    expect(put).toMatchObject({
      idempotencyKey: UUID(3),
      sessionId: UUID(2),
      runId: UUID(1),
      noticeVersion: '2026-09-28',
      receivedAtMs: NOW,
      dailyCeiling: 50,
    });
    expect(JSON.parse(put.payloadJson)).toEqual(payload());
  });

  it('answers a duplicate as accepted, and the day ceiling or a throttle as 503', async () => {
    for (const [outcome, status, code] of [
      ['duplicate', 200, 'duplicate'],
      ['ceiling', 503, 'ceiling'],
      ['throttled', 503, 'throttled'],
    ] as const) {
      const res = await setup(outcome).run(event());
      expect(res.statusCode, outcome).toBe(status);
      expect(statusOf(res.body)).toBe(code);
    }
  });

  it('turns an unexpected storage failure into a 503, never a 500', async () => {
    const res = await setup(new Error('boom')).run(event());
    expect(res.statusCode).toBe(503);
    expect(statusOf(res.body)).toBe('error');
  });

  it('refuses anything but POST', async () => {
    const h = setup();
    const res = await h.run(event({ requestContext: { http: { method: 'GET' } } }));
    expect(res.statusCode).toBe(405);
    expect((await h.run(event({ requestContext: {} }))).statusCode).toBe(405);
    expect(h.puts).toHaveLength(0);
  });

  it('refuses a request without CloudFront’s origin secret, whatever its body', async () => {
    const h = setup();
    for (const headers of [
      {},
      { [ORIGIN_SECRET_HEADER]: 'wrong' },
      { [ORIGIN_SECRET_HEADER]: `${SECRET}x` },
    ]) {
      const res = await h.run(event({ headers }));
      expect(res.statusCode).toBe(403);
    }
    expect((await h.run(event({ headers: undefined }))).statusCode).toBe(403);
    // A caller that does not lower-case header names is matched all the same.
    expect((await h.run(event({ headers: { 'X-Wynding-Origin': SECRET } }))).statusCode).toBe(200);
    expect(h.puts).toHaveLength(1);
  });

  it('is off (503) when disabled or misconfigured, before looking at anything else', async () => {
    const h = setup('stored', null);
    const res = await h.run(event());
    expect(res.statusCode).toBe(503);
    expect(statusOf(res.body)).toBe('disabled');
    expect(h.puts).toHaveLength(0);
  });

  it('refuses an oversized body (413), a non-JSON body and an invalid payload (400)', async () => {
    const h = setup();
    const huge = { ...payload(), padding: 'x'.repeat(SURVEY_MAX_BODY_BYTES) };
    expect((await h.run(event({}, huge))).statusCode).toBe(413);
    expect((await h.run(event({}, '{not json'))).statusCode).toBe(400);
    expect(statusOf((await h.run(event({}, '{not json'))).body)).toBe('bad_json');
    expect((await h.run(event({}, { ...payload(), extra: 1 }))).statusCode).toBe(400);
    expect((await h.run(event({ body: null }))).statusCode).toBe(400);
    expect(h.puts).toHaveLength(0);
  });

  it('accepts a maximal honest survey, and a base64-encoded body', async () => {
    const h = setup();
    const control = '\u0001'.repeat(SURVEY_TEXT_MAX); // JSON-escapes to 6 bytes each
    const big = JSON.stringify(payload(control));
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(SURVEY_MAX_BODY_BYTES);
    expect((await h.run(event({}, big))).statusCode).toBe(200);
    const encoded = Buffer.from(JSON.stringify(payload())).toString('base64');
    expect((await h.run(event({ body: encoded, isBase64Encoded: true }))).statusCode).toBe(200);
  });

  it('logs exactly one fixed outcome code per request — never the payload or the reason', async () => {
    const h = setup();
    await h.run(event({}, { ...payload('my name is Ada'), ['secret-field-name']: 1 }));
    await h.run(event({}, '{"text": "leak me"'));
    await h.run(event());
    expect(h.logs).toEqual([
      '{"survey":"invalid"}',
      '{"survey":"bad_json"}',
      '{"survey":"accepted"}',
    ]);
    // Every response has the same small shape, and none echoes the submission.
    const res = await h.run(event());
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toContain('maze');
  });
});

describe('readSurveyConfig — off unless switched on and fully configured', () => {
  const full = {
    SURVEY_ENABLED: 'true',
    TABLE_NAME: 'wynding-feedback',
    ORIGIN_SECRET: SECRET,
    PRIVACY_NOTICE_VERSION: '2026-09-28',
  };

  it('reads a complete environment, with the ceiling defaulting to 50', () => {
    expect(readSurveyConfig(full)).toEqual(CONFIG);
    expect(readSurveyConfig({ ...full, DAILY_CEILING: '7' })?.dailyCeiling).toBe(7);
  });

  it('is null (disabled) for any missing or malformed setting', () => {
    for (const env of [
      { ...full, SURVEY_ENABLED: 'false' },
      { ...full, SURVEY_ENABLED: 'TRUE' },
      { ...full, SURVEY_ENABLED: undefined },
      { ...full, TABLE_NAME: '' },
      { ...full, TABLE_NAME: undefined },
      { ...full, PRIVACY_NOTICE_VERSION: undefined },
      { ...full, ORIGIN_SECRET: undefined },
      { ...full, PRIVACY_NOTICE_VERSION: '' },
      { ...full, DAILY_CEILING: '0' },
      { ...full, DAILY_CEILING: '2.5' },
      { ...full, DAILY_CEILING: 'many' },
    ]) {
      expect(readSurveyConfig(env), JSON.stringify(env)).toBeNull();
    }
  });
});

describe('the Lambda entry point', () => {
  it('reads its configuration from the environment, and is off without it', async () => {
    const saved = process.env['SURVEY_ENABLED'];
    delete process.env['SURVEY_ENABLED'];
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await handler(event());
      expect(res.statusCode).toBe(503);
      expect(logged).toHaveBeenCalledWith('{"survey":"disabled"}');
    } finally {
      logged.mockRestore();
      if (saved !== undefined) process.env['SURVEY_ENABLED'] = saved;
    }
  });
});

describe('survey store — the transaction (ADR 0001 §3, §6, §7)', () => {
  const submission: SurveySubmission = {
    idempotencyKey: UUID(3),
    sessionId: UUID(2),
    runId: UUID(1),
    payloadJson: '{"x":1}',
    noticeVersion: '2026-09-28',
    receivedAtMs: NOW,
    dailyCeiling: 50,
  };

  it('writes the submission under its key, conditionally, with the day’s counter beside it', () => {
    const tx = surveyTransaction('wynding-feedback', submission);
    const [put, update] = tx.TransactItems!;
    expect(put!.Put).toEqual({
      TableName: 'wynding-feedback',
      Item: {
        pk: { S: `survey#${UUID(3)}` },
        sessionId: { S: UUID(2) },
        runId: { S: UUID(1) },
        payload: { S: '{"x":1}' },
        noticeVersion: { S: '2026-09-28' },
        receivedAt: { S: '2026-09-28T12:00:00.000Z' },
        expiresAt: { N: String(NOW / 1000 + SURVEY_TTL_DAYS * 86400) },
        moderation: { S: 'pending' },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(update!.Update).toEqual({
      TableName: 'wynding-feedback',
      Key: { pk: { S: 'quota#2026-09-28' } },
      UpdateExpression: 'ADD n :one SET expiresAt = :expires',
      ConditionExpression: 'attribute_not_exists(n) OR n < :ceiling',
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':ceiling': { N: '50' },
        ':expires': { N: String(NOW / 1000 + QUOTA_TTL_DAYS * 86400) },
      },
    });
  });

  it('keys the counter by the UTC day, not the local one', () => {
    const lateUtc = Date.UTC(2026, 8, 28, 23, 59, 59);
    const tx = surveyTransaction('t', { ...submission, receivedAtMs: lateUtc });
    expect(tx.TransactItems![1]!.Update!.Key).toEqual({ pk: { S: 'quota#2026-09-28' } });
  });

  const cancelled = (...codes: string[]): Error =>
    Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: codes.map((Code) => ({ Code })),
    });

  it('reads a cancelled transaction: the put’s failure first (a duplicate), then the counter’s', () => {
    expect(classifyFailure(cancelled('ConditionalCheckFailed', 'None'))).toBe('duplicate');
    // A lost-acknowledgement retry on a day at the ceiling is still a duplicate, not refused.
    expect(classifyFailure(cancelled('ConditionalCheckFailed', 'ConditionalCheckFailed'))).toBe(
      'duplicate',
    );
    expect(classifyFailure(cancelled('None', 'ConditionalCheckFailed'))).toBe('ceiling');
    expect(classifyFailure(cancelled('TransactionConflict', 'None'))).toBe('throttled');
    expect(classifyFailure(cancelled('ThrottlingError', 'ThrottlingError'))).toBe('throttled');
    expect(
      classifyFailure(Object.assign(new Error('x'), { name: 'TransactionCanceledException' })),
    ).toBe('throttled');
  });

  it('reads a throttle as throttled, and rethrows anything that is not a DynamoDB refusal', () => {
    for (const name of [
      'ProvisionedThroughputExceededException',
      'ThrottlingException',
      'RequestLimitExceeded',
    ]) {
      expect(classifyFailure(Object.assign(new Error('x'), { name }))).toBe('throttled');
    }
    const other = new Error('network down');
    expect(() => classifyFailure(other)).toThrow(other);
    expect(() => classifyFailure(null)).toThrow();
  });

  it('sends the transaction through the client, and maps its outcome', async () => {
    const sent: unknown[] = [];
    let fail: unknown = null;
    const client = {
      send: async (command: { input: unknown }) => {
        sent.push(command.input);
        if (fail !== null) throw fail;
        return {};
      },
    };
    const store = createDynamoSurveyStore({ tableName: 'wynding-feedback', client });
    expect(await store.put(submission)).toBe('stored');
    expect(sent[0]).toEqual(surveyTransaction('wynding-feedback', submission));
    fail = cancelled('ConditionalCheckFailed', 'None');
    expect(await store.put(submission)).toBe('duplicate');
    fail = new Error('network down');
    await expect(store.put(submission)).rejects.toThrow('network down');
  });

  it('creates a real client lazily when none is injected', () => {
    // Constructing the store must not touch AWS; only a put would.
    expect(() => createDynamoSurveyStore({ tableName: 't' })).not.toThrow();
  });
});
