// layout-units.ts — the two unit helpers the HUD's layout passes share: hud-cut.ts (Compact's
// chips column) and dock-reserve.ts (Standard's Dock).

/** Rounds `v` UP to the layout engine's 1/64px unit — never past it. A bound or reserve
 *  rounded any coarser takes board height the floor was promised; one rounded down leaves a
 *  sliver of cell under the Dock. (The `1e-6` absorbs float noise in a value that is already
 *  a whole number of units, so noise never costs a unit.) */
export function ceil64(v: number): number {
  return Math.ceil(v * 64 - 1e-6) / 64;
}

/** A computed CSS length as a number of px; anything missing or unparsable is 0. */
export function px(value: string | undefined): number {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}
