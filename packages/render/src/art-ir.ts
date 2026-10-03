// art-ir.ts — the vector art kit's intermediate representation (visual pass, #181): a small,
// typed, Phaser-free description of a piece of art as a list of shapes, each with its own
// paint. The IR is the EDITABLE MASTER of the game's art (ADR 0002: art is original and its
// master is committed — here, as code): `tower-art.ts` holds the towers' art in it, the
// Canvas2D painter (`art-paint.ts`) draws it into the board atlas and the Card swatches, and
// `art-geometry.ts` measures it (frame sizes, and the tests that reason about what the art
// covers).
//
// Coordinates are DESIGN UNITS. A tower's art lives in a 64-unit box — one 2×2 footprint —
// and is drawn scaled by `2 × cellPx / 64` CSS px per unit, so it is resolution-independent:
// the same master bakes at every cell size and device pixel ratio. Stroke widths and dash
// lengths are design units too (they scale with the art, as in SVG), with an optional floor
// in CSS px so a line that matters still reads at a phone's cell size.

/** A colour an art shape paints with — a TOKEN, resolved per palette at paint time
 *  (`tower-art.ts`'s `artColour`). Some come from the colour-vision palette and so follow the
 *  player's colour mode; the rest are fixed art inks. */
export type ArtColour =
  /** The tower's role colour (`roleColour`, palette). */
  | 'role'
  /** The tower plate's fill (`palette.plate`). */
  | 'plate'
  /** The board floor (`palette.floor`) — the pad a plateless tower stands on. */
  | 'floor'
  /** The plate's rim — `palette.tower`, gated ≥ 3:1 against the floor. */
  | 'rim'
  /** `palette.aura` — the glow on a tower a beacon boosts. */
  | 'aura'
  /** Near-black outline and glyph ink. */
  | 'ink'
  /** The plate's top-edge highlight. */
  | 'bevel'
  /** Drop shadows. */
  | 'shadow'
  /** The venom head's highlight. */
  | 'gloss'
  /** A spent mine's scorch mark, and its cracks. */
  | 'scorch'
  | 'crack';

/** How one shape is painted. A shape may fill, stroke, or both (fill first, as in SVG). */
export interface ArtPaint {
  readonly fill?: ArtColour;
  readonly stroke?: ArtColour;
  /** Stroke width, design units. Default 1. */
  readonly width?: number;
  /** A floor on the stroke width, in CSS px: the stroke is never drawn thinner than this,
   *  whatever the scale. For lines that must stay visible at a phone's cell size. */
  readonly minWidthPx?: number;
  /** Opacity, applied to the fill and the stroke each — exact for a shape that only fills
   *  or only strokes; a shape that does both below 1 would compound where they overlap, so
   *  the art does not use that combination (`tower-art.test.ts` holds it to that). */
  readonly alpha?: number;
  /** Stroke dash pattern, design units (`setLineDash`). */
  readonly dash?: readonly number[];
  /** A floor on the SHORTEST dash or gap, in CSS px: the whole pattern scales up until it
   *  is met, so the dashes stay dashes, not a grey line, at a phone's cell size. */
  readonly dashMinPx?: number;
  /** Default `'miter'`, as in SVG and Canvas2D. */
  readonly join?: CanvasLineJoin;
  /** Default `'butt'`, as in SVG and Canvas2D. */
  readonly cap?: CanvasLineCap;
}

/** An SVG path string — absolute or relative M/L/H/V/C/S/Q/T/A/Z commands, numbers
 *  separated by spaces or commas (an arc's two flags too: `0 0 1`, never packed `001`). */
export interface ArtPath extends ArtPaint {
  readonly kind: 'path';
  readonly d: string;
}

export interface ArtCircle extends ArtPaint {
  readonly kind: 'circle';
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

export interface ArtEllipse extends ArtPaint {
  readonly kind: 'ellipse';
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

/** A rectangle with SVG's corner radius: `rx` is clamped to half the shorter side. */
export interface ArtRect extends ArtPaint {
  readonly kind: 'rect';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rx: number;
  /** Stroke on WHOLE TEXELS wherever the art is baked onto a texel grid
   *  (`alignArtToTexels`): a thin stroke whose centre line falls inside a texel is
   *  anti-aliased across two, each partly covered, and reads at a fraction of its colour's
   *  contrast. The fill, if any, moves with it — so the art gives a crisp stroke a rect of
   *  its own. */
  readonly crisp?: boolean;
}

/** A closed polygon through `points`. */
export interface ArtPolygon extends ArtPaint {
  readonly kind: 'polygon';
  readonly points: readonly (readonly [number, number])[];
}

export type ArtShape = ArtPath | ArtCircle | ArtEllipse | ArtRect | ArtPolygon;

/** The stroke width `shape` is drawn with at `unit` CSS px per design unit, in design units:
 *  its own width, raised to its `minWidthPx` floor. */
export function strokeWidthAt(shape: ArtPaint, unit: number): number {
  const width = shape.width ?? 1;
  return shape.minWidthPx === undefined || unit <= 0
    ? width
    : Math.max(width, shape.minWidthPx / unit);
}

/** The dash pattern `shape` is drawn with at `unit` CSS px per design unit, in design units:
 *  its own pattern, scaled up (never down) until its shortest entry meets `dashMinPx`. Empty
 *  for a solid stroke. */
export function dashAt(shape: ArtPaint, unit: number): number[] {
  const dash = shape.dash ?? [];
  if (dash.length === 0) return [];
  const shortest = Math.min(...dash);
  const floor = shape.dashMinPx === undefined || unit <= 0 ? 0 : shape.dashMinPx / unit;
  const k = shortest > 0 && floor > shortest ? floor / shortest : 1;
  return dash.map((d) => d * k);
}

/** A box in design units — `[minX, minY, maxX, maxY]`. */
export type ArtBox = readonly [number, number, number, number];

/**
 * `rect`'s stroke moved onto whole texels, for art drawn at `unit` CSS px per design unit
 * and `scale` texels per CSS px, with design-unit (0, 0) at texel `origin` (only its
 * fractional part matters: a whole-texel offset moves nothing).
 *
 * WIDTH: a whole number of texels — never under its CSS-px floor, which rounds UP (a one-CSS-
 * px floor is 2 texels at dpr 1.25 or 1.5), so the floor holds as a floor; otherwise the
 * nearest to its own width, the thinner at a tie; never fewer than one.
 *
 * PLACE: each straight edge's centre line moves to the nearest place where the stroke covers
 * whole texels, once any width the rounding ADDED has been put on the outside — so a
 * widened stroke keeps its inner side, towards the rect's middle, within half a texel of the
 * design's, and whatever the rect holds keeps its clearance from it; a stroke rounded
 * thinner keeps its centre line within half a texel. So the edges are drawn in the stroke's
 * full colour, rather than anti-aliased across two partly covered texels (a one-texel line
 * centred inside a texel shows about half its colour's contrast). With `within`, the
 * stroke's outer edges stay inside that box (a tower's footprint, cut to the surface it is
 * drawn on), an edge that would cross it moving inward to the first place inside it — which
 * can take it a little over half a texel from the design's. (Whole texels reach the screen
 * as whole device pixels only where the surface is shown pixel for pixel, as `scene.ts`
 * sizes the board's canvas to be.)
 *
 * The corner radius is kept, and the result is a plain stroke at its final width, with no
 * CSS-px floor left to apply. A rect with no stroke is returned as it is.
 */
export function alignRectToTexels(
  rect: ArtRect,
  unit: number,
  scale: number,
  origin: readonly [number, number] = [0, 0],
  within?: ArtBox,
): ArtRect {
  const k = unit * scale; // texels per design unit
  if (!(k > 0) || rect.stroke === undefined) return rect;
  // (A hair of floating-point noise is not enough to round a width up, nor to break a tie.)
  const floor = rect.minWidthPx === undefined ? 0 : Math.ceil(rect.minWidthPx * scale - 1e-9);
  const own = Math.ceil((rect.width ?? 1) * k - 0.5 - 1e-9);
  const width = Math.max(1, floor, own);
  // Half the width the rounding added beyond the design's, floor included: it goes outward.
  const grow = Math.max(0, width - strokeWidthAt(rect, unit) * k) / 2;
  const [ox, oy] = origin;
  /** The first texel of a stroke whose centre line lies at texel `centre`. */
  const start = (centre: number): number => Math.round(centre - width / 2);
  const near = (edge: number, at: number, min: number | undefined): number => {
    const s = start(at + edge * k - grow);
    return min === undefined ? s : Math.max(s, Math.ceil(at + min * k - 1e-9));
  };
  const far = (edge: number, at: number, max: number | undefined): number => {
    const s = start(at + edge * k + grow);
    return max === undefined ? s : Math.min(s, Math.floor(at + max * k + 1e-9) - width);
  };
  const left = near(rect.x, ox, within?.[0]);
  const top = near(rect.y, oy, within?.[1]);
  const right = Math.max(left, far(rect.x + rect.w, ox, within?.[2]));
  const bottom = Math.max(top, far(rect.y + rect.h, oy, within?.[3]));
  /** Back to design units: the centre line of the stroke starting at texel `s`. */
  const line = (s: number, at: number): number => (s + width / 2 - at) / k;
  const x = line(left, ox);
  const y = line(top, oy);
  const { minWidthPx: _floorApplied, ...rest } = rect;
  return {
    ...rest,
    x,
    y,
    w: line(right, ox) - x,
    h: line(bottom, oy) - y,
    width: width / k,
  };
}

/** `shapes` with every `crisp` rect aligned by `alignRectToTexels` — the SAME array when
 *  none is, so a list with nothing to align keeps its identity. */
export function alignArtToTexels(
  shapes: readonly ArtShape[],
  unit: number,
  scale: number,
  origin: readonly [number, number] = [0, 0],
  within?: ArtBox,
): readonly ArtShape[] {
  const crisp = (s: ArtShape): s is ArtRect => s.kind === 'rect' && s.crisp === true;
  if (!shapes.some(crisp)) return shapes;
  return shapes.map((s) => (crisp(s) ? alignRectToTexels(s, unit, scale, origin, within) : s));
}

/** SVG's rect corner radius rule: `rx` clamped to half of each side. */
export function rectRadius(rect: Pick<ArtRect, 'w' | 'h' | 'rx'>): number {
  return Math.max(0, Math.min(rect.rx, rect.w / 2, rect.h / 2));
}
