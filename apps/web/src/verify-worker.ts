// verify-worker.ts — the in-app Verify worker (M3 story 2). Its only consumer is `verifier.ts`'s
// `spawnVerifyWorker`, whose `new Worker(new URL(…))` Vite emits as a chunk of its own.
//
// It answers every request with `validate()`'s result and nothing else. `validate()` is total,
// so every request gets an answer; a throw from below it would reach the main thread as the
// worker's `error` event, which `workerVerifier` turns into a failed verification.
//
// The import from `./verifier` is TYPE-ONLY and must stay so: a value import would pull
// `spawnVerifyWorker`, and with it a `new Worker` of this very file, into this file's chunk.

import { validate, type ValidationResult } from '@wynding/replay';
import type { VerifyRequest } from './verifier';

/** As much of `DedicatedWorkerGlobalScope` as this uses — this app's `lib` is the DOM's, which
 *  types `self.postMessage` as a window's. */
interface VerifyWorkerScope {
  onmessage: ((event: MessageEvent<VerifyRequest>) => void) | null;
  postMessage(result: ValidationResult): void;
}

const scope = self as unknown as VerifyWorkerScope;
scope.onmessage = (event) => {
  scope.postMessage(validate(event.data.replay, event.data.bundle));
};
