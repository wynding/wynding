// @wynding/feedback — the end-of-run survey's WIRE CONTRACT (ADR 0014 §4, §5), shared by the
// client that builds a submission (`apps/web`) and the endpoint that accepts one (`apps/server`,
// per wynding-site's ADR 0001). One source, so the two cannot disagree about what a valid
// submission is: a second copy of this validator would drift the first time the payload changed.
//
// What lives here is only what both sides need: the payload's types and constants, the
// allowlisted builder, `replayDigest`, the full-commit-SHA rule for `gameVersion`, and the
// server-side validation. Everything about the survey's UI flow, the ask state and the session
// id stays in `apps/web/src/survey.ts`.

import { canonicalJson, sha256Hex } from '@wynding/engine';
import type { Replay } from '@wynding/replay';
import { isFullCommitSha } from './sha';

/** Payload schema version. Distinct from `simVersion` and from `PLAYTRACE_VERSION`. */
export const SURVEY_VERSION = 1;

/** §2's free-text cap, in UTF-16 code units — the unit `maxlength` counts, so the client and
 *  the server agree about text the player was allowed to type. */
export const SURVEY_TEXT_MAX = 2000;

/** A 1–5 choice (rating, difficulty). */
export type SurveyScale = 1 | 2 | 3 | 4 | 5;

function isScale(value: unknown): value is SurveyScale {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

// --- §4: the envelope ----------------------------------------------------------------------

/**
 * `replayDigest`, exactly as §4 pins it: `sha256Hex(canonicalJson(tickInputs))` through the
 * shared `@wynding/engine` helpers, over the `tickInputs` array ALONE — never a wrapper
 * carrying the identity fields, which travel and are checked separately. Synchronous
 * (`@noble/hashes`), which is why §1's cancellation has no pre-request window to cover.
 */
export function replayDigest(tickInputs: Replay['tickInputs']): string {
  return sha256Hex(canonicalJson(tickInputs));
}

/** The player's answers as the form holds them. Only `rating` is required to send. */
export interface SurveyAnswers {
  readonly rating: SurveyScale | null;
  readonly difficulty: SurveyScale | null;
  readonly somethingBroke: boolean;
  readonly text: string;
}

/** The run a submission is about (§4). Every field is read from state the app already
 *  holds; `runId`, `sessionId` and `gameVersion` are the three render-layer facts. */
export interface SurveyRunIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly gameVersion: string;
  readonly simVersion: number;
  readonly rulesetHash: string;
  readonly boardId: string;
  readonly seed: number;
  readonly outcome: 'won' | 'lost';
  readonly score: number;
  readonly stars: number;
  readonly waveCursor: number;
  readonly finalTick: number;
  readonly finalHash: string;
  readonly replayDigest: string;
}

/** What one submission carries. `difficulty` is ABSENT, not null, when unanswered. */
export interface SurveyPayload {
  readonly surveyVersion: number;
  readonly idempotencyKey: string;
  readonly answers: {
    readonly rating: SurveyScale;
    readonly difficulty?: SurveyScale;
    readonly somethingBroke: boolean;
    readonly text: string;
  };
  readonly run: SurveyRunIdentity;
}

/**
 * Assemble a submission. THE ALLOWLIST IS SERIALIZED EXPLICITLY — every field named at its
 * assignment, never an object spread or a reference — so a field added to an upstream type
 * cannot ride into a payload, and `survey.test.ts` holds the key set to exactly this list.
 * Nothing about the player, the device or their settings (§4, and ADR 0011 for the reason).
 *
 * Throws on answers the UI should never have allowed (no rating, a value outside 1–5, text
 * over the cap): those are programming errors, and a payload the server must reject is
 * better refused here than sent.
 */
export function buildSurveyPayload(input: {
  readonly answers: SurveyAnswers;
  readonly run: SurveyRunIdentity;
  readonly idempotencyKey: string;
}): SurveyPayload {
  const { answers, run } = input;
  if (!isScale(answers.rating)) throw new RangeError('survey: a rating is required to send');
  if (answers.difficulty !== null && !isScale(answers.difficulty)) {
    throw new RangeError('survey: difficulty must be 1–5 when present');
  }
  if (answers.text.length > SURVEY_TEXT_MAX) {
    throw new RangeError(`survey: text exceeds ${String(SURVEY_TEXT_MAX)} code units`);
  }
  const base = {
    rating: answers.rating,
    somethingBroke: answers.somethingBroke,
    text: answers.text,
  };
  return {
    surveyVersion: SURVEY_VERSION,
    idempotencyKey: input.idempotencyKey,
    answers: answers.difficulty === null ? base : { ...base, difficulty: answers.difficulty },
    run: {
      runId: run.runId,
      sessionId: run.sessionId,
      gameVersion: run.gameVersion,
      simVersion: run.simVersion,
      rulesetHash: run.rulesetHash,
      boardId: run.boardId,
      seed: run.seed,
      outcome: run.outcome,
      score: run.score,
      stars: run.stars,
      waveCursor: run.waveCursor,
      finalTick: run.finalTick,
      finalHash: run.finalHash,
      replayDigest: run.replayDigest,
    },
  };
}

// --- §5: the server-side validation the endpoint must enforce -------------------------------

/** `deriveStars` grades 0–3 (`packages/sim`). */
const MAX_STARS = 3;

/**
 * Whether `gameVersion` is a real revision identity — a full commit SHA (§4). A build that
 * could not resolve one carries `'unknown'` (`apps/web/build-config.ts`): every such build would share
 * one version, so one Not now would silence all of them, and every send would fail
 * validation. The survey is therefore not offered at all in such a build.
 */
export function isSubmittableGameVersion(gameVersion: string): boolean {
  return isFullCommitSha(gameVersion);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const WORLD_HASH_RE = /^[0-9a-f]{8}$/;
/** `RulesetBoard.id`'s own pattern (`packages/sim/src/ruleset-schema.ts`). */
const BOARD_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export type SurveyValidation =
  | { readonly ok: true; readonly payload: SurveyPayload }
  | { readonly ok: false; readonly reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
function unknownKey(record: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) return key;
  return null;
}

const TOP_KEYS = ['surveyVersion', 'idempotencyKey', 'answers', 'run'] as const;
const ANSWER_KEYS = ['rating', 'difficulty', 'somethingBroke', 'text'] as const;
const RUN_KEYS = [
  'runId',
  'sessionId',
  'gameVersion',
  'simVersion',
  'rulesetHash',
  'boardId',
  'seed',
  'outcome',
  'score',
  'stars',
  'waveCursor',
  'finalTick',
  'finalHash',
  'replayDigest',
] as const;

/**
 * §5's server-side validation, as a reference implementation: `rating` required and an
 * integer 1–5; `difficulty` optional and an integer 1–5 when present; `somethingBroke` a
 * boolean; the free text within the cap (never stricter than the client's); every envelope
 * field checked against its declared format; and **unknown fields rejected outright**, at
 * every level. The endpoint owns enforcement — this is what it can be checked against, and
 * the unit tests prove every payload `buildSurveyPayload` makes passes it.
 */
export function validateSurveyPayload(data: unknown): SurveyValidation {
  const fail = (reason: string): SurveyValidation => ({ ok: false, reason });
  if (!isRecord(data)) return fail('payload must be an object');
  const extraTop = unknownKey(data, TOP_KEYS);
  if (extraTop !== null) return fail(`unknown field: ${extraTop}`);
  if (data['surveyVersion'] !== SURVEY_VERSION) return fail('unsupported surveyVersion');
  const key = data['idempotencyKey'];
  if (typeof key !== 'string' || !UUID_RE.test(key)) return fail('idempotencyKey malformed');

  const answers = data['answers'];
  if (!isRecord(answers)) return fail('answers must be an object');
  const extraAnswer = unknownKey(answers, ANSWER_KEYS);
  if (extraAnswer !== null) return fail(`unknown field: answers.${extraAnswer}`);
  if (!isScale(answers['rating'])) return fail('rating must be an integer 1–5');
  if ('difficulty' in answers && !isScale(answers['difficulty'])) {
    return fail('difficulty must be an integer 1–5 when present');
  }
  if (typeof answers['somethingBroke'] !== 'boolean')
    return fail('somethingBroke must be a boolean');
  const text = answers['text'];
  if (typeof text !== 'string') return fail('text must be a string');
  if (text.length > SURVEY_TEXT_MAX) return fail('text exceeds the cap');

  const run = data['run'];
  if (!isRecord(run)) return fail('run must be an object');
  const extraRun = unknownKey(run, RUN_KEYS);
  if (extraRun !== null) return fail(`unknown field: run.${extraRun}`);
  for (const field of ['runId', 'sessionId'] as const) {
    const v = run[field];
    if (typeof v !== 'string' || !UUID_RE.test(v)) return fail(`${field} malformed`);
  }
  if (typeof run['gameVersion'] !== 'string' || !isSubmittableGameVersion(run['gameVersion'])) {
    return fail('gameVersion must be a full commit SHA');
  }
  if (!isNonNegInt(run['simVersion']) || run['simVersion'] === 0)
    return fail('simVersion malformed');
  for (const field of ['rulesetHash', 'replayDigest'] as const) {
    const v = run[field];
    if (typeof v !== 'string' || !SHA256_HEX_RE.test(v)) return fail(`${field} malformed`);
  }
  if (typeof run['boardId'] !== 'string' || !BOARD_ID_RE.test(run['boardId'])) {
    return fail('boardId malformed');
  }
  const seed = run['seed'];
  if (!isNonNegInt(seed) || seed > 0xffffffff) return fail('seed must be a uint32');
  if (run['outcome'] !== 'won' && run['outcome'] !== 'lost') return fail('outcome malformed');
  for (const field of ['score', 'stars', 'waveCursor', 'finalTick'] as const) {
    if (!isNonNegInt(run[field])) return fail(`${field} must be a non-negative integer`);
  }
  if ((run['stars'] as number) > MAX_STARS) return fail('stars out of range');
  if (typeof run['finalHash'] !== 'string' || !WORLD_HASH_RE.test(run['finalHash'])) {
    return fail('finalHash malformed');
  }
  return { ok: true, payload: data as unknown as SurveyPayload };
}
