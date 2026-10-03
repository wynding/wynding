// swatch.ts — paints each Card's tower swatch (playtest round; redrawn by the visual pass,
// #181): a mini board tile — the palette's floor as ground, and on it the tower itself, its
// plate and its role-coloured head, drawn from the SAME vector art through the SAME painter
// the board's atlas uses (`paintTowerArt`, `@wynding/render` — #89's rule: one art
// vocabulary, never a second copy here that rots). So a Card always matches the board, in
// every colour mode, and every colour pairing on it is one the palette already gates.
//
// The 2D context is handed to the render package's Phaser-free drawing surface
// (`artGraphics`), so Phaser never enters this module. Under vitest, `getContext` is stubbed
// to a QUIET null (vitest.setup.ts — jsdom's own implementation throws a noisy
// not-implemented jsdomError per call), so `paintSwatch` is unit-inert through the same
// null-context contract that guards a lost context in production; the paint sequence itself
// is unit tested against a recording context.

import {
  artGraphics,
  paintTowerArt,
  resolvePalette,
  towerArtFit,
  towerLookFor,
  type ColourMode,
  type PathFactory,
} from '@wynding/render';

/** The swatch's logical (CSS px) size — mirrored by `.wy-card-swatch`'s width/height in
 *  ui.css. The whole tower, its plate's shadow included, is fitted inside it at one scale
 *  for every tower (`towerArtFit`), as the board draws every tower at one scale. */
export const SWATCH_SIZE_PX = 36;

/** The browser's own `Path2D`, for the art's SVG path strings. */
const browserPath: PathFactory = (d) => new Path2D(d);

/** Paint `towerId`'s tile onto `canvas` at the palette for `mode`. Called at boot and again
 *  on every colour-mode change (`main.ts`), never per frame. The backing store is sized to
 *  `SWATCH_SIZE_PX` × the CURRENT devicePixelRatio for crisp edges on HiDPI — re-derived on
 *  each (rare) repaint, so a monitor move is corrected by the next mode change at worst.
 *  `makePath` is the browser's `Path2D` unless a test hands in its own. */
export function paintSwatch(
  canvas: HTMLCanvasElement,
  towerId: string,
  mode: ColourMode,
  makePath: PathFactory = browserPath,
): void {
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
  const g = artGraphics(ctx, makePath);
  // Ground, then the tower — plate and head, the board's own art at tile scale.
  g.fillStyle(pal.floor, 1);
  g.fillRect(0, 0, SWATCH_SIZE_PX, SWATCH_SIZE_PX);
  const fit = towerArtFit(SWATCH_SIZE_PX);
  // On this canvas's own pixel grid, so the plate's rim is crisp, as on the board.
  paintTowerArt(g, pal, towerLookFor(towerId), fit.x, fit.y, fit.footprintPx, dpr);
  g.flush();
}
