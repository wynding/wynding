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
// is how the board shows it. Each shot counts once — keyed by its launch tick and origin while
// its tracer stays listed — and one first seen after its feedback would already be over shows
// nothing. A shot whose whole flight falls between two frames (a two-tick flight, at 2× speed,
// on a frame slower than 50 ms) is never listed, and shows nothing: this is decoration, and the
// impact spark still lands.
//
// FEEDBACK, per the style frame's firing state: an aiming head (`towerAims`) is knocked back
// along its facing and flashes at its muzzle; a head that does not aim (slow, splash,
// frost-splash) pulses a pair of rings in its role colour. Each lasts a few ticks of RENDER time
// — a paused game freezes it part-way, 2× speed plays it twice as fast — and a tower's next
// shot restarts it.
//
// PHOTOSENSITIVITY (ADR 0003, WCAG 2.3.1): a shot is one flash or one pulse, a single rise and
// fade, so a tower flashes exactly as often as it fires — `flashesPerSecond`. The fastest
// shipped tower, antiair, fires every 15 ticks: 1⅓ times a second at 1×, 2⅔ at 2×, under the
// bound of three. `apps/web/src/fire-rate.test.ts` pins that for every shipped tower at the
// game's fastest speed, so a faster tower fails it.
//
// REDUCE MOTION draws none of it: no recoil, no flash and no pulse.

import { MS_PER_TICK } from '@wynding/sim';
import { FP_ONE } from '@wynding/engine';
import { artUnit, towerAims } from './art-frames';
import { snapToDevicePx } from './device-px';
import { roleColour, type Palette } from './palette';
import { HEAD_AT_REST, type HeadPose } from './placement';
import type { Projection } from './projection';
import { isDetonation } from './scorches';
import { ART_FLASH, FIRE_PULSE_RINGS, MUZZLE_FLASH, RECOIL_DEPTH } from './tower-art';
import type { AimTracker } from './tower-aim';
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
  /** Render time, in fractional ticks (`renderTimeOf`). */
  readonly renderTick: number;
}

export interface FireTracker {
  /** Take in one frame: note every tower whose shot appears for the first time, and forget
   *  shots whose feedback is over and towers that are gone. */
  update(frame: FireFrame): void;
  /** Ticks of render time since tower `id` last fired, as of the last update — or null when
   *  it has not fired within `FIRE_FEEDBACK_TICKS`. */
  sinceFired(id: number): number | null;
  /** Forget everything — a new run starts with no shot in the air. */
  reset(): void;
}

const pointKey = (x: number, y: number): string => `${x},${y}`;

/** Every tower's id by its footprint centre, fixed-point sim units — where its shots start. */
function towersByCentre(towers: readonly TowerVM[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of towers) out.set(pointKey((t.col + 1) * FP_ONE, (t.row + 1) * FP_ONE), t.id);
  return out;
}

export function createFireTracker(): FireTracker {
  /** Each tower that fired recently, by entity id: the render tick its shot was first seen. */
  let fired = new Map<number, number>();
  /** Shots already taken in, while their tracers are still listed. */
  let seen = new Set<string>();
  let now = 0;
  return {
    update({ tracers, towers, renderTick }) {
      now = renderTick;
      const stillListed = new Set<string>();
      let byCentre: Map<string, number> | null = null; // built for the first new shot only
      for (const t of tracers) {
        if (isDetonation(t)) continue; // a mine going off: its scorch shows it
        const key = `${t.launchTick}@${pointKey(t.originX, t.originY)}`;
        stillListed.add(key);
        if (seen.has(key) || renderTick - t.launchTick >= FIRE_FEEDBACK_TICKS) continue;
        byCentre ??= towersByCentre(towers);
        const id = byCentre.get(pointKey(t.originX, t.originY));
        if (id !== undefined) fired.set(id, renderTick);
      }
      seen = stillListed;
      if (fired.size === 0) return;
      // Keep only the towers still standing whose feedback is still playing — render time
      // never runs backwards within a run, so a shot "seen" after now is from a run gone by.
      const next = new Map<number, number>();
      for (const t of towers) {
        const at = fired.get(t.id);
        if (at !== undefined && renderTick >= at && renderTick - at < FIRE_FEEDBACK_TICKS) {
          next.set(t.id, at);
        }
      }
      fired = next;
    },
    sinceFired(id) {
      const at = fired.get(id);
      return at === undefined ? null : now - at;
    },
    reset() {
      fired = new Map();
      seen = new Set();
      now = 0;
    },
  };
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
