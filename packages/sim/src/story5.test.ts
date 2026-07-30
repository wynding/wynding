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
  previewInputs,
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
const place = (col: number, row: number, towerId = 'basic'): SimInput => ({
  kind: 'placeTower',
  anchor: { col, row },
  towerId,
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
    // After stepping ticks 0..9, tick is now 10 and no wave has launched yet.
    expect(s.tick).toBe(10);
    expect(s.waveLaunchTick[0]).toBeNull();
    expect(s.creeps.id).toHaveLength(0);
    s = step(s, ruleset, []); // the tick where tick === countdownTicks (10)
    expect(s.waveLaunchTick[0]).toBe(10);
    expect(s.creeps.id).toHaveLength(1); // first creep spawned on the launch tick
  });

  it('call-early launches immediately, paying the early-call bounty/credit from the undecremented countdown', () => {
    const ruleset = testRuleset(OPEN, {
      waveCount: 1,
      startingBounty: 80,
      countdownTicks: 100,
      earlyCallBountyDivisor: 50,
      earlyCallScoreDivisor: 25,
    });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly);
    expect(s.waveLaunchTick[0]).toBe(0);
    expect(s.bounty).toBe(80 + Math.floor(100 / 50)); // 80 + 2
    expect(s.cumulativeEarlyCallCredit).toBe(Math.floor(100 / 25)); // 4
  });

  it('an early call with both divisors off (M1 default) pays/credits nothing', () => {
    const ruleset = testRuleset(OPEN, { waveCount: 1, startingBounty: 80 });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly);
    expect(s.waveLaunchTick[0]).toBe(0);
    expect(s.bounty).toBe(80);
    expect(s.cumulativeEarlyCallCredit).toBe(0);
  });

  it('an auto-launch (no early call) pays/credits 0 with no special case', () => {
    const ruleset = testRuleset(OPEN, {
      waveCount: 1,
      countdownTicks: 5,
      earlyCallBountyDivisor: 2,
      earlyCallScoreDivisor: 2,
      startingBounty: 80,
    });
    let s = createInitialState(1, ruleset);
    for (let t = 0; t < 6; t++) s = step(s, ruleset, []); // tick === countdownTicks (5) launches
    expect(s.waveLaunchTick[0]).toBe(5);
    expect(s.bounty).toBe(80); // countdownRemaining is 0 at auto-launch — floor(0/2) = 0
    expect(s.cumulativeEarlyCallCredit).toBe(0);
  });

  it('a same-tick double call is idempotent — only the first pays, both accepted/rejected correctly', () => {
    const ruleset = testRuleset(OPEN, {
      waveCount: 1,
      countdownTicks: 100,
      earlyCallBountyDivisor: 10,
    });
    const { accepted, preview } = previewInputs(createInitialState(1, ruleset), ruleset, [
      { kind: 'callWaveEarly' },
      { kind: 'callWaveEarly' },
    ]);
    expect(accepted).toEqual([true, false]); // idempotent: second same-tick call no-ops
    expect(preview.launchPending).toBe(true); // buffered — pays at the real launch, not here
  });

  it('a call after the final wave has launched is a no-op (nothing callable)', () => {
    // (Renamed per CodeRabbit PR #68: `launchPending` never survives its own tick,
    // so "pending across ticks" is not a state this — or any — test can witness;
    // the same-tick double-call no-op is pinned 17 lines up in THIS file — the
    // `accepted [true, false]` idempotence test. Local QC round 3 caught this
    // comment previously pointing at wave-multi.test.ts, which has no such test.)
    const ruleset = testRuleset(OPEN, { waveCount: 1, countdownTicks: 50 });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly); // consumed + launched within this same tick
    // The wave already launched, so a further call this run is a no-op (no second
    // wave to call in a single-wave bundle) — waveLaunchTick stays pinned at 0.
    s = step(s, ruleset, callEarly);
    expect(s.waveLaunchTick[0]).toBe(0);
    expect(s.launchPending).toBe(false);
  });

  it('a final-wave early call zeroes the countdown (boundary invariant)', () => {
    const ruleset = testRuleset(OPEN, {
      waves: [
        { waveCount: 1, waveSpacing: 5, countdownTicks: 200 },
        { waveCount: 1, waveSpacing: 5, countdownTicks: 300 },
      ],
    });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly); // launches wave 0
    expect(s.waveCursor).toBe(1);
    s = step(s, ruleset, callEarly); // launches the FINAL wave early
    expect(s.waveCursor).toBe(2);
    expect(s.countdownRemaining).toBe(0); // never a stale positive countdown
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

  // DEVIATION (M2-S1 decision 5): v1's board `name` was presentation-only and
  // excluded from the hash so a rename never invalidated a replay. v2 carries ZERO
  // presentation fields — `name` is deleted from the schema entirely, not merely
  // stripped from the digest — so there is no longer a presentation-only field to
  // test the exclusion of. This case is retired, not replaced.

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

  it('ignores unknown properties nested inside an effect (allowlist, not spread)', () => {
    // A hand-built bundle can reach rulesetDigest without parseRulesetJson's strict
    // rejection; the per-kind effect projection must still keep an unknown effect
    // property out of the digest ("equal in every supported field ⇒ equal digest").
    const base = rulesetDigest(testBundle(OPEN));
    const bundle = structuredClone(testBundle(OPEN)) as unknown as {
      towerCatalog: { effects: Record<string, unknown>[] }[];
    };
    bundle.towerCatalog[0]!.effects[0]!.someJunk = 999;
    expect(rulesetDigest(bundle as unknown as Ruleset)).toBe(base);
  });
});

/**
 * Generic mutation-walk machinery (M2-S1 P3 step 8): recursively visit every
 * primitive leaf of a bundle, mutate it in isolation on a deep clone, and assert
 * the digest changes — proving every field the schema carries actually enters
 * `rulesetHash`, including the parity-invisible zero-valued fields (`clearBonus`,
 * the two early-call divisors) that no M1 scenario's world-hash would ever
 * distinguish. Generic over the tree shape rather than hand-enumerating fields, so
 * it stays correct as the schema grows.
 */
type PathSegment = string | number;

function walkLeaves(
  node: unknown,
  path: readonly PathSegment[],
  visit: (path: readonly PathSegment[], leaf: string | number | boolean) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkLeaves(item, [...path, i], visit));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      walkLeaves((node as Record<string, unknown>)[key], [...path, key], visit);
    }
    return;
  }
  if (typeof node === 'number' || typeof node === 'string' || typeof node === 'boolean') {
    visit(path, node);
  }
}

function setAtPath(root: unknown, path: readonly PathSegment[], value: unknown): void {
  let cur = root as Record<PathSegment, unknown>;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]!] as Record<PathSegment, unknown>;
  cur[path[path.length - 1]!] = value;
}

/** Asserts every projected leaf of `bundle` changes `rulesetDigest` when mutated in
 *  isolation. Skips nothing — a schema field this test doesn't reach is a field the
 *  digest doesn't yet cover. */
function assertEveryLeafHashes(bundle: Ruleset): void {
  const baseDigest = rulesetDigest(bundle);
  let leafCount = 0;
  walkLeaves(bundle, [], (path, leaf) => {
    leafCount++;
    const mutated =
      typeof leaf === 'number' ? leaf + 1 : typeof leaf === 'string' ? `${leaf}x` : !leaf;
    const clone = structuredClone(bundle);
    setAtPath(clone, path, mutated);
    let mutatedDigest: string;
    try {
      mutatedDigest = rulesetDigest(clone);
    } catch (err) {
      // A mutation that makes the bundle loudly UNHASHABLE (a mutated effect-kind
      // discriminator matches no projection branch — a TypeError, same family as
      // canonicalJson's malformed-field guards) proves the field is load-bearing
      // exactly as strongly as a changed digest. Anything else escaping here would
      // be a bug in this walk itself, so only that family is absorbed.
      if (!(err instanceof TypeError)) throw err;
      return;
    }
    expect(mutatedDigest, `mutating .${path.join('.')} should change rulesetDigest`).not.toBe(
      baseDigest,
    );
  });
  expect(leafCount).toBeGreaterThan(0); // the walk actually visited something
}

describe('rulesetHash — every schema field enters the digest (P3 step 8 mutation walk)', () => {
  it('walks the shipped-artifact-shaped fixture (test-support values mirror wynding-core-m1)', () => {
    assertEveryLeafHashes(testBundle(OPEN));
  });

  it('walks a full-schema fixture exercising every union member and optional field', () => {
    // All eight EffectDef variants (six kinds; direct/burst each single+aoe), spread
    // across three towers because `support` must be a bundle's sole effect with no
    // `attack`, and at most one `burst` may appear per bundle:
    //   • 'multi' — non-support, attacking, WITH a burst → cadenceTicks omitted
    //     (cross-field rule) — carries direct/single, direct/aoe, slow, stun, dot,
    //     and burst/single (6 of the 8 variants).
    //   • 'supporter' — the exclusive support-only bundle (no attack).
    //   • 'burst-aoe' — an attack-with-burst bundle carrying burst/aoe (the 8th
    //     variant), also covering a second cadenceTicks-omitted attack shape.
    const fullSchema: Ruleset = {
      formatVersion: 2,
      rulesetId: 'full-schema-fixture',
      version: 3,
      creepCatalog: [
        {
          id: 'normal',
          hp: 20,
          speedFp: 26,
          armor: 2, // nonzero armor — capability-gated in compileRuleset, not here
          domain: 'ground',
          immunities: [],
          leakCost: 1,
          bounty: 1,
        },
        {
          id: 'brute',
          hp: 200,
          speedFp: 10,
          armor: 5,
          domain: 'air',
          // Authored out of canonical order — rulesetDigest re-canonicalizes
          // defensively for a hand-built bundle bypassing parseRulesetJson.
          immunities: ['stun', 'slow'],
          role: 'boss',
          leakCost: 1,
          bounty: 50,
        },
      ],
      towerCatalog: [
        {
          id: 'multi',
          cost: 12,
          attack: { domain: 'both', rangeFp: 2048, travelTicks: 4 }, // no cadenceTicks (has burst)
          effects: [
            { kind: 'direct', form: 'single', damage: 10 },
            { kind: 'direct', form: 'aoe', damage: 15, radiusFp: 300 },
            { kind: 'slow', mulFp: 64, durationTicks: 40 },
            { kind: 'stun', chanceNum: 32, durationTicks: 20 },
            { kind: 'dot', damagePerTick: 3, cadenceTicks: 10, durationTicks: 30 },
            { kind: 'burst', form: 'single', damage: 500 },
          ],
        },
        {
          id: 'supporter',
          cost: 8,
          effects: [{ kind: 'support', damageMulFp: 300 }],
        },
        {
          id: 'burst-aoe',
          cost: 20,
          attack: { domain: 'air', rangeFp: 4096, travelTicks: 2 }, // no cadenceTicks (has burst)
          effects: [{ kind: 'burst', form: 'aoe', damage: 800, radiusFp: 512 }],
        },
      ],
      balance: {
        startingLives: 10,
        startingBounty: 80,
        refundNum: 3,
        refundDen: 4,
        slowFloorNum: 1,
        slowFloorDen: 4,
        earlyCallBountyDivisor: 7, // nonzero — capability-gated in compileRuleset, not here
      },
      scoring: {
        survivalMul: 25,
        starThresholds: [1, 6, 9],
        earlyCallScoreDivisor: 11, // nonzero — capability-gated in compileRuleset, not here
      },
      boards: [
        {
          id: 'full-board',
          widthTiles: 20,
          heightTiles: 20,
          entrance: { col: 0, row: 10 },
          exit: { col: 19, row: 10 },
          waves: [
            {
              index: 0,
              countdownTicks: 100,
              clearBonus: 5, // nonzero — a parity-invisible field at M1
              entries: [
                { creepId: 'normal', count: 10, spacingTicks: 20 },
                { creepId: 'brute', count: 2, spacingTicks: 50, offsetTicks: 15 },
              ],
            },
            {
              index: 1,
              countdownTicks: 200,
              clearBonus: 0,
              entries: [{ creepId: 'normal', count: 5, spacingTicks: 10, offsetTicks: 3 }],
            },
          ],
        },
      ],
    };
    assertEveryLeafHashes(fullSchema);
  });
});

describe('compiled ruleset snapshots its tuning', () => {
  it('a match uses the compiled snapshot, not the raw bundle mutated after compile', () => {
    const bundle = testBundle(OPEN, { startingLives: 10, creepHp: 17 });
    const ruleset = compileRuleset(bundle, 'test');
    // Mutate the RAW bundle after compiling — a running match must be unaffected.
    (bundle.balance as { startingLives: number }).startingLives = 999;
    (bundle.creepCatalog[0] as { hp: number }).hp = 999;
    const s = createInitialState(1, ruleset);
    expect(s.lives).toBe(10); // the compiled snapshot, not the post-compile mutation
    // The creep catalog is snapshotted too: the compiled def keeps its authored HP (17)
    // even though the raw bundle's creep was mutated to 999 after compile.
    expect(ruleset.creepById.normal?.hp).toBe(17);
  });

  it('freezes the compiled tuning so a retained ruleset cannot be mutated', () => {
    const ruleset = compileRuleset(testBundle(OPEN), 'test');
    expect(Object.isFrozen(ruleset)).toBe(true); // the wrapper (can't replace a field)
    expect(Object.isFrozen(ruleset.balance)).toBe(true);
    expect(Object.isFrozen(ruleset.scoring)).toBe(true);
    expect(Object.isFrozen(ruleset.towers)).toBe(true);
    expect(Object.isFrozen(ruleset.towerById)).toBe(true);
    expect(Object.isFrozen(ruleset.waves)).toBe(true);
    expect(Object.isFrozen(ruleset.waves[0]!.spawns)).toBe(true);
    expect(Object.isFrozen(ruleset.creepById)).toBe(true); // a frozen record, not a Map
    expect(() => {
      (ruleset.balance as { startingLives: number }).startingLives = 999;
    }).toThrow(); // strict-mode write to a frozen object
    expect(() => {
      (ruleset as { towers: unknown }).towers = []; // can't replace a field on the frozen wrapper
    }).toThrow();
    expect(() => {
      (ruleset.creepById as Record<string, unknown>).normal = {}; // frozen record
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
