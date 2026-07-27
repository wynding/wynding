// capability.test.ts — the per-simVersion capability profile (M2-S1): the
// simVersion-5 profile's exact shape, an unknown-simVersion throw, and — since the
// profile itself is inert data gated only inside `compileRuleset` — accept-at-
// boundary / reject-beyond-boundary coverage for every dimension, exercised through
// `compileRuleset` against `test-support`'s M1-shaped bundle. Every rejection pins
// the gate's own message: several mutations are rejectable by more than one path
// (a 'slow' effect trips `allowedEffectKinds` AND the later direct/single-effect
// requirement), and this file's whole premise is per-dimension coverage — removing
// a capability check must turn a case red, not shift it to a different throw.

import { describe, it, expect } from 'vitest';
import type { Ruleset } from '@wynding/types';
import { capabilityProfile } from './capability';
import { compileRuleset, RulesetError } from './ruleset';
import { testBundle } from './test-support';

const OPEN = {
  widthTiles: 9,
  heightTiles: 5,
  entrance: { col: 0, row: 2 },
  exit: { col: 8, row: 2 },
} as const;

type DeepMutable<T> = T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;
type MutableRuleset = DeepMutable<Ruleset>;

function base(): MutableRuleset {
  return JSON.parse(JSON.stringify(testBundle(OPEN))) as MutableRuleset;
}

function compiles(mutate: (b: MutableRuleset) => void): void {
  const b = base();
  mutate(b);
  expect(() => compileRuleset(b as Ruleset, 'test')).not.toThrow();
}

/** Assert the mutation is rejected by the EXPECTED gate — `toThrow(string)` matches
 *  a message substring, so the case fails if a different check fires first. */
function rejects(mutate: (b: MutableRuleset) => void, expected: string): void {
  const b = base();
  mutate(b);
  expect(() => compileRuleset(b as Ruleset, 'test')).toThrow(RulesetError);
  expect(() => compileRuleset(b as Ruleset, 'test')).toThrow(expected);
}

describe('capabilityProfile', () => {
  it('throws on an unknown simVersion', () => {
    expect(() => capabilityProfile(0)).toThrow(RulesetError);
    expect(() => capabilityProfile(999)).toThrow(RulesetError);
  });

  it('simVersion 5 is exactly M1 semantics', () => {
    expect(capabilityProfile(5)).toEqual({
      maxTowerCatalogSize: 1,
      maxWavesPerBoard: 1,
      maxEntriesPerWave: 1,
      maxOffsetTicks: 0,
      maxEffectsPerBundle: 1,
      allowedEffectKinds: ['direct'],
      allowedDirectForms: ['single'],
      allowedTowerDomains: ['ground'],
      allowedCreepDomains: ['ground'],
      allowedImmunities: [],
      allowedRoles: [],
      maxArmor: 0,
      requiredLeakCost: 1,
      maxClearBonus: 0,
      maxEarlyCallBountyDivisor: 0,
      maxEarlyCallScoreDivisor: 0,
    });
  });

  it('the returned profile is deeply frozen (a mutation cannot widen the gate)', () => {
    const profile = capabilityProfile(5);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.allowedEffectKinds)).toBe(true);
    expect(() => {
      (profile.allowedEffectKinds as string[]).push('slow');
    }).toThrow(TypeError);
  });
});

describe('capability gate — accept at boundary, reject beyond, per dimension', () => {
  it('maxTowerCatalogSize: 1 accepted, 2 rejected', () => {
    compiles(() => {});
    rejects(
      (b) =>
        b.towerCatalog.push({
          id: 'rapid',
          cost: 5,
          attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
          effects: [{ kind: 'direct', form: 'single', damage: 10 }],
        }),
      'towerCatalog size 2 exceeds 1 at simVersion 5',
    );
  });

  it('maxWavesPerBoard: 1 accepted, 2 rejected', () => {
    compiles(() => {});
    rejects(
      (b) =>
        b.boards[0]!.waves.push({
          index: 1,
          countdownTicks: 10,
          clearBonus: 0,
          entries: [{ creepId: 'normal', count: 1, spacingTicks: 5 }],
        }),
      "board 'test' has 2 waves, exceeds 1 at simVersion 5",
    );
  });

  it('maxEntriesPerWave: 1 accepted, 2 rejected', () => {
    compiles(() => {});
    rejects(
      (b) => b.boards[0]!.waves[0]!.entries.push({ creepId: 'normal', count: 1, spacingTicks: 5 }),
      "board 'test' wave 0 has 2 entries, exceeds 1 at simVersion 5",
    );
  });

  it('maxOffsetTicks: 0 accepted, 1 rejected', () => {
    compiles((b) => (b.boards[0]!.waves[0]!.entries[0]!.offsetTicks = 0));
    rejects(
      (b) => (b.boards[0]!.waves[0]!.entries[0]!.offsetTicks = 1),
      "board 'test' wave 0 entry offsetTicks 1 exceeds 0 at simVersion 5",
    );
  });

  it('maxEffectsPerBundle: 1 accepted, 2 rejected', () => {
    compiles(() => {});
    rejects((b) => {
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'direct', form: 'single', damage: 10 },
      ];
    }, "tower 'basic' has 2 effects, exceeds 1 at simVersion 5");
  });

  it("allowedEffectKinds: 'direct' accepted, 'slow' rejected", () => {
    compiles(() => {});
    rejects((b) => {
      b.towerCatalog[0]!.effects = [{ kind: 'slow', mulFp: 64, durationTicks: 30 }];
    }, "effect kind 'slow' unsupported at simVersion 5");
  });

  it("allowedDirectForms: 'single' accepted, 'aoe' rejected", () => {
    compiles(() => {});
    rejects((b) => {
      b.towerCatalog[0]!.effects = [{ kind: 'direct', form: 'aoe', damage: 10, radiusFp: 300 }];
    }, "effect form 'aoe' unsupported at simVersion 5");
  });

  it("allowedTowerDomains: 'ground' accepted, 'both' rejected", () => {
    compiles(() => {});
    rejects(
      (b) => (b.towerCatalog[0]!.attack!.domain = 'both'),
      "tower attack domain 'both' unsupported at simVersion 5",
    );
  });

  it("allowedCreepDomains: 'ground' accepted, 'air' rejected", () => {
    compiles(() => {});
    rejects(
      (b) => (b.creepCatalog[0]!.domain = 'air'),
      "creep domain 'air' unsupported at simVersion 5",
    );
  });

  it("allowedImmunities: [] — no immunity accepted, 'slow' rejected", () => {
    compiles((b) => (b.creepCatalog[0]!.immunities = []));
    rejects(
      (b) => (b.creepCatalog[0]!.immunities = ['slow']),
      "creep immunity 'slow' unsupported at simVersion 5",
    );
  });

  it("allowedRoles: [] — no role accepted, 'boss' rejected", () => {
    compiles(() => {});
    rejects(
      (b) => (b.creepCatalog[0]!.role = 'boss'),
      "creep role 'boss' unsupported at simVersion 5",
    );
  });

  it('maxArmor: 0 accepted, 1 rejected', () => {
    compiles((b) => (b.creepCatalog[0]!.armor = 0));
    rejects(
      (b) => (b.creepCatalog[0]!.armor = 1),
      "creep 'normal' armor 1 exceeds 0 at simVersion 5",
    );
  });

  it('requiredLeakCost: pins the VALUE (1), not merely uniformity', () => {
    compiles((b) => b.creepCatalog.push({ ...b.creepCatalog[0]!, id: 'other', leakCost: 1 }));
    rejects(
      (b) => b.creepCatalog.push({ ...b.creepCatalog[0]!, id: 'other', leakCost: 2 }),
      "creep 'other' leakCost 2 unsupported at simVersion 5 (must be 1)",
    );
    // Uniform-but-nonzero must ALSO reject — m2.md pins "leakCost = 1 until S10";
    // a whole catalog at 2 is still content this sim build cannot simulate.
    rejects(
      (b) => (b.creepCatalog[0]!.leakCost = 2),
      "creep 'normal' leakCost 2 unsupported at simVersion 5 (must be 1)",
    );
  });

  it('maxClearBonus: 0 accepted, 1 rejected', () => {
    compiles((b) => (b.boards[0]!.waves[0]!.clearBonus = 0));
    rejects(
      (b) => (b.boards[0]!.waves[0]!.clearBonus = 1),
      "board 'test' wave 0 clearBonus 1 exceeds 0 at simVersion 5",
    );
  });

  it('maxEarlyCallBountyDivisor: 0 accepted, 1 rejected', () => {
    compiles((b) => (b.balance.earlyCallBountyDivisor = 0));
    rejects(
      (b) => (b.balance.earlyCallBountyDivisor = 1),
      'earlyCallBountyDivisor 1 exceeds 0 at simVersion 5',
    );
  });

  it('maxEarlyCallScoreDivisor: 0 accepted, 1 rejected', () => {
    compiles((b) => (b.scoring.earlyCallScoreDivisor = 0));
    rejects(
      (b) => (b.scoring.earlyCallScoreDivisor = 1),
      'earlyCallScoreDivisor 1 exceeds 0 at simVersion 5',
    );
  });
});
