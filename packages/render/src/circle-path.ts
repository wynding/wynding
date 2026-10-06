// circle-path.ts — the live layers' circles, drawn as polygons sized to their radius (#181).
//
// Phaser's Graphics draws EVERY arc as 100 segments — a 1.5px DoT pip and a boss's 50px ward
// alike — and builds a point object for each of them, on every frame (the ARC case of
// `GraphicsWebGLRenderer`, a fixed `iterStep` of 0.01). The live layers draw hundreds of
// circles a frame on a busy board: the creep cues' rings and pips, the ink edge under each
// (C3), the tracers' dots and the sparks. Tessellating those is where the board's frame time
// goes (ADR 0005's S10 finding), and the ink edges added half as many again.
//
// So a live layer draws a circle as a closed polygon with only as many sides as keep it
// within `CIRCLE_TOLERANCE_DEVICE_PX` of the true circle on screen: 8 for a pip, 16 to 20 for
// a status ring, 32 for a boss's ward at a 40px cell (56 at dpr 3) — never more than Phaser's
// own 100. Phaser-free: `scene.ts` hands each live layer's Graphics to `polygonCircles`.

/** The most a polygon's edge may fall inside its circle, in device pixels — a quarter of
 *  one, which no anti-aliased stroke can show. */
export const CIRCLE_TOLERANCE_DEVICE_PX = 0.25;

/** The fewest sides a circle is drawn with, however small — a pip stays round. */
export const CIRCLE_MIN_SEGMENTS = 8;

/** The most sides a circle is drawn with: Phaser's own count, which this never exceeds. */
export const CIRCLE_MAX_SEGMENTS = 100;

/** How many sides a circle of `radius` CSS px is drawn with at `dpr` device pixels per CSS
 *  px: the fewest whose edges' midpoints fall no more than `CIRCLE_TOLERANCE_DEVICE_PX` inside
 *  it — `r × (1 − cos(π / n)) ≤ tolerance` — within the bounds above. */
export function circleSegments(radius: number, dpr: number): number {
  const r = radius * dpr;
  if (!(r > CIRCLE_TOLERANCE_DEVICE_PX)) return CIRCLE_MIN_SEGMENTS;
  const n = Math.ceil(Math.PI / Math.acos(1 - CIRCLE_TOLERANCE_DEVICE_PX / r));
  return Math.min(CIRCLE_MAX_SEGMENTS, Math.max(CIRCLE_MIN_SEGMENTS, n));
}

/** The path calls a circle is drawn through, and the two circle calls this replaces — a
 *  Phaser `Graphics` has all of them. */
export interface PathGraphics {
  beginPath(): unknown;
  moveTo(x: number, y: number): unknown;
  lineTo(x: number, y: number): unknown;
  closePath(): unknown;
  strokePath(): unknown;
  fillPath(): unknown;
  strokeCircle(x: number, y: number, radius: number): unknown;
  fillCircle(x: number, y: number, radius: number): unknown;
}

/** `g`, with its `strokeCircle` and `fillCircle` drawing a closed polygon of
 *  `circleSegments(radius, dpr())` sides instead — `dpr` read at each call, so a monitor move
 *  is followed. The polygon's corners lie on the circle, the first at its rightmost point, and
 *  the path is CLOSED, so a stroke joins its last side to its first without a seam. Every
 *  other call is `g`'s own. */
export function polygonCircles<G extends PathGraphics>(g: G, dpr: () => number): G {
  const trace = (x: number, y: number, radius: number): void => {
    const n = circleSegments(radius, dpr());
    g.beginPath();
    g.moveTo(x + radius, y);
    for (let i = 1; i < n; i++) {
      const t = (i * 2 * Math.PI) / n;
      g.lineTo(x + radius * Math.cos(t), y + radius * Math.sin(t));
    }
    g.closePath();
  };
  const paths: PathGraphics = g;
  paths.strokeCircle = (x, y, radius) => {
    trace(x, y, radius);
    g.strokePath();
    return g;
  };
  paths.fillCircle = (x, y, radius) => {
    trace(x, y, radius);
    g.fillPath();
    return g;
  };
  return g;
}
