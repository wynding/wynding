// tower-paint.ts — what a tower LOOKS like, keyed on its catalog id (M2-S3; the visual
// pass's T1/T2, #181). Two id-keyed axes, same pattern as `creep-paint.ts`: the footprint
// MARK — which head silhouette and glyph the tower's art draws (`tower-art.ts`) — and the
// ROLE — which colour that head is tinted. Shape is the primary channel (ADR 0003); the
// role colour is the second one, never the only one.

/** The footprint marks — since the visual pass (#181), which HEAD a tower wears: its
 *  silhouette and the ink glyph inside it (`HEAD_ART`, `tower-art.ts`), each keeping the idea
 *  of the mark described here. The descriptions are the marks as the M2 stories drew them
 *  over the old 2×2 fill — kept as the record of what each glyph means. `'plain'` is the
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
 *  full-height) evoking "shoots skyward" — distinct from `'crosshair'`'s four spokes (a shaft
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
 *  straight post). `'charge'` is `mine`'s (M2-S9) — a FILLED disc at the footprint
 *  centre, at the same `size * 0.22` half-size `'ringed'`/`'crosshair'`/`'droplet'`/
 *  `'arrow'`/`'pylon'` already use. It is the only FILLED mark in a vocabulary of
 *  otherwise six strokes (`'plain'`, the eighth value, draws nothing at all — `basic`
 *  is body-only), which is the whole distinctness argument and not a
 *  decorative one: at the `CELL_PX_MIN_NARROW = 10` compact-layout floor `size * 0.22`
 *  is a ~4.4 px RADIUS, so the disc spans ~8.8 px, and at that size fine detail (a
 *  ring's thin stroke, a bolt's stagger) is gone —
 *  but "filled" vs "stroked" survives at any size — a solid disc
 *  reads as a dense charge where `'ringed'`'s stroked circle of the same radius reads
 *  as a thin ring, so the two are never confused even when every other shape cue has
 *  collapsed to a blur. `'ringed-crosshair'` is `frost-splash`'s (M2-S10) — the
 *  `'ringed'` circle at its existing radius plus four short spokes radiating OUTWARD
 *  from it, evoking "slow (the ring) + area effect (the spokes)": it literally reads
 *  as its two parent marks (m2.md:299) while staying distinct from `'ringed'` (no
 *  spokes), `'crosshair'` (no ring, and ITS spokes radiate from the centre with a gap
 *  rather than from a ring outward) and `'charge'` (filled, not stroked). Hyphenated
 *  against this file's otherwise single-word convention DELIBERATELY — the value names
 *  what it composes, the same way `armored-flyer` (a creep id, not a mark) names its
 *  own composition. A NEW value, never a reuse, so no two towers ever share a mark. An
 *  unrecognized id draws `'plain'` (total, never throw). */
export type TowerFootprintMark =
  | 'plain'
  | 'ringed'
  | 'crosshair'
  | 'droplet'
  | 'bolt'
  | 'arrow'
  | 'pylon'
  | 'charge'
  | 'ringed-crosshair';

/** Every `TowerFootprintMark`, as a value — the board atlas bakes one frame per mark per
 *  state (`art-frames.ts`), so it needs the union enumerated rather than merely typed. A
 *  `Record` keyed on the union, so a tenth mark that is not listed here fails to compile
 *  instead of silently baking no frame (the same "everywhere at once or nowhere" rule
 *  `HEAD_ART`'s `Record` over the union enforces in `tower-art.ts`). */
const ALL_MARKS: Readonly<Record<TowerFootprintMark, true>> = {
  plain: true,
  ringed: true,
  crosshair: true,
  droplet: true,
  bolt: true,
  arrow: true,
  pylon: true,
  charge: true,
  'ringed-crosshair': true,
};
export const TOWER_FOOTPRINT_MARKS: readonly TowerFootprintMark[] = Object.keys(
  ALL_MARKS,
) as TowerFootprintMark[];

const TOWER_MARKS: Readonly<Partial<Record<string, TowerFootprintMark>>> = {
  basic: 'plain',
  slow: 'ringed',
  splash: 'crosshair',
  venom: 'droplet',
  stun: 'bolt',
  antiair: 'arrow',
  beacon: 'pylon',
  mine: 'charge',
  'frost-splash': 'ringed-crosshair',
};

/** The footprint mark for `towerId` — total over any string, `hasOwnProperty`-guarded
 *  like `creepShapeFor` so a JSON id such as `'__proto__'` can't escape via the
 *  prototype chain and resolve to `Object.prototype` instead of falling back. */
export function towerFootprintMarkFor(towerId: string): TowerFootprintMark {
  return Object.prototype.hasOwnProperty.call(TOWER_MARKS, towerId)
    ? (TOWER_MARKS[towerId] as TowerFootprintMark)
    : 'plain';
}

/** A tower's ROLE (visual pass T2, #181) — what it does for the maze, shown as the colour of
 *  its head, the second channel beside the head's silhouette. One colour per role per
 *  colour-vision mode (`roleColour`, `palette.ts`), gated for contrast against the floor and
 *  the plate and for distinctness under simulated colour-vision deficiency
 *  (`palette.test.ts`).
 *
 *  - `damage`  — direct or area damage and nothing else (`basic`, `splash`)
 *  - `control` — slows or stuns (`slow`, `stun`, `frost-splash`)
 *  - `poison`  — damage over time (`venom`)
 *  - `air`     — strikes flying creeps (`antiair`)
 *  - `support` — strengthens neighbouring towers instead of attacking (`beacon`)
 *  - `burst`   — one discharge, then the tower is gone (`mine`)
 *
 *  The style frame calls the last one "trap"; it is `burst` here because that is the
 *  glossary's word for the mine's primitive and CONTEXT.md lists "trap" among the words to
 *  avoid for it. */
export type TowerRole = 'damage' | 'control' | 'poison' | 'air' | 'support' | 'burst';

/** Every `TowerRole`, as a value — keyed on the union, so a seventh role that is not listed
 *  here fails to compile (the palette needs one colour per role, `roleColour`). */
const ALL_ROLES: Readonly<Record<TowerRole, true>> = {
  damage: true,
  control: true,
  poison: true,
  air: true,
  support: true,
  burst: true,
};
export const TOWER_ROLES: readonly TowerRole[] = Object.keys(ALL_ROLES) as TowerRole[];

const TOWER_ROLE_BY_ID: Readonly<Partial<Record<string, TowerRole>>> = {
  basic: 'damage',
  slow: 'control',
  splash: 'damage',
  venom: 'poison',
  stun: 'control',
  antiair: 'air',
  beacon: 'support',
  mine: 'burst',
  'frost-splash': 'control',
};

/** The role for `towerId` — total over any string, guarded like `towerFootprintMarkFor`. An
 *  unknown id falls back to `basic`'s role, exactly as its mark falls back to `basic`'s
 *  `'plain'`, so an id the catalog has never heard of looks like `basic` on both axes. */
export function towerRoleFor(towerId: string): TowerRole {
  return Object.prototype.hasOwnProperty.call(TOWER_ROLE_BY_ID, towerId)
    ? (TOWER_ROLE_BY_ID[towerId] as TowerRole)
    : 'damage';
}

/** What a tower looks like: its head's silhouette and glyph (the mark) and their colour
 *  (the role). */
export interface TowerLook {
  readonly mark: TowerFootprintMark;
  readonly role: TowerRole;
}

/** The look of `towerId` — total over any string, like both of its halves. */
export function towerLookFor(towerId: string): TowerLook {
  return { mark: towerFootprintMarkFor(towerId), role: towerRoleFor(towerId) };
}

/** A look's stable name, `<mark>:<role>` — what the board atlas keys tower frames by. */
export function towerLookKey(look: TowerLook): string {
  return `${look.mark}:${look.role}`;
}

/** Every look `towerLookFor` can return for ANY string: one per id either table knows,
 *  plus the fallback an unknown id gets — deduplicated, in table order. The board atlas
 *  bakes one set of frames per look (`art-frames.ts`), so every look placement can ask for
 *  is baked by construction, for any id at all. */
export const TOWER_LOOKS: readonly TowerLook[] = (() => {
  const ids = [...new Set([...Object.keys(TOWER_MARKS), ...Object.keys(TOWER_ROLE_BY_ID)])];
  // `''` is never a catalog id (`ruleset-schema.ts` requires `^[a-z][a-z0-9-]{0,31}$`), so
  // it stands in for "an id neither table knows" — the fallback look.
  const looks = [...ids, ''].map(towerLookFor);
  const seen = new Set<string>();
  return looks.filter((look) => {
    const key = towerLookKey(look);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
})();
