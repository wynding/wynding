// rim-scales.ts — TEST SUPPORT: the plate's rim as the plate frame draws it, and every dpr at
// which it can be at its best or worst (`art-frames.test.ts`, `tower-art.test.ts`). Kept out
// of the build (`tsconfig.json`) and out of the coverage denominator (`vitest.config.ts`).
//
// Drawn on whole texels, the rim jumps a texel at a time as the scale changes, and between
// two jumps whatever is measured against it — where the plate fill's edge lies, the room it
// leaves the boost glow, whether it reaches the bevel — moves one way. So the extremes of
// each lie at the two sides of a jump, and a fixed grid of scales undershoots the worst of
// them, which lie just short of one (QC round 4: plate 0.30 px past the rim at 9 px cells
// just under dpr 5/6, where every 0.005 of dpr found 0.24).

import { alignArtToTexels, strokeWidthAt, type ArtRect } from '../art-ir';
import { artUnit } from '../art-frames';
import { ART_FOOTPRINT, PLATE_ART } from '../tower-art';

/** The plate's rim as the plate frame draws it at `cellPx` and `scale`: on whole texels,
 *  inside the footprint. */
export function drawnRim(cellPx: number, scale: number): ArtRect {
  const rim = alignArtToTexels(PLATE_ART, artUnit(cellPx), scale, [0, 0], ART_FOOTPRINT).find(
    (s) => s.stroke === 'rim',
  );
  if (rim?.kind !== 'rect') throw new Error('the rim is a rect');
  return rim;
}

/** Every 0.005 of dpr from 0.8 to 3. */
export const DPR_GRID: readonly number[] = Array.from(
  { length: 441 },
  (_, step) => Math.round((0.8 + step * 0.005) * 1000) / 1000,
);

/** Every dpr from 0.8 to 3 at which the rim drawn at `cellPx` can be at its best or worst, in
 *  order: every 0.005, and both sides of each scale where any of its edges moves to another
 *  texel, bisected to 1e-12. */
export function rimScales(cellPx: number): number[] {
  const unit = artUnit(cellPx);
  /** The texels the rim's eight edges (outer and inner, each side) lie on. */
  const texels = (scale: number): string => {
    const rim = drawnRim(cellPx, scale);
    const half = strokeWidthAt(rim, unit) / 2;
    return [rim.x, rim.x + rim.w, rim.y, rim.y + rim.h]
      .flatMap((v) => [v - half, v + half])
      .map((v) => Math.round(v * unit * scale))
      .join();
  };
  const scales: number[] = [];
  let [before, was] = [DPR_GRID[0]!, texels(DPR_GRID[0]!)];
  for (const scale of DPR_GRID) {
    const now = texels(scale);
    // Each change since the last scale, bisected to its two sides.
    while (was !== now) {
      let [lo, hi] = [before, scale];
      while (hi - lo > 1e-12) {
        const mid = (lo + hi) / 2;
        if (texels(mid) === was) lo = mid;
        else hi = mid;
      }
      scales.push(lo, hi);
      [before, was] = [hi, texels(hi)];
    }
    scales.push(scale);
    before = scale;
  }
  return [...new Set(scales)];
}
