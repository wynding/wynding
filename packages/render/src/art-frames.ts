// art-frames.ts — the board atlas's frame catalogue (V2, #181): every piece of static art a
// sprite can show, as a key, a size, an anchor and a PAINTER. A painter draws its frame
// into an `ArtGraphics` in frame-local CSS px — the bake (`bake.ts`) hands it a Canvas2D
// adapter scaled to texels.
//
// Towers (visual pass T1/T2/T4/B3) are drawn from their vector art (`tower-art.ts`) through
// the art painter (`art-paint.ts`), as SEPARATE frames: the plate every tower but the mine
// sits on, the head (committed, or boosted with its glow), a pending build's whole
// translucent picture, and the scorch a spent mine leaves. Every tower frame is sized from
// its own art's bounds — shadow, glow and strokes included — so nothing is clipped at any
// cell size. Creeps are still the board's own geometry (`board-draw.ts`), unchanged.
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
import type { ArtShape } from './art-ir';
import {
  ART_BOX,
  BOOST_ART,
  HEAD_ART,
  PENDING_ALPHA,
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

/** Paints art with its design origin at `(x0, y0)` frame-local CSS px, `unit` CSS px per
 *  design unit. */
type ArtPainter = (g: ArtGraphics, pal: Palette, x0: number, y0: number, unit: number) => void;

/**
 * A frame sized to hold `shapes` drawn at `cellPx`, anchored at the design point `anchor`
 * (a tower's footprint corner is (0, 0); its centre is (32, 32)). The anchor sits on a whole
 * texel at least `FRAME_PAD_TEXELS` in from every edge, and the frame reaches past the art's
 * bounds — strokes grown by their half-width at this scale — by that same pad.
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
  const b = artBounds(shapes, unit);
  const [ax, ay] = anchor;
  const leftTexels = FRAME_PAD_TEXELS + Math.ceil(Math.max(0, ax - b.minX) * unit * scale);
  const topTexels = FRAME_PAD_TEXELS + Math.ceil(Math.max(0, ay - b.minY) * unit * scale);
  const width = leftTexels + Math.ceil(Math.max(0, b.maxX - ax) * unit * scale) + FRAME_PAD_TEXELS;
  const height = topTexels + Math.ceil(Math.max(0, b.maxY - ay) * unit * scale) + FRAME_PAD_TEXELS;
  const anchorX = leftTexels / scale;
  const anchorY = topTexels / scale;
  const x0 = anchorX - ax * unit;
  const y0 = anchorY - ay * unit;
  return { key, width, height, anchorX, anchorY, paint: (g, pal) => paint(g, pal, x0, y0, unit) };
}

/** A tower's whole picture as a Card swatch shows it — its plate (if its look has one), then
 *  its committed head — with design-unit (0, 0), the footprint corner, at `(x, y)` and the
 *  footprint `footprintPx` CSS px across. The same art, through the same painter, as the
 *  board's frames, so a Card always matches the board. */
export function paintTowerArt(
  g: ArtGraphics,
  pal: Palette,
  look: TowerLook,
  x: number,
  y: number,
  footprintPx: number,
): void {
  const unit = footprintPx / ART_BOX;
  const c = colours(pal, look.role);
  const head = HEAD_ART[look.mark];
  if (head.plate) g.art(PLATE_ART, c, x, y, unit);
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

/** Every tower frame at `cellPx` and `scale` texels per CSS px: the shared plate, and for
 *  every look its head (committed and boosted) and its pending build. Tower frames are
 *  anchored at the footprint's top-left corner. */
export function towerFrameSpecs(cellPx: number, scale: number): FrameSpec[] {
  const corner = [0, 0] as const;
  const specs: FrameSpec[] = [
    artFrame(PLATE_FRAME_KEY, PLATE_ART, cellPx, scale, corner, (g, pal, x0, y0, unit) =>
      g.art(PLATE_ART, colours(pal, 'damage'), x0, y0, unit),
    ),
  ];
  for (const look of TOWER_LOOKS) {
    const head = HEAD_ART[look.mark];
    for (const buffed of [false, true]) {
      const shapes = buffed ? [...BOOST_ART, ...head.shapes] : head.shapes;
      specs.push(
        artFrame(headLookKey(look, buffed), shapes, cellPx, scale, corner, (g, pal, x0, y0, unit) =>
          // The glow first, so the head draws over it, as in the frame.
          g.art(shapes, colours(pal, look.role), x0, y0, unit),
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
        (g, pal, x0, y0, unit) => {
          const c = colours(pal, look.role);
          // The whole tower, then faded as ONE picture — so the head covers the plate under
          // it exactly as a built tower's does — then the dashed rim at full opacity.
          g.art([...under, ...head.shapes], c, x0, y0, unit);
          g.fade(PENDING_ALPHA);
          g.art(PENDING_RIM_ART, c, x0, y0, unit);
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
  return artFrame(SCORCH_FRAME_KEY, SCORCH_ART, cellPx, scale, centre, (g, pal, x0, y0, unit) =>
    g.art(SCORCH_ART, colours(pal, 'burst'), x0, y0, unit),
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
