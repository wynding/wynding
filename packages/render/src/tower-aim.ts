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
// REDUCE MOTION holds every head at angle 0 — the picture before towers aimed — and a head
// released from it sweeps from there to its target.

import { FP_ONE } from '@wynding/engine';
import { towerAims } from './art-frames';
import type { TowerVM } from './types';

/** The most a head turns in one tick of render time: 18°, so half a turn takes half a second
 *  at 1× speed. */
export const AIM_TURN_PER_TICK = Math.PI / 10;

const TAU = 2 * Math.PI;

/** `a` radians as the same direction in (−π, π]. */
export function wrapAngle(a: number): number {
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
}

export interface AimTracker {
  /** Take in one frame: turn every aiming head toward its target by as much as the render
   *  time since the last frame allows, and forget the towers that are gone. */
  update(frame: AimFrame): void;
  /** Tower `id`'s head angle as of the last update, radians clockwise from straight up: 0
   *  for a tower that does not aim, one not seen yet, and every tower under Reduce motion. */
  angleOf(id: number): number;
  /** Forget everything — a new run's towers start pointing up. */
  reset(): void;
}

export function createAimTracker(): AimTracker {
  /** Each aiming tower's head angle, by tower entity id — only those this frame drew. */
  let angles = new Map<number, number>();
  let lastTick: number | null = null;
  return {
    update({ towers, creeps, renderTick, reducedMotion }) {
      // Render time never runs backwards within a run; if it ever does, nothing turns.
      const elapsed = lastTick === null ? 0 : Math.max(0, renderTick - lastTick);
      lastTick = renderTick;
      const maxStep = AIM_TURN_PER_TICK * elapsed;
      const next = new Map<number, number>();
      for (const t of towers) {
        // Under Reduce motion nothing is kept, so every head reads 0 — and starts from 0.
        if (reducedMotion || !towerAims(t.towerId)) continue;
        const current = angles.get(t.id) ?? 0;
        const target = t.targetId === 0 ? undefined : creeps.get(t.targetId);
        const want =
          target === undefined
            ? null
            : aimAngle((t.col + 1) * FP_ONE, (t.row + 1) * FP_ONE, target.x, target.y);
        next.set(t.id, want === null ? current : stepToward(current, want, maxStep));
      }
      angles = next;
    },
    angleOf(id) {
      return angles.get(id) ?? 0;
    },
    reset() {
      angles = new Map();
      lastTick = null;
    },
  };
}
