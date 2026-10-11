// sparks.test.ts — impact-spark lifetimes: held before the game clock runs, stamped on intake,
// faded and dropped by age (shorter under reduced motion), drawn newest first, and bounded
// even when nothing draws them — and a flyer's spark keeping the look it struck (C2).

import { describe, it, expect } from 'vitest';
import { createSparkStore, sparkLifeMs, SPARK_MS } from './sparks';

const hit = (x: number, radiusFp = 0) => ({ x, y: 0, radiusFp });

describe('sparkLifeMs', () => {
  it('is 180ms, cut to 0.4× under reduced motion', () => {
    expect(sparkLifeMs(false)).toBe(SPARK_MS);
    expect(SPARK_MS).toBe(180);
    expect(sparkLifeMs(true)).toBeCloseTo(72, 9);
  });
});

describe('createSparkStore', () => {
  it('fades a spark from 1 at its birth to 0 at the end of its life, then drops it', () => {
    const s = createSparkStore();
    s.intake([hit(1)], 1000, false);
    expect(s.live(1000, false).map((p) => p.k)).toEqual([1]);
    expect(s.live(1090, false)[0]!.k).toBeCloseTo(0.5, 9);
    expect(s.live(1180, false)[0]!.k).toBeCloseTo(0, 9); // still lit at exactly its life
    expect(s.live(1181, false)).toEqual([]);
    expect(s.size).toBe(0);
  });

  it('expires faster under reduced motion', () => {
    const s = createSparkStore();
    s.intake([hit(1)], 0, true);
    expect(s.live(36, true)[0]!.k).toBeCloseTo(0.5, 9); // halfway through its 72ms
    expect(s.live(72, true)).toHaveLength(1);
    expect(s.live(73, true)).toEqual([]);
  });

  it('holds points that arrive before the clock runs, and stamps them at the first intake', () => {
    const s = createSparkStore();
    s.hold([hit(1), hit(2, 512)]);
    expect(s.size).toBe(2);
    expect(s.live(5000, false)).toEqual([]); // not lit yet: unstamped
    s.intake([], 5000, false);
    expect(s.live(5000, false).map((p) => [p.x, p.radiusFp, p.k])).toEqual([
      [2, 512, 1],
      [1, 0, 1],
    ]);
  });

  it('gives the lit sparks newest first — the order the board has always drawn them in', () => {
    const s = createSparkStore();
    s.intake([hit(1)], 0, false);
    s.intake([hit(2), hit(3)], 10, false);
    expect(s.live(20, false).map((p) => p.x)).toEqual([3, 2, 1]);
  });

  it('stays bounded when nothing draws: every intake drops what has expired', () => {
    // Frames before the first successful bake take sparks in but draw none (`live` is never
    // called); they must not pile up.
    const s = createSparkStore();
    for (let t = 0; t < 10_000; t += 16) s.intake([hit(t)], t, false);
    expect(s.size).toBeLessThanOrEqual(Math.ceil(SPARK_MS / 16) + 1);
  });

  it('clear forgets every spark, held or lit', () => {
    const s = createSparkStore();
    s.hold([hit(1)]);
    s.intake([hit(2)], 0, false);
    s.hold([hit(3)]);
    s.clear();
    expect(s.size).toBe(0);
    s.intake([], 1, false);
    expect(s.live(1, false)).toEqual([]);
  });

  it('keeps the look of the flyer a spark struck, held or lit, so it is drawn on the flyer’s lifted body (C2)', () => {
    const s = createSparkStore();
    const flyer = { creepId: 'armored-flyer', boss: false };
    s.hold([{ ...hit(1), flyer }]);
    s.intake([{ ...hit(2), flyer: { creepId: 'flying', boss: true } }, hit(3)], 0, false);
    const live = s.live(0, false);
    expect(live.map((p) => [p.x, p.flyer])).toEqual([
      [3, undefined],
      [2, { creepId: 'flying', boss: true }],
      [1, flyer],
    ]);
  });
});
