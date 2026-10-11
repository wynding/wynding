// outline-overlap.ts — test support: how much two pieces of art share an OUTLINE (visual pass,
// #181). One measure, and one bar, for the art kit: `tower-art.test.ts` holds the tower heads
// apart with it (T1), and `creep-art.test.ts` the creep silhouettes (C3). Each outline is
// rasterized as fractional coverage of a grid laid over its own bounding box — normalised to the
// box, so it measures shape, not size — and two outlines overlap by the soft intersection over
// union of their coverage.

import { artBounds, shapeOutline, type Point, type Polyline } from '../art-geometry';
import { strokeWidthAt, type ArtShape } from '../art-ir';

/** The most two outlines may overlap — the art kit's bar, for the tower heads and the creep
 *  silhouettes alike. Each suite records what its own art measures against it, and the controls
 *  that must fail it. */
export const MAX_OUTLINE_OVERLAP = 0.88;

/** Even-odd point-in-polygon over a set of rings. */
export function insideRings(x: number, y: number, rings: readonly (readonly Point[])[]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Distance from (x, y) to the segment a–b. */
export function distToSegment(x: number, y: number, a: Point, b: Point): number {
  const [ax, ay] = a;
  const dx = b[0] - ax;
  const dy = b[1] - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** Whether (x, y) lies within `half` of any segment of `lines` — on a stroke that wide. */
export function nearStroke(
  x: number,
  y: number,
  lines: readonly Polyline[],
  half: number,
): boolean {
  for (const { points, closed } of lines) {
    const n = points.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      if (distToSegment(x, y, points[i]!, points[(i + 1) % n]!) <= half) return true;
    }
  }
  return false;
}

/** Whether the point (x, y), in design units, is covered by `shape` — its fill, or its stroke
 *  at `unit` CSS px per design unit (`Infinity`: the design width). */
export function covers(shape: ArtShape, x: number, y: number, unit = Infinity): boolean {
  const lines = shapeOutline(shape);
  if (
    shape.fill !== undefined &&
    insideRings(
      x,
      y,
      lines.map((l) => l.points),
    )
  )
    return true;
  return shape.stroke !== undefined && nearStroke(x, y, lines, strokeWidthAt(shape, unit) / 2);
}

/** `shapes`' OUTLINE as fractional coverage of an `n`×`n` grid laid over their own bounding
 *  box: scaled uniformly (aspect kept) so the box's longer side spans the grid, centred, and
 *  shifted by `offset` of a grid cell. Each cell is supersampled 4×4 over every visible shape
 *  — fills, and strokes at their width at `unit` CSS px per design unit (`Infinity`: the
 *  design width) — so a cell an edge crosses counts the share of it covered. Shadows are not
 *  part of a silhouette (dark on the dark floor).
 *
 *  Normalising to the box makes this measure SHAPE — not size, which a copy at 90% of the
 *  size only changes (a footprint-sized raster scored such a copy of a tower head as a
 *  different outline), and not where edges fall on the pixel grid (a footprint-sized raster at
 *  a phone's 26px swung splash against frost-splash from 0.82 to 0.91 between 20px and 33px).
 *  Each suite pins the measure grid-independent for its own art: a coarser grid at a
 *  third-cell offset reads every pair the same. */
export function outline(
  shapes: readonly ArtShape[],
  n = 64,
  offset = 0,
  unit = Infinity,
): Float64Array {
  const visible = shapes.filter((s) => s.fill !== 'shadow');
  const b = artBounds(visible, unit);
  const side = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const x0 = (b.minX + b.maxX) / 2 - side / 2 - (offset * side) / n;
  const y0 = (b.minY + b.maxY) / 2 - side / 2 - (offset * side) / n;
  const prepared = visible.map((s) => {
    const lines = shapeOutline(s);
    return {
      rings: s.fill === undefined ? null : lines.map((l) => l.points),
      half: s.stroke === undefined ? -1 : strokeWidthAt(s, unit) / 2,
      lines,
    };
  });
  const SS = 4;
  const out = new Float64Array(n * n);
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = x0 + ((px + (sx + 0.5) / SS) * side) / n;
          const y = y0 + ((py + (sy + 0.5) / SS) * side) / n;
          if (
            prepared.some(
              (p) =>
                (p.rings !== null && insideRings(x, y, p.rings)) ||
                (p.half >= 0 && nearStroke(x, y, p.lines, p.half)),
            )
          ) {
            hits++;
          }
        }
      }
      out[py * n + px] = hits / (SS * SS);
    }
  }
  return out;
}

/** How much two outlines overlap: soft intersection over union of their coverage, Σmin/Σmax
 *  — 1 for one outline twice, falling as they differ. */
export function overlap(a: Float64Array, b: Float64Array): number {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < a.length; i++) {
    lo += Math.min(a[i]!, b[i]!);
    hi += Math.max(a[i]!, b[i]!);
  }
  return lo / hi;
}
