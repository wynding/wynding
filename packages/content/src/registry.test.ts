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

  it('carries the creep catalog: `normal`, the S3 `fast` creep, and the S4a `swarm` creep', () => {
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
    ]);
  });

  it('carries the tower catalog: `basic`, the S3 `slow` tower, and the S4a `splash` tower (all ground-scoped)', () => {
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
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 2 },
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

  it('carries the three waves: 10 × normal @ spacing 20, then 16 × swarm @ spacing 5 (the S4a AoE showcase), then 8 × fast @ spacing 15 (the S3 slow-showcase)', () => {
    const normalEntries = [{ creepId: 'normal', count: 10, spacingTicks: 20, offsetTicks: 0 }];
    const swarmEntries = [{ creepId: 'swarm', count: 16, spacingTicks: 5, offsetTicks: 0 }];
    const fastEntries = [{ creepId: 'fast', count: 8, spacingTicks: 15, offsetTicks: 0 }];
    expect(board.waves).toEqual([
      { index: 0, countdownTicks: 500, clearBonus: 4, entries: normalEntries },
      { index: 1, countdownTicks: 300, clearBonus: 4, entries: swarmEntries },
      { index: 2, countdownTicks: 300, clearBonus: 5, entries: fastEntries },
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
