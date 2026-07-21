// sim.test.ts — smoke + determinism for the headless simulation.

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  step,
  hashSimState,
  loadBoard,
  type BoardContext,
  type CreepArrays,
  type SimInput,
  type SimState,
} from './index';

/** A small straight board: entrance (0,2) → exit (4,2), four orthogonal edges. */
const BOARD: BoardContext = loadBoard({
  widthTiles: 5,
  heightTiles: 5,
  entrance: { col: 0, row: 2 },
  exit: { col: 4, row: 2 },
});

/** Drive a full match from a seed and a fixed input schedule, hashing each tick. */
function run(seed: number, ticks: number): { state: SimState; trace: string } {
  let state = createInitialState(seed);
  const hashes: string[] = [];
  for (let t = 0; t < ticks; t++) {
    // Spawn a creep every 4th tick; otherwise no input.
    const inputs: SimInput[] = t % 4 === 0 ? [{ kind: 'spawnCreep', hp: 10 }] : [];
    state = step(state, inputs, BOARD);
    hashes.push(hashSimState(state));
  }
  return { state, trace: hashes.join(':') };
}

describe('sim smoke', () => {
  it('starts with lives and no creeps', () => {
    const s = createInitialState(1);
    expect(s.tick).toBe(0);
    expect(s.lives).toBe(10);
    expect(s.creeps.id).toHaveLength(0);
  });

  it('treats noop inputs as no input at all', () => {
    const s = createInitialState(7);
    step(s, [{ kind: 'noop' }], BOARD);
    expect(s.tick).toBe(1);
    expect(s.creeps.id).toHaveLength(0);
    expect(s.lives).toBe(10);
  });

  it('spawns a creep at the entrance and moves it the same tick', () => {
    const s = createInitialState(1);
    step(s, [{ kind: 'spawnCreep', hp: 7 }], BOARD);
    expect(s.creeps.id).toHaveLength(1);
    expect(s.creeps.hp[0]).toBe(7);
    expect(s.creeps.col[0]).toBe(0); // still on the entrance cell...
    expect(s.creeps.row[0]).toBe(2);
    expect(s.creeps.edgeProgress[0]).toBe(26); // ...one budget into the first edge
  });

  it('defensively drops creep rows whose parallel arrays are out of sync', () => {
    // Each corruption knocks out one column of the structure-of-arrays store;
    // step() must skip the ragged row without leaking a life or crashing.
    const corruptions: ReadonlyArray<(c: CreepArrays) => void> = [
      (c) => (c.id = new Array<number>(1)), // id[0] is a hole
      (c) => (c.hp = []),
      (c) => (c.col = []),
      (c) => (c.row = []),
      (c) => (c.edgeProgress = []),
    ];
    for (const corrupt of corruptions) {
      const s = createInitialState(1);
      s.creeps = { id: [1], hp: [5], col: [1], row: [2], edgeProgress: [0] };
      corrupt(s.creeps);
      const out = step(s, [], BOARD);
      expect(out.creeps.id).toHaveLength(0);
      expect(out.lives).toBe(10);
    }
  });

  it('spawns creeps that advance and eventually leak, costing lives', () => {
    const { state } = run(12345, 120);
    expect(state.tick).toBe(120);
    // Some creeps have crossed the four-cell board over 120 ticks.
    expect(state.lives).toBeLessThan(10);
  });
});

describe('sim determinism', () => {
  it('two runs from the same seed produce byte-identical tick traces', () => {
    const a = run(12345, 200);
    const b = run(12345, 200);
    expect(a.trace).toBe(b.trace);
    expect(hashSimState(a.state)).toBe(hashSimState(b.state));
  });

  it('different seeds diverge', () => {
    // Movement itself is seed-independent in M1, but the seed lives in the hashed
    // state (rngState, carried unchanged for a future stochastic mechanic), so two
    // seeds still produce distinct world-hash traces.
    expect(run(12345, 200).trace).not.toBe(run(54321, 200).trace);
  });
});
