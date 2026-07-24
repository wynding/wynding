// fixed.ts — fixed-point arithmetic primitives for the deterministic sim.
//
// FP_SHIFT = 8 means 1 board tile = 256 fixed-point units. All sim-layer
// fractional quantities use these helpers; floats are banned in the sim.
//
// Safety contract (per-operation, not a single blanket bound — see fixed.test.ts for the
// pinned boundary cases):
//  - Operands are signed 32-bit integer fixed-point values: `Math.imul` coerces both to
//    int32 before multiplying — fractional inputs truncate toward zero, and
//    out-of-int32 inputs WRAP modulo 2^32 with signed reinterpretation (ToInt32).
//    "Exact" below means no 32-bit wrap — not exact real-number multiplication.
//  - `fpMul(a, b)` is exact only while the mathematical product `a·b` fits in a signed
//    32-bit integer: `-2^31 ≤ a·b ≤ 2^31 − 1` (the interval INCLUDES -2^31; Math.imul's
//    wraparound is the failure mode outside it).
//  - Multiplying by `FP_ONE` specifically is exact only for the signed interval
//    `-2^23 ≤ a ≤ 2^23 − 1` — NOT "below 2^23", which would wrongly admit arbitrarily
//    negative operands (the product overflows just as much on the negative side).
//  - Two EQUAL positive whole-tile operands (the common `fpMul(n*FP_ONE, n*FP_ONE)`
//    shape) are safe THROUGH 181 tiles inclusive; 182 wraps. Not "below 181" — 181 itself
//    is verified-safe, 182 is the first unsafe value.

/** Number of fractional bits. 1 tile = 2^FP_SHIFT fixed-point units. */
export const FP_SHIFT = 8;

/** Fixed-point representation of 1.0 (one tile). */
export const FP_ONE = 1 << FP_SHIFT; // 256

/**
 * Multiply two fixed-point values. Uses Math.imul for C-style 32-bit signed
 * integer semantics; the signed right-shift preserves negative values.
 * Do NOT use >>> here — it would turn negatives into large positive uint32s.
 */
export function fpMul(a: number, b: number): number {
  return Math.imul(a, b) >> FP_SHIFT;
}

/**
 * Divide two fixed-point values. Left-shifts the dividend first to preserve
 * sub-unit precision; Math.trunc keeps integer (not floor) semantics.
 */
export function fpDiv(a: number, b: number): number {
  return Math.trunc((a << FP_SHIFT) / b);
}

/** Convert an integer tile count to fixed-point. */
export function toFixed(tiles: number): number {
  return (tiles * FP_ONE) | 0;
}

/**
 * Convert a fixed-point value to a float tile count.
 * RENDER LAYER ONLY — never store or use the result inside the sim.
 */
export function toFloat(fixed: number): number {
  return fixed / FP_ONE;
}
