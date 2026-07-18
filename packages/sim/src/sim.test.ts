// sim.test.ts — smoke + determinism for the headless simulation.

import { describe, it, expect } from 'vitest';
import { createInitialState, step, hashSimState, type SimInput, type SimState } from './index';

/** Drive a full match from a seed and a fixed input schedule, hashing each tick. */
function run(seed: number, ticks: number): { state: SimState; trace: string } {
  let state = createInitialState(seed);
  const hashes: string[] = [];
  for (let t = 0; t < ticks; t++) {
    // Spawn a creep every 4th tick; otherwise no input.
    const inputs: SimInput[] = t % 4 === 0 ? [{ kind: 'spawnCreep', hp: 10, lane: 2 }] : [];
    state = step(state, inputs);
    hashes.push(hashSimState(state));
  }
  return { state, trace: hashes.join(':') };
}

describe('sim smoke', () => {
  it('starts with lives and no creeps', () => {
    const s = createInitialState(1);
    expect(s.tick).toBe(0);
    expect(s.lives).toBe(20);
    expect(s.creeps.id).toHaveLength(0);
  });

  it('spawns creeps that advance and eventually leak, costing lives', () => {
    const { state } = run(12345, 120);
    expect(state.tick).toBe(120);
    // Some creeps have reached the exit over 120 ticks.
    expect(state.lives).toBeLessThan(20);
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
    expect(run(12345, 200).trace).not.toBe(run(54321, 200).trace);
  });
});
