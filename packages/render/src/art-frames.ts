// art-frames.ts — the board atlas's frame catalogue (V2, #181): every piece of static art a
// sprite can show, as a key, a size, an anchor and a PAINTER. A painter draws its frame
// into an `ArtGraphics` in frame-local CSS px — the bake (`bake.ts`) hands it a Canvas2D
// adapter scaled to texels.
//
// Towers (visual pass T1/T2/T4/B3) are drawn from their vector art (`tower-art.ts`) through
// the art painter (`art-paint.ts`), as SEPARATE frames: the plate every tower but the mine
// sits on (the mine stands on a floor-coloured pad instead), the head (committed, or
// boosted with its glow), a pending build's whole translucent picture, and the scorch a
// spent mine leaves. Creeps (C3/C4/B3) are drawn from theirs (`creep-art.ts`) the same way,
// as two frames: a body per look — silhouette, family hue, outline, a flyer's wings — and
// a shadow per family's size and domain. Every frame is sized from its own art's bounds —
// shadow, glow and strokes included — so nothing is clipped at any cell size.
//
// "Paint frame X into a graphics surface" is the seam later art goes through: the packing,
// baking, placement and sprite pools never learn what is inside a frame.
//
// Frames are keyed by what they LOOK like, not by catalog id: a tower frame by its look —
// head silhouette and role colour, `TowerLook` (an id the catalog has never heard of looks
// like `basic`) — a creep's body by its look — shape, family and domain, `CreepLook` — and
// its shadow by its family and domain. So every key placement can produce exists in the
// atlas by construction, for any id, and the atlas never needs the catalog. Each key is
// built once per id and kept: placement asks for one per sprite per frame, and a key string
// built afresh every time has to be hashed afresh by the atlas map it is looked up in.

import {
  CREEP_ART_R,
  CREEP_LIFT,
  CREEP_SHADOW,
  creepArtColour,
  creepBodyArt,
  creepRadius,
} from './creep-art';
import {
  CREEP_FAMILIES,
  CREEP_LOOKS,
  creepLookFor,
  creepLookKey,
  type CreepFamily,
  type CreepLook,
} from './creep-paint';
import { artBounds } from './art-geometry';
import type { ArtColourResolver, ArtGraphics } from './art-paint';
import {
  alignArtToTexels,
  rectRadius,
  strokeWidthAt,
  type ArtBox,
  type ArtRect,
  type ArtShape,
} from './art-ir';
import {
  ART_BOX,
  ART_FOOTPRINT,
  BOOST_ART,
  HEAD_ART,
  PAD_ART,
  PENDING_ALPHA,
  PENDING_PLATE_ALPHA,
  PENDING_PLATE_ART,
  PENDING_RIM_ART,
  PLATE_ART,
  SCORCH_ART,
  artColour,
} from './tower-art';
import {
  TOWER_LOOKS,
  towerFootprintMarkFor,
  towerLookFor,
  towerLookKey,
  type TowerLook,
  type TowerRole,
} from './tower-paint';
import type { Palette } from './palette';

/** Draws one frame's art in frame-local CSS px. */
export type FramePainter = (g: ArtGraphics, pal: Palette) => void;

export interface FrameSpec {
  /** The atlas frame name sprites are pointed at. */
  readonly key: string;
  /** The frame's size in TEXELS of the atlas it is baked into. */
  readonly width: number;
  readonly height: number;
  /** Where the frame's placement point sits, in CSS px from the frame's top-left: a tower
   *  frame's footprint corner, a creep or scorch frame's centre. Always a whole number of
   *  texels, so a sprite whose anchor lands on a whole device pixel has every texel on one
   *  too. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Where the art's CENTRE sits — a tower frame's footprint centre, a creep's or a scorch's
   *  own centre — as fractions of the frame's width and height: the point a sprite showing
   *  the frame turns about (an aiming head, `placement.ts`). A tower frame's lies `cellPx`
   *  CSS px right of and below its anchor, the footprint corner; a flyer's body's, its lift
   *  above its anchor, the true position (`CREEP_ART_CENTRE`). */
  readonly pivotX: number;
  readonly pivotY: number;
  readonly paint: FramePainter;
}

/** The colour resolver for a tower of `role` in `pal`. */
function colours(pal: Palette, role: TowerRole): ArtColourResolver {
  return (token) => artColour(token, pal, role);
}

/** Whether a tower of `towerId` stands on a plate — every look but the mine's. */
export function towerHasPlate(towerId: string): boolean {
  return HEAD_ART[towerLookFor(towerId).mark].plate;
}

/** `towerAims`' answer for each tower id it has been asked about. */
const AIMS_BY_ID = new Map<string, boolean>();

/** Whether a tower of `towerId` AIMS — turns its head to face its target (T3) — as its head
 *  is drawn to (`HeadArt.aims`): basic, venom, stun and antiair, and an id the catalog has
 *  never heard of, which looks like basic. Read two or three times per tower per frame, so
 *  each id's answer is kept: a tower id's look never changes, and a ruleset has a handful. */
export function towerAims(towerId: string): boolean {
  let aims = AIMS_BY_ID.get(towerId);
  if (aims === undefined) {
    aims = HEAD_ART[towerFootprintMarkFor(towerId)].aims;
    AIMS_BY_ID.set(towerId, aims);
  }
  return aims;
}

/** The one plate frame every plated tower shows. */
export const PLATE_FRAME_KEY = 'tower:plate';

/** The plate rim's four straight runs, painted again over an aiming head while it is posed —
 *  turned or knocked back (T3, `placement.ts`; `rimRunsAt`). */
export const RIM_RUNS_FRAME_KEY = 'tower:rim-runs';

/** The pad a plateless tower (the mine) shows in the plates layer instead (`PAD_ART`). */
export const PAD_FRAME_KEY = 'tower:pad';

/** What a committed tower of `towerId` stands on in the plates layer: its plate, or — for a
 *  plateless look — the floor-coloured pad that keeps aura shells off its footprint too. */
export function groundFrameKey(towerId: string): string {
  return towerFrameKeys(towerId).ground;
}

/** The frame a spent mine's scorch shows. */
export const SCORCH_FRAME_KEY = 'scorch';

function headLookKey(look: TowerLook, buffed: boolean): string {
  return `tower:head:${towerLookKey(look)}:${buffed ? 'buffed' : 'committed'}`;
}

function pendingLookKey(look: TowerLook): string {
  return `tower:pending:${towerLookKey(look)}`;
}

/** A tower id's frame keys, each built once (see the header). */
interface TowerFrameKeys {
  readonly ground: string;
  /** Committed, then boosted. */
  readonly head: readonly [string, string];
  readonly pending: string;
}

const KEYS_BY_TOWER = new Map<string, TowerFrameKeys>();

function towerFrameKeys(towerId: string): TowerFrameKeys {
  let keys = KEYS_BY_TOWER.get(towerId);
  if (keys === undefined) {
    const look = towerLookFor(towerId);
    keys = {
      ground: HEAD_ART[look.mark].plate ? PLATE_FRAME_KEY : PAD_FRAME_KEY,
      head: [headLookKey(look, false), headLookKey(look, true)],
      pending: pendingLookKey(look),
    };
    KEYS_BY_TOWER.set(towerId, keys);
  }
  return keys;
}

/** The head frame a committed tower of `towerId` shows — with the boost glow when a beacon
 *  boosts it (`buffed`). */
export function headFrameKey(towerId: string, buffed: boolean): string {
  return towerFrameKeys(towerId).head[buffed ? 1 : 0];
}

/** The frame a pending build of `towerId` shows. */
export function pendingFrameKey(towerId: string): string {
  return towerFrameKeys(towerId).pending;
}

function creepBodyKey(look: CreepLook): string {
  return `creep:${creepLookKey(look)}`;
}

function creepShadowKey(family: CreepFamily, airborne: boolean): string {
  return `creep:shadow:${family}:${airborne ? 'air' : 'ground'}`;
}

/** A creep's frames for one id, role and domain: its look, the body frame it shows and the
 *  shadow frame under it. */
export interface CreepFrameKeys {
  readonly look: CreepLook;
  readonly body: string;
  readonly shadow: string;
}

/** A value per creep look, kept by creep id in four slots — [ground, air] × [not boss, boss] —
 *  each set the first time its look is asked for. The one layout both caches of a creep's
 *  frames use: its frame keys (`creepFrameKeys`, below) and, per atlas, their anchors
 *  (`placement.ts`). */
export class CreepLookSlots<T> {
  private readonly byId = new Map<string, (T | undefined)[]>();

  private static slot(boss: boolean, airborne: boolean): number {
    return (boss ? 2 : 0) + (airborne ? 1 : 0);
  }

  /** The value kept for `creepId` with the boss role or not, in the air or not, if any. */
  get(creepId: string, boss: boolean, airborne: boolean): T | undefined {
    return this.byId.get(creepId)?.[CreepLookSlots.slot(boss, airborne)];
  }

  /** Keep `value` for `creepId` with the boss role or not, in the air or not; returns it. */
  set(creepId: string, boss: boolean, airborne: boolean, value: T): T {
    let slots = this.byId.get(creepId);
    if (slots === undefined) {
      slots = [undefined, undefined, undefined, undefined];
      this.byId.set(creepId, slots);
    }
    slots[CreepLookSlots.slot(boss, airborne)] = value;
    return value;
  }
}

/** Each creep id's frame keys, one per look. */
const KEYS_BY_CREEP = new CreepLookSlots<CreepFrameKeys>();

/** The frames a creep of `creepId` shows, with the boss role or not, in the air or not —
 *  built once per id, role and domain (see the header). */
export function creepFrameKeys(creepId: string, boss: boolean, airborne: boolean): CreepFrameKeys {
  const kept = KEYS_BY_CREEP.get(creepId, boss, airborne);
  if (kept !== undefined) return kept;
  const look = creepLookFor(creepId, boss, airborne);
  return KEYS_BY_CREEP.set(creepId, boss, airborne, {
    look,
    body: creepBodyKey(look),
    shadow: creepShadowKey(look.family, airborne),
  });
}

/** The body frame a creep of `creepId` shows. */
export function creepFrameKey(creepId: string, boss: boolean, airborne: boolean): string {
  return creepFrameKeys(creepId, boss, airborne).body;
}

/** The shadow frame under a creep of `creepId`. */
export function creepShadowFrameKey(creepId: string, boss: boolean, airborne: boolean): string {
  return creepFrameKeys(creepId, boss, airborne).shadow;
}

/** Transparent texels kept around a frame's art on each side — room for the anti-aliased
 *  edge of a stroke that reaches the frame's art box. */
export const FRAME_PAD_TEXELS = 2;

/** CSS px per design unit for art at `cellPx`: the 64-unit box spans a 2×2 footprint. */
export function artUnit(cellPx: number): number {
  return (2 * cellPx) / ART_BOX;
}

/** Draws design-unit `shapes` into the frame, in the colours `colour` resolves. */
type ArtDraw = (shapes: readonly ArtShape[], colour: ArtColourResolver) => void;

/** Paints a frame's art through `draw`, which places it; `g` is there for the bake's other
 *  operations (`fade`). */
type ArtPainter = (draw: ArtDraw, g: ArtGraphics, pal: Palette) => void;

/**
 * A frame sized to hold `shapes` drawn at `unit` CSS px per design unit — a tower's
 * `artUnit(cellPx)` by default; a creep's is its radius over `CREEP_ART_R` — anchored at the
 * design point `anchor` (a tower's footprint corner is (0, 0); its centre is (32, 32); a
 * creep's true position is its body's centre, or `CREEP_LIFT` below a flyer's), and pivoting
 * on the design point `centre`, the art's own centre (`FrameSpec.pivotX/Y`): a tower's
 * footprint centre, (32, 32), by default; a creep's body centre, (0, 0). The anchor
 * sits on a whole texel at least `FRAME_PAD_TEXELS` in from every edge, and the frame reaches
 * past the art's bounds — strokes grown by their half-width at this scale — by that same pad.
 *
 * Every frame is packed on whole atlas texels (`atlas-pack.ts`), so the frame's texel grid
 * is the atlas's: what the frame draws — and sizes itself for — is the art with its `crisp`
 * strokes moved onto that grid (`alignArtToTexels`), kept inside the footprint.
 */
function artFrame(
  key: string,
  shapes: readonly ArtShape[],
  cellPx: number,
  scale: number,
  anchor: readonly [number, number],
  paint: ArtPainter,
  unit: number = artUnit(cellPx),
  centre: readonly [number, number] = [ART_BOX / 2, ART_BOX / 2],
): FrameSpec {
  const [ax, ay] = anchor;
  // Design-unit (0, 0) lies `anchor` design units up and left of the anchor, which is on a
  // whole texel: that offset is all the texel grid's alignment needs to know.
  const origin = [-ax * unit * scale, -ay * unit * scale] as const;
  const onGrid = (s: readonly ArtShape[]): readonly ArtShape[] =>
    alignArtToTexels(s, unit, scale, origin, ART_FOOTPRINT);
  const b = artBounds(onGrid(shapes), unit);
  /** Whole texels to hold `d` design units: rounded up, but never for floating-point dust —
   *  a rim moved onto the texel grid can end exactly on the anchor, which the bounds then
   *  report a few 1e-16 units past it. */
  const texels = (d: number): number => Math.ceil(Math.max(0, d) * unit * scale - 1e-9);
  const leftTexels = FRAME_PAD_TEXELS + texels(ax - b.minX);
  const topTexels = FRAME_PAD_TEXELS + texels(ay - b.minY);
  const width = leftTexels + texels(b.maxX - ax) + FRAME_PAD_TEXELS;
  const height = topTexels + texels(b.maxY - ay) + FRAME_PAD_TEXELS;
  const anchorX = leftTexels / scale;
  const anchorY = topTexels / scale;
  const x0 = anchorX - ax * unit;
  const y0 = anchorY - ay * unit;
  // The art's centre, design `centre` — (32, 32) for a tower — lies `cx - ax` design units
  // right of the anchor (and `cy - ay` below it): in texels from the frame's corner, over the
  // frame's size.
  const [cx, cy] = centre;
  return {
    key,
    width,
    height,
    anchorX,
    anchorY,
    pivotX: (leftTexels + (cx - ax) * unit * scale) / width,
    pivotY: (topTexels + (cy - ay) * unit * scale) / height,
    paint: (g, pal) => paint((s, colour) => g.art(onGrid(s), colour, x0, y0, unit), g, pal),
  };
}

/** A tower's whole picture as a Card swatch shows it — its plate (if its look has one), then
 *  its committed head — with design-unit (0, 0), the footprint corner, at `(x, y)` and the
 *  footprint `footprintPx` CSS px across. The same art, through the same painter, as the
 *  board's frames, so a Card always matches the board. With `pixelScale` — the surface's
 *  device px per CSS px, its CSS (0, 0) on a whole device pixel — the plate's crisp rim is
 *  drawn on that surface's pixel grid, as the board's frames draw it on the atlas's, inside
 *  the footprint; and, given `surfacePx` (the surface's CSS size from its (0, 0)), inside the
 *  surface too. A fitted picture's footprint can reach past the surface's edge — the plate's
 *  offset shadow pushes it up and left (`towerArtFit`) — and a rim widened outward to its
 *  floor there would lose a pixel of its width to that edge. */
export function paintTowerArt(
  g: ArtGraphics,
  pal: Palette,
  look: TowerLook,
  x: number,
  y: number,
  footprintPx: number,
  pixelScale?: number,
  surfacePx?: { readonly width: number; readonly height: number },
): void {
  const unit = footprintPx / ART_BOX;
  const c = colours(pal, look.role);
  const head = HEAD_ART[look.mark];
  /** The footprint, cut to the surface when there is one — design units. */
  const within: ArtBox =
    surfacePx === undefined
      ? ART_FOOTPRINT
      : [
          Math.max(0, -x / unit),
          Math.max(0, -y / unit),
          Math.min(ART_BOX, (surfacePx.width - x) / unit),
          Math.min(ART_BOX, (surfacePx.height - y) / unit),
        ];
  const plate =
    pixelScale === undefined
      ? PLATE_ART
      : alignArtToTexels(PLATE_ART, unit, pixelScale, [x * pixelScale, y * pixelScale], within);
  if (head.plate) g.art(plate, c, x, y, unit);
  g.art(head.shapes, c, x, y, unit);
}

/** Every shape a committed tower can paint without its boost glow: the plate, and every
 *  head over it. */
const EVERY_TOWER_SHAPE: readonly ArtShape[] = [
  ...PLATE_ART,
  ...Object.values(HEAD_ART).flatMap((h) => h.shapes),
];

/** Where a tower's whole picture — the plate's offset shadow included — sits centred in a
 *  `sizePx` square: the footprint corner and size to hand `paintTowerArt`. One fit for every
 *  look, taken from the bounds of every tower's art together, so towers drawn side by side —
 *  a Card per tower — share one scale, as they do on the board. The bounds depend a little
 *  on the scale (a stroke's CSS-px floor is wider in design units the smaller the art), so
 *  the fit is iterated to its fixed point. */
export function towerArtFit(sizePx: number): { x: number; y: number; footprintPx: number } {
  let unit = sizePx / ART_BOX;
  let b = artBounds(EVERY_TOWER_SHAPE, unit);
  for (let i = 0; i < 16; i++) {
    const next = sizePx / Math.max(b.maxX - b.minX, b.maxY - b.minY);
    if (Math.abs(next - unit) < 1e-12) break;
    unit = next;
    b = artBounds(EVERY_TOWER_SHAPE, unit);
  }
  return {
    x: sizePx / 2 - ((b.minX + b.maxX) / 2) * unit,
    y: sizePx / 2 - ((b.minY + b.maxY) / 2) * unit,
    footprintPx: unit * ART_BOX,
  };
}

/**
 * The boost glow as a boosted head's frame draws it, at `unit` CSS px per design unit and
 * `scale` texels per CSS px: each ring inside the plate's rim AS THE PLATE FRAME DRAWS IT —
 * on whole texels and inside the footprint, which at small cells brings the rim's far sides
 * in past the design's place, where the footprint ends inside a pixel. The glow's colour is
 * gated against the plate, never the rim, and a ring reaching into the rim's texels would
 * blend the footprint's edge itself. So the cue ring is drawn as designed wherever it fits
 * and otherwise shrinks about its centre just enough (from 9 px cells, at dpr 0.8 to 3: only
 * at 9 and 10 px cells, to 0.91 of its radius at the least, where every head still leaves
 * 0.9 of it showing); the fainter halo shrinks too while it stays clear of the cue (at 9 to
 * 15 px cells, at some dprs), and is left out where it cannot (at 9 to 12 px). Below 9 px
 * (at those dprs) the cue shrinks further: to 0.85 of its radius at 8 px, 0.77 at 7 px and
 * 0.30 at 4 px, and to nothing at some dprs at 3 px and below (at every dpr at 1 px). Each ring may meet the rim's inner edge — a texel's —
 * never cross it.
 */
export function boostArtAt(unit: number, scale: number): readonly ArtShape[] {
  const rim = drawnPlateRim(unit, scale);
  const [cue, halo] = BOOST_ART;
  if (cue?.kind !== 'circle' || halo?.kind !== 'circle') {
    throw new Error('the glow is two rings inside a rect rim');
  }
  const half = strokeWidthAt(rim, unit) / 2;
  // The room inside the drawn rim, from the glow's centre to its nearest inner edge.
  const room = Math.min(
    cue.cx - (rim.x + half),
    rim.x + rim.w - half - cue.cx,
    cue.cy - (rim.y + half),
    rim.y + rim.h - half - cue.cy,
  );
  const cueHalf = strokeWidthAt(cue, unit) / 2;
  const haloHalf = strokeWidthAt(halo, unit) / 2;
  const cueR = Math.min(cue.r, room - cueHalf);
  const haloR = Math.min(halo.r, room - haloHalf);
  if (cueR === cue.r && haloR === halo.r) return BOOST_ART;
  const fitted: ArtShape[] = [{ ...cue, r: cueR }];
  if (haloR - haloHalf >= cueR + cueHalf) fitted.push({ ...halo, r: haloR });
  return fitted;
}

/** The plate's rim as the plate frame draws it at `unit` CSS px per design unit and `scale`
 *  texels per CSS px: on whole texels, inside the footprint. */
function drawnPlateRim(unit: number, scale: number): ArtRect {
  const rim = alignArtToTexels(PLATE_ART, unit, scale, [0, 0], ART_FOOTPRINT).find(
    (s) => s.stroke === 'rim',
  );
  if (rim?.kind !== 'rect') throw new Error('the plate rim is a rect');
  return rim;
}

/**
 * The plate rim's four straight runs as the plate frame draws them at `unit` CSS px per design
 * unit and `scale` texels per CSS px: four filled rects in the rim's colour, each over exactly
 * the texels the rim wholly covers between its rounded corners — its band of whole texels
 * (`alignRectToTexels`), cut back to the whole texels between the corners' tangent points. So,
 * painted over the plate, they change no pixel the rim has not already made its own; painted
 * over a head, they give back whatever of it the head darkened (T3: a turned head is resampled,
 * and where a side of the drawn rim comes within a texel of it — at small cells, and at dprs
 * between the whole ones, where the footprint ends inside a pixel and the texel grid brings the
 * rim's far sides in by up to a pixel — the Basic Tower's barrel took the rim's inner pixel to
 * 1.34:1 on screen). A head never reaches a corner: its farthest point is 26 design units out,
 * a corner's inner edge 36. A run with no whole texel between its corners — at a few px cells —
 * is left out.
 */
export function rimRunsAt(unit: number, scale: number): readonly ArtShape[] {
  const rim = drawnPlateRim(unit, scale);
  const k = unit * scale; // texels per design unit
  const half = strokeWidthAt(rim, unit) / 2;
  const r = rectRadius(rim);
  /** The rim's band of whole texels about centre line `c`. */
  const band = (c: number): [number, number] => [
    Math.round((c - half) * k),
    Math.round((c + half) * k),
  ];
  /** The whole texels between two tangent points, `from` and `to` design units. */
  const between = (from: number, to: number): [number, number] => [
    Math.ceil(from * k - 1e-9),
    Math.floor(to * k + 1e-9),
  ];
  const [x0, x1] = between(rim.x + r, rim.x + rim.w - r);
  const [y0, y1] = between(rim.y + r, rim.y + rim.h - r);
  const run = ([l, rt]: [number, number], [t, b]: [number, number]): ArtShape[] =>
    rt > l && b > t
      ? [{ kind: 'rect', x: l / k, y: t / k, w: (rt - l) / k, h: (b - t) / k, rx: 0, fill: 'rim' }]
      : [];
  return [
    ...run([x0, x1], band(rim.y)),
    ...run([x0, x1], band(rim.y + rim.h)),
    ...run(band(rim.x), [y0, y1]),
    ...run(band(rim.x + rim.w), [y0, y1]),
  ];
}

/** Every tower frame at `cellPx` and `scale` texels per CSS px: the shared plate, and for
 *  every look its head (committed and boosted) and its pending build. Tower frames are
 *  anchored at the footprint's top-left corner. */
export function towerFrameSpecs(cellPx: number, scale: number): FrameSpec[] {
  const corner = [0, 0] as const;
  const specs: FrameSpec[] = [
    artFrame(PLATE_FRAME_KEY, PLATE_ART, cellPx, scale, corner, (draw, _g, pal) =>
      draw(PLATE_ART, colours(pal, 'damage')),
    ),
    artFrame(PAD_FRAME_KEY, PAD_ART, cellPx, scale, corner, (draw, _g, pal) =>
      draw(PAD_ART, colours(pal, 'burst')),
    ),
  ];
  const runs = rimRunsAt(artUnit(cellPx), scale);
  specs.push(
    artFrame(RIM_RUNS_FRAME_KEY, runs, cellPx, scale, corner, (draw, _g, pal) =>
      draw(runs, colours(pal, 'damage')),
    ),
  );
  const glow = boostArtAt(artUnit(cellPx), scale);
  for (const look of TOWER_LOOKS) {
    const head = HEAD_ART[look.mark];
    for (const buffed of [false, true]) {
      const shapes = buffed ? [...glow, ...head.shapes] : head.shapes;
      specs.push(
        artFrame(headLookKey(look, buffed), shapes, cellPx, scale, corner, (draw, _g, pal) =>
          // The glow first, so the head draws over it, as in the frame.
          draw(shapes, colours(pal, look.role)),
        ),
      );
    }
    const under = head.plate ? PENDING_PLATE_ART : [];
    specs.push(
      artFrame(
        pendingLookKey(look),
        [...under, ...head.shapes, ...PENDING_RIM_ART],
        cellPx,
        scale,
        corner,
        (draw, g, pal) => {
          const c = colours(pal, look.role);
          // The plate first, faded so that the head's fade below takes it the rest of the way
          // to `PENDING_PLATE_ALPHA`; then the head over it, opaque, so it covers the plate
          // exactly as a built tower's does; then both faded as ONE picture to the head's
          // `PENDING_ALPHA`; then the dashed rim at full opacity.
          if (under.length > 0) {
            draw(under, c);
            g.fade(PENDING_PLATE_ALPHA / PENDING_ALPHA);
          }
          draw(head.shapes, c);
          g.fade(PENDING_ALPHA);
          draw(PENDING_RIM_ART, c);
        },
      ),
    );
  }
  return specs;
}

/** The scorch frame at `cellPx` and `scale`, anchored at its centre — the mine's footprint
 *  centre, where its blast went off. */
export function scorchFrameSpec(cellPx: number, scale: number): FrameSpec {
  const centre = [ART_BOX / 2, ART_BOX / 2] as const;
  return artFrame(SCORCH_FRAME_KEY, SCORCH_ART, cellPx, scale, centre, (draw, _g, pal) =>
    draw(SCORCH_ART, colours(pal, 'burst')),
  );
}

/** The colour resolver for a creep of `family` in `pal`. */
function creepColours(pal: Palette, family: CreepFamily): ArtColourResolver {
  return (token) => creepArtColour(token, pal, family);
}

/** Where every creep frame pivots (`FrameSpec.pivotX/Y`): design (0, 0) — in a body's frame
 *  the body's centre, a flyer's `CREEP_LIFT` above the true position the frame is anchored
 *  at; in a shadow's, the true position it is cast from, as a plate pivots on its footprint
 *  centre whatever its offset shadow. */
const CREEP_ART_CENTRE = [0, 0] as const;

/** Every creep frame at `cellPx` and `scale` texels per CSS px: each look's BODY — its wings
 *  if it flies, its silhouette in its family's hue, outlined in ink — and each family's
 *  SHADOW, on the ground and in the air. Each is drawn at its family's radius and anchored at
 *  the creep's TRUE position — a flyer's body `CREEP_LIFT` above it — so a creep's body and
 *  shadow sprites land on one snapped point and the lift between them is baked in. The body
 *  keeps its family's hue at any HP; the HP bar is drawn live (`drawCreepCues`). */
export function creepFrameSpecs(cellPx: number, scale: number): FrameSpec[] {
  const specs: FrameSpec[] = [];
  for (const look of CREEP_LOOKS) {
    const shapes = creepBodyArt(look);
    const anchor = [0, look.airborne ? CREEP_LIFT : 0] as const;
    specs.push(
      artFrame(
        creepBodyKey(look),
        shapes,
        cellPx,
        scale,
        anchor,
        (draw, _g, pal) => draw(shapes, creepColours(pal, look.family)),
        creepRadius(cellPx, look.family) / CREEP_ART_R,
        CREEP_ART_CENTRE,
      ),
    );
  }
  for (const family of CREEP_FAMILIES) {
    for (const airborne of [false, true]) {
      const shapes = CREEP_SHADOW[airborne ? 'air' : 'ground'];
      specs.push(
        artFrame(
          creepShadowKey(family, airborne),
          shapes,
          cellPx,
          scale,
          [0, 0],
          (draw, _g, pal) => draw(shapes, creepColours(pal, family)),
          creepRadius(cellPx, family) / CREEP_ART_R,
          CREEP_ART_CENTRE,
        ),
      );
    }
  }
  return specs;
}

/** The whole atlas's frames: towers, the scorch, then creeps. */
export function atlasFrameSpecs(cellPx: number, scale: number): FrameSpec[] {
  return [
    ...towerFrameSpecs(cellPx, scale),
    scorchFrameSpec(cellPx, scale),
    ...creepFrameSpecs(cellPx, scale),
  ];
}
