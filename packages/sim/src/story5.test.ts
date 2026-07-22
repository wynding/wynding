// story5.test.ts — Story 5: wave lifecycle, win/loss resolution, the authoritative
// scorer + star grade, freeze-on-terminal, and the content-derived rulesetHash.

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  step,
  hashSimState,
  deriveScore,
  deriveStars,
  compileRuleset,
  rulesetDigest,
  RulesetError,
  type SimInput,
  type CompiledRuleset,
} from './index';
import type { Ruleset } from '@wynding/types';
import { testBundle, testRuleset } from './test-support';

const OPEN = {
  widthTiles: 9,
  heightTiles: 5,
  entrance: { col: 0, row: 2 },
  exit: { col: 8, row: 2 },
} as const;

const callEarly: SimInput[] = [{ kind: 'callWaveEarly' }];
const place = (col: number, row: number): SimInput => ({
  kind: 'placeTower',
  anchor: { col, row },
});

/** Run to a terminal phase (won/lost) or a tick cap; returns the final state. */
function runToEnd(ruleset: CompiledRuleset, first: SimInput[], cap = 2000) {
  let s = createInitialState(1, ruleset);
  for (let t = 0; t < cap && s.phase !== 'won' && s.phase !== 'lost'; t++) {
    s = step(s, ruleset, t === 0 ? first : []);
  }
  return s;
}

describe('wave launch + countdown', () => {
  it('auto-launches exactly on tick === countdownTicks (500, not 499)', () => {
    const ruleset = testRuleset(OPEN, { countdownTicks: 10, waveCount: 1 });
    let s = createInitialState(1, ruleset);
    for (let t = 0; t < 10; t++) s = step(s, ruleset, []);
    // After stepping ticks 0..9, tick is now 10 and still pre-wave (no creep yet).
    expect(s.tick).toBe(10);
    expect(s.phase).toBe('pre-wave');
    expect(s.creeps.id).toHaveLength(0);
    s = step(s, ruleset, []); // the tick where tick === launchAtTick (10)
    expect(s.phase).toBe('active');
    expect(s.creeps.id).toHaveLength(1); // first creep spawned on the launch tick
  });

  it('call-early launches immediately and credits the early-call bonus', () => {
    const ruleset = testRuleset(OPEN, { waveCount: 1, earlyCallBonus: 7, startingBounty: 80 });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly);
    expect(s.phase).toBe('active');
    expect(s.launchTick).toBe(0);
    expect(s.bounty).toBe(87); // 80 + 7 early-call bonus
  });
});

describe('loss resolution', () => {
  it('an undefended board leaks the whole wave → lives 0 → loss, score = kill-bounties only', () => {
    const ruleset = testRuleset(OPEN, { waveCount: 10, waveSpacing: 5, startingLives: 10 });
    const s = runToEnd(ruleset, callEarly);
    expect(s.phase).toBe('lost');
    expect(s.lives).toBeLessThanOrEqual(0);
    expect(s.cumulativeKillBounty).toBe(0);
    expect(deriveScore(s, ruleset)).toBe(0); // no kills, lives ≤ 0
    expect(deriveStars(s, ruleset)).toBe(0); // a loss earns no star
  });
});

describe('win resolution', () => {
  it('a tower on the lane kills the wave → win with lives intact, score + stars from state', () => {
    // 1-hit creeps + a tower straddling the lane: every creep dies before the exit.
    const ruleset = testRuleset(OPEN, { creepHp: 10, waveCount: 3, waveSpacing: 20 });
    const s = runToEnd(ruleset, [{ kind: 'callWaveEarly' }, place(3, 1)]);
    expect(s.phase).toBe('won');
    expect(s.leakedCount).toBe(0);
    expect(s.lives).toBe(10);
    expect(s.cumulativeKillBounty).toBe(3); // three kills × bounty 1
    expect(deriveScore(s, ruleset)).toBe(3 + 10 * 25); // Σ kill-bounties + lives × survivalMul
    expect(deriveStars(s, ruleset)).toBe(3); // lives 10 ≥ 9
  });
});

describe('freeze on terminal', () => {
  it('trailing ticks after resolution do not change the final hash or score', () => {
    const ruleset = testRuleset(OPEN, { waveCount: 4, waveSpacing: 5, startingLives: 2 });
    const s = runToEnd(ruleset, callEarly);
    expect(s.phase).toBe('lost');
    const frozenHash = hashSimState(s);
    const frozenTick = s.tick;
    const frozenScore = deriveScore(s, ruleset);
    for (let i = 0; i < 50; i++) step(s, ruleset, [place(2, 1), { kind: 'callWaveEarly' }]);
    expect(s.tick).toBe(frozenTick); // no tick advance
    expect(hashSimState(s)).toBe(frozenHash); // no state change
    expect(deriveScore(s, ruleset)).toBe(frozenScore);
  });
});

describe('rulesetHash — content-derived SHA-256 (ADR 0007 §3)', () => {
  it('is a 64-char hex digest, stable for identical content', () => {
    const a = rulesetDigest(testBundle(OPEN));
    const b = rulesetDigest(testBundle(OPEN));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('changes when sim-affecting tuning changes', () => {
    const base = rulesetDigest(testBundle(OPEN));
    expect(rulesetDigest(testBundle(OPEN, { creepHp: 21 }))).not.toBe(base);
    expect(rulesetDigest(testBundle(OPEN, { startingBounty: 81 }))).not.toBe(base);
  });

  it('does NOT change when a presentation-only field (board name) changes', () => {
    const base = testBundle(OPEN);
    const renamed = {
      ...base,
      boards: base.boards.map((b) => ({ ...b, name: 'A Totally Different Display Name' })),
    };
    expect(rulesetDigest(renamed)).toBe(rulesetDigest(base));
  });

  it('is compiled onto the CompiledRuleset and matches the raw-bundle digest', () => {
    const bundle = testBundle(OPEN);
    const compiled = compileRuleset(bundle, 'test');
    expect(compiled.digest).toBe(rulesetDigest(bundle));
  });

  it('ignores schema-unknown properties (only known fields enter the digest)', () => {
    const base = rulesetDigest(testBundle(OPEN));
    const withJunk = { ...testBundle(OPEN), someMetadata: 'irrelevant', extra: 42 } as Ruleset;
    expect(rulesetDigest(withJunk)).toBe(base); // unknown fields don't change identity
  });
});

describe('compiled ruleset snapshots its tuning (Codex P1)', () => {
  it('a match uses the compiled snapshot, not the raw bundle mutated after compile', () => {
    const bundle = testBundle(OPEN, { startingLives: 10 });
    const ruleset = compileRuleset(bundle, 'test');
    // Mutate the RAW bundle after compiling — a running match must be unaffected.
    (bundle.balance as { startingLives: number }).startingLives = 999;
    (bundle.creepCatalog[0] as { hp: number }).hp = 999;
    const s = createInitialState(1, ruleset);
    expect(s.lives).toBe(10); // the compiled snapshot, not the post-compile mutation
  });

  it('freezes the compiled tuning so a retained ruleset cannot be mutated', () => {
    const ruleset = compileRuleset(testBundle(OPEN), 'test');
    expect(Object.isFrozen(ruleset)).toBe(true); // the wrapper (can't replace a field)
    expect(Object.isFrozen(ruleset.balance)).toBe(true);
    expect(Object.isFrozen(ruleset.scoring)).toBe(true);
    expect(Object.isFrozen(ruleset.tower)).toBe(true);
    expect(Object.isFrozen(ruleset.schedule)).toBe(true);
    expect(Object.isFrozen(ruleset.creepByKind)).toBe(true); // a frozen record, not a Map
    expect(() => {
      (ruleset.balance as { startingLives: number }).startingLives = 999;
    }).toThrow(); // strict-mode write to a frozen object
    expect(() => {
      (ruleset as { tower: unknown }).tower = {}; // can't replace a field on the frozen wrapper
    }).toThrow();
    expect(() => {
      (ruleset.creepByKind as Record<string, unknown>).normal = {}; // frozen record
    }).toThrow();
  });
});

describe('ruleset boundary guard (totality)', () => {
  it('rejects a forged / uncompiled ruleset at the sim boundary', () => {
    const forged = { ...testRuleset(OPEN) }; // a shallow copy loses the brand membership
    expect(() => createInitialState(1, forged as CompiledRuleset)).toThrow(RulesetError);
    const s = createInitialState(1, testRuleset(OPEN));
    expect(() => step(s, {} as unknown as CompiledRuleset, [])).toThrow(RulesetError);
  });

  it('rejects malformed content at compile time (RulesetError, before any match)', () => {
    expect(() => compileRuleset(testBundle(OPEN, { creepHp: 0 }), 'test')).toThrow(RulesetError);
    expect(() => compileRuleset(testBundle(OPEN), 'no-such-board')).toThrow(RulesetError);
  });
});
