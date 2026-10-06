// survey-transport.ts — the survey's real transport: a fetch to the feedback endpoint
// (wynding-site ADR 0001). `shippedSurveyTransport` decides where the shipped build injects
// it: only the web game served from wynding.net, where the endpoint is same-origin.
//
// The status mapping is the endpoint ADR's §4, and it is deliberately coarse:
//   2xx                      accepted (a stored submission, or a duplicate of one)
//   any other HTTP status    rejected (invalid, throttled, over the day's ceiling, disabled)
//   no answer in time, or    offline
//   a network failure
// The timeout is the client's half of the bounded-settle requirement: the survey holds the
// results dialog's status region while a send is in flight, so a request that never settles
// must not keep it held.

import type { SurveyPayload } from '@wynding/feedback';
import type { SurveySendResult, SurveyTransport } from './survey';

/** Same origin: the web game is served from wynding.net, and the API is `/api/*` there. */
export const SURVEY_ENDPOINT = '/api/feedback/survey';

/** How long a send may take before it reads as offline. */
export const SURVEY_TIMEOUT_MS = 10_000;

type Fetch = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok'>>;

export function createFetchTransport(options: {
  readonly fetch: Fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  /** Timer seam for tests; defaults to the global timers. */
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}): SurveyTransport {
  // Held as a plain function, never called as `options.fetch(...)`: a native `fetch` invoked
  // with `options` as its receiver throws "Illegal invocation" in browsers, which the catch
  // below would silently turn into "offline" on every send.
  const doFetch = options.fetch;
  const endpoint = options.endpoint ?? SURVEY_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? SURVEY_TIMEOUT_MS;
  const arm = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const disarm =
    options.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  return {
    async send(payload: SurveyPayload, signal: AbortSignal): Promise<SurveySendResult> {
      // A run start that already happened needs no request at all.
      if (signal.aborted) return 'offline';
      // One controller for both reasons to stop: the survey's operation token (a run start)
      // and the timeout. Combined by hand rather than `AbortSignal.any`, which older WebKit
      // (the Capacitor WebView) lacks.
      const request = new AbortController();
      const stop = (): void => request.abort();
      signal.addEventListener('abort', stop, { once: true });
      const timer = arm(stop, timeoutMs);
      try {
        const response = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: request.signal,
          // Nothing about the player rides the request: no cookies, no credentials.
          credentials: 'omit',
          cache: 'no-store',
        });
        return response.ok ? 'accepted' : 'rejected';
      } catch {
        // A timeout, a network failure, or the run-start abort (whose result the survey
        // discards anyway): none of them reached a verdict from the server.
        return 'offline';
      } finally {
        disarm(timer);
        signal.removeEventListener('abort', stop);
      }
    },
  };
}

/** The one origin the endpoint answers: it is same-origin behind the site's CloudFront, with
 *  no CORS for anything else (wynding-site ADR 0001 §1). */
export const SURVEY_ORIGIN_HOST = 'wynding.net';

/** The shipped build's survey switch (ADR 0014: the transport IS the switch). A transport
 *  only for the open-web game served from wynding.net over https. Not for a native host
 *  (ADR 0012: its WebView serves the game from its own origin, and the endpoint's CORS
 *  allowlist for host origins is added when a host ships a transport), and not for a dev
 *  server, a preview build or an e2e run on localhost, where the POST could only fail. */
export function shippedSurveyTransport(options: {
  readonly location: Pick<Location, 'protocol' | 'hostname'>;
  readonly hosted: boolean;
  readonly fetch: Fetch;
}): SurveyTransport | undefined {
  if (options.hosted) return undefined;
  if (options.location.protocol !== 'https:') return undefined;
  if (options.location.hostname !== SURVEY_ORIGIN_HOST) return undefined;
  return createFetchTransport({ fetch: options.fetch });
}
