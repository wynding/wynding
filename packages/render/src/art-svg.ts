// art-svg.ts — the vector art kit's SVG renderer (visual pass, #181): IR shapes (`art-ir.ts`)
// as SVG elements, for art the DOM draws — the wave strip's creep icons (`apps/web`'s
// `hud-icons.ts`) — so the DOM draws the board's own art from the board's own master rather
// than restating its geometry. Pure and DOM-free: it returns each element as a tag and its
// attributes, which the caller creates in its own document.
//
// Colours stay TOKENS: each element names its fill and stroke token in `data-art-fill` and
// `data-art-stroke`, which the caller resolves (`creepArtColour`, for a creep) and writes as
// `fill`/`stroke`. So a colour-mode change re-inks the very same elements, and a stylesheet can
// select the parts by the token they paint in.
//
// Geometry is written in DESIGN UNITS, as SVG would draw the IR: the caller scales the whole
// picture (a `viewBox`, a `transform`), stroke widths and dashes with it. A stroke's CSS-px
// floor needs to know how large the picture is drawn, so it is applied at the `unit` — CSS px
// per design unit — the caller passes, as the board's painter applies it at its own.

import { dashAt, strokeWidthAt, type ArtShape } from './art-ir';

/** One SVG element: its tag, and its attributes in the order they are written. */
export interface ArtSvgNode {
  readonly tag: 'path' | 'circle' | 'ellipse' | 'rect' | 'polygon';
  readonly attrs: Readonly<Record<string, string>>;
}

/** A number as an SVG attribute: rounded to 1/1000 of a unit, never `-0`. */
function num(v: number): string {
  return String(Math.round(v * 1000) / 1000 + 0);
}

/**
 * `shapes` as SVG elements, in paint order. Each keeps its geometry in design units and its
 * paint as SVG paints it — a fill and then a stroke, `fill-opacity`/`stroke-opacity` for the
 * shape's alpha (exact, as the board's painter applies it to each), its stroke width and dash
 * raised to their CSS-px floors at `unit` CSS px per design unit (none applied without one),
 * its join and cap — with `fill="none"` on a shape that does not fill, since SVG's default fill
 * is black. Colours are left to the caller: the elements carry their tokens.
 */
export function artSvgNodes(shapes: readonly ArtShape[], unit?: number): ArtSvgNode[] {
  const at = unit ?? Infinity; // no floor: a floor in CSS px is nothing at infinite scale
  return shapes.map((shape): ArtSvgNode => {
    const attrs: Record<string, string> = {};
    switch (shape.kind) {
      case 'path':
        attrs.d = shape.d;
        break;
      case 'circle':
        attrs.cx = num(shape.cx);
        attrs.cy = num(shape.cy);
        attrs.r = num(Math.max(0, shape.r));
        break;
      case 'ellipse':
        attrs.cx = num(shape.cx);
        attrs.cy = num(shape.cy);
        attrs.rx = num(Math.max(0, shape.rx));
        attrs.ry = num(Math.max(0, shape.ry));
        break;
      case 'rect':
        // SVG clamps `rx` to half the shorter side itself — the IR's own rule (`rectRadius`).
        attrs.x = num(shape.x);
        attrs.y = num(shape.y);
        attrs.width = num(shape.w);
        attrs.height = num(shape.h);
        attrs.rx = num(shape.rx);
        break;
      case 'polygon':
        attrs.points = shape.points.map(([x, y]) => `${num(x)},${num(y)}`).join(' ');
        break;
    }
    const alpha = shape.alpha ?? 1;
    if (shape.fill === undefined) {
      attrs.fill = 'none';
    } else {
      attrs['data-art-fill'] = shape.fill;
      if (alpha !== 1) attrs['fill-opacity'] = num(alpha);
    }
    if (shape.stroke !== undefined) {
      attrs['data-art-stroke'] = shape.stroke;
      attrs['stroke-width'] = num(strokeWidthAt(shape, at));
      if (alpha !== 1) attrs['stroke-opacity'] = num(alpha);
      if (shape.join !== undefined) attrs['stroke-linejoin'] = shape.join;
      if (shape.cap !== undefined) attrs['stroke-linecap'] = shape.cap;
      const dash = dashAt(shape, at);
      if (dash.length > 0) attrs['stroke-dasharray'] = dash.map(num).join(' ');
    }
    return { tag: shape.kind, attrs };
  });
}
