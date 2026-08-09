// capability.test.ts — the per-simVersion capability profile (M2-S1, widened at
// M2-S2 to sv6, M2-S3 to sv7, M2-S4a to sv8, M2-S5a to sv9, M2-S6 to sv10, M2-S7 to
// sv11, M2-S8 to sv12, M2-S9 to sv13): the simVersion-13 profile's exact shape, an
// unknown-simVersion throw, and — since the profile itself is inert data gated only
// inside `compileRuleset` — accept-at-boundary / reject-beyond-boundary coverage for
// every dimension still narrower than the schema, exercised through `compileRuleset`
// against `test-support`'s bundle. Every rejection pins the gate's own message,
// because this file's whole premise is per-dimension coverage — removing a capability
// check must turn a case RED, not shift it quietly to a different throw. Pinning the
// message is what tells those two apart. A `burst/single` bundle is the sharpest
// current example and the reason the discipline matters: it trips `allowedBurstForms`
// and NOTHING ELSE would catch it (ship-review traced the path — form-uniform sees one
// form, the aoe scan finds no aoe effect, and `maxBurstTravelTicks` passes), so that
// bundle would compile clean into a live untested mechanic if the gate were removed.
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
//
// `allowedTowerDomains`/`allowedCreepDomains` (M2-S7 P1) join this deferred-to-
// schema list too, but NOT deliberately the way `allowedImmunities` did: they widen
// to exactly `['ground','air','both']`/`['ground','air']`, the v2 schema's own
// `TowerTargetDomain`/`CreepDomain` enums, because the shipped catalog (`flying`/
// `antiair`/both-domain `slow`) already exhausts every legal value on both axes —
// there is no narrower ceiling a real bundle wouldn't immediately saturate. Same
// consequence as `allowedImmunities`, though: no schema-legal third value exists on
// either axis to test a reject against, so both domain tests below have no reject
// case of their own.
//
// `allowedEffectKinds` (M2-S9 P1) now joins this list too: it widens to all six
// kinds, exactly the v2 schema's own `EffectDef` enum, so no seventh legal value
// exists to test a reject against — the witness this axis carried through sv12 is
// retired here, and `allowedBurstForms` (genuinely narrower than the schema's
// `single | aoe`) carries the replacement.
//
// `allowedRoles` (M2-S10 P1) joins this list too: it widens to `['boss']`, exactly
// the v2 schema's own role enum (`CreepDef.role?: 'boss'`), so no second legal role
// value exists to test a reject against. `requiredLeakCost` is deleted at the same
// bump (a second lost witness — the "must be exactly 1" reject); `maxLeakCost`
// (genuinely narrower than the schema's own 1..1000) carries the replacement for
// both.

import { describe, it, expect } from 'vitest';
import type { Ruleset } from '@wynding/types';
import { capabilityProfile } from './capability';
import { MAX_IMPACT_EFFECTS, MAX_BLAST_RADIUS_FP, MAX_DOT_RECORDS } from './combat';
import { MAX_TOWERS } from './tower';
import { MAX_DOT_DURATION_CADENCE_RATIO } from './ruleset-shared';
import { compileRuleset, MAX_AIR_BOARD_SIDE_TILES, RulesetError } from './ruleset';
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

  it('simVersion 14 is the multi-life-leak profile, deferring wave/economy/catalog-size/immunity/domain/role axes to the schema', () => {
    expect(capabilityProfile(14)).toEqual({
      maxTowerCatalogSize: 64,
      maxWavesPerBoard: 64,
      maxEntriesPerWave: 16,
      maxOffsetTicks: 1_000_000,
      maxEffectsPerBundle: 8,
      allowedEffectKinds: ['direct', 'slow', 'dot', 'stun', 'support', 'burst'],
      allowedDirectForms: ['single', 'aoe'],
      allowedTowerDomains: ['ground', 'air', 'both'],
      allowedCreepDomains: ['ground', 'air'],
      allowedImmunities: ['slow', 'stun'],
      allowedRoles: ['boss'],
      maxArmor: 16,
      maxLeakCost: 16,
      maxClearBonus: 1_000_000,
      maxEarlyCallBountyDivisor: 1_000_000,
      maxEarlyCallScoreDivisor: 1_000_000,
      maxAoeRadiusFp: 2048,
      maxDotDurationTicks: 100_000,
      maxDotDurationCadenceRatio: 8,
      maxSupportDamageMulFp: 1024,
      allowedBurstForms: ['aoe'],
      maxBurstTravelTicks: 8,
    });
    // Every prior version is deleted with each bump (G11, capability.ts's header) —
    // sv13 misdescribes v14 tick code now (it could not compile a non-uniform-
    // leakCost catalog or a 'boss' creep), so it throws exactly like any other
    // unknown version.
    expect(() => capabilityProfile(13)).toThrow(RulesetError);
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

  it('allowedEffectKinds: all six kinds accepted — the axis now defers to the schema (M2-S9)', () => {
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
    // (M2-S6) stun joined the accepted set. (An earlier revision of this comment said
    // the profile still excluded 'burst' and 'support' — true when it was written,
    // false at sv13, where `allowedEffectKinds` carries all six.)
    compiles((b) => {
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'stun', chanceNum: 64, durationTicks: 30 },
      ];
    });
    // A support bundle is EXCLUSIVE (ruleset-schema.ts) and attackless — the whole
    // `attack` key must go, or the schema rejects before the capability gate is reached.
    compiles((b) => {
      delete b.towerCatalog[0]!.attack;
      b.towerCatalog[0]!.effects = [{ kind: 'support', damageMulFp: 384 }];
    });
    // (M2-S9) 'burst' joins too — a burst bundle carries `attack` (that is where its
    // TRIGGER range lives) but no `cadenceTicks`, and the schema rejects one that
    // carries it, so the fixture must drop the key to reach the capability gate at all.
    // With this case the test exercises all six kinds its title claims, rather than
    // five (ship-review, M2-S9: it briefly deferred this witness to `ruleset.test.ts`
    // on the grounds that a burst bundle "does not compile until the guard surgery
    // lands" — which stopped being true in the same change).
    compiles((b) => {
      delete b.towerCatalog[0]!.attack!.cadenceTicks;
      b.towerCatalog[0]!.effects = [{ kind: 'burst', form: 'aoe', damage: 45, radiusFp: 640 }];
    });
    // All six kinds the schema's `EffectDef` enum admits now pass this gate, so
    // `allowedEffectKinds` defers to the schema exactly like `allowedDirectForms`/
    // `allowedImmunities`/the domain axes: deleting the `allowedEffectKinds` gate
    // entirely would leave every case here green. The replacement witnesses live in the
    // `allowedBurstForms` and `maxBurstTravelTicks` tests below.
  });

  it("allowedBurstForms: 'single' rejected — the witness that replaces allowedEffectKinds' (M2-S9)", () => {
    // A profile ceiling with no enforcement site is dead code — before the M2-S9 split,
    // burst forms ran through `allowedDirectForms` (`['single','aoe']`), so this
    // bundle would have compiled into a live untested mechanic. The matching ACCEPTS
    // case (`burst/aoe`) is the last `compiles(...)` in the test above.
    rejects((b) => {
      // A burst effect requires `cadenceTicks` omitted (single-use) — schema
      // validation runs BEFORE the capability check, so the fixture must be
      // schema-valid on its own for the capability gate to be what fires.
      delete b.towerCatalog[0]!.attack!.cadenceTicks;
      b.towerCatalog[0]!.effects = [{ kind: 'burst', form: 'single', damage: 10 }];
    }, "burst effect form 'single' unsupported at simVersion 14");
  });

  it('maxBurstTravelTicks: exactly 8 accepted, 9 rejected (M2-S9)', () => {
    // The bound the burst axis REMOVES, restored at the profile layer. A cadenced
    // tower's `travelTicks` is bounded by the schema's `travelTicks < cadenceTicks`,
    // which is what makes `MAX_IN_FLIGHT_IMPACTS = MAX_TOWERS` sizing hold; a burst
    // bundle has no cadence, so that rule never runs and the schema's generic 1..1e6 is
    // all that is left. Worse, a CONSUMED mine frees its tower row while keeping its
    // discharge resident, so residency stops tracking live towers — a schema-legal
    // `travelTicks: 1_000_000` mine would drive the queue to the cap and turn every
    // tower's fire into a deterministic no-op. Found by ship-review, M2-S9.
    const burstBundle = (travelTicks: number) => (b: MutableRuleset) => {
      delete b.towerCatalog[0]!.attack!.cadenceTicks;
      b.towerCatalog[0]!.attack!.travelTicks = travelTicks;
      b.towerCatalog[0]!.effects = [{ kind: 'burst', form: 'aoe', damage: 45, radiusFp: 640 }];
    };
    compiles(burstBundle(8));
    rejects(burstBundle(9), "tower 'basic' burst travelTicks 9 exceeds 8 at simVersion 14");
    // Scoped to BURST bundles only: a cadenced tower may still travel further, bounded
    // by its own cadence exactly as before. Deleting the `e.kind === 'burst'` leg of the
    // enforcement site would turn this case red.
    compiles((b) => {
      b.towerCatalog[0]!.attack!.cadenceTicks = 30;
      b.towerCatalog[0]!.attack!.travelTicks = 9;
    });
  });

  it('maxSupportDamageMulFp: exactly 1024 accepted, 1025 rejected (M2-S8)', () => {
    // A profile ceiling with no enforcement site is dead code — the v2 schema admits
    // `damageMulFp` up to 1e6, so without `checkCapabilityGlobal`'s clause a ×3906
    // beacon would compile clean. Unlike the domain axes, this ceiling is genuinely
    // narrower than the schema's own wall, so it keeps a real reject witness.
    compiles((b) => {
      delete b.towerCatalog[0]!.attack;
      b.towerCatalog[0]!.effects = [{ kind: 'support', damageMulFp: 1024 }];
    });
    rejects((b) => {
      delete b.towerCatalog[0]!.attack;
      b.towerCatalog[0]!.effects = [{ kind: 'support', damageMulFp: 1025 }];
    }, "tower 'basic' support damageMulFp 1025 exceeds 1024 at simVersion 14");
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
    }, "tower 'basic' dot durationTicks 100001 exceeds 100000 at simVersion 14");
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
    }, "tower 'basic' dot durationTicks 241 exceeds 240 (8× its 30-tick attack cadence) at simVersion 14");
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
    }, "tower 'basic' combines an aoe direct effect with a dot effect, unsupported at simVersion 14");
  });

  it("allowedDirectForms: 'single' accepted, 'aoe' also accepted — no reject case exists (see header comment)", () => {
    compiles(() => {});
    compiles((b) => {
      b.towerCatalog[0]!.effects = [{ kind: 'direct', form: 'aoe', damage: 10, radiusFp: 300 }];
    });
  });

  it("allowedTowerDomains: 'ground' accepted, 'air' also accepted, 'both' also accepted — no reject case exists (see header comment)", () => {
    compiles(() => {});
    compiles((b) => (b.towerCatalog[0]!.attack!.domain = 'air'));
    compiles((b) => (b.towerCatalog[0]!.attack!.domain = 'both'));
  });

  it("allowedCreepDomains: 'ground' accepted, 'air' also accepted — no reject case exists (see header comment)", () => {
    compiles(() => {});
    compiles((b) => (b.creepCatalog[0]!.domain = 'air'));
  });

  it("allowedImmunities: [] accepted, 'slow' also accepted, 'stun' also accepted — no reject case exists (see header comment)", () => {
    compiles((b) => (b.creepCatalog[0]!.immunities = []));
    compiles((b) => (b.creepCatalog[0]!.immunities = ['slow']));
    compiles((b) => (b.creepCatalog[0]!.immunities = ['stun']));
    compiles((b) => (b.creepCatalog[0]!.immunities = ['slow', 'stun']));
  });

  it("allowedRoles: no role accepted, 'boss' also accepted — no reject case exists (M2-S10: allowedRoles widens to ['boss'], exactly the v2 schema's own role enum; see header comment)", () => {
    compiles(() => {});
    compiles((b) => (b.creepCatalog[0]!.role = 'boss'));
  });

  it('maxArmor: 0 accepted, at the ceiling (16) accepted, one past it (17) rejected', () => {
    compiles((b) => (b.creepCatalog[0]!.armor = 0));
    compiles((b) => (b.creepCatalog[0]!.armor = 16)); // exactly the ceiling — accepted
    rejects(
      (b) => (b.creepCatalog[0]!.armor = 17),
      "creep 'normal' armor 17 exceeds 16 at simVersion 14",
    );
  });

  it('maxLeakCost: a mixed-cost catalog compiles, at the ceiling (16) accepted, one past it (17) rejected (M2-S10)', () => {
    // A profile ceiling with no enforcement site is dead code — sv13's
    // `requiredLeakCost` pinned every creep to exactly 1; sv14 lifts that to a
    // per-creep ceiling, so a NON-uniform catalog within it is the new accept case.
    compiles((b) => b.creepCatalog.push({ ...b.creepCatalog[0]!, id: 'other', leakCost: 2 }));
    compiles((b) => (b.creepCatalog[0]!.leakCost = 16)); // exactly the ceiling — accepted
    rejects(
      (b) => (b.creepCatalog[0]!.leakCost = 17),
      "creep 'normal' leakCost 17 exceeds 16 at simVersion 14",
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

// The two board gates (M2-S7 P1) are DELIBERATELY DIFFERENT SCOPES: axis-alignment
// fires only when THIS board's own wave schedule flies an air creep (it protects
// measurement fidelity, which only genuinely scheduled flight can reach); the size
// ceiling fires whenever the CATALOG contains an air creep at all, scheduled or not
// (it protects safe-integer arithmetic against a forged/restored air row a schedule
// never mentions). A single rejection test cannot prove that difference — a
// regression making axis-alignment catalog-global, or the size ceiling
// schedule-only, would still pass one. This four-cell matrix is the witness.
describe('board gates — air-domain size ceiling vs. axis-alignment, deliberately different scopes (M2-S7 P1)', () => {
  const AIR_CREEP = {
    id: 'flyer',
    hp: 10,
    speedFp: 30,
    armor: 0,
    domain: 'air' as const,
    immunities: [],
    leakCost: 1,
    bounty: 1,
  };

  // Different col AND different row at entrance vs. exit — non-axis-aligned on both
  // legs, so neither the equal-col nor the equal-row side of the gate can
  // accidentally pass it. Both openings sit off the corners (a corner opening's
  // only interior neighbour is a diagonal past two blocked orthogonal cells, which
  // `buildGrid`'s no-corner-cutting rule makes unreachable — an unrelated
  // playability failure this test isn't exercising).
  const NON_AXIS = {
    widthTiles: 9,
    heightTiles: 9,
    entrance: { col: 3, row: 0 },
    exit: { col: 8, row: 6 },
  } as const;

  // One side one past MAX_AIR_BOARD_SIDE_TILES (1024) — a genuinely playable board
  // (unlike the 1,048,576 × 1 shape MAX_AIR_BOARD_SIDE_TILES's own doc comment
  // cites for the arithmetic argument alone: at heightTiles 1 or 2 EVERY cell sits
  // on the border ring, per `buildGrid`, leaving no interior and no reachable path
  // at this width). `heightTiles: 5` keeps total cell count small enough that the
  // UNRELATED baseline-tick-budget gate (`ruleset.ts`'s own worst-case traversal
  // estimate, which scales with total cells, not width alone) doesn't ALSO reject
  // it — `creepSpeedFp` is raised well past the default for the same reason, so
  // this board's rejection (or acceptance) below isolates the size gate under
  // test, not an unrelated tick-budget rejection. Entrance/exit stay axis-aligned
  // (row 2 either way, off the border rows) so this row isolates the size gate
  // from the axis-alignment gate beside it.
  const OVERSIZED = {
    widthTiles: 1025,
    heightTiles: 5,
    entrance: { col: 0, row: 2 },
    exit: { col: 1024, row: 2 },
  } as const;

  function bundleWithSpec(
    spec: { widthTiles: number; heightTiles: number; entrance: unknown; exit: unknown },
    opts: { withAirCreep: boolean; flies: boolean; creepSpeedFp?: number },
  ): MutableRuleset {
    const b = JSON.parse(
      JSON.stringify(testBundle(spec as never, { creepSpeedFp: opts.creepSpeedFp })),
    ) as MutableRuleset;
    if (opts.withAirCreep) {
      b.creepCatalog.push(AIR_CREEP);
    }
    if (opts.flies) {
      b.boards[0]!.waves[0]!.entries[0]!.creepId = 'flyer';
    }
    return b;
  }

  it('catalog has air, board schedule flies, non-axis-aligned geometry — rejected', () => {
    const b = bundleWithSpec(NON_AXIS, { withAirCreep: true, flies: true });
    expect(() => compileRuleset(b as Ruleset, 'test')).toThrow(RulesetError);
    expect(() => compileRuleset(b as Ruleset, 'test')).toThrow('is not axis-aligned');
  });

  it('catalog has air, board schedule does NOT fly, non-axis-aligned geometry — accepted', () => {
    const b = bundleWithSpec(NON_AXIS, { withAirCreep: true, flies: false });
    expect(() => compileRuleset(b as Ruleset, 'test')).not.toThrow();
  });

  it('catalog has air, board schedule does NOT fly, oversized side — rejected', () => {
    const b = bundleWithSpec(OVERSIZED, { withAirCreep: true, flies: false, creepSpeedFp: 1000 });
    expect(() => compileRuleset(b as Ruleset, 'test')).toThrow(RulesetError);
    expect(() => compileRuleset(b as Ruleset, 'test')).toThrow(
      `widthTiles ${MAX_AIR_BOARD_SIDE_TILES + 1} exceeds ${MAX_AIR_BOARD_SIDE_TILES} at simVersion 14 (the catalog contains an air creep)`,
    );
  });

  // The matrix above only ever oversizes WIDTH, so the gate's `heightTiles` branch had
  // no witness (ship-review, M2-S7) — deleting it, or mistyping it as a second width
  // check, would have left every test green. Both sides are bounded for the same
  // safe-integer reason, so both need a witness.
  it('catalog has air, OVERSIZED HEIGHT — rejected by the heightTiles branch', () => {
    const OVERSIZED_TALL = {
      widthTiles: 5,
      heightTiles: 1025,
      entrance: { col: 2, row: 0 },
      exit: { col: 2, row: 1024 },
    } as const;
    const b = bundleWithSpec(OVERSIZED_TALL, {
      withAirCreep: true,
      flies: false,
      creepSpeedFp: 1000,
    });
    expect(() => compileRuleset(b as Ruleset, 'test')).toThrow(RulesetError);
    expect(() => compileRuleset(b as Ruleset, 'test')).toThrow(
      `heightTiles ${MAX_AIR_BOARD_SIDE_TILES + 1} exceeds ${MAX_AIR_BOARD_SIDE_TILES} at simVersion 14 (the catalog contains an air creep)`,
    );
  });

  it('catalog has NO air, oversized side — accepted (existing gates only)', () => {
    const b = bundleWithSpec(OVERSIZED, {
      withAirCreep: false,
      flies: false,
      creepSpeedFp: 1000,
    });
    expect(() => compileRuleset(b as Ruleset, 'test')).not.toThrow();
  });
});
