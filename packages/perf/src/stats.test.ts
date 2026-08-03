// stats.test.ts — nearest-rank percentile edge cases (Phase 3, PLAN step 21).

import { describe, it, expect } from 'vitest';
import { percentile, min, max, mean } from './stats';

describe('percentile()', () => {
  it('throws on an empty sample set', () => {
    expect(() => percentile([], 50)).toThrow();
  });

  it.each([NaN, Infinity, -Infinity, -1, 101])('throws on an out-of-range p (%p)', (p) => {
    // Pinned rather than left to clamp: a non-finite `p` used to reach `Math.ceil` and
    // return `undefined` through the non-null assertion, and an out-of-range finite `p`
    // silently clamped to the min or max — either way publishing a number that is not the
    // percentile the caller asked for.
    expect(() => percentile([1, 2, 3], p)).toThrow(RangeError);
  });

  it('a single element is every percentile', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
  });

  it('p0 and p100 are the min and max of a known array', () => {
    const xs = [5, 3, 1, 4, 2];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 100)).toBe(5);
  });

  it('p50 of a known 10-element array (nearest-rank, not interpolated)', () => {
    // Sorted: 1..10. ceil(50/100 * 10) - 1 = 4 -> index 4 -> value 5 (not 5.5).
    const xs = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(percentile(xs, 50)).toBe(5);
  });

  it('p99 of a known 100-element array lands on the 99th ranked value', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    // ceil(99/100 * 100) - 1 = 98 -> index 98 -> value 99.
    expect(percentile(xs, 99)).toBe(99);
  });

  it('p95 at the real due-blast subset size distinguishes ceil from floor (QC: the ceil-vs-floor blind spot at exact multiples of 100)', () => {
    // Every prior test above uses counts where `Math.ceil` and `Math.floor` agree on
    // the rank, so a `Math.ceil -> Math.floor` mutant in `percentile()` survived
    // unnoticed — including at the SIZE and PERCENTILE the real gate actually runs (the
    // stress run's due-blast subset, 1,427 samples as measured post-M2-S5b-P9, and p95
    // since P11 moved `stressStat` off p99; both were 1,671/p99 before those packets).
    // 1,427 samples: ceil(95/100 * 1427) - 1 = ceil(1355.65) - 1 = 1356 - 1 = 1355 ->
    // index 1355 -> value 1356. `Math.floor` instead would give floor(1355.65) - 1 =
    // 1354 -> value 1355, a DIFFERENT answer, so this case kills that mutant.
    const xs = Array.from({ length: 1_427 }, (_, i) => i + 1); // 1..1427
    expect(percentile(xs, 95)).toBe(1356);
  });

  it('does not mutate its input', () => {
    const xs = [3, 1, 2];
    percentile(xs, 50);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('min/max/mean', () => {
  it('throw on an empty sample set', () => {
    expect(() => min([])).toThrow();
    expect(() => max([])).toThrow();
    expect(() => mean([])).toThrow();
  });

  it('compute over a known array', () => {
    const xs = [5, 3, 1, 4, 2];
    expect(min(xs)).toBe(1);
    expect(max(xs)).toBe(5);
    expect(mean(xs)).toBe(3);
  });

  it('a single element is its own min/max/mean', () => {
    expect(min([7])).toBe(7);
    expect(max([7])).toBe(7);
    expect(mean([7])).toBe(7);
  });
});
