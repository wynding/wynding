// replay.test.ts — the validator re-simulates to a deterministic TERMINAL state and
// derives a trusted score, binding the replay to a content-derived ruleset digest
// (ADR 0006 anti-cheat spine).

import { describe, it, expect } from 'vitest';
import { SIM_VERSION, type SimInput } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from '@wynding/content';
import type { Ruleset, RulesetBoard } from '@wynding/types';
import {
  validate,
  currentRulesetHash,
  CompileCache,
  COMPILE_CACHE_MAX,
  type Replay,
} from './index';

const m1Ruleset = getBundledRuleset();
const M1_BOARD_ID = defaultBoardId(m1Ruleset);
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
    const build: SimInput[] = [
      { kind: 'placeTower', anchor: { col: 1, row: 1 }, towerId: 'basic' },
    ];
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

  it('rejects a placeTower whose towerId does not name a catalog tower', () => {
    for (const towerId of ['no-such-tower', 1, null, undefined]) {
      expect(
        validate(withInput({ kind: 'placeTower', anchor: { col: 1, row: 1 }, towerId }), m1Ruleset)
          .reason,
      ).toContain('placeTower.towerId must name a catalog tower');
    }
  });

  it('validates a known-id placeTower whose placement is illegal as a no-op replay (structurally well-formed)', () => {
    // The entrance cell is not buildable — the sim's canPlaceTower rejects it as a
    // no-op, but the command is structurally well-formed (a known towerId), so the
    // replay validates rather than being rejected at the domain-validation stage.
    const r = validate(
      makeReplay({
        tickInputs: [
          [
            { kind: 'placeTower', anchor: { col: 0, row: 11 }, towerId: 'basic' },
            { kind: 'callWaveEarly' },
          ],
        ],
      }),
      m1Ruleset,
    );
    expect(r.ok).toBe(true);
  });
});

describe('replay validate() — terminal contract (ADR 0006)', () => {
  it('rejects a canonical replay that logs ANY tick past the terminal transition', () => {
    // The undefended wave leaks out and the match ends (loss) well before tick 800. A
    // canonical replay must END at the terminal tick — ANY logged tick after it (even an
    // empty or noop-only one) is padding and rejected (strict PLAN/ADR 0006 contract).
    for (const trailing of [
      [{ kind: 'placeTower', anchor: { col: 1, row: 1 }, towerId: 'basic' }] as SimInput[],
      [{ kind: 'noop' }] as SimInput[],
      [] as SimInput[],
    ]) {
      const inputs: SimInput[][] = Array.from({ length: 900 }, () => []);
      inputs[0] = [{ kind: 'callWaveEarly' }];
      inputs[800] = trailing;
      const r = validate(makeReplay({ tickInputs: inputs }), m1Ruleset);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('past match termination');
    }
  });

  it('stays total (returns {ok:false}, never throws) on a malformed bundle', () => {
    // An unplayable board (interior, non-border entrance) makes loadBoard throw a
    // GridError inside compileRuleset; validate must surface it as a rejection, not
    // let it escape as an unhandled 500.
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

    // A float in a per-creep v2 field (`leakCost` must be a safe integer 1..1000) trips
    // `validateRulesetShape` — the NEW validate-first stage (Codex R2-1) — before the
    // digest is even taken, re-targeting the v1-era "a float trips canonicalJson" case
    // to the v2 field that now carries per-creep tuning (decision 6).
    const badFloat = JSON.parse(JSON.stringify(m1Ruleset)) as Ruleset;
    (badFloat.creepCatalog[0] as { leakCost: number }).leakCost = 1.5;
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
    // ceiling merely to cross — such a ruleset is rejected at COMPILE, so no
    // replay on it can be submitted, rather than compiling into replays that only ever
    // time out. validate() surfaces the compile rejection as a clean {ok:false}.
    const slowBundle: Ruleset = makeRuleset(
      [
        makeBoard('wide', {
          widthTiles: 200,
          heightTiles: 3,
          entrance: { col: 0, row: 1 },
          exit: { col: 199, row: 1 },
          countdownTicks: 5,
        }),
      ],
      { speedFp: 1, rulesetId: 'timeout-probe' },
    );
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

/** A minimal v2 board — one wave, one entry, capability-profile-legal at SIM_VERSION 5. */
function makeBoard(
  id: string,
  opts: {
    readonly widthTiles?: number;
    readonly heightTiles?: number;
    readonly entrance?: { readonly col: number; readonly row: number };
    readonly exit?: { readonly col: number; readonly row: number };
    readonly countdownTicks?: number;
  } = {},
): RulesetBoard {
  return {
    id,
    widthTiles: opts.widthTiles ?? 9,
    heightTiles: opts.heightTiles ?? 3,
    entrance: opts.entrance ?? { col: 0, row: 1 },
    exit: opts.exit ?? { col: 8, row: 1 },
    waves: [
      {
        index: 0,
        countdownTicks: opts.countdownTicks ?? 5,
        clearBonus: 0,
        entries: [{ creepId: 'normal', count: 1, spacingTicks: 20 }],
      },
    ],
  };
}

/** A minimal v2 bundle over the given boards, capability-profile-legal at SIM_VERSION 5. */
function makeRuleset(
  boards: RulesetBoard[],
  opts: {
    readonly speedFp?: number;
    readonly cost?: number;
    readonly damage?: number;
    readonly rulesetId?: string;
  } = {},
): Ruleset {
  return {
    formatVersion: 2,
    rulesetId: opts.rulesetId ?? 'compile-cache-probe',
    version: 1,
    creepCatalog: [
      {
        id: 'normal',
        hp: 20,
        speedFp: opts.speedFp ?? 256,
        armor: 0,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: 1,
      },
    ],
    towerCatalog: [
      {
        id: 'basic',
        cost: opts.cost ?? 5,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
        effects: [{ kind: 'direct', form: 'single', damage: opts.damage ?? 10 }],
      },
    ],
    balance: {
      startingLives: 10,
      startingBounty: 80,
      refundNum: 3,
      refundDen: 4,
      slowFloorNum: 1,
      slowFloorDen: 4,
      earlyCallBountyDivisor: 0,
    },
    scoring: { survivalMul: 25, starThresholds: [1, 6, 9], earlyCallScoreDivisor: 0 },
    boards,
  };
}

describe('CompileCache — LRU compile memo keyed by content digest (#26)', () => {
  function twoBoardBundle(): Ruleset {
    return makeRuleset([makeBoard('board-a'), makeBoard('board-b')]);
  }

  function replayFor(bundle: Ruleset, boardId: string): Replay {
    return {
      seed: 1,
      boardId,
      rulesetHash: currentRulesetHash(bundle),
      simVersion: SIM_VERSION,
      tickInputs: [[{ kind: 'callWaveEarly' }]],
    };
  }

  it('defaults its LRU cap to COMPILE_CACHE_MAX', () => {
    const cache = new CompileCache();
    const bundles = Array.from({ length: COMPILE_CACHE_MAX + 1 }, (_, i) => {
      const b = twoBoardBundle();
      (b.towerCatalog[0] as { cost: number }).cost = 5 + i;
      return b;
    });
    for (const b of bundles) validate(replayFor(b, 'board-a'), b, cache);
    expect(cache.size).toBe(COMPILE_CACHE_MAX); // capped, not COMPILE_CACHE_MAX + 1
  });

  it('a second validate() call with the same bundle is a compile-cache HIT with identical results', () => {
    const cache = new CompileCache();
    const bundle = twoBoardBundle();
    const first = validate(replayFor(bundle, 'board-a'), bundle, cache);
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(0);
    const second = validate(replayFor(bundle, 'board-a'), bundle, cache);
    expect(cache.misses).toBe(1); // still one compile — the second call hit
    expect(cache.hits).toBe(1);
    expect(second.ok).toBe(true);
    expect(second.finalHash).toBe(first.finalHash);
    expect(second.score).toBe(first.score);
    expect(second.stars).toBe(first.stars);
  });

  it('a different boardId on the same bundle is a separate cache entry', () => {
    const cache = new CompileCache();
    const bundle = twoBoardBundle();
    validate(replayFor(bundle, 'board-a'), bundle, cache);
    expect(cache.misses).toBe(1);
    validate(replayFor(bundle, 'board-b'), bundle, cache);
    expect(cache.misses).toBe(2); // different boardId → distinct key → a second miss
    expect(cache.hits).toBe(0);
    expect(cache.size).toBe(2);
  });

  it('mutating the bundle between validations changes the digest → cache miss → fresh, correct compile', () => {
    const cache = new CompileCache();
    const bundle = twoBoardBundle();
    validate(replayFor(bundle, 'board-a'), bundle, cache);
    expect(cache.misses).toBe(1);

    // Mutate a sim-affecting field on the SAME bundle object (identity unchanged) — the
    // v2 `damage` value lives on the tower's single direct/single effect bundle.
    (bundle.towerCatalog[0]!.effects[0] as { damage: number }).damage = 999;
    const mutatedReplay = replayFor(bundle, 'board-a'); // rulesetHash recomputed post-mutation
    const after = validate(mutatedReplay, bundle, cache);

    expect(cache.misses).toBe(2); // digest changed → miss, not a stale identity-keyed hit
    expect(cache.size).toBe(2); // both the pre- and post-mutation digest are now cached
    expect(after.ok).toBe(true);

    // Submitting the STALE (pre-mutation) hash against the now-mutated bundle is still
    // correctly rejected — proving the digest check itself (never memoized) stays live.
    const staleHash = currentRulesetHash(twoBoardBundle());
    const staleAttempt = validate({ ...mutatedReplay, rulesetHash: staleHash }, bundle, cache);
    expect(staleAttempt.ok).toBe(false);
    expect(staleAttempt.reason).toContain('ruleset hash mismatch');
  });

  it('evicts the oldest-untouched entry at exactly COMPILE_CACHE_MAX, with hits refreshing recency', () => {
    const cache = new CompileCache(3);
    // Fill the cache with 3 distinct entries via 3 single-field mutations of the same
    // base bundle (each mutation changes the digest, giving distinct cache keys).
    const bundle0 = twoBoardBundle();
    (bundle0.towerCatalog[0] as { cost: number }).cost = 5;
    const bundle1 = twoBoardBundle();
    (bundle1.towerCatalog[0] as { cost: number }).cost = 6;
    const bundle2 = twoBoardBundle();
    (bundle2.towerCatalog[0] as { cost: number }).cost = 7;
    for (const b of [bundle0, bundle1, bundle2]) validate(replayFor(b, 'board-a'), b, cache);
    expect(cache.size).toBe(3);
    expect(cache.misses).toBe(3);

    // Touch entry 0 (bundle0) so it becomes most-recently-used, not oldest.
    validate(replayFor(bundle0, 'board-a'), bundle0, cache);
    expect(cache.hits).toBe(1);
    expect(cache.size).toBe(3);

    // A 4th distinct entry pushes size over the cap — the oldest UNTOUCHED entry
    // (bundle1, never re-hit) is evicted, not bundle0 (recency-refreshed).
    const bundle3 = twoBoardBundle();
    (bundle3.towerCatalog[0] as { cost: number }).cost = 999;
    validate(replayFor(bundle3, 'board-a'), bundle3, cache);
    expect(cache.size).toBe(3);
    expect(cache.misses).toBe(4);

    // bundle0 survives (recently touched) → still a hit.
    const missesBefore = cache.misses;
    validate(replayFor(bundle0, 'board-a'), bundle0, cache);
    expect(cache.misses).toBe(missesBefore); // hit, no new compile
    expect(cache.hits).toBe(2);

    // bundle1 was evicted → recompiling it is a fresh miss.
    const missesBefore2 = cache.misses;
    validate(replayFor(bundle1, 'board-a'), bundle1, cache);
    expect(cache.misses).toBe(missesBefore2 + 1);
  });
});
