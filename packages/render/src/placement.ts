// placement.ts — which atlas frame each sprite shows, and where (V2, #181). Pure,
// Phaser-free, unit-tested: `board-frame.ts` hands these lists to the sprite pools
// (`sprite-pool.ts`), which only copy them onto sprites, so every decision a frame's picture
// depends on — which towers are hidden, which are pending, which stand on a plate and which
// on a pad, which heads wear the boost glow, how faded a scorch is, which look a creep wears,
// where its body and its shadow go, which creeps draw over which — is made here, where a test
// can see it.
//
// POSITIONS are world CSS px (the space every projection call returns) and are SNAPPED TO
// WHOLE DEVICE PIXELS: a sprite's top-left lands where `x × dpr` is an integer. The atlas
// bakes at the effective dpr with every frame anchor on a whole texel, so a snapped sprite
// puts each texel on exactly one pixel of the canvas's backing store — crisp, never resampled
// between two (`scene.ts` says how that store reaches the screen). Creeps carry the centre
// their cues are drawn around too (`drawCreepCues`): their body's, as drawn.

import { visibleTowers, type CreepCueInput } from './board-draw';
import {
  creepFrameKeys,
  groundFrameKey,
  headFrameKey,
  pendingFrameKey,
  SCORCH_FRAME_KEY,
} from './art-frames';
import { creepBaseRadius, creepLiftPx, CREEP_SIZE } from './creep-art';
import type { CreepFamily } from './creep-paint';
import { snapToDevicePx } from './device-px';
import type { Projection } from './projection';
import { creepColour, type Palette } from './palette';
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
  // the scorch, `creepFrameKeys` — is baked (`art-frames.ts`), for any id at all: a miss is a
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

/** One creep's BODY: its sprite, plus everything its live cues need. */
export interface CreepPlacement extends SpritePlacement, CreepCueInput {}

/** Every creep sprite this frame. */
export interface CreepPlacements {
  /** Each creep's ground shadow — the creep-shadows layer, under every creep's body. */
  readonly shadows: readonly SpritePlacement[];
  /** Each creep's body, with what its cues need — the creeps layer: every creep on the
   *  ground, then every creep in the air. */
  readonly bodies: readonly CreepPlacement[];
}

/** What `placeCreeps` reads of a creep: its interpolated position and the state its
 *  frames and cues are keyed on. */
export type CreepPlacementInput = Pick<
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
>;

/** What placement needs of one creep look in one atlas: its two frames and their anchors,
 *  and its family's size step. */
interface CreepLookPlacement {
  readonly body: string;
  readonly bodyAnchor: FrameAnchor;
  readonly shadow: string;
  readonly shadowAnchor: FrameAnchor;
  readonly family: CreepFamily;
  readonly size: number;
}

/** Per atlas, per creep id, four slots — [ground, air] × [not boss, boss] — each filled the
 *  first time a frame asks for it and kept for as long as the atlas lives: a rebake brings a
 *  new frame map, and with it a new table. So a creep's look, its frame keys and their
 *  anchors are found once per look, never once per creep per frame (#181: R3's profile found
 *  a fifth of the board frame's JavaScript going to frame keys built and looked up afresh). */
const CREEP_TABLES = new WeakMap<
  ReadonlyMap<string, FrameAnchor>,
  Map<string, (CreepLookPlacement | undefined)[]>
>();

function creepLookPlacement(
  frames: ReadonlyMap<string, FrameAnchor>,
  creepId: string,
  boss: boolean,
  airborne: boolean,
): CreepLookPlacement {
  let table = CREEP_TABLES.get(frames);
  if (table === undefined) {
    table = new Map();
    CREEP_TABLES.set(frames, table);
  }
  let slots = table.get(creepId);
  if (slots === undefined) {
    slots = [undefined, undefined, undefined, undefined];
    table.set(creepId, slots);
  }
  const slot = (boss ? 2 : 0) + (airborne ? 1 : 0);
  let look = slots[slot];
  if (look === undefined) {
    const keys = creepFrameKeys(creepId, boss, airborne);
    look = {
      body: keys.body,
      bodyAnchor: anchorOf(frames, keys.body),
      shadow: keys.shadow,
      shadowAnchor: anchorOf(frames, keys.shadow),
      family: keys.look.family,
      size: CREEP_SIZE[keys.look.family],
    };
    slots[slot] = look;
  }
  return look;
}

/** The canvas's top edge, world CSS px: no flyer's body is drawn above it. */
const CANVAS_TOP = 0;

/**
 * Every creep sprite this frame: each creep's SHADOW, for the creep-shadows layer, and its
 * BODY, for the creeps layer — both keyed on its look (shape, family and domain,
 * `creep-paint.ts`), both anchored at its true position — its projected point, snapped to a
 * whole device pixel — so the two land together, and a flyer's lift is the one its frame has
 * baked in.
 *
 * Bodies come every creep on the ground first, then every creep in the air, each group in the
 * order of `interpolated`, so a later creep still covers an earlier one of its own domain: a
 * flyer is above the ground, and draws over every creep walking it. Each body carries the
 * centre its cues are drawn around — the body's own, which for a flyer is its LIFTED body,
 * not its shadow (`creep-paint.ts`'s CUE-RADIUS ORDERING block) — and its family's radius and
 * hue.
 *
 * A flyer whose body would start above the canvas — on a board with an opening on its top
 * row, legal though no shipped board has one — is drawn down by just enough whole device
 * pixels that it does not, its cues with it: its wings are its airborne cue, and the
 * detached cue they replace flipped below its creep there for the same reason (Codex P2,
 * PR #87).
 */
export function placeCreeps(
  interpolated: readonly CreepPlacementInput[],
  pal: Palette,
  projection: Projection,
  frames: ReadonlyMap<string, FrameAnchor>,
): CreepPlacements {
  const dpr = projection.dpr;
  const base = creepBaseRadius(projection.cellPx);
  const shadows: SpritePlacement[] = [];
  const ground: CreepPlacement[] = [];
  const air: CreepPlacement[] = [];
  for (const c of interpolated) {
    const airborne = c.domain === 'air';
    const look = creepLookPlacement(frames, c.creepId, c.boss, airborne);
    const p = projection.fpToPixel(c.x, c.y);
    const x = snapToDevicePx(p.x, dpr);
    const y = snapToDevicePx(p.y, dpr);
    shadows.push({
      frame: look.shadow,
      x: x - look.shadowAnchor.anchorX,
      y: y - look.shadowAnchor.anchorY,
    });
    const r = base * look.size;
    const top = y - look.bodyAnchor.anchorY;
    // Whole device pixels (the body stays on the texel grid); the epsilon keeps a float's
    // error on an exact edge from costing a pixel.
    const down =
      airborne && top < CANVAS_TOP ? Math.ceil((CANVAS_TOP - top) * dpr - 1e-6) / dpr : 0;
    (airborne ? air : ground).push({
      frame: look.body,
      x: x - look.bodyAnchor.anchorX,
      y: top + down,
      cx: x,
      cy: y - creepLiftPx(r, airborne) + down,
      r,
      hue: creepColour(pal, look.family),
      hpFrac: c.hpFrac,
      slowed: c.slowed,
      poisoned: c.poisoned,
      stunned: c.stunned,
      warded: c.warded,
    });
  }
  return { shadows, bodies: air.length === 0 ? ground : [...ground, ...air] };
}
