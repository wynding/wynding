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
  type SimInput,
  type SimState,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from '@wynding/content';
import { createProjection } from './projection';
import { deriveViewModel, deriveHud } from './view-model';
import { interpolateCreeps } from './interpolate';
import { resolvePalette } from './palette';
import type { ColourMode, RenderVM } from './types';
import * as barrel from './index';

const bundle = getBundledRuleset();
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));

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

  it('gives a ragged-HP creep a zero health fraction (no crash)', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    s.creeps.hp[0] = Number.NaN as unknown as number; // corrupt only the HP column
    const c = deriveViewModel(s, ruleset).creeps.find((v) => v.id === s.creeps.id[0]);
    expect(c?.hpFrac).toBe(0);
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
    s = step(s, ruleset, [{ kind: 'placeTower', anchor: DEFENDER }]);
    return step(s, ruleset, [{ kind: 'callWaveEarly' }]);
  }

  /** Step until `done`, so the fixtures key on the state they need rather than on tick
   *  numbers that balance changes would silently invalidate. Throws instead of asserting
   *  against a state that never arrived. */
  function stepUntil(from: SimState, done: (s: SimState) => boolean, limit = 5000): SimState {
    let s = from;
    for (let i = 0; i < limit && !done(s); i++) s = step(s, ruleset, []);
    if (!done(s)) throw new Error(`fixture never reached its target state within ${limit} ticks`);
    return s;
  }

  it('reads 0 on a fresh pre-wave state — nothing has been earned yet', () => {
    const s = createInitialState(1, ruleset);
    expect(s.cumulativeKillBounty).toBe(0);
    expect(s.lives).toBeGreaterThan(0); // the survival term would be nonzero if it counted
    expect(deriveHud(s, ruleset).score).toBe(0);
  });

  it('equals the accrued kill bounty mid-run', () => {
    const s = stepUntil(startDefendedRun(), (x) => x.cumulativeKillBounty > 0);
    expect(s.phase).toBe('active');
    expect(deriveHud(s, ruleset).score).toBe(s.cumulativeKillBounty);
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
    expect(leaked.phase).toBe('active'); // still live, not resolved by the leak
    expect(leaked.cumulativeKillBounty).toBe(bountyBefore); // the leak cost a life, not a kill
    expect(deriveHud(leaked, ruleset).score).toBe(scoreBefore);
  });

  it('folds the survival term in at a win, matching deriveScore exactly', () => {
    let s = createInitialState(1, ruleset);
    for (const anchor of [
      { col: 3, row: 9 },
      { col: 3, row: 12 },
    ] as const) {
      s = step(s, ruleset, [{ kind: 'placeTower', anchor }]);
    }
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    const won = stepUntil(s, (x) => x.phase === 'won');
    expect(won.cumulativeKillBounty).toBeGreaterThan(0);
    expect(won.lives).toBeGreaterThan(0);
    const score = deriveHud(won, ruleset).score;
    expect(score).toBe(deriveScore(won, ruleset));
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
    phase: 'active',
    creeps,
    towers: [],
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
