// art-frames.ts — the board atlas's frame catalogue (V2, #181): every piece of static art a
// sprite can show, as a key, a size, an anchor and a PAINTER. A painter draws its frame
// into an `ArtGraphics` in frame-local CSS px — the bake (`bake.ts`) hands it a Canvas2D
// adapter scaled to texels.
//
// Towers (visual pass T1/T2/T4/B3) are drawn from their vector art (`tower-art.ts`) through
// the art painter (`art-paint.ts`), as SEPARATE frames: the plate every tower but the mine
// sits on (the mine stands on a floor-coloured pad instead), the head (committed, or
// boosted with its glow), a pending build's whole translucent picture, and the scorch a
// spent mine leaves. Every tower frame is sized from its own art's bounds — shadow, glow and
// strokes included — so nothing is clipped at any cell size. Creeps are still the board's
// own geometry (`board-draw.ts`), unchanged.
//
// "Paint frame X into a graphics surface" is the seam later art goes through: the packing,
// baking, placement and sprite pools never learn what is inside a frame.
//
// Frames are keyed by what they LOOK like, not by catalog id: a tower frame by its look —
// head silhouette and role colour, `TowerLook` (an id the catalog has never heard of looks
// like `basic`) — a creep frame by its silhouette shape. So every key placement can produce
// exists in the atlas by construction, for any id, and the atlas never needs the catalog.

import { creepFillColour, creepRadius, paintCreepSilhouette, isLowHp } from './board-draw';
import { CREEP_SHAPE_VALUES, creepShapeFor, type CreepShape } from './creep-paint';
import { artBounds } from './art-geometry';
import type { ArtColourResolver, ArtGraphics } from './art-paint';
import { alignArtToTexels, strokeWidthAt, type ArtBox, type ArtShape } from './art-ir';
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

/** The one plate frame every plated tower shows. */
export const PLATE_FRAME_KEY = 'tower:plate';

/** The pad a plateless tower (the mine) shows in the plates layer instead (`PAD_ART`). */
export const PAD_FRAME_KEY = 'tower:pad';

/** What a committed tower of `towerId` stands on in the plates layer: its plate, or — for a
 *  plateless look — the floor-coloured pad that keeps aura shells off its footprint too. */
export function groundFrameKey(towerId: string): string {
  return towerHasPlate(towerId) ? PLATE_FRAME_KEY : PAD_FRAME_KEY;
}

/** The frame a spent mine's scorch shows. */
export const SCORCH_FRAME_KEY = 'scorch';

function headLookKey(look: TowerLook, buffed: boolean): string {
  return `tower:head:${towerLookKey(look)}:${buffed ? 'buffed' : 'committed'}`;
}

function pendingLookKey(look: TowerLook): string {
  return `tower:pending:${towerLookKey(look)}`;
}

/** The head frame a committed tower of `towerId` shows — with the boost glow when a beacon
 *  boosts it (`buffed`). */
export function headFrameKey(towerId: string, buffed: boolean): string {
  return headLookKey(towerLookFor(towerId), buffed);
}

/** The frame a pending build of `towerId` shows. */
export function pendingFrameKey(towerId: string): string {
  return pendingLookKey(towerLookFor(towerId));
}

/** The atlas frame a creep of `creepId` shows at `hpFrac`, boss-sized or not. */
export function creepFrameKey(creepId: string, hpFrac: number, boss: boolean): string {
  return creepShapeFrameKey(creepShapeFor(creepId), isLowHp(hpFrac), boss);
}

function creepShapeFrameKey(shape: CreepShape, lowHp: boolean, boss: boolean): string {
  return `creep:${shape}:${lowHp ? 'low' : 'normal'}:${boss ? 'boss' : 'standard'}`;
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
 * A frame sized to hold `shapes` drawn at `cellPx`, anchored at the design point `anchor`
 * (a tower's footprint corner is (0, 0); its centre is (32, 32)). The anchor sits on a whole
 * texel at least `FRAME_PAD_TEXELS` in from every edge, and the frame reaches past the art's
 * bounds — strokes grown by their half-width at this scale — by that same pad.
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
): FrameSpec {
  const unit = artUnit(cellPx);
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
  return {
    key,
    width,
    height,
    anchorX,
    anchorY,
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
  const rim = alignArtToTexels(PLATE_ART, unit, scale, [0, 0], ART_FOOTPRINT).find(
    (s) => s.stroke === 'rim',
  );
  const [cue, halo] = BOOST_ART;
  if (rim?.kind !== 'rect' || cue?.kind !== 'circle' || halo?.kind !== 'circle') {
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

/** Every creep frame: each silhouette shape × {normal, low-HP} fill × {standard, boss}
 *  size. The anchor is the silhouette's centre, on a whole texel — which is also what puts
 *  the diamond's two triangles' shared edge exactly between two texel columns, so the bake
 *  cannot leave an anti-aliased seam down its middle. */
export function creepFrameSpecs(cellPx: number, scale: number): FrameSpec[] {
  const specs: FrameSpec[] = [];
  for (const boss of [false, true]) {
    const r = creepRadius(cellPx, boss);
    const half = Math.ceil(r * scale) + FRAME_PAD_TEXELS;
    const at = half / scale; // the centre, frame-local CSS px
    for (const shape of CREEP_SHAPE_VALUES) {
      for (const lowHp of [false, true]) {
        specs.push({
          key: creepShapeFrameKey(shape, lowHp, boss),
          width: half * 2,
          height: half * 2,
          anchorX: at,
          anchorY: at,
          paint: (g, pal) =>
            paintCreepSilhouette(g, {
              shape,
              x: at,
              y: at,
              r,
              colour: creepFillColour(pal, lowHp),
            }),
        });
      }
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
