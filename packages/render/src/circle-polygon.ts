// circle-polygon.ts — a small circle drawn as a regular polygon through `fillPoints` and
// `strokePoints` (visual pass T3, #181): the shots' muzzle flashes and ring pulses. Phaser-free:
// anything with `fillPoints` and `strokePoints` draws one — a live layer's Phaser `Graphics`, or
// the tests' recording layer.
//
// WHY: Phaser's WebGL Graphics draws every arc as 101 points, whatever its radius
// (`GraphicsWebGLRenderer`, a fixed step of 0.01 of a turn). A filled circle is triangulated by
// earcut over all of them, and a stroked one becomes 100 line quads. A muzzle flash a few
// pixels across paid that in full on every frame it showed (ADR 0005, the T3 entry). A regular
// polygon with as many sides as its size needs reads as a circle and costs a fraction of that.
//
// ONE SIDE-COUNT RULE FOR THE BOARD (R5, #181). How many sides is `circle-path.ts`'s decision
// (`circleSegments`): the fewest that keep the polygon within a quarter of a device pixel of its
// circle at the board's dpr. Its `polygonCircles` turns every live layer's `strokeCircle` and
// `fillCircle` into such a polygon; these helpers draw the same polygon through
// `fillPoints`/`strokePoints`, which that wrapper leaves alone, so a circle drawn here is never
// converted twice. (T3 first had a rule of its own here, 12 to 24 sides by a 3 CSS px side
// length; R4 left the two side by side, and R5 made them one.) What stays this file's own is
// where the corners sit: the first straight up from the centre, going clockwise.

import { circleSegments } from './circle-path';

const TAU = 2 * Math.PI;

/** What draws a circle's polygon: a filled one and a stroked, closed one. */
export interface PolygonGraphics {
  fillPoints(points: readonly { x: number; y: number }[], closeShape?: boolean): unknown;
  strokePoints(
    points: readonly { x: number; y: number }[],
    closeShape?: boolean,
    closePath?: boolean,
  ): unknown;
}

/** Each side count's corners on the unit circle, computed once. */
const unitCorners = new Map<number, readonly { readonly x: number; readonly y: number }[]>();

function cornersOf(n: number): readonly { readonly x: number; readonly y: number }[] {
  let corners = unitCorners.get(n);
  if (corners === undefined) {
    const made: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const a = (TAU * i) / n;
      made.push({ x: Math.sin(a), y: -Math.cos(a) });
    }
    corners = made;
    unitCorners.set(n, corners);
  }
  return corners;
}

/** The corners of the polygon drawn for the circle of radius `r` CSS px about `(x, y)`, at `dpr`
 *  device pixels per CSS px: `circleSegments(r, dpr)` points on the circle, evenly spaced, the
 *  first straight up from the centre, going clockwise (y grows downward). A radius that is not a
 *  positive number, NaN included, still gets the fewest sides, never none: an empty point list
 *  throws out of Phaser's `fillPoints` and `strokePoints` (they read the first point). */
export function circlePoints(
  x: number,
  y: number,
  r: number,
  dpr: number,
): { x: number; y: number }[] {
  return cornersOf(circleSegments(r, dpr)).map((c) => ({ x: x + r * c.x, y: y + r * c.y }));
}

/** Fill the circle of radius `r` about `(x, y)` as its polygon at `dpr`, in the fill style in
 *  force. */
export function fillCircleAsPolygon(
  g: PolygonGraphics,
  x: number,
  y: number,
  r: number,
  dpr: number,
): void {
  g.fillPoints(circlePoints(x, y, r, dpr), true);
}

/** Stroke the circle of radius `r` about `(x, y)` as its polygon at `dpr`, in the line style in
 *  force. The path is closed rather than its first corner repeated: Phaser closes a path by
 *  joining its last side to its first, where a repeated corner would add a side of no length. */
export function strokeCircleAsPolygon(
  g: PolygonGraphics,
  x: number,
  y: number,
  r: number,
  dpr: number,
): void {
  g.strokePoints(circlePoints(x, y, r, dpr), false, true);
}
