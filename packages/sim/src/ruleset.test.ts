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
import { testBundle, TEST_BURST_TOWER } from './test-support';

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

  it('accepts a nonzero earlyCallBountyDivisor — sv6 defers this axis to the schema ceiling', () => {
    const compiled = compileRuleset(
      { ...base(), balance: { ...base().balance, earlyCallBountyDivisor: 1 } } as Ruleset,
      'test',
    );
    expect(compiled.balance.earlyCallBountyDivisor).toBe(1);
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

  it('accepts a nonzero earlyCallScoreDivisor — sv6 defers this axis to the schema ceiling', () => {
    const compiled = compileRuleset(
      { ...base(), scoring: { ...base().scoring, earlyCallScoreDivisor: 1 } } as Ruleset,
      'test',
    );
    expect(compiled.scoring.earlyCallScoreDivisor).toBe(1);
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

  it("compiles an 'air' creep domain — no reject case exists (M2-S7: allowedCreepDomains widens to ['ground','air'], exactly the v2 schema's own CreepDomain enum; see capability.test.ts's header comment)", () => {
    const b = base();
    b.creepCatalog[0]!.domain = 'air';
    expect(() => compileRuleset(b as Ruleset, 'test')).not.toThrow();
  });

  it('rejects armor past the capability ceiling — capability-gated (M2-S5a widened maxArmor 0 → 16)', () => {
    rejects((b) => (b.creepCatalog[0]!.armor = 17)); // one past the live profile's maxArmor ceiling
    // `immunities` is no longer a reject case here (M2-S6 P4): `allowedImmunities`
    // widens to `['slow','stun']`, exactly the v2 schema's own enum — see
    // capability.test.ts's `allowedImmunities` case and header comment.
  });

  it("compiles a 'boss' role — no reject case exists (M2-S10: allowedRoles widens to ['boss'], exactly the v2 schema's own role enum; see capability.test.ts's header comment)", () => {
    const b = base();
    b.creepCatalog[0]!.role = 'boss';
    expect(() => compileRuleset(b as Ruleset, 'test')).not.toThrow();
  });

  it('compiles a mixed-cost catalog within the maxLeakCost ceiling (capability: maxLeakCost, M2-S10)', () => {
    const b = base();
    b.creepCatalog.push({ ...b.creepCatalog[0]!, id: 'other', leakCost: 2 });
    expect(() => compileRuleset(b as Ruleset, 'test')).not.toThrow();
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

  it('rejects a burst effect form unsupported at simVersion 15 (valid schema, capability-gated: allowedBurstForms)', () => {
    // Before M2-S9, 'burst' wasn't in `allowedEffectKinds` at all, so ANY burst
    // bundle tripped that gate first. Since sv13 'burst' joins `allowedEffectKinds`
    // (capability.ts's header comment — it now defers to the schema, exactly the
    // v2 schema's own `EffectDef` enum), so the rejection witness moves to the
    // narrower `allowedBurstForms: ['aoe']` ceiling. This mirrors
    // capability.test.ts's own exhaustive boundary coverage of that gate — kept
    // here too as an integration witness that the schema-wall-then-capability-wall
    // wiring this file's header describes is actually live for the burst kind.
    const b = base();
    // A burst effect requires `cadenceTicks` omitted (single-use) — schema
    // validation runs BEFORE the capability check, so the fixture must be
    // schema-valid on its own for the capability gate to be what fires.
    delete b.towerCatalog[0]!.attack!.cadenceTicks;
    // No cast needed: `burst/single` is a legal `EffectDef` in the v2 schema — that is
    // precisely why the profile's own `allowedBurstForms` ceiling has to reject it.
    b.towerCatalog[0]!.effects = [{ kind: 'burst', form: 'single', damage: 10 }];
    expect(() => compileRuleset(b as Ruleset, 'test')).toThrow(
      "burst effect form 'single' unsupported at simVersion 15",
    );
  });

  it('compiles an aoe direct effect (capability: allowedDirectForms widens to include aoe at sv8)', () => {
    const b = base();
    b.towerCatalog[0]!.effects = [{ kind: 'direct', form: 'aoe', damage: 10, radiusFp: 300 }];
    const compiled = compileRuleset(b as Ruleset, 'test');
    expect(compiled.towerById['basic']!.effects).toEqual([
      { kind: 'aoe', amount: 10, radiusFp: 300 },
    ]);
  });

  it('compiles a dot direct effect (capability: allowedEffectKinds widens to include dot at sv9)', () => {
    const b = base();
    b.towerCatalog[0]!.effects = [
      { kind: 'direct', form: 'single', damage: 10 },
      { kind: 'dot', damagePerTick: 5, cadenceTicks: 10, durationTicks: 60 },
    ];
    const compiled = compileRuleset(b as Ruleset, 'test');
    expect(compiled.towerById['basic']!.effects).toEqual([
      { kind: 'direct', amount: 10 },
      { kind: 'dot', amount: 5, cadenceTicks: 10, durationTicks: 60 },
    ]);
  });

  it('rejects a dot durationTicks past the capability ceiling (M2-S5a maxDotDurationTicks: exactly 100,000 accepted, 100,001 rejected)', () => {
    // Fire cadence 20,000 so the duration:cadence RATIO gate (8x -> 160,000, Codex P2 on
    // PR #78) sits clear of the ABSOLUTE ceiling this test isolates.
    const b = base();
    b.towerCatalog[0]!.attack!.cadenceTicks = 20_000;
    b.towerCatalog[0]!.effects = [
      { kind: 'direct', form: 'single', damage: 10 },
      { kind: 'dot', damagePerTick: 5, cadenceTicks: 10, durationTicks: 100_000 },
    ];
    expect(() => compileRuleset(b as Ruleset, 'test')).not.toThrow();
    rejects((b) => {
      b.towerCatalog[0]!.attack!.cadenceTicks = 20_000;
      b.towerCatalog[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 10 },
        { kind: 'dot', damagePerTick: 5, cadenceTicks: 10, durationTicks: 100_001 },
      ];
    });
  });

  it('compiles a multi-tower catalog (capability: maxTowerCatalogSize widens to 64 at sv8) — every entry compiled independently', () => {
    const b = base();
    b.towerCatalog.push({
      id: 'rapid',
      cost: 5,
      attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
      effects: [{ kind: 'direct', form: 'single', damage: 10 }],
    });
    const compiled = compileRuleset(b as Ruleset, 'test');
    expect(compiled.towers).toHaveLength(2);
    expect(compiled.towerById['rapid']!.cost).toBe(5);
    expect(compiled.towerById['basic']!.cost).toBe(5);
  });

  it("compiles a 'both' tower attack domain — no reject case exists (M2-S7: allowedTowerDomains widens to ['ground','air','both'], exactly the v2 schema's own TowerTargetDomain enum; see capability.test.ts's header comment)", () => {
    const b = base();
    b.towerCatalog[0]!.attack!.domain = 'both';
    expect(() => compileRuleset(b as Ruleset, 'test')).not.toThrow();
  });

  it('rejects a tower mixing single and aoe direct forms (form-uniform, M2-S4a)', () => {
    rejects(
      (b) =>
        (b.towerCatalog[0]!.effects = [
          { kind: 'direct', form: 'single', damage: 10 },
          { kind: 'direct', form: 'aoe', damage: 8, radiusFp: 300 },
        ]),
    );
  });

  it('rejects a tower whose two aoe effects carry different radii (radius-uniform, M2-S4a)', () => {
    rejects(
      (b) =>
        (b.towerCatalog[0]!.effects = [
          { kind: 'direct', form: 'aoe', damage: 8, radiusFp: 300 },
          { kind: 'direct', form: 'aoe', damage: 4, radiusFp: 400 },
        ]),
    );
  });

  it('rejects an aoe radiusFp over the capability profile’s maxAoeRadiusFp (2048)', () => {
    rejects(
      (b) =>
        (b.towerCatalog[0]!.effects = [{ kind: 'direct', form: 'aoe', damage: 8, radiusFp: 2049 }]),
    );
  });

  // QC round-1 #13: only the reject half (2049) of this boundary was pinned — admits
  // the accept half too, matching AOE_SCAN_CEILING's own accept-at-boundary/reject-
  // beyond-boundary convention (story-aoe.test.ts's "admits exactly the pinned
  // boundary" pair).
  it('admits an aoe radiusFp exactly AT the capability profile’s maxAoeRadiusFp (2048)', () => {
    const b = base();
    b.towerCatalog[0]!.effects = [{ kind: 'direct', form: 'aoe', damage: 8, radiusFp: 2048 }];
    expect(() => compileRuleset(b as Ruleset, 'test')).not.toThrow();
  });
});

describe('compileRuleset — burst (M2-S9 P2: the guard surgery + the two widened blind gates)', () => {
  it('compiles a burst/aoe-only bundle: attack.mode is "burst" with no cadenceTicks key, and the effect collapses to the compiled "aoe" kind', () => {
    const compiled = compileRuleset(testBundle(OPEN, { towers: [TEST_BURST_TOWER] }), 'test');
    const mine = compiled.towerById['mine']!;
    expect(mine.attack).toEqual({ mode: 'burst', domain: 'ground', rangeFp: 576, travelTicks: 1 });
    expect('cadenceTicks' in mine.attack!).toBe(false);
    expect(mine.effects).toEqual([{ kind: 'aoe', amount: 45, radiusFp: 640 }]);
  });

  it('a cadenced tower still compiles with attack.mode "cadenced" and its cadenceTicks intact — the negative control for the union', () => {
    const compiled = compileRuleset(base() as Ruleset, 'test');
    expect(compiled.towerById['basic']!.attack).toEqual({
      mode: 'cadenced',
      domain: 'ground',
      rangeFp: 1024,
      cadenceTicks: 30,
      travelTicks: 4,
    });
  });

  it('burst/aoe + slow compiles — a recorded decision, not a discovery', () => {
    // Nothing in the widened form-uniform/radius-uniform gates rejects this: `slow`
    // carries no form/radius of its own, `snapshotEffects` and the blast's status
    // pass handle a `slow` member totally, and this is the IDENTICAL posture
    // `direct/aoe + slow` already has at sv12 (which `frost-splash` makes shipped
    // content at S10). The doctrine is this file's own: reject or record, never
    // leave silent.
    const b = testBundle(OPEN, {
      towers: [
        {
          ...TEST_BURST_TOWER,
          effects: [
            { kind: 'burst', form: 'aoe', damage: 45, radiusFp: 640 },
            { kind: 'slow', mulFp: 128, durationTicks: 40 },
          ],
        },
      ],
    });
    expect(() => compileRuleset(b, 'test')).not.toThrow();
  });

  it('radius-matched direct/aoe + burst/aoe compiles, and the whole tower takes BURST discipline — a recorded decision, not a discovery', () => {
    // Both effects are `aoe` and share one radius, so form-uniform and radius-uniform
    // both pass, and there is no dot, so the burst+dot gate passes too. Nothing rejects
    // it — which means the compiler makes a semantic CHOICE here, and an unpinned choice
    // is exactly what this file's own doctrine calls a silent one: `burstEffect !==
    // undefined` selects `mode: 'burst'` unconditionally, so the `direct` payload rides
    // the burst tower's single-discharge-then-consume discipline rather than a cadence.
    //
    // Allowed and PINNED rather than rejected (ship-review, CodeRabbit on PR #90): it is
    // the same posture `direct/aoe + slow` already has at sv12, both amounts land on the
    // one blast the tower ever fires, and nothing about the composition is unsafe — it is
    // simply a shape no shipped content uses. If a later story wants it rejected instead,
    // this test is the thing that has to change, which is the point of writing it down.
    const b = testBundle(OPEN, {
      towers: [
        {
          ...TEST_BURST_TOWER,
          effects: [
            { kind: 'direct', form: 'aoe', damage: 8, radiusFp: 640 },
            { kind: 'burst', form: 'aoe', damage: 45, radiusFp: 640 },
          ],
        },
      ],
    });
    const compiled = compileRuleset(b, 'test');
    const mine = compiled.towerById['mine']!;
    // BURST discipline for the whole tower — no `cadenceTicks` key at all.
    expect(mine.attack).toEqual({ mode: 'burst', domain: 'ground', rangeFp: 576, travelTicks: 1 });
    // Both payloads survive, in authored order, on the one blast it ever fires.
    expect(mine.effects).toEqual([
      { kind: 'aoe', amount: 8, radiusFp: 640 },
      { kind: 'aoe', amount: 45, radiusFp: 640 },
    ]);
  });

  it("rejects direct/single + burst/aoe on one tower — blind gate #1's witness (form-uniform)", () => {
    // Before the S9 widening this bundle compiled clean: `directForms` only ever
    // looked at `kind === 'direct'`, so `directForms.size === 1` (just 'single') —
    // then `blastRadiusOf` found the `burst/aoe` effect and built a blast, silently
    // applying the `single` effect's damage to every creep in the radius.
    const b = testBundle(OPEN, {
      towers: [
        {
          ...TEST_BURST_TOWER,
          effects: [
            { kind: 'direct', form: 'single', damage: 10 },
            { kind: 'burst', form: 'aoe', damage: 45, radiusFp: 640 },
          ],
        },
      ],
    });
    expect(() => compileRuleset(b, 'test')).toThrow('form-uniform');
  });

  it("rejects a burst/aoe radiusFp past maxAoeRadiusFp — blind gate #2's witness", () => {
    // Before the S9 widening a burst radius was never checked against the profile
    // ceiling at all — `aoeEffects` only ever looked at `direct/aoe`.
    const b = testBundle(OPEN, {
      towers: [
        {
          ...TEST_BURST_TOWER,
          effects: [{ kind: 'burst', form: 'aoe', damage: 45, radiusFp: 2049 }],
        },
      ],
    });
    expect(() => compileRuleset(b, 'test')).toThrow('exceeds 2048');
  });

  it('rejects direct/aoe (radius 300) + burst/aoe (radius 301) on one tower — radius-uniform now spans both kinds', () => {
    const b = testBundle(OPEN, {
      towers: [
        {
          ...TEST_BURST_TOWER,
          effects: [
            { kind: 'direct', form: 'aoe', damage: 8, radiusFp: 300 },
            { kind: 'burst', form: 'aoe', damage: 45, radiusFp: 301 },
          ],
        },
      ],
    });
    expect(() => compileRuleset(b, 'test')).toThrow('radii');
  });

  it('rejects burst/aoe + dot — the deliberate rejection, replacing the old accidental one', () => {
    // Previously this rejected too, but ACCIDENTALLY: `cadenceTicks ?? 0` made the
    // ratio ceiling 0 and the message named "its 0-tick attack cadence" — a false
    // sentence, since a burst tower's cadence isn't 0, it doesn't have one.
    const b = testBundle(OPEN, {
      towers: [
        {
          ...TEST_BURST_TOWER,
          effects: [
            { kind: 'burst', form: 'aoe', damage: 45, radiusFp: 640 },
            { kind: 'dot', damagePerTick: 2, cadenceTicks: 10, durationTicks: 60 },
          ],
        },
      ],
    });
    expect(() => compileRuleset(b, 'test')).toThrow('combines a burst effect with a dot effect');
  });
});

describe('compileRuleset — wave domains', () => {
  it('rejects a wave that exceeds the scheduled-spawn cap', () => {
    rejects((b) => (b.boards[0]!.waves[0]!.entries[0]!.count = 10_001));
  });

  it('rejects a baseline run that cannot terminate within the tick budget', () => {
    rejects((b) => (b.boards[0]!.waves[0]!.countdownTicks = 40_000)); // launch alone > the 36k ceiling
  });

  // A second wave, a second entry, a nonzero clearBonus, and a nonzero entry
  // offsetTicks are all sv6-LEGAL now (capability defers to the schema on these
  // axes — capability.test.ts's boundary coverage) — moved to the success
  // describe block below rather than pinned here as rejections.

  it('rejects a wave whose index skips past the tick budget when SUMMED across waves', () => {
    // Bound-gate regression (step 4): each individual wave stays under the 36k
    // ceiling on its own, but the SUM across all waves must still fit — a
    // per-wave-only check would wrongly accept this.
    rejects((b) => {
      const w0 = b.boards[0]!.waves[0]!;
      b.boards[0]!.waves = [
        { ...w0, index: 0, countdownTicks: 20_000 },
        { ...w0, index: 1, countdownTicks: 20_000 },
      ];
    });
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
  it('compiles a valid bundle into a branded ruleset with a per-wave spawn schedule', () => {
    const compiled = compileRuleset(testBundle(OPEN, { waveCount: 4, waveSpacing: 5 }), 'test');
    expect(compiled.waves).toHaveLength(1);
    expect(compiled.waves[0]!.spawns).toHaveLength(4);
    expect(compiled.waves[0]!.spawns.map((s) => s.offsetTicks)).toEqual([0, 5, 10, 15]);
    expect(compiled.waves[0]!.entriesSummary).toEqual([{ creepId: 'normal', count: 4 }]);
    expect(compiled.towers).toHaveLength(1);
    expect(compiled.towerById['basic']!.cost).toBe(5);
    expect(compiled.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('compiles a multi-wave board (sv6): a second wave, a second entry, a nonzero clearBonus, and a stream offset all accepted', () => {
    const compiled = compileRuleset(
      testBundle(OPEN, {
        waves: [
          { waveCount: 3, waveSpacing: 20, countdownTicks: 100, waveClearBonus: 4 },
          { waveCount: 2, waveSpacing: 20, countdownTicks: 80, waveClearBonus: 4 },
        ],
      }),
      'test',
    );
    expect(compiled.waves).toHaveLength(2);
    expect(compiled.waves[0]!.clearBonus).toBe(4);
    expect(compiled.waves[0]!.spawns).toHaveLength(3);
    expect(compiled.waves[1]!.spawns).toHaveLength(2);
  });

  it('interleaves a multi-entry stream by (offsetTicks, entryRow), aggregating entriesSummary in first-appearance order', () => {
    const bundle = testBundle(OPEN, { waveCount: 2, waveSpacing: 100, countdownTicks: 50 });
    const mutable = JSON.parse(JSON.stringify(bundle)) as {
      boards: {
        waves: {
          entries: { creepId: string; count: number; spacingTicks: number; offsetTicks?: number }[];
        }[];
      }[];
    };
    // Entry 0: 2 × 'normal' spacing 100, offset 0 → ticks [0, 100].
    // Entry 1: 2 × 'normal' spacing 30, offset 5 → ticks [5, 35] — interleaves.
    mutable.boards[0]!.waves[0]!.entries.push({
      creepId: 'normal',
      count: 2,
      spacingTicks: 30,
      offsetTicks: 5,
    });
    const compiled = compileRuleset(mutable as unknown as Ruleset, 'test');
    expect(compiled.waves[0]!.spawns.map((s) => s.offsetTicks)).toEqual([0, 5, 35, 100]);
    expect(compiled.waves[0]!.entriesSummary).toEqual([{ creepId: 'normal', count: 4 }]);
  });
});
