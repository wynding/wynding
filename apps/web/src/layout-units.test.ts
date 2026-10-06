// layout-units.test.ts — the shared unit helpers (#152, #181).
import { describe, it, expect } from 'vitest';
import { ceil64, px } from './layout-units';

describe('ceil64 (#152)', () => {
  it('rounds UP to the 1/64px layout unit, and no further', () => {
    expect(ceil64(52.4)).toBe(52.40625);
    expect(ceil64(51.203125)).toBe(51.203125); // already a whole unit
    expect(ceil64(52 + 1e-9)).toBe(52); // float noise in a whole unit costs nothing
  });

  it('keeps an exact 1/64 multiple, and rounds just over one up to the next', () => {
    expect(ceil64(3 / 64)).toBe(3 / 64);
    expect(ceil64(3 / 64 + 0.001)).toBe(4 / 64);
  });
});

describe('px', () => {
  it('parses a computed length, with or without its unit', () => {
    expect(px('12.5px')).toBe(12.5);
    expect(px('8')).toBe(8);
  });

  it('is 0 for a missing, empty or unparsable value', () => {
    expect(px(undefined)).toBe(0);
    expect(px('')).toBe(0);
    expect(px('auto')).toBe(0);
  });
});
