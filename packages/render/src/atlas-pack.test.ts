// atlas-pack.test.ts — the board atlas's shelf packer: every frame gets a texel-integral
// rectangle inside the reported size, none overlap (gutters included), shelves respect the
// width limit, and the layout is deterministic.

import { describe, it, expect } from 'vitest';
import { packShelves, type PackItem, type PackedRect } from './atlas-pack';

const item = (key: string, width: number, height: number): PackItem => ({ key, width, height });

/** Do two rects (grown by `gap` on every side) overlap? */
function overlaps(a: PackedRect, b: PackedRect, gap: number): boolean {
  return (
    a.x < b.x + b.width + gap &&
    b.x < a.x + a.width + gap &&
    a.y < b.y + b.height + gap &&
    b.y < a.y + a.height + gap
  );
}

describe('packShelves', () => {
  it('places frames left to right on one shelf while they fit, with a gutter between and around them', () => {
    const packed = packShelves([item('a', 10, 10), item('b', 10, 10), item('c', 10, 10)], 100, 2);
    expect(packed.rects.map((r) => [r.key, r.x, r.y])).toEqual([
      ['a', 2, 2],
      ['b', 14, 2],
      ['c', 26, 2],
    ]);
    // The reported size includes the trailing gutter on both axes.
    expect(packed.width).toBe(38);
    expect(packed.height).toBe(14);
  });

  it('starts a new shelf below the tallest frame of the last one when the next would cross the width limit', () => {
    const packed = packShelves(
      [item('a', 40, 12), item('b', 40, 10), item('c', 40, 10)],
      100, // a + b fit (2+40+2+40+2 = 86); c would need 128
      2,
    );
    const c = packed.rects.find((r) => r.key === 'c')!;
    expect(c.x).toBe(2);
    expect(c.y).toBe(2 + 12 + 2); // below the first shelf's TALLEST frame, plus a gutter
    expect(packed.width).toBeLessThanOrEqual(100);
    expect(packed.height).toBe(c.y + 10 + 2);
  });

  it('packs tallest first, keeping the given order among equal heights (stable)', () => {
    const packed = packShelves(
      [item('short', 10, 5), item('tall', 10, 20), item('mid', 10, 10), item('mid2', 10, 10)],
      1000,
      1,
    );
    expect(packed.rects.map((r) => r.key)).toEqual(['tall', 'mid', 'mid2', 'short']);
  });

  it('never overlaps two frames, gutter included, and keeps every frame inside the reported size', () => {
    const items: PackItem[] = [];
    for (let i = 0; i < 47; i++) items.push(item(`f${i}`, 7 + ((i * 13) % 29), 5 + ((i * 7) % 31)));
    const gutter = 2;
    const packed = packShelves(items, 160, gutter);
    expect(packed.rects).toHaveLength(items.length);
    for (const r of packed.rects) {
      expect(Number.isInteger(r.x) && Number.isInteger(r.y)).toBe(true);
      expect(r.x).toBeGreaterThanOrEqual(gutter);
      expect(r.y).toBeGreaterThanOrEqual(gutter);
      expect(r.x + r.width + gutter).toBeLessThanOrEqual(packed.width);
      expect(r.y + r.height + gutter).toBeLessThanOrEqual(packed.height);
      expect(packed.width).toBeLessThanOrEqual(160);
    }
    for (let i = 0; i < packed.rects.length; i++) {
      for (let j = i + 1; j < packed.rects.length; j++) {
        expect(overlaps(packed.rects[i]!, packed.rects[j]!, gutter)).toBe(false);
      }
    }
  });

  it('is deterministic — the same frames always land in the same places', () => {
    const items = [item('a', 30, 9), item('b', 12, 30), item('c', 50, 9), item('d', 12, 4)];
    expect(packShelves(items, 64, 2)).toEqual(packShelves(items, 64, 2));
  });

  it('gives a frame wider than the limit a shelf of its own and reports the width it needs', () => {
    const packed = packShelves([item('small', 10, 10), item('huge', 300, 10)], 100, 2);
    const huge = packed.rects.find((r) => r.key === 'huge')!;
    expect(huge.x).toBe(2);
    expect(packed.width).toBe(2 + 300 + 2); // over the limit: the caller sees it and degrades
    expect(huge.y).toBeGreaterThan(packed.rects.find((r) => r.key === 'small')!.y);
  });

  it('packs nothing into nothing', () => {
    expect(packShelves([], 100, 2)).toEqual({ width: 0, height: 0, rects: [] });
  });
});
