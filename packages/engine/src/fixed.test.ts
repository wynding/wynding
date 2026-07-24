// fixed.test.ts — pins the per-operation safety boundaries documented in fixed.ts's
// header (#45): `fpMul` is exact only while the mathematical product fits signed 32-bit,
// and multiplication by `FP_ONE` specifically has its own tighter, signed-interval bound.
// These are boundary/anchor tests (verify the documented numbers), not exhaustive range
// tests.

import { describe, it, expect } from 'vitest';
import { fpMul, FP_ONE } from './fixed';

describe('fpMul — the FP_ONE-multiplication safety boundary', () => {
  it('two equal positive whole-tile operands are exact through 181 tiles', () => {
    expect(fpMul(181 * FP_ONE, 181 * FP_ONE)).toBe(181 * 181 * FP_ONE);
  });

  it('182 tiles wraps (the first unsafe value, not merely "large")', () => {
    expect(fpMul(182 * FP_ONE, 182 * FP_ONE)).not.toBe(182 * 182 * FP_ONE);
    expect(fpMul(182 * FP_ONE, 182 * FP_ONE)).toBeLessThan(0); // pins the actual wrap direction
  });

  it('fpMul(2^23, FP_ONE) overflows to a negative value (the documented -8388608)', () => {
    expect(fpMul(2 ** 23, FP_ONE)).toBe(-8388608);
  });

  it('fpMul(-2^23, FP_ONE) is exact — the safe negative boundary', () => {
    expect(fpMul(-(2 ** 23), FP_ONE)).toBe(-(2 ** 23));
  });

  it('fpMul(-2^23 - 1, FP_ONE) wraps — just below the safe negative boundary', () => {
    expect(fpMul(-(2 ** 23) - 1, FP_ONE)).not.toBe(-(2 ** 23) - 1);
  });
});
