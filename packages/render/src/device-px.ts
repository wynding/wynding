// device-px.ts — the one device-pixel snap every sprite and every live cue drawn around a
// sprite share, and the device-pixel box the board's canvas is drawn into. A leaf module (no
// imports) so `board-draw.ts` can use it: `placement.ts` imports `board-draw.ts`, so taking
// it from `placement.ts` would close a cycle.

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
