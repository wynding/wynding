// device-px.ts — the one device-pixel snap every sprite and every live cue drawn around a
// sprite share, the device-pixel box a canvas is drawn into, and the backing store that box
// needs to be shown pixel for pixel (the board's canvas, and each Card swatch's). A leaf
// module (no imports) so `board-draw.ts` can use it: `placement.ts` imports `board-draw.ts`,
// so taking it from `placement.ts` would close a cycle.

/** `v` (CSS px) moved to the nearest whole DEVICE pixel at `dpr`. */
export function snapToDevicePx(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}

/**
 * How many whole device pixels, at `dpr`, a box from CSS px `start` to `start + size` is
 * drawn into: the browser snaps the box to the pixel grid, from the device pixel nearest its
 * start to the one nearest its end, half a pixel rounding up. So the count depends on where
 * the box sits, not only on its size — a box at 52.5 that is 328.5 wide covers pixels 53 to
 * 381, 328 of them, though `round(328.5)` is 329. It is the size a canvas's backing store
 * must have to be shown pixel for pixel. (Layout positions are whole 64ths of a device
 * pixel; read back as CSS px they can carry floating-point dust either side of a half, so
 * each edge goes back onto that grid before it is rounded.)
 */
export function snappedSpan(start: number, size: number, dpr: number): number {
  const edge = (v: number): number => Math.round(Math.round(v * dpr * 64) / 64);
  return edge(start + size) - edge(start);
}

/** What a `ResizeObserver` watching a canvas's `device-pixel-content-box` last reported: the
 *  device pixels the browser draws the canvas's content box into, and the dpr at the time. */
export interface DevicePixelReport {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/**
 * The backing store a canvas needs to be shown pixel for pixel: as many pixels as the device
 * pixels the browser draws its box into. That is the browser's own answer when it has given
 * one (`reported`, from a `device-pixel-content-box` observer — Chromium and Firefox),
 * counting pixels at the page's dpr (within one of the box's size × dpr, as any count of
 * where the box snaps to is), and the store is drawn at the device's own ratio
 * (`dpr === rawDpr`). The observer reports again whenever its count changes, so a report is
 * never held to the CSS size it was taken at (a layout reads two ways, by up to a 64th of a
 * pixel, and a resize that keeps the count brings no new report): one taken just before a
 * resize stands until the new count comes, later in the same observer loop. Otherwise it is
 * worked out from where the box sits (`snappedSpan`): WebKit gives no such answer, the
 * observer has not answered yet (or the box was just resized more than a pixel from its
 * last count), Chromium's device-scale emulation counts the screen's own pixels rather than
 * the emulated ones (a box 1072 CSS px wide read 1072 at an emulated 2), and a store at a
 * dpr clamped below the device's is deliberately fewer pixels than the box, scaled up into
 * it. `box` is the canvas's CSS box from its page position, as `getBoundingClientRect` reads
 * it. Never under one pixel.
 */
export function backingStoreSize(
  box: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  dpr: number,
  rawDpr: number,
  reported: DevicePixelReport | null,
): { width: number; height: number } {
  const answer =
    reported !== null &&
    dpr === rawDpr &&
    reported.dpr === rawDpr &&
    Math.abs(reported.width - box.width * dpr) <= 1 &&
    Math.abs(reported.height - box.height * dpr) <= 1
      ? reported
      : null;
  return {
    width: Math.max(1, answer?.width ?? snappedSpan(box.left, box.width, dpr)),
    height: Math.max(1, answer?.height ?? snappedSpan(box.top, box.height, dpr)),
  };
}

/** A `device-pixel-content-box` report from one `ResizeObserver` entry, or null where the
 *  browser gives none (WebKit). (A horizontal writing mode: inline is width, block height.) */
export function devicePixelReport(
  entry: ResizeObserverEntry,
  dpr: number,
): DevicePixelReport | null {
  const device = (
    entry.devicePixelContentBoxSize as readonly ResizeObserverSize[] | undefined
  )?.[0];
  if (device === undefined) return null;
  return { width: device.inlineSize, height: device.blockSize, dpr };
}

/** Whether this window's `ResizeObserver` can watch a `device-pixel-content-box`. */
export function observesDevicePixels(
  view: { readonly ResizeObserverEntry?: unknown } | null | undefined,
): boolean {
  const entry = view?.ResizeObserverEntry as { prototype?: object } | undefined;
  return typeof entry?.prototype === 'object' && 'devicePixelContentBoxSize' in entry.prototype;
}
