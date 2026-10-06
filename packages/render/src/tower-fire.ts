// tower-fire.ts — a tower's shots, as the board shows them (visual pass T3, #181): which towers
// just fired, and how each one shows it. Pure and Phaser-free: `board-frame.ts` feeds the
// tracker once a frame on the render clock, poses each head with it (`headPose`, which
// `placement.ts` places) and draws the flashes and pulses it plans (`fireFeedbackPaintOps`)
// into the effects layer.
//
// DETECTION reads what the renderer is already handed, never the sim. Every shot's tracer
// starts at the footprint centre of the tower that fired it (`packages/sim/src/combat.ts`, the
// fire step: `originX/Y` is `(col + 1, row + 1)` cells), so a tracer seen for the first time,
// launched from a tower's footprint centre, is that tower firing. A mine going off is the one
// shot left out: `isDetonation` (`scorches.ts`) is the rule that recognises it, and its scorch
// is how the board shows it. Each shot counts once, and one first seen after its feedback would
// already be over shows nothing. "Seen already" needs no record of each shot: the controller
// lists every shot a sim tick fires together, from the first frame after that tick until each
// lands (`apps/web/src/controller.ts`; `controller.test.ts`'s "lists every shot a tick fires
// together" pins it), so a shot launched no later than the latest launch tick taken in has
// been taken in already — or was never listed and never will be. A shot whose whole flight
// falls between two frames (a two-tick flight, at 2× speed, on a frame slower than 50 ms) is
// never listed, and shows nothing: this is decoration, and the impact spark still lands. Nor
// does an aiming head's shot at a creep no longer drawn when the shot is first seen (a frame
// that caught up on several ticks): it has no tracer to draw and no bearing to turn onto, so it
// is taken in and shows no flash and no recoil.
//
// FEEDBACK, per the style frame's firing state: an aiming head (`towerAims`) is knocked back
// along its facing and flashes at its muzzle; a head that does not aim (slow, splash,
// frost-splash) pulses a pair of rings in its role colour. Each lasts a few ticks of RENDER time
// — a paused game freezes it part-way, 2× speed plays it twice as fast — and a tower's next
// shot restarts it. The shots first seen in a frame are handed back (`FireTracker.update`), so
// the aim tracker can turn each one's head onto its bearing (`tower-aim.ts`).
//
// PHOTOSENSITIVITY (ADR 0003, WCAG 2.3.1): a shot is one flash or one pulse, a single rise and
// fade, shown when its tracer is first seen: from its launch tick to just under
// `FIRE_FEEDBACK_TICKS` after it. A tower fires at most once per cadence, so four of its
// flashes take no less than three cadences less `FIRE_FEEDBACK_TICKS` of game time —
// `shortestFourFlashMs`. `apps/web/src/fire-rate.test.ts` requires that to be at least a
// second for every shipped tower at every game speed, so no second holds four flashes of one
// tower: the closest is antiair, every 15 ticks, at 2×, 1025 ms. A faster tower or a faster
// speed fails it.
//
// REDUCE MOTION draws none of it: no recoil, no flash and no pulse. A shot first seen under it
// is taken in and never shown, and one still playing when it is switched on is forgotten, so
// switching it off shows nothing stale: no recoil or flash along a head just reset to face up.
//
// COST: this runs every frame, over every tracer in flight. In steady state a frame allocates
// nothing: a tracer already taken in is passed over on its launch tick alone, only a new
// shot's tower is looked for, and the towers that just fired are kept and pruned in place.

import { MS_PER_TICK } from '@wynding/sim';
import { artUnit, towerAims } from './art-frames';
import { snapToDevicePx } from './device-px';
import { roleColour, type Palette } from './palette';
import { HEAD_AT_REST, type HeadPose } from './placement';
import type { Projection } from './projection';
import { isDetonation } from './scorches';
import { ART_FLASH, FIRE_PULSE_RINGS, MUZZLE_FLASH, RECOIL_DEPTH } from './tower-art';
import { footprintCentreFp, type AimTracker } from './tower-aim';
import { towerRoleFor } from './tower-paint';
import type { TowerVM, TracerVM } from './types';

/** How long a head's recoil takes to settle, in ticks of render time: 150 ms at 1×. */
export const RECOIL_TICKS = 3;
/** How long a muzzle flash takes to fade: 100 ms. */
export const FLASH_TICKS = 2;
/** How long a ring pulse takes to fade: 200 ms. */
export const PULSE_TICKS = 4;
/** The longest of them: how long a shot is remembered. */
export const FIRE_FEEDBACK_TICKS = Math.max(RECOIL_TICKS, FLASH_TICKS, PULSE_TICKS);

/** ADR 0003's photosensitivity bound (WCAG 2.3.1): no more than three flashes a second. */
export const MAX_FLASHES_PER_SECOND = 3;

/** How many times a second a tower that fires every `cadenceTicks` flashes with the game
 *  running at `gameSpeed`× — one flash per shot, and render time runs `gameSpeed` times as
 *  fast as the wall clock. */
export function flashesPerSecond(cadenceTicks: number, gameSpeed: number): number {
  return (gameSpeed * 1000) / (cadenceTicks * MS_PER_TICK);
}

/** The least wall-clock time, in ms, that four flashes of a tower firing every `cadenceTicks`
 *  can take with the game running at `gameSpeed`×. A shot shows when its tracer is first
 *  seen, from its launch tick to just under `FIRE_FEEDBACK_TICKS` after it: the first of four
 *  as late as that, the fourth the moment it launches, three cadences after the first. ADR
 *  0003's bound holds while this is at least a second — no second then holds four. */
export function shortestFourFlashMs(cadenceTicks: number, gameSpeed: number): number {
  return ((3 * cadenceTicks - FIRE_FEEDBACK_TICKS) * MS_PER_TICK) / gameSpeed;
}

/** The flash's smallest radius, CSS px — the floor the tracer dot and the spark keep too. */
const MIN_FLASH_PX = 2;
/** A pulse ring's thinnest stroke, CSS px. */
const MIN_RING_PX = 1;

/** 1 at `ticks` = 0, falling linearly to 0 at `span`; 0 outside [0, span). */
function fade(ticks: number, span: number): number {
  return ticks >= 0 && ticks < span ? 1 - ticks / span : 0;
}

/** How far back a head that fired `ticks` ago sits, as a fraction of `RECOIL_DEPTH`: all the
 *  way back the instant it fires, easing home over `RECOIL_TICKS` — quickly at first, then
 *  settling (a quadratic ease-out). */
export function recoilAt(ticks: number): number {
  const left = fade(ticks, RECOIL_TICKS);
  return left * left;
}

/** How bright a muzzle flash `ticks` old is: 1 at the shot, fading linearly to 0. */
export function flashAt(ticks: number): number {
  return fade(ticks, FLASH_TICKS);
}

/** How strong a ring pulse `ticks` old is: 1 at the shot, fading linearly to 0. */
export function pulseAt(ticks: number): number {
  return fade(ticks, PULSE_TICKS);
}

/** What the tracker reads each frame — all of it already on the renderer's per-frame path. */
export interface FireFrame {
  /** The shots in flight this frame (`RenderOverlay.tracers`). */
  readonly tracers: readonly TracerVM[];
  /** The towers the sim holds this frame (`curVm.towers`). */
  readonly towers: readonly TowerVM[];
  /** Where each creep is drawn this frame, by entity id — the map the tracers converge on and
   *  the heads turn toward (`AimFrame.creeps`). Only whether a shot's creep is in it is read. */
  readonly creeps: ReadonlyMap<number, { readonly x: number; readonly y: number }>;
  /** Render time, in fractional ticks (`renderTimeOf`). */
  readonly renderTick: number;
  readonly reducedMotion: boolean;
}

/** A shot first seen this frame: the tower that fired it, and its tracer. */
export interface ShotSeen {
  readonly tower: TowerVM;
  readonly tracer: TracerVM;
}

export interface FireTracker {
  /** Take in one frame: note every tower whose shot appears for the first time, and forget
   *  shots whose feedback is over and towers that are gone. Returns the shots first seen
   *  this frame, in tracer order — valid until the next update, which reuses the list. */
  update(frame: FireFrame): readonly ShotSeen[];
  /** Ticks of render time since tower `id` last fired, as of the last update — or null when
   *  it has not fired within `FIRE_FEEDBACK_TICKS`. */
  sinceFired(id: number): number | null;
  /** Forget everything — a new run starts with no shot in the air. */
  reset(): void;
}

/** The tower whose footprint centre is `(x, y)`, fixed-point sim units — where its shots
 *  start. Looked for only for a shot first seen, a few a frame at most. */
function towerAt(towers: readonly TowerVM[], x: number, y: number): TowerVM | undefined {
  for (const t of towers) {
    if (footprintCentreFp(t.col) === x && footprintCentreFp(t.row) === y) return t;
  }
  return undefined;
}

export function createFireTracker(): FireTracker {
  /** Each tower that fired recently, by entity id: the render tick its shot was first seen. */
  const fired = new Map<number, number>();
  /** The latest launch tick taken in: a shot launched no later has been (DETECTION, above). */
  let takenThrough = -Infinity;
  let now = -Infinity;
  /** The shots first seen by the latest update — one list, refilled each frame. */
  const shots: ShotSeen[] = [];
  return {
    update({ tracers, towers, creeps, renderTick, reducedMotion }) {
      // Render time never runs backwards within a run: a frame earlier than the last is a run
      // gone by, and nothing it noted stands.
      if (renderTick < now) {
        fired.clear();
        takenThrough = -Infinity;
      }
      now = renderTick;
      shots.length = 0;
      // Under Reduce motion nothing shows now, so nothing is kept to show stale on release.
      if (reducedMotion) fired.clear();
      let latest = takenThrough;
      for (const t of tracers) {
        // Taken in already — or a mine going off, which its scorch shows.
        if (t.launchTick <= takenThrough || isDetonation(t)) continue;
        if (t.launchTick > latest) latest = t.launchTick;
        if (renderTick - t.launchTick >= FIRE_FEEDBACK_TICKS) continue; // over before it showed
        if (reducedMotion) continue; // taken in, and never shown
        const tower = towerAt(towers, t.originX, t.originY);
        if (tower === undefined) continue; // no tower's shot — or one already sold
        // An aiming head's shot at a creep no longer drawn has no tracer and no bearing to turn
        // onto: it shows nothing, rather than a flash along wherever the head happens to face.
        if (t.kind === 'targeted' && !creeps.has(t.targetId) && towerAims(tower.towerId)) continue;
        fired.set(tower.id, renderTick);
        shots.push({ tower, tracer: t });
      }
      takenThrough = latest;
      if (fired.size > 0) forgetSettled(fired, towers, renderTick);
      return shots;
    },
    sinceFired(id) {
      const at = fired.get(id);
      return at === undefined ? null : now - at;
    },
    reset() {
      fired.clear();
      takenThrough = -Infinity;
      now = -Infinity;
      shots.length = 0;
    },
  };
}

/** Forget, in place, the shots whose feedback is over and the towers that are gone. A tower
 *  sold within its feedback is rare, so the standing ones are only counted, and the gone one
 *  found only when the count falls short. */
function forgetSettled(
  fired: Map<number, number>,
  towers: readonly TowerVM[],
  renderTick: number,
): void {
  for (const [id, at] of fired) if (renderTick - at >= FIRE_FEEDBACK_TICKS) fired.delete(id);
  if (fired.size === 0) return;
  let standing = 0;
  for (const t of towers) if (fired.has(t.id)) standing += 1;
  if (standing === fired.size) return;
  const ids = new Set(towers.map((t) => t.id));
  for (const id of fired.keys()) if (!ids.has(id)) fired.delete(id);
}

/** Tower `t`'s head pose this frame: turned to its aim angle (`tower-aim.ts`) and knocked back
 *  by its recoil if it has just fired, in CSS px at `cellPx`. At rest for a head that does
 *  not aim, and for every head under Reduce motion. */
export function headPose(
  t: TowerVM,
  aim: Pick<AimTracker, 'angleOf'>,
  fire: Pick<FireTracker, 'sinceFired'>,
  reducedMotion: boolean,
  cellPx: number,
): HeadPose {
  if (reducedMotion || !towerAims(t.towerId)) return HEAD_AT_REST;
  const angle = aim.angleOf(t.id);
  const since = fire.sinceFired(t.id);
  const recoilPx = since === null ? 0 : recoilAt(since) * RECOIL_DEPTH * artUnit(cellPx);
  return angle === 0 && recoilPx === 0 ? HEAD_AT_REST : { angle, recoilPx };
}

/** One piece of fire feedback: a filled disc (the muzzle flash), or a stroked ring (a pulse).
 *  Centres and sizes in CSS px. */
export type FireFeedbackOp =
  | {
      readonly kind: 'flash';
      readonly x: number;
      readonly y: number;
      readonly r: number;
      readonly colour: number;
      readonly alpha: number;
    }
  | {
      readonly kind: 'ring';
      readonly x: number;
      readonly y: number;
      readonly r: number;
      readonly width: number;
      readonly colour: number;
      readonly alpha: number;
    };

/**
 * Every muzzle flash and ring pulse to draw this frame, in tower order, about the footprint
 * centre each head turns on — its corner snapped as `placement.ts` snaps the sprite's, plus a
 * cell. An aiming tower that has just fired flashes `MUZZLE_FLASH.reach` out along the way its
 * head faces; one that does not aim pulses `FIRE_PULSE_RINGS` in its role colour. `towers` are
 * the committed towers the frame shows (`visibleTowers`). Empty under Reduce motion.
 */
export function fireFeedbackPaintOps(
  towers: readonly TowerVM[],
  aim: Pick<AimTracker, 'angleOf'>,
  fire: Pick<FireTracker, 'sinceFired'>,
  reducedMotion: boolean,
  pal: Palette,
  projection: Projection,
): FireFeedbackOp[] {
  if (reducedMotion) return [];
  const { cellPx, dpr } = projection;
  const unit = artUnit(cellPx);
  const out: FireFeedbackOp[] = [];
  for (const t of towers) {
    const since = fire.sinceFired(t.id);
    if (since === null) continue;
    const aims = towerAims(t.towerId);
    const k = aims ? flashAt(since) : pulseAt(since);
    if (k === 0) continue;
    const corner = projection.cellToPixel(t.col, t.row);
    const cx = snapToDevicePx(corner.x, dpr) + cellPx;
    const cy = snapToDevicePx(corner.y, dpr) + cellPx;
    if (aims) {
      const a = aim.angleOf(t.id);
      const reach = MUZZLE_FLASH.reach * unit;
      // It shrinks as it fades: `r` at the shot, `fadeR` as it goes.
      const r = MUZZLE_FLASH.fadeR + (MUZZLE_FLASH.r - MUZZLE_FLASH.fadeR) * k;
      out.push({
        kind: 'flash',
        x: cx + Math.sin(a) * reach,
        y: cy - Math.cos(a) * reach,
        r: Math.max(MIN_FLASH_PX, r * unit),
        colour: ART_FLASH,
        alpha: MUZZLE_FLASH.alpha * k,
      });
    } else {
      const colour = roleColour(pal, towerRoleFor(t.towerId));
      for (const ring of FIRE_PULSE_RINGS) {
        out.push({
          kind: 'ring',
          x: cx,
          y: cy,
          r: ring.r * unit,
          width: Math.max(MIN_RING_PX, ring.width * unit),
          colour,
          alpha: ring.alpha * k,
        });
      }
    }
  }
  return out;
}
