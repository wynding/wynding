// render.test.ts — the presentation layer's PURE modules: projection geometry + its
// pointer inverse, view-model/hud derivation from SimState, and id-matched
// interpolation + impact-spark diffing. No Phaser, no DOM.

import { describe, it, expect } from 'vitest';
import { FP_ONE } from '@wynding/engine';
import { createInitialState, step, compileRuleset, type SimInput } from '@wynding/sim';
import { m1Ruleset, M1_BOARD_ID } from '@wynding/content';
import { createProjection } from './projection';
import { deriveViewModel, deriveHud } from './view-model';
import { interpolateCreeps, resolvedImpactPoints } from './interpolate';
import { resolvePalette } from './palette';
import type { ColourMode, RenderVM } from './types';
import * as barrel from './index';

const ruleset = compileRuleset(m1Ruleset, M1_BOARD_ID);

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
  it('derives HUD countdown/score/stars from a fresh pre-wave state', () => {
    const s = createInitialState(1, ruleset);
    const hud = deriveHud(s, ruleset);
    expect(hud.phase).toBe('pre-wave');
    expect(hud.lives).toBe(ruleset.balance.startingLives);
    expect(hud.bounty).toBe(ruleset.balance.startingBounty);
    expect(hud.countdownSeconds).toBeGreaterThan(0); // counting down pre-launch
    expect(hud.stars).toBe(0);
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
    expect(vm.phase).toBe('active');
  });

  it('includes placed towers in the view-model', () => {
    let s = createInitialState(1, ruleset);
    const build: SimInput = { kind: 'placeTower', anchor: { col: 3, row: 3 } };
    s = step(s, ruleset, [build]);
    const vm = deriveViewModel(s, ruleset);
    expect(vm.towers).toHaveLength(1);
    expect(vm.towers[0]).toMatchObject({ col: 3, row: 3 });
  });

  it('hides the countdown once the wave is active (null)', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    expect(deriveHud(s, ruleset).countdownSeconds).toBeNull();
  });

  it('carries in-flight impacts into the view-model', () => {
    // A tower straddling the lane fires as creeps arrive → impacts get scheduled.
    let s = createInitialState(1, ruleset);
    const b = ruleset.board.grid;
    const onLane: SimInput = {
      kind: 'placeTower',
      anchor: { col: b.entrance.col + 2, row: b.entrance.row - 1 },
    };
    s = step(s, ruleset, [onLane, { kind: 'callWaveEarly' }]);
    let sawImpact = false;
    for (let t = 0; t < 120 && !sawImpact; t++) {
      s = step(s, ruleset, []);
      if (deriveViewModel(s, ruleset).impacts.length > 0) sawImpact = true;
    }
    expect(sawImpact).toBe(true);
  });

  it('gives a ragged-HP creep a zero health fraction (no crash)', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    s.creeps.hp[0] = Number.NaN as unknown as number; // corrupt only the HP column
    const c = deriveViewModel(s, ruleset).creeps.find((v) => v.id === s.creeps.id[0]);
    expect(c?.hpFrac).toBe(0);
  });
});

describe('interpolation — by entity id', () => {
  const vm = (
    tick: number,
    creeps: RenderVM['creeps'],
    impacts: RenderVM['impacts'] = [],
  ): RenderVM => ({
    tick,
    phase: 'active',
    creeps,
    towers: [],
    impacts,
  });

  it('blends a creep present in both snapshots by its id', () => {
    const prev = vm(0, [{ id: 1, x: 0, y: 0, hpFrac: 1 }]);
    const cur = vm(1, [{ id: 1, x: 100, y: 40, hpFrac: 1 }]);
    const out = interpolateCreeps(prev, cur, 0.5);
    expect(out).toEqual([{ id: 1, x: 50, y: 20, hpFrac: 1 }]);
  });

  it('shows a just-spawned creep (only in current) at its current point, no blend', () => {
    const prev = vm(0, []);
    const cur = vm(1, [{ id: 7, x: 12, y: 34, hpFrac: 1 }]);
    expect(interpolateCreeps(prev, cur, 0.5)).toEqual([{ id: 7, x: 12, y: 34, hpFrac: 1 }]);
  });

  it('does not resurrect a creep that left the world (only in previous)', () => {
    const prev = vm(0, [{ id: 1, x: 0, y: 0, hpFrac: 1 }]);
    const cur = vm(1, []);
    expect(interpolateCreeps(prev, cur, 0.5)).toEqual([]);
  });

  it('clamps a stale/overshooting alpha to [0,1]', () => {
    const prev = vm(0, [{ id: 1, x: 0, y: 0, hpFrac: 1 }]);
    const cur = vm(1, [{ id: 1, x: 100, y: 0, hpFrac: 1 }]);
    expect(interpolateCreeps(prev, cur, 2).at(0)?.x).toBe(100);
    expect(interpolateCreeps(prev, cur, -1).at(0)?.x).toBe(0);
    expect(interpolateCreeps(null, cur, NaN).at(0)?.x).toBe(100); // null prev → current
  });
});

describe('impact-spark diffing (multiset by (targetId, impactTick))', () => {
  const vm = (creeps: RenderVM['creeps'], impacts: RenderVM['impacts']): RenderVM => ({
    tick: 0,
    phase: 'active',
    creeps,
    towers: [],
    impacts,
  });

  it('sparks at the CURRENT point of a creep that survived the hit (on it, not a tick behind)', () => {
    const prev = vm([{ id: 5, x: 20, y: 30, hpFrac: 1 }], [{ targetId: 5, impactTick: 10 }]);
    const cur = vm([{ id: 5, x: 25, y: 30, hpFrac: 1 }], []); // survivor moved on; impact consumed
    expect(resolvedImpactPoints(prev, cur)).toEqual([{ x: 25, y: 30 }]);
  });

  it('falls back to the previous point for a creep that died this tick', () => {
    const prev = vm([{ id: 5, x: 20, y: 30, hpFrac: 0.1 }], [{ targetId: 5, impactTick: 10 }]);
    const cur = vm([], []); // creep gone from cur → use its last-known point
    expect(resolvedImpactPoints(prev, cur)).toEqual([{ x: 20, y: 30 }]);
  });

  it('suppresses the spark when the target had already left', () => {
    const prev = vm([], [{ targetId: 9, impactTick: 10 }]); // no point for target 9
    const cur = vm([], []);
    expect(resolvedImpactPoints(prev, cur)).toEqual([]);
  });

  it('does not spark for an impact still pending next tick', () => {
    const prev = vm([{ id: 5, x: 0, y: 0, hpFrac: 1 }], [{ targetId: 5, impactTick: 10 }]);
    const cur = vm([{ id: 5, x: 0, y: 0, hpFrac: 1 }], [{ targetId: 5, impactTick: 10 }]);
    expect(resolvedImpactPoints(prev, cur)).toEqual([]);
  });

  it('returns nothing when there is no previous snapshot', () => {
    const cur = vm([], [{ targetId: 1, impactTick: 2 }]);
    expect(resolvedImpactPoints(null, cur)).toEqual([]);
  });

  it('short-circuits when the previous snapshot had no impacts (no-combat tick)', () => {
    const prev = vm([{ id: 5, x: 20, y: 30, hpFrac: 1 }], []); // non-null prev, no impacts
    const cur = vm([{ id: 5, x: 25, y: 30, hpFrac: 1 }], []);
    expect(resolvedImpactPoints(prev, cur)).toEqual([]);
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
    expect(barrel.resolvedImpactPoints).toBeTypeOf('function');
    expect(barrel.resolvePalette).toBeTypeOf('function');
  });
});
