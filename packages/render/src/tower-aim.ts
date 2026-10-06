// tower-aim.ts — where each tower's head points (visual pass T3, #181). Pure and Phaser-free:
// `board-frame.ts` feeds the tracker once a frame on the render clock, and each head's sprite
// is turned to the angle it reads back (`placement.ts`).
//
// WHAT A HEAD AIMS AT is the sim's own target lock, read and never decided here:
// `TowerVM.targetId` (the sim's `towers.targetId` column, 0 for none) names the creep, and the
// head turns toward where that creep is DRAWN this frame — its interpolated point, from the
// same per-frame map the tracers converge on. Only the heads drawn to aim turn
// (`towerAims`: basic, venom, stun, antiair); the rest never do.
//
// HOW IT TURNS: toward that point along the shorter arc, never faster than
// `AIM_TURN_PER_TICK` per tick of render time, so a head sweeps onto a new target rather than
// snapping to it, and keeps up with the one it is tracking: the fastest shipped creep (44
// fixed-point units a tick), walking the cell beside a footprint, turns a head at about a
// third of that rate. Only a flyer crossing right over its tower outruns it, and the head
// catches up a moment later. With no target — none in range,
// or one no longer drawn — a head holds the angle it last had: it idles. A tower the tracker
// has not seen starts at angle 0, pointing up, as its head is drawn. Turning runs on render
// time: a paused game holds every head still, and 2× speed turns them twice as fast, in step
// with the creeps they follow.
//
// A SHOT is the one exception to the bounded turn. The sim fires on the tick a tower locks
// on, while its head may still be sweeping toward the creep, so the moment a shot is first
// seen (`tower-fire.ts`) its head is turned onto that shot's bearing: toward where the shot's
// target is drawn this frame, or toward where a blast will land. The barrel, the muzzle flash,
// the recoil and the tracer then agree, and tracking resumes at the bounded rate from there.
// A shot whose target is no longer drawn turns nothing.
//
// REDUCE MOTION holds every head at angle 0 — the picture before towers aimed — and a head
// released from it sweeps from there to its target.
//
// COST: this runs every frame for every tower, so each head's state is kept and updated in
// place — a frame allocates nothing for the heads it already knows — and a frame whose render
// time has not moved (a paused game) turns nothing: it still walks every tower to keep it
// marked as seen, and skips only the angle maths.

import { FP_ONE } from '@wynding/engine';
import { towerAims } from './art-frames';
import type { TowerVM, TracerVM } from './types';

/** The most a head turns in one tick of render time: 18°, so half a turn takes half a second
 *  at 1× speed. */
export const AIM_TURN_PER_TICK = Math.PI / 10;

const TAU = 2 * Math.PI;

/** `a` radians as the same direction in (−π, π]. */
export function wrapAngle(a: number): number {
  // Already in range: nearly every call (every angle the tracker keeps is), and the same
  // number the remainder below would give — without the floating-point remainder per head
  // per frame.
  if (a > -Math.PI && a <= Math.PI) return a;
  const r = a % TAU; // (−2π, 2π), with `a`'s sign
  if (r <= -Math.PI) return r + TAU;
  if (r > Math.PI) return r - TAU;
  return r;
}

/** The head angle that faces `(toX, toY)` from `(fromX, fromY)`: radians CLOCKWISE from
 *  straight up (y grows downward), in (−π, π] — the turn a head drawn pointing up takes to
 *  face that way. Null when the two points coincide, where there is no way to face. */
export function aimAngle(fromX: number, fromY: number, toX: number, toY: number): number | null {
  const dx = toX - fromX;
  const dy = toY - fromY;
  if (dx === 0 && dy === 0) return null;
  return wrapAngle(Math.atan2(dx, -dy));
}

/** One step from `current` toward `target` along the shorter arc, turning at most `maxStep`
 *  radians: `target` itself (wrapped) once it is within reach, so a tracked creep is faced
 *  exactly. A target dead opposite is reached turning clockwise. */
export function stepToward(current: number, target: number, maxStep: number): number {
  const diff = wrapAngle(target - current);
  if (Math.abs(diff) <= maxStep) return wrapAngle(target);
  return wrapAngle(current + Math.sign(diff) * maxStep);
}

/** A shot first seen this frame (`tower-fire.ts`'s `FireTracker.update`): the tower that
 *  fired it and its tracer. */
export interface AimShot {
  readonly tower: TowerVM;
  readonly tracer: TracerVM;
}

/** What the tracker reads each frame — all of it already on the renderer's per-frame path. */
export interface AimFrame {
  /** The towers the sim holds this frame (`curVm.towers`). */
  readonly towers: readonly TowerVM[];
  /** Where each creep is drawn this frame, by entity id, in fixed-point sim units — the
   *  interpolated points (`interpolateCreeps`), the map the tracers converge on. */
  readonly creeps: ReadonlyMap<number, { readonly x: number; readonly y: number }>;
  /** Render time, in fractional ticks (`renderTimeOf`). */
  readonly renderTick: number;
  readonly reducedMotion: boolean;
  /** The shots first seen this frame: each turns its tower's head onto its bearing. None
   *  unless given. */
  readonly shots?: readonly AimShot[];
}

export interface AimTracker {
  /** Take in one frame: turn every aiming head toward its target by as much as the render
   *  time since the last frame allows, turn each head that just fired onto its shot's
   *  bearing, and forget the towers that are gone. */
  update(frame: AimFrame): void;
  /** Tower `id`'s head angle as of the last update, radians clockwise from straight up: 0
   *  for a tower that does not aim, one not seen yet, and every tower under Reduce motion. */
  angleOf(id: number): number;
  /** Forget everything — a new run's towers start pointing up. */
  reset(): void;
}

/** One aiming head, kept across frames and updated in place. */
interface Head {
  /** Where it points: radians clockwise from straight up. */
  angle: number;
  /** The last update that saw its tower — a head not seen by the latest one is gone. */
  seen: number;
}

/** A tower's footprint centre along one axis, fixed-point sim units, from its `col` or `row`:
 *  where the sim's fire step starts its shots (`combat.ts`). Aiming turns a head about it, and
 *  `tower-fire.ts` finds a shot's tower by it, so all three must meet the same point. */
export function footprintCentreFp(cell: number): number {
  return (cell + 1) * FP_ONE;
}

/** The bearing of `shot` from its tower's footprint centre: toward where its target is drawn,
 *  or where a blast will land. Null when its target is no longer drawn, or sits on the centre. */
function shotBearing(shot: AimShot, creeps: AimFrame['creeps']): number | null {
  const { tower, tracer } = shot;
  const cx = footprintCentreFp(tower.col);
  const cy = footprintCentreFp(tower.row);
  if (tracer.kind === 'blast') return aimAngle(cx, cy, tracer.destX, tracer.destY);
  const target = creeps.get(tracer.targetId);
  return target === undefined ? null : aimAngle(cx, cy, target.x, target.y);
}

export function createAimTracker(): AimTracker {
  /** Each aiming tower's head, by tower entity id — those the latest update saw. */
  const heads = new Map<number, Head>();
  let lastTick: number | null = null;
  let updates = 0;
  return {
    update({ towers, creeps, renderTick, reducedMotion, shots }) {
      // Render time never runs backwards within a run; if it ever does, nothing turns.
      const elapsed = lastTick === null ? 0 : Math.max(0, renderTick - lastTick);
      lastTick = renderTick;
      // Under Reduce motion nothing is kept, so every head reads 0 — and starts from 0.
      if (reducedMotion) {
        heads.clear();
        return;
      }
      const maxStep = AIM_TURN_PER_TICK * elapsed;
      updates += 1;
      let seen = 0;
      for (const t of towers) {
        if (!towerAims(t.towerId)) continue;
        let head = heads.get(t.id);
        if (head === undefined) {
          head = { angle: 0, seen: 0 };
          heads.set(t.id, head);
        }
        head.seen = updates;
        seen += 1;
        // With no render time gone by, no head turns: skip the arithmetic.
        if (maxStep === 0 || t.targetId === 0) continue;
        const target = creeps.get(t.targetId);
        if (target === undefined) continue;
        const want = aimAngle(
          footprintCentreFp(t.col),
          footprintCentreFp(t.row),
          target.x,
          target.y,
        );
        if (want !== null) head.angle = stepToward(head.angle, want, maxStep);
      }
      // Forget the towers that are gone — only looked for when some are.
      if (seen < heads.size) {
        for (const [id, head] of heads) if (head.seen !== updates) heads.delete(id);
      }
      // Each shot first seen turns its head onto its bearing at once.
      if (shots !== undefined) {
        for (const shot of shots) {
          const head = heads.get(shot.tower.id); // none for a head that does not aim
          if (head === undefined) continue;
          const bearing = shotBearing(shot, creeps);
          if (bearing !== null) head.angle = bearing;
        }
      }
    },
    angleOf(id) {
      return heads.get(id)?.angle ?? 0;
    },
    reset() {
      heads.clear();
      lastTick = null;
    },
  };
}
