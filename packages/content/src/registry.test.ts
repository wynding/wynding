// registry.test.ts — the bundled ruleset registry (M2-S1). Pins every authored M1
// value (carrying forward the intent of the deleted `boards.test.ts`, now over the
// registry-loaded artifact) and proves the registry's own contract: happy path,
// caching, unknown-id rejection, deep-frozen results, and — the two-loaders
// invariant (ADR 0007 §2 / PLAN M2-S1 Validation architecture) — artifact fidelity
// between the bundled `?raw` text and the on-disk JSON file.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  parseRulesetJson,
  MAX_RULESET_TEXT_UNITS,
  rulesetDigest,
  RulesetError,
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
import rawWyndingCoreM1 from './rulesets/wynding-core-m1.json?raw';

describe('getBundledRuleset (happy path + authored M1 values)', () => {
  const ruleset = getBundledRuleset();
  const board = ruleset.boards[0]!;

  it('defaults to DEFAULT_RULESET_ID = wynding-core-m1, version 1', () => {
    expect(DEFAULT_RULESET_ID).toBe('wynding-core-m1');
    expect(ruleset.formatVersion).toBe(2);
    expect(ruleset.rulesetId).toBe('wynding-core-m1');
    expect(ruleset.version).toBe(1);
  });

  it('is also reachable by explicit id', () => {
    expect(getBundledRuleset('wynding-core-m1')).toBe(ruleset);
  });

  it('carries the M1 creep catalog: one ground creep, `normal`', () => {
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
    ]);
  });

  it('carries the M1 tower catalog: one single-target tower, `basic`', () => {
    expect(ruleset.towerCatalog).toEqual([
      {
        id: 'basic',
        cost: 5,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
        effects: [{ kind: 'direct', form: 'single', damage: 10 }],
      },
    ]);
  });

  it('carries the M1 starting economy and refund/slow-floor fractions', () => {
    expect(ruleset.balance).toEqual({
      startingLives: 10,
      startingBounty: 80,
      refundNum: 3,
      refundDen: 4,
      slowFloorNum: 1,
      slowFloorDen: 4,
      earlyCallBountyDivisor: 0,
    });
  });

  it('carries the M1 scoring weights', () => {
    expect(ruleset.scoring).toEqual({
      survivalMul: 25,
      starThresholds: [1, 6, 9],
      earlyCallScoreDivisor: 0,
    });
  });

  it('carries the M1 board geometry: field-01, a 28×24 grid', () => {
    expect(board.id).toBe('field-01');
    expect(defaultBoardId(ruleset)).toBe('field-01');
    expect(board.widthTiles).toBe(28);
    expect(board.heightTiles).toBe(24);
    expect(board.entrance).toEqual({ col: 0, row: 11 });
    expect(board.exit).toEqual({ col: 27, row: 11 });
  });

  it('carries the M1 wave: one wave of 10, countdown 500, no clear bonus, offsetTicks defaulted to 0', () => {
    expect(board.waves).toEqual([
      {
        index: 0,
        countdownTicks: 500,
        clearBonus: 0,
        entries: [{ creepId: 'normal', count: 10, spacingTicks: 20, offsetTicks: 0 }],
      },
    ]);
  });

  it('is the only bundled ruleset', () => {
    expect(bundledRulesetIds()).toEqual(['wynding-core-m1']);
  });
});

describe('getBundledRuleset (caching + freezing)', () => {
  it('caches: repeated calls for the same id return the SAME frozen instance', () => {
    const first = getBundledRuleset('wynding-core-m1');
    const second = getBundledRuleset('wynding-core-m1');
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
    expect(diskText).toBe(rawWyndingCoreM1);
    expect(diskText.length).toBeLessThanOrEqual(MAX_RULESET_TEXT_UNITS);
    // Both loaders run the SAME text through the SAME parseRulesetJson, so their
    // normalized output — and thus their digest — must agree exactly.
    const registryRuleset = getBundledRuleset();
    const diskRuleset = parseRulesetJson(diskText);
    expect(diskRuleset).toEqual(registryRuleset);
    expect(rulesetDigest(diskRuleset)).toBe(rulesetDigest(registryRuleset));
  });
});
