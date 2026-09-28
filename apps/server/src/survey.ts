// apps/server — the feedback endpoint's survey handler (`POST /api/feedback/survey`).
//
// The mechanism is wynding-site's ADR 0001 (accepted 2026-09-28): CloudFront `/api/*` in front
// of an API Gateway HTTP API in front of this Lambda, with one DynamoDB table. The CONTRACT is
// this repo's ADR 0014, and the validator is the one the client is tested against
// (`@wynding/feedback`), so the two cannot disagree about what a valid submission is.
//
// In order, before anything is stored (ADR 0001 §4):
//   1. POST only (405). API Gateway routes nothing else here; this is the belt to that.
//   2. CloudFront's origin secret header, compared in constant time (403). The API Gateway
//      invoke URL is public; this is what makes the API usable only through CloudFront. It
//      comes BEFORE the kill switch, so a direct caller cannot even learn whether the survey
//      is switched on. (With no secret configured, nobody can be authenticated: 503.) The
//      secret is an SSM SecureString, read once per execution environment, so it is never in
//      the function's configuration or in the deploy workflow that writes that configuration.
//   3. The kill switch (503): the handler is OFF unless `SURVEY_ENABLED` is exactly `true`,
//      and it is also off if any other setting is missing, so a half-configured deploy
//      refuses rather than half-works.
//   4. A body over 16 KiB (413), a body that is not JSON (400), and anything
//      `validateSurveyPayload` refuses (400).
//   5. The transactional put (`survey-store.ts`): accepted (200), a duplicate of an already
//      stored submission (also 200), or 503 when the day's ceiling is reached or DynamoDB
//      throttles.
//
// LOGGING IS A FIXED OUTCOME CODE AND NOTHING ELSE (ADR 0001 §8). Never the payload, the free
// text, the `sessionId` or `runId`, never the validator's reason (it names the offending
// field, which the sender chooses) and never an error message (a JSON parse error can quote
// the input). The log is one line per request, `{"survey":"<code>"}`, which is also what the
// "ceiling reached" metric filter and alarm count.

import { timingSafeEqual } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { validateSurveyPayload, type SurveyPayload } from '@wynding/feedback';
import { createDynamoSurveyStore, type SurveyStore } from './survey-store';

/** The largest body accepted, in bytes. A maximal honest survey is about 13 KiB: 2000 code
 *  units that JSON-escape to at most 6 bytes each, plus about 1 KiB of envelope. */
export const SURVEY_MAX_BODY_BYTES = 16 * 1024;

/** The header CloudFront adds to every `/api/*` request (its value is the origin secret). */
export const ORIGIN_SECRET_HEADER = 'x-wynding-origin';

/** Every outcome the handler can log. The ONLY thing it logs. */
export type SurveyOutcome =
  | 'accepted'
  | 'duplicate'
  | 'method'
  | 'forbidden'
  | 'disabled'
  | 'too_large'
  | 'bad_json'
  | 'invalid'
  | 'ceiling'
  | 'throttled'
  | 'error'
  | 'config_error';

/** The slice of an API Gateway HTTP API (payload v2) event this handler reads. */
export interface HttpApiEvent {
  readonly requestContext?: { readonly http?: { readonly method?: string } };
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
}

export interface HttpApiResult {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** What the handler needs from its environment, already parsed. `null` = misconfigured. */
export interface SurveyConfig {
  readonly tableName: string;
  readonly noticeVersion: string;
  readonly dailyCeiling: number;
}

/** Reads one SecureString parameter, decrypted. `undefined` when it has no value. */
export type GetParameter = (name: string) => Promise<string | undefined>;

/** The origin secret, read on its own: the handler checks it before the kill switch, so it
 *  must be available whether or not the survey is switched on. `ORIGIN_SECRET_PARAM` names the
 *  SSM parameter; empty means none configured. A failed read rejects (retried after a backoff). */
export async function readOriginSecret(
  env: Readonly<Record<string, string | undefined>>,
  getParameter: GetParameter,
): Promise<string> {
  const name = env['ORIGIN_SECRET_PARAM'] ?? '';
  if (name === '') return '';
  return (await getParameter(name)) ?? '';
}

/** Read the configuration from the Lambda environment. Returns null (and so disables the
 *  handler) unless it is switched on and every setting is present and well-formed. */
export function readSurveyConfig(
  env: Readonly<Record<string, string | undefined>>,
): SurveyConfig | null {
  if (env['SURVEY_ENABLED'] !== 'true') return null;
  const tableName = env['TABLE_NAME'] ?? '';
  const noticeVersion = env['PRIVACY_NOTICE_VERSION'] ?? '';
  const ceiling = Number(env['DAILY_CEILING'] ?? '50');
  if (tableName === '' || noticeVersion === '') return null;
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) return null;
  return { tableName, noticeVersion, dailyCeiling: ceiling };
}

function respond(statusCode: number, outcome: SurveyOutcome): HttpApiResult {
  // Deliberately the same shape for every answer, and never an echo of the payload.
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ status: outcome }),
  };
}

function sameSecret(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on unequal lengths; a length mismatch is simply a mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The body as text, or null when it is over the cap. Sized BEFORE anything is copied or
 *  decoded, so an oversized request costs no allocation of its own size. */
function decodeBody(event: HttpApiEvent): string | null {
  const raw = event.body ?? '';
  if (event.isBase64Encoded !== true) {
    return Buffer.byteLength(raw, 'utf8') > SURVEY_MAX_BODY_BYTES ? null : raw;
  }
  // Base64 inflates by 4/3: anything longer than the cap's encoding cannot decode under it.
  if (raw.length > Math.ceil(SURVEY_MAX_BODY_BYTES / 3) * 4 + 4) return null;
  const bytes = Buffer.from(raw, 'base64');
  return bytes.length > SURVEY_MAX_BODY_BYTES ? null : bytes.toString('utf8');
}

function header(event: HttpApiEvent, name: string): string | undefined {
  // API Gateway HTTP APIs lower-case header names; a direct caller might not.
  const headers = event.headers ?? {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

export function createSurveyHandler(deps: {
  readonly originSecret: string;
  readonly config: SurveyConfig | null;
  readonly store: SurveyStore;
  readonly now: () => number;
  readonly log: (line: string) => void;
}): (event: HttpApiEvent) => Promise<HttpApiResult> {
  const { originSecret, config, store, now, log } = deps;
  const finish = (statusCode: number, outcome: SurveyOutcome): HttpApiResult => {
    log(JSON.stringify({ survey: outcome }));
    return respond(statusCode, outcome);
  };

  return async (event) => {
    if (event.requestContext?.http?.method !== 'POST') return finish(405, 'method');
    if (originSecret === '') return finish(503, 'disabled');
    if (!sameSecret(header(event, ORIGIN_SECRET_HEADER), originSecret)) {
      return finish(403, 'forbidden');
    }
    if (config === null) return finish(503, 'disabled');

    const text = decodeBody(event);
    if (text === null) return finish(413, 'too_large');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return finish(400, 'bad_json');
    }
    const result = validateSurveyPayload(data);
    if (!result.ok) return finish(400, 'invalid');

    const payload: SurveyPayload = result.payload;
    let stored;
    try {
      stored = await store.put({
        idempotencyKey: payload.idempotencyKey,
        sessionId: payload.run.sessionId,
        runId: payload.run.runId,
        payloadJson: JSON.stringify(payload),
        noticeVersion: config.noticeVersion,
        receivedAtMs: now(),
        dailyCeiling: config.dailyCeiling,
      });
    } catch {
      return finish(503, 'error');
    }
    switch (stored) {
      case 'stored':
        return finish(200, 'accepted');
      case 'duplicate':
        return finish(200, 'duplicate');
      case 'ceiling':
        return finish(503, 'ceiling');
      case 'throttled':
        return finish(503, 'throttled');
    }
  };
}

type SurveyHandler = (event: HttpApiEvent) => Promise<HttpApiResult>;

/** After a failed SSM read, how long before another is attempted. Requests in between answer
 *  503 without calling SSM, so strangers hammering the public invoke URL during a
 *  misconfiguration cannot turn each request into an SSM call (the account's GetParameter
 *  throughput is shared with other functions). */
export const SECRET_RETRY_BACKOFF_MS = 10_000;

/** The Lambda entry point, configured on first use (a cold start) so importing this module has
 *  no side effects. The method is checked first, so only a POST can cause the SSM read. A read
 *  that fails is NOT cached: requests answer 503 `config_error`, and the read is tried again
 *  once SECRET_RETRY_BACKOFF_MS has passed. Exported as a factory so tests can supply the
 *  seams. */
export function createLambdaEntry(deps: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getParameter: GetParameter;
  readonly createStore: (tableName: string) => SurveyStore;
  readonly now: () => number;
  readonly log: (line: string) => void;
}): SurveyHandler {
  let configured: SurveyHandler | null = null;
  let retryAfter = 0;
  const fail = (statusCode: number, outcome: SurveyOutcome): HttpApiResult => {
    deps.log(JSON.stringify({ survey: outcome }));
    return respond(statusCode, outcome);
  };
  return async (event) => {
    if (configured === null) {
      // The same first check the handler makes, before anything costs an SSM call.
      if (event.requestContext?.http?.method !== 'POST') return fail(405, 'method');
      if (deps.now() < retryAfter) return fail(503, 'config_error');
      let originSecret: string;
      try {
        originSecret = await readOriginSecret(deps.env, deps.getParameter);
      } catch {
        retryAfter = deps.now() + SECRET_RETRY_BACKOFF_MS;
        return fail(503, 'config_error');
      }
      const config = readSurveyConfig(deps.env);
      configured = createSurveyHandler({
        originSecret,
        config,
        store: deps.createStore(config?.tableName ?? ''),
        now: deps.now,
        log: deps.log,
      });
    }
    return configured(event);
  };
}

/** The production SSM read: one attempt plus one retry, each bounded, so an unreachable
 *  endpoint fails fast into the fixed `config_error` answer instead of hanging until the
 *  Lambda timeout. The client is built on first use. Exported so the request shape is
 *  testable with a stand-in client. */
const ignore = (): void => undefined;
const silent = { debug: ignore, info: ignore, warn: ignore, error: ignore };

export const SSM_CLIENT_CONFIG = {
  maxAttempts: 2,
  requestHandler: {
    connectionTimeout: 1000,
    requestTimeout: 2000,
    // Without this the request timeout only WARNS (to the console, a free-text log line)
    // and the request keeps waiting until the Lambda timeout.
    throwOnRequestTimeout: true,
    // And the handler's own warnings stay out of the log, which carries fixed codes only.
    logger: silent,
  },
} as const;

export function createSsmGetParameter(
  makeClient: () => Pick<SSMClient, 'send'> = () => new SSMClient(SSM_CLIENT_CONFIG),
): GetParameter {
  let client: Pick<SSMClient, 'send'> | null = null;
  return async (name) => {
    client ??= makeClient();
    const out = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return out.Parameter?.Value;
  };
}

export const handler: SurveyHandler = createLambdaEntry({
  env: process.env,
  getParameter: createSsmGetParameter(),
  createStore: (tableName) => createDynamoSurveyStore({ tableName }),
  now: () => Date.now(),
  log: (line) => console.log(line),
});
