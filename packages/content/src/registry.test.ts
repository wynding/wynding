// registry.test.ts — the bundled ruleset registry. Pins every authored
// value (carrying forward the intent of the deleted `boards.test.ts`, now over the
// registry-loaded artifact) and proves the registry's own contract: happy path,
// caching, unknown-id rejection, deep-frozen results, and — the two-loaders
// invariant (ADR 0007 §2 / PLAN M2-S1 Validation architecture) — artifact fidelity
// between the bundled `?raw` text and the on-disk JSON file.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  parseRulesetJson,
  compileRuleset,
  MAX_RULESET_TEXT_UNITS,
  MAX_MATCH_TICKS,
  rulesetDigest,
  RulesetError,
  DIAG_LEN,
} from '@wynding/sim';
import {
  DEFAULT_RULESET_ID,
  getBundledRuleset,
  bundledRulesetIds,
  defaultBoardId,
} from './registry';
import { BUNDLED_ARTIFACT_URL } from './artifact';
// The registry module holds its bundled `?raw` text in a private map; import the
// same specifier here so the fidelity test below compares the literal string the
// registry embeds (not just its parsed/validated shape) to the on-disk bytes.
import rawWyndingCore from './rulesets/wynding-core.json?raw';

describe('getBundledRuleset (happy path + authored values)', () => {
  const ruleset = getBundledRuleset();
  const board = ruleset.boards[0]!;

  it('defaults to DEFAULT_RULESET_ID = wynding-core, version 1', () => {
    expect(DEFAULT_RULESET_ID).toBe('wynding-core');
    expect(ruleset.formatVersion).toBe(2);
    expect(ruleset.rulesetId).toBe('wynding-core');
    expect(ruleset.version).toBe(1);
  });

  it('is also reachable by explicit id', () => {
    expect(getBundledRuleset('wynding-core')).toBe(ruleset);
  });

  it('carries the creep catalog: `normal`, the S3 `fast` creep, the S4a `swarm` creep, the S5a `armored` creep, the S6 `resolute` creep, and the S7 `flying` creep', () => {
    expect(ruleset.creepCatalog).toEqual([
      {
        id: 'normal',
        hp: 20,
        speedFp: 26,
        armor: 0,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: 1,
      },
      {
        id: 'fast',
        hp: 16,
        speedFp: 44,
        armor: 0,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: 2,
      },
      {
        id: 'swarm',
        hp: 7,
        speedFp: 30,
        armor: 0,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: 1,
      },
      {
        id: 'armored',
        hp: 36,
        speedFp: 22,
        armor: 6,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: 3,
      },
      {
        id: 'resolute',
        hp: 20,
        speedFp: 44,
        armor: 0,
        domain: 'ground',
        immunities: ['slow'],
        leakCost: 1,
        bounty: 2,
      },
      {
        id: 'flying',
        hp: 18,
        speedFp: 30,
        armor: 0,
        domain: 'air',
        immunities: [],
        leakCost: 1,
        bounty: 2,
      },
    ]);
  });

  it('carries the tower catalog: `basic`, the S3 `slow` tower (S7: attack domain widens ground → both), the S4a `splash` tower, the S5a `venom` tower, the S6 `stun` tower, and the S7 `antiair` tower', () => {
    expect(ruleset.towerCatalog).toEqual([
      {
        id: 'basic',
        cost: 5,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
        effects: [{ kind: 'direct', form: 'single', damage: 10 }],
      },
      {
        id: 'slow',
        cost: 8,
        attack: { domain: 'both', rangeFp: 1024, cadenceTicks: 30, travelTicks: 2 },
        effects: [
          { kind: 'direct', form: 'single', damage: 2 },
          { kind: 'slow', mulFp: 128, durationTicks: 40 },
        ],
      },
      {
        id: 'splash',
        cost: 12,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 60, travelTicks: 8 },
        effects: [{ kind: 'direct', form: 'aoe', damage: 8, radiusFp: 384 }],
      },
      {
        id: 'venom',
        cost: 9,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 2 },
        effects: [
          { kind: 'direct', form: 'single', damage: 2 },
          { kind: 'dot', damagePerTick: 4, cadenceTicks: 10, durationTicks: 60 },
        ],
      },
      {
        id: 'stun',
        cost: 10,
        attack: { domain: 'ground', rangeFp: 768, cadenceTicks: 40, travelTicks: 2 },
        effects: [
          { kind: 'direct', form: 'single', damage: 4 },
          { kind: 'stun', chanceNum: 64, durationTicks: 20 },
        ],
      },
      {
        id: 'antiair',
        cost: 7,
        attack: { domain: 'air', rangeFp: 1280, cadenceTicks: 20, travelTicks: 2 },
        effects: [{ kind: 'direct', form: 'single', damage: 8 }],
      },
    ]);
  });

  it('carries the starting economy, refund/slow-floor fractions and early-call bounty divisor', () => {
    expect(ruleset.balance).toEqual({
      startingLives: 10,
      startingBounty: 80,
      refundNum: 3,
      refundDen: 4,
      slowFloorNum: 1,
      slowFloorDen: 4,
      earlyCallBountyDivisor: 50,
    });
  });

  it('carries the scoring weights and early-call score divisor', () => {
    expect(ruleset.scoring).toEqual({
      survivalMul: 35,
      starThresholds: [1, 6, 9],
      earlyCallScoreDivisor: 50,
    });
  });

  it('carries the board geometry: field-01, a 28×24 grid', () => {
    expect(board.id).toBe('field-01');
    expect(defaultBoardId(ruleset)).toBe('field-01');
    expect(board.widthTiles).toBe(28);
    expect(board.heightTiles).toBe(24);
    expect(board.entrance).toEqual({ col: 0, row: 11 });
    expect(board.exit).toEqual({ col: 27, row: 11 });
  });

  it("carries the six waves: 10 × normal @ spacing 20, then 16 × swarm @ spacing 5 (the S4a AoE showcase), then 8 × fast @ spacing 15 (the S3 slow-showcase), then 6 × armored @ spacing 25 (the S5a armor showcase), then wave index 4's 6 × resolute + 6 × fast @ spacing 15/15 (the S6 immunity showcase), then wave index 5's 8 × flying @ spacing 15 (the S7 air showcase)", () => {
    const normalEntries = [{ creepId: 'normal', count: 10, spacingTicks: 20, offsetTicks: 0 }];
    const swarmEntries = [{ creepId: 'swarm', count: 16, spacingTicks: 5, offsetTicks: 0 }];
    const fastEntries = [{ creepId: 'fast', count: 8, spacingTicks: 15, offsetTicks: 0 }];
    const armoredEntries = [{ creepId: 'armored', count: 6, spacingTicks: 25, offsetTicks: 0 }];
    const resoluteFastEntries = [
      { creepId: 'resolute', count: 6, spacingTicks: 15, offsetTicks: 0 },
      { creepId: 'fast', count: 6, spacingTicks: 15, offsetTicks: 0 },
    ];
    const flyingEntries = [{ creepId: 'flying', count: 8, spacingTicks: 15, offsetTicks: 0 }];
    expect(board.waves).toEqual([
      { index: 0, countdownTicks: 500, clearBonus: 4, entries: normalEntries },
      { index: 1, countdownTicks: 300, clearBonus: 4, entries: swarmEntries },
      { index: 2, countdownTicks: 300, clearBonus: 5, entries: fastEntries },
      { index: 3, countdownTicks: 300, clearBonus: 5, entries: armoredEntries },
      { index: 4, countdownTicks: 300, clearBonus: 7, entries: resoluteFastEntries },
      { index: 5, countdownTicks: 300, clearBonus: 6, entries: flyingEntries },
    ]);
  });

  it('is the only bundled ruleset', () => {
    expect(bundledRulesetIds()).toEqual(['wynding-core']);
  });
});

describe('getBundledRuleset (caching + freezing)', () => {
  it('caches: repeated calls for the same id return the SAME frozen instance', () => {
    const first = getBundledRuleset('wynding-core');
    const second = getBundledRuleset('wynding-core');
    expect(second).toBe(first);
    const byDefault = getBundledRuleset();
    expect(byDefault).toBe(first);
  });

  it('throws RulesetError for an unknown ruleset id', () => {
    expect(() => getBundledRuleset('no-such-ruleset')).toThrow(RulesetError);
  });

  it('returns a deep-frozen result', () => {
    const ruleset = getBundledRuleset();
    expect(Object.isFrozen(ruleset)).toBe(true);
    expect(Object.isFrozen(ruleset.creepCatalog)).toBe(true);
    expect(Object.isFrozen(ruleset.creepCatalog[0])).toBe(true);
    expect(Object.isFrozen(ruleset.towerCatalog[0])).toBe(true);
    expect(Object.isFrozen(ruleset.balance)).toBe(true);
    expect(Object.isFrozen(ruleset.scoring)).toBe(true);
    expect(Object.isFrozen(ruleset.boards[0])).toBe(true);
    expect(Object.isFrozen(ruleset.boards[0]!.waves[0])).toBe(true);
  });
});

describe('artifact fidelity (the two-loaders invariant, ADR 0007 §2)', () => {
  it('the on-disk text is string-identical to the registry-bundled text', () => {
    const diskText = readFileSync(BUNDLED_ARTIFACT_URL, 'utf8');
    expect(diskText).toBe(rawWyndingCore);
    expect(diskText.length).toBeLessThanOrEqual(MAX_RULESET_TEXT_UNITS);
    // Both loaders run the SAME text through the SAME parseRulesetJson, so their
    // normalized output — and thus their digest — must agree exactly.
    const registryRuleset = getBundledRuleset();
    const diskRuleset = parseRulesetJson(diskText);
    expect(diskRuleset).toEqual(registryRuleset);
    expect(rulesetDigest(diskRuleset)).toBe(rulesetDigest(registryRuleset));
  });
});

describe('the compile-bound arithmetic, pinned as named numbers (M2-S5a P5, mirrors stress.test.ts)', () => {
  // Same idiom as stress.test.ts's own compile-bound pin: read the knobs off the
  // parsed bundle rather than hand-typing them, so a bundle edit changes what this
  // test computes, not just what it happens to match. This bundle now carries SIX
  // waves (the S5a `armored` wave at index 3, the S6 `resolute`+`fast` wave at index
  // 4, the S7 `flying` wave at index 5), so the prefix-sum form is load-bearing here
  // in a way stress.test.ts's single-wave bundle doesn't exercise.
  const text = readFileSync(BUNDLED_ARTIFACT_URL, 'utf8');
  const bundle = parseRulesetJson(text);
  const board = bundle.boards.find((b) => b.id === 'field-01');
  if (board === undefined) throw new Error("no board 'field-01' in the shipped bundle");
  const slowTower = bundle.towerCatalog.find((t) => t.id === 'slow');
  if (slowTower === undefined) throw new Error("no tower 'slow' in the shipped bundle");
  const slowEffect = slowTower.effects.find((e) => e.kind === 'slow');
  if (slowEffect === undefined) throw new Error("'slow' has no slow effect");
  const mulFp = slowEffect.mulFp;
  const slowFloorNum = bundle.balance.slowFloorNum;
  const slowFloorDen = bundle.balance.slowFloorDen;

  // `effectiveSpeedFp` (ruleset-shared.ts): max(1, floor(speedFp*mulFp/256),
  // ceil(speedFp*slowFloorNum/slowFloorDen)) — the minimum over every creep id ANY
  // wave spawns, exactly as `ruleset.ts`'s own bound gate computes it.
  const minEffSpeedFp = Math.min(
    ...bundle.creepCatalog.map((c) =>
      Math.max(
        1,
        Math.floor((c.speedFp * mulFp) / 256),
        Math.ceil((c.speedFp * slowFloorNum) / slowFloorDen),
      ),
    ),
  );

  it('minEffSpeedFp = 11 (the S5a `armored` creep, 22 under `slow`: floor(22*128/256))', () => {
    expect(minEffSpeedFp).toBe(11);
  });

  const cells = board.widthTiles * board.heightTiles;
  const traversal = Math.ceil((cells * DIAG_LEN) / minEffSpeedFp);

  it('board is 28x24 (672 cells); traversal = ceil(672*362/11) = 22115', () => {
    expect(board.widthTiles).toBe(28);
    expect(board.heightTiles).toBe(24);
    expect(cells).toBe(672);
    expect(traversal).toBe(22_115);
  });

  // latestSpawnTick, mirroring `ruleset.ts`'s own prefix-sum definition: wave k
  // launches at the prefix sum of countdowns 1..k, so its last spawn lands at
  // `prefix_k + tail_k`, and the run's latest spawn is the MAX of that over k.
  const waves = board.waves;
  const tailOf = (w: (typeof waves)[number]): number =>
    w.entries.reduce(
      (max, e) => Math.max(max, (e.offsetTicks ?? 0) + (e.count - 1) * e.spacingTicks),
      0,
    );
  let prefixCountdown = 0;
  let latestSpawnTick = 0;
  for (const w of waves) {
    prefixCountdown += w.countdownTicks;
    latestSpawnTick = Math.max(latestSpawnTick, prefixCountdown + tailOf(w));
  }

  // Re-pinned M2-S7 P6: the bundle gains a SIXTH wave (index 5, 8x `flying`, spacing
  // 15). Its prefix countdown is 2000 (500+300+300+300+300+300) and its tail is
  // (8-1)*15 = 105, so its launch-tick spawn lands at 2105 — the new max, beating
  // wave index 4's 1775 by 330 ticks.
  it("latestSpawnTick = 2105 (wave index 5 launches at prefix 2000, tail 105 on its 8x15 entries — its 2105 beats wave index 4's prefix 1700 + tail 75 = 1775 on launch tick)", () => {
    expect(waves).toHaveLength(6);
    expect(latestSpawnTick).toBe(2_105);
  });

  it('total bound = latestSpawnTick + traversal = 24220, comfortably under MAX_MATCH_TICKS (36000)', () => {
    // Derived from the same bundle-read terms the tests above pin, not re-typed as
    // `2105 + 22115` — the same reason stress.test.ts's own pin does this.
    const total = latestSpawnTick + traversal;
    expect(total).toBe(24_220);
    expect(MAX_MATCH_TICKS).toBe(36_000);
    expect(total).toBeLessThan(MAX_MATCH_TICKS);
  });

  // The bundle must actually compile under this bound — a passing arithmetic pin
  // above proves nothing if the compiler disagrees; this ties the two together.
  it('compiles cleanly given the bound holds', () => {
    expect(() => compileRuleset(bundle, 'field-01')).not.toThrow();
  });
});
