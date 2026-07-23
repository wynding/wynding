// num.ts — tiny numeric helpers shared across the render package so clamp semantics live
// in one place (health fraction, interpolation alpha, and the scene's health pip all
// clamp to [0,1] the same way, including NaN handling).

/** Clamp `x` to [0,1]; a non-finite input (NaN/±Infinity) collapses to 0. */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
