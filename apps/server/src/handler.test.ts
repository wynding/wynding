// handler.test.ts — the Lambda re-simulates a submitted replay into a trusted score.

import { describe, it, expect } from 'vitest';
import { currentRulesetHash, type Replay } from '@wynding/replay';
import type { SimInput } from '@wynding/sim';
import { handler } from './handler';

function validReplayBody(): string {
  const spawn: SimInput[] = [{ kind: 'spawnCreep', hp: 10, lane: 2 }];
  const replay: Replay = {
    seed: 12345,
    rulesetHash: currentRulesetHash(),
    simVersion: 1,
    tickInputs: Array.from({ length: 100 }, (_v, t) => (t % 4 === 0 ? spawn : [])),
  };
  return JSON.stringify(replay);
}

describe('lambda handler', () => {
  it('returns a 200 with a derived score for a valid replay', async () => {
    const res = await handler({ body: validReplayBody() });
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as { ok: boolean; score: number; finalHash: string };
    expect(payload.ok).toBe(true);
    expect(typeof payload.score).toBe('number');
    expect(payload.finalHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('rejects an empty/missing body with 400', async () => {
    const res = await handler({ body: null });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a replay from a different sim version with 422', async () => {
    const bad = JSON.stringify({ seed: 1, rulesetHash: 'x', simVersion: 999, tickInputs: [] });
    const res = await handler({ body: bad });
    expect(res.statusCode).toBe(422);
  });
});
