// replay.test.ts — the validator re-simulates to a deterministic TERMINAL state and
// derives a trusted score, binding the replay to a content-derived ruleset digest
// (ADR 0006 anti-cheat spine).

import { describe, it, expect } from 'vitest';
import { SIM_VERSION, type SimInput } from '@wynding/sim';
import { m1Ruleset, M1_BOARD_ID } from '@wynding/content';
import type { Ruleset } from '@wynding/types';
import { validate, currentRulesetHash, type Replay } from './index';

const HASH = currentRulesetHash(m1Ruleset);
const HEX64 = /^[0-9a-f]{64}$/;

function makeReplay(overrides: Partial<Replay> = {}): Replay {
  return {
    seed: 12345,
    boardId: M1_BOARD_ID,
    rulesetHash: HASH,
    simVersion: SIM_VERSION,
    // Launch the wave; with no defense every creep leaks → the validator drives empty
    // ticks to the terminal (loss) and derives the score from that terminal state.
    tickInputs: [[{ kind: 'callWaveEarly' }]],
    ...overrides,
  };
}

describe('replay validate() — terminal re-simulation + score', () => {
  it('re-simulates to a stable terminal hash, score, and stars', () => {
    const first = validate(makeReplay(), m1Ruleset);
    const again = validate(makeReplay(), m1Ruleset);
    expect(first.ok).toBe(true);
    expect(first.finalHash).toBeDefined();
    expect(first.finalHash).toBe(again.finalHash);
    expect(first.score).toBe(again.score);
    expect(first.stars).toBe(again.stars);
    // Undefended M1: the wave leaks out → a loss (0 stars, score = kill-bounties = 0).
    expect(first.stars).toBe(0);
    expect(first.score).toBe(0);
    expect((first.ticks ?? 0) < 36_000).toBe(true); // terminated well before the ceiling
  });

  it('exposes a 64-hex content-derived ruleset hash', () => {
    expect(HASH).toMatch(HEX64);
  });
});

describe('replay validate() — envelope structural validation', () => {
  it('rejects a non-negative-safe-integer seed', () => {
    for (const seed of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1] as number[]) {
      const r = validate(makeReplay({ seed }), m1Ruleset);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('seed');
    }
  });

  it('rejects a non-object replay', () => {
    const r = validate(null as unknown as Replay, m1Ruleset);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('replay must be an object');
  });

  it('rejects an empty / non-string boardId', () => {
    const r = validate(makeReplay({ boardId: '' }), m1Ruleset);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('boardId');
  });

  it('rejects a replay recorded under a different sim version', () => {
    const r = validate(makeReplay({ simVersion: 999 }), m1Ruleset);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('sim version mismatch');
  });

  it('rejects a rulesetHash that is not a 64-hex digest', () => {
    const r = validate(makeReplay({ rulesetHash: 'deadbeef' }), m1Ruleset);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('64-char hex');
  });

  it('rejects a 64-hex rulesetHash that does not match the bundle', () => {
    const r = validate(makeReplay({ rulesetHash: '0'.repeat(64) }), m1Ruleset);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('ruleset hash mismatch');
  });

  it('rejects an unknown boardId (the bundle cannot resolve it)', () => {
    const r = validate(makeReplay({ boardId: 'no-such-board' }), m1Ruleset);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('boardId');
  });
});

describe('replay validate() — re-simulation budget caps', () => {
  it('rejects a replay whose tick count exceeds the budget', () => {
    const r = validate(
      makeReplay({ tickInputs: Array.from({ length: 36_001 }, () => []) }),
      m1Ruleset,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('too many ticks');
  });

  it('rejects a replay with too many inputs on a single tick', () => {
    const burst: SimInput[] = Array.from({ length: 65 }, () => ({ kind: 'noop' }));
    const r = validate(makeReplay({ tickInputs: [burst] }), m1Ruleset);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('too many inputs');
  });

  it('rejects a replay whose total tower commands exceed the budget', () => {
    const build: SimInput[] = [{ kind: 'placeTower', anchor: { col: 1, row: 1 } }];
    const r = validate(
      makeReplay({ tickInputs: Array.from({ length: 1_001 }, () => build) }),
      m1Ruleset,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('too many tower commands');
  });
});

describe('replay validate() — command-union validation (ADR 0006 §4)', () => {
  const withInput = (input: unknown): Replay =>
    makeReplay({ tickInputs: [[input]] as unknown as Replay['tickInputs'] });

  it('rejects a malformed input element without throwing', () => {
    const r = validate(
      makeReplay({ tickInputs: [[null]] as unknown as Replay['tickInputs'] }),
      m1Ruleset,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('malformed');
  });

  it('rejects a non-array tickInputs and a non-array tick', () => {
    expect(
      validate(makeReplay({ tickInputs: 'x' as unknown as Replay['tickInputs'] }), m1Ruleset)
        .reason,
    ).toContain('tickInputs must be an array');
    expect(
      validate(makeReplay({ tickInputs: ['x'] as unknown as Replay['tickInputs'] }), m1Ruleset)
        .reason,
    ).toContain('inputs must be an array');
  });

  it('rejects an unknown command kind', () => {
    expect(validate(withInput({ kind: 'teleportCreep' }), m1Ruleset).reason).toContain(
      'unknown command kind',
    );
  });

  it('rejects a removed spawnCreep command as an unknown command (spawns come from the schedule)', () => {
    const r = validate(withInput({ kind: 'spawnCreep', hp: 10 }), m1Ruleset);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('unknown command kind');
  });

  it('rejects a sellTower whose id is not a safe integer', () => {
    for (const tower of ['x', 1.5, null, NaN]) {
      expect(validate(withInput({ kind: 'sellTower', tower }), m1Ruleset).reason).toContain(
        'sellTower.tower',
      );
    }
  });

  it('rejects a placeTower whose anchor is malformed or out of bounds', () => {
    expect(validate(withInput({ kind: 'placeTower', anchor: null }), m1Ruleset).reason).toContain(
      'placeTower.anchor must be a cell',
    );
    expect(
      validate(withInput({ kind: 'placeTower', anchor: { col: 0.5, row: 1 } }), m1Ruleset).reason,
    ).toContain('placeTower.anchor');
    expect(
      validate(withInput({ kind: 'placeTower', anchor: { col: -1, row: 1 } }), m1Ruleset).reason,
    ).toContain('out of bounds');
  });
});

describe('replay validate() — terminal contract (ADR 0006)', () => {
  it('rejects a command applied past the terminal transition (padding)', () => {
    // The undefended wave leaks out and the match ends (loss) well before tick 800.
    // A build command at tick 800 is padding past termination — rejected.
    const inputs: SimInput[][] = Array.from({ length: 900 }, () => []);
    inputs[0] = [{ kind: 'callWaveEarly' }];
    inputs[800] = [{ kind: 'placeTower', anchor: { col: 1, row: 1 } }];
    const r = validate(makeReplay({ tickInputs: inputs }), m1Ruleset);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('past match termination');
  });

  it('ACCEPTS a benign trailing noop / empty tick past termination (not padding)', () => {
    // A client that keeps logging after the match ends emits harmless noop/empty ticks;
    // the frozen sim ignores them, so a legitimately-resolved replay must still validate.
    const inputs: SimInput[][] = Array.from({ length: 900 }, () => []);
    inputs[0] = [{ kind: 'callWaveEarly' }];
    inputs[800] = [{ kind: 'noop' }];
    const r = validate(makeReplay({ tickInputs: inputs }), m1Ruleset);
    expect(r.ok).toBe(true);
  });

  it('stays total (returns {ok:false}, never throws) on a malformed bundle', () => {
    // An unplayable board (interior, non-border entrance) makes loadBoard throw a
    // GridError inside compileRuleset; validate must surface it as a rejection, not
    // let it escape as an unhandled 500 (Fable P2).
    const badGeometry = JSON.parse(JSON.stringify(m1Ruleset)) as Ruleset;
    (badGeometry.boards[0] as { entrance: { col: number; row: number } }).entrance = {
      col: 5,
      row: 5,
    };
    const r1 = validate(
      {
        seed: 1,
        boardId: M1_BOARD_ID,
        rulesetHash: '0'.repeat(64),
        simVersion: SIM_VERSION,
        tickInputs: [],
      },
      badGeometry,
    );
    expect(r1.ok).toBe(false);
    expect(r1.reason).toContain('invalid ruleset');

    // A float in a sim-affecting field trips canonicalJson inside rulesetDigest.
    const badFloat = JSON.parse(JSON.stringify(m1Ruleset)) as Ruleset;
    (badFloat.creepCatalog[0] as { speedFp: number }).speedFp = 26.5;
    const r2 = validate(
      {
        seed: 1,
        boardId: M1_BOARD_ID,
        rulesetHash: '0'.repeat(64),
        simVersion: SIM_VERSION,
        tickInputs: [],
      },
      badFloat,
    );
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('invalid ruleset');
  });

  it('rejects a ruleset whose baseline run cannot terminate within the tick budget', () => {
    // A very slow creep (speed 1) on a wide board needs far more than the absolute tick
    // ceiling merely to cross — such a ruleset is rejected at COMPILE (Codex P2), so no
    // replay on it can be submitted, rather than compiling into replays that only ever
    // time out. validate() surfaces the compile rejection as a clean {ok:false}.
    const slowBundle: Ruleset = {
      formatVersion: 1,
      rulesetId: 'timeout-probe',
      version: 1,
      creepCatalog: [{ kind: 'normal', hp: 20, speedFp: 1, bounty: 1, domain: 'ground' }],
      towerCatalog: [
        { kind: 'basic', cost: 5, damage: 10, rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
      ],
      balance: {
        startingLives: 10,
        startingBounty: 80,
        refundNum: 3,
        refundDen: 4,
        leakCost: 1,
        countdownTicks: 5,
        waveClearBonus: 0,
        earlyCallBonus: 0,
      },
      scoring: { survivalMul: 25, starThresholds: [1, 6, 9] },
      boards: [
        {
          id: 'wide',
          name: 'Wide',
          widthTiles: 200,
          heightTiles: 3,
          entrance: { col: 0, row: 1 },
          exit: { col: 199, row: 1 },
          waves: [{ index: 0, entries: [{ kind: 'normal', count: 1, spacingTicks: 20 }] }],
        },
      ],
    };
    const replay: Replay = {
      seed: 1,
      boardId: 'wide',
      rulesetHash: currentRulesetHash(slowBundle),
      simVersion: SIM_VERSION,
      tickInputs: [[{ kind: 'callWaveEarly' }]],
    };
    const r = validate(replay, slowBundle);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('invalid ruleset'); // rejected at compile (terminal budget)
    expect(r.reason).toContain('terminal state within the tick budget');
  });
});
