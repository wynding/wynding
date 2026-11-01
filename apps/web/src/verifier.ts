// verifier.ts — where in-app Verify re-simulates a finished run (M3 story 2).
//
// Verify hands the recorded replay to `@wynding/replay`'s `validate()`, the check the server
// makes, and that re-runs the whole match. An M3 run is 4–5× an M2 run, which on the main
// thread froze the results dialog for seconds on a low-end phone. So the shipped app runs it
// in a dedicated module worker (`verify-worker.ts`): the sim and replay packages touch no DOM,
// so they run there unchanged, and the main thread only posts the replay and the bundle and
// waits for the validator's own result, structured-cloned back. The answer cannot change: it
// is the same function over the same inputs.
//
// ONE WORKER PER VERIFICATION, terminated once it answers. It keeps no state between runs, and
// terminating it is the whole of cancellation: a verification the player walked away from
// (Play again) stops spending a core at once rather than finishing for no one.
//
// A WORKER THAT NEVER ANSWERS MUST STILL END THE VERIFICATION. A load that stalls, or a host
// scheme that swallows the request, fires no `error` event, and "Verifying…" would stand for
// good. So the worker says it is ready the moment its module has loaded; no word within
// {@link VERIFY_READY_TIMEOUT_MS} is a worker that could not start, and no answer within
// {@link VERIFY_TIMEOUT_MS} of the press is one that took too long. Both reject with a
// {@link VerifyError}, and both terminate the worker. `ready` also tells the two ways a worker
// can fail apart: an `error` before it is one that could not start, and after it one that
// crashed while verifying.
//
// THE WINDOWS RUN ONLY WHILE THE PAGE IS VISIBLE. A phone that backgrounds the app suspends the
// worker with it, and a timer that came due meanwhile would fire on resume and call a
// verification that was never given its time "too long". So both timers stop when the page is
// hidden and start again, at their full length, when it is visible.
//
// The verifier is injected because jsdom has no `Worker`: unit tests verify in-process with
// {@link inProcessVerifier}, and the shipped app — `main.ts`'s default — with
// {@link workerVerifier} over {@link spawnVerifyWorker}.

import { validate, type Replay, type ValidationResult } from '@wynding/replay';
import type { Ruleset } from '@wynding/content';

/** What the main thread posts to the worker: the run, and the bundle it was played under. */
export interface VerifyRequest {
  readonly replay: Replay;
  readonly bundle: Ruleset;
}

/** What the worker posts back: `ready` once, as its module finishes loading, then one
 *  `result` per request. */
export type VerifyWorkerMessage =
  { readonly kind: 'ready' } | { readonly kind: 'result'; readonly result: ValidationResult };

/** No `ready` within this long of the spawn, or of the page's return to view: the worker could
 *  not start. Loading the worker's one chunk takes well under a second; 15 s allows for a slow
 *  device and a cold cache. */
export const VERIFY_READY_TIMEOUT_MS = 15_000;

/** No answer within this long of the spawn, or of the page's return to view: the verification
 *  took too long. A 30-wave run verifies in about 5 s on ADR 0005's low-end profile, so this is
 *  a stall, not a slow phone. */
export const VERIFY_TIMEOUT_MS = 120_000;

/** Why a verification could not run at all. `main.ts` says which, in the player's language. */
export type VerifyFailure = 'unavailable' | 'crashed' | 'timeout' | 'unreadable';

/** A verification that could not run: the worker could not start (`unavailable`), failed
 *  after it had (`crashed`), took too long (`timeout`), or answered with something that was
 *  not an answer (`unreadable`). The message carries what the browser said, when it said
 *  anything, for whoever debugs it. */
export class VerifyError extends Error {
  constructor(
    readonly failure: VerifyFailure,
    message: string,
  ) {
    super(message);
    this.name = 'VerifyError';
  }
}

/** Re-simulates `replay` against `bundle` and resolves with the validator's result. Rejects
 *  only when the verification could not run (a {@link VerifyError}) or `signal` abandoned it:
 *  a replay that does not validate RESOLVES, with `ok: false`. */
export type Verifier = (
  replay: Replay,
  bundle: Ruleset,
  signal?: AbortSignal,
) => Promise<ValidationResult>;

/** On the calling thread. For unit tests, never the shipped app's Verify. */
export const inProcessVerifier: Verifier = (replay, bundle) =>
  Promise.resolve(validate(replay, bundle));

/** The main thread's side of a worker: as much of `Worker` as {@link workerVerifier} uses.
 *  `onerror` takes a plain `Event`: a worker whose script fails to LOAD fires one with no
 *  `message`, unlike the `ErrorEvent` of a throw inside it. */
export interface VerifyWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(request: VerifyRequest): void;
  terminate(): void;
}

/** The shipped worker. Vite emits `verify-worker.ts` as a chunk of its own because the
 *  `new URL(…, import.meta.url)` is written inside the `Worker` call; `type: 'module'` lets the
 *  dev server serve it as ES modules. jsdom has no `Worker`, so only the e2e Verify specs run
 *  this — in a browser, against the built app. Asserted to the port because the DOM lib types
 *  `onerror`'s event as an `ErrorEvent`, and a script that fails to load fires a plain `Event`. */
export function spawnVerifyWorker(): VerifyWorkerPort {
  return new Worker(new URL('./verify-worker.ts', import.meta.url), {
    type: 'module',
    name: 'wynding-verify',
  }) as VerifyWorkerPort;
}

/** `data` as a message the worker sends, or null when it is not one. Checked rather than
 *  trusted: an answer of the wrong shape must fail the verification, not pass for a result. */
function readMessage(data: unknown): VerifyWorkerMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const { kind, result } = data as { kind?: unknown; result?: unknown };
  if (kind === 'ready') return { kind };
  if (
    kind === 'result' &&
    typeof result === 'object' &&
    result !== null &&
    typeof (result as { ok?: unknown }).ok === 'boolean'
  ) {
    return { kind, result: result as ValidationResult };
  }
  return null;
}

/** The page whose visibility pauses a verification's windows: as much of `Document` as
 *  {@link workerVerifier} uses. */
export interface VerifyPage {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** A {@link Verifier} that runs each verification in a worker of its own from `spawn`, its
 *  windows paused while `page` is hidden. */
export function workerVerifier(spawn: () => VerifyWorkerPort, page: VerifyPage): Verifier {
  return (replay, bundle, signal) =>
    new Promise<ValidationResult>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abandoned(signal));
        return;
      }
      let worker: VerifyWorkerPort;
      try {
        worker = spawn();
      } catch (error) {
        reject(
          new VerifyError('unavailable', describe(error, 'the verify worker could not start')),
        );
        return;
      }
      /** Whether the worker has said `ready`: its module loaded, so it started. */
      let ready = false;
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      let answerTimer: ReturnType<typeof setTimeout> | undefined;
      function disarm(): void {
        clearTimeout(readyTimer);
        clearTimeout(answerTimer);
      }
      /** Start both windows afresh, at their full length — the ready one only while the
       *  worker has not said it yet. */
      function arm(): void {
        disarm();
        if (!ready) {
          readyTimer = setTimeout(() => {
            fail(new VerifyError('unavailable', 'the verify worker did not start in time'));
          }, VERIFY_READY_TIMEOUT_MS);
        }
        answerTimer = setTimeout(() => {
          fail(new VerifyError('timeout', 'the verify worker did not answer in time'));
        }, VERIFY_TIMEOUT_MS);
      }
      const onVisibility = (): void => {
        if (page.visibilityState === 'visible') arm();
        else disarm();
      };
      const onAbort = (): void => {
        fail(abandoned(signal!));
      };
      function finish(): void {
        disarm();
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        signal?.removeEventListener('abort', onAbort);
        page.removeEventListener('visibilitychange', onVisibility);
        worker.terminate();
      }
      function fail(reason: unknown): void {
        finish();
        reject(reason);
      }
      worker.onmessage = (event) => {
        const message = readMessage(event.data);
        if (message === null) {
          fail(
            new VerifyError('unreadable', 'the verify worker sent something that is not an answer'),
          );
        } else if (message.kind === 'ready') {
          ready = true;
          clearTimeout(readyTimer);
        } else {
          finish();
          resolve(message.result);
        }
      };
      worker.onerror = (event) => {
        // Handled here, so the browser does not also report it as an uncaught error.
        event.preventDefault();
        fail(
          ready
            ? new VerifyError('crashed', describe(event, 'the verify worker stopped'))
            : new VerifyError('unavailable', describe(event, 'the verify worker failed')),
        );
      };
      // Either side of `ready` this is a message that could not be read — after it, the
      // answer itself — so it is `unreadable` either way, never a failure to start.
      worker.onmessageerror = () => {
        fail(new VerifyError('unreadable', 'the verify worker’s answer could not be read'));
      };
      signal?.addEventListener('abort', onAbort);
      page.addEventListener('visibilitychange', onVisibility);
      onVisibility(); // a page hidden already starts its windows when it is next shown
      worker.postMessage({ replay, bundle });
    });
}

/** What an error or error event says about itself, or `fallback` when it says nothing. */
function describe(source: unknown, fallback: string): string {
  const message = (source as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message !== '' ? message : fallback;
}

/** Why an abandoned verification rejected: the signal's own reason when it carries one. */
function abandoned(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('verification abandoned');
}
