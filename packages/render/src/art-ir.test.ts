// art-ir.test.ts — the vector art kit's IR helpers: the CSS-px floors on stroke widths and
// dash patterns, and SVG's rect corner-radius clamp.

import { describe, it, expect } from 'vitest';
import { dashAt, rectRadius, strokeWidthAt } from './art-ir';

describe('strokeWidthAt — a width in design units, never under its CSS-px floor', () => {
  it('defaults to 1 unit, and keeps its own width when there is no floor', () => {
    expect(strokeWidthAt({}, 0.5)).toBe(1);
    expect(strokeWidthAt({ width: 2.4 }, 0.1)).toBe(2.4);
  });

  it('raises the width to the floor at small scales, and leaves it at large ones', () => {
    // 2 units at 0.3125 px/unit (a 10px cell) is 0.625 px — under a 1px floor, so it is
    // drawn at 1 / 0.3125 = 3.2 units.
    expect(strokeWidthAt({ width: 2, minWidthPx: 1 }, 0.3125)).toBeCloseTo(3.2, 12);
    // At 30px cells (0.9375 px/unit) 2 units is 1.875 px: over the floor, unchanged.
    expect(strokeWidthAt({ width: 2, minWidthPx: 1 }, 0.9375)).toBe(2);
  });

  it('ignores the floor at a degenerate scale rather than dividing by zero', () => {
    expect(strokeWidthAt({ width: 2, minWidthPx: 1 }, 0)).toBe(2);
  });
});

describe('dashAt — a dash pattern in design units, scaled up to its CSS-px floor', () => {
  it('is empty for a solid stroke', () => {
    expect(dashAt({}, 1)).toEqual([]);
    expect(dashAt({ dash: [] }, 1)).toEqual([]);
  });

  it('keeps the pattern while its shortest entry meets the floor', () => {
    expect(dashAt({ dash: [5, 4], dashMinPx: 2 }, 1)).toEqual([5, 4]);
    expect(dashAt({ dash: [5, 4] }, 0.1)).toEqual([5, 4]);
  });

  it('scales the WHOLE pattern, never just the short entry, so its rhythm survives', () => {
    // At 0.25 px/unit the 4-unit gap is 1 px; a 2px floor doubles the pattern.
    expect(dashAt({ dash: [5, 4], dashMinPx: 2 }, 0.25)).toEqual([10, 8]);
  });

  it('ignores the floor at a degenerate scale, and never divides by a zero-length entry', () => {
    expect(dashAt({ dash: [5, 4], dashMinPx: 2 }, 0)).toEqual([5, 4]);
    expect(dashAt({ dash: [0, 4], dashMinPx: 2 }, 0.25)).toEqual([0, 4]);
  });
});

describe('rectRadius — SVG’s corner radius rule', () => {
  it('keeps a radius that fits, and clamps one that does not to half the shorter side', () => {
    expect(rectRadius({ w: 58, h: 58, rx: 9 })).toBe(9);
    expect(rectRadius({ w: 7, h: 21, rx: 9 })).toBe(3.5);
    expect(rectRadius({ w: 24, h: 6, rx: 9 })).toBe(3);
  });

  it('is never negative — not for a negative radius, nor for a degenerate rect', () => {
    expect(rectRadius({ w: 10, h: 10, rx: -4 })).toBe(0);
    expect(rectRadius({ w: -2, h: 10, rx: 4 })).toBe(0);
  });
});
