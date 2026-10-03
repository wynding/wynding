// placement.ts — which atlas frame each sprite shows, and where (V2, #181). Pure,
// Phaser-free, unit-tested: `board-frame.ts` hands these lists to the sprite pools
// (`sprite-pool.ts`), which only copy them onto sprites, so every decision a frame's picture
// depends on — which towers are hidden, which are pending, which stand on a plate and which
// on a pad, which heads wear the boost glow, how faded a scorch is, which silhouette and size
// a creep gets, when it turns low-health — is made here, where a test can see it.
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
import {
  creepFrameKey,
  groundFrameKey,
  headFrameKey,
  pendingFrameKey,
  SCORCH_FRAME_KEY,
} from './art-frames';
import { snapToDevicePx } from './device-px';
import type { Projection } from './projection';
import type { Palette } from './palette';
import type { CreepVM, RenderOverlay, RenderVM } from './types';

/** One sprite: the atlas frame it shows, its top-left corner (world CSS px), and its
 *  opacity — 1 unless it says otherwise. */
export interface SpritePlacement {
  readonly frame: string;
  readonly x: number;
  readonly y: number;
  readonly alpha?: number;
}

/** What placement needs to know of a baked frame: where its anchor sits inside it. */
export interface FrameAnchor {
  readonly anchorX: number;
  readonly anchorY: number;
}

function anchorOf(frames: ReadonlyMap<string, FrameAnchor>, key: string): FrameAnchor {
  const frame = frames.get(key);
  // Every key placement can produce — `groundFrameKey`, `headFrameKey`, `pendingFrameKey`,
  // the scorch, `creepFrameKey` — is baked (`art-frames.ts`), for any id at all: a miss is a
  // broken atlas, and drawing nothing would hide it.
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
  /** What committed towers stand on — the plates layer: each one's plate, or for a
   *  plateless look (the mine) its floor-coloured pad, which keeps a neighbouring beacon's
   *  aura shell off its footprint as a plate does. One per head. */
  readonly plates: readonly SpritePlacement[];
  /** Committed towers' heads — the heads layer, over the plates. */
  readonly heads: readonly SpritePlacement[];
  /** Pending builds — the pending layer, above the towers: one translucent picture each. */
  readonly pending: readonly SpritePlacement[];
}

/**
 * Every tower sprite this frame. A committed tower whose sell is pending is HIDDEN —
 * presented as already gone (`visibleTowers`) — plate and head alike. A committed tower
 * shows its plate (or, plateless, its pad) and its head, the boosted head when a beacon
 * boosts it; a pending build (`overlay.pendingAdds`) shows the pending picture of ITS OWN
 * look, so a slow tower queued while paused keeps its shape-distinct identity (Codex R1-7).
 * Every sprite is anchored at its 2×2 footprint's top-left cell, so a tower's plate and
 * head land on the same snapped corner.
 */
export function placeTowers(
  vm: RenderVM,
  o: Pick<RenderOverlay, 'pendingAdds' | 'pendingSells'>,
  projection: Projection,
  frames: ReadonlyMap<string, FrameAnchor>,
): TowerPlacements {
  const dpr = projection.dpr;
  const plates: SpritePlacement[] = [];
  const heads: SpritePlacement[] = [];
  for (const t of visibleTowers(vm.towers, o.pendingSells)) {
    const p = projection.cellToPixel(t.col, t.row);
    plates.push(placeAt(frames, groundFrameKey(t.towerId), p.x, p.y, dpr));
    heads.push(placeAt(frames, headFrameKey(t.towerId, t.buffed), p.x, p.y, dpr));
  }
  const pending = o.pendingAdds.map((t) => {
    const p = projection.cellToPixel(t.col, t.row);
    return placeAt(frames, pendingFrameKey(t.towerId), p.x, p.y, dpr);
  });
  return { plates, heads, pending };
}

/** A scorch to show: where it is, in fixed-point sim units, and how opaque it is now. */
export interface ScorchPoint {
  readonly x: number;
  readonly y: number;
  readonly alpha: number;
}

/** Every scorch sprite this frame, centred on its point and carrying its fade. */
export function placeScorches(
  scorches: readonly ScorchPoint[],
  projection: Projection,
  frames: ReadonlyMap<string, FrameAnchor>,
): SpritePlacement[] {
  return scorches.map((s) => {
    const p = projection.fpToPixel(s.x, s.y);
    return { ...placeAt(frames, SCORCH_FRAME_KEY, p.x, p.y, projection.dpr), alpha: s.alpha };
  });
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
