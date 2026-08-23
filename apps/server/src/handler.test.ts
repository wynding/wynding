// handler.test.ts — the Lambda re-simulates a submitted replay into a trusted score.

import { describe, it, expect } from 'vitest';
import { currentRulesetHash, type Replay } from '@wynding/replay';
import { SIM_VERSION } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from '@wynding/content';
import { handler } from './handler';

const m1Ruleset = getBundledRuleset();
const M1_BOARD_ID = defaultBoardId(m1Ruleset);

function validReplayBody(): string {
  const replay: Replay = {
    seed: 12345,
    boardId: M1_BOARD_ID,
    rulesetHash: currentRulesetHash(m1Ruleset),
    simVersion: SIM_VERSION,
    // Launch the wave; undefended, it leaks out → the validator drives to terminal.
    tickInputs: [[{ kind: 'callWaveEarly' }]],
  };
  return JSON.stringify(replay);
}

describe('lambda handler', () => {
  it('returns a 200 with a derived score + stars for a valid replay', async () => {
    const res = await handler({ body: validReplayBody() });
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as {
      ok: boolean;
      score: number;
      stars: number;
      finalHash: string;
    };
    expect(payload.ok).toBe(true);
    expect(typeof payload.score).toBe('number');
    expect(typeof payload.stars).toBe('number');
    expect(payload.finalHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('rejects an empty/missing body with 400', async () => {
    const res = await handler({ body: null });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'missing replay payload' });
  });

  // The 400 guard has TWO arms and they are not interchangeable, so both are pinned by
  // their error text as well as their status. Unparseable input dies in the `catch`
  // around `JSON.parse`; input that parses to a non-object reaches the shape check one
  // line later. Merging or reordering them — the tempting "both return 400 anyway"
  // refactor — makes one of these two cases report the other's message.
  it('rejects a body that is not JSON at all with 400 (the parse arm)', async () => {
    const res = await handler({ body: '{' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'invalid JSON body' });
  });

  it('rejects valid JSON that is not a replay object with 400 (the shape arm)', async () => {
    const res = await handler({ body: '42' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'missing replay payload' });
  });

  it('rejects a replay from a different sim version with 422', async () => {
    const bad = JSON.stringify({
      seed: 1,
      boardId: M1_BOARD_ID,
      rulesetHash: '0'.repeat(64),
      simVersion: 999,
      tickInputs: [],
    });
    const res = await handler({ body: bad });
    expect(res.statusCode).toBe(422);
  });
});
