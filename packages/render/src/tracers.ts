// tracers.ts — where each shot in flight is (Tracer, #32/P6): the render time a frame draws at,
// and each in-flight shot's lerped point. The single source of a shot's position: the shot
// plan (`shots.ts`, visual pass C2) draws each one there, in its tower's style. Pure; `scene.ts`
// and `board-frame.ts` only execute.

import type { RenderVM, TracerVM } from './types';
import { clamp01 } from './num';

/** A shot in flight, positioned at its current render-time point — all in fixed-point sim
 *  units. */
export interface PositionedTracer {
  /** Where the shot is now. */
  readonly x: number;
  readonly y: number;
  /** Where it left from — its tower's footprint centre — and where it is headed: its target's
   *  drawn point, or a blast's own destination. */
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  /** How far along its flight it is: 0 at launch, 1 on arrival. */
  readonly frac: number;
  /** The shot itself. */
  readonly tracer: TracerVM;
}

/**
 * The render "time" a frame is drawing at, in fractional ticks: `curVm` is POST-step,
 * so tracer (and creep) progress is interpolated from the PREVIOUS tick's base — using
 * `curVm.tick` directly would skip a tracer's first frame of travel. `prevVm === null`
 * (the very first frame of a run) falls back to `curVm.tick` (nothing to interpolate
 * from yet).
 */
export function renderTimeOf(prevVm: RenderVM | null, curVm: RenderVM, alpha: number): number {
  const base = prevVm !== null ? prevVm.tick : curVm.tick;
  return base + clamp01(alpha);
}

/**
 * Lerp each in-flight tracer from its fp-unit origin toward its aim point, at fraction
 * `clamp01((renderTime - launchTick) / (impactTick - launchTick))`. A non-positive
 * flight span (a forged/degenerate launch===impact tick) resolves to fraction 1
 * (already arrived) rather than dividing by zero.
 *
 * The aim point depends on `kind` (M2-S4a step 12): a `targeted` tracer aims at its
 * `targetId`'s point THIS FRAME in `targets` — where the creep is drawn (`creepAimPoints`:
 * since C2 a flyer's lifted body, not the true point under it) — and is DROPPED if that target
 * is no longer drawn (died or leaked mid-flight — no point to aim at, and drawing one anyway
 * would visibly point at nothing); a `blast` tracer aims at its OWN fixed `destX`/`destY` —
 * the fire-time predicted lead point the impact itself will land at — regardless of
 * whether the original target survived, and is therefore NEVER dropped.
 */
export function positionTracers(
  flights: readonly TracerVM[],
  targets: ReadonlyMap<number, { readonly x: number; readonly y: number }>,
  renderTime: number,
): PositionedTracer[] {
  const out: PositionedTracer[] = [];
  for (const f of flights) {
    let toX: number;
    let toY: number;
    if (f.kind === 'targeted') {
      const target = targets.get(f.targetId);
      if (target === undefined) continue;
      toX = target.x;
      toY = target.y;
    } else {
      toX = f.destX;
      toY = f.destY;
    }
    const span = f.impactTick - f.launchTick;
    const frac = span > 0 ? clamp01((renderTime - f.launchTick) / span) : 1;
    // An arrived shot is exactly at its aim point: the lerp's arithmetic can land an ulp away,
    // and a shot that has arrived sits on the body it struck.
    const arrived = frac === 1;
    out.push({
      x: arrived ? toX : f.originX + (toX - f.originX) * frac,
      y: arrived ? toY : f.originY + (toY - f.originY) * frac,
      fromX: f.originX,
      fromY: f.originY,
      toX,
      toY,
      frac,
      tracer: f,
    });
  }
  return out;
}
