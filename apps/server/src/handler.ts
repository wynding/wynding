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
import { loadBoard } from '@wynding/sim';
import { sampleBoard } from '@wynding/content';

// The board the submitted replay was played on. Interim: pinned to the single
// authored board until Story 5 resolves a `boardId` carried on the replay itself.
// Built once at module load — the geometry is static content.
const matchBoard = loadBoard(sampleBoard);

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

  const result = validate(replay, matchBoard);
  if (!result.ok) {
    return json(422, { ok: false, error: result.reason });
  }

  return json(200, {
    ok: true,
    score: result.score,
    finalHash: result.finalHash,
    ticks: result.ticks,
    rulesetHash: currentRulesetHash(),
  });
}
