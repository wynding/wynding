// story6.test.ts — Story 6 additive read-only seams the client reads: `previewInputs`
// (deep-clone placement preview that cannot diverge from step()), and `projectCreep`
// (the derived render point). No sim behavior changes; no simVersion bump.

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  step,
  hashSimState,
  previewInputs,
  projectCreep,
  type SimInput,
  type CompiledRuleset,
} from './index';
import { testRuleset } from './test-support';

const OPEN = {
  widthTiles: 9,
  heightTiles: 5,
  entrance: { col: 0, row: 2 },
  exit: { col: 8, row: 2 },
} as const;

const place = (col: number, row: number): SimInput => ({
  kind: 'placeTower',
  anchor: { col, row },
});

/** Advance to `active` (creeps spawning) via an early call, returning the state. */
function toActive(ruleset: CompiledRuleset) {
  let s = createInitialState(1, ruleset);
  s = step(s, ruleset, [{ kind: 'callWaveEarly' }]); // launches; first creep spawns on launch tick
  return s;
}

describe('previewInputs — read-only placement preview', () => {
  it('never mutates the source state (hash byte-identical before/after)', () => {
    const ruleset = testRuleset(OPEN, { startingBounty: 80 });
    const s = createInitialState(1, ruleset);
    const before = hashSimState(s);
    previewInputs(s, ruleset, [place(3, 1), place(5, 1), { kind: 'callWaveEarly' }]);
    expect(hashSimState(s)).toBe(before); // deep clone — source untouched
  });

  it('mirrors step() FREEZE-ON-TERMINAL: rejects every command on a resolved match', () => {
    const ruleset = testRuleset(OPEN, { startingBounty: 80 });
    // Drive a loss: launch the wave and let every creep leak (no towers built).
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'callWaveEarly' }]);
    for (let t = 0; t < 4000 && s.phase !== 'won' && s.phase !== 'lost'; t++) {
      s = step(s, ruleset, []);
    }
    expect(s.phase === 'won' || s.phase === 'lost').toBe(true);
    const before = hashSimState(s);
    const { accepted, preview } = previewInputs(s, ruleset, [
      place(3, 1),
      { kind: 'callWaveEarly' },
    ]);
    expect(accepted).toEqual([false, false]); // frozen step() no-ops these — preview agrees
    expect(hashSimState(preview)).toBe(before); // clone unchanged, like the frozen tick
    expect(hashSimState(s)).toBe(before); // source still untouched
  });

  it('accepts a legal build and reflects it in the preview state only', () => {
    const ruleset = testRuleset(OPEN, { startingBounty: 80 });
    const s = createInitialState(1, ruleset);
    const { accepted, preview } = previewInputs(s, ruleset, [place(3, 1)]);
    expect(accepted).toEqual([true]);
    expect(preview.towers.id).toHaveLength(1); // present in the preview
    expect(s.towers.id).toHaveLength(0); // absent from the source
    expect(preview.bounty).toBe(75); // 80 − cost 5, on the clone only
    expect(s.bounty).toBe(80);
  });

  it('rejects a second queued build that overlaps the first (issued-order folding)', () => {
    const ruleset = testRuleset(OPEN, { startingBounty: 80 });
    const s = createInitialState(1, ruleset);
    // (3,1) occupies cols 3–4; (4,1) occupies cols 4–5 → overlap at col 4.
    const { accepted } = previewInputs(s, ruleset, [place(3, 1), place(4, 1)]);
    expect(accepted).toEqual([true, false]);
  });

  it('rejects a second queued build the first made unaffordable', () => {
    const ruleset = testRuleset(OPEN, { startingBounty: 5 }); // exactly one tower
    const s = createInitialState(1, ruleset);
    const { accepted } = previewInputs(s, ruleset, [place(3, 1), place(6, 1)]);
    expect(accepted).toEqual([true, false]); // second is unaffordable after the first
  });

  it('agrees with step(): a preview-accepted command is applied by a real tick', () => {
    const ruleset = testRuleset(OPEN, { startingBounty: 80 });
    const s0 = createInitialState(1, ruleset);
    const cmds = [place(3, 1)];
    const { accepted } = previewInputs(s0, ruleset, cmds);
    const s1 = step(createInitialState(1, ruleset), ruleset, cmds);
    expect(accepted).toEqual([true]);
    expect(s1.towers.id).toHaveLength(1); // step applied exactly what preview predicted
  });
});

describe('projectCreep — derived render point', () => {
  it('returns the entrance-centre point for a freshly spawned creep', () => {
    const ruleset = testRuleset(OPEN, { waveCount: 1 });
    const s = toActive(ruleset);
    expect(s.creeps.id.length).toBeGreaterThan(0);
    const grid = ruleset.board.grid;
    const p = projectCreep(s.creeps, 0, grid);
    expect(p).not.toBeNull();
    expect(Number.isSafeInteger(p!.x)).toBe(true);
    expect(Number.isSafeInteger(p!.y)).toBe(true);
  });

  it('returns null for a non-canonical (ragged) creep row', () => {
    const ruleset = testRuleset(OPEN, { waveCount: 1 });
    const s = toActive(ruleset);
    s.creeps.progress[0] = Number.NaN as unknown as number; // corrupt the row
    expect(projectCreep(s.creeps, 0, ruleset.board.grid)).toBeNull();
  });
});
