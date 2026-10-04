// circle-polygon.ts — a small circle drawn as a regular polygon (visual pass T3, #181; R5 reuses
// it for tracers, sparks and pips). Phaser-free: anything with `fillPoints` and `strokePoints`
// draws one — a live layer's Phaser `Graphics`, or the tests' recording layer.
//
// WHY: Phaser's WebGL Graphics draws every arc as 101 points, whatever its radius
// (`GraphicsWebGLRenderer`, a fixed step of 0.01 of a turn). A filled circle is triangulated by
// earcut over all of them, and a stroked one becomes 100 line quads. A muzzle flash a few
// pixels across paid that in full on every frame it showed (ADR 0005, the T3 entry). A regular
// polygon with as many sides as its size needs reads as a circle and costs a fraction of that:
// enough sides that none is longer than 3 CSS px, from 12 for the smallest circles up to 24,
// where a polygon strays from its circle by under 1% of its radius.

/** The fewest sides a circle's polygon has: the smallest circles still read as round. */
export const MIN_CIRCLE_SIDES = 12;
/** The most: a 24-sided polygon strays from its circle by under 1% of its radius, so a larger
 *  circle keeps 24 sides and its sides grow past `MAX_CIRCLE_SIDE_PX`. */
export const MAX_CIRCLE_SIDES = 24;
/** The longest side a circle's polygon is given before it gets another, CSS px. */
export const MAX_CIRCLE_SIDE_PX = 3;

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

/** How many sides the polygon for a circle of radius `r` CSS px has: enough that no side is
 *  longer than `MAX_CIRCLE_SIDE_PX`, within `MIN_CIRCLE_SIDES`..`MAX_CIRCLE_SIDES`. */
export function circleSides(r: number): number {
  const n = Math.ceil((TAU * Math.max(0, r)) / MAX_CIRCLE_SIDE_PX);
  return Math.min(MAX_CIRCLE_SIDES, Math.max(MIN_CIRCLE_SIDES, n));
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

/** The corners of the polygon drawn for the circle of radius `r` about `(x, y)`: `circleSides(r)`
 *  points on the circle, evenly spaced, the first straight up from the centre, going clockwise
 *  (y grows downward). */
export function circlePoints(x: number, y: number, r: number): { x: number; y: number }[] {
  return cornersOf(circleSides(r)).map((c) => ({ x: x + r * c.x, y: y + r * c.y }));
}

/** Fill the circle of radius `r` about `(x, y)` as its polygon, in the fill style in force. */
export function fillCircleAsPolygon(g: PolygonGraphics, x: number, y: number, r: number): void {
  g.fillPoints(circlePoints(x, y, r), true);
}

/** Stroke the circle of radius `r` about `(x, y)` as its polygon, in the line style in force.
 *  The path is closed rather than its first corner repeated: Phaser closes a path by joining its
 *  last side to its first, where a repeated corner would add a side of no length. */
export function strokeCircleAsPolygon(g: PolygonGraphics, x: number, y: number, r: number): void {
  g.strokePoints(circlePoints(x, y, r), false, true);
}
