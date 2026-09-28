import { describe, expect, it, vi } from 'vitest';
import { buildSurveyPayload, replayDigest, type SurveyPayload } from '@wynding/feedback';
import { createFetchTransport, SURVEY_ENDPOINT, SURVEY_TIMEOUT_MS } from './survey-transport';

// The fetch transport (wynding-site ADR 0001 §4): what it sends, and how every way a request
// can end maps onto the survey's three outcomes.

const UUID = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const PAYLOAD: SurveyPayload = buildSurveyPayload({
  answers: { rating: 3, difficulty: null, somethingBroke: true, text: 'a wall vanished' },
  idempotencyKey: UUID(3),
  run: {
    runId: UUID(1),
    sessionId: UUID(2),
    gameVersion: '0123456789abcdef0123456789abcdef01234567',
    simVersion: 1,
    rulesetHash: 'a'.repeat(64),
    boardId: 'first-light',
    seed: 1,
    outcome: 'won',
    score: 5,
    stars: 3,
    waveCursor: 10,
    finalTick: 900,
    finalHash: '0badf00d',
    replayDigest: replayDigest([[]] as never),
  },
});

/** A fetch whose answer the test decides, honouring the request's abort signal like the real one. */
function controllableFetch() {
  const calls: { input: string; init: RequestInit }[] = [];
  let settle: ((r: { ok: boolean }) => void) | null = null;
  let fail: ((e: unknown) => void) | null = null;
  const fetch = vi.fn(
    (input: string, init: RequestInit) =>
      new Promise<{ ok: boolean }>((resolve, reject) => {
        calls.push({ input, init });
        settle = resolve;
        fail = reject;
        // Like the real fetch: an already-aborted signal rejects at once.
        if (init.signal?.aborted === true) reject(new DOMException('aborted', 'AbortError'));
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      }),
  );
  return {
    fetch,
    calls,
    respond: (ok: boolean) => settle?.({ ok }),
    networkError: () => fail?.(new TypeError('Failed to fetch')),
  };
}

function timers() {
  let pending: (() => void) | null = null;
  let armedFor = -1;
  return {
    setTimeout: (fn: () => void, ms: number) => {
      pending = fn;
      armedFor = ms;
      return 1;
    },
    clearTimeout: vi.fn(() => {
      pending = null;
    }),
    fire: () => pending?.(),
    armedFor: () => armedFor,
  };
}

describe('createFetchTransport', () => {
  it('POSTs the payload as JSON to the same-origin endpoint, with no credentials', async () => {
    const f = controllableFetch();
    const t = createFetchTransport({ fetch: f.fetch });
    const sent = t.send(PAYLOAD, new AbortController().signal);
    f.respond(true);
    expect(await sent).toBe('accepted');
    const { input, init } = f.calls[0]!;
    expect(input).toBe(SURVEY_ENDPOINT);
    expect(SURVEY_ENDPOINT).toBe('/api/feedback/survey');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(PAYLOAD);
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
  });

  it('maps any non-2xx answer to rejected', async () => {
    const f = controllableFetch();
    const t = createFetchTransport({ fetch: f.fetch });
    const sent = t.send(PAYLOAD, new AbortController().signal);
    f.respond(false);
    expect(await sent).toBe('rejected');
  });

  it('maps a network failure to offline', async () => {
    const f = controllableFetch();
    const sent = createFetchTransport({ fetch: f.fetch }).send(
      PAYLOAD,
      new AbortController().signal,
    );
    f.networkError();
    expect(await sent).toBe('offline');
  });

  it('times out after the bounded wait and reads as offline, then disarms', async () => {
    const f = controllableFetch();
    const clock = timers();
    const sent = createFetchTransport({ fetch: f.fetch, ...clock }).send(
      PAYLOAD,
      new AbortController().signal,
    );
    expect(clock.armedFor()).toBe(SURVEY_TIMEOUT_MS);
    clock.fire();
    expect(await sent).toBe('offline');
    expect(f.calls[0]!.init.signal?.aborted).toBe(true);
    expect(clock.clearTimeout).toHaveBeenCalled();
  });

  it('a run start (the operation token) aborts the request', async () => {
    const f = controllableFetch();
    const operation = new AbortController();
    const sent = createFetchTransport({ fetch: f.fetch }).send(PAYLOAD, operation.signal);
    operation.abort();
    expect(await sent).toBe('offline');
    expect(f.calls[0]!.init.signal?.aborted).toBe(true);
  });

  it('an operation already aborted never waits on the network', async () => {
    const f = controllableFetch();
    const operation = new AbortController();
    operation.abort();
    expect(await createFetchTransport({ fetch: f.fetch }).send(PAYLOAD, operation.signal)).toBe(
      'offline',
    );
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('removes its abort listener from the operation signal on every path', async () => {
    for (const end of ['respond', 'networkError'] as const) {
      const f = controllableFetch();
      const operation = new AbortController();
      const removed = vi.spyOn(operation.signal, 'removeEventListener');
      const sent = createFetchTransport({ fetch: f.fetch }).send(PAYLOAD, operation.signal);
      if (end === 'respond') f.respond(true);
      else f.networkError();
      await sent;
      expect(removed, end).toHaveBeenCalledWith('abort', expect.any(Function));
    }
  });

  it('calls fetch as a plain function, never as a method of its options', async () => {
    // A native fetch called with the options object as its receiver throws in browsers.
    let receiver: unknown = 'unset';
    const fetch = function (this: unknown) {
      receiver = this;
      return Promise.resolve({ ok: true });
    };
    await createFetchTransport({ fetch }).send(PAYLOAD, new AbortController().signal);
    expect(receiver).toBeUndefined();
  });

  it('uses the real timers by default, and honours an endpoint override', async () => {
    const f = controllableFetch();
    const sent = createFetchTransport({
      fetch: f.fetch,
      endpoint: '/elsewhere',
      timeoutMs: 5,
    }).send(PAYLOAD, new AbortController().signal);
    expect(f.calls[0]!.input).toBe('/elsewhere');
    expect(await sent).toBe('offline'); // the 5 ms real timer fired
  });
});
