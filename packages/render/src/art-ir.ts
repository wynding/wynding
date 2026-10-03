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

/** SVG's rect corner radius rule: `rx` clamped to half of each side. */
export function rectRadius(rect: Pick<ArtRect, 'w' | 'h' | 'rx'>): number {
  return Math.max(0, Math.min(rect.rx, rect.w / 2, rect.h / 2));
}
