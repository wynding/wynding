// capability.test.ts — the per-simVersion capability profile (M2-S1, widened at
// M2-S2 to sv6, M2-S3 to sv7, M2-S4a to sv8, M2-S5a to sv9): the simVersion-9
// profile's exact shape, an unknown-simVersion throw, and — since the profile
// itself is inert data gated only inside `compileRuleset` — accept-at-boundary /
// reject-beyond-boundary coverage for every dimension still narrower than the
// schema, exercised through `compileRuleset` against `test-support`'s bundle.
// Every rejection pins the gate's own message: several mutations are rejectable by
// more than one path (a 'stun' effect trips `allowedEffectKinds` AND the later
// direct/single-effect requirement would trip too, were `allowedEffectKinds` not
// there first), and this file's whole premise is per-dimension coverage — removing
// a capability check must turn a case red, not shift it to a different throw.
//
// sv9 DEFERS TO THE SCHEMA on waves/entries/offsets/clearBonus/both early-call
// divisors (unchanged from sv6) AND NOW ALSO on `maxTowerCatalogSize`/
// `maxEffectsPerBundle` (capability.ts's header comment) — those dimensions no
// longer have a capability-layer rejection boundary distinct from the schema's own
// ceiling, so this file instead asserts they compile at (or near) the SCHEMA's
// boundary rather than testing a capability-specific reject.
//
// `allowedDirectForms` (QC round-1 #12) joins this deferred-to-schema list,
// UNAVOIDABLY: the v2 schema's own `form` field is an enum of exactly `'single'` /
// `'aoe'` (ruleset-schema.ts), so there is no schema-legal way to author a THIRD
// form value that could reach `allowedDirectForms` and be rejected BY IT — the
// schema wall trips first, every time. `allowedDirectForms`'s "'single' accepted,
// 'aoe' also accepted" test below therefore has no reject case of its own
// (deleting the gate entirely still leaves every test green, since both legal
// forms pass regardless) — recorded here rather than left silently missing.

import { describe, it, expect } from 'vitest';
import type { Ruleset } from '@wynding/types';
import { capabilityProfile } from './capability';
import { MAX_IMPACT_EFFECTS, MAX_BLAST_RADIUS_FP } from './combat';
import { compileRuleset, RulesetError } from './ruleset';
import { SIM_VERSION } from './index';
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
  it('accepts SIM_VERSION and rejects an unknown simVersion', () => {
    expect(() => capabilityProfile(SIM_VERSION)).not.toThrow();
    expect(() => capabilityProfile(0)).toThrow(RulesetError);
    expect(() => capabilityProfile(999)).toThrow(RulesetError);
    // Every prior version is deleted with each bump (G11) — a live entry would
    // misdescribe the current build's tick code, so each throws exactly like any
    // other unknown version.
    expect(() => capabilityProfile(6)).toThrow(RulesetError);
    expect(() => capabilityProfile(8)).toThrow(RulesetError);
  });

  // The profile's per-bundle ceiling and combat's `MAX_IMPACT_EFFECTS` are DELIBERATELY
  // separate constants (CodeRabbit #73): the profile is a verbatim per-simVersion record
  // whose numbers never move because another layer was edited; the cap is combat's
  // structural bound on any snapshot it accepts. The layers share an INVARIANT instead
  // of a binding — and since dead profiles are deleted at each bump (G11), pinning the
  // live one pins the whole surface.
  it('the live profile’s effects-per-bundle ceiling fits inside the runtime impact cap', () => {
    expect(capabilityProfile(SIM_VERSION).maxEffectsPerBundle).toBeLessThanOrEqual(
      MAX_IMPACT_EFFECTS,
    );
  });

  // Same INVARIANT-not-binding relationship (M2-S4a) between the profile's
  // `maxAoeRadiusFp` (an authoring ceiling, per simVersion) and combat's own
  // `MAX_BLAST_RADIUS_FP` (a runtime totality bound, independent of simVersion).
  it('the live profile’s maxAoeRadiusFp fits inside combat’s runtime blast-radius cap', () => {
    expect(capabilityProfile(SIM_VERSION).maxAoeRadiusFp).toBeLessThanOrEqual(MAX_BLAST_RADIUS_FP);
  });

  it('simVersion 9 is the armored-creep-and-DoT profile, deferring wave/economy/catalog-size axes to the schema', () => {
    expect(capabilityProfile(9)).toEqual({
      maxTowerCatalogSize: 64,
      maxWavesPerBoard: 64,
      maxEntriesPerWave: 16,
      maxOffsetTicks: 1_000_000,
      maxEffectsPerBundle: 8,
      allowedEffectKinds: ['direct', 'slow', 'dot'],
      allowedDirectForms: ['single', 'aoe'],
      allowedTowerDomains: ['ground'],
      allowedCreepDomains: ['ground'],
      allowedImmunities: [],
      allowedRoles: [],
      maxArmor: 16,
      requiredLeakCost: 1,
      maxClearBonus: 1_000_000,
      maxEarlyCallBountyDivisor: 1_000_000,
      maxEarlyCallScoreDivisor: 1_000_000,
      maxAoeRadiusFp: 2048,
      maxDotDurationTicks: 100_000,
    });
  });

  it('the returned profile is deeply frozen (a mutation cannot widen the gate)', () => {
    const profile = capabilityProfile(SIM_VERSION);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.allowedEffectKinds)).toBe(true);
    expect(() => {
      (profile.allowedEffectKinds as string[]).push('stun');
    }).toThrow(TypeError);
  });
});

describe('capability gate — accept at boundary, reject beyond, per dimension', () => {
  it('maxTowerCatalogSize defers to the schema ceiling (64) — a multi-tower catalog compiles', () => {
    compiles(() => {});
    compiles((b) =>
      b.towerCatalog.push({
        id: 'rapid',
        cost: 5,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
        effects: [{ kind: 'direct', form: 'single', damage: 10 }],
      }),
    );
  });

  // maxWavesPerBoard/maxEntriesPerWave/maxOffsetTicks/maxClearBonus/both early-call
  // divisors now carry the SCHEMA's own ceiling verbatim (sv6 defers, per
  // capability.ts's header) — the schema itself rejects anything wider, so there is
  // no longer a capability-specific reject boundary to pin for these dimensions.
  // Instead: accept at the schema's own widest legal value.

  it('maxWavesPerBoard defers to the schema ceiling (64) — a 3-wave board compiles', () => {
    compiles((b) => {
      const w0 = b.boards[0]!.waves[0]!;
      b.boards[0]!.waves = [
        { ...w0, index: 0 },
        { ...w0, index: 1 },
        { ...w0, index: 2 },
      ];
    });
  });

  it('maxEntriesPerWave defers to the schema ceiling (16) — a 2-entry wave compiles', () => {
    compiles((b) => {
      b.boards[0]!.waves[0]!.entries.push({ creepId: 'normal', count: 1, spacingTicks: 5 });
    });
  });

  it('maxOffsetTicks defers to the schema ceiling — a nonzero stream offset compiles', () => {
    compiles((b) => (b.boards[0]!.waves[0]!.entries[0]!.offsetTicks = 30));
  });

  it('maxEffectsPerBundle defers to the schema ceiling (8) — a maximal direct+slow bundle compiles', () => {
    compiles(() => {});
    compiles((b) => {
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'slow', mulFp: 200, durationTicks: 10 },
        { kind: 'slow', mulFp: 190, durationTicks: 10 },
        { kind: 'slow', mulFp: 180, durationTicks: 10 },
        { kind: 'slow', mulFp: 170, durationTicks: 10 },
        { kind: 'slow', mulFp: 160, durationTicks: 10 },
        { kind: 'slow', mulFp: 150, durationTicks: 10 },
        { kind: 'slow', mulFp: 140, durationTicks: 10 },
      ]; // 8 effects — the schema's own per-tower ceiling
    });
  });

  it("allowedEffectKinds: 'direct'+'slow'+'dot' accepted, 'stun' rejected", () => {
    compiles(() => {});
    compiles((b) => {
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'slow', mulFp: 128, durationTicks: 40 },
      ];
    });
    compiles((b) => {
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'dot', damagePerTick: 5, cadenceTicks: 10, durationTicks: 60 },
      ];
    });
    rejects((b) => {
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'stun', chanceNum: 64, durationTicks: 30 },
      ];
    }, "effect kind 'stun' unsupported at simVersion 9");
  });

  it('maxDotDurationTicks: exactly 100,000 accepted, 100,001 rejected', () => {
    compiles((b) => {
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'dot', damagePerTick: 5, cadenceTicks: 10, durationTicks: 100_000 },
      ];
    });
    rejects((b) => {
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'dot', damagePerTick: 5, cadenceTicks: 10, durationTicks: 100_001 },
      ];
    }, "tower 'basic' dot durationTicks 100001 exceeds 100000 at simVersion 9");
  });

  it("allowedDirectForms: 'single' accepted, 'aoe' also accepted — no reject case exists (see header comment)", () => {
    compiles(() => {});
    compiles((b) => {
      b.towerCatalog[0]!.effects = [{ kind: 'direct', form: 'aoe', damage: 10, radiusFp: 300 }];
    });
  });

  it("allowedTowerDomains: 'ground' accepted, 'both' rejected", () => {
    compiles(() => {});
    rejects(
      (b) => (b.towerCatalog[0]!.attack!.domain = 'both'),
      "tower attack domain 'both' unsupported at simVersion 9",
    );
  });

  it("allowedCreepDomains: 'ground' accepted, 'air' rejected", () => {
    compiles(() => {});
    rejects(
      (b) => (b.creepCatalog[0]!.domain = 'air'),
      "creep domain 'air' unsupported at simVersion 9",
    );
  });

  it("allowedImmunities: [] — no immunity accepted, 'slow' rejected", () => {
    compiles((b) => (b.creepCatalog[0]!.immunities = []));
    rejects(
      (b) => (b.creepCatalog[0]!.immunities = ['slow']),
      "creep immunity 'slow' unsupported at simVersion 9",
    );
  });

  it("allowedRoles: [] — no role accepted, 'boss' rejected", () => {
    compiles(() => {});
    rejects(
      (b) => (b.creepCatalog[0]!.role = 'boss'),
      "creep role 'boss' unsupported at simVersion 9",
    );
  });

  it('maxArmor: 0 accepted, at the ceiling (16) accepted, one past it (17) rejected', () => {
    compiles((b) => (b.creepCatalog[0]!.armor = 0));
    compiles((b) => (b.creepCatalog[0]!.armor = 16)); // exactly the ceiling — accepted
    rejects(
      (b) => (b.creepCatalog[0]!.armor = 17),
      "creep 'normal' armor 17 exceeds 16 at simVersion 9",
    );
  });

  it('requiredLeakCost: pins the VALUE (1), not merely uniformity', () => {
    compiles((b) => b.creepCatalog.push({ ...b.creepCatalog[0]!, id: 'other', leakCost: 1 }));
    rejects(
      (b) => b.creepCatalog.push({ ...b.creepCatalog[0]!, id: 'other', leakCost: 2 }),
      "creep 'other' leakCost 2 unsupported at simVersion 9 (must be 1)",
    );
    // Uniform-but-nonzero must ALSO reject — m2.md pins "leakCost = 1 until S10";
    // a whole catalog at 2 is still content this sim build cannot simulate.
    rejects(
      (b) => (b.creepCatalog[0]!.leakCost = 2),
      "creep 'normal' leakCost 2 unsupported at simVersion 9 (must be 1)",
    );
  });

  it('maxClearBonus defers to the schema ceiling — a nonzero clear bonus compiles', () => {
    compiles((b) => (b.boards[0]!.waves[0]!.clearBonus = 4));
  });

  it('maxEarlyCallBountyDivisor defers to the schema ceiling — a nonzero divisor compiles', () => {
    compiles((b) => (b.balance.earlyCallBountyDivisor = 50));
  });

  it('maxEarlyCallScoreDivisor defers to the schema ceiling — a nonzero divisor compiles', () => {
    compiles((b) => (b.scoring.earlyCallScoreDivisor = 50));
  });
});
