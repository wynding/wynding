// ruleset.test.ts — the ruleset loader's per-field domain validation (ADR 0007):
// every malformed field is rejected with a RulesetError before a match can start.

import { describe, it, expect } from 'vitest';
import type { Ruleset } from '@wynding/types';
import { compileRuleset, RulesetError } from './ruleset';
import { testBundle } from './test-support';

const OPEN = {
  widthTiles: 9,
  heightTiles: 5,
  entrance: { col: 0, row: 2 },
  exit: { col: 8, row: 2 },
} as const;

/** A deep-writable view so each case can mutate one field of a cloned bundle. */
type DeepMutable<T> = T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;
type MutableRuleset = DeepMutable<Ruleset>;

/** A deep clone of a valid bundle, so each case mutates one field in isolation. */
function base(): MutableRuleset {
  return JSON.parse(JSON.stringify(testBundle(OPEN))) as MutableRuleset;
}

/** Assert `mutate` produces content the loader rejects with a RulesetError. */
function rejects(mutate: (b: MutableRuleset) => void): void {
  const b = base();
  mutate(b);
  expect(() => compileRuleset(b as Ruleset, 'test')).toThrow(RulesetError);
}

describe('compileRuleset — structural rejections', () => {
  it('rejects a missing bundle / empty catalogs', () => {
    expect(() => compileRuleset(null as unknown as Ruleset, 'test')).toThrow(RulesetError);
    rejects((b) => (b.creepCatalog = []));
    rejects((b) => (b.towerCatalog = []));
  });

  it('rejects an unknown boardId', () => {
    expect(() => compileRuleset(base() as Ruleset, 'no-such-board')).toThrow(RulesetError);
  });

  it('rejects an unsupported formatVersion (schema evolution)', () => {
    rejects((b) => (b.formatVersion = 2));
  });
});

describe('compileRuleset — balance domains', () => {
  it('rejects non-positive lives / countdown / leakCost / refundDen', () => {
    rejects((b) => (b.balance.startingLives = 0));
    rejects((b) => (b.balance.countdownTicks = 0));
    rejects((b) => (b.balance.leakCost = 0));
    rejects((b) => (b.balance.refundDen = 0));
  });

  it('rejects negative economy / bonus values', () => {
    rejects((b) => (b.balance.startingBounty = -1));
    rejects((b) => (b.balance.refundNum = -1));
    rejects((b) => (b.balance.waveClearBonus = -1));
    rejects((b) => (b.balance.earlyCallBonus = -1));
  });

  it('rejects a refund fraction greater than 1', () => {
    rejects((b) => {
      b.balance.refundNum = 5;
      b.balance.refundDen = 4;
    });
  });

  it('rejects a non-integer field', () => {
    rejects((b) => (b.balance.startingLives = 1.5));
  });
});

describe('compileRuleset — scoring domains', () => {
  it('rejects a negative survival multiplier', () => {
    rejects((b) => (b.scoring.survivalMul = -1));
  });

  it('rejects star thresholds that are the wrong shape or not ascending', () => {
    rejects((b) => (b.scoring.starThresholds = [1, 6] as unknown as [number, number, number]));
    rejects((b) => (b.scoring.starThresholds = [1, 6, 0]));
    rejects((b) => (b.scoring.starThresholds = [9, 6, 1]));
  });
});

describe('compileRuleset — creep + tower catalog domains', () => {
  it('rejects a malformed creep def', () => {
    rejects((b) => (b.creepCatalog[0]!.hp = 0));
    rejects((b) => (b.creepCatalog[0]!.speedFp = 0));
    rejects((b) => (b.creepCatalog[0]!.bounty = -1));
    rejects((b) => ((b.creepCatalog[0] as { domain: unknown }).domain = 'plasma'));
    rejects((b) => (b.creepCatalog[0]!.domain = 'air')); // valid type, unsupported at M1
  });

  it('rejects a malformed tower def', () => {
    rejects((b) => (b.towerCatalog[0]!.cost = 0));
    rejects((b) => (b.towerCatalog[0]!.damage = 0));
    rejects((b) => (b.towerCatalog[0]!.rangeFp = 0));
    rejects((b) => (b.towerCatalog[0]!.cadenceTicks = 0));
    rejects((b) => (b.towerCatalog[0]!.travelTicks = -1));
    rejects((b) => (b.towerCatalog[0]!.travelTicks = 0)); // 0-travel resolves a tick late
  });

  it('rejects a sole tower whose kind is not basic (mis-simulated as basic otherwise)', () => {
    rejects((b) => (b.towerCatalog[0]!.kind = 'splash'));
  });

  it('rejects a multi-entry tower catalog (M1 is single-tower)', () => {
    rejects((b) =>
      b.towerCatalog.push({
        kind: 'rapid',
        cost: 5,
        damage: 10,
        rangeFp: 1024,
        cadenceTicks: 30,
        travelTicks: 4,
      }),
    );
  });
});

describe('compileRuleset — wave domains', () => {
  it('rejects anything but exactly one wave', () => {
    rejects((b) => (b.boards[0]!.waves = []));
    rejects((b) =>
      b.boards[0]!.waves.push({
        index: 1,
        entries: [{ kind: 'normal', count: 1, spacingTicks: 5 }],
      }),
    );
  });

  it('rejects an entry referencing an unknown creep kind, or a bad count/spacing', () => {
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.kind = 'boss'));
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.count = 0));
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.spacingTicks = 0));
    // Object.prototype names must NOT be treated as known kinds (null-proto record).
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.kind = 'toString' as never));
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.kind = '__proto__' as never));
  });

  it('rejects a wave that exceeds the scheduled-spawn cap', () => {
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.count = 10_001));
  });

  it('rejects a baseline run that cannot terminate within the tick budget', () => {
    rejects((b) => (b.balance.countdownTicks = 40_000)); // launch alone > the 36k ceiling
  });

  it('surfaces an un-hashable field (non-integer wave index) as a RulesetError', () => {
    // `index` isn't a sim-affecting int-validated field, but it enters the digest;
    // a float trips canonicalJson — compileRuleset must re-throw it as a RulesetError.
    rejects((b) => (b.boards[0]!.waves[0]!.index = 1.5));
  });
});

describe('compileRuleset — success', () => {
  it('compiles a valid bundle into a branded ruleset with a per-spawn schedule', () => {
    const compiled = compileRuleset(testBundle(OPEN, { waveCount: 4, waveSpacing: 5 }), 'test');
    expect(compiled.schedule).toHaveLength(4);
    expect(compiled.schedule.map((s) => s.offsetTicks)).toEqual([0, 5, 10, 15]);
    expect(compiled.tower.cost).toBe(5);
    expect(compiled.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
