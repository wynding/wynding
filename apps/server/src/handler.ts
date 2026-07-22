// apps/server — AWS Lambda handler that turns an untrusted client replay into a
// trusted score by RE-SIMULATING it with the same deterministic sim the client
// ran. Because the sim is a pure function of (seed, inputs), the server arrives
// at the exact final state the client saw — so scores can't be forged by
// tampering with a claimed result; only a valid input log reproduces the score.
//
// Minimal API-Gateway-style event/result shapes are declared locally to keep the
// stub free of an @types/aws-lambda dependency; swap them for the real types when
// wiring the deployment (Function URL / API Gateway proxy integration).

import { validate, currentRulesetHash, type Replay } from '@wynding/replay';
import { m1Ruleset } from '@wynding/content';

// The authored ruleset bundle the server re-validates against. The submitted replay
// carries its own `boardId` (Story 5); `validate` resolves the board from the bundle
// and binds the content-derived ruleset digest before re-simulating.
const rulesetBundle = m1Ruleset;
// The bundle is a fixed module constant, so its digest is computed ONCE at cold start
// (not re-hashed per request — code-review).
const RULESET_HASH = currentRulesetHash(rulesetBundle);

interface LambdaEvent {
  readonly body?: string | null;
}

interface LambdaResult {
  readonly statusCode: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

function json(statusCode: number, payload: unknown): LambdaResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export async function handler(event: LambdaEvent): Promise<LambdaResult> {
  let replay: Replay;
  try {
    replay = JSON.parse(event.body ?? 'null') as Replay;
  } catch {
    return json(400, { ok: false, error: 'invalid JSON body' });
  }
  if (replay === null || typeof replay !== 'object') {
    return json(400, { ok: false, error: 'missing replay payload' });
  }

  const result = validate(replay, rulesetBundle);
  if (!result.ok) {
    return json(422, { ok: false, error: result.reason });
  }

  return json(200, {
    ok: true,
    score: result.score,
    stars: result.stars,
    finalHash: result.finalHash,
    ticks: result.ticks,
    rulesetHash: RULESET_HASH,
  });
}
