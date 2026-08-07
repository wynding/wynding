// tower-paint.ts — pure tower-footprint paint-plan geometry (M2-S3). Keys a distinct
// footprint MARK on the tower's catalog id — `basic`/`slow` share `palette.tower` (colour
// carries no distinction between them; shape does), same pattern as `creep-paint.ts`.

/** The footprint marks the scene can draw over a tower's 2×2 fill. `'plain'` is the
 *  pre-M2-S3 look (no extra mark — `basic`); `'ringed'` adds a concentric inner ring
 *  (`slow`'s distinct mark). `'crosshair'` is `splash`'s (M2-S4a) — four short spokes
 *  radiating from the footprint centre, evoking "area effect" — a SHAPE distinct from
 *  `'ringed'`'s closed circle, not a third colour (the vocabulary widens rather than
 *  reusing `'ringed'`, since `slow` already owns that mark). `'droplet'` is `venom`'s
 *  (M2-S5a) — a small teardrop shape at the footprint centre, evoking "applies a
 *  lingering effect" — again a NEW value rather than reusing any of the above, so no two
 *  towers ever share a footprint mark. `'bolt'` is `stun`'s (M2-S6) — a three-segment
 *  zigzag polyline through the footprint centre, evoking "shocks" — distinct from
 *  `'crosshair'`'s spokes by not being radial. `'arrow'` is `antiair`'s (M2-S7) — an
 *  upward arrow (a shaft through the footprint centre plus two barbs at its tip,
 *  drawn at the same `size * 0.22` half-size as `'crosshair'`/`'droplet'` — NOT
 *  full-height; `drawArrow`'s own comment carries the derivation) evoking "shoots skyward" — distinct from `'crosshair'`'s four spokes (a shaft
 *  and two barbs, not four radial strokes with a centre gap) and `'bolt'`'s zigzag (a
 *  straight shaft, not a three-segment stagger), so `antiair` is never visually
 *  conflated with `basic`'s plain body. It is deliberately NOT a bare "^": the airborne
 *  creep cue (`airborneCuePaintOps`) is exactly that glyph, and a flyer's cue lands in
 *  the cell to its north — i.e. on top of a tower footprint — so a bare chevron here
 *  would put two same-shaped marks a tenth of a cell apart with only colour separating
 *  them (ADR 0003 forbids leaning on colour for essential cues). `'pylon'` is `beacon`'s
 *  (M2-S8) — an upright post through the footprint centre with a short crossbar near its
 *  top and a wider base bar, evoking "a broadcasting mast": a NEW value, never a reuse,
 *  so no two towers share a mark. Distinct from `'arrow'` (which converges to a point
 *  with two barbs at the TIP and no base) and from `'bolt'` (a staggered zigzag, not a
 *  straight post). An unrecognized id draws `'plain'` (total, never throw). */
export type TowerFootprintMark =
  'plain' | 'ringed' | 'crosshair' | 'droplet' | 'bolt' | 'arrow' | 'pylon';

const TOWER_MARKS: Readonly<Partial<Record<string, TowerFootprintMark>>> = {
  basic: 'plain',
  slow: 'ringed',
  splash: 'crosshair',
  venom: 'droplet',
  stun: 'bolt',
  antiair: 'arrow',
  beacon: 'pylon',
};

/** The footprint mark for `towerId` — total over any string, `hasOwnProperty`-guarded
 *  like `creepShapeFor` so a JSON id such as `'__proto__'` can't escape via the
 *  prototype chain and resolve to `Object.prototype` instead of falling back. */
export function towerFootprintMarkFor(towerId: string): TowerFootprintMark {
  return Object.prototype.hasOwnProperty.call(TOWER_MARKS, towerId)
    ? (TOWER_MARKS[towerId] as TowerFootprintMark)
    : 'plain';
}
