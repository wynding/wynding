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
  type VerifyPage,
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

/** A page whose visibility the test sets: `hide()` and `show()` change it and say so, as a
 *  browser does when the app is backgrounded and brought back. */
function fakePage(initially: DocumentVisibilityState = 'visible') {
  const target = new EventTarget();
  const page = {
    visibilityState: initially,
    addEventListener: (type: 'visibilitychange', listener: () => void) =>
      target.addEventListener(type, listener),
    removeEventListener: (type: 'visibilitychange', listener: () => void) =>
      target.removeEventListener(type, listener),
    hide(): void {
      page.visibilityState = 'hidden';
      target.dispatchEvent(new Event('visibilitychange'));
    },
    show(): void {
      page.visibilityState = 'visible';
      target.dispatchEvent(new Event('visibilitychange'));
    },
  } satisfies VerifyPage & Record<string, unknown>;
  return page;
}

/** A verifier over `worker`, on a page that stays visible unless the test says otherwise. */
const over = (worker: VerifyWorkerPort, page: VerifyPage = fakePage()) =>
  workerVerifier(() => worker, page);

/** Whether `pending` has settled yet, readable without awaiting it. */
function track<T>(pending: Promise<{ value?: T; error?: unknown }>) {
  const state = { done: false };
  void pending.then(() => (state.done = true));
  return state;
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
    }, fakePage());
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
    const pending = over(worker)(finishedReplay(), bundle);
    worker.send(ready);
    worker.send(answer({ ok: false, reason: 'sim version mismatch' }));
    await expect(pending).resolves.toEqual({ ok: false, reason: 'sim version mismatch' });
  });

  it('a worker that fails BEFORE ready rejects as unavailable, with what it said, and the browser does not report it again', async () => {
    const worker = fakeWorker();
    const pending = over(worker)(finishedReplay(), bundle);
    const event = new ErrorEvent('error', { message: 'worker exploded', cancelable: true });
    worker.onerror!(event);
    const { error } = await outcome(pending);
    expect(error).toBeInstanceOf(VerifyError);
    expect(error).toMatchObject({ failure: 'unavailable', message: 'worker exploded' });
    expect(event.defaultPrevented).toBe(true);
    expect(worker.terminated).toBe(1);
  });

  it('a worker that fails to LOAD — a plain Event, no message, before ready — still rejects with a reason', async () => {
    const worker = fakeWorker();
    const pending = over(worker)(finishedReplay(), bundle);
    worker.onerror!(new Event('error', { cancelable: true }));
    const { error } = await outcome(pending);
    expect(error).toMatchObject({ failure: 'unavailable', message: 'the verify worker failed' });
    expect(worker.terminated).toBe(1);
  });

  it('a worker that fails AFTER ready crashed — it started — and says what the browser said', async () => {
    const worker = fakeWorker();
    const pending = over(worker)(finishedReplay(), bundle);
    worker.send(ready);
    const event = new ErrorEvent('error', { message: 'out of memory', cancelable: true });
    worker.onerror!(event);
    const { error } = await outcome(pending);
    expect(error).toBeInstanceOf(VerifyError);
    expect(error).toMatchObject({ failure: 'crashed', message: 'out of memory' });
    expect(event.defaultPrevented).toBe(true);
    expect(worker.terminated).toBe(1);

    // With nothing to say, it still has a reason.
    const silent = fakeWorker();
    const second = over(silent)(finishedReplay(), bundle);
    silent.send(ready);
    silent.onerror!(new Event('error', { cancelable: true }));
    const { error: quiet } = await outcome(second);
    expect(quiet).toMatchObject({ failure: 'crashed', message: 'the verify worker stopped' });
  });

  it('a worker that cannot be created rejects as unavailable', async () => {
    const pending = workerVerifier(() => {
      throw new Error('Worker is not defined');
    }, fakePage())(finishedReplay(), bundle);
    const { error } = await outcome(pending);
    expect(error).toMatchObject({ failure: 'unavailable', message: 'Worker is not defined' });
  });

  it.each([
    ['before', false],
    ['after', true],
  ])('rejects as unreadable when a message cannot be read, %s ready', async (_, afterReady) => {
    const worker = fakeWorker();
    const pending = over(worker)(finishedReplay(), bundle);
    if (afterReady) worker.send(ready);
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
    const pending = over(worker)(finishedReplay(), bundle);
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
    const settled = outcome(over(worker)(finishedReplay(), bundle));
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
    const settled = outcome(over(worker)(finishedReplay(), bundle));
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
    const pending = over(worker)(finishedReplay(), bundle, abort.signal);
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
    const settled = outcome(over(worker)(replay, bundle, abort.signal));
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
    }, fakePage());
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
    const pending = over(worker)(finishedReplay(), bundle, signal);
    listeners[0]!();
    await expect(pending).rejects.toThrow('verification abandoned');
  });
});

describe('workerVerifier — the windows run only while the page is visible (M3 story 2)', () => {
  // A backgrounded app suspends its worker; a timer that came due meanwhile must not call the
  // verification "too long" the moment the app comes back.
  it('hiding the page stops both windows, and showing it starts them again at full length', async () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    const page = fakePage();
    const settled = outcome(over(worker, page)(finishedReplay(), bundle));
    const state = track(settled);
    await vi.advanceTimersByTimeAsync(VERIFY_READY_TIMEOUT_MS - 1_000);
    page.hide();
    expect(vi.getTimerCount(), 'no window runs while hidden').toBe(0);
    await vi.advanceTimersByTimeAsync(10 * VERIFY_TIMEOUT_MS); // backgrounded for a long time
    expect(state.done).toBe(false);
    expect(worker.terminated).toBe(0);

    page.show(); // the ready window starts again in full, not with its last second
    await vi.advanceTimersByTimeAsync(VERIFY_READY_TIMEOUT_MS - 1);
    expect(state.done, 'a full ready window after the page came back').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await settled;
    expect(error).toMatchObject({ failure: 'unavailable' });
    expect(worker.terminated).toBe(1);
  });

  it('after ready, only the answer window comes back, at full length', async () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    const page = fakePage();
    const settled = outcome(over(worker, page)(finishedReplay(), bundle));
    const state = track(settled);
    worker.send(ready);
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS - 1_000);
    page.hide();
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS);
    page.show();
    expect(vi.getTimerCount(), 'the answer window alone').toBe(1);
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS - 1);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await settled).error).toMatchObject({ failure: 'timeout' });
  });

  it('a page hidden when Verify starts starts its windows when it is shown', async () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    const page = fakePage('hidden');
    const settled = outcome(over(worker, page)(finishedReplay(), bundle));
    expect(vi.getTimerCount()).toBe(0);
    expect(worker.posted, 'the request is sent regardless').toHaveLength(1);
    page.show();
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(VERIFY_READY_TIMEOUT_MS);
    expect((await settled).error).toMatchObject({ failure: 'unavailable' });
  });

  it('a verification that has answered no longer listens to the page', async () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    const page = fakePage();
    const replay = finishedReplay();
    const pending = over(worker, page)(replay, bundle);
    worker.send(ready);
    worker.send(answer(validate(replay, bundle)));
    await expect(pending).resolves.toMatchObject({ ok: true });
    page.hide();
    page.show();
    expect(vi.getTimerCount(), 'nothing re-armed for a finished verification').toBe(0);
  });
});
