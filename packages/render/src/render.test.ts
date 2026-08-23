// render.test.ts — the presentation layer's PURE modules: projection geometry + its
// pointer inverse, view-model/hud derivation from SimState, and id-matched
// interpolation + impact-spark diffing. No Phaser, no DOM.

import { describe, it, expect } from 'vitest';
import { FP_ONE } from '@wynding/engine';
import {
  createInitialState,
  step,
  compileRuleset,
  deriveScore,
  previewInputs,
  type SimInput,
  type SimState,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from '@wynding/content';
import type { Ruleset } from '@wynding/types';
import { createProjection } from './projection';
import { deriveViewModel, deriveHud } from './view-model';
import { interpolateCreeps } from './interpolate';
import { resolvePalette } from './palette';
import type { ColourMode, RenderVM } from './types';
import * as barrel from './index';

const bundle = getBundledRuleset();
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));

/** The first wave index, in the COMPILED schedule, that spawns at least one creep of
 *  `creepId` — mirrors `@wynding/content`'s `wave-lookup.ts` (S11 P2's de-index ruling:
 *  P1 renumbers every wave, so a literal wave index would silently retarget onto
 *  whatever wave lands there after a renumber, with no test failure to flag it).
 *  `wave-lookup.ts` is content's own test-support module, not part of its public API
 *  (not re-exported, no `exports` map entry), so this file carries its own copy rather
 *  than reaching across the package boundary for it. */
function waveIndexForCreep(r: typeof ruleset, creepId: string): number {
  const index = r.waves.findIndex((wave) => wave.spawns.some((s) => s.creepId === creepId));
  if (index === -1) {
    throw new Error(`no wave in the compiled schedule spawns creep id '${creepId}'`);
  }
  return index;
}

// A hand-built, sv6-legal SYNTHETIC bundle (M2-S2, PLAN.md P3 step 19) — the shipped
// `wynding-core` bundle's three identical single-entry waves cannot catch an
// aggregation/ordering bug in the preview join, so this exercises duplicate-creepId
// aggregation and first-appearance ordering with a real `compileRuleset` pass rather than
// a hand-built `CompiledRuleset` (which is opaque/branded — `assertRuleset` would reject
// one anyway). Every creep stays `domain: 'ground'`, `armor: 0`, `immunities: []` — sv6's
// capability profile keeps those closed (Out of scope), so only hp/speed/bounty vary
// between the two kinds.
const SYNTHETIC_BOARD_ID = 'wave-preview-board';
const syntheticBundle: Ruleset = {
  formatVersion: 2,
  rulesetId: 'wave-preview-test',
  version: 1,
  creepCatalog: [
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
      id: 'armored',
      hp: 60,
      speedFp: 18,
      armor: 0,
      domain: 'ground',
      immunities: [],
      leakCost: 1,
      bounty: 3,
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
    startingLives: 10,
    startingBounty: 80,
    refundNum: 3,
    refundDen: 4,
    slowFloorNum: 1,
    slowFloorDen: 4,
    earlyCallBountyDivisor: 50,
  },
  scoring: { survivalMul: 25, starThresholds: [1, 6, 9], earlyCallScoreDivisor: 50 },
  boards: [
    {
      id: SYNTHETIC_BOARD_ID,
      widthTiles: 9,
      heightTiles: 5,
      entrance: { col: 0, row: 2 },
      exit: { col: 8, row: 2 },
      waves: [
        {
          index: 0,
          countdownTicks: 100,
          clearBonus: 4,
          // First-appearance order 'armored' then 'normal' — deliberately NOT alphabetical
          // or catalog order, so a bug that re-sorts the summary alphabetically or by
          // catalog position (rather than preserving entry order) would be caught. The two
          // 'normal' entries (counts 2 + 1) must aggregate to a single count-3 row.
          entries: [
            { creepId: 'armored', count: 1, spacingTicks: 10, offsetTicks: 0 },
            { creepId: 'normal', count: 2, spacingTicks: 10, offsetTicks: 0 },
            { creepId: 'normal', count: 1, spacingTicks: 10, offsetTicks: 5 },
          ],
        },
        {
          index: 1,
          countdownTicks: 50,
          clearBonus: 4,
          entries: [{ creepId: 'normal', count: 1, spacingTicks: 10, offsetTicks: 0 }],
        },
      ],
    },
  ],
};
const syntheticRuleset = compileRuleset(syntheticBundle, SYNTHETIC_BOARD_ID);

describe('projection — fit/letterbox + pointer inverse', () => {
  it('letterboxes a wide canvas: whole-pixel cells, centred board', () => {
    // 10×10 board in a 400×200 canvas → cellPx = floor(min(40,20)) = 20; board 200 wide,
    // centred with a 100px left/right margin, 0 top/bottom.
    const p = createProjection({ cols: 10, rows: 10, cssWidth: 400, cssHeight: 200, dpr: 2 });
    expect(p.cellPx).toBe(20);
    expect(p.originX).toBe(100);
    expect(p.originY).toBe(0);
    expect(p.dpr).toBe(2);
    expect(p.cellToPixel(0, 0)).toEqual({ x: 100, y: 0 });
    expect(p.cellToPixel(2, 3)).toEqual({ x: 140, y: 60 });
  });

  it('projects a fixed-point point and a length to pixels', () => {
    const p = createProjection({ cols: 10, rows: 10, cssWidth: 200, cssHeight: 200, dpr: 1 });
    expect(p.cellPx).toBe(20);
    // centre of cell (1,1) is at 1.5 cells = 1.5 * FP_ONE fixed-point units.
    expect(p.fpToPixel(1.5 * FP_ONE, 0.5 * FP_ONE)).toEqual({ x: 30, y: 10 });
    expect(p.fpLenToPixel(4 * FP_ONE)).toBe(80); // a 4-tile range → 80px
  });

  it('maps a pointer back to the cell the player sees, and rejects outside the board', () => {
    const p = createProjection({ cols: 10, rows: 10, cssWidth: 400, cssHeight: 200, dpr: 1 });
    expect(p.pointerToCell(100, 0)).toEqual({ col: 0, row: 0 }); // top-left of board
    expect(p.pointerToCell(145, 65)).toEqual({ col: 2, row: 3 });
    expect(p.pointerToCell(0, 0)).toBeNull(); // in the left letterbox margin
    expect(p.pointerToCell(399, 199)).toBeNull(); // past the right edge of the board
  });

  it('is round-trip consistent: a cell top-left maps back to that cell', () => {
    const p = createProjection({ cols: 28, rows: 24, cssWidth: 560, cssHeight: 600, dpr: 3 });
    for (const [col, row] of [
      [0, 0],
      [27, 23],
      [13, 11],
    ] as const) {
      const px = p.cellToPixel(col, row);
      expect(p.pointerToCell(px.x + 1, px.y + 1)).toEqual({ col, row });
    }
  });

  it('degenerate (zero-size) layout falls back to 1px cells instead of throwing', () => {
    const p = createProjection({ cols: 0, rows: 0, cssWidth: 0, cssHeight: 0, dpr: 0 });
    expect(p.cellPx).toBe(1);
    expect(p.dpr).toBe(1);
  });
});

describe('view-model + hud derivation', () => {
  it('derives HUD countdown/score/stars from a fresh running (pre-first-launch) state', () => {
    const s = createInitialState(1, ruleset);
    const hud = deriveHud(s, ruleset);
    expect(hud.phase).toBe('running');
    expect(hud.lives).toBe(ruleset.balance.startingLives);
    expect(hud.bounty).toBe(ruleset.balance.startingBounty);
    expect(hud.countdownSeconds).toBeGreaterThan(0); // counting down pre-launch
    expect(hud.stars).toBe(0);
    expect(hud.waveCount).toBe(ruleset.waves.length);
    expect(hud.waveCursor).toBe(0);
    expect(hud.launchPending).toBe(false);
    expect(hud.callable).toBe(true);
  });

  it('projects spawned creeps into the render view-model with a health fraction', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]); // launch → first creep spawns
    const vm = deriveViewModel(s, ruleset);
    expect(vm.creeps.length).toBeGreaterThan(0);
    for (const c of vm.creeps) {
      expect(c.hpFrac).toBeGreaterThan(0);
      expect(c.hpFrac).toBeLessThanOrEqual(1);
    }
    expect(vm.phase).toBe('running');
  });

  it('includes placed towers in the view-model', () => {
    let s = createInitialState(1, ruleset);
    const build: SimInput = { kind: 'placeTower', anchor: { col: 3, row: 3 }, towerId: 'basic' };
    s = step(s, ruleset, [build]);
    const vm = deriveViewModel(s, ruleset);
    expect(vm.towers).toHaveLength(1);
    expect(vm.towers[0]).toMatchObject({ col: 3, row: 3, towerId: 'basic' });
  });

  // M2-S8. The view model must classify support/buffed by calling the SIM's own aura
  // rule, so the ✦ can never mark a tower `runCombat` is not actually buffing.
  it('marks a support tower and the attackers its aura reaches (M2-S8)', () => {
    let s = createInitialState(1, ruleset);
    // `beacon` at (4,12) occupies cols 4-5, rows 12-13; its ring includes (6,12), so the
    // `basic` anchored there shares a full cell edge with it and is buffed. The `basic`
    // at (10,12) is three columns clear of the ring and is not.
    s = step(s, ruleset, [
      { kind: 'placeTower', anchor: { col: 4, row: 12 }, towerId: 'beacon' },
      { kind: 'placeTower', anchor: { col: 6, row: 12 }, towerId: 'basic' },
      { kind: 'placeTower', anchor: { col: 10, row: 12 }, towerId: 'basic' },
    ]);
    const byCol = new Map(deriveViewModel(s, ruleset).towers.map((t) => [t.col, t]));
    expect(byCol.get(4)).toMatchObject({ towerId: 'beacon', support: true, buffed: false });
    expect(byCol.get(6)).toMatchObject({ towerId: 'basic', support: false, buffed: true });
    expect(byCol.get(10)).toMatchObject({ towerId: 'basic', support: false, buffed: false });
  });

  it('never marks a beacon beside a beacon as buffed — the sim enacts no chaining (M2-S8)', () => {
    // A beacon IS inside its neighbour's stamped ring, so `buffed` is only false here
    // because it is gated on the tower having an attack. Without that gate the scene
    // would draw a ✦ on both — a visual chaining lie the sim never enacts (support
    // towers are skipped in the fire step and never look the aura up at all).
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [
      { kind: 'placeTower', anchor: { col: 4, row: 12 }, towerId: 'beacon' },
      { kind: 'placeTower', anchor: { col: 6, row: 12 }, towerId: 'beacon' },
    ]);
    const towers = deriveViewModel(s, ruleset).towers;
    expect(towers).toHaveLength(2);
    expect(towers.every((t) => t.support)).toBe(true);
    expect(towers.every((t) => !t.buffed)).toBe(true);
  });

  it('excludes corner-only touch from the aura — a diagonal neighbour is not buffed (M2-S8)', () => {
    // The aura is a full-cell-EDGE share, not a radius. `beacon` at (4,12) covers cols
    // 4-5 / rows 12-13; a `basic` at (6,14) covers cols 6-7 / rows 14-15, touching only
    // at the corner point (6,14)↔(5,13). Excluded (m2.md).
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [
      { kind: 'placeTower', anchor: { col: 4, row: 12 }, towerId: 'beacon' },
      { kind: 'placeTower', anchor: { col: 6, row: 14 }, towerId: 'basic' },
    ]);
    const basic = deriveViewModel(s, ruleset).towers.find((t) => t.towerId === 'basic');
    expect(basic).toBeDefined();
    expect(basic!.buffed).toBe(false);
  });

  it('projects each creep’s catalog id and the true per-creep hpFrac denominator (M2-S3)', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    const vm = deriveViewModel(s, ruleset);
    expect(vm.creeps.length).toBeGreaterThan(0);
    for (const c of vm.creeps) {
      expect(c.creepId).toBe('normal');
      expect(c.slowed).toBe(false);
      expect(c.hpFrac).toBe(1); // undamaged: full pip regardless of denominator
    }
    // The DENOMINATOR itself (CodeRabbit #73 — the old assertion was def.hp/def.hp, a
    // tautology): retag row 0 as `fast` (catalog max 16) at 8 hp — half a pip against
    // ITS OWN catalog max, not `normal`'s 20 (the single-kind global the VM used to
    // assume) and not current hp (which would read full).
    s.creeps.creepId[0] = 'fast';
    s.creeps.hp[0] = 8;
    const damaged = deriveViewModel(s, ruleset).creeps[0];
    expect(damaged?.hpFrac).toBeCloseTo(8 / 16);
    // Two kinds in ONE view-model (QC r3): a denominator hoisted from row 0 would read
    // row 1 as 5/16 instead of 5/20 — advance to the second spawn and pin BOTH rows.
    for (let i = 0; i < 40 && s.creeps.id.length < 2; i++) s = step(s, ruleset, []);
    expect(s.creeps.id.length).toBe(2);
    s.creeps.creepId[0] = 'fast';
    s.creeps.hp[0] = 8;
    s.creeps.hp[1] = 5; // row 1 stays `normal` (catalog max 20)
    const two = deriveViewModel(s, ruleset);
    expect(two.creeps[0]?.hpFrac).toBeCloseTo(8 / 16);
    expect(two.creeps[1]?.hpFrac).toBeCloseTo(5 / 20);
  });

  it('projects `slowed` from a live slowMulFp column value', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    s.creeps.slowMulFp[0] = 128;
    s.creeps.slowUntilTick[0] = s.tick + 10;
    const vm = deriveViewModel(s, ruleset);
    const c = vm.creeps.find((v) => v.id === s.creeps.id[0]);
    expect(c?.slowed).toBe(true);
  });

  it('projects `stunned` from a live stunUntilTick column value, inclusive of the expiry tick (M2-S6)', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    s.creeps.stunUntilTick[0] = s.tick; // inclusive boundary: still stunned THIS tick
    let vm = deriveViewModel(s, ruleset);
    let c = vm.creeps.find((v) => v.id === s.creeps.id[0]);
    expect(c?.stunned).toBe(true);

    s.creeps.stunUntilTick[0] = s.tick - 1; // expired the tick before
    vm = deriveViewModel(s, ruleset);
    c = vm.creeps.find((v) => v.id === s.creeps.id[0]);
    expect(c?.stunned).toBe(false);

    s.creeps.stunUntilTick[0] = 0; // 0 means never stunned
    vm = deriveViewModel(s, ruleset);
    c = vm.creeps.find((v) => v.id === s.creeps.id[0]);
    expect(c?.stunned).toBe(false);
  });

  it('the pollable board summary (#79) counts an EMPTY board as five zeroes, never a null surface', () => {
    const s = createInitialState(1, ruleset);
    expect(deriveHud(s, ruleset).statuses).toEqual({
      slowed: 0,
      poisoned: 0,
      armored: 0,
      stunned: 0,
      airborne: 0,
    });
  });

  it('the pollable board summary (#79) counts all five statuses at once, and agrees with the per-creep telegraph flags creep-for-creep', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    // Spawn enough rows to give every axis a distinct population: the shipped wave 1 is
    // ten `normal`s spawned over time, so step until there are at least five live rows.
    for (let i = 0; i < 200 && s.creeps.id.length < 5; i++) s = step(s, ruleset, []);
    expect(s.creeps.id.length).toBeGreaterThanOrEqual(5);

    // Row 0 slowed, row 1 stunned (inclusive expiry), row 2 poisoned by a live DoT
    // record, row 3 `armored` (nonzero catalog armor), row 4 `flying` (air domain).
    s.creeps.slowMulFp[0] = 128;
    s.creeps.slowUntilTick[0] = s.tick + 10;
    s.creeps.stunUntilTick[1] = s.tick;
    s.dots = [
      {
        targetId: s.creeps.id[2] as number,
        sourceId: 101,
        amount: 4,
        cadenceTicks: 10,
        nextTickTick: s.tick + 10,
        untilTick: s.tick + 60,
      },
    ];
    s.creeps.creepId[3] = 'armored';
    s.creeps.creepId[4] = 'flying';

    const hud = deriveHud(s, ruleset);
    expect(hud.statuses).toEqual({
      slowed: 1,
      poisoned: 1,
      armored: 1,
      stunned: 1,
      airborne: 1,
    });

    // The counts and the drawn telegraphs read the SAME rules — a second copy of
    // "slowed right now" is exactly how a cue and a count come to disagree.
    const vm = deriveViewModel(s, ruleset);
    expect(vm.creeps.filter((c) => c.slowed)).toHaveLength(hud.statuses.slowed);
    expect(vm.creeps.filter((c) => c.poisoned)).toHaveLength(hud.statuses.poisoned);
    expect(vm.creeps.filter((c) => c.stunned)).toHaveLength(hud.statuses.stunned);
    expect(vm.creeps.filter((c) => c.domain === 'air')).toHaveLength(hud.statuses.airborne);
  });

  it('the pollable board summary (#79) counts one creep on every axis it satisfies, and a forged creepId on neither catalog axis', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    for (let i = 0; i < 200 && s.creeps.id.length < 2; i++) s = step(s, ruleset, []);

    // One creep, three statuses at once: overlap is additive per AXIS, never
    // winner-takes-all — the summary reports state, not a classification.
    s.creeps.creepId[0] = 'armored-flyer'; // armor 5 AND domain air
    s.creeps.slowMulFp[0] = 128;
    s.creeps.slowUntilTick[0] = s.tick + 10;
    // A forged/unresolved id must not throw and must count on NEITHER catalog axis —
    // the same total-over-absent-definition posture `warded`'s join takes.
    s.creeps.creepId[1] = 'nonexistent';

    const rest = s.creeps.id.length - 2;
    expect(deriveHud(s, ruleset).statuses).toEqual({
      slowed: 1,
      poisoned: 0,
      armored: 1,
      stunned: 0,
      airborne: 1,
    });
    expect(rest).toBe(0); // the remaining rows are plain `normal`s and add nothing
  });

  it('the pollable board summary (#79) is derived through the PreviewState path too (paused planning)', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    s.creeps.slowMulFp[0] = 128;
    s.creeps.slowUntilTick[0] = s.tick + 10;
    const { preview } = previewInputs(s, ruleset, []);
    expect(deriveHud(preview, ruleset).statuses.slowed).toBe(1);
  });

  it('projects `warded` as a catalog join (M2-S6): true for a creep whose def carries an immunity, false otherwise — never sim state', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    expect(s.creeps.creepId[0]).toBe('normal'); // no immunities in the shipped catalog
    let vm = deriveViewModel(s, ruleset);
    expect(vm.creeps[0]?.warded).toBe(false);

    s.creeps.creepId[0] = 'resolute'; // shipped with immunities: ['slow']
    vm = deriveViewModel(s, ruleset);
    expect(vm.creeps[0]?.warded).toBe(true);

    // A forged/unresolved creepId must not throw — falls back to `false`, mirroring
    // the adjacent hpFrac join's own posture on an absent definition.
    s.creeps.creepId[0] = 'nonexistent';
    vm = deriveViewModel(s, ruleset);
    expect(vm.creeps[0]?.warded).toBe(false);
  });

  it('projects `boss` as a catalog join (M2-S10): true for the shipped `boss` def, false for `armored` — which shares its hexagon silhouette — and false for a forged id', () => {
    // The ONLY wiring between the shipped catalog and the boss size cue. Without this
    // the join can be replaced by a constant `false` and every other suite stays green
    // while the boss silently renders at every other creep's size (ship-review P2).
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    expect(s.creeps.creepId[0]).toBe('normal'); // no role in the shipped catalog
    let vm = deriveViewModel(s, ruleset);
    expect(vm.creeps[0]?.boss).toBe(false);

    // `armored` is the discriminating case, not a plain creep: it shares the boss's
    // `'hexagon'` silhouette, so `boss` is the only channel separating the two sizes.
    s.creeps.creepId[0] = 'armored';
    vm = deriveViewModel(s, ruleset);
    expect(vm.creeps[0]?.boss).toBe(false);

    s.creeps.creepId[0] = 'boss'; // shipped with role: 'boss'
    vm = deriveViewModel(s, ruleset);
    expect(vm.creeps[0]?.boss).toBe(true);

    // Forged/unresolved id must not throw — falls back to `false`, the same totality
    // posture `warded`/`domain` already take.
    s.creeps.creepId[0] = 'nonexistent';
    vm = deriveViewModel(s, ruleset);
    expect(vm.creeps[0]?.boss).toBe(false);
  });

  it('projects `domain` as a catalog join (M2-S7): `ground` for the shipped `normal` creep, `air` for `flying`, never sim state', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    expect(s.creeps.creepId[0]).toBe('normal');
    let vm = deriveViewModel(s, ruleset);
    expect(vm.creeps[0]?.domain).toBe('ground');

    s.creeps.creepId[0] = 'flying'; // shipped air creep (M2-S7)
    vm = deriveViewModel(s, ruleset);
    expect(vm.creeps[0]?.domain).toBe('air');

    // A forged/unresolved creepId must not throw — falls back to `'ground'`, the same
    // totality rail `warded`'s absent-definition fallback and `hpFrac`'s denominator
    // already take.
    s.creeps.creepId[0] = 'nonexistent';
    vm = deriveViewModel(s, ruleset);
    expect(vm.creeps[0]?.domain).toBe('ground');
  });

  it('projects `poisoned` from live DoT records, many-to-many-ish (M2-S5a P7)', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    for (let i = 0; i < 400 && s.creeps.id.length < 5; i++) s = step(s, ruleset, []);
    expect(s.creeps.id.length).toBe(5);
    const ids = Array.from(s.creeps.id) as number[];
    // Two independent sources DoT the SAME target (ids[0]) — a many-to-one relation —
    // plus a lone record on ids[2]; ids[1]/ids[3]/ids[4] carry no record at all.
    s.dots = [
      {
        targetId: ids[0]!,
        sourceId: 101,
        amount: 2,
        cadenceTicks: 10,
        nextTickTick: s.tick + 10,
        untilTick: s.tick + 60,
      },
      {
        targetId: ids[0]!,
        sourceId: 202,
        amount: 2,
        cadenceTicks: 10,
        nextTickTick: s.tick + 10,
        untilTick: s.tick + 60,
      },
      {
        targetId: ids[2]!,
        sourceId: 303,
        amount: 2,
        cadenceTicks: 10,
        nextTickTick: s.tick + 10,
        untilTick: s.tick + 60,
      },
    ];
    const vm = deriveViewModel(s, ruleset);
    const poisonedById = new Map(vm.creeps.map((c) => [c.id, c.poisoned]));
    expect(poisonedById.get(ids[0]!)).toBe(true);
    expect(poisonedById.get(ids[1]!)).toBe(false);
    expect(poisonedById.get(ids[2]!)).toBe(true);
    expect(poisonedById.get(ids[3]!)).toBe(false);
    expect(poisonedById.get(ids[4]!)).toBe(false);
  });

  it('does not draw a sim-invalid tower row (Codex R3-2: forged towerId is never drawn)', () => {
    let s = createInitialState(1, ruleset);
    const build: SimInput = { kind: 'placeTower', anchor: { col: 3, row: 3 }, towerId: 'basic' };
    s = step(s, ruleset, [build]);
    // Forge the row's towerId to something the catalog doesn't resolve — the sim's own
    // `forEachValidTower` walk (and thus the render VM) must classify it invisible.
    s.towers.towerId[0] = 'nonexistent';
    const vm = deriveViewModel(s, ruleset);
    expect(vm.towers).toHaveLength(0);
  });

  it('resumes counting down once the first wave has launched (wave 2 of 3)', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    const hud = deriveHud(s, ruleset);
    expect(hud.countdownSeconds).toBeGreaterThan(0); // wave 2 is now counting down
    expect(hud.waveCursor).toBe(1);
  });

  it('gives a ragged-HP creep a zero health fraction (no crash)', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    s.creeps.hp[0] = Number.NaN as unknown as number; // corrupt only the HP column
    const c = deriveViewModel(s, ruleset).creeps.find((v) => v.id === s.creeps.id[0]);
    expect(c?.hpFrac).toBe(0);
  });
});

describe('hud wave preview (M2-S2, PLAN.md P3 step 16)', () => {
  it('shows wave 1 of N with the shipped bundle’s single-creep-kind composition, callable true', () => {
    const s = createInitialState(1, ruleset);
    const hud = deriveHud(s, ruleset);
    expect(hud.callable).toBe(true);
    expect(hud.preview).toEqual({
      kind: 'upcoming',
      waveNumber: 1,
      waveCount: ruleset.waves.length,
      entries: [
        {
          creepId: 'normal',
          count: 10,
          domain: 'ground',
          armor: 0,
          leakCost: 1,
          immunities: [],
          boss: false,
        },
      ],
    });
  });

  it('surfaces a paused, queued call as launchPending via previewInputs, disabling callable', () => {
    // `launchPending` is consumed within the tick it's set (the wave phase launches the
    // SAME step() call the input phase queued it in) — it is only OBSERVABLE as pending
    // via `previewInputs`'s projection (a paused client's uncommitted buffer), which is
    // exactly the case `deriveHud` must accept a `PreviewState` for.
    const s = createInitialState(1, ruleset);
    const { preview } = previewInputs(s, ruleset, [{ kind: 'callWaveEarly' }]);
    expect(preview.launchPending).toBe(true);
    const hud = deriveHud(preview, ruleset);
    expect(hud.callable).toBe(false); // buffered call already queued
    expect(hud.preview).toMatchObject({ kind: 'upcoming', waveNumber: 1 });
  });

  it('advances to the next wave’s composition after a real launch', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]); // launches wave 1 this same tick
    const hud = deriveHud(s, ruleset);
    expect(hud.waveCursor).toBe(1);
    expect(hud.preview).toMatchObject({ kind: 'upcoming', waveNumber: 2 });
    expect(hud.callable).toBe(true);
  });

  it('shows the last-wave marker once every wave has launched but the run is still live', () => {
    let s = createInitialState(1, ruleset);
    for (let i = 0; i < ruleset.waves.length; i++) {
      s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    }
    expect(s.waveCursor).toBe(ruleset.waves.length);
    expect(s.phase).toBe('running'); // waves still resolving — not terminal yet
    const hud = deriveHud(s, ruleset);
    expect(hud.preview).toEqual({ kind: 'lastWave' });
    expect(hud.callable).toBe(false); // no more waves to call
  });

  it('is null once the run resolves — the results dialog takes over', () => {
    const lost: SimState = { ...createInitialState(1, ruleset), phase: 'lost', lives: 0 };
    expect(deriveHud(lost, ruleset).preview).toBeNull();
    expect(deriveHud(lost, ruleset).callable).toBe(false);
  });

  it("joins each preview entry's `leakCost` from the catalog (M2-S10): the boss's wave shows 3 for the boss and 1 for its escort, in ONE preview", () => {
    // The ONLY wiring between the shipped catalog and the preview's leak-cost slot.
    // Every other preview assertion in this file happens to sit on a leakCost-1 wave, so
    // without this the join can be replaced by the constant 1 and stay green while the
    // HUD announces "leak cost 1" for the boss forever (ship-review P2). The boss's wave
    // is the mixed one, which also proves the join is PER ENTRY rather than per wave.
    // Located by searching the COMPILED schedule for creep id 'boss' (S11 ruling 1: the
    // wave's INDEX moved when M2-S11 grew the bundle from 8 to 10 waves, so a hardcoded
    // literal would silently retarget onto whatever now sits there).
    const bossWaveIndex = waveIndexForCreep(ruleset, 'boss');
    let s = createInitialState(1, ruleset);
    for (let i = 0; i < bossWaveIndex; i++) s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    const hud = deriveHud(s, ruleset);
    expect(hud.preview).toMatchObject({ kind: 'upcoming', waveNumber: bossWaveIndex + 1 });
    const entries = hud.preview?.kind === 'upcoming' ? hud.preview.entries : [];
    expect(entries.find((e) => e.creepId === 'boss')?.leakCost).toBe(3);
    expect(entries.find((e) => e.creepId === 'normal')?.leakCost).toBe(1);
  });
});

describe('hud wave preview — SYNTHETIC sv6-legal bundle (M2-S2, PLAN.md P3 step 19: the shipped bundle’s three identical single-entry waves cannot catch aggregation/ordering bugs)', () => {
  it('aggregates a duplicate creepId across two entries into ONE summed row, in FIRST-APPEARANCE order (not alphabetical, not catalog order)', () => {
    const s = createInitialState(1, syntheticRuleset);
    const hud = deriveHud(s, syntheticRuleset);
    expect(hud.preview).toEqual({
      kind: 'upcoming',
      waveNumber: 1,
      waveCount: 2,
      entries: [
        {
          creepId: 'armored',
          count: 1,
          domain: 'ground',
          armor: 0,
          leakCost: 1,
          immunities: [],
          boss: false,
        },
        {
          creepId: 'normal',
          count: 3,
          domain: 'ground',
          armor: 0,
          leakCost: 1,
          immunities: [],
          boss: false,
        }, // 2 + 1
      ],
    });
  });

  it('joins each row’s metadata off the CORRECT creep definition — the two kinds are not conflated', () => {
    const s = createInitialState(1, syntheticRuleset);
    const entries = deriveHud(s, syntheticRuleset).preview;
    expect(entries).toMatchObject({
      entries: [
        { creepId: 'armored', count: 1 },
        { creepId: 'normal', count: 3 },
      ],
    });
    // Both rows read `domain`/`armor`/`immunities` off the compiled catalog, not a shared
    // default — distinct hp/speed/bounty per kind (asserted via the compiled ruleset
    // itself, since those axes aren't in the preview) proves the join key is `creepId`.
    expect(syntheticRuleset.creepById['armored']?.hp).toBe(60);
    expect(syntheticRuleset.creepById['normal']?.hp).toBe(20);
  });

  it('advances to wave 2’s single-entry composition after wave 1 launches', () => {
    let s = createInitialState(1, syntheticRuleset);
    s = step(s, syntheticRuleset, [{ kind: 'callWaveEarly' }]);
    const hud = deriveHud(s, syntheticRuleset);
    expect(hud.waveCursor).toBe(1);
    expect(hud.preview).toEqual({
      kind: 'upcoming',
      waveNumber: 2,
      waveCount: 2,
      entries: [
        {
          creepId: 'normal',
          count: 1,
          domain: 'ground',
          armor: 0,
          leakCost: 1,
          immunities: [],
          boss: false,
        },
      ],
    });
  });

  it('shows the last-wave marker once wave 2 (the final wave) launches too', () => {
    let s = createInitialState(1, syntheticRuleset);
    s = step(s, syntheticRuleset, [{ kind: 'callWaveEarly' }]);
    s = step(s, syntheticRuleset, [{ kind: 'callWaveEarly' }]);
    expect(s.waveCursor).toBe(2);
    const hud = deriveHud(s, syntheticRuleset);
    expect(hud.preview).toEqual({ kind: 'lastWave' });
    expect(hud.callable).toBe(false);
  });
});

// #53 — the HUD score is EARNED-SO-FAR while the run is live, and the authoritative
// `deriveScore` total once it resolves. Rendering the terminal formula against a live state
// put `Score: 250` (10 starting lives × survivalMul 25) on screen before a wave had launched,
// and dropped the displayed score by 25 on every leak. These fixtures play real M1 runs
// rather than hand-building states, so they break if the sim's scoring inputs move.
describe('hud score — earned components while live, authoritative once terminal (#53)', () => {
  /** A 2×2 tower flanking the entrance lane: enough to kill, not enough to hold the wave,
   *  so one run yields BOTH an accrued kill bounty and later leaks. */
  const DEFENDER = { col: 3, row: 9 } as const;

  /** A run with a single defender, wave launched. */
  function startDefendedRun(): SimState {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'placeTower', anchor: DEFENDER, towerId: 'basic' }]);
    return step(s, ruleset, [{ kind: 'callWaveEarly' }]);
  }

  /** Step until `done`, so the fixtures key on the state they need rather than on tick
   *  numbers that balance changes would silently invalidate. Throws instead of asserting
   *  against a state that never arrived. */
  function stepUntil(
    from: SimState,
    done: (s: SimState) => boolean,
    limit = 5000,
    r: typeof ruleset = ruleset,
  ): SimState {
    let s = from;
    for (let i = 0; i < limit && !done(s); i++) s = step(s, r, []);
    if (!done(s)) throw new Error(`fixture never reached its target state within ${limit} ticks`);
    return s;
  }

  it('reads 0 on a fresh running (pre-first-launch) state — nothing has been earned yet', () => {
    const s = createInitialState(1, ruleset);
    expect(s.cumulativeKillBounty).toBe(0);
    expect(s.lives).toBeGreaterThan(0); // the survival term would be nonzero if it counted
    expect(deriveHud(s, ruleset).score).toBe(0);
  });

  it('equals the accrued kill bounty PLUS the accrued early-call credit mid-run (M2-S2)', () => {
    // The credit has to come from a wave index >= 1. `startDefendedRun`'s call launches
    // wave 1, and since sv15 (#70) that opening launch pays nothing — so this fixture
    // calls the NEXT wave early once kills have accrued, and it is that call which earns
    // the real credit (divisor 50, sampled from the undecremented countdown). The claim
    // under test is unchanged: the running score is `kb + credit`, not `kb` alone.
    let s = stepUntil(startDefendedRun(), (x) => x.cumulativeKillBounty > 0);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    expect(s.phase).toBe('running');
    expect(s.cumulativeEarlyCallCredit).toBeGreaterThan(0);
    expect(deriveHud(s, ruleset).score).toBe(s.cumulativeKillBounty + s.cumulativeEarlyCallCredit);
  });

  it('does not change when a creep leaks while the run is active', () => {
    const killed = stepUntil(startDefendedRun(), (x) => x.cumulativeKillBounty > 0);
    // `step` mutates in place and returns the SAME state object, so every "before" value
    // must be snapshotted as a primitive here — reading `killed.foo` after the leak below
    // would read the post-leak value and assert nothing.
    const scoreBefore = deriveHud(killed, ruleset).score;
    const bountyBefore = killed.cumulativeKillBounty;
    const livesBefore = killed.lives;
    const leaked = stepUntil(killed, (x) => x.lives < livesBefore);
    expect(leaked.phase).toBe('running'); // still live, not resolved by the leak
    expect(leaked.cumulativeKillBounty).toBe(bountyBefore); // the leak cost a life, not a kill
    expect(deriveHud(leaked, ruleset).score).toBe(scoreBefore);
  });

  it('folds the survival term in at a win, matching deriveScore exactly', () => {
    // This fixture used to script a defense against the SHIPPED bundle. M2-S11 grew that
    // bundle from 8 to 10 waves (retuned `antiair` cadence + `survivalMul` along the
    // way), and the scripted wall above no longer wins the ten-wave arc within the
    // `stepUntil` budget — chasing a fresh tuned defense against a bundle that keeps
    // growing is exactly the kind of pin this test doesn't need: its claim
    // ("hud score equals `deriveScore` at a win, survival term included") is
    // bundle-agnostic. Moved onto the file's own SYNTHETIC sv6-legal bundle (the "hud
    // wave preview — SYNTHETIC" describe block's precedent above), which wins trivially
    // and needs no re-tuning as the shipped content grows. Board is `wave-preview-board`
    // (9×5); `buildGrid` blocks the whole border ring except the entrance/exit openings
    // (board.ts), so the only buildable interior is cols 1-7 × rows 1-3 — two `basic`
    // towers there (measured-valid anchors, non-overlapping 2×2 footprints, maze
    // invariant intact) flank the row-2 lane and clear both waves (1 `armored` + 3
    // `normal` in wave 0, 1 `normal` in wave 1) with kills and lives to spare (measured:
    // 8 of 10 lives remaining) — this fixture only needs SOME win with SOME kill, not a
    // tuned one.
    let s = createInitialState(1, syntheticRuleset);
    for (const anchor of [
      { col: 2, row: 1 },
      { col: 5, row: 2 },
    ] as const) {
      s = step(s, syntheticRuleset, [{ kind: 'placeTower', anchor, towerId: 'basic' }]);
    }
    s = step(s, syntheticRuleset, [{ kind: 'callWaveEarly' }]);
    const won = stepUntil(s, (x) => x.phase === 'won', 10_000, syntheticRuleset);
    expect(won.cumulativeKillBounty).toBeGreaterThan(0);
    expect(won.lives).toBeGreaterThan(0);
    const score = deriveHud(won, syntheticRuleset).score;
    expect(score).toBe(deriveScore(won, syntheticRuleset));
    // The terminal number is strictly more than the earned component — i.e. the survival
    // term really is credited here and was really excluded before.
    expect(score).toBeGreaterThan(won.cumulativeKillBounty);
  });

  it('keeps the kill component at a loss, where the survival term contributes zero', () => {
    // A played-out M1 loss WITH kills is unreachable: the wave is 10 creeps against 10
    // lives, so any kill leaves at least one life and the run resolves `won`. Take a real
    // run that accrued a kill and drive it to the terminal loss state directly (PLAN.md
    // step 4 sanctions this) — a zero-kill loss would pass vacuously against a hardcoded 0.
    const run = stepUntil(startDefendedRun(), (x) => x.cumulativeKillBounty > 0);
    // Forge a COPY into the loss state rather than mutating the sim's own object —
    // render code (tests included) reads sim state, never writes it (AGENTS.md layering).
    const lost: SimState = { ...run, lives: 0, phase: 'lost' };
    expect(deriveScore(lost, ruleset)).toBe(lost.cumulativeKillBounty); // survival term is 0
    expect(deriveHud(lost, ruleset).score).toBe(deriveScore(lost, ruleset));
    expect(deriveHud(lost, ruleset).score).toBeGreaterThan(0);
  });

  it('reads 0 rather than NaN if the accumulator is ragged, matching deriveScore’s guard', () => {
    const ragged: SimState = {
      ...createInitialState(1, ruleset),
      cumulativeKillBounty: Number.NaN,
    };
    expect(deriveHud(ragged, ruleset).score).toBe(0);
  });
});

describe('interpolation — by entity id', () => {
  const vm = (tick: number, creeps: RenderVM['creeps']): RenderVM => ({
    tick,
    phase: 'running',
    creeps,
    towers: [],
  });

  it('blends a creep present in both snapshots by its id', () => {
    const prev = vm(0, [
      {
        id: 1,
        creepId: 'normal',
        domain: 'ground',
        x: 0,
        y: 0,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
    const cur = vm(1, [
      {
        id: 1,
        creepId: 'normal',
        domain: 'ground',
        x: 100,
        y: 40,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
    const out = interpolateCreeps(prev, cur, 0.5);
    expect(out).toEqual([
      {
        id: 1,
        creepId: 'normal',
        domain: 'ground',
        x: 50,
        y: 20,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
  });

  it('the blend path snaps NON-DEFAULT creepId/slowed from the CURRENT snapshot (QC round 1 — a rebuild that dropped or defaulted the new fields would pass the all-defaults case above)', () => {
    const prev = vm(0, [
      {
        id: 1,
        creepId: 'fast',
        domain: 'ground',
        x: 0,
        y: 0,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
    const cur = vm(1, [
      {
        id: 1,
        creepId: 'fast',
        domain: 'ground',
        x: 100,
        y: 40,
        hpFrac: 0.5,
        slowed: true,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
    const out = interpolateCreeps(prev, cur, 0.5);
    expect(out).toEqual([
      {
        id: 1,
        creepId: 'fast',
        domain: 'ground',
        x: 50,
        y: 20,
        hpFrac: 0.5,
        slowed: true,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
  });

  it('snaps `poisoned` from the CURRENT snapshot on a genuinely-interpolated frame (M2-S5a P7 — guards a field-by-field rebuild silently dropping it)', () => {
    const prev = vm(0, [
      {
        id: 1,
        creepId: 'normal',
        domain: 'ground',
        x: 0,
        y: 0,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
    const cur = vm(1, [
      {
        id: 1,
        creepId: 'normal',
        domain: 'ground',
        x: 100,
        y: 40,
        hpFrac: 1,
        slowed: false,
        poisoned: true,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
    const out = interpolateCreeps(prev, cur, 0.5);
    expect(out).toEqual([
      {
        id: 1,
        creepId: 'normal',
        domain: 'ground',
        x: 50,
        y: 20,
        hpFrac: 1,
        slowed: false,
        poisoned: true,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
  });

  it('snaps `stunned`/`warded` from the CURRENT snapshot on a genuinely-interpolated frame (M2-S6 — guards a field-by-field rebuild silently dropping either)', () => {
    const prev = vm(0, [
      {
        id: 1,
        creepId: 'resolute',
        domain: 'ground',
        x: 0,
        y: 0,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: false,
        warded: true,
        boss: false,
      },
    ]);
    const cur = vm(1, [
      {
        id: 1,
        creepId: 'resolute',
        domain: 'ground',
        x: 100,
        y: 40,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: true,
        warded: true,
        boss: false,
      },
    ]);
    const out = interpolateCreeps(prev, cur, 0.5);
    expect(out).toEqual([
      {
        id: 1,
        creepId: 'resolute',
        domain: 'ground',
        x: 50,
        y: 20,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: true,
        warded: true,
        boss: false,
      },
    ]);
  });

  it('shows a just-spawned creep (only in current) at its current point, no blend', () => {
    const prev = vm(0, []);
    const cur = vm(1, [
      {
        id: 7,
        creepId: 'normal',
        domain: 'ground',
        x: 12,
        y: 34,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
    expect(interpolateCreeps(prev, cur, 0.5)).toEqual([
      {
        id: 7,
        creepId: 'normal',
        domain: 'ground',
        x: 12,
        y: 34,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
  });

  it('does not resurrect a creep that left the world (only in previous)', () => {
    const prev = vm(0, [
      {
        id: 1,
        creepId: 'normal',
        domain: 'ground',
        x: 0,
        y: 0,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
    const cur = vm(1, []);
    expect(interpolateCreeps(prev, cur, 0.5)).toEqual([]);
  });

  it('clamps a stale/overshooting alpha to [0,1]', () => {
    const prev = vm(0, [
      {
        id: 1,
        creepId: 'normal',
        domain: 'ground',
        x: 0,
        y: 0,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
    const cur = vm(1, [
      {
        id: 1,
        creepId: 'normal',
        domain: 'ground',
        x: 100,
        y: 0,
        hpFrac: 1,
        slowed: false,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: false,
      },
    ]);
    expect(interpolateCreeps(prev, cur, 2).at(0)?.x).toBe(100);
    expect(interpolateCreeps(prev, cur, -1).at(0)?.x).toBe(0);
    expect(interpolateCreeps(null, cur, NaN).at(0)?.x).toBe(100); // null prev → current
  });
});

describe('palette — colourblind modes (GAG §2)', () => {
  it('provides a full, distinct palette for every selectable mode', () => {
    const modes: ColourMode[] = ['default', 'protan', 'deutan', 'tritan'];
    for (const m of modes) {
      const p = resolvePalette(m);
      // every semantic role is a real colour, and valid/invalid cues differ
      for (const role of Object.values(p)) expect(typeof role).toBe('number');
      expect(p.ghostValid).not.toBe(p.ghostInvalid);
      expect(p.creep).not.toBe(p.tower);
    }
  });

  it('shifts the tower/creep hues off the red–green axis for protan/deutan', () => {
    expect(resolvePalette('protan')).toEqual(resolvePalette('deutan'));
    expect(resolvePalette('protan').tower).not.toBe(resolvePalette('default').tower);
  });

  it('falls back to the base palette for an unknown mode', () => {
    expect(resolvePalette('nonsense' as ColourMode)).toEqual(resolvePalette('default'));
  });
});

describe('render barrel', () => {
  it('re-exports the pure modules (and no Phaser)', () => {
    expect(barrel.createProjection).toBeTypeOf('function');
    expect(barrel.deriveViewModel).toBeTypeOf('function');
    expect(barrel.deriveHud).toBeTypeOf('function');
    expect(barrel.interpolateCreeps).toBeTypeOf('function');
    expect(barrel.resolvePalette).toBeTypeOf('function');
  });
});
