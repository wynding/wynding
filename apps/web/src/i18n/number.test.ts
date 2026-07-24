import { describe, it, expect } from 'vitest';
import { formatNumber } from './number';

describe('number — locale-aware one-decimal formatting (PLAN.md P2)', () => {
  it('formats an exact integer with one decimal digit', () => {
    expect(formatNumber(4)).toBe('4.0');
  });

  it('formats and rounds a repeating decimal to one digit', () => {
    expect(formatNumber(2 / 3)).toBe('0.7');
  });

  it('formats zero', () => {
    expect(formatNumber(0)).toBe('0.0');
  });
});
