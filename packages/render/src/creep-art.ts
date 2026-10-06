// creep-art.ts — every creep's art, as vector IR (`art-ir.ts`): the editable master of how a
// creep looks (visual pass C3/C4/B3, #181; ADR 0002). Built to the owner-approved style frame:
// a creep's BODY is its silhouette (`CreepShape` — the primary cue) filled in its FAMILY's hue
// and outlined in ink, drawn at its family's size step over a soft ground SHADOW; a flyer's
// body is lifted above its shadow, which marks where it truly is, and carries two WINGS
// attached to its sides.
//
// DESIGN UNITS: ten to the creep's radius (`CREEP_ART_R`), the body centred on (0, 0). One
// master serves every family and every cell size: a creep's art is drawn at
// `creepRadius(cellPx, family) / CREEP_ART_R` CSS px per unit. Stroke floors are CSS px, so
// an outline still reads at the narrow floor's 3.5px radius.
//
// BODY AND SHADOW ARE SEPARATE, and the board shows them as two sprites in two paint layers
// (`art-frames.ts`, `layers.ts`): every creep's shadow lies under every creep's body, so one
// creep's shadow never darkens a neighbour.
//
// COLOURS ARE TOKENS (`ArtColour`), resolved per colour-vision mode by `creepArtColour`: the
// family hue and the wings' fill come from the palette and are gated there
// (`palette.test.ts`); the ink and the shadow are the art kit's fixed inks.

import { artBounds } from './art-geometry';
import type { ArtColour, ArtShape } from './art-ir';
import { creepColour, type Palette } from './palette';
import { ART_INK, ART_SHADOW } from './tower-art';
import { CREEP_LOOKS, type CreepFamily, type CreepLook, type CreepShape } from './creep-paint';

/** Design units per creep RADIUS. */
export const CREEP_ART_R = 10;

/** How much larger a boss is drawn than an armored creep — its size, and since C3 its hue,
 *  being what tell the two hexagons apart (M2-S10's size-only boss cue, kept at its strength:
 *  the boss was 1.5× every creep, and the armored creep has grown a step since). */
export const BOSS_OVER_ARMORED = 1.5;

/** Each family's size step over the board's base radius — the style frame's, from the small
 *  swarm to the large boss. The frame drew the boss at 1.6; it is 1.5 × the armored creep's
 *  1.12 here (1.68), so the boss stays the 1.5× the armored creep's radius it has always
 *  been. */
export const CREEP_SIZE: Readonly<Record<CreepFamily, number>> = {
  swarm: 0.78,
  normal: 1,
  fast: 0.95,
  armored: 1.12,
  flying: 1,
  boss: 1.12 * BOSS_OVER_ARMORED,
};

/** The board's base creep radius in CSS px — `max(3, cellPx × 0.35)`, the radius every creep
 *  was drawn at before C3, and every family's size step multiplies. */
export function creepBaseRadius(cellPx: number): number {
  return Math.max(3, cellPx * 0.35);
}

/** A creep's radius in CSS px: the base radius, THEN its family's size step. The step is
 *  applied after the 3px floor, never inside it — load-bearing (M2-S10): below `cellPx ≈
 *  8.57` the floor binds, and scaling inside it would draw every family at the same 3px,
 *  the boss included, at exactly the cell size where size is hardest to read. One function,
 *  because the baked body (`art-frames.ts`) and the live cues drawn around it
 *  (`drawCreepCues`) must agree on it exactly. */
export function creepRadius(cellPx: number, family: CreepFamily): number {
  return creepBaseRadius(cellPx) * CREEP_SIZE[family];
}

/** How far a flyer's body is drawn above its true position, in design units — the frame's
 *  0.9 of its radius. Its ground shadow stays at the true position, so the gap between them
 *  reads as height. */
export const CREEP_LIFT = 9;

/** A flyer's lift in CSS px, for a creep of radius `r` — zero for a creep on the ground. */
export function creepLiftPx(r: number, airborne: boolean): number {
  return airborne ? (r * CREEP_LIFT) / CREEP_ART_R : 0;
}

/** The body's ink outline: the frame's `max(1.4px, 0.16 r)` — 0.16 of the radius in design
 *  units, floored at 1.4 CSS px so the outline that keeps overlapping creeps countable still
 *  reads at a phone's cell size. */
export const CREEP_OUTLINE_WIDTH = 1.6;
export const CREEP_OUTLINE_MIN_PX = 1.4;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** A regular polygon's points, circumradius `r`, centred on (0, `cy`), its first vertex at
 *  `startDeg` (−90 puts it straight up; canvas y grows down). */
function regular(n: number, r: number, startDeg: number, cy = 0): [number, number][] {
  return Array.from({ length: n }, (_, k): [number, number] => {
    const t = ((startDeg + (360 * k) / n) * Math.PI) / 180;
    return [round2(r * Math.cos(t)) + 0, round2(cy + r * Math.sin(t)) + 0];
  });
}

/** The paint every body shares: family fill, ink outline, round joins. */
const BODY = {
  fill: 'family',
  stroke: 'ink',
  width: CREEP_OUTLINE_WIDTH,
  minWidthPx: CREEP_OUTLINE_MIN_PX,
  join: 'round',
} as const;

/** Every silhouette, as the style frame draws it — a `Record` over the union, so a sixth
 *  shape without art fails to compile. The frame's own geometry, not the pre-C3 board's: an
 *  equilateral triangle a little low of centre, a diamond reaching 1.1 radii, a square with
 *  rounded corners, a regular pentagon, and a FLAT-TOPPED hexagon (the pre-C3 board drew it
 *  point-up). `creep-art.test.ts` holds the five apart by outline. */
export const CREEP_BODY: Readonly<Record<CreepShape, ArtShape>> = {
  triangle: { kind: 'polygon', points: regular(3, 11.2, -90, 1.8), ...BODY },
  diamond: { kind: 'polygon', points: regular(4, 11, -90), ...BODY },
  square: { kind: 'rect', x: -8.2, y: -8.2, w: 16.4, h: 16.4, rx: 1.8, ...BODY },
  pentagon: { kind: 'polygon', points: regular(5, 10, -90), ...BODY },
  hexagon: { kind: 'polygon', points: regular(6, 10, 0), ...BODY },
};

/** The wings' ink outline — the frame's 1.4px at its desktop cell, in design units, floored
 *  at one CSS px. */
const WING = {
  fill: 'airborne',
  stroke: 'ink',
  width: 1.4,
  minWidthPx: 1,
  join: 'round',
} as const;

/** A flyer's two wings (C4), the style frame's: each a slim triangle rooted on the body's
 *  side just above its centre, swept up and out to about two radii, filled in
 *  `palette.airborne` and outlined in ink — so the light fill reads on the dark floor and
 *  plate, the ink edge on a light tower head or another creep. Drawn UNDER the body, which
 *  covers their roots: the frame rooted them 0.55 radii out, just past the triangle's narrow
 *  waist (its ink outline hid the gap); they root 0.4 radii out here, inside every
 *  silhouette's fill, so each wing grows out of the body at any outline width. They replace
 *  the detached chevron that floated more than a cell above the creep (`creep-paint.ts`'s
 *  CUE-RADIUS ORDERING block says why it had to). */
export const CREEP_WINGS: readonly ArtShape[] = [
  {
    kind: 'polygon',
    points: [
      [-4, -1],
      [-20.5, -7.5],
      [-15.5, 3.5],
    ],
    ...WING,
  },
  {
    kind: 'polygon',
    points: [
      [4, -1],
      [20.5, -7.5],
      [15.5, 3.5],
    ],
    ...WING,
  },
];

const BODY_ART = new Map<string, readonly ArtShape[]>();

/** A look's BODY art, centred on the body: a flyer's wings, then the body over them. The
 *  family does not change the shapes — it sets their colour (`creepArtColour`) and the scale
 *  they are drawn at (`creepRadius`) — so looks of one shape and domain share one array. */
export function creepBodyArt(look: Pick<CreepLook, 'shape' | 'airborne'>): readonly ArtShape[] {
  const key = `${look.shape}:${look.airborne}`;
  let art = BODY_ART.get(key);
  if (art === undefined) {
    const body = CREEP_BODY[look.shape];
    art = look.airborne ? [...CREEP_WINGS, body] : [body];
    BODY_ART.set(key, art);
  }
  return art;
}

/** How opaque a creep's shadow is: a little lighter under a flyer, whose shadow falls
 *  further (the frame's). Dark on a dark floor, decorative, and outside every gate. */
export const CREEP_SHADOW_ALPHA = { ground: 0.34, air: 0.28 } as const;

/** A creep's soft ground SHADOW (B3), relative to its TRUE position — the frame's flat,
 *  translucent ellipse offset down and to the right, the light falling from the upper left as
 *  it does on the towers. A flyer's is smaller and falls further from its lifted body, and
 *  is what marks where it is. */
export const CREEP_SHADOW: Readonly<Record<'ground' | 'air', readonly ArtShape[]>> = {
  ground: [
    {
      kind: 'ellipse',
      cx: 1.8,
      cy: 6.2,
      rx: 10.5,
      ry: 4.8,
      fill: 'shadow',
      alpha: CREEP_SHADOW_ALPHA.ground,
    },
  ],
  air: [
    {
      kind: 'ellipse',
      cx: 3.5,
      cy: 5.5,
      rx: 9.5,
      ry: 4.2,
      fill: 'shadow',
      alpha: CREEP_SHADOW_ALPHA.air,
    },
  ],
};

/** The colour `token` resolves to in `pal`, for a creep of `family`. Creep art paints in
 *  four colours only; a tower's token here is a bug to surface, not a colour to guess. */
export function creepArtColour(token: ArtColour, pal: Palette, family: CreepFamily): number {
  switch (token) {
    case 'family':
      return creepColour(pal, family);
    case 'airborne':
      return pal.airborne;
    case 'ink':
      return ART_INK;
    case 'shadow':
      return ART_SHADOW;
    default:
      throw new Error(`creep art has no '${token}' colour`);
  }
}

// ---- The wave strip's icons ----

/** Half the side of a creep icon's box, in the icon's own units — the icons' shared
 *  `viewBox="-10 -10 20 20"` (`hud-icons.ts`). */
export const CREEP_ICON_HALF = 10;

/** Icon units per design unit for a creep icon, before its family's size step: the one scale
 *  every creep icon is drawn at, so the strip shows the board's size steps — the swarm
 *  smallest, the boss largest — and the largest at which every look on the GROUND, its
 *  outline included, fits the icon's box (the boss's flat hexagon is the widest). A flyer's
 *  wings reach past the box's sides at this scale, as the icon lets them (`ui.css`). */
export const CREEP_ICON_SCALE: number = (() => {
  let extent = 0;
  for (const look of CREEP_LOOKS) {
    if (look.airborne) continue;
    const b = artBounds(creepBodyArt(look), Infinity); // strokes at their design width
    const reach = Math.max(-b.minX, b.maxX, -b.minY, b.maxY) * CREEP_SIZE[look.family];
    extent = Math.max(extent, reach);
  }
  return CREEP_ICON_HALF / extent;
})();

/** A look as its wave-strip icon draws it: its BODY art — wings and body, centred on the
 *  body, without the board's shadow and lift (depth cues for the board's floor, which a
 *  strip icon has none of) — and the scale to draw it at, icon units per design unit, its
 *  family's size step included. The same master as the board's atlas. */
export function creepIconArt(look: CreepLook): {
  readonly shapes: readonly ArtShape[];
  readonly scale: number;
} {
  return { shapes: creepBodyArt(look), scale: CREEP_ICON_SCALE * CREEP_SIZE[look.family] };
}
