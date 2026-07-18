// fixed.ts — fixed-point arithmetic primitives for the deterministic sim.
//
// FP_SHIFT = 8 means 1 board tile = 256 fixed-point units. All sim-layer
// fractional quantities use these helpers; floats are banned in the sim.
//
// Safe upper bound: values up to 2^23 FP units (32,768 tiles) are safe before
// Math.imul overflow.

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
