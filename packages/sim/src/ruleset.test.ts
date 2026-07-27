// ruleset.test.ts — compileRuleset's end-to-end domain validation (ADR 0007): every
// malformed/unsupported field is rejected with a RulesetError before a match can
// start. Pure structural/shape violations are exhaustively covered in
// ruleset-schema.test.ts; capability-profile boundary cases are exhaustively covered
// in capability.test.ts. This file covers compileRuleset's own integration surface —
// representative structural rejections (proving the schema wall is actually wired
// in), the balance/scoring/catalog/wave domains that matter at the compile level,
// and the success path.

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

describe('compileRuleset — structural rejections (schema wall wired in)', () => {
  it('rejects a missing bundle / empty catalogs', () => {
    expect(() => compileRuleset(null as unknown as Ruleset, 'test')).toThrow(RulesetError);
    rejects((b) => (b.creepCatalog = []));
    rejects((b) => (b.towerCatalog = []));
  });

  it('rejects an unknown boardId', () => {
    expect(() => compileRuleset(base() as Ruleset, 'no-such-board')).toThrow(RulesetError);
  });

  it('rejects an unsupported formatVersion (schema evolution)', () => {
    rejects((b) => (b.formatVersion = 1 as never));
  });

  it('rejects malformed identity fields (rulesetId / version)', () => {
    rejects((b) => (b.rulesetId = 7 as never));
    rejects((b) => (b.rulesetId = ''));
    rejects((b) => (b.rulesetId = 'Not-Lowercase'));
    rejects((b) => (b.version = -1));
  });

  it('rejects a null / primitive catalog entry as a RulesetError (no native TypeError)', () => {
    rejects((b) => (b.creepCatalog[0] = null as never));
    rejects((b) => (b.towerCatalog[0] = null as never));
    rejects((b) => (b.towerCatalog[0] = 42 as never));
  });

  it('rejects a null board / wave entry as a RulesetError (no native TypeError)', () => {
    rejects((b) => (b.boards[0] = null as never));
    rejects((b) => (b.boards[0]!.waves[0] = null as never));
  });

  it('rejects a duplicate creep id (ambiguous catalog — an id maps to one stat block)', () => {
    rejects((b) => b.creepCatalog.push({ ...b.creepCatalog[0]! }));
  });

  it('rejects an unknown top-level property', () => {
    rejects((b) => ((b as unknown as Record<string, unknown>).extra = 1));
  });
});

describe('compileRuleset — balance domains', () => {
  it('rejects non-positive lives / refundDen / slowFloorDen', () => {
    rejects((b) => (b.balance.startingLives = 0));
    rejects((b) => (b.balance.refundDen = 0));
    rejects((b) => (b.balance.slowFloorDen = 0));
  });

  it('rejects negative economy / divisor values', () => {
    rejects((b) => (b.balance.startingBounty = -1));
    rejects((b) => (b.balance.refundNum = -1));
    rejects((b) => (b.balance.earlyCallBountyDivisor = -1));
  });

  it('rejects a refund fraction greater than 1', () => {
    rejects((b) => {
      b.balance.refundNum = 5;
      b.balance.refundDen = 4;
    });
  });

  it('rejects a slowFloor fraction greater than 1', () => {
    rejects((b) => {
      b.balance.slowFloorNum = 5;
      b.balance.slowFloorDen = 4;
    });
  });

  it('rejects a non-integer field', () => {
    rejects((b) => (b.balance.startingLives = 1.5));
  });

  it('rejects a nonzero earlyCallBountyDivisor — pinned off at simVersion 5', () => {
    rejects((b) => (b.balance.earlyCallBountyDivisor = 1));
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

  it('rejects a nonzero earlyCallScoreDivisor — pinned off at simVersion 5', () => {
    rejects((b) => (b.scoring.earlyCallScoreDivisor = 1));
  });
});

describe('compileRuleset — creep catalog domains', () => {
  it('rejects a malformed creep def', () => {
    rejects((b) => (b.creepCatalog[0]!.hp = 0));
    rejects((b) => (b.creepCatalog[0]!.speedFp = 0));
    rejects((b) => (b.creepCatalog[0]!.bounty = -1));
    rejects((b) => ((b.creepCatalog[0] as { domain: unknown }).domain = 'plasma'));
    rejects((b) => (b.creepCatalog[0]!.leakCost = 0));
    rejects((b) => (b.creepCatalog[0]!.leakCost = 1001));
  });

  it('rejects a creep domain unsupported at simVersion 5 (valid type, capability-gated)', () => {
    rejects((b) => (b.creepCatalog[0]!.domain = 'air'));
  });

  it('rejects nonzero armor / any immunity / role — all capability-gated to 0/none at simVersion 5', () => {
    rejects((b) => (b.creepCatalog[0]!.armor = 1));
    rejects((b) => (b.creepCatalog[0]!.immunities = ['slow']));
    rejects((b) => (b.creepCatalog[0]!.role = 'boss'));
  });

  it('rejects a non-uniform leakCost across the catalog (capability: requiredLeakCost)', () => {
    rejects((b) => b.creepCatalog.push({ ...b.creepCatalog[0]!, id: 'other', leakCost: 2 }));
  });
});

describe('compileRuleset — tower catalog domains', () => {
  it('rejects a malformed tower def', () => {
    rejects((b) => (b.towerCatalog[0]!.cost = 0));
    rejects((b) => (b.towerCatalog[0]!.attack!.rangeFp = 0));
    rejects((b) => (b.towerCatalog[0]!.attack!.cadenceTicks = 0));
    rejects((b) => (b.towerCatalog[0]!.attack!.travelTicks = -1));
    rejects((b) => (b.towerCatalog[0]!.attack!.travelTicks = 0)); // 0-travel resolves a tick late
    rejects((b) => (b.towerCatalog[0]!.attack!.travelTicks = 30)); // >= cadence → >1 impact in flight
  });

  it('rejects an effect kind/form unsupported at simVersion 5 (valid schema, capability-gated)', () => {
    rejects(
      (b) =>
        (b.towerCatalog[0]!.effects = [{ kind: 'slow', mulFp: 64, durationTicks: 30 } as never]),
    );
    rejects(
      (b) =>
        (b.towerCatalog[0]!.effects = [
          { kind: 'direct', form: 'aoe', damage: 10, radiusFp: 300 } as never,
        ]),
    );
  });

  it('rejects a multi-tower catalog (capability: maxTowerCatalogSize 1)', () => {
    rejects((b) =>
      b.towerCatalog.push({
        id: 'rapid',
        cost: 5,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
        effects: [{ kind: 'direct', form: 'single', damage: 10 }],
      }),
    );
  });

  it('rejects a tower attack domain unsupported at simVersion 5', () => {
    rejects((b) => (b.towerCatalog[0]!.attack!.domain = 'both'));
  });
});

describe('compileRuleset — wave domains', () => {
  it('rejects a wave that exceeds the scheduled-spawn cap', () => {
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.count = 10_001));
  });

  it('rejects a baseline run that cannot terminate within the tick budget', () => {
    rejects((b) => (b.boards[0]!.waves[0]!.countdownTicks = 40_000)); // launch alone > the 36k ceiling
  });

  it('rejects a second wave on the board (capability: maxWavesPerBoard 1)', () => {
    rejects((b) =>
      b.boards[0]!.waves.push({
        index: 1,
        countdownTicks: 10,
        clearBonus: 0,
        entries: [{ creepId: 'normal', count: 1, spacingTicks: 5 }],
      }),
    );
  });

  it('rejects a second entry on the wave (capability: maxEntriesPerWave 1)', () => {
    rejects((b) =>
      b.boards[0]!.waves[0]!.entries.push({ creepId: 'normal', count: 1, spacingTicks: 5 }),
    );
  });

  it('rejects a nonzero wave clearBonus (capability: maxClearBonus 0)', () => {
    rejects((b) => (b.boards[0]!.waves[0]!.clearBonus = 1));
  });

  it('rejects a nonzero entry offsetTicks (capability: maxOffsetTicks 0)', () => {
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.offsetTicks = 1));
  });

  it('rejects an entry referencing an unknown creepId, or a bad count/spacing', () => {
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.creepId = 'boss'));
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.count = 0));
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.spacingTicks = 0));
    // Object.prototype names are ordinary UNKNOWN ids here: the schema's Set-based
    // reference check rejects them first (and the id pattern bars them from ever
    // being DEFINED as catalog ids), so compileRuleset's null-proto `creepById`
    // record sits behind two walls as belt-and-braces — these cases pin the outer
    // wall, not the record itself.
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.creepId = 'toString'));
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.creepId = '__proto__'));
  });

  it('rejects a wave.index that does not match its array position, incl. a non-integer', () => {
    rejects((b) => (b.boards[0]!.waves[0]!.index = 1));
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
