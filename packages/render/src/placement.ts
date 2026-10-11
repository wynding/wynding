// placement.ts — which atlas frame each sprite shows, and where (V2, #181). Pure,
// Phaser-free, unit-tested: `board-frame.ts` hands these lists to the sprite pools
// (`sprite-pool.ts`), which only copy them onto sprites, so every decision a frame's picture
// depends on — which towers are hidden, which are pending, which stand on a plate and which
// on a pad, which heads wear the boost glow, how each head is turned and knocked back, how
// faded a scorch is, which look a creep wears, where its body and its shadow go, which creeps
// draw over which — is made here, where a test can see it.
//
// POSITIONS are world CSS px (the space every projection call returns) and are SNAPPED TO
// WHOLE DEVICE PIXELS: a sprite's top-left lands where `x × dpr` is an integer. The atlas
// bakes at the effective dpr with every frame anchor on a whole texel, so a snapped sprite
// puts each texel on exactly one pixel of the canvas's backing store — crisp, never resampled
// between two (`scene.ts` says how that store reaches the screen). Creeps carry the centre
// their cues are drawn around too (`drawCreepCues`): their body's, as drawn — for a flyer,
// lifted above the true position its shadow marks, which is the point the tracers converge on
// and the heads turn toward. The one sprite that leaves the grid is a tower's head while it is
// TURNED toward its target (visual pass T3): it turns about its footprint centre, and a turned
// sprite's texels fall between pixels whatever its position (`placeHead`).

import { FP_ONE } from '@wynding/engine';
import { visibleTowers, type CreepCueInput } from './board-draw';
import {
  creepFrameKeys,
  CreepLookSlots,
  groundFrameKey,
  headFrameKey,
  pendingFrameKey,
  RIM_RUNS_FRAME_KEY,
  SCORCH_FRAME_KEY,
  towerHasPlate,
} from './art-frames';
import { creepLiftPx, creepRadius } from './creep-art';
import type { CreepFamily } from './creep-paint';
import { snapToDevicePx } from './device-px';
import type { Projection } from './projection';
import { creepColour, type Palette } from './palette';
import type { CreepLookVM, CreepVM, RenderOverlay, RenderVM, TowerVM } from './types';

/** One sprite: the atlas frame it shows, where it goes (world CSS px), and its opacity — 1
 *  unless it says otherwise. `x`/`y` place the sprite's ORIGIN: its top-left corner, unless
 *  the placement moves the origin — only a turned head does (`placeTowers`), to turn about
 *  its footprint centre. */
export interface SpritePlacement {
  readonly frame: string;
  readonly x: number;
  readonly y: number;
  readonly alpha?: number;
  /** The sprite's origin, as fractions of its frame's width and height — the point `x`/`y`
   *  place and the one it turns about. 0 (the top-left) unless set. */
  readonly originX?: number;
  readonly originY?: number;
  /** How far the sprite is turned about its origin, radians clockwise. 0 unless set. */
  readonly rotation?: number;
}

/** What placement needs to know of a baked frame: where its anchor sits inside it, and its
 *  pivot — where its art's centre sits, as fractions of its size (`FrameSpec`). */
export interface FrameAnchor {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly pivotX: number;
  readonly pivotY: number;
}

/** How a committed tower's head is posed this frame (visual pass T3): turned `angle` radians
 *  clockwise from straight up about its footprint centre, and knocked `recoilPx` CSS px back
 *  along the way it faces. `tower-fire.ts`'s `headPose` says how each head is posed. */
export interface HeadPose {
  readonly angle: number;
  readonly recoilPx: number;
}

/** A head as it is drawn: pointing up, where it stands — every head before towers aimed, a
 *  head that does not aim, and every head under Reduce motion. */
export const HEAD_AT_REST: HeadPose = { angle: 0, recoilPx: 0 };

/** The atlas frame `key`'s anchor: a miss is a broken atlas, never a quiet gap. */
export function anchorOf(frames: ReadonlyMap<string, FrameAnchor>, key: string): FrameAnchor {
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
  /** The plate rim's straight runs over each POSED head — one an aiming tower has turned or
   *  knocked back (T3) — the rims layer, over every head. A posed head is resampled, or moved
   *  off the grid it was baked on, so its outline can spread into the rim's pixels, and the
   *  rim is the footprint's edge: it is painted again over it (`RIM_RUNS_FRAME_KEY`). A head
   *  at rest needs none — it is the picture R2 measured — so a head that never aims has none. */
  readonly rims: readonly SpritePlacement[];
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
 *
 * Each head is posed as `poseOf` says (T3; at rest when it is not given — `placeHead`), and a
 * posed one's plate rim is painted again over it (`TowerPlacements.rims`).
 */
export function placeTowers(
  vm: RenderVM,
  o: Pick<RenderOverlay, 'pendingAdds' | 'pendingSells'>,
  projection: Projection,
  frames: ReadonlyMap<string, FrameAnchor>,
  poseOf: (t: TowerVM) => HeadPose = () => HEAD_AT_REST,
): TowerPlacements {
  const dpr = projection.dpr;
  const plates: SpritePlacement[] = [];
  const heads: SpritePlacement[] = [];
  const rims: SpritePlacement[] = [];
  for (const t of visibleTowers(vm.towers, o.pendingSells)) {
    const p = projection.cellToPixel(t.col, t.row);
    plates.push(placeAt(frames, groundFrameKey(t.towerId), p.x, p.y, dpr));
    const pose = poseOf(t);
    heads.push(placeHead(frames, headFrameKey(t.towerId, t.buffed), p.x, p.y, projection, pose));
    if ((pose.angle !== 0 || pose.recoilPx !== 0) && towerHasPlate(t.towerId)) {
      rims.push(placeAt(frames, RIM_RUNS_FRAME_KEY, p.x, p.y, dpr));
    }
  }
  const pending = o.pendingAdds.map((t) => {
    const p = projection.cellToPixel(t.col, t.row);
    return placeAt(frames, pendingFrameKey(t.towerId), p.x, p.y, dpr);
  });
  return { plates, heads, rims, pending };
}

/**
 * A committed tower's head, posed (T3). Its recoil knocks it `pose.recoilPx` back along the
 * way it faces, `(sin a, −cos a)` for a turn of `a` from straight up, the knock moved onto
 * whole device pixels so a head that is not turned stays crisp as it recoils.
 *
 * A head NOT turned is placed exactly as the plate under it is — its frame's anchor on the
 * snapped footprint corner, its origin the frame's top-left — so at rest it is the picture
 * before towers aimed, to the bit. A TURNED head is placed by the point it turns about: its
 * origin is the frame's pivot, the art's centre (`FrameSpec.pivotX/Y`), which lies a cell
 * right of and below the frame's anchor, so it goes on the snapped corner plus a cell. Turning
 * a sprite resamples its texels, so a turned head is drawn a little softer than one at rest.
 */
function placeHead(
  frames: ReadonlyMap<string, FrameAnchor>,
  key: string,
  cornerX: number,
  cornerY: number,
  projection: Projection,
  pose: HeadPose,
): SpritePlacement {
  const { dpr, cellPx } = projection;
  const a = anchorOf(frames, key);
  const x = snapToDevicePx(cornerX, dpr);
  const y = snapToDevicePx(cornerY, dpr);
  const back = pose.recoilPx;
  const dx = back === 0 ? 0 : snapToDevicePx(-Math.sin(pose.angle) * back, dpr);
  const dy = back === 0 ? 0 : snapToDevicePx(Math.cos(pose.angle) * back, dpr);
  if (pose.angle === 0) return { frame: key, x: x - a.anchorX + dx, y: y - a.anchorY + dy };
  return {
    frame: key,
    x: x + cellPx + dx,
    y: y + cellPx + dy,
    originX: a.pivotX,
    originY: a.pivotY,
    rotation: pose.angle,
  };
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

/** One creep's BODY: its sprite, plus everything its live cues need, and the creep's entity id
 *  — what the frame keys where it is drawn by (`creepAimPoints`). */
export interface CreepPlacement extends SpritePlacement, CreepCueInput {
  readonly id: number;
}

/** Every creep sprite this frame. */
export interface CreepPlacements {
  /** Each creep's ground shadow — the creep-shadows layer, under every creep's body. */
  readonly shadows: readonly SpritePlacement[];
  /** Each creep's body, with what its cues need — the creeps layer: every creep on the
   *  ground, then every creep in the air. */
  readonly bodies: readonly CreepPlacement[];
  /** Each flashing creep's hit flash (C1) — the flashes layer, over every body: its body's
   *  silhouette in white, on its body to the texel, at the flash's opacity. */
  readonly flashes: readonly SpritePlacement[];
}

/** What `placeCreeps` reads of a creep: its entity id, its interpolated position and the state
 *  its frames and cues are keyed on. */
export type CreepPlacementInput = Pick<
  CreepVM,
  | 'id'
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

/** What placement needs of one creep look in one atlas: its frames and their anchors, and its
 *  family. */
interface CreepLookPlacement {
  readonly body: string;
  readonly bodyAnchor: FrameAnchor;
  readonly shadow: string;
  readonly shadowAnchor: FrameAnchor;
  readonly flash: string;
  readonly flashAnchor: FrameAnchor;
  readonly family: CreepFamily;
}

/** Per atlas, a creep id's looks in the slots its frame keys are kept in (`CreepLookSlots`),
 *  each filled the first time a frame asks for it and kept for as long as the atlas lives: a
 *  rebake brings a new frame map, and with it a new table. So a creep's look, its frame keys
 *  and their anchors are found once per look, never once per creep per frame (#181: R3's
 *  profile found a fifth of the board frame's JavaScript going to frame keys built and looked
 *  up afresh). */
const CREEP_TABLES = new WeakMap<
  ReadonlyMap<string, FrameAnchor>,
  CreepLookSlots<CreepLookPlacement>
>();

function creepLookPlacement(
  frames: ReadonlyMap<string, FrameAnchor>,
  creepId: string,
  boss: boolean,
  airborne: boolean,
): CreepLookPlacement {
  let table = CREEP_TABLES.get(frames);
  if (table === undefined) {
    table = new CreepLookSlots();
    CREEP_TABLES.set(frames, table);
  }
  const kept = table.get(creepId, boss, airborne);
  if (kept !== undefined) return kept;
  const keys = creepFrameKeys(creepId, boss, airborne);
  return table.set(creepId, boss, airborne, {
    body: keys.body,
    bodyAnchor: anchorOf(frames, keys.body),
    shadow: keys.shadow,
    shadowAnchor: anchorOf(frames, keys.shadow),
    flash: keys.flash,
    flashAnchor: anchorOf(frames, keys.flash),
    family: keys.look.family,
  });
}

/** The canvas's top edge, world CSS px: no flyer's body is drawn above it. */
const CANVAS_TOP = 0;

/** Where a creep of `look` standing at fixed-point `(x, y)` is drawn: its true position
 *  snapped to a whole device pixel (`sx`, `sy`) — where its sprites are anchored — how far its
 *  body is stepped down to stay on the canvas (`down`), and its body's radius. */
interface DrawnBody {
  readonly sx: number;
  readonly sy: number;
  readonly down: number;
  readonly r: number;
}

function drawnBody(
  x: number,
  y: number,
  look: CreepLookPlacement,
  airborne: boolean,
  projection: Projection,
): DrawnBody {
  const dpr = projection.dpr;
  const p = projection.fpToPixel(x, y);
  const sx = snapToDevicePx(p.x, dpr);
  const sy = snapToDevicePx(p.y, dpr);
  const top = sy - look.bodyAnchor.anchorY;
  // Whole device pixels (the body stays on the texel grid); the epsilon keeps a float's
  // error on an exact edge from costing a pixel.
  const down = airborne && top < CANVAS_TOP ? Math.ceil((CANVAS_TOP - top) * dpr - 1e-6) / dpr : 0;
  return { sx, sy, down, r: creepRadius(projection.cellPx, look.family) };
}

/**
 * The centre of the body a creep of `look` standing at fixed-point `(x, y)` is drawn with,
 * world CSS px — exactly the centre `placeCreeps` gives its body (`CreepPlacement.cx/cy`): its
 * true position snapped to a whole device pixel, and for a flyer lifted (and stepped down at the
 * canvas top) as its body is. Where an effect that belongs to a creep no longer drawn lands — a
 * kill's burst, a flyer's spark (visual pass C1/C2, #181).
 */
export function creepBodyCentre(
  x: number,
  y: number,
  look: CreepLookVM,
  projection: Projection,
  frames: ReadonlyMap<string, FrameAnchor>,
): { x: number; y: number } {
  const airborne = look.domain === 'air';
  const placed = creepLookPlacement(frames, look.creepId, look.boss, airborne);
  const b = drawnBody(x, y, placed, airborne, projection);
  return { x: b.sx, y: b.sy - creepLiftPx(b.r, airborne) + b.down };
}

/** A creep's drawn point as `creepAimPoints` keeps it from frame to frame: the point, in sim
 *  units, and the call that last wrote it. */
export interface KeptAimPoint {
  x: number;
  y: number;
  call: number;
}

/** How many times `creepAimPoints` has run: each call stamps the points it writes. */
let aimPointCalls = 0;

/**
 * Where each creep in `bodies` is drawn, by entity id, in fixed-point sim units: its body's
 * centre (`CreepPlacement.cx/cy`) taken back through the projection. What the heads aim at and
 * the shots land on (visual pass C2, #181) — so for a flyer its lifted body, where the player
 * sees it, not the true point under it — in the units the trackers and `positionTracers` work
 * in. A ground creep's is its true point snapped to a whole device pixel, where its body is.
 *
 * Written into `into` — a new map unless the caller keeps one across frames, as the board frame
 * does: each body's point is rewritten in place, and a creep no longer drawn loses its entry, so
 * the map holds exactly this frame's points and a frame makes no object per creep.
 */
export function creepAimPoints(
  bodies: readonly CreepPlacement[],
  projection: Projection,
  into: Map<number, KeptAimPoint> = new Map(),
): ReadonlyMap<number, { readonly x: number; readonly y: number }> {
  const call = ++aimPointCalls;
  const k = FP_ONE / projection.cellPx;
  let written = 0;
  for (const b of bodies) {
    const x = (b.cx - projection.originX) * k;
    const y = (b.cy - projection.originY) * k;
    const kept = into.get(b.id);
    if (kept === undefined) {
      into.set(b.id, { x, y, call });
      written += 1;
    } else {
      if (kept.call !== call) written += 1;
      kept.x = x;
      kept.y = y;
      kept.call = call;
    }
  }
  // An entry this call did not write is a creep an earlier frame drew and this one does not.
  if (into.size > written) {
    for (const [id, p] of into) if (p.call !== call) into.delete(id);
  }
  return into;
}

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
 *
 * A creep `flashOf` gives an opacity above 0 shows its hit flash (C1): its look's white
 * silhouette, anchored where its body is, so the two land on the same texels — ground creeps'
 * first, then flyers', in the order their bodies come.
 */
export function placeCreeps(
  interpolated: readonly CreepPlacementInput[],
  pal: Palette,
  projection: Projection,
  frames: ReadonlyMap<string, FrameAnchor>,
  flashOf: (id: number) => number = () => 0,
): CreepPlacements {
  const shadows: SpritePlacement[] = [];
  const ground: CreepPlacement[] = [];
  const air: CreepPlacement[] = [];
  const groundFlashes: SpritePlacement[] = [];
  const airFlashes: SpritePlacement[] = [];
  for (const c of interpolated) {
    const airborne = c.domain === 'air';
    const look = creepLookPlacement(frames, c.creepId, c.boss, airborne);
    const { sx: x, sy: y, down, r } = drawnBody(c.x, c.y, look, airborne, projection);
    shadows.push({
      frame: look.shadow,
      x: x - look.shadowAnchor.anchorX,
      y: y - look.shadowAnchor.anchorY,
    });
    (airborne ? air : ground).push({
      id: c.id,
      frame: look.body,
      x: x - look.bodyAnchor.anchorX,
      y: y - look.bodyAnchor.anchorY + down,
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
    const flash = flashOf(c.id);
    if (flash > 0) {
      (airborne ? airFlashes : groundFlashes).push({
        frame: look.flash,
        x: x - look.flashAnchor.anchorX,
        y: y - look.flashAnchor.anchorY + down,
        alpha: flash,
      });
    }
  }
  return {
    shadows,
    bodies: air.length === 0 ? ground : [...ground, ...air],
    flashes: airFlashes.length === 0 ? groundFlashes : [...groundFlashes, ...airFlashes],
  };
}
