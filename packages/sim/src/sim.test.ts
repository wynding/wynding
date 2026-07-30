// sim.test.ts — smoke + determinism for the headless simulation.

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  step,
  hashSimState,
  previewInputs,
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
  it('starts with lives, no creeps, running, wave 0 counting down', () => {
    const s = createInitialState(1, RULESET);
    expect(s.tick).toBe(0);
    expect(s.lives).toBe(10);
    expect(s.phase).toBe('running');
    expect(s.waveCursor).toBe(0);
    expect(s.countdownRemaining).toBe(500); // testRuleset default countdownTicks
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
    expect(s.phase).toBe('running');
    expect(s.waveLaunchTick[0]).toBe(0);
    expect(s.creeps.id).toHaveLength(1);
    expect(s.creeps.hp[0]).toBe(20); // catalog hp
    expect(s.creeps.bounty[0]).toBe(1); // resolved from kind
    expect(s.creeps.speed[0]).toBe(26);
    expect(s.creeps.fromX[0]).toBe(0 * 256 + 128); // from-point still on the entrance centre...
    expect(s.creeps.fromY[0]).toBe(2 * 256 + 128);
    expect(s.creeps.progress[0]).toBe(26); // ...one budget into the first edge
    expect(s.creeps.headCol[0]).toBe(1); // committed toward the next cell east
    expect(s.creeps.headRow[0]).toBe(2);
    expect(s.creeps.wave[0]).toBe(0);
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
      (c) => (c.wave = []),
      (c) => (c.creepId = []), // M2-S3: an unresolvable/missing creepId drops the row too
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
        wave: [0],
        creepId: ['normal'],
        slowMulFp: [0],
        slowUntilTick: [0],
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

describe('step() StepEvents plumbing (#31/#32)', () => {
  it('a pre-populated collector passes through the tick-totality early return unchanged', () => {
    const s = createInitialState(1, RULESET);
    s.tick = -1; // forges the tick-totality no-op path
    const events: StepEvents = {
      impactPoints: [{ x: 1, y: 2, radiusFp: 0 }],
      fired: [
        { kind: 'targeted', originX: 1, originY: 2, targetId: 3, launchTick: 4, impactTick: 5 },
      ],
    };
    step(s, RULESET, [], events);
    expect(events.impactPoints).toEqual([{ x: 1, y: 2, radiusFp: 0 }]); // untouched — appended nothing
    expect(events.fired).toEqual([
      { kind: 'targeted', originX: 1, originY: 2, targetId: 3, launchTick: 4, impactTick: 5 },
    ]);
  });

  it('a pre-populated collector passes through the terminal freeze early return unchanged', () => {
    const s = createInitialState(1, RULESET);
    s.phase = 'won';
    const events: StepEvents = {
      impactPoints: [{ x: 3, y: 4, radiusFp: 0 }],
      fired: [
        { kind: 'targeted', originX: 5, originY: 6, targetId: 7, launchTick: 8, impactTick: 9 },
      ],
    };
    step(s, RULESET, [], events);
    expect(events.impactPoints).toEqual([{ x: 3, y: 4, radiusFp: 0 }]); // untouched — appended nothing
    expect(events.fired).toEqual([
      { kind: 'targeted', originX: 5, originY: 6, targetId: 7, launchTick: 8, impactTick: 9 },
    ]);
  });

  it('a multi-step catch-up accumulates landed-impact AND fired events append-only across step() calls', () => {
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
      { kind: 'placeTower', anchor: { col: 3, row: 5 }, towerId: 'basic' },
      { kind: 'callWaveEarly' },
    ]);
    const events: StepEvents = { impactPoints: [], fired: [] };
    for (let t = 0; t < 120; t++) {
      s = step(s, wide, [], events);
    }
    expect(events.impactPoints.length).toBeGreaterThan(0); // accumulated across many calls
    expect(events.fired.length).toBeGreaterThan(0); // at least one shot fired across the window
    // Every fired event carries a well-formed tick window (launch strictly before impact).
    for (const f of events.fired) expect(f.launchTick).toBeLessThan(f.impactTick);
  });
});

describe('previewInputs — read-only PreviewState contract (#30/P3)', () => {
  it('never throws with every creeps column array and impacts frozen, across all command kinds', () => {
    let s = createInitialState(1, RULESET);
    s = step(s, RULESET, [
      { kind: 'placeTower', anchor: { col: 2, row: 1 }, towerId: 'basic' },
      { kind: 'callWaveEarly' },
    ]);
    // Freeze every creeps column array AND impacts — previewInputs must never attempt to
    // write into them: only `towers` is deep-cloned, `creeps`/`impacts` are shared/shallow.
    for (const col of Object.values(s.creeps)) Object.freeze(col);
    Object.freeze(s.impacts);
    const before = hashSimState(s);
    const allKinds: SimInput[] = [
      { kind: 'placeTower', anchor: { col: 5, row: 1 }, towerId: 'basic' },
      { kind: 'sellTower', tower: 999 },
      { kind: 'callWaveEarly' },
      { kind: 'noop' },
    ];
    expect(() => previewInputs(s, RULESET, allKinds)).not.toThrow();
    expect(hashSimState(s)).toBe(before); // source untouched
  });

  it('identity: preview.creeps column arrays are the SAME reference as source (shallow container copy)', () => {
    const s = createInitialState(1, RULESET);
    const { preview } = previewInputs(s, RULESET, []);
    expect(preview.creeps.id).toBe(s.creeps.id); // shared column array
    expect(preview.creeps).not.toBe(s.creeps); // fresh container object (coerceSoa-safe)
    expect(preview.towers).not.toBe(s.towers); // deep-cloned
    expect(preview.towers.id).not.toBe(s.towers.id);
  });

  it('an adversarial non-cloneable value stashed on creeps flows through untouched (narrowed guarantee)', () => {
    const s = createInitialState(1, RULESET);
    // A function is not structured-cloneable. Previously a blanket `structuredClone(state)`
    // would throw on this. Now only `towers` is deep-cloned, so garbage anywhere in
    // `creeps` is never inspected/copied — no throw, per the narrowed guarantee.
    (s.creeps as unknown as Record<string, unknown>).poison = () => {};
    expect(() => previewInputs(s, RULESET, [{ kind: 'noop' }])).not.toThrow();
  });

  it('compile-only: step() rejects a PreviewState (readonly arrays vs. SimState mutable arrays)', () => {
    if (false as boolean) {
      const s = createInitialState(1, RULESET);
      const { preview } = previewInputs(s, RULESET, []);
      // @ts-expect-error PreviewState's readonly columns are not assignable to step()'s
      // mutable SimState — the read-only contract is a typecheck failure, never a live call.
      step(preview, RULESET, []);
      // @ts-expect-error preview.impacts is deeply readonly — effects is `readonly
      // EffectPrimitive[]`, so pushing onto it (which would mutate the shared, live-state
      // impact object) is a typecheck failure, never a live call.
      preview.impacts[0].effects.push({ kind: 'direct', amount: 1 });
    }
  });
});
