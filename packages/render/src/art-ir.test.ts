// art-ir.test.ts — the vector art kit's IR helpers: the CSS-px floors on stroke widths and
// dash patterns, SVG's rect corner-radius clamp, and the move of a crisp stroke onto whole
// texels.

import { describe, it, expect } from 'vitest';
import {
  alignArtToTexels,
  alignRectToTexels,
  dashAt,
  rectRadius,
  strokeWidthAt,
  type ArtRect,
  type ArtShape,
} from './art-ir';

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

describe('alignRectToTexels — a crisp stroke on whole texels', () => {
  /** The plate's rim: 2 units wide, never under 1 CSS px. */
  const RIM: ArtRect = {
    kind: 'rect',
    x: 3,
    y: 3,
    w: 58,
    h: 58,
    rx: 9,
    stroke: 'rim',
    width: 2,
    minWidthPx: 1,
    crisp: true,
  };
  /** The aligned stroke's width, texels. */
  const texelWidth = (r: ArtRect, unit: number, scale: number): number =>
    strokeWidthAt(r, unit) * unit * scale;

  it('makes the width whole texels — never under its CSS-px floor, rounded up; else the nearest to its own, the thinner at a tie; never under one', () => {
    // 10px cells: 0.3125 px per unit, so the 1px floor rules (3.2 units), rounded UP to whole
    // texels — two at every fractional dpr, never thinner than the floor.
    const unit = 0.3125;
    expect(texelWidth(alignRectToTexels(RIM, unit, 1), unit, 1)).toBeCloseTo(1, 9);
    expect(texelWidth(alignRectToTexels(RIM, unit, 1.25), unit, 1.25)).toBeCloseTo(2, 9);
    expect(texelWidth(alignRectToTexels(RIM, unit, 1.5), unit, 1.5)).toBeCloseTo(2, 9);
    expect(texelWidth(alignRectToTexels(RIM, unit, 1.75), unit, 1.75)).toBeCloseTo(2, 9);
    expect(texelWidth(alignRectToTexels(RIM, unit, 3), unit, 3)).toBeCloseTo(3, 9);
    // 40px cells: 1.25 px per unit, so its own 2 units (2.5px) rule — a tie, so 2.
    expect(texelWidth(alignRectToTexels(RIM, 1.25, 1), 1.25, 1)).toBeCloseTo(2, 9);
    // 27px cells: its own 1.6875px is nearer 2 than 1.
    expect(texelWidth(alignRectToTexels(RIM, 27 / 32, 1), 27 / 32, 1)).toBeCloseTo(2, 9);
    // A hairline is never thinner than one texel.
    const hair: ArtRect = { ...RIM, width: 0.1, minWidthPx: undefined };
    expect(texelWidth(alignRectToTexels(hair, 1, 1), 1, 1)).toBeCloseTo(1, 9);
    // The floor is applied: none is left on the result.
    expect(alignRectToTexels(RIM, unit, 1).minWidthPx).toBeUndefined();
  });

  it('puts each edge on whole texels: a widened stroke keeps its inner side, a narrowed one its centre line, within half a texel', () => {
    // 10px cells at dpr 1: a 1-texel rim whose design centre lines sit at 0.9375 and 19.0625
    // texels moves to 0.5 and 19.5 — each now covers exactly one texel.
    const a = alignRectToTexels(RIM, 0.3125, 1);
    expect([a.x, a.y, a.x + a.w, a.y + a.h].map((v) => v * 0.3125)).toEqual([0.5, 0.5, 19.5, 19.5]);
    // 10px cells at dpr 1.5: the floor widens the rim from 1.5 texels to 2, and the extra half
    // texel goes OUTWARD: its inner side stays at the design's 2.16 texels, to the nearest.
    const b = alignRectToTexels(RIM, 0.3125, 1.5);
    expect((b.x - strokeWidthAt(b, 0.3125) / 2) * 0.46875).toBeCloseTo(0, 9); // texels 0–2
    // Everywhere: each edge starts on a whole texel, and its INNER side (towards the rect's
    // middle) — for a stroke rounded thinner, its centre line — is within half a texel of
    // the design's.
    let widened = 0;
    let narrowed = 0;
    for (const scale of [1, 1.25, 1.5, 1.75, 2, 3]) {
      for (let cellPx = 10; cellPx <= 40; cellPx += 3) {
        const unit = (2 * cellPx) / 64;
        const k = unit * scale;
        const r = alignRectToTexels(RIM, unit, scale);
        const half = texelWidth(r, unit, scale) / 2;
        const designHalf = (strokeWidthAt(RIM, unit) * k) / 2;
        const wider = half >= designHalf - 1e-9;
        if (wider) widened++;
        else narrowed++;
        // [drawn centre, design centre, which way is inward]
        const edges: [number, number, 1 | -1][] = [
          [r.x, RIM.x, 1],
          [r.y, RIM.y, 1],
          [r.x + r.w, RIM.x + RIM.w, -1],
          [r.y + r.h, RIM.y + RIM.h, -1],
        ];
        for (const [drawn, design, inward] of edges) {
          const at = `${cellPx}px at dpr ${scale}`;
          const start = drawn * k - half;
          expect(Math.abs(start - Math.round(start)), at).toBeLessThan(1e-9);
          const miss = wider
            ? drawn * k + inward * half - (design * k + inward * designHalf)
            : (drawn - design) * k;
          expect(Math.abs(miss), at).toBeLessThanOrEqual(0.5 + 1e-9);
        }
      }
    }
    expect([widened > 0, narrowed > 0]).toEqual([true, true]); // both cases were met
  });

  it('keeps the stroke inside `within` — the footprint — moving an edge inward where it would spill', () => {
    // 11px cells at dpr 1.25: the footprint ends at 27.5 texels, and the 2-texel rim's far
    // edge, placed freely, would end at 28 — half a texel into the next footprint.
    const unit = 22 / 64;
    const k = unit * 1.25;
    const farEnd = (r: ArtRect): number => (r.x + r.w) * k + texelWidth(r, unit, 1.25) / 2;
    expect(farEnd(alignRectToTexels(RIM, unit, 1.25))).toBeCloseTo(28, 9);
    const kept = alignRectToTexels(RIM, unit, 1.25, [0, 0], [0, 0, 64, 64]);
    expect(farEnd(kept)).toBeCloseTo(27, 9); // the last whole texel inside 27.5
    expect(kept.x).toBe(alignRectToTexels(RIM, unit, 1.25).x); // the near edge had room
    // The near side too: with the footprint's corner 0.3 texels into a texel, the rim placed
    // freely starts on texel 0, partly outside the footprint; kept, it starts on texel 1,
    // the first whole one inside.
    const o = [0.3, 0.3] as const;
    const nearStart = (r: ArtRect): number => o[0] + r.x * k - texelWidth(r, unit, 1.25) / 2;
    expect(nearStart(alignRectToTexels(RIM, unit, 1.25, o))).toBeCloseTo(0, 9);
    expect(nearStart(alignRectToTexels(RIM, unit, 1.25, o, [0, 0, 64, 64]))).toBeCloseTo(1, 9);
    // Each side keeps to its own bound, in a box that is not square: at 10px cells and dpr 1
    // the 1-texel rim runs from texel 0 to 20 across, but from 1 to 19 down a box that
    // starts 2 units (0.625 texels) lower and ends 2 units sooner.
    const tall = alignRectToTexels(RIM, 0.3125, 1, [0, 0], [0, 2, 64, 62]);
    const th = texelWidth(tall, 0.3125, 1) / 2;
    const outer = [
      tall.x * 0.3125 - th,
      tall.y * 0.3125 - th,
      (tall.x + tall.w) * 0.3125 + th,
      (tall.y + tall.h) * 0.3125 + th,
    ];
    outer.forEach((v, i) => expect(v, `edge ${i}`).toBeCloseTo([0, 1, 20, 19][i]!, 9));
    // Everywhere, wherever the footprint's corner falls in a texel: inside it, on whole texels.
    for (const scale of [1, 1.25, 1.5, 1.75, 2, 3]) {
      for (let cellPx = 10; cellPx <= 40; cellPx++) {
        for (const f of [0, 0.3, 0.7]) {
          const u = (2 * cellPx) / 64;
          const r = alignRectToTexels(RIM, u, scale, [f, f], [0, 0, 64, 64]);
          const h = texelWidth(r, u, scale) / 2;
          const at = `${cellPx}px at dpr ${scale}, corner +${f}`;
          const start = f + r.x * u * scale - h;
          expect(start, at).toBeGreaterThanOrEqual(f - 1e-9);
          expect(Math.abs(start - Math.round(start)), at).toBeLessThan(1e-9);
          expect(f + (r.x + r.w) * u * scale + h, at).toBeLessThanOrEqual(
            f + 64 * u * scale + 1e-9,
          );
        }
      }
    }
  });

  it('reads only the fraction of the origin’s texel position', () => {
    const at0 = alignRectToTexels(RIM, 0.3125, 1);
    expect(alignRectToTexels(RIM, 0.3125, 1, [3, 7])).toEqual(at0);
    // A quarter-texel origin: the stroke still covers whole texels of the GRID.
    const q = alignRectToTexels(RIM, 0.3125, 1, [0.25, 0]);
    const outer = 0.25 + q.x * 0.3125 - 0.5;
    expect(Math.abs(outer - Math.round(outer))).toBeLessThan(1e-9);
    expect(q.x).not.toBe(at0.x);
    expect(q.y).toBe(at0.y);
  });

  it('keeps the corner radius, dash and paint; leaves a rect with no stroke, or a degenerate scale, alone', () => {
    const dashed: ArtRect = { ...RIM, dash: [5, 4], dashMinPx: 2, alpha: 0.5 };
    const d = alignRectToTexels(dashed, 0.3125, 1);
    expect(d).toMatchObject({ rx: 9, dash: [5, 4], dashMinPx: 2, alpha: 0.5, stroke: 'rim' });
    const filled: ArtRect = { kind: 'rect', x: 3, y: 3, w: 58, h: 58, rx: 9, fill: 'plate' };
    expect(alignRectToTexels(filled, 0.3125, 1)).toBe(filled);
    expect(alignRectToTexels(RIM, 0, 1)).toBe(RIM);
  });
});

describe('alignArtToTexels — the crisp rects of a list, and nothing else', () => {
  const ring: ArtShape = { kind: 'circle', cx: 32, cy: 32, r: 22, stroke: 'aura' };
  const plain: ArtShape = { kind: 'rect', x: 3, y: 3, w: 58, h: 58, rx: 9, stroke: 'rim' };
  const crisp: ArtRect = { ...(plain as ArtRect), crisp: true };

  it('aligns each crisp rect and hands every other shape back as it is', () => {
    const shapes = [ring, crisp, plain];
    const out = alignArtToTexels(shapes, 0.3125, 1);
    expect(out[0]).toBe(ring);
    expect(out[1]).toEqual(alignRectToTexels(crisp, 0.3125, 1));
    expect(out[1]).not.toEqual(crisp);
    expect(out[2]).toBe(plain);
  });

  it('hands back the SAME list when nothing in it is crisp', () => {
    const shapes = [ring, plain];
    expect(alignArtToTexels(shapes, 0.3125, 1)).toBe(shapes);
  });
});
