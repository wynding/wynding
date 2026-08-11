// swatch.ts — paints each Card's footprint-glyph swatch (playtest round): a mini board
// tile — the palette's floor as ground, the `pal.tower` rounded body inset 2 with radius
// 6 (the committed tower's own draw, `board-draw.ts`), and the tower's footprint mark at
// centre in `pal.floor` — through the SAME `drawFootprintMark` dispatch the board uses
// (#89: one glyph vocabulary; an SVG twin here would be the second copy that rots). The
// colour pairing is therefore exactly the one the board already ships and the palette
// gates — nothing here invents a contrast surface.
//
// The 2D-context adapter implements `GraphicsLike` structurally — the same Phaser-free
// seam `scene.test.ts`'s recording fake uses — so Phaser never enters this module. Under
// vitest, `getContext` is stubbed to a QUIET null (vitest.setup.ts — jsdom's own
// implementation throws a noisy not-implemented jsdomError per call), so `paintSwatch`
// is unit-inert through the same null-context contract that guards a lost context in
// production; the adapter itself is unit tested against a recording context instead.

import {
  drawFootprintMark,
  towerFootprintMarkFor,
  resolvePalette,
  type ColourMode,
  type GraphicsLike,
} from '@wynding/render';

/** The swatch's logical (CSS px) size — mirrored by `.wy-card-swatch`'s width/height in
 *  ui.css. 36px makes the tile a cellPx-18 tower: comfortably above the narrow-floor
 *  sizes at which the mark vocabulary is already proven legible. */
export const SWATCH_SIZE_PX = 36;

const cssColour = (colour: number, alpha: number): string =>
  `rgba(${(colour >> 16) & 0xff}, ${(colour >> 8) & 0xff}, ${colour & 0xff}, ${alpha})`;

/** `GraphicsLike` over a DOM 2D context. Fill/line style are latched (Phaser semantics:
 *  a style call applies to every later shape until restated). Rounded rects trace an
 *  explicit arc path — Canvas2D's own `roundRect` is newer than this app's support floor.
 *  Exported for the unit test only; runtime callers go through `paintSwatch`. */
export function canvasGraphics(ctx: CanvasRenderingContext2D): GraphicsLike {
  let fill = 'rgba(0, 0, 0, 1)';
  let stroke = 'rgba(0, 0, 0, 1)';
  let strokeWidth = 1;
  const roundedRectPath = (x: number, y: number, w: number, h: number, r = 0): void => {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  };
  return {
    fillStyle(colour, alpha = 1) {
      fill = cssColour(colour, alpha);
      return this;
    },
    lineStyle(lineWidth, colour, alpha = 1) {
      strokeWidth = lineWidth;
      stroke = cssColour(colour, alpha);
      return this;
    },
    fillRect(x, y, width, height) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, width, height);
      return this;
    },
    fillRoundedRect(x, y, width, height, radius) {
      roundedRectPath(x, y, width, height, radius);
      ctx.fillStyle = fill;
      ctx.fill();
      return this;
    },
    strokeRoundedRect(x, y, width, height, radius) {
      roundedRectPath(x, y, width, height, radius);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
      return this;
    },
    fillTriangle(x0, y0, x1, y1, x2, y2) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      return this;
    },
    fillCircle(x, y, radius) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      return this;
    },
    strokeCircle(x, y, radius) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
      return this;
    },
    fillPoints(points, closeShape) {
      if (points.length === 0) return this;
      ctx.beginPath();
      ctx.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
      if (closeShape === true) ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      return this;
    },
    lineBetween(x0, y0, x1, y1) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
      return this;
    },
  };
}

/** Paint `towerId`'s glyph tile onto `canvas` at the palette for `mode`. Called at boot
 *  and again on every colour-mode change (`main.ts`), never per frame. The backing store
 *  is sized to `SWATCH_SIZE_PX` × the CURRENT devicePixelRatio for a crisp stroke on
 *  HiDPI — re-derived on each (rare) repaint, so a monitor move is corrected by the next
 *  mode change at worst. */
export function paintSwatch(canvas: HTMLCanvasElement, towerId: string, mode: ColourMode): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return; // stubbed jsdom / lost context — the Card's text carries everything
  // The canvas's OWN window, not the global (every module here threads the injected
  // document); rounded because the DOM truncates fractional backing sizes, and a
  // truncated store under an unrounded transform clips the tile's right/bottom edge at
  // fractional OS scale factors (e.g. 125% → dpr 1.25).
  const rawDpr = canvas.ownerDocument.defaultView?.devicePixelRatio;
  const dpr = typeof rawDpr === 'number' && Number.isFinite(rawDpr) ? Math.max(1, rawDpr) : 1;
  canvas.width = Math.round(SWATCH_SIZE_PX * dpr);
  canvas.height = Math.round(SWATCH_SIZE_PX * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pal = resolvePalette(mode);
  const g = canvasGraphics(ctx);
  // Ground, body, mark — the board's own committed-tower sequence at tile scale.
  g.fillStyle(pal.floor, 1);
  g.fillRect(0, 0, SWATCH_SIZE_PX, SWATCH_SIZE_PX);
  g.fillStyle(pal.tower, 1);
  g.fillRoundedRect(2, 2, SWATCH_SIZE_PX - 4, SWATCH_SIZE_PX - 4, 6);
  drawFootprintMark(
    g,
    towerFootprintMarkFor(towerId),
    SWATCH_SIZE_PX / 2,
    SWATCH_SIZE_PX / 2,
    SWATCH_SIZE_PX,
    2,
    pal.floor,
    1,
  );
}
