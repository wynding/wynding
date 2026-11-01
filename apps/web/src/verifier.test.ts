import { describe, it, expect } from 'vitest';
import { validate, type ValidationResult } from '@wynding/replay';
import { getBundledRuleset } from '@wynding/content';
import { createController } from './controller';
import {
  inProcessVerifier,
  workerVerifier,
  type VerifyRequest,
  type VerifyWorkerPort,
} from './verifier';

const bundle = getBundledRuleset();

/** A finished (lost, undefended) run's replay — a real one, so a real answer exists for it. */
function finishedReplay() {
  const c = createController(7);
  c.start();
  for (let i = 0; i < 20_000 && !c.isTerminal(); i++) c.advance(50);
  expect(c.isTerminal()).toBe(true);
  return c.buildReplay();
}

/** A `Worker` stand-in: records what it is sent and whether it was terminated, and lets the
 *  test play the worker's side of the exchange. */
function fakeWorker() {
  const port: VerifyWorkerPort & {
    posted: VerifyRequest[];
    terminated: number;
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
  };
  return port;
}

describe('inProcessVerifier', () => {
  it('answers with validate()’s own result', async () => {
    const replay = finishedReplay();
    expect(await inProcessVerifier(replay, bundle)).toEqual(validate(replay, bundle));
  });
});

describe('workerVerifier — one worker per verification (M3 story 2)', () => {
  it('posts the replay and the bundle, resolves with the worker’s answer, and terminates it', async () => {
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
    const answer: ValidationResult = validate(replay, bundle);
    worker.onmessage!(new MessageEvent('message', { data: answer }));
    await expect(pending).resolves.toEqual(answer);
    expect(worker.terminated).toBe(1);
    expect(worker.onmessage, 'no handler outlives the answer').toBeNull();
  });

  it('a replay that does not validate RESOLVES — only a worker that cannot run rejects', async () => {
    const worker = fakeWorker();
    const pending = workerVerifier(() => worker)(finishedReplay(), bundle);
    worker.onmessage!(
      new MessageEvent('message', { data: { ok: false, reason: 'sim version mismatch' } }),
    );
    await expect(pending).resolves.toEqual({ ok: false, reason: 'sim version mismatch' });
  });

  it('rejects with the error’s message when the worker fails, and keeps the browser from reporting it again', async () => {
    const worker = fakeWorker();
    const pending = workerVerifier(() => worker)(finishedReplay(), bundle);
    const event = new ErrorEvent('error', {
      message: 'Failed to load the worker script',
      cancelable: true,
    });
    worker.onerror!(event);
    await expect(pending).rejects.toThrow('Failed to load the worker script');
    expect(event.defaultPrevented).toBe(true);
    expect(worker.terminated).toBe(1);

    // An error event with no message still says something.
    const silent = fakeWorker();
    const second = workerVerifier(() => silent)(finishedReplay(), bundle);
    silent.onerror!(new ErrorEvent('error', { cancelable: true }));
    await expect(second).rejects.toThrow('the verify worker failed');
  });

  it('rejects when the answer cannot be read', async () => {
    const worker = fakeWorker();
    const pending = workerVerifier(() => worker)(finishedReplay(), bundle);
    worker.onmessageerror!(new MessageEvent('messageerror'));
    await expect(pending).rejects.toThrow('could not be read');
    expect(worker.terminated).toBe(1);
  });

  it('an abandoned verification terminates its worker and rejects with the signal’s reason', async () => {
    const worker = fakeWorker();
    const abort = new AbortController();
    const pending = workerVerifier(() => worker)(finishedReplay(), bundle, abort.signal);
    abort.abort(new Error('Play again'));
    await expect(pending).rejects.toThrow('Play again');
    expect(worker.terminated).toBe(1);
    expect(worker.onmessage).toBeNull();
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
