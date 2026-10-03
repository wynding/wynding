// art-paint.ts — the Canvas2D painter for the vector art kit (`art-ir.ts`, visual pass #181),
// and `artGraphics`: the bake's drawing surface (`canvas-graphics.ts`'s `BakeGraphics`) with
// the two operations the art needs on top — paint IR shapes, and fade what a frame has
// painted so far as one picture. Phaser-free like the rest of the bake: the context is
// structural, so the scene and the Card swatch hand in a real 2D context and the unit tests
// a recorder.
//
// Shapes are painted in DESIGN UNITS under a transform `art()` sets up, so widths and dashes
// scale with the art exactly as they would in SVG. Path strings go through `Path2D`, made
// by a factory the caller supplies (`(d) => new Path2D(d)` in a browser) — Canvas2D parses
// them itself, so there is no second path parser on the drawing side.

import { canvasGraphics, cssColour, type BakeGraphics, type Canvas2DLike } from './canvas-graphics';
import { dashAt, rectRadius, strokeWidthAt, type ArtColour, type ArtShape } from './art-ir';

/** What the art painter needs of a 2D context beyond the bake's own slice. A real
 *  `CanvasRenderingContext2D` satisfies it structurally. */
export interface ArtCanvas2DLike extends Canvas2DLike {
  globalCompositeOperation: GlobalCompositeOperation;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  fill(path?: Path2D): void;
  stroke(path?: Path2D): void;
  setLineDash(segments: number[]): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}

/** Makes a `Path2D` from an SVG path string — `(d) => new Path2D(d)` in a browser. */
export type PathFactory = (d: string) => Path2D;

/** Resolves an art colour token to `0xRRGGBB` (`tower-art.ts`'s `artColour`, bound to a
 *  palette and a role). */
export type ArtColourResolver = (token: ArtColour) => number;

const TAU = Math.PI * 2;

/** Trace `shape`'s outline as the context's current path (every kind but a path string,
 *  which is a `Path2D` of its own). Radii are clamped at zero, so no shape can hand the
 *  context a negative one. */
function traceShape(ctx: ArtCanvas2DLike, shape: Exclude<ArtShape, { kind: 'path' }>): void {
  ctx.beginPath();
  switch (shape.kind) {
    case 'circle':
      ctx.arc(shape.cx, shape.cy, Math.max(0, shape.r), 0, TAU);
      break;
    case 'ellipse':
      ctx.ellipse(shape.cx, shape.cy, Math.max(0, shape.rx), Math.max(0, shape.ry), 0, 0, TAU);
      break;
    case 'polygon': {
      shape.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      break;
    }
    case 'rect': {
      // SVG's rounded rect, clockwise from the top edge.
      const { x, y, w, h } = shape;
      const r = rectRadius(shape);
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
      ctx.lineTo(x + w, y + h - r);
      ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
      ctx.lineTo(x + r, y + h);
      ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
      ctx.lineTo(x, y + r);
      ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
      break;
    }
  }
  ctx.closePath();
}

/**
 * Paint `shapes` in order into `ctx`, in design units — the caller has set the transform
 * from design units to the target (`artGraphics().art` does). Each shape fills, then
 * strokes, like SVG; its alpha rides in the colour, so no paint state outlives the shape but
 * line style, which every stroke restates in full (width, join, cap, dash). `unit` is the
 * CSS px per design unit the art is being drawn at, for the CSS-px floors on stroke widths
 * and dashes.
 */
export function paintArtShapes(
  ctx: ArtCanvas2DLike,
  shapes: readonly ArtShape[],
  colour: ArtColourResolver,
  makePath: PathFactory | undefined,
  unit: number,
): void {
  for (const shape of shapes) {
    const alpha = shape.alpha ?? 1;
    let path: Path2D | undefined;
    if (shape.kind === 'path') {
      if (makePath === undefined) {
        throw new Error('art with a path shape needs a Path2D factory');
      }
      path = makePath(shape.d);
    } else {
      traceShape(ctx, shape);
    }
    if (shape.fill !== undefined) {
      ctx.fillStyle = cssColour(colour(shape.fill), alpha);
      if (path === undefined) ctx.fill();
      else ctx.fill(path);
    }
    if (shape.stroke !== undefined) {
      ctx.strokeStyle = cssColour(colour(shape.stroke), alpha);
      ctx.lineWidth = strokeWidthAt(shape, unit);
      ctx.lineJoin = shape.join ?? 'miter';
      ctx.lineCap = shape.cap ?? 'butt';
      ctx.setLineDash(dashAt(shape, unit));
      if (path === undefined) ctx.stroke();
      else ctx.stroke(path);
    }
  }
}

/** Half the side of the square `fade` fills, CSS px — far past any frame, which the bake's
 *  per-frame clip then cuts it down to. */
const FADE_EXTENT = 1e6;

/** The bake's drawing surface with the art kit's operations on top. */
export interface ArtGraphics extends BakeGraphics {
  /** Paint `shapes` with design-unit (0, 0) at `(x, y)` CSS px and `unit` CSS px per design
   *  unit, colours resolved by `colour`. The context's state — transform, line style, dash —
   *  is restored afterwards, so the `GraphicsLike` calls around it keep Phaser's. */
  art(
    shapes: readonly ArtShape[],
    colour: ArtColourResolver,
    x: number,
    y: number,
    unit: number,
  ): void;
  /** Multiply the opacity of everything painted so far INSIDE THE CURRENT CLIP by `alpha` —
   *  group opacity, the way an SVG group's `opacity` fades its contents as one picture
   *  rather than shape by shape. Clip-scoped: the bake clips every atlas frame to its own
   *  rectangle (`paintAtlas`), which is what keeps it from reaching a neighbour. */
  fade(alpha: number): void;
}

/** `canvasGraphics` over `ctx`, plus `art` and `fade`. `makePath` is needed only to paint a
 *  path shape. */
export function artGraphics(ctx: ArtCanvas2DLike, makePath?: PathFactory): ArtGraphics {
  const base = canvasGraphics(ctx);
  return {
    ...base,
    art(shapes, colour, x, y, unit) {
      base.flush();
      ctx.save();
      ctx.transform(unit, 0, 0, unit, x, y);
      paintArtShapes(ctx, shapes, colour, makePath, unit);
      ctx.restore();
    },
    fade(alpha) {
      base.flush();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = cssColour(0, Math.min(1, Math.max(0, alpha)));
      ctx.fillRect(-FADE_EXTENT, -FADE_EXTENT, FADE_EXTENT * 2, FADE_EXTENT * 2);
      ctx.restore();
    },
  };
}
