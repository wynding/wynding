// story-slow.test.ts — M2 Story 3: the catalog-tower + status-effect framework.
// `placeTower` by catalog `towerId` (accept/no-op/cost/preview-parity), per-kind
// tower row validity, the slow effect's application/stacking/expiry, the
// slow-aware bound gate, and the new creep/tower SoA columns' totality.

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  step,
  previewInputs,
  forEachValidTower,
  materializeTowerMask,
  findValidTowerIndex,
  countValidTowers,
  type SimInput,
} from './index';
import { runCombat, MAX_IMPACT_EFFECTS, type EffectPrimitive, type Impact } from './combat';
import { emptyTowers } from './tower';
import { compileRuleset, RulesetError } from './ruleset';
import { effectiveSpeedFp } from './ruleset-shared';
import {
  testBundle,
  testRuleset,
  pushCreep,
  TEST_SLOW_TOWER,
  TEST_FAST_CREEP,
} from './test-support';

const LANE = {
  widthTiles: 14,
  heightTiles: 14,
  entrance: { col: 0, row: 6 },
  exit: { col: 13, row: 6 },
} as const;

const cx = (col: number): number => col * 256 + 128;
const cy = (row: number): number => row * 256 + 128;

describe('placeTower — by catalog towerId', () => {
  const RULESET = testRuleset(LANE, { extraTowers: [TEST_SLOW_TOWER] });

  it('accepts a known towerId, charges the per-kind cost, and writes the towerId column', () => {
    const s = createInitialState(1, RULESET);
    step(s, RULESET, [{ kind: 'placeTower', anchor: { col: 5, row: 5 }, towerId: 'slow' }]);
    expect(s.towers.id).toEqual([1]);
    expect(s.towers.towerId).toEqual(['slow']);
    expect(s.towers.spend).toEqual([8]); // TEST_SLOW_TOWER.cost
    expect(s.bounty).toBe(80 - 8);
  });

  it('no-ops on an unknown towerId (catalog-unresolved)', () => {
    const s = createInitialState(1, RULESET);
    step(s, RULESET, [{ kind: 'placeTower', anchor: { col: 5, row: 5 }, towerId: 'nonexistent' }]);
    expect(s.towers.id).toHaveLength(0);
    expect(s.bounty).toBe(80);
  });

  it('no-ops on a non-string towerId (malformed input, no throw)', () => {
    const s = createInitialState(1, RULESET);
    const junk = [
      { kind: 'placeTower', anchor: { col: 5, row: 5 }, towerId: 42 },
      { kind: 'placeTower', anchor: { col: 5, row: 5 }, towerId: null },
      { kind: 'placeTower', anchor: { col: 5, row: 5 } }, // towerId omitted entirely
    ] as unknown as SimInput[];
    expect(() => step(s, RULESET, junk)).not.toThrow();
    expect(s.towers.id).toHaveLength(0);
    expect(s.bounty).toBe(80);
  });

  it('charges the correct per-kind cost across a mixed basic+slow build', () => {
    const s = createInitialState(1, RULESET);
    step(s, RULESET, [
      { kind: 'placeTower', anchor: { col: 3, row: 3 }, towerId: 'basic' }, // cost 5
      { kind: 'placeTower', anchor: { col: 8, row: 8 }, towerId: 'slow' }, // cost 8
    ]);
    expect(s.towers.towerId).toEqual(['basic', 'slow']);
    expect(s.towers.spend).toEqual([5, 8]);
    expect(s.bounty).toBe(80 - 5 - 8);
  });

  it('preview parity — previewInputs never diverges from step() on towerId acceptance', () => {
    const s = createInitialState(1, RULESET);
    const before = JSON.stringify(s);
    const { accepted, preview } = previewInputs(s, RULESET, [
      { kind: 'placeTower', anchor: { col: 5, row: 5 }, towerId: 'slow' },
    ]);
    expect(accepted).toEqual([true]);
    expect(preview.towers.towerId).toEqual(['slow']);
    expect(JSON.stringify(s)).toBe(before); // source untouched
  });
});

describe('per-kind tower row validity (forEachValidTower/materializeTowerMask/findValidTowerIndex)', () => {
  const RULESET = testRuleset(LANE, { extraTowers: [TEST_SLOW_TOWER] });
  const GRID = RULESET.board.grid;

  it('a forged spend↔towerId mismatch is invisible in the mask and unsellable', () => {
    const s = createInitialState(1, RULESET);
    // A row claiming to be 'slow' (cost 8) but carrying 'basic'-cost spend (5).
    s.towers.id.push(9);
    s.towers.col.push(3);
    s.towers.row.push(3);
    s.towers.spend.push(5);
    s.towers.targetId.push(0);
    s.towers.nextFireTick.push(0);
    s.towers.towerId.push('slow');
    expect(materializeTowerMask(GRID, s.towers, RULESET.towerById).every((b) => b === 0)).toBe(
      true,
    );
    expect(findValidTowerIndex(GRID, s.towers, 9, RULESET.towerById)).toBe(-1);
    const seen: number[] = [];
    forEachValidTower(GRID, s.towers, RULESET.towerById, (_i, id) => seen.push(id));
    expect(seen).toEqual([]);
  });

  it('a correctly-priced mixed catalog validates both kinds independently', () => {
    const s = createInitialState(1, RULESET);
    step(s, RULESET, [
      { kind: 'placeTower', anchor: { col: 3, row: 3 }, towerId: 'basic' },
      { kind: 'placeTower', anchor: { col: 8, row: 8 }, towerId: 'slow' },
    ]);
    const seen: number[] = [];
    forEachValidTower(GRID, s.towers, RULESET.towerById, (_i, id) => seen.push(id));
    expect(seen).toEqual([1, 2]); // both rows valid
  });
});

describe('effectiveSpeedFp — the ONE effective-speed formula (ruleset-shared.ts)', () => {
  it('mulFp 0 (no active slow) returns the base speed unchanged', () => {
    expect(effectiveSpeedFp(26, 0, 1, 4)).toBe(26);
  });

  it('floors the multiplier term and ceils the slow-floor term', () => {
    // base 26, mulFp 128 (half): floor(26*128/256) = 13; slowFloor 1/4: ceil(26/4) = 7.
    // max(1, 13, 7) = 13.
    expect(effectiveSpeedFp(26, 128, 1, 4)).toBe(13);
    // A near-zero multiplier still respects the ceil'd slow floor: floor(26*1/256)=0,
    // ceil(26/4)=7 → max(1,0,7) = 7.
    expect(effectiveSpeedFp(26, 1, 1, 4)).toBe(7);
  });

  it('never returns below 1, even at degenerate slowFloorNum 0', () => {
    // floor(26*1/256) = 0; ceil(26*0/4) = 0 → max(1,0,0) = 1 (the totality rail).
    expect(effectiveSpeedFp(26, 1, 0, 4)).toBe(1);
  });
});

describe('slow application — movement reads the per-creep slow columns', () => {
  it('a single hit slows movement from the NEXT tick, floor respected', () => {
    // A slow-only catalog so the tower cannot kill the high-hp creep outright.
    const ruleset = testRuleset(LANE, { towers: [TEST_SLOW_TOWER] });
    const s = createInitialState(1, ruleset);
    pushCreep(s, { id: 1, hp: 10_000, col: 6, row: 6 });
    step(s, ruleset, [{ kind: 'placeTower', anchor: { col: 5, row: 3 }, towerId: 'slow' }]);
    // Run enough ticks for the impact (travelTicks 2) to resolve and apply the slow.
    for (let t = 0; t < 5; t++) step(s, ruleset, []);
    expect(s.creeps.slowMulFp[0]).toBe(128);
    // Deterministic expiry pin (CodeRabbit #73), derived from the def so a test-bundle
    // edit moves it (QC r3): the first `step` call processes tick 0, so the placement
    // lands in tick 0's input phase, the tower (nextFireTick 0) fires that same tick's
    // combat phase, and the impact resolves `travelTicks` later — tick 2. The duration
    // is INCLUSIVE per m2.md ("applied at T for D, observed through T + D"): movement at
    // tick 42 still reads the slow; that tick's combat-phase sweep then removes it.
    const slowEffect = TEST_SLOW_TOWER.effects.find((e) => e.kind === 'slow');
    if (slowEffect?.kind !== 'slow') throw new Error('TEST_SLOW_TOWER must carry a slow effect');
    const attack = TEST_SLOW_TOWER.attack; // optional on TowerDef (support towers) — guard it
    if (attack === undefined) throw new Error('TEST_SLOW_TOWER must carry an attack block');
    expect(s.creeps.slowUntilTick[0]).toBe(attack.travelTicks + slowEffect.durationTicks); // 2 + 40 = 42
    // Effective speed at mulFp 128 over base 26 is 13 (see effectiveSpeedFp tests) —
    // strictly less than the unslowed 26, so progress accumulates at half rate.
    const progressBefore = s.creeps.progress[0] as number;
    step(s, ruleset, []);
    const delta = (s.creeps.progress[0] as number) - progressBefore;
    expect(delta).toBe(13); // effectiveSpeedFp(26, 128, 1, 4) — the exact slowed rate
  });
});

describe('slow stacking — strongest-wins, refresh-only-at-equal-or-stronger (via runCombat)', () => {
  const RULESET = testRuleset(LANE, { extraTowers: [TEST_SLOW_TOWER] });
  const FIELD = RULESET.board.field;
  const GRID = RULESET.board.grid;

  function oneRestingCreep(hp: number) {
    return {
      id: [1],
      hp: [hp],
      bounty: [1],
      speed: [26],
      fromX: [cx(7)],
      fromY: [cy(6)],
      headCol: [7],
      headRow: [6],
      progress: [0],
      wave: [0],
      creepId: ['normal'],
      slowMulFp: [0],
      slowUntilTick: [0],
    };
  }

  it('a stronger slow (lower mulFp) REPLACES an active weaker one', () => {
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      effects: [
        { kind: 'slow', mulFp: 150, durationTicks: 20 },
        { kind: 'slow', mulFp: 100, durationTicks: 5 }, // stronger — replaces
      ],
    };
    const result = runCombat(
      oneRestingCreep(100),
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.slowMulFp[0]).toBe(100);
    expect(result.creeps.slowUntilTick[0]).toBe(5);
  });

  it('a weaker slow (higher mulFp) is a NO-WRITE no-op against an active stronger one', () => {
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      effects: [
        { kind: 'slow', mulFp: 100, durationTicks: 20 },
        { kind: 'slow', mulFp: 200, durationTicks: 5 }, // weaker — no-op
      ],
    };
    const result = runCombat(
      oneRestingCreep(100),
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.slowMulFp[0]).toBe(100);
    expect(result.creeps.slowUntilTick[0]).toBe(20); // unchanged by the weaker second effect
  });

  it('TWO EQUAL-strength slows refresh SEQUENTIALLY (authored order) — the later application controls the final expiry, not the max', () => {
    // The later-authored effect has the SHORTER duration — if the implementation
    // wrongly took the max instead of the sequential refresh, this would read 50,
    // not 10.
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      effects: [
        { kind: 'slow', mulFp: 128, durationTicks: 50 },
        { kind: 'slow', mulFp: 128, durationTicks: 10 }, // equal strength — refreshes
      ],
    };
    const result = runCombat(
      oneRestingCreep(100),
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.slowMulFp[0]).toBe(128);
    expect(result.creeps.slowUntilTick[0]).toBe(10); // the LATER application's duration wins
  });

  it('direct-then-slow (authored order) applies direct in pass 1 regardless of the slow entries interleaved after it', () => {
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      effects: [
        { kind: 'direct', amount: 10 },
        { kind: 'slow', mulFp: 128, durationTicks: 30 },
      ],
    };
    const result = runCombat(
      oneRestingCreep(100),
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.hp[0]).toBe(90);
    expect(result.creeps.slowMulFp[0]).toBe(128); // survived — slow pass ran too
  });

  it('slow-authored-BEFORE-direct still runs the direct/death-check class first (class normalization, not raw array order)', () => {
    // A lethal direct listed AFTER the slow entry: the creep must still die (the
    // CLASS order is direct-then-slow, independent of authored array position).
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      effects: [
        { kind: 'slow', mulFp: 128, durationTicks: 30 },
        { kind: 'direct', amount: 999 },
      ],
    };
    const result = runCombat(
      oneRestingCreep(10),
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.id).toHaveLength(0); // dead — swept
  });

  // QC round-2: this title previously claimed "a lethal direct applies NO status",
  // but the killed row (creep 1) is swept before its slow columns could be read —
  // this only verifies creep 2, the SURVIVING sibling, still gets its slow. The
  // "no statuses on a lethal hit" rule itself is pinned pre-sweep, directly against
  // `applyImpactToCreep`, in `combat.test.ts`.
  it('creep 1 dies to its own impact and is swept; creep 2, hit by an identical impact but non-lethally, still gets its slow', () => {
    const creeps = {
      id: [1, 2],
      hp: [10, 100], // creep 1 dies to the direct; creep 2 survives it
      bounty: [1, 1],
      speed: [26, 26],
      fromX: [cx(7), cx(9)],
      fromY: [cy(6), cy(6)],
      headCol: [7, 9],
      headRow: [6, 6],
      progress: [0, 0],
      wave: [0, 0],
      creepId: ['normal', 'normal'],
      slowMulFp: [0, 0],
      slowUntilTick: [0, 0],
    };
    const impacts: Impact[] = [
      {
        kind: 'targeted',
        impactTick: 0,
        targetId: 1,
        effects: [
          { kind: 'direct', amount: 10 },
          { kind: 'slow', mulFp: 128, durationTicks: 30 },
        ],
      },
      {
        kind: 'targeted',
        impactTick: 0,
        targetId: 2,
        effects: [
          { kind: 'direct', amount: 10 },
          { kind: 'slow', mulFp: 128, durationTicks: 30 },
        ],
      },
    ];
    const result = runCombat(
      creeps,
      emptyTowers(),
      impacts,
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.id).toEqual([2]); // creep 1 dead+swept; creep 2 survives
    expect(result.creeps.slowMulFp[0]).toBe(128); // creep 2 got its slow
  });

  it('an impact carrying exactly MAX_IMPACT_EFFECTS effects RESOLVES; one more is dropped whole (QC r3 — the cap is a boundary, not a rejection of legal bundles)', () => {
    const atCap: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      effects: [
        ...Array.from({ length: MAX_IMPACT_EFFECTS - 1 }, (): EffectPrimitive => ({
          kind: 'direct',
          amount: 1,
        })),
        { kind: 'slow', mulFp: 128, durationTicks: 40 },
      ],
    };
    const result = runCombat(
      oneRestingCreep(100),
      emptyTowers(),
      [atCap],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.hp[0]).toBe(100 - (MAX_IMPACT_EFFECTS - 1)); // every direct landed
    expect(result.creeps.slowMulFp[0]).toBe(128); // and the slow applied
    // One MORE effect makes the snapshot structurally invalid — canonicalImpacts drops
    // it whole (totality): no damage, no slow, no throw.
    const overCap: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      effects: Array.from({ length: MAX_IMPACT_EFFECTS + 1 }, (): EffectPrimitive => ({
        kind: 'direct',
        amount: 1,
      })),
    };
    const untouched = runCombat(
      oneRestingCreep(100),
      emptyTowers(),
      [overCap],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(untouched.creeps.hp[0]).toBe(100);
    expect(untouched.creeps.slowMulFp[0]).toBe(0);
  });

  it('an overdue forged impact (impactTick < tick) anchors its slow expiry to the RESOLUTION tick, not the stale schedule (QC r3)', () => {
    // m2.md's inclusive rule reads "applied at T" — T is the tick the application
    // actually happens (combat drains overdue impacts at the current tick), so the
    // expiry is satAdd(tick, durationTicks), never the forged impactTick's.
    const overdue: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      effects: [{ kind: 'slow', mulFp: 128, durationTicks: 40 }],
    };
    const result = runCombat(
      oneRestingCreep(100),
      emptyTowers(),
      [overdue],
      5,
      0,
      FIELD,
      GRID,
      {},
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.slowMulFp[0]).toBe(128);
    expect(result.creeps.slowUntilTick[0]).toBe(45); // 5 + 40 — resolution-tick anchored
  });
});

describe('slow expiry — the combat-phase sweep, inclusive final tick', () => {
  const RULESET = testRuleset(LANE);
  const FIELD = RULESET.board.field;
  const GRID = RULESET.board.grid;

  function slowedCreep(slowUntilTick: number) {
    return {
      id: [1],
      hp: [100],
      bounty: [1],
      speed: [26],
      fromX: [cx(7)],
      fromY: [cy(6)],
      headCol: [7],
      headRow: [6],
      progress: [0],
      wave: [0],
      creepId: ['normal'],
      slowMulFp: [128],
      slowUntilTick: [slowUntilTick],
    };
  }

  it('is still active AT its final tick (inclusive), then cleared by the sweep', () => {
    const result = runCombat(
      slowedCreep(5),
      emptyTowers(),
      [],
      5,
      0,
      FIELD,
      GRID,
      {},
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    // The expiry sweep clears it THIS tick (== boundary) — so movement (which ran
    // BEFORE combat, in step()) still saw it active for tick 5's own movement.
    expect(result.creeps.slowMulFp[0]).toBe(0);
    expect(result.creeps.slowUntilTick[0]).toBe(0);
  });

  it('is NOT cleared one tick before its boundary', () => {
    const result = runCombat(
      slowedCreep(5),
      emptyTowers(),
      [],
      4,
      0,
      FIELD,
      GRID,
      {},
      RULESET.balance.slowFloorNum,
      RULESET.balance.slowFloorDen,
    );
    expect(result.creeps.slowMulFp[0]).toBe(128);
    expect(result.creeps.slowUntilTick[0]).toBe(5);
  });
});

describe('coerceSoa totality — the new creep/tower columns (via step()/previewInputs())', () => {
  const RULESET = testRuleset(LANE);

  it('drops a row whose creepId is unresolvable in the compiled catalog', () => {
    const s = createInitialState(1, RULESET);
    pushCreep(s, { id: 1, hp: 10, col: 6, row: 6, creepId: 'no-such-creep' });
    expect(() => step(s, RULESET, [])).not.toThrow();
    expect(s.creeps.id).toHaveLength(0);
    expect(s.lives).toBe(10); // dropped, not leaked
  });

  it('resets a malformed slow pair to (0, 0)', () => {
    const s = createInitialState(1, RULESET);
    pushCreep(s, { id: 1, hp: 10, col: 6, row: 6 });
    s.creeps.slowMulFp[0] = 999; // out of 1..255 range
    s.creeps.slowUntilTick[0] = 40;
    step(s, RULESET, []);
    expect(s.creeps.slowMulFp[0]).toBe(0);
    expect(s.creeps.slowUntilTick[0]).toBe(0);
  });

  it('clears an already-EXPIRED forged record AT ENTRY (before movement can read it), but preserves a genuine boundary record (=== tick)', () => {
    // Stale/forged: slowUntilTick strictly BELOW the current tick — coerceSoa must
    // clear this before movement, so this tick moves at the FULL unslowed speed.
    const stale = createInitialState(1, RULESET);
    stale.tick = 10;
    pushCreep(stale, { id: 1, hp: 10, col: 6, row: 6, slowMulFp: 128, slowUntilTick: 3 });
    step(stale, RULESET, []);
    const staleDelta = stale.creeps.progress[0] as number;
    expect(staleDelta).toBe(26); // full speed — the stale slow was cleared before movement

    // Genuine boundary: slowUntilTick === tick is LIVE for this tick's movement
    // (only the end-of-combat expiry sweep clears it, after movement already ran).
    const boundary = createInitialState(1, RULESET);
    boundary.tick = 10;
    pushCreep(boundary, { id: 1, hp: 10, col: 6, row: 6, slowMulFp: 128, slowUntilTick: 10 });
    step(boundary, RULESET, []);
    const boundaryDelta = boundary.creeps.progress[0] as number;
    expect(boundaryDelta).toBe(13); // slowed THIS tick (effectiveSpeedFp(26,128,1,4) = 13)
    expect(boundary.creeps.slowMulFp[0]).toBe(0); // then cleared by the same tick's sweep
  });

  it('a length overrun on slowMulFp trips the rebuild — the legit row survives, the trailing tail does not', () => {
    const s = createInitialState(1, RULESET);
    pushCreep(s, { id: 1, hp: 10, col: 6, row: 6 });
    (s.creeps.slowMulFp as number[]).push(0, 0); // longer than `id` — a forged trailing tail
    expect(() => step(s, RULESET, [])).not.toThrow();
    // The rebuild iterates `id`'s length (the row authority): row 0 is otherwise
    // well-formed (valid wave/creepId), so it survives — the forged tail beyond
    // `id`'s length simply never rides into the rebuilt (fresh) arrays.
    expect(s.creeps.id).toHaveLength(1);
    expect(s.creeps.slowMulFp).toHaveLength(1);
  });

  it('slow-pair repair is copy-on-write: a frozen source column is never mutated by a PREVIEW repair', () => {
    const s = createInitialState(1, RULESET);
    pushCreep(s, { id: 1, hp: 10, col: 6, row: 6 });
    s.creeps.slowMulFp = [999]; // invalid — needs repair
    s.creeps.slowUntilTick = [40];
    Object.freeze(s.creeps.slowMulFp);
    Object.freeze(s.creeps.slowUntilTick);
    expect(() => previewInputs(s, RULESET, [{ kind: 'noop' }])).not.toThrow();
    const { preview } = previewInputs(s, RULESET, [{ kind: 'noop' }]);
    expect(preview.creeps.slowMulFp[0]).toBe(0); // repaired in the preview clone
    expect(preview.creeps.slowUntilTick[0]).toBe(0);
    expect(s.creeps.slowMulFp[0]).toBe(999); // source untouched
    expect(s.creeps.slowUntilTick[0]).toBe(40);
  });

  it('densifies a SHORT slow pair to the row authority — absent tail rows become the inert (0,0), present rows keep their live pair (CodeRabbit #73)', () => {
    const s = createInitialState(1, RULESET);
    pushCreep(s, { id: 1, hp: 10, col: 6, row: 6 });
    pushCreep(s, { id: 2, hp: 10, col: 6, row: 6 });
    s.creeps.slowMulFp = [128]; // forged short: one entry against two rows
    s.creeps.slowUntilTick = [40];
    // The PREVIEW layer pins coerceSoa's OWN densifier (QC r3): previewInputs runs no
    // movement phase, so a repair that failed to grow the columns has nothing
    // downstream to mask it (step()'s movement rebuild would independently densify).
    const { preview } = previewInputs(s, RULESET, [{ kind: 'noop' }]);
    expect(preview.creeps.id).toEqual([1, 2]); // densify, never row-drop
    expect(preview.creeps.slowMulFp).toEqual([128, 0]);
    expect(preview.creeps.slowUntilTick).toEqual([40, 0]);
    // And end-to-end through step(): the committed state lands the same dense shape.
    expect(() => step(s, RULESET, [])).not.toThrow();
    expect(s.creeps.id).toEqual([1, 2]);
    expect(s.creeps.slowMulFp).toEqual([128, 0]);
    expect(s.creeps.slowUntilTick).toEqual([40, 0]);
  });

  it('coerces a missing towerId container to an empty array (totality)', () => {
    const s = createInitialState(1, RULESET);
    step(s, RULESET, [{ kind: 'placeTower', anchor: { col: 5, row: 5 }, towerId: 'basic' }]);
    (s.towers as unknown as { towerId?: unknown }).towerId = undefined;
    expect(() => step(s, RULESET, [])).not.toThrow();
  });

  it('pads a short tower column to the row authority, so a later placement cannot revive a dead row (QC round 1)', () => {
    // A restored container whose towerId column is MISSING: the old row must stay
    // invalid (unresolvable ''), and an accepted placeTower must land ALL its column
    // values at the same tail index — never towerId at index 0 beside id/col/row at
    // index 1 (the zombie-revival misalignment).
    const s = createInitialState(1, RULESET);
    s.towers.id.push(7);
    s.towers.col.push(5);
    s.towers.row.push(5);
    s.towers.spend.push(5);
    s.towers.targetId.push(0);
    s.towers.nextFireTick.push(0);
    // towerId column deliberately left EMPTY (length 0 vs id length 1).
    step(s, RULESET, [{ kind: 'placeTower', anchor: { col: 10, row: 5 }, towerId: 'basic' }]);
    expect(s.towers.towerId).toHaveLength(s.towers.id.length); // aligned
    expect(s.towers.towerId[0]).toBe(''); // the dead row stays inert…
    const newRow = s.towers.id.length - 1;
    expect(s.towers.towerId[newRow]).toBe('basic'); // …and the paid row is real,
    expect(s.towers.col[newRow]).toBe(10); // at its own coordinates.
    // The dead row is invisible to the canonical walk; only the new tower counts.
    expect(countValidTowers(RULESET.board.grid, s.towers, RULESET.towerById)).toBe(1);
  });

  it('pads short col/row with an OUT-OF-BOUNDS value — a forged row with valid towerId/spend must not materialize at (0,0) (QC round 2)', () => {
    const s = createInitialState(1, RULESET);
    s.towers.id.push(7);
    s.towers.spend.push(5); // basic's exact cost…
    s.towers.targetId.push(0);
    s.towers.nextFireTick.push(0);
    s.towers.towerId.push('basic'); // …and a resolvable id —
    // col/row columns deliberately left EMPTY: a 0-pad would place this row at (0,0).
    expect(() => step(s, RULESET, [])).not.toThrow();
    expect(s.towers.col[0]).toBe(-1);
    expect(s.towers.row[0]).toBe(-1);
    expect(countValidTowers(RULESET.board.grid, s.towers, RULESET.towerById)).toBe(0);
  });
});

describe('the slow-aware bound gate (Codex R2-4/G10)', () => {
  // A board just large enough that the baseline (no slow) traversal fits the
  // MAX_MATCH_TICKS budget, but adding the catalog's `slow` tower (strongest
  // mulFp 128, floor 1/4 ⇒ effective speed 13 vs base 26) pushes the worst-case
  // traversal over it — the hostile-self-slowing bound-gate proof (G10).
  const BOUND_BOARD = {
    widthTiles: 50,
    heightTiles: 50,
    entrance: { col: 0, row: 25 },
    exit: { col: 49, row: 25 },
  } as const;

  it('compiles without a slow tower in the catalog, rejects once one is added', () => {
    const withoutSlow = testBundle(BOUND_BOARD, {
      waveCount: 1,
      waveSpacing: 1,
      countdownTicks: 1,
    });
    expect(() => compileRuleset(withoutSlow, 'test')).not.toThrow();

    const withSlow = testBundle(BOUND_BOARD, {
      waveCount: 1,
      waveSpacing: 1,
      countdownTicks: 1,
      extraTowers: [TEST_SLOW_TOWER],
    });
    expect(() => compileRuleset(withSlow, 'test')).toThrow(RulesetError);
    expect(() => compileRuleset(withSlow, 'test')).toThrow(
      'ruleset cannot reach a terminal state within the tick budget',
    );
  });
});

describe('fast creep catalog entry', () => {
  it('compiles with its own hp/speedFp/bounty, independent of the normal creep', () => {
    const ruleset = testRuleset(LANE, { extraCreeps: [TEST_FAST_CREEP] });
    const fast = ruleset.creepById['fast']!;
    expect(fast.hp).toBe(16);
    expect(fast.speedFp).toBe(44);
    expect(fast.bounty).toBe(2);
    expect(ruleset.creepById['normal']!.speedFp).toBe(26); // unaffected
  });

  it("a spawned fast creep resolves its own catalog stats (hp/speed) at spawn, not the normal creep's", () => {
    const ruleset = testRuleset(LANE, {
      extraCreeps: [TEST_FAST_CREEP],
      waves: [{ waveCount: 1, waveSpacing: 1, creepId: 'fast' }],
    });
    const s = createInitialState(1, ruleset);
    step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    expect(s.creeps.creepId).toEqual(['fast']);
    expect(s.creeps.hp).toEqual([16]);
    expect(s.creeps.speed).toEqual([44]);
  });
});
