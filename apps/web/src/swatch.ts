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
  backingStoreSize,
  devicePixelReport,
  observesDevicePixels,
  paintTowerArt,
  resolvePalette,
  towerArtFit,
  towerLookFor,
  type ColourMode,
  type DevicePixelReport,
  type PathFactory,
} from '@wynding/render';

/** The swatch's logical (CSS px) size — mirrored by `.wy-card-swatch`'s width/height in
 *  ui.css. The whole tower, its plate's shadow included, is fitted inside it at one scale
 *  for every tower (`towerArtFit`), as the board draws every tower at one scale. */
export const SWATCH_SIZE_PX = 36;

/** The browser's own `Path2D`, for the art's SVG path strings. */
const browserPath: PathFactory = (d) => new Path2D(d);

/** What a swatch was last painted as, and the browser's last count of the device pixels it
 *  is drawn into — kept so a change in that count can repaint it. */
interface Swatch {
  towerId: string;
  mode: ColourMode;
  makePath: PathFactory;
  devicePixels: DevicePixelReport | null;
  /** The box observer (null where the view has no `ResizeObserver`), kept so
   *  `releaseSwatch` can disconnect it. */
  observer: ResizeObserver | null;
}
const swatches = new WeakMap<HTMLCanvasElement, Swatch>();

/** The device pixels per CSS px of the canvas's OWN window (every module here threads the
 *  injected document), or 1 where it has none. */
const dprOf = (canvas: HTMLCanvasElement): number => {
  const raw = canvas.ownerDocument.defaultView?.devicePixelRatio;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1;
};

/** Paint `towerId`'s tile onto `canvas` at the palette for `mode`. Called at boot and again
 *  on every colour-mode change (`main.ts`), never per frame. The backing store is the device
 *  pixels the browser draws the tile into, so it is shown pixel for pixel, as the board's
 *  canvas is (`backingStoreSize`): any other size is scaled into the tile, smearing the
 *  plate's one-pixel rim. Where the browser reports that count (a `device-pixel-content-box`
 *  observer — Chromium, Firefox), a change in it repaints the tile: a resize, a move, a
 *  monitor move. Elsewhere (WebKit) it is worked out from where the tile sits, and a resize
 *  repaints it. `makePath` is the browser's `Path2D` unless a test hands in its own. */
export function paintSwatch(
  canvas: HTMLCanvasElement,
  towerId: string,
  mode: ColourMode,
  makePath: PathFactory = browserPath,
): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return; // stubbed jsdom / lost context — the Card's text carries everything
  const known = swatches.get(canvas);
  const swatch = known ?? { towerId, mode, makePath, devicePixels: null, observer: null };
  Object.assign(swatch, { towerId, mode, makePath });
  if (known === undefined) {
    swatches.set(canvas, swatch);
    swatch.observer = watch(canvas, swatch);
  }
  paint(canvas, ctx, swatch, storeFor(canvas, swatch));
}

/** Stop watching `canvas` and forget it: disconnects its observer (which would otherwise keep
 *  the canvas, its backing store and the callback alive after the app's nodes are removed) and
 *  drops its record, so a later `paintSwatch` on the same canvas registers and observes it
 *  afresh. `createApp().destroy()` calls it for every Card, so a destroy/recreate in one
 *  session leaks nothing. A no-op for a canvas never painted. */
export function releaseSwatch(canvas: HTMLCanvasElement): void {
  swatches.get(canvas)?.observer?.disconnect();
  swatches.delete(canvas);
}

/** The backing store `canvas` needs: the device pixels its box is drawn into — or, before it
 *  is laid out (no box yet), its size × dpr, until the observer reports its box. */
function storeFor(canvas: HTMLCanvasElement, swatch: Swatch): { width: number; height: number } {
  const dpr = dprOf(canvas);
  const box = canvas.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) {
    const side = Math.max(1, Math.round(SWATCH_SIZE_PX * dpr));
    return { width: side, height: side };
  }
  return backingStoreSize(box, dpr, dpr, swatch.devicePixels);
}

/** Repaint the tile whenever the browser reports a new box for it — or, where it reports no
 *  device pixels, a new CSS size. */
function watch(canvas: HTMLCanvasElement, swatch: Swatch): ResizeObserver | null {
  const view = canvas.ownerDocument.defaultView;
  // (jsdom has none.)
  const Observer = (view as { ResizeObserver?: typeof ResizeObserver } | null)?.ResizeObserver;
  if (Observer === undefined) return null;
  const exact = observesDevicePixels(view);
  const observer = new Observer((entries) => {
    const entry = entries[entries.length - 1];
    if (entry === undefined) return;
    if (exact) swatch.devicePixels = devicePixelReport(entry, dprOf(canvas));
    const store = storeFor(canvas, swatch);
    if (store.width === canvas.width && store.height === canvas.height) return; // still right
    const ctx = canvas.getContext('2d');
    if (ctx !== null) paint(canvas, ctx, swatch, store);
  });
  observer.observe(canvas, exact ? { box: 'device-pixel-content-box' } : {});
  return observer;
}

function paint(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  swatch: Swatch,
  store: { width: number; height: number },
): void {
  const dpr = dprOf(canvas);
  canvas.width = store.width;
  canvas.height = store.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // The surface in CSS px: the store, which the browser's snap can make a little under or
  // over the tile's own size.
  const surface = { width: store.width / dpr, height: store.height / dpr };
  const pal = resolvePalette(swatch.mode);
  const g = artGraphics(ctx, swatch.makePath);
  // Ground, then the tower — plate and head, the board's own art at tile scale.
  g.fillStyle(pal.floor, 1);
  g.fillRect(0, 0, surface.width, surface.height);
  const fit = towerArtFit(SWATCH_SIZE_PX);
  // On this canvas's own pixel grid, so the plate's rim is crisp, as on the board — and kept
  // on the store, which the fitted footprint reaches past at its top and left.
  paintTowerArt(g, pal, towerLookFor(swatch.towerId), fit.x, fit.y, fit.footprintPx, dpr, surface);
  g.flush();
}
