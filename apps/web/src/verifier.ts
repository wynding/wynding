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

/** Re-simulates `replay` against `bundle` and resolves with the validator's result. Rejects
 *  only when the verification could not run at all (a worker that failed, or one `signal`
 *  abandoned): a replay that does not validate RESOLVES, with `ok: false`. */
export type Verifier = (
  replay: Replay,
  bundle: Ruleset,
  signal?: AbortSignal,
) => Promise<ValidationResult>;

/** On the calling thread. For unit tests, never the shipped app's Verify. */
export const inProcessVerifier: Verifier = (replay, bundle) =>
  Promise.resolve(validate(replay, bundle));

/** The main thread's side of a worker: as much of `Worker` as {@link workerVerifier} uses. */
export interface VerifyWorkerPort {
  onmessage: ((event: MessageEvent<ValidationResult>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(request: VerifyRequest): void;
  terminate(): void;
}

/** The shipped worker. Vite emits `verify-worker.ts` as a chunk of its own because the
 *  `new URL(…, import.meta.url)` is written inside the `Worker` call; `type: 'module'` lets the
 *  dev server serve it as ES modules. jsdom has no `Worker`, so only the e2e Verify specs run
 *  this — in a browser, against the built app. */
export function spawnVerifyWorker(): VerifyWorkerPort {
  return new Worker(new URL('./verify-worker.ts', import.meta.url), {
    type: 'module',
    name: 'wynding-verify',
  });
}

/** A {@link Verifier} that runs each verification in a worker of its own from `spawn`. */
export function workerVerifier(spawn: () => VerifyWorkerPort): Verifier {
  return (replay, bundle, signal) =>
    new Promise<ValidationResult>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abandoned(signal));
        return;
      }
      const worker = spawn();
      const onAbort = (): void => {
        finish();
        reject(abandoned(signal!));
      };
      function finish(): void {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        signal?.removeEventListener('abort', onAbort);
        worker.terminate();
      }
      worker.onmessage = (event) => {
        finish();
        resolve(event.data);
      };
      worker.onerror = (event) => {
        // Handled here, so the browser does not also report it as an uncaught error.
        event.preventDefault();
        finish();
        reject(new Error(event.message === '' ? 'the verify worker failed' : event.message));
      };
      worker.onmessageerror = () => {
        finish();
        reject(new Error('the verify worker’s answer could not be read'));
      };
      signal?.addEventListener('abort', onAbort);
      worker.postMessage({ replay, bundle });
    });
}

/** Why an abandoned verification rejected: the signal's own reason when it carries one. */
function abandoned(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('verification abandoned');
}
