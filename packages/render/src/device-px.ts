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
 *  device pixels the browser draws the canvas's content box into, the CSS size of that box,
 *  and the dpr at the time. */
export interface DevicePixelReport {
  readonly width: number;
  readonly height: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
}

/** CSS sizes this close are one layout: a real change is at least a layout unit (1/64 of a
 *  pixel), far above floating-point dust. */
const SAME_LAYOUT = 1e-3;

/**
 * The backing store a canvas needs to be shown pixel for pixel: as many pixels as the device
 * pixels the browser draws its box into. That is the browser's own answer when it has given
 * one (`reported`, from a `device-pixel-content-box` observer — Chromium and Firefox) for
 * the box as it is now — the same CSS size, at the same dpr — and the store is drawn at the
 * device's own ratio (`dpr === rawDpr`). Otherwise it is worked out from where the box sits
 * (`snappedSpan`): WebKit gives no such answer, the observer has not yet answered for a box
 * just resized, and a store at a dpr clamped below the device's is deliberately fewer pixels
 * than the box, scaled up into it. `box` is the canvas's CSS box from its page position, as
 * `getBoundingClientRect` reads it. Never under one pixel.
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
    Math.abs(reported.cssWidth - box.width) < SAME_LAYOUT &&
    Math.abs(reported.cssHeight - box.height) < SAME_LAYOUT
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
  const css = entry.contentBoxSize[0];
  if (device === undefined || css === undefined) return null;
  return {
    width: device.inlineSize,
    height: device.blockSize,
    cssWidth: css.inlineSize,
    cssHeight: css.blockSize,
    dpr,
  };
}

/** Whether this window's `ResizeObserver` can watch a `device-pixel-content-box`. */
export function observesDevicePixels(
  view: { readonly ResizeObserverEntry?: unknown } | null | undefined,
): boolean {
  const entry = view?.ResizeObserverEntry as { prototype?: object } | undefined;
  return typeof entry?.prototype === 'object' && 'devicePixelContentBoxSize' in entry.prototype;
}
