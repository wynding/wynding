// tower-art.ts — every tower's art, as vector IR (`art-ir.ts`): the editable master of how a
// tower looks (visual pass T1/T2/T4/B3, #181; ADR 0002). Built to the owner-approved style
// frame: each tower is a slate PLATE with a soft offset shadow, and a role-coloured HEAD with
// an ink outline whose silhouette is the tower's own and whose glyph keeps the idea of the
// footprint mark the tower has carried since M2 (`TowerFootprintMark`).
//
// Everything is in a 64-unit design box — one 2×2 footprint, its top-left corner at (0, 0),
// its centre at (32, 32) — and is drawn scaled by `2 × cellPx / 64` CSS px per unit.
//
// PLATE AND HEAD ARE SEPARATE, and the board shows them as two sprites (`art-frames.ts`), so a
// later pass can turn a head toward its target without touching the plate under it. Heads
// that will aim (`basic`, `venom`, `stun`, `antiair`) are drawn pointing UP, aim angle 0.
//
// COLOURS ARE TOKENS (`ArtColour`), resolved per colour-vision mode by `artColour`: the plate,
// its rim, the role colours and the boost glow come from the palette and are gated there
// (`palette.test.ts`); the outline ink, the bevel, shadows, the venom gloss and the scorch are
// fixed art inks, decorative or always drawn against colours the gate does cover.

import { roleColour, type Palette } from './palette';
import type { ArtBox, ArtColour, ArtRect, ArtShape } from './art-ir';
import type { TowerFootprintMark, TowerRole } from './tower-paint';

/** Design units across one 2×2 footprint. */
export const ART_BOX = 64;
/** The footprint itself, in design units: what a crisp stroke is kept inside when it is
 *  moved onto the pixel grid (`alignArtToTexels`), so it never spills into a neighbour's. */
export const ART_FOOTPRINT: ArtBox = [0, 0, ART_BOX, ART_BOX];
/** The footprint's centre, design units — where every head, glow and scorch is centred. */
const C = ART_BOX / 2;

// ---- Fixed art inks ----

/** Outline and glyph ink: near-black, so a head's silhouette and the glyph inside it read
 *  against every role colour (`palette.test.ts` gates ink against each, ≥ 3:1). */
export const ART_INK = 0x0b0e14;
/** The plate's top-edge highlight — decorative. */
export const ART_BEVEL = 0x3d4a66;
export const ART_SHADOW = 0x000000;
/** The venom head's highlight — decorative. */
export const ART_GLOSS = 0xfbeefd;
/** A spent mine's scorch and its cracks — decorative, and fading (`scorches.ts`). */
export const ART_SCORCH = 0x0b0d12;
export const ART_CRACK = 0x3a3f4c;

/** How opaque a drop shadow is. */
export const SHADOW_ALPHA = 0.32;

/** The colour `token` resolves to in `pal`, for a tower of `role`. */
export function artColour(token: ArtColour, pal: Palette, role: TowerRole): number {
  switch (token) {
    case 'role':
      return roleColour(pal, role);
    case 'plate':
      return pal.plate;
    case 'floor':
      return pal.floor;
    case 'rim':
      return pal.tower;
    case 'aura':
      return pal.aura;
    case 'ink':
      return ART_INK;
    case 'bevel':
      return ART_BEVEL;
    case 'shadow':
      return ART_SHADOW;
    case 'gloss':
      return ART_GLOSS;
    case 'scorch':
      return ART_SCORCH;
    case 'crack':
      return ART_CRACK;
  }
}

// ---- The plate ----

/** The plate's rectangle, design units: inset 3 from the footprint, corner radius 9. */
export const PLATE_RECT = { x: 3, y: 3, w: 58, h: 58, rx: 9 } as const;

/** The plate rim's width, design units, and its floor in CSS px. The frame's slate plate is
 *  only ~1.28:1 against the floor, so on its own the footprint's edge would vanish; the rim
 *  is what carries it, in `palette.tower`, which the palette gate holds ≥ 3:1 against the
 *  floor in every mode. That contrast is only shown if the rim's pixels are wholly rim, so
 *  the rim is drawn CRISP (`ArtRect.crisp`, `alignRectToTexels`): baked on whole device
 *  pixels, never thinner than its one CSS px rounded UP (two pixels at dpr 1.25 or 1.5),
 *  else the whole number nearest its design width. Any width that rounding adds goes
 *  outward, so its plate side keeps its place; each edge then moves to the nearest place on
 *  the pixel grid, under half a pixel away — or, where that would cross the footprint's edge,
 *  inward to the first place inside it (at most 0.59 of a pixel from the design). Without
 *  it, a one-pixel rim whose centre fell inside a pixel was smeared across two half-lit ones
 *  — 2.19:1 at 10px cells on a dpr 1 screen (QC round 2, A4). And it needs the board's
 *  canvas shown pixel for pixel, which `scene.ts` sizes it to be: a canvas scaled into its
 *  box smears a one-pixel line the same way (as low as 1.88:1, QC round 3). */
export const PLATE_RIM_WIDTH = 2;
export const PLATE_RIM_MIN_PX = 1;

const PLATE_SHADOW: ArtShape = {
  kind: 'rect',
  x: 6,
  y: 8,
  w: 58,
  h: 58,
  rx: 9,
  fill: 'shadow',
  alpha: SHADOW_ALPHA,
};
const PLATE_BEVEL: ArtShape = {
  kind: 'path',
  d: 'M13 5.6H51',
  stroke: 'bevel',
  width: 1.6,
  cap: 'round',
};

/** The slate plate itself. */
const PLATE_FILL: ArtShape = { kind: 'rect', ...PLATE_RECT, fill: 'plate' };

/** The plate's rim: a rect of its own, so that drawing it crisp moves only the stroke. The
 *  fill's edge, on the rim's design centre line, always lies under the moved stroke (swept
 *  over every cell size and dpr in `art-frames.test.ts`), so no sliver of plate shows past
 *  the rim and none of the floor inside it. */
const PLATE_RIM: ArtRect = {
  kind: 'rect',
  ...PLATE_RECT,
  stroke: 'rim',
  width: PLATE_RIM_WIDTH,
  minWidthPx: PLATE_RIM_MIN_PX,
  crisp: true,
};

/** A committed tower's plate: its soft offset shadow, the slate plate, the bevel along its
 *  top edge, and its rim last, over all three. The rim must be on top: on whole pixels it
 *  can land on the bevel's row (at dpr 1 at cells of 11 to 13 px, and at a few cell sizes up
 *  to 13 px at other dprs), and its colour is the footprint's edge. Shared by every tower
 *  that has a plate. */
export const PLATE_ART: readonly ArtShape[] = [PLATE_SHADOW, PLATE_FILL, PLATE_BEVEL, PLATE_RIM];

/** The PAD a plateless tower (the mine) stands on in the plates layer: the plate's own
 *  rectangle, filled opaque in the floor colour — no rim, no shadow, no bevel — so it is
 *  invisible against the floor. It exists for the layer order's sake: a beacon's aura shell
 *  sits under every tower (M2-S8: a shell never stripes a tower), which a plated tower's
 *  plate makes true over its footprint; a mine's studded head covers too little of its
 *  footprint to, and without the pad a neighbouring beacon's shell ran straight through it. */
export const PAD_ART: readonly ArtShape[] = [{ kind: 'rect', ...PLATE_RECT, fill: 'floor' }];

/** The plate a PENDING build shows under its translucent art: the same plate without its
 *  solid rim, because the pending build's rim is the dashed one (`PENDING_RIM_ART`) and a
 *  faded solid rim showing through its gaps would blur the dashes into a line. */
export const PENDING_PLATE_ART: readonly ArtShape[] = [PLATE_SHADOW, PLATE_FILL, PLATE_BEVEL];

// ---- The heads ----

/** A head's art: its shapes, and whether it sits on a plate (every tower but the mine). */
export interface HeadArt {
  readonly plate: boolean;
  readonly shapes: readonly ArtShape[];
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** A regular polygon's points around the centre, first vertex at `startDeg`. */
function regular(n: number, r: number, startDeg: number): [number, number][] {
  return Array.from({ length: n }, (_, k): [number, number] => {
    const t = ((startDeg + (360 * k) / n) * Math.PI) / 180;
    return [round2(C + r * Math.cos(t)), round2(C + r * Math.sin(t))];
  });
}

/** An `n`-pointed star, points at `outer`, notches at `inner`, the first point straight up. */
function star(n: number, outer: number, inner: number): [number, number][] {
  return Array.from({ length: n * 2 }, (_, k): [number, number] => {
    const r = k % 2 === 0 ? outer : inner;
    const t = (Math.PI * k) / n - Math.PI / 2;
    return [round2(C + r * Math.cos(t)), round2(C + r * Math.sin(t))];
  });
}

/** A plus-shaped outline: four arms of half-width `half` reaching `reach` from the centre. */
function plus(half: number, reach: number): [number, number][] {
  const a = C - reach;
  const b = C - half;
  const p = C + half;
  const q = C + reach;
  return [
    [b, a],
    [p, a],
    [p, b],
    [q, b],
    [q, p],
    [p, p],
    [p, q],
    [b, q],
    [b, p],
    [a, p],
    [a, b],
    [b, b],
  ];
}

/** Four strokes along the axes, each from `inner` to `outer` out from the centre. */
function spokes(inner: number, outer: number): string {
  return (
    `M${C} ${C - outer}V${C - inner}M${C} ${C + inner}V${C + outer}` +
    `M${C - outer} ${C}H${C - inner}M${C + inner} ${C}H${C + outer}`
  );
}

/** The paint every head's outline shares: role fill, ink outline, round joins. */
const BODY = { fill: 'role', stroke: 'ink', width: 2, join: 'round' } as const;

/** Every head, keyed by the footprint mark whose idea it keeps. A `Record` over the union, so
 *  a tenth mark without art fails to compile. */
export const HEAD_ART: Readonly<Record<TowerFootprintMark, HeadArt>> = {
  // basic — a ringed turret with its barrel up: the plain body, now with a centre.
  plain: {
    plate: true,
    shapes: [
      { kind: 'rect', x: 28.5, y: 7, w: 7, h: 21, rx: 2, ...BODY },
      { kind: 'circle', cx: C, cy: C, r: 12.5, ...BODY },
      { kind: 'circle', cx: C, cy: C, r: 3.6, fill: 'ink' },
    ],
  },
  // slow — a six-pointed star around the ring the mark always drew.
  ringed: {
    plate: true,
    shapes: [
      { kind: 'polygon', points: star(6, 19, 10.5), ...BODY },
      { kind: 'circle', cx: C, cy: C, r: 6, stroke: 'ink', width: 2.2 },
    ],
  },
  // splash — an octagon with the four spokes of the area-effect mark around a hub.
  crosshair: {
    plate: true,
    shapes: [
      { kind: 'polygon', points: regular(8, 18, -22.5), ...BODY },
      { kind: 'circle', cx: C, cy: C, r: 6.5, fill: 'ink' },
      { kind: 'path', d: spokes(9.5, 14), stroke: 'ink', width: 2.2, cap: 'round' },
    ],
  },
  // venom — the droplet itself, tip up, with a highlight.
  droplet: {
    plate: true,
    shapes: [
      {
        kind: 'path',
        d: 'M32 10C36 18.5 46 26 46 35.5A14 14 0 0 1 18 35.5C18 26 28 18.5 32 10Z',
        ...BODY,
      },
      { kind: 'circle', cx: 27, cy: 36, r: 3.4, fill: 'gloss', alpha: 0.9 },
    ],
  },
  // stun — a diamond carrying the bolt's zigzag.
  bolt: {
    plate: true,
    shapes: [
      {
        kind: 'polygon',
        points: [
          [32, 10],
          [46.5, 32],
          [32, 54],
          [17.5, 32],
        ],
        ...BODY,
      },
      {
        kind: 'path',
        d: 'M28 21L36 29L28 35L36 43',
        stroke: 'ink',
        width: 2.4,
        cap: 'round',
        join: 'round',
      },
    ],
  },
  // antiair — the arrow, swept back and pointing up, with its shaft.
  arrow: {
    plate: true,
    shapes: [
      { kind: 'path', d: 'M32 9L47.5 44L37 38L32 51L27 38L16.5 44Z', ...BODY },
      { kind: 'path', d: 'M32 22V37', stroke: 'ink', width: 2.4, cap: 'round' },
    ],
  },
  // beacon — the mast on its base, broadcasting.
  pylon: {
    plate: true,
    shapes: [
      { kind: 'rect', x: 20, y: 47, w: 24, h: 6, rx: 2, ...BODY },
      { kind: 'path', d: 'M27 48L37 48L35 23L29 23Z', ...BODY },
      { kind: 'circle', cx: C, cy: 19, r: 5.5, ...BODY },
      { kind: 'path', d: 'M22 15A12 12 0 0 1 42 15', stroke: 'role', width: 2.4, cap: 'round' },
      {
        kind: 'path',
        d: 'M17 11A18 18 0 0 1 47 11',
        stroke: 'role',
        width: 2.2,
        cap: 'round',
        alpha: 0.65,
      },
    ],
  },
  // mine — no plate: a studded charge lying on the floor, its own shadow under it.
  charge: {
    plate: false,
    shapes: [
      { kind: 'ellipse', cx: 34, cy: 36, rx: 19, ry: 15, fill: 'shadow', alpha: SHADOW_ALPHA },
      ...regular(6, 15.5, 0).map(([cx, cy]): ArtShape => ({
        kind: 'circle',
        cx,
        cy,
        r: 3.4,
        fill: 'role',
        stroke: 'ink',
        width: 1.6,
      })),
      { kind: 'circle', cx: C, cy: C, r: 13.5, ...BODY },
      { kind: 'circle', cx: C, cy: C, r: 4.2, fill: 'ink' },
    ],
  },
  // frost-splash — its own outline, a plus whose arms carry the ringed-crosshair glyph's
  // spokes out from the ring. The frame drew it as `splash`'s octagon; a tower needs an
  // outline of its own (T1). The arms are slim (12 units across, reaching 18 — the most the
  // blast spokes' 0.6-cell start allows) so the plus's deep notches set it apart from
  // splash's octagon, whose flat sides a broad plus would all but fill; the ring is sized to
  // clear the notches' inner corners. `tower-art.test.ts` measures the outline against every
  // other head, splash's and the other two control heads' (the star and the diamond) included.
  'ringed-crosshair': {
    plate: true,
    shapes: [
      { kind: 'polygon', points: plus(6, 18), ...BODY },
      { kind: 'circle', cx: C, cy: C, r: 5.25, stroke: 'ink', width: 2.2 },
      { kind: 'path', d: spokes(5.25, 13), stroke: 'ink', width: 2.2, cap: 'round' },
    ],
  },
};

// ---- States ----

/** The inner boost ring's opacity — gated, composited over the plate and over the floor,
 *  ≥ 3:1 (`palette.test.ts`), so a change here moves the gate with it. */
export const BOOST_RING_ALPHA = 0.9;

/** The glow on a tower a beacon boosts (T4): two concentric rings in `palette.aura` around
 *  the head, drawn under it. It replaced the four-stroke ✦ recipient mark. The inner ring is
 *  the cue (one CSS px at the least); the outer one is its fainter halo. Both sit inside the
 *  plate's rim, so the surface under them is the plate — or, on the plateless mine, the
 *  floor — and the palette gates the ring against both (`tower-art.test.ts` holds the rings
 *  inside the rim and visible around almost all of every head they can circle). */
export const BOOST_ART: readonly ArtShape[] = [
  {
    kind: 'circle',
    cx: C,
    cy: C,
    r: 22,
    stroke: 'aura',
    width: 2.4,
    minWidthPx: 1,
    alpha: BOOST_RING_ALPHA,
  },
  { kind: 'circle', cx: C, cy: C, r: 25.5, stroke: 'aura', width: 1.2, alpha: 0.45 },
];

/** How opaque a pending build's HEAD is. The plate under it fades further
 *  (`PENDING_PLATE_ALPHA`), so the tower reads as planned — a faint plate inside a dashed
 *  rim — while its head, the identity a player plans with, stays legible: the head's role
 *  colour at this opacity clears 3:1 against the faded plate in every mode
 *  (`palette.test.ts`). Each part fades as a whole picture, never shape by shape, so the
 *  head still covers the plate under it exactly as a built tower's does. */
export const PENDING_ALPHA = 0.85;

/** How opaque a pending build's plate is — well under the head's `PENDING_ALPHA`. */
export const PENDING_PLATE_ALPHA = 0.25;

/** A pending build's rim (T4): the plate's rim, DASHED, at full opacity over the faded art
 *  — so "planned, not built" reads by shape (the dashes) as well as by alpha. In
 *  `palette.tower`, gated ≥ 3:1 against the floor, and crisp like the solid rim, so its
 *  dashes show that contrast in full; the pattern is scaled up until its shortest dash or gap
 *  is 2 CSS px, so it stays dashed at a phone's cell size. Drawn for the mine too, which has
 *  no plate of its own: it marks the footprint the build will take. */
export const PENDING_RIM_ART: readonly ArtShape[] = [{ ...PLATE_RIM, dash: [5, 4], dashMinPx: 2 }];

/** The scorch's radius, design units — the frame's, 0.73 of a cell. */
export const SCORCH_RADIUS = 23.5;

/** The scorch a mine leaves where it went off (T4): a dark, cracked mark on the floor,
 *  centred on the mine's footprint. Decorative, and fading (`scorches.ts`). */
export const SCORCH_ART: readonly ArtShape[] = (() => {
  const r = SCORCH_RADIUS;
  const at = (fx: number, fy: number): string => `${round2(C + r * fx)} ${round2(C + r * fy)}`;
  const by = (fx: number, fy: number): string => `${round2(r * fx)} ${round2(r * fy)}`;
  return [
    {
      kind: 'ellipse',
      cx: C,
      cy: C,
      rx: r,
      ry: round2(r * 0.86),
      fill: 'scorch',
      alpha: 0.75,
    },
    {
      kind: 'path',
      d:
        `M${at(-0.7, -0.2)}l${by(0.4, 0.1)}` +
        `M${at(0.2, -0.7)}l${by(0.1, 0.4)}` +
        `M${at(0.5, 0.4)}l${by(-0.3, -0.1)}`,
      stroke: 'crack',
      width: 1.5,
      cap: 'round',
    },
  ];
})();
