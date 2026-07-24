// sim.test.ts — smoke + determinism for the headless simulation.

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  step,
  hashSimState,
  type CreepArrays,
  type SimInput,
  type SimState,
  type StepEvents,
} from './index';
import { testRuleset } from './test-support';

/** A small straight board: entrance (0,2) → exit (4,2), four orthogonal edges. */
const RULESET = testRuleset({
  widthTiles: 5,
  heightTiles: 5,
  entrance: { col: 0, row: 2 },
  exit: { col: 4, row: 2 },
});

const callEarly: SimInput[] = [{ kind: 'callWaveEarly' }];

/** Drive a full match from a seed, calling the wave early at tick 0, hashing each tick. */
function run(seed: number, ticks: number): { state: SimState; trace: string } {
  let state = createInitialState(seed, RULESET);
  const hashes: string[] = [];
  for (let t = 0; t < ticks; t++) {
    state = step(state, RULESET, t === 0 ? callEarly : []);
    hashes.push(hashSimState(state));
  }
  return { state, trace: hashes.join(':') };
}

describe('sim smoke', () => {
  it('starts with lives, no creeps, pre-wave', () => {
    const s = createInitialState(1, RULESET);
    expect(s.tick).toBe(0);
    expect(s.lives).toBe(10);
    expect(s.phase).toBe('pre-wave');
    expect(s.creeps.id).toHaveLength(0);
  });

  it('treats noop inputs as no input at all', () => {
    const s = createInitialState(7, RULESET);
    step(s, RULESET, [{ kind: 'noop' }]);
    expect(s.tick).toBe(1);
    expect(s.creeps.id).toHaveLength(0);
    expect(s.lives).toBe(10);
  });

  it('launches on an early call: spawns the first creep at the entrance and moves it the same tick', () => {
    const s = createInitialState(1, RULESET);
    step(s, RULESET, callEarly);
    expect(s.phase).toBe('active');
    expect(s.launchTick).toBe(0);
    expect(s.creeps.id).toHaveLength(1);
    expect(s.creeps.hp[0]).toBe(20); // catalog hp
    expect(s.creeps.bounty[0]).toBe(1); // resolved from kind
    expect(s.creeps.speed[0]).toBe(26);
    expect(s.creeps.fromX[0]).toBe(0 * 256 + 128); // from-point still on the entrance centre...
    expect(s.creeps.fromY[0]).toBe(2 * 256 + 128);
    expect(s.creeps.progress[0]).toBe(26); // ...one budget into the first edge
    expect(s.creeps.headCol[0]).toBe(1); // committed toward the next cell east
    expect(s.creeps.headRow[0]).toBe(2);
  });

  it('ignores an unknown/malformed command as a deterministic no-op', () => {
    const s = createInitialState(1, RULESET);
    const bad = [
      { kind: 'spawnCreep', hp: 5 }, // no longer a command — spawns come from the schedule
      { kind: 'bogus' },
      null,
      42,
    ] as unknown as SimInput[];
    step(s, RULESET, bad);
    expect(s.creeps.id).toHaveLength(0);
    expect(s.nextEntityId).toBe(1);
    expect(s.tick).toBe(1);
  });

  it('defensively drops creep rows whose parallel arrays are out of sync', () => {
    const corruptions: ReadonlyArray<(c: CreepArrays) => void> = [
      (c) => (c.id = new Array<number>(1)), // id[0] is a hole
      (c) => (c.hp = []),
      (c) => (c.bounty = []),
      (c) => (c.speed = []),
      (c) => (c.fromX = []),
      (c) => (c.fromY = []),
      (c) => (c.headCol = []),
      (c) => (c.headRow = []),
      (c) => (c.progress = []),
    ];
    for (const corrupt of corruptions) {
      const s = createInitialState(1, RULESET);
      s.creeps = {
        id: [1],
        hp: [5],
        bounty: [1],
        speed: [26],
        fromX: [1 * 256 + 128],
        fromY: [2 * 256 + 128],
        headCol: [1],
        headRow: [2],
        progress: [0],
      };
      corrupt(s.creeps);
      const out = step(s, RULESET, []);
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

  it('different seeds share the movement trace but differ in hashed rngState', () => {
    // Movement is seed-independent in M1, but the seed lives in the hashed state, so
    // two seeds still produce distinct world-hash traces.
    expect(run(12345, 200).trace).not.toBe(run(54321, 200).trace);
  });
});

describe('rngState — anchors "inert" (#45)', () => {
  it('is carried through the tick boundary byte-identical — step() never touches it', () => {
    const s = createInitialState(12345, RULESET);
    const before = s.rngState;
    step(s, RULESET, callEarly);
    expect(s.rngState).toBe(before);
    for (let t = 0; t < 50; t++) step(s, RULESET, []);
    expect(s.rngState).toBe(before); // still untouched after many ticks of real play
  });
});

describe('step() StepEvents plumbing (#31)', () => {
  it('a pre-populated collector passes through the tick-totality early return unchanged', () => {
    const s = createInitialState(1, RULESET);
    s.tick = -1; // forges the tick-totality no-op path
    const events: StepEvents = { impactPoints: [{ x: 1, y: 2 }] };
    step(s, RULESET, [], events);
    expect(events.impactPoints).toEqual([{ x: 1, y: 2 }]); // untouched — appended nothing
  });

  it('a pre-populated collector passes through the terminal freeze early return unchanged', () => {
    const s = createInitialState(1, RULESET);
    s.phase = 'won';
    const events: StepEvents = { impactPoints: [{ x: 3, y: 4 }] };
    step(s, RULESET, [], events);
    expect(events.impactPoints).toEqual([{ x: 3, y: 4 }]); // untouched — appended nothing
  });

  it('a multi-step catch-up accumulates landed-impact events append-only across step() calls', () => {
    // A 14-wide straight lane with a tower straddling it (mirrors combat.test.ts) — wide
    // enough that the 2×2 tower detours the lane rather than severing it.
    const wide = testRuleset({
      widthTiles: 14,
      heightTiles: 14,
      entrance: { col: 0, row: 6 },
      exit: { col: 13, row: 6 },
    });
    let s = createInitialState(1, wide);
    s = step(s, wide, [
      { kind: 'placeTower', anchor: { col: 3, row: 5 } },
      { kind: 'callWaveEarly' },
    ]);
    const events: StepEvents = { impactPoints: [] };
    for (let t = 0; t < 120; t++) {
      s = step(s, wide, [], events);
    }
    expect(events.impactPoints.length).toBeGreaterThan(0); // accumulated across many calls
  });
});
