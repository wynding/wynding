// canvas-graphics.ts — `GraphicsLike` over a Canvas2D context, the drawing surface the
// board's static art is BAKED through (`bake.ts`): the board texture and the sprite atlas are
// painted by the very geometry code that used to draw them into a Phaser `Graphics` every
// frame, so the baked art matches it by construction rather than by a second copy of the
// shapes. Phaser-free like `board-draw.ts`: the context is structural (`Canvas2DLike`), so
// `scene.ts` hands in the real context of the canvas it uploads as a texture, and the unit
// test hands in a recorder.
//
// It reproduces Phaser `Graphics` SEMANTICS, which is where Canvas2D differs:
//
//  - Styles LATCH. `fillStyle`/`lineStyle` apply to every later shape until restated, and
//    their alpha defaults to 1, as Phaser's do.
//  - Every primitive composites ON ITS OWN. Two strokes at alpha 0.6 that cross read 0.84
//    where they overlap, exactly as two Phaser primitives blended one after the other do —
//    the pending-build variant is baked primitive by primitive at its own alphas for that
//    reason, never flattened and then faded as a whole.
//  - Rounded rects trace Phaser's own paths: the fill as one continuous outline with the 20px
//    default radius; the stroke clamped to half the shorter side and built from separate
//    edge and corner sub-paths (Phaser's `strokeRoundedRect` moves between them).
//
// One deliberate departure, made so the bake LOOKS like the WebGL draw rather than merely
// calling the same functions: consecutive OPAQUE `fillRect`s of one colour fill as ONE path.
// The WebGL renderer resolves edges by multisampling, so two same-colour rects sharing an edge
// leave no trace of it; Canvas2D anti-aliases each fill on its own, and where a shared edge
// falls inside a texel (a fractional bake scale — any browser zoom or 125%/150% display) each
// rect covers that texel only partly and the board floor shows through as a faint seam. The
// border ring is a run of exactly such rects. One path has no interior edges, so no seams.
// Translucent rects are never merged — merging would stop their overlaps compounding, which
// is the per-primitive rule above. `flush()` paints whatever is still batched; the bake calls
// it after every painter, and every other drawing call flushes first, so draw order holds.

import type { GraphicsLike } from './board-draw';

/** The slice of `CanvasRenderingContext2D` the bake draws through — a real 2D context
 *  satisfies it structurally. */
export interface Canvas2DLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  rect(x: number, y: number, width: number, height: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clip(): void;
}

/** A `GraphicsLike` that also has a batch to drain: call `flush()` after the last primitive. */
export interface BakeGraphics extends GraphicsLike {
  flush(): void;
}

/** `0xRRGGBB` + alpha as a CSS colour. */
export function cssColour(colour: number, alpha: number): string {
  return `rgba(${(colour >> 16) & 0xff}, ${(colour >> 8) & 0xff}, ${colour & 0xff}, ${alpha})`;
}

const HALF_PI = Math.PI / 2;

/** Phaser's `fillRoundedRect` / `strokeRoundedRect` default radius. */
const PHASER_DEFAULT_RADIUS = 20;

export function canvasGraphics(ctx: Canvas2DLike): BakeGraphics {
  // Phaser strokes are quads per segment — square-ended, no cap.
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  let fill = cssColour(0, 1);
  let fillOpaque = true;
  let stroke = cssColour(0, 1);
  let strokeWidth = 1;
  // The opaque-rect batch: rects that will fill as ONE path in `batchColour`.
  let batch: [number, number, number, number][] = [];
  let batchColour = '';

  const flush = (): void => {
    if (batch.length === 0) return;
    ctx.beginPath();
    for (const [x, y, w, h] of batch) ctx.rect(x, y, w, h);
    ctx.fillStyle = batchColour;
    ctx.fill();
    batch = [];
  };
  const fillPath = (): void => {
    ctx.fillStyle = fill;
    ctx.fill();
  };
  const strokePath = (): void => {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
  };

  const g: BakeGraphics = {
    flush,
    fillStyle(colour, alpha = 1) {
      fill = cssColour(colour, alpha);
      fillOpaque = alpha >= 1;
      return g;
    },
    lineStyle(lineWidth, colour, alpha = 1) {
      strokeWidth = lineWidth;
      stroke = cssColour(colour, alpha);
      return g;
    },
    fillRect(x, y, width, height) {
      if (fillOpaque) {
        if (batch.length > 0 && batchColour !== fill) flush();
        batchColour = fill;
        batch.push([x, y, width, height]);
        return g;
      }
      flush();
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, width, height);
      return g;
    },
    fillRoundedRect(x, y, width, height, radius = PHASER_DEFAULT_RADIUS) {
      flush();
      // Phaser's path, corner by corner; no clamp on the fill (Phaser applies none).
      const r = Math.abs(radius);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.arc(x + width - r, y + r, r, -HALF_PI, 0);
      ctx.lineTo(x + width, y + height - r);
      ctx.arc(x + width - r, y + height - r, r, 0, HALF_PI);
      ctx.lineTo(x + r, y + height);
      ctx.arc(x + r, y + height - r, r, HALF_PI, Math.PI);
      ctx.lineTo(x, y + r);
      ctx.arc(x + r, y + r, r, -Math.PI, -HALF_PI);
      fillPath();
      return g;
    },
    strokeRoundedRect(x, y, width, height, radius = PHASER_DEFAULT_RADIUS) {
      flush();
      // Phaser clamps the stroke's radius to half the shorter side, and moves between the
      // straight edges and the corner arcs — separate sub-paths, butt-ended where they meet.
      const r = Math.min(Math.abs(radius), Math.min(width, height) / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.moveTo(x + width - r, y);
      ctx.arc(x + width - r, y + r, r, -HALF_PI, 0);
      ctx.lineTo(x + width, y + height - r);
      ctx.moveTo(x + width, y + height - r);
      ctx.arc(x + width - r, y + height - r, r, 0, HALF_PI);
      ctx.lineTo(x + r, y + height);
      ctx.moveTo(x + r, y + height);
      ctx.arc(x + r, y + height - r, r, HALF_PI, Math.PI);
      ctx.lineTo(x, y + r);
      ctx.moveTo(x, y + r);
      ctx.arc(x + r, y + r, r, -Math.PI, -HALF_PI);
      strokePath();
      return g;
    },
    fillTriangle(x0, y0, x1, y1, x2, y2) {
      flush();
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.closePath();
      fillPath();
      return g;
    },
    fillCircle(x, y, radius) {
      flush();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      fillPath();
      return g;
    },
    strokeCircle(x, y, radius) {
      flush();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      strokePath();
      return g;
    },
    fillPoints(points, closeShape = false) {
      flush();
      const first = points[0];
      if (first === undefined) return g;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < points.length; i++) {
        const p = points[i] as { x: number; y: number };
        ctx.lineTo(p.x, p.y);
      }
      if (closeShape) ctx.lineTo(first.x, first.y);
      fillPath();
      return g;
    },
    lineBetween(x0, y0, x1, y1) {
      flush();
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      strokePath();
      return g;
    },
  };
  return g;
}
