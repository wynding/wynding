// capability.test.ts — the per-simVersion capability profile (M2-S1, widened at
// M2-S2 to sv6, M2-S3 to sv7, M2-S4a to sv8, M2-S5a to sv9, M2-S6 to sv10): the
// simVersion-10 profile's exact shape, an unknown-simVersion throw, and — since the
// profile itself is inert data gated only inside `compileRuleset` — accept-at-
// boundary / reject-beyond-boundary coverage for every dimension still narrower
// than the schema, exercised through `compileRuleset` against `test-support`'s
// bundle. Every rejection pins the gate's own message: several mutations are
// rejectable by more than one path (a 'burst' effect trips `allowedEffectKinds` AND
// the later direct/single-effect requirement would trip too, were
// `allowedEffectKinds` not there first), and this file's whole premise is
// per-dimension coverage — removing a capability check must turn a case red, not
// shift it to a different throw.
//
// sv10 DEFERS TO THE SCHEMA on waves/entries/offsets/clearBonus/both early-call
// divisors (unchanged from sv6) AND ALSO on `maxTowerCatalogSize`/
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
//
// `allowedImmunities` (M2-S6 P4) joins this deferred-to-schema list too: it widens
// to `['slow','stun']`, exactly the v2 schema's own immunity enum, so there is no
// schema-legal third immunity value that could reach `allowedImmunities` and be
// rejected BY IT — deliberately, per `capability.ts`'s sv10 doc comment (an immune
// target consuming no draw needs a compilable stun-immune creep to test against).

import { describe, it, expect } from 'vitest';
import type { Ruleset } from '@wynding/types';
import { capabilityProfile } from './capability';
import { MAX_IMPACT_EFFECTS, MAX_BLAST_RADIUS_FP, MAX_DOT_RECORDS } from './combat';
import { MAX_TOWERS } from './tower';
import { MAX_DOT_DURATION_CADENCE_RATIO } from './ruleset-shared';
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

  it('simVersion 10 is the stun-and-immunity profile, deferring wave/economy/catalog-size/immunity axes to the schema', () => {
    expect(capabilityProfile(10)).toEqual({
      maxTowerCatalogSize: 64,
      maxWavesPerBoard: 64,
      maxEntriesPerWave: 16,
      maxOffsetTicks: 1_000_000,
      maxEffectsPerBundle: 8,
      allowedEffectKinds: ['direct', 'slow', 'dot', 'stun'],
      allowedDirectForms: ['single', 'aoe'],
      allowedTowerDomains: ['ground'],
      allowedCreepDomains: ['ground'],
      allowedImmunities: ['slow', 'stun'],
      allowedRoles: [],
      maxArmor: 16,
      requiredLeakCost: 1,
      maxClearBonus: 1_000_000,
      maxEarlyCallBountyDivisor: 1_000_000,
      maxEarlyCallScoreDivisor: 1_000_000,
      maxAoeRadiusFp: 2048,
      maxDotDurationTicks: 100_000,
      maxDotDurationCadenceRatio: 8,
    });
    // Every prior version is deleted with each bump (G11, capability.ts's header) —
    // sv9 misdescribes v10 tick code now, so it throws exactly like any other
    // unknown version.
    expect(() => capabilityProfile(9)).toThrow(RulesetError);
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

  it("allowedEffectKinds: 'direct'+'slow'+'dot'+'stun' accepted, 'burst' rejected", () => {
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
    // (M2-S6) stun joins the accepted set — the schema still carries 'burst' and
    // 'support' kinds this profile does not, so the reject case moves to 'burst'
    // rather than disappearing.
    compiles((b) => {
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'stun', chanceNum: 64, durationTicks: 30 },
      ];
    });
    rejects((b) => {
      // A burst effect requires `cadenceTicks` omitted (single-use) — schema
      // validation runs BEFORE the capability check, so the fixture must be
      // schema-valid on its own for the capability gate to be what fires.
      delete b.towerCatalog[0]!.attack!.cadenceTicks;
      b.towerCatalog[0]!.effects = [{ kind: 'burst', form: 'single', damage: 10 }];
    }, "effect kind 'burst' unsupported at simVersion 10");
  });

  it('maxDotDurationTicks: exactly 100,000 accepted, 100,001 rejected', () => {
    compiles((b) => {
      // Fire cadence 20,000 so the duration:cadence RATIO gate (8x -> 160,000) sits
      // clear of the ABSOLUTE ceiling this test isolates. At 12,500 the two coincide
      // exactly at 100,000 and the ratio message fires instead.
      b.towerCatalog[0]!.attack!.cadenceTicks = 20_000;
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'dot', damagePerTick: 5, cadenceTicks: 10, durationTicks: 100_000 },
      ];
    });
    rejects((b) => {
      b.towerCatalog[0]!.attack!.cadenceTicks = 20_000;
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'dot', damagePerTick: 5, cadenceTicks: 10, durationTicks: 100_001 },
      ];
    }, "tower 'basic' dot durationTicks 100001 exceeds 100000 at simVersion 10");
  });

  it('MAX_DOT_RECORDS budgets (ratio + 1) per source, so compiled content can reach the rail but never exceed it', () => {
    // The property both reviewers found missing (Codex P2 + CodeRabbit, PR #78): the gate
    // admitted 8 records per source while the rail budgeted 4, so schema-valid content
    // could silently lose applications. A source's PEAK is `ratio + 1`, not `ratio`:
    // impacts resolve in step (1) while expiry runs in step (6), so the shot landing on
    // the tick a record expires still sees it — and that is when capacity is tested.
    expect(capabilityProfile(SIM_VERSION).maxDotDurationCadenceRatio).toBe(
      MAX_DOT_DURATION_CADENCE_RATIO,
    );
    // `+ 1`: impacts resolve in step (1) but expiry runs in step (6), so on the tick a
    // source's oldest record expires, the newly-landing shot still sees it — the peak is
    // `ratio + 1` for that one tick, and that is when capacity is tested (Codex P2).
    expect(MAX_DOT_RECORDS).toBe((MAX_DOT_DURATION_CADENCE_RATIO + 1) * MAX_TOWERS);
  });

  it('maxDotDurationCadenceRatio: a DoT may last 8x its tower fire cadence, not 9x (Codex P2, PR #78)', () => {
    // The absolute ceiling above bounds the NUMBER; this bounds the RATIO, which is what
    // actually sets how many live records one source can hold (~duration / fire cadence
    // shots land inside a duration window, each able to seed a different creep). Without
    // it, 100,000 ticks against a 2-tick cadence admits ~50,000 records from ONE tower —
    // an order of magnitude past MAX_DOT_RECORDS, on a bundle that compiles clean.
    compiles((b) => {
      b.towerCatalog[0]!.attack!.cadenceTicks = 30;
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'dot', damagePerTick: 5, cadenceTicks: 10, durationTicks: 240 }, // 8 x 30
      ];
    });
    rejects((b) => {
      b.towerCatalog[0]!.attack!.cadenceTicks = 30;
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'dot', damagePerTick: 5, cadenceTicks: 10, durationTicks: 241 },
      ];
    }, "tower 'basic' dot durationTicks 241 exceeds 240 (8× its 30-tick attack cadence) at simVersion 10");
  });

  // M2-S5a P8 (CodeRabbit, PR #78) — not a `capabilityProfile` field (the profile has
  // no data dimension for this), but a hardcoded compile-time gate in `compileRuleset`
  // living right beside the `maxDotDurationTicks` check above: `MAX_DOT_RECORDS` was
  // sized on the single-target application model (one shot lands on one creep), and a
  // blast applying a DoT to every member it catches can blow that table out at a
  // bundle that would otherwise compile clean. Recorded here, next to the sibling
  // dot-duration gate, rather than in ruleset.test.ts's structural-rejection block,
  // since this file's `rejects` helper is what pins the gate's own message text.
  it('rejects a tower combining an aoe direct effect with a dot effect, naming both in the message; a dot on a single-target tower still compiles', () => {
    compiles((b) => {
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'dot', damagePerTick: 5, cadenceTicks: 10, durationTicks: 60 },
      ];
    });
    rejects((b) => {
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'aoe', damage: 8, radiusFp: 300 },
        { kind: 'dot', damagePerTick: 5, cadenceTicks: 10, durationTicks: 60 },
      ];
    }, "tower 'basic' combines an aoe direct effect with a dot effect, unsupported at simVersion 10");
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
      "tower attack domain 'both' unsupported at simVersion 10",
    );
  });

  it("allowedCreepDomains: 'ground' accepted, 'air' rejected", () => {
    compiles(() => {});
    rejects(
      (b) => (b.creepCatalog[0]!.domain = 'air'),
      "creep domain 'air' unsupported at simVersion 10",
    );
  });

  it("allowedImmunities: [] accepted, 'slow' also accepted, 'stun' also accepted — no reject case exists (see header comment)", () => {
    compiles((b) => (b.creepCatalog[0]!.immunities = []));
    compiles((b) => (b.creepCatalog[0]!.immunities = ['slow']));
    compiles((b) => (b.creepCatalog[0]!.immunities = ['stun']));
    compiles((b) => (b.creepCatalog[0]!.immunities = ['slow', 'stun']));
  });

  it("allowedRoles: [] — no role accepted, 'boss' rejected", () => {
    compiles(() => {});
    rejects(
      (b) => (b.creepCatalog[0]!.role = 'boss'),
      "creep role 'boss' unsupported at simVersion 10",
    );
  });

  it('maxArmor: 0 accepted, at the ceiling (16) accepted, one past it (17) rejected', () => {
    compiles((b) => (b.creepCatalog[0]!.armor = 0));
    compiles((b) => (b.creepCatalog[0]!.armor = 16)); // exactly the ceiling — accepted
    rejects(
      (b) => (b.creepCatalog[0]!.armor = 17),
      "creep 'normal' armor 17 exceeds 16 at simVersion 10",
    );
  });

  it('requiredLeakCost: pins the VALUE (1), not merely uniformity', () => {
    compiles((b) => b.creepCatalog.push({ ...b.creepCatalog[0]!, id: 'other', leakCost: 1 }));
    rejects(
      (b) => b.creepCatalog.push({ ...b.creepCatalog[0]!, id: 'other', leakCost: 2 }),
      "creep 'other' leakCost 2 unsupported at simVersion 10 (must be 1)",
    );
    // Uniform-but-nonzero must ALSO reject — m2.md pins "leakCost = 1 until S10";
    // a whole catalog at 2 is still content this sim build cannot simulate.
    rejects(
      (b) => (b.creepCatalog[0]!.leakCost = 2),
      "creep 'normal' leakCost 2 unsupported at simVersion 10 (must be 1)",
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
