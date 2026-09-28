import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@wynding/engine';
import {
  SURVEY_TEXT_MAX,
  SURVEY_VERSION,
  buildSurveyPayload,
  isFullCommitSha,
  isSubmittableGameVersion,
  replayDigest,
  validateSurveyPayload,
  type SurveyAnswers,
  type SurveyPayload,
  type SurveyRunIdentity,
} from './index';

// The wire contract's own tests. The identity here is a fixed, well-formed one; that the
// formats match what a REAL run produces is `apps/web/src/survey.test.ts`'s job, which builds
// a payload from a live controller and runs it through this same validator.

const UUID = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SHA = '0123456789abcdef0123456789abcdef01234567';

function identity(): SurveyRunIdentity {
  return {
    runId: UUID(1),
    sessionId: UUID(2),
    gameVersion: SHA,
    simVersion: 1,
    rulesetHash: 'a'.repeat(64),
    boardId: 'first-light',
    seed: 12345,
    outcome: 'lost',
    score: 0,
    stars: 0,
    waveCursor: 0,
    finalTick: 100,
    finalHash: '0badf00d',
    replayDigest: replayDigest([[]] as never),
  };
}

describe('isFullCommitSha — the one gameVersion identity rule', () => {
  it('accepts a full SHA-1 or SHA-256 object id, lowercase only', () => {
    expect(isFullCommitSha(SHA)).toBe(true);
    expect(isFullCommitSha('b'.repeat(64))).toBe(true);
    for (const bad of [
      '',
      'unknown',
      SHA.slice(0, 12),
      SHA.toUpperCase(),
      `${SHA}0`,
      'g'.repeat(40),
    ]) {
      expect(isFullCommitSha(bad), bad).toBe(false);
    }
  });

  it('is exactly what a submittable gameVersion is', () => {
    for (const v of [SHA, 'b'.repeat(64), 'unknown', SHA.slice(0, 12)]) {
      expect(isSubmittableGameVersion(v)).toBe(isFullCommitSha(v));
    }
  });
});

describe('replayDigest (ADR 0014 §4 — pinned, not described)', () => {
  it('is exactly sha256Hex(canonicalJson(tickInputs)) through the shared helpers', () => {
    const tickInputs = [[], [{ type: 'callWaveEarly' }], []] as never;
    expect(replayDigest(tickInputs)).toBe(sha256Hex(canonicalJson(tickInputs)));
    expect(replayDigest(tickInputs)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is a function of the log alone: a different log differs, the same log agrees', () => {
    const a = [[], []] as never;
    const b = [[], [], []] as never;
    expect(replayDigest(a)).toBe(replayDigest(JSON.parse(JSON.stringify(a)) as never));
    expect(replayDigest(a)).not.toBe(replayDigest(b));
  });
});

const ANSWERS: SurveyAnswers = { rating: 4, difficulty: null, somethingBroke: false, text: '' };

function payload(overrides: Partial<SurveyAnswers> = {}): SurveyPayload {
  return buildSurveyPayload({
    answers: { ...ANSWERS, ...overrides },
    run: identity(),
    idempotencyKey: UUID(3),
  });
}

/** A deep copy with one path replaced (or deleted with `undefined` + `del`). */
function mutate(base: SurveyPayload, fn: (draft: Record<string, unknown>) => void): unknown {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  fn(draft);
  return draft;
}

describe('replayDigest (ADR 0014 §4 — pinned, not described)', () => {
  it('is exactly sha256Hex(canonicalJson(tickInputs)) through the shared helpers', () => {
    const tickInputs = [[], [{ type: 'callWaveEarly' }], []] as never;
    expect(replayDigest(tickInputs)).toBe(sha256Hex(canonicalJson(tickInputs)));
    expect(replayDigest(tickInputs)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is a function of the log alone: a different log differs, the same log agrees', () => {
    const a = [[], []] as never;
    const b = [[], [], []] as never;
    expect(replayDigest(a)).toBe(replayDigest(JSON.parse(JSON.stringify(a)) as never));
    expect(replayDigest(a)).not.toBe(replayDigest(b));
  });
});

describe('buildSurveyPayload — the explicit allowlist (§4)', () => {
  it('carries exactly the ADR’s fields, at every level, and nothing else', () => {
    const p = payload({ difficulty: 2, somethingBroke: true, text: 'the tower vanished' });
    expect(Object.keys(p).sort()).toEqual(['answers', 'idempotencyKey', 'run', 'surveyVersion']);
    expect(Object.keys(p.answers).sort()).toEqual([
      'difficulty',
      'rating',
      'somethingBroke',
      'text',
    ]);
    expect(Object.keys(p.run).sort()).toEqual(
      [
        'boardId',
        'finalHash',
        'finalTick',
        'gameVersion',
        'outcome',
        'replayDigest',
        'rulesetHash',
        'runId',
        'score',
        'seed',
        'sessionId',
        'simVersion',
        'stars',
        'waveCursor',
      ].sort(),
    );
    expect(p.surveyVersion).toBe(SURVEY_VERSION);
  });

  it('never lets an upstream field ride in by reference', () => {
    // A future field on the identity object must not reach the payload unlisted.
    const run = { ...identity(), deviceId: 'leak', colourMode: 'protan' } as SurveyRunIdentity;
    const p = buildSurveyPayload({ answers: ANSWERS, run, idempotencyKey: UUID(3) });
    expect(p.run).not.toHaveProperty('deviceId');
    expect(p.run).not.toHaveProperty('colourMode');
    expect(p.run).not.toBe(run);
  });

  it('omits difficulty when unanswered rather than sending null', () => {
    expect(payload()).not.toHaveProperty('answers.difficulty');
    expect(payload({ difficulty: 5 }).answers.difficulty).toBe(5);
  });

  it('refuses answers the UI should never have allowed', () => {
    expect(() => payload({ rating: null })).toThrow(RangeError);
    expect(() => payload({ difficulty: 6 as never })).toThrow(RangeError);
    expect(() => payload({ text: 'x'.repeat(SURVEY_TEXT_MAX + 1) })).toThrow(RangeError);
  });

  it('produces payloads the server-side validation accepts', () => {
    for (const overrides of [
      {},
      { difficulty: 1 as const },
      { somethingBroke: true, text: 'x'.repeat(SURVEY_TEXT_MAX) },
    ]) {
      const result = validateSurveyPayload(JSON.parse(JSON.stringify(payload(overrides))));
      expect(result).toMatchObject({ ok: true });
    }
  });
});

describe('validateSurveyPayload — §5’s server-side check, unknown fields rejected', () => {
  const base = payload({ difficulty: 3 });
  const reject = (data: unknown): string => {
    const result = validateSurveyPayload(data);
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.reason;
  };

  it('rejects an unknown field at every level', () => {
    expect(reject(mutate(base, (d) => (d['extra'] = 1)))).toMatch(/unknown field: extra/);
    expect(
      reject(mutate(base, (d) => ((d['answers'] as Record<string, unknown>)['email'] = 'x'))),
    ).toMatch(/answers\.email/);
    expect(
      reject(mutate(base, (d) => ((d['run'] as Record<string, unknown>)['deviceId'] = 'x'))),
    ).toMatch(/run\.deviceId/);
  });

  it('requires rating as an integer 1–5', () => {
    for (const bad of [undefined, null, 0, 6, 2.5, '3', true]) {
      reject(
        mutate(base, (d) => {
          const answers = d['answers'] as Record<string, unknown>;
          if (bad === undefined) delete answers['rating'];
          else answers['rating'] = bad;
        }),
      );
    }
  });

  it('allows difficulty absent, but not present-and-invalid (null included)', () => {
    expect(
      validateSurveyPayload(
        mutate(base, (d) => delete (d['answers'] as Record<string, unknown>)['difficulty']),
      ).ok,
    ).toBe(true);
    for (const bad of [null, 0, 6, '2']) {
      reject(mutate(base, (d) => ((d['answers'] as Record<string, unknown>)['difficulty'] = bad)));
    }
  });

  it('caps text in UTF-16 code units — the unit maxlength counts, never stricter', () => {
    const astral = '😀'.repeat(SURVEY_TEXT_MAX / 2); // two code units each
    expect(astral.length).toBe(SURVEY_TEXT_MAX);
    expect(
      validateSurveyPayload(
        mutate(base, (d) => ((d['answers'] as Record<string, unknown>)['text'] = astral)),
      ).ok,
    ).toBe(true);
    reject(mutate(base, (d) => ((d['answers'] as Record<string, unknown>)['text'] = `${astral}x`)));
  });

  it('checks every envelope field against its declared format', () => {
    const cases: [string, unknown][] = [
      ['runId', 'not-a-uuid'],
      ['sessionId', UUID(1).toUpperCase().replace('0000', 'ZZZZ')],
      ['gameVersion', 'v1.2.3'],
      ['gameVersion', SHA.slice(0, 12)],
      ['simVersion', 0],
      ['simVersion', 1.5],
      ['rulesetHash', 'abc'],
      ['replayDigest', 'z'.repeat(64)],
      ['boardId', 'Bad Board'],
      ['seed', -1],
      ['seed', 0x100000000],
      ['outcome', 'draw'],
      ['score', -1],
      ['stars', 1.5],
      ['stars', 4],
      ['waveCursor', '2'],
      ['finalTick', null],
      ['finalHash', 'deadbeef00'],
    ];
    for (const [field, value] of cases) {
      reject(mutate(base, (d) => ((d['run'] as Record<string, unknown>)[field] = value)));
    }
  });

  it('accepts a SHA-256 repository’s 64-hex revision as gameVersion', () => {
    const ok = mutate(
      base,
      (d) => ((d['run'] as Record<string, unknown>)['gameVersion'] = 'b'.repeat(64)),
    );
    expect(validateSurveyPayload(ok).ok).toBe(true);
  });

  it('rejects a wrong version, a malformed key and non-object shapes', () => {
    reject(mutate(base, (d) => (d['surveyVersion'] = SURVEY_VERSION + 1)));
    reject(mutate(base, (d) => (d['idempotencyKey'] = 'k')));
    for (const bad of [null, [], 'payload', 7]) reject(bad);
    reject(mutate(base, (d) => (d['answers'] = [])));
    reject(mutate(base, (d) => (d['run'] = null)));
    reject(mutate(base, (d) => ((d['answers'] as Record<string, unknown>)['somethingBroke'] = 1)));
    reject(mutate(base, (d) => ((d['answers'] as Record<string, unknown>)['text'] = 7)));
  });
});
