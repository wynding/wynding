// replay.test.ts — the validator re-simulates deterministically and derives a
// stable, tamper-evident score.

import { describe, it, expect } from 'vitest';
import { loadBoard, type BoardContext, type SimInput } from '@wynding/sim';
import { validate, currentRulesetHash, type Replay } from './index';

// A small 3×3 board (entrance (0,1) → exit (2,1)) so creeps leak quickly within the
// replay's tick budget. The caller supplies the board — a replay carries none yet.
const BOARD: BoardContext = loadBoard({
  widthTiles: 3,
  heightTiles: 3,
  entrance: { col: 0, row: 1 },
  exit: { col: 2, row: 1 },
});

function makeReplay(overrides: Partial<Replay> = {}): Replay {
  const spawn: SimInput[] = [{ kind: 'spawnCreep', hp: 10 }];
  return {
    seed: 12345,
    rulesetHash: currentRulesetHash(),
    simVersion: 3,
    tickInputs: Array.from({ length: 200 }, (_v, t) => (t % 4 === 0 ? spawn : [])),
    ...overrides,
  };
}

describe('replay validate()', () => {
  it('re-simulates to a stable final hash and score', () => {
    const first = validate(makeReplay(), BOARD);
    const again = validate(makeReplay(), BOARD);
    expect(first.ok).toBe(true);
    expect(first.finalHash).toBeDefined();
    expect(first.finalHash).toBe(again.finalHash);
    expect(first.score).toBe(again.score);
    expect(first.ticks).toBe(200);
  });

  it('rejects a replay recorded under a different sim version', () => {
    const result = validate(makeReplay({ simVersion: 999 }), BOARD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('sim version mismatch');
  });

  it('rejects a replay recorded under a different ruleset', () => {
    const result = validate(makeReplay({ rulesetHash: 'deadbeef' }), BOARD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ruleset hash mismatch');
  });

  it('derives a lower score when more creeps leak', () => {
    const spawn: SimInput[] = [{ kind: 'spawnCreep', hp: 10 }];
    const heavy = validate(
      makeReplay({ tickInputs: Array.from({ length: 200 }, () => spawn) }),
      BOARD,
    );
    const light = validate(
      makeReplay({ tickInputs: Array.from({ length: 200 }, () => []) }),
      BOARD,
    );
    expect(heavy.ok && light.ok).toBe(true);
    expect(heavy.score ?? 0).toBeLessThan(light.score ?? 0);
  });

  it('exposes an 8-hex-char ruleset hash', () => {
    expect(currentRulesetHash()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('rejects a replay whose tick count exceeds the budget before re-simulating', () => {
    const result = validate(
      makeReplay({ tickInputs: Array.from({ length: 36_001 }, () => []) }),
      BOARD,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('too many ticks');
  });

  it('rejects a replay with too many inputs on a single tick', () => {
    const burst: SimInput[] = Array.from({ length: 65 }, () => ({ kind: 'spawnCreep', hp: 10 }));
    const result = validate(makeReplay({ tickInputs: [burst] }), BOARD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('too many inputs');
  });

  it('rejects a replay whose total spawns exceed the budget', () => {
    const spawn: SimInput[] = [{ kind: 'spawnCreep', hp: 10 }];
    const result = validate(
      makeReplay({ tickInputs: Array.from({ length: 10_001 }, () => spawn) }),
      BOARD,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('too many spawns');
  });

  it('rejects a replay whose total tower commands exceed the budget', () => {
    // Each placeTower runs a grid-wide Dijkstra in the invariant check and a
    // rejected build is a free no-op, so — like spawns — tower commands are
    // capped across the whole match to bound the validate() CPU cost.
    const build: SimInput[] = [{ kind: 'placeTower', anchor: { col: 1, row: 1 } }];
    const result = validate(
      makeReplay({ tickInputs: Array.from({ length: 1_001 }, () => build) }),
      BOARD,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('too many tower commands');
  });

  it('rejects a malformed input element without throwing', () => {
    // `tickInputs` is untrusted: a null/undefined/non-object element must be
    // rejected as a typed 4xx, not throw a TypeError (which would surface as a 500).
    const malformed = [[null]] as unknown as Replay['tickInputs'];
    const result = validate(makeReplay({ tickInputs: malformed }), BOARD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('malformed');
  });

  it('rejects a non-array tickInputs', () => {
    const bad = 'not-an-array' as unknown as Replay['tickInputs'];
    const result = validate(makeReplay({ tickInputs: bad }), BOARD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tickInputs must be an array');
  });

  it('rejects a tick whose inputs are not an array', () => {
    const bad = ['not-a-tick'] as unknown as Replay['tickInputs'];
    const result = validate(makeReplay({ tickInputs: bad }), BOARD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('inputs must be an array');
  });
});

describe('replay validate() — complete command-union validation (ADR 0006 §4)', () => {
  const withInput = (input: unknown): Replay =>
    makeReplay({ tickInputs: [[input]] as unknown as Replay['tickInputs'] });

  it('rejects an unknown command kind', () => {
    const result = validate(withInput({ kind: 'teleportCreep' }), BOARD);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unknown command kind');
  });

  it('rejects a spawnCreep whose hp is not a positive safe integer', () => {
    for (const hp of [0, -1, 1.5, '10', null, Infinity, 2 ** 53]) {
      const result = validate(withInput({ kind: 'spawnCreep', hp }), BOARD);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('spawnCreep.hp');
    }
  });

  it('rejects a sellTower whose tower id is not a safe integer', () => {
    for (const tower of ['x', 1.5, null, undefined, NaN]) {
      const result = validate(withInput({ kind: 'sellTower', tower }), BOARD);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('sellTower.tower');
    }
  });

  it('rejects a placeTower whose anchor is not a safe-integer cell', () => {
    for (const anchor of [null, undefined, 'cell', 7, { col: 0.5, row: 1 }, { row: 1 }, {}]) {
      const result = validate(withInput({ kind: 'placeTower', anchor }), BOARD);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('placeTower.anchor');
    }
  });

  it('rejects a placeTower whose safe-integer anchor is out of the board (malformed, not a no-op)', () => {
    // design-notes/replay-and-commands.md classifies an out-of-bounds integer as
    // malformed — the validator rejects it rather than letting step() no-op it.
    // BOARD is 3×3, so any coord < 0 or ≥ 3 is off-board.
    for (const anchor of [
      { col: -1, row: 1 },
      { col: 3, row: 1 },
      { col: 1, row: -1 },
      { col: 1, row: 3 },
    ]) {
      const result = validate(withInput({ kind: 'placeTower', anchor }), BOARD);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('out of bounds');
    }
  });

  it('accepts well-formed place/sell commands and re-simulates deterministically', () => {
    // Domain-valid but unplaceable on the tiny board — the sim no-ops the build
    // (in-sim legality is the sim's job; the validator gates only wire-format domain).
    const inputs: Replay['tickInputs'] = [
      [{ kind: 'placeTower', anchor: { col: 1, row: 1 } }],
      [{ kind: 'sellTower', tower: 1 }],
      [{ kind: 'noop' }],
    ];
    const first = validate(makeReplay({ tickInputs: inputs }), BOARD);
    const again = validate(makeReplay({ tickInputs: inputs }), BOARD);
    expect(first.ok).toBe(true);
    expect(first.finalHash).toBe(again.finalHash);
  });
});
