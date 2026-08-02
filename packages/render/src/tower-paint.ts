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
 *  towers ever share a footprint mark. An unrecognized id draws `'plain'` (total, never
 *  throw). */
export type TowerFootprintMark = 'plain' | 'ringed' | 'crosshair' | 'droplet';

const TOWER_MARKS: Readonly<Partial<Record<string, TowerFootprintMark>>> = {
  basic: 'plain',
  slow: 'ringed',
  splash: 'crosshair',
  venom: 'droplet',
};

/** The footprint mark for `towerId` — total over any string, `hasOwnProperty`-guarded
 *  like `creepShapeFor` so a JSON id such as `'__proto__'` can't escape via the
 *  prototype chain and resolve to `Object.prototype` instead of falling back. */
export function towerFootprintMarkFor(towerId: string): TowerFootprintMark {
  return Object.prototype.hasOwnProperty.call(TOWER_MARKS, towerId)
    ? (TOWER_MARKS[towerId] as TowerFootprintMark)
    : 'plain';
}
