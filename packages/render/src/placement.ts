// placement.ts — which atlas frame each sprite shows, and where (V2, #181). Pure,
// Phaser-free, unit-tested: `board-frame.ts` hands these lists to the sprite pools
// (`sprite-pool.ts`), which only copy them onto sprites, so every decision a frame's picture
// depends on — which towers are hidden, which are pending, which wear the buffed ✦, which
// silhouette and size a creep gets, when it turns low-health — is made here, where a test
// can see it.
//
// POSITIONS are world CSS px (the space every projection call returns) and are SNAPPED TO
// WHOLE DEVICE PIXELS: a sprite's top-left lands where `x × dpr` is an integer. The atlas
// bakes at the effective dpr with every frame anchor on a whole texel, so a snapped sprite
// puts each texel on exactly one pixel of the canvas's backing store — crisp, never resampled
// between two (`scene.ts` says how that store reaches the screen). Creeps carry their snapped
// centre too, for the cues drawn around them (`drawCreepCues`) and the tracers converging on
// them.

import {
  creepFillColour,
  creepRadius,
  isLowHp,
  visibleTowers,
  type CreepCueInput,
} from './board-draw';
import { creepFrameKey, towerFrameKey } from './art-frames';
import { snapToDevicePx } from './device-px';
import type { Projection } from './projection';
import type { Palette } from './palette';
import type { CreepVM, RenderOverlay, RenderVM } from './types';

/** One sprite: the atlas frame it shows and its top-left corner, world CSS px. */
export interface SpritePlacement {
  readonly frame: string;
  readonly x: number;
  readonly y: number;
}

/** What placement needs to know of a baked frame: where its anchor sits inside it. */
export interface FrameAnchor {
  readonly anchorX: number;
  readonly anchorY: number;
}

function anchorOf(frames: ReadonlyMap<string, FrameAnchor>, key: string): FrameAnchor {
  const frame = frames.get(key);
  // Every key `towerFrameKey`/`creepFrameKey` can produce is baked (`art-frames.ts`), for
  // any id at all — a miss is a broken atlas, and drawing nothing would hide it.
  if (frame === undefined) throw new Error(`board atlas has no frame '${key}'`);
  return frame;
}

/** The sprite whose frame anchor goes at world `(ax, ay)`. */
function placeAt(
  frames: ReadonlyMap<string, FrameAnchor>,
  key: string,
  ax: number,
  ay: number,
  dpr: number,
): SpritePlacement {
  const a = anchorOf(frames, key);
  return {
    frame: key,
    x: snapToDevicePx(ax, dpr) - a.anchorX,
    y: snapToDevicePx(ay, dpr) - a.anchorY,
  };
}

export interface TowerPlacements {
  /** Committed towers — the tower sprite layer. */
  readonly committed: readonly SpritePlacement[];
  /** Queued-but-not-committed builds — the pending sprite layer, above the towers. */
  readonly pending: readonly SpritePlacement[];
}

/**
 * Every tower sprite this frame. A committed tower whose sell is pending is HIDDEN —
 * presented as already gone (`visibleTowers`); a buffed one shows its ✦ variant; a queued
 * build (`overlay.pendingAdds`) shows the translucent pending variant of ITS OWN mark, so a
 * slow tower queued while paused keeps its shape-distinct identity (Codex R1-7). Each sprite
 * is anchored at its 2×2 footprint's top-left cell.
 */
export function placeTowers(
  vm: RenderVM,
  o: Pick<RenderOverlay, 'pendingAdds' | 'pendingSells'>,
  projection: Projection,
  frames: ReadonlyMap<string, FrameAnchor>,
): TowerPlacements {
  const dpr = projection.dpr;
  const committed = visibleTowers(vm.towers, o.pendingSells).map((t) => {
    const p = projection.cellToPixel(t.col, t.row);
    return placeAt(
      frames,
      towerFrameKey(t.towerId, t.buffed ? 'buffed' : 'committed'),
      p.x,
      p.y,
      dpr,
    );
  });
  const pending = o.pendingAdds.map((t) => {
    const p = projection.cellToPixel(t.col, t.row);
    return placeAt(frames, towerFrameKey(t.towerId, 'pending'), p.x, p.y, dpr);
  });
  return { committed, pending };
}

/** One creep: its silhouette sprite, plus everything its live cues need. */
export interface CreepPlacement extends SpritePlacement, CreepCueInput {}

/**
 * Every creep silhouette this frame, in draw order (the order of `interpolated`, so a later
 * creep's body still covers an earlier one's, as before). The frame is keyed on the
 * creep's shape, its low-health tint and its boss size; the sprite is centred on the
 * creep's projected point, snapped to a whole device pixel, and that snapped centre is what
 * its health pip and status cues are drawn around.
 */
export function placeCreeps(
  interpolated: readonly Pick<
    CreepVM,
    | 'x'
    | 'y'
    | 'hpFrac'
    | 'creepId'
    | 'domain'
    | 'slowed'
    | 'poisoned'
    | 'stunned'
    | 'warded'
    | 'boss'
  >[],
  pal: Palette,
  projection: Projection,
  frames: ReadonlyMap<string, FrameAnchor>,
): CreepPlacement[] {
  const dpr = projection.dpr;
  return interpolated.map((c) => {
    const p = projection.fpToPixel(c.x, c.y);
    const cx = snapToDevicePx(p.x, dpr);
    const cy = snapToDevicePx(p.y, dpr);
    const frame = creepFrameKey(c.creepId, c.hpFrac, c.boss);
    const a = anchorOf(frames, frame);
    return {
      frame,
      x: cx - a.anchorX,
      y: cy - a.anchorY,
      cx,
      cy,
      r: creepRadius(projection.cellPx, c.boss),
      colour: creepFillColour(pal, isLowHp(c.hpFrac)),
      hpFrac: c.hpFrac,
      slowed: c.slowed,
      poisoned: c.poisoned,
      stunned: c.stunned,
      warded: c.warded,
      airborne: c.domain === 'air',
    };
  });
}
