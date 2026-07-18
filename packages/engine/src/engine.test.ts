// engine.test.ts — proves the determinism primitives are byte-stable. If these
// fail, replay verification is unsound, so this is the project's bedrock test.

import { describe, it, expect } from 'vitest';
import {
  Rng,
  FP_ONE,
  fpMul,
  fpDiv,
  toFixed,
  toFloat,
  createFixedLoop,
  DEFAULT_MS_PER_TICK,
  hash32,
  fnv1a,
  hashState,
} from './index';

describe('Rng — Mulberry32 repeatability', () => {
  // Normative vectors for seed 12345. A mismatch means the wrong Mulberry32
  // variant, which would silently break every replay.
  it('produces the canonical first five outputs for seed 12345', () => {
    const rng = new Rng(12345);
    expect(rng.nextU32()).toBe(4207900869);
    expect(rng.nextU32()).toBe(1317490944);
    expect(rng.nextU32()).toBe(2079646450);
    expect(rng.nextU32()).toBe(3513001552);
    expect(rng.nextU32()).toBe(2187978186);
  });

  it('two instances from the same seed produce identical sequences', () => {
    const a = new Rng(777);
    const b = new Rng(777);
    for (let i = 0; i < 100; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it('different seeds diverge', () => {
    expect(new Rng(42).nextU32()).not.toBe(new Rng(43).nextU32());
  });

  it('getState/setState round-trips the exact sequence', () => {
    const rng = new Rng(99);
    rng.nextU32();
    rng.nextU32();
    const snap = rng.getState();
    const original = [rng.nextU32(), rng.nextU32(), rng.nextU32()];

    const restored = new Rng(0);
    restored.setState(snap);
    expect([restored.nextU32(), restored.nextU32(), restored.nextU32()]).toEqual(original);
  });

  it('keeps state canonical uint32 across many advances', () => {
    const rng = new Rng(0x7fffffff);
    for (let i = 0; i < 10_000; i++) {
      rng.nextU32();
      const s = rng.getState();
      expect(s >>> 0).toBe(s);
      expect(Number.isInteger(s)).toBe(true);
    }
  });

  it('bounded helpers stay in range', () => {
    const rng = new Rng(42);
    for (let i = 0; i < 1000; i++) {
      expect(rng.nextInt(10)).toBeGreaterThanOrEqual(0);
      expect(rng.nextInt(10)).toBeLessThan(10);
      const r = rng.nextRange(5, 15);
      expect(r).toBeGreaterThanOrEqual(5);
      expect(r).toBeLessThanOrEqual(15);
    }
  });
});

describe('fixed-point math', () => {
  it('multiplies with exact integer identity', () => {
    expect(fpMul(FP_ONE, FP_ONE)).toBe(FP_ONE);
    expect(fpMul(FP_ONE * 2, FP_ONE * 3)).toBe(FP_ONE * 6);
    expect(fpMul(-FP_ONE * 2, FP_ONE * 3)).toBe(-FP_ONE * 6);
  });

  it('divides with sub-unit precision', () => {
    expect(fpDiv(FP_ONE * 6, FP_ONE * 3)).toBe(FP_ONE * 2);
    expect(fpDiv(FP_ONE, FP_ONE * 2)).toBe(128);
  });

  it('round-trips whole tiles', () => {
    expect(toFixed(3)).toBe(768);
    expect(toFloat(toFixed(5))).toBe(5);
  });
});

describe('createFixedLoop — fixed timestep', () => {
  it('runs whole ticks and carries the remainder', () => {
    let ticks = 0;
    const loop = createFixedLoop(() => ticks++, { msPerTick: 50 });
    expect(loop.advance(120)).toBe(2); // 2 ticks, 20ms remainder
    expect(loop.accumulatorMs).toBe(20);
    expect(loop.advance(30)).toBe(1); // 20 + 30 = 50 -> 1 tick
    expect(ticks).toBe(3);
  });

  it('defaults to the 20 Hz tick (50 ms) when no options are given', () => {
    let ticks = 0;
    const loop = createFixedLoop(() => ticks++);
    expect(loop.advance(DEFAULT_MS_PER_TICK)).toBe(1);
    expect(ticks).toBe(1);
  });

  it('clamps catch-up after a long stall (spiral-of-death guard)', () => {
    let ticks = 0;
    const loop = createFixedLoop(() => ticks++, { msPerTick: 50, maxCatchUpTicks: 5 });
    loop.advance(100_000);
    expect(ticks).toBe(5);
  });

  it('reset() drops the accumulator', () => {
    const loop = createFixedLoop(() => {}, { msPerTick: 50 });
    loop.advance(40);
    loop.reset();
    expect(loop.accumulatorMs).toBe(0);
  });
});

describe('hashing — stability', () => {
  it('hash32 and fnv1a are deterministic', () => {
    expect(hash32(12345)).toBe(hash32(12345));
    expect(fnv1a('wynding')).toBe(fnv1a('wynding'));
    expect(fnv1a('wynding')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('hashState is stable for equal state and sensitive to change', () => {
    const a = hashState({ tick: 10, creeps: [1, 2, 3] });
    const b = hashState({ tick: 10, creeps: [1, 2, 3] });
    const c = hashState({ tick: 11, creeps: [1, 2, 3] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
