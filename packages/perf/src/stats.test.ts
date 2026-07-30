// stats.test.ts — nearest-rank percentile edge cases (Phase 3, PLAN step 21).

import { describe, it, expect } from 'vitest';
import { percentile, min, max, mean } from './stats';

describe('percentile()', () => {
  it('throws on an empty sample set', () => {
    expect(() => percentile([], 50)).toThrow();
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

  it('p99 of a count that is NOT a multiple of 100 distinguishes ceil from floor (QC: the ceil-vs-floor blind spot at exact multiples of 100)', () => {
    // Every prior test above uses counts where `Math.ceil` and `Math.floor` agree on
    // the rank, so a `Math.ceil -> Math.floor` mutant in `percentile()` survived
    // unnoticed — including at the SIZE the real gate actually runs `p99` over (the
    // stress run's due-blast subset is ~1,671 samples in a genuine run, not a round
    // number). 1,671 samples: ceil(99/100 * 1671) - 1 = ceil(1654.29) - 1 = 1655 - 1 =
    // 1654 -> index 1654 -> value 1655. `Math.floor` instead would give
    // floor(1654.29) - 1 = 1653 -> value 1654, a DIFFERENT answer, so this case kills
    // that mutant.
    const xs = Array.from({ length: 1_671 }, (_, i) => i + 1); // 1..1671
    expect(percentile(xs, 99)).toBe(1655);
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
