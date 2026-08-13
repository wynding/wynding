// apps/server — AWS Lambda handler that turns an untrusted client replay into a
// trusted score by RE-SIMULATING it with the same deterministic sim the client
// ran. Because the sim is a pure function of (seed, ruleset, boardId, inputs), the server arrives
// at the exact final state the client saw — so scores can't be forged by
// tampering with a claimed result; only a valid input log reproduces the score.
//
// Minimal API-Gateway-style event/result shapes are declared locally to keep the
// stub free of an @types/aws-lambda dependency; swap them for the real types when
// wiring the deployment (Function URL / API Gateway proxy integration).

import { readFileSync } from 'node:fs';
import { validate, type Replay } from '@wynding/replay';
import { parseRulesetJson, compileRuleset } from '@wynding/sim';
import { BUNDLED_ARTIFACT_URL } from '@wynding/content/artifact';

// Cold-start disk path (M2-S1 Validation architecture): read the shipped artifact's
// TEXT from disk and parse+validate it through the SAME `parseRulesetJson` the
// client's registry runs over its bundler-embedded copy of the identical bytes — the
// two independent loaders (ADR 0007 §2) can never accept/reject different bundles on
// the same file. Importing `@wynding/content/artifact` (never the main `.` registry
// entry) means this module never drags the bundler-embedded raw text into the
// server's module graph.
const rulesetBundle = parseRulesetJson(readFileSync(BUNDLED_ARTIFACT_URL, 'utf8'));
// The default board id, computed LOCALLY — never imported from the content registry's
// `defaultBoardId` (that would pull the bundled text in too, Codex R3-1). The
// validator guarantees `boards` has at least one entry.
const DEFAULT_BOARD_ID = rulesetBundle.boards[0]!.id;
// Compile the default board at module init (not just at first request) so a bad
// deploy fails fast at COLD START, never as a per-request 422. The bundle is a fixed
// module constant, so this (and the digest it carries) happens ONCE per cold start.
const compiledDefault = compileRuleset(rulesetBundle, DEFAULT_BOARD_ID);
const RULESET_HASH = compiledDefault.digest;

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
