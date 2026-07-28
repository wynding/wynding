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
    const build: SimInput = { kind: 'placeTower', anchor: { col: 3, row: 3 } };
    s = step(s, ruleset, [build]);
    const vm = deriveViewModel(s, ruleset);
    expect(vm.towers).toHaveLength(1);
    expect(vm.towers[0]).toMatchObject({ col: 3, row: 3 });
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
      entries: [{ creepId: 'normal', count: 10, domain: 'ground', armor: 0, immunities: [] }],
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
        { creepId: 'armored', count: 1, domain: 'ground', armor: 0, immunities: [] },
        { creepId: 'normal', count: 3, domain: 'ground', armor: 0, immunities: [] }, // 2 + 1
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
      entries: [{ creepId: 'normal', count: 1, domain: 'ground', armor: 0, immunities: [] }],
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

  it('reads 0 on a fresh running (pre-first-launch) state — nothing has been earned yet', () => {
    const s = createInitialState(1, ruleset);
    expect(s.cumulativeKillBounty).toBe(0);
    expect(s.lives).toBeGreaterThan(0); // the survival term would be nonzero if it counted
    expect(deriveHud(s, ruleset).score).toBe(0);
  });

  it('equals the accrued kill bounty PLUS the accrued early-call credit mid-run (M2-S2)', () => {
    // `startDefendedRun` early-calls wave 1 at tick 0, which earns a real early-call
    // credit at launch (the divisor is 50, sampled from the undecremented countdown) —
    // the running score is `kb + credit`, not `kb` alone, once M2-S2's credit accrues.
    const s = stepUntil(startDefendedRun(), (x) => x.cumulativeKillBounty > 0);
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
    let s = createInitialState(1, ruleset);
    for (const anchor of [
      { col: 3, row: 9 },
      { col: 3, row: 12 },
    ] as const) {
      s = step(s, ruleset, [{ kind: 'placeTower', anchor }]);
    }
    // Early-call only wave 1 — the later waves auto-launch on their own countdown
    // (300 ticks each, chained off the prior wave's LAUNCH per PLAN.md's flip-tick rule),
    // which the fixed defense clears within the `stepUntil` budget below.
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    const won = stepUntil(s, (x) => x.phase === 'won', 10_000);
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
    phase: 'running',
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
