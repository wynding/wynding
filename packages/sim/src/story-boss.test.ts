// story-boss.test.ts — M2 Story 10 P6: the multi-life leak, at sim level.
//
// `leakCost` has been a per-creep field in the v2 schema since S1, but every catalog
// pinned it to 1 and `compileRuleset` collapsed the axis into a single
// `CompiledBalance.leakCost`, which `index.ts` subtracted uniformly. S10 UN-collapses
// that: `CompiledCreep` now carries its own `leakCost`, and `step`'s leak branch
// resolves it per creep via `resolveCreepLeakCost` (a sibling of `resolveCreepDomain`).
// This file is the sim-level witness for that rule — NOT a rebuild of the boss's other
// content (armor, role, render cue), which is content-level (`story-finale.test.ts`).
//
// FIXTURE REQUIREMENT (PLAN.md P6/Verification §6): the catalog's FIRST entry carries
// `leakCost: 3`, with a `leakCost: 1` entry LATER in the catalog. This is deliberate,
// not incidental — against the shipped bundle (`creepCatalog[0]` is `normal`, cost 1),
// the mutation "force leak cost resolution to constant 1" and the mutation "read
// creepCatalog[0].leakCost regardless of the creep passed in" (the pre-S10 collapsed
// behaviour) are BEHAVIOURALLY IDENTICAL and cannot be told apart. Putting a
// non-1 cost at index 0 here makes them diverge: "constant 1" always returns 1,
// "read index 0" always returns 3, and this fixture's own low-cost creep (`grunt`,
// catalog[1], cost 1) is what makes that difference visible in a test's own numbers.
//
// TWO DISTINCT overshoot modes exist and are covered SEPARATELY, never conflated
// (Context, PLAN.md lines ~24-34):
//   - SAME-TICK AGGREGATE overshoot — pre-existing, NOT introduced by S10. Any leak
//     cost reaches it: two cost-1 creeps leaking on the SAME tick from 1 life land on
//     -1, because leaks subtract in MOVEMENT (over every creep) while terminal is only
//     evaluated later in RESOLUTION. `determinism.test.ts:166-168` records exactly
//     this, measured: "it overshoots to `lives === -1` (two creeps leak on the fatal
//     tick; `index.ts` deliberately applies no low clamp)".
//   - SINGLE-LEAK overshoot — what S10 actually unlocks. Needs `leakCost > 1`: ONE
//     creep, ONE tick, 2 lives -> -1. The boss is its only shipped source.

import { describe, it, expect } from 'vitest';
import type { Ruleset } from '@wynding/types';
import { compileRuleset, type CompiledRuleset } from './ruleset';
import { createInitialState, step, resolveCreepLeakCost, type SimState } from './index';
import { pushCreep } from './test-support';

const LANE = {
  widthTiles: 14,
  heightTiles: 14,
  entrance: { col: 0, row: 6 },
  exit: { col: 13, row: 6 },
} as const;

/** A minimal raw bundle, built by hand (not `test-support.ts`'s `testBundle`) —
 *  `testBundle`'s default catalog hardcodes `creepCatalog[0]` as `normal` at
 *  `leakCost: 1`, which cannot satisfy this file's fixture requirement above.
 *  `HEAVY` (catalog[0], cost 3) and `GRUNT` (catalog[1], cost 1) are injected
 *  directly via `pushCreep`, bypassing the wave schedule entirely — every test below
 *  needs exact control over which creep leaks on which tick, not a real spawn
 *  timeline. `startingLives` is the one thing tests vary, via `buildRuleset`. */
function buildRuleset(startingLives: number): CompiledRuleset {
  const bundle: Ruleset = {
    formatVersion: 2,
    rulesetId: 'test-boss',
    version: 1,
    creepCatalog: [
      {
        id: 'heavy',
        hp: 50,
        speedFp: 26,
        armor: 0,
        domain: 'ground',
        immunities: [],
        leakCost: 3,
        bounty: 5,
      },
      {
        id: 'grunt',
        hp: 20,
        speedFp: 26,
        armor: 0,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: 1,
      },
    ],
    towerCatalog: [
      {
        id: 'basic',
        cost: 5,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
        effects: [{ kind: 'direct', form: 'single', damage: 10 }],
      },
    ],
    balance: {
      startingLives,
      startingBounty: 80,
      refundNum: 3,
      refundDen: 4,
      slowFloorNum: 1,
      slowFloorDen: 4,
      earlyCallBountyDivisor: 0,
    },
    scoring: { survivalMul: 25, starThresholds: [1, 6, 9], earlyCallScoreDivisor: 0 },
    boards: [
      {
        id: 'test',
        widthTiles: LANE.widthTiles,
        heightTiles: LANE.heightTiles,
        entrance: LANE.entrance,
        exit: LANE.exit,
        waves: [
          {
            index: 0,
            countdownTicks: 500,
            clearBonus: 0,
            entries: [{ creepId: 'grunt', count: 1, spacingTicks: 20 }],
          },
        ],
      },
    ],
  };
  return compileRuleset(bundle, 'test');
}

/** A creep resting AT the exit cell, one ordinary tick from leaking — mirrors the
 *  shape `determinism.test.ts`'s own overshoot witness needs: a row whose very next
 *  movement step reaches the exit and leaks. */
function pushAboutToLeak(
  s: SimState,
  args: { readonly id: number; readonly creepId: string; readonly wave?: number },
): void {
  pushCreep(s, {
    id: args.id,
    hp: 200,
    col: LANE.exit.col,
    row: LANE.exit.row,
    creepId: args.creepId,
    wave: args.wave ?? 0,
  });
}

describe('single-leak overshoot (what S10 unlocks — needs leakCost > 1)', () => {
  it('one cost-3 creep, one tick, 2 lives -> -1, and the state is terminal', () => {
    const ruleset = buildRuleset(2);
    const s = createInitialState(1, ruleset);
    pushAboutToLeak(s, { id: 1, creepId: 'heavy' }); // leakCost 3
    step(s, ruleset, []); // the one tick this creep leaks on
    expect(s.lives).toBe(-1); // 2 - 3, no low clamp
    expect(s.phase).toBe('lost'); // lives <= 0 -> terminal
    expect(s.leakedCount).toBe(1);
    expect(s.waveLeaked[0]).toBe(true);
  });
});

describe('same-tick aggregate overshoot (pre-existing, NOT introduced by S10 — determinism.test.ts:166-168: "two creeps leak on the fatal tick; index.ts deliberately applies no low clamp")', () => {
  it('two cost-1 creeps leaking on the SAME tick from 1 life -> -1', () => {
    const ruleset = buildRuleset(1);
    const s = createInitialState(1, ruleset);
    pushAboutToLeak(s, { id: 1, creepId: 'grunt' }); // leakCost 1
    pushAboutToLeak(s, { id: 2, creepId: 'grunt' }); // leakCost 1
    step(s, ruleset, []); // both leak in MOVEMENT; terminal only checked in RESOLUTION
    expect(s.lives).toBe(-1); // 1 - 1 - 1
    expect(s.phase).toBe('lost');
    expect(s.leakedCount).toBe(2); // cost-independent — bumped once per leak, not per cost
  });
});

describe('aggregate: two leaks on one tick both subtract (distinct from the single-leak case)', () => {
  it('two cost-3 creeps leak on the same tick from 10 lives -> 4', () => {
    const ruleset = buildRuleset(10);
    const s = createInitialState(1, ruleset);
    pushAboutToLeak(s, { id: 1, creepId: 'heavy' });
    pushAboutToLeak(s, { id: 2, creepId: 'heavy' });
    step(s, ruleset, []);
    expect(s.lives).toBe(4); // 10 - 3 - 3
    expect(s.phase).toBe('running');
    expect(s.leakedCount).toBe(2);
  });
});

describe('a MIXED wave subtracts per creep, not a flat per-bundle amount', () => {
  it('one cost-3 creep and one cost-1 creep leak on the same tick: 10 lives -> 6', () => {
    const ruleset = buildRuleset(10);
    const s = createInitialState(1, ruleset);
    pushAboutToLeak(s, { id: 1, creepId: 'heavy' }); // -3
    pushAboutToLeak(s, { id: 2, creepId: 'grunt' }); // -1
    step(s, ruleset, []);
    expect(s.lives).toBe(6); // 10 - 3 - 1, per-creep — a flat per-bundle amount would read 8 or 7
    expect(s.leakedCount).toBe(2);
    expect(s.waveLeaked[0]).toBe(true);
  });
});

describe('leakedCount and waveLeaked are cost-independent counters', () => {
  it('a single cost-3 leak bumps leakedCount by exactly 1, not by 3', () => {
    const ruleset = buildRuleset(10);
    const s = createInitialState(1, ruleset);
    pushAboutToLeak(s, { id: 1, creepId: 'heavy' });
    step(s, ruleset, []);
    expect(s.lives).toBe(7); // 10 - 3, the cost DID apply to lives
    expect(s.leakedCount).toBe(1); // but the presentation counter is a plain +1
    expect(s.waveLeaked[0]).toBe(true); // likewise boolean, not cost-weighted
  });
});

describe('resolveCreepLeakCost — direct unit test of the resolver itself', () => {
  // Sim-level scenarios cannot reach the `?? 1` fallback: `coerceSoa` drops any row
  // whose `creepId` doesn't resolve in `creepById` BEFORE movement ever runs, so no
  // leak can ever observe an unresolved id (index.ts, resolver's own doc comment).
  // A sim-level attempt at this would be vacuous — it would pass whether or not the
  // fallback exists, because the row it needs never survives to the leak branch.
  // This calls the resolver directly instead, exactly as `domain.test.ts` calls
  // `resolveCreepDomain` directly for the identical reason (that file's own
  // "resolveCreepDomain — the shared totality rail" describe block, line ~310).
  it('an id with no entry in creepById falls back to 1', () => {
    const ruleset = buildRuleset(10);
    expect(resolveCreepLeakCost(ruleset.creepById, 'ghost-creep-id')).toBe(1);
  });

  it('a real id resolves its own catalog leakCost (3 for catalog[0], 1 for catalog[1])', () => {
    const ruleset = buildRuleset(10);
    expect(resolveCreepLeakCost(ruleset.creepById, 'heavy')).toBe(3);
    expect(resolveCreepLeakCost(ruleset.creepById, 'grunt')).toBe(1);
  });

  it('a non-string creepId also falls back to 1 (same totality posture as resolveCreepDomain)', () => {
    const ruleset = buildRuleset(10);
    expect(resolveCreepLeakCost(ruleset.creepById, undefined)).toBe(1);
    expect(resolveCreepLeakCost(ruleset.creepById, 42)).toBe(1);
  });
});
