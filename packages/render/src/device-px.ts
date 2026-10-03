// device-px.ts — the one device-pixel snap every sprite and every live cue drawn around a
// sprite share. A leaf module (no imports) so `board-draw.ts` can use it: `placement.ts`
// imports `board-draw.ts`, so taking it from `placement.ts` would close a cycle.

/** `v` (CSS px) moved to the nearest whole DEVICE pixel at `dpr`. */
export function snapToDevicePx(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}
