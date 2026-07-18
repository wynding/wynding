// replay.test.ts — the validator re-simulates deterministically and derives a
// stable, tamper-evident score.

import { describe, it, expect } from 'vitest';
import type { SimInput } from '@wynding/sim';
import { validate, currentRulesetHash, type Replay } from './index';

function makeReplay(overrides: Partial<Replay> = {}): Replay {
  const spawn: SimInput[] = [{ kind: 'spawnCreep', hp: 10, lane: 2 }];
  return {
    seed: 12345,
    rulesetHash: currentRulesetHash(),
    simVersion: 1,
    tickInputs: Array.from({ length: 200 }, (_v, t) => (t % 4 === 0 ? spawn : [])),
    ...overrides,
  };
}

describe('replay validate()', () => {
  it('re-simulates to a stable final hash and score', () => {
    const first = validate(makeReplay());
    const again = validate(makeReplay());
    expect(first.ok).toBe(true);
    expect(first.finalHash).toBeDefined();
    expect(first.finalHash).toBe(again.finalHash);
    expect(first.score).toBe(again.score);
    expect(first.ticks).toBe(200);
  });

  it('rejects a replay recorded under a different sim version', () => {
    const result = validate(makeReplay({ simVersion: 999 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('sim version mismatch');
  });

  it('rejects a replay recorded under a different ruleset', () => {
    const result = validate(makeReplay({ rulesetHash: 'deadbeef' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ruleset hash mismatch');
  });

  it('derives a lower score when more creeps leak', () => {
    const spawn: SimInput[] = [{ kind: 'spawnCreep', hp: 10, lane: 1 }];
    const heavy = validate(makeReplay({ tickInputs: Array.from({ length: 200 }, () => spawn) }));
    const light = validate(makeReplay({ tickInputs: Array.from({ length: 200 }, () => []) }));
    expect(heavy.ok && light.ok).toBe(true);
    expect(heavy.score ?? 0).toBeLessThan(light.score ?? 0);
  });

  it('exposes an 8-hex-char ruleset hash', () => {
    expect(currentRulesetHash()).toMatch(/^[0-9a-f]{8}$/);
  });
});
