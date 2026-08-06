// stats.ts — pure percentile/summary helpers for the harness (PLAN step 19's
// "reports the step() percentile table", step 21's gate statistics).
//
// NEAREST-RANK, not interpolation. The gate (`gate.ts`) compares a stress-run p50 over
// the due-blast subset against a control-run p50 over the full window — as of M2-S6 the
// same percentile of two DIFFERENT sample sets (the numerator was p99 until M2-S5b P11
// and p95 until M2-S6), combined into one ratio. The SAMPLE COUNTS still differ and that
// is what this choice turns on: an interpolating estimator (e.g. linear/R-7, what
// `Array.prototype` percentile libraries usually default to) blends the two samples
// adjacent to the target rank, and how much blending happens shifts with the sample
// count — which differs between the control run (the full `SAMPLE_TICKS` window) and
// the stress run's due-blast subset (a few hundred to ~2,500 samples). That would make
// the ratio's precision depend on sample count in a way nearest-rank's integer index
// does not: nearest-rank always picks an ACTUAL observed `ms` value, so every statistic
// the gate reports — the two gating medians and the audit p95/p99 alike — is a real
// measurement, not a synthetic blend, which is what a measurement report (as opposed to
// a smoothed estimate) should assert.

/** Nearest-rank percentile: sort `xs` ascending, then take the element at index
 *  `min(len-1, max(0, ceil(p/100 * len) - 1))`. `p` is 0..100. Throws on an empty
 *  input — there is no sensible percentile of zero samples, and a silent `NaN` or `0`
 *  would be exactly the kind of "passes but measured nothing" failure this package
 *  exists to catch. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) {
    throw new Error('percentile() of an empty sample set is undefined');
  }
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    // The same discipline as the empty-set throw above, for the same reason: `NaN`
    // reaches `Math.ceil` and returns `undefined` through a non-null assertion, and a
    // finite out-of-range `p` silently clamps to the min or max. Both would publish a
    // number that is not the percentile anyone asked for. Every call site today passes a
    // literal 50/95/99, so this guards the day one of them becomes computed.
    throw new RangeError(`percentile() needs 0..100, got ${p}`);
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index]!;
}

/** Minimum of `xs`. Throws on empty, matching `percentile`'s totality contract. */
export function min(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('min() of an empty sample set is undefined');
  return xs.reduce((a, b) => Math.min(a, b));
}

/** Maximum of `xs`. Throws on empty, matching `percentile`'s totality contract. */
export function max(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('max() of an empty sample set is undefined');
  return xs.reduce((a, b) => Math.max(a, b));
}

/** Arithmetic mean of `xs`. Throws on empty, matching `percentile`'s totality
 *  contract. Used only for the report's descriptive summaries — never for a gate,
 *  which always reads a named percentile (mean is not robust to a single outlier
 *  tick, exactly the noise the gate exists to be robust against). */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('mean() of an empty sample set is undefined');
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
