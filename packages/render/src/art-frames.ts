// art-frames.ts — the board atlas's frame catalogue (V2, #181): every piece of static art a
// sprite can show, as a key, a size, an anchor and a PAINTER. A painter draws its frame
// into a `GraphicsLike` in frame-local CSS px — the bake (`bake.ts`) hands it a Canvas2D
// adapter scaled to texels — by calling the board's own geometry (`board-draw.ts`), so the
// sprite shows exactly what the board used to re-record into a `Graphics` every frame.
//
// "Paint frame X into a GraphicsLike" is the seam later art goes through: a new primitive
// (an SVG path, say) is a new method on the bake's graphics and a new painter here — the
// packing, baking, placement and sprite pools never learn what is inside a frame.
//
// Frames are keyed by what they LOOK like, not by catalog id: a tower frame by its
// footprint mark (an id the catalog has never heard of draws `'plain'`, like `basic`), a
// creep frame by its silhouette shape. So every key placement can produce exists in the
// atlas by construction, for any id, and the atlas never needs the catalog.

import {
  creepFillColour,
  creepRadius,
  paintCommittedTower,
  paintCreepSilhouette,
  paintPendingTower,
  isLowHp,
  type GraphicsLike,
} from './board-draw';
import { CREEP_SHAPE_VALUES, creepShapeFor, type CreepShape } from './creep-paint';
import {
  TOWER_FOOTPRINT_MARKS,
  towerFootprintMarkFor,
  type TowerFootprintMark,
} from './tower-paint';
import type { Palette } from './palette';

/** Draws one frame's art in frame-local CSS px. */
export type FramePainter = (g: GraphicsLike, pal: Palette) => void;

export interface FrameSpec {
  /** The atlas frame name sprites are pointed at. */
  readonly key: string;
  /** The frame's size in TEXELS of the atlas it is baked into. */
  readonly width: number;
  readonly height: number;
  /** Where the frame's placement point sits, in CSS px from the frame's top-left: a tower
   *  frame's footprint corner, a creep frame's centre. Always a whole number of texels, so
   *  a sprite whose anchor lands on a whole device pixel has every texel on one too. */
  readonly anchorX: number;
  readonly anchorY: number;
  readonly paint: FramePainter;
}

/** A tower frame's three states: committed, committed while a support aura buffs it (the
 *  recipient ✦), and queued-but-not-committed (the translucent outline). */
export type TowerVariant = 'committed' | 'buffed' | 'pending';
const TOWER_VARIANTS: readonly TowerVariant[] = ['committed', 'buffed', 'pending'];

/** The atlas frame a tower of `towerId` shows in `variant`. */
export function towerFrameKey(towerId: string, variant: TowerVariant): string {
  return towerMarkFrameKey(towerFootprintMarkFor(towerId), variant);
}

function towerMarkFrameKey(mark: TowerFootprintMark, variant: TowerVariant): string {
  return `tower:${mark}:${variant}`;
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

/** Every tower frame: each footprint mark × each variant, at `cellPx` and `scale` texels per
 *  CSS px. The art box is the 2×2 footprint; the anchor is its top-left corner. */
export function towerFrameSpecs(cellPx: number, scale: number): FrameSpec[] {
  const footprint = Math.ceil(cellPx * 2 * scale);
  const side = footprint + FRAME_PAD_TEXELS * 2;
  const at = FRAME_PAD_TEXELS / scale; // the footprint corner, frame-local CSS px
  const specs: FrameSpec[] = [];
  for (const mark of TOWER_FOOTPRINT_MARKS) {
    for (const variant of TOWER_VARIANTS) {
      specs.push({
        key: towerMarkFrameKey(mark, variant),
        width: side,
        height: side,
        anchorX: at,
        anchorY: at,
        paint:
          variant === 'pending'
            ? (g, pal) => paintPendingTower(g, pal, mark, at, at, cellPx)
            : (g, pal) => paintCommittedTower(g, pal, mark, at, at, cellPx, variant === 'buffed'),
      });
    }
  }
  return specs;
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

/** The whole atlas's frames, towers then creeps. */
export function atlasFrameSpecs(cellPx: number, scale: number): FrameSpec[] {
  return [...towerFrameSpecs(cellPx, scale), ...creepFrameSpecs(cellPx, scale)];
}
