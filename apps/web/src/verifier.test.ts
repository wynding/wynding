import { describe, it, expect, vi, afterEach } from 'vitest';
import { validate, type ValidationResult } from '@wynding/replay';
import { getBundledRuleset } from '@wynding/content';
import { createController } from './controller';
import {
  inProcessVerifier,
  workerVerifier,
  VerifyError,
  VERIFY_READY_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
  type VerifyRequest,
  type VerifyWorkerPort,
} from './verifier';

const bundle = getBundledRuleset();

afterEach(() => {
  vi.useRealTimers();
});

/** A finished (lost, undefended) run: its replay, and what the live run ended on. */
function finishedRun() {
  const c = createController(7);
  c.start();
  for (let i = 0; i < 20_000 && !c.isTerminal(); i++) c.advance(50);
  expect(c.isTerminal()).toBe(true);
  return { replay: c.buildReplay(), hud: c.hud(), stateHash: c.capture().stateHash };
}
const finishedReplay = () => finishedRun().replay;

/** A `Worker` stand-in: records what it is sent and whether it was terminated, and lets the
 *  test play the worker's side of the exchange. */
function fakeWorker() {
  const port: VerifyWorkerPort & {
    posted: VerifyRequest[];
    terminated: number;
    send(data: unknown): void;
  } = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    posted: [],
    terminated: 0,
    postMessage(request) {
      this.posted.push(request);
    },
    terminate() {
      this.terminated++;
    },
    send(data) {
      this.onmessage?.(new MessageEvent('message', { data }));
    },
  };
  return port;
}

/** The worker's two messages. */
const ready = { kind: 'ready' } as const;
const answer = (result: ValidationResult) => ({ kind: 'result', result }) as const;

/** What `pending` settled to — read without leaving a rejection unhandled while timers run. */
function outcome<T>(pending: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe('inProcessVerifier', () => {
  it('re-simulates the run to the outcome the live run ended on', async () => {
    const { replay, hud, stateHash } = finishedRun();
    const r = await inProcessVerifier(replay, bundle);
    expect(r.ok).toBe(true);
    expect(r.score).toBe(hud.score);
    expect(r.stars).toBe(hud.stars);
    expect(r.finalHash).toBe(stateHash);
  });
});

describe('workerVerifier — one worker per verification (M3 story 2)', () => {
  it('posts the replay and the bundle, resolves with the worker’s answer, and terminates it', async () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    let spawned = 0;
    const verify = workerVerifier(() => {
      spawned++;
      return worker;
    });
    const replay = finishedReplay();
    const pending = verify(replay, bundle);
    expect(spawned).toBe(1);
    expect(worker.posted).toEqual([{ replay, bundle }]);
    const result: ValidationResult = validate(replay, bundle);
    worker.send(ready);
    worker.send(answer(result));
    await expect(pending).resolves.toEqual(result);
    expect(worker.terminated).toBe(1);
    expect(worker.onmessage, 'no handler outlives the answer').toBeNull();
    expect(vi.getTimerCount(), 'no timer outlives the answer').toBe(0);
  });

  it('a replay that does not validate RESOLVES — only a worker that cannot run rejects', async () => {
    const worker = fakeWorker();
    const pending = workerVerifier(() => worker)(finishedReplay(), bundle);
    worker.send(ready);
    worker.send(answer({ ok: false, reason: 'sim version mismatch' }));
    await expect(pending).resolves.toEqual({ ok: false, reason: 'sim version mismatch' });
  });

  it('a worker that throws rejects as unavailable, with what it said, and the browser does not report it again', async () => {
    const worker = fakeWorker();
    const pending = workerVerifier(() => worker)(finishedReplay(), bundle);
    const event = new ErrorEvent('error', { message: 'worker exploded', cancelable: true });
    worker.onerror!(event);
    const { error } = await outcome(pending);
    expect(error).toBeInstanceOf(VerifyError);
    expect(error).toMatchObject({ failure: 'unavailable', message: 'worker exploded' });
    expect(event.defaultPrevented).toBe(true);
    expect(worker.terminated).toBe(1);
  });

  it('a worker that fails to LOAD — a plain Event, no message — still rejects with a reason', async () => {
    const worker = fakeWorker();
    const pending = workerVerifier(() => worker)(finishedReplay(), bundle);
    worker.onerror!(new Event('error', { cancelable: true }));
    const { error } = await outcome(pending);
    expect(error).toMatchObject({ failure: 'unavailable', message: 'the verify worker failed' });
    expect(worker.terminated).toBe(1);
  });

  it('a worker that cannot be created rejects as unavailable', async () => {
    const pending = workerVerifier(() => {
      throw new Error('Worker is not defined');
    })(finishedReplay(), bundle);
    const { error } = await outcome(pending);
    expect(error).toMatchObject({ failure: 'unavailable', message: 'Worker is not defined' });
  });

  it('rejects as unreadable when the answer cannot be read', async () => {
    const worker = fakeWorker();
    const pending = workerVerifier(() => worker)(finishedReplay(), bundle);
    worker.onmessageerror!(new MessageEvent('messageerror'));
    const { error } = await outcome(pending);
    expect(error).toMatchObject({ failure: 'unreadable' });
    expect(worker.terminated).toBe(1);
  });

  it.each([
    ['a bare validation result (no envelope)', { ok: true }],
    ['a result without a verdict', { kind: 'result', result: { score: 1 } }],
    ['a result that is not an object', { kind: 'result', result: 'ok' }],
    ['an unknown kind', { kind: 'progress' }],
    ['not an object at all', 'done'],
    ['null', null],
  ])('rejects as unreadable on a message of the wrong shape: %s', async (_, data) => {
    const worker = fakeWorker();
    const pending = workerVerifier(() => worker)(finishedReplay(), bundle);
    worker.send(ready);
    worker.send(data);
    const { value, error } = await outcome(pending);
    expect(value, 'never passed off as a result').toBeUndefined();
    expect(error).toMatchObject({ failure: 'unreadable' });
    expect(worker.terminated).toBe(1);
  });

  it('a worker that never says ready fails as unavailable once the ready window passes', async () => {
    // A stalled load, or a host scheme that swallows the request, fires no error event at all.
    vi.useFakeTimers();
    const worker = fakeWorker();
    const settled = outcome(workerVerifier(() => worker)(finishedReplay(), bundle));
    let done = false;
    void settled.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(VERIFY_READY_TIMEOUT_MS - 1);
    expect(done, 'still waiting just inside the window').toBe(false);
    expect(worker.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await settled;
    expect(error).toMatchObject({ failure: 'unavailable' });
    expect(worker.terminated).toBe(1);
    expect(worker.onmessage).toBeNull();
    expect(vi.getTimerCount(), 'the answer timer went with it').toBe(0);
  });

  it('a worker that said ready but never answers fails as a timeout once the answer window passes', async () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    const settled = outcome(workerVerifier(() => worker)(finishedReplay(), bundle));
    let done = false;
    void settled.then(() => (done = true));
    worker.send(ready);
    // Past the ready window: being ready, it is no longer judged by it.
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS - 1);
    expect(done, 'still waiting just inside the window').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await settled;
    expect(error).toBeInstanceOf(VerifyError);
    expect(error).toMatchObject({ failure: 'timeout' });
    expect(worker.terminated).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an abandoned verification terminates its worker and rejects with the signal’s reason', async () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    const abort = new AbortController();
    const pending = workerVerifier(() => worker)(finishedReplay(), bundle, abort.signal);
    abort.abort(new Error('Play again'));
    await expect(pending).rejects.toThrow('Play again');
    expect(worker.terminated).toBe(1);
    expect(worker.onmessage).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an abort AFTER the answer neither terminates the worker again nor rejects', async () => {
    const worker = fakeWorker();
    const abort = new AbortController();
    const replay = finishedReplay();
    const settled = outcome(workerVerifier(() => worker)(replay, bundle, abort.signal));
    worker.send(ready);
    worker.send(answer(validate(replay, bundle)));
    abort.abort(); // Play again, pressed after the answer landed
    const { value, error } = await settled;
    expect(error).toBeUndefined();
    expect(value?.ok).toBe(true);
    expect(worker.terminated, 'terminated once, by the answer').toBe(1);
  });

  it('a signal already aborted spawns nothing', async () => {
    let spawned = 0;
    const abort = new AbortController();
    abort.abort();
    const verify = workerVerifier(() => {
      spawned++;
      return fakeWorker();
    });
    await expect(verify(finishedReplay(), bundle, abort.signal)).rejects.toBeDefined();
    expect(spawned).toBe(0);
  });

  it('a signal with no reason of its own still rejects with an error', async () => {
    // jsdom's AbortController supplies a DOMException; a bare signal-like object does not.
    const worker = fakeWorker();
    const listeners: (() => void)[] = [];
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: (_: string, l: () => void) => void listeners.push(l),
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    const pending = workerVerifier(() => worker)(finishedReplay(), bundle, signal);
    listeners[0]!();
    await expect(pending).rejects.toThrow('verification abandoned');
  });
});
