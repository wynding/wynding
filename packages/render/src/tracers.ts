// tracers.ts — pure Tracer (in-flight shot) FX helpers, #32/P6. Two composed seams (the
// `board-cells.ts` pattern): `positionTracers` computes each tracer's lerped point,
// `tracerPaintOps` turns positioned tracers into an ordered draw plan. `scene.ts` is a
// thin executor of the plan (coverage-excluded); all testable logic lives here.

import type { RenderVM, TracerVM } from './types';
import type { Palette } from './palette';
import { clamp01 } from './num';

/** A tracer positioned at its current render-time point. */
export interface PositionedTracer {
  readonly x: number;
  readonly y: number;
}

/** A tracer's paint instruction: a small bright dot at `(x,y)` in `colour`. */
export interface TracerPaintOp {
  readonly x: number;
  readonly y: number;
  readonly colour: number;
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
 * Lerp each in-flight tracer from its fp-unit origin to its target's CURRENT
 * interpolated point, at fraction `clamp01((renderTime - launchTick) / (impactTick -
 * launchTick))`. A tracer whose target is no longer drawn (died or leaked mid-flight)
 * is DROPPED — no target point to aim at, and drawing one anyway would visibly point
 * at nothing. A non-positive flight span (a forged/degenerate launch===impact tick)
 * resolves to fraction 1 (already arrived) rather than dividing by zero.
 */
export function positionTracers(
  flights: readonly TracerVM[],
  interpolatedTargets: ReadonlyMap<number, { readonly x: number; readonly y: number }>,
  renderTime: number,
): PositionedTracer[] {
  const out: PositionedTracer[] = [];
  for (const f of flights) {
    const target = interpolatedTargets.get(f.targetId);
    if (target === undefined) continue;
    const span = f.impactTick - f.launchTick;
    const frac = span > 0 ? clamp01((renderTime - f.launchTick) / span) : 1;
    out.push({
      x: f.originX + (target.x - f.originX) * frac,
      y: f.originY + (target.y - f.originY) * frac,
    });
  }
  return out;
}

/**
 * Turn positioned tracers into an ordered draw plan: a small bright dot in the firing
 * tower's cue colour (`pal.tower`) — decorative only, per docs/CONTEXT.md's "Tracer"
 * entry, never the carrier of a hit/miss outcome (the impact spark + HP pips are).
 * Reduced motion (WCAG 2.3.3 / GAG §2) omits tracers entirely — an EMPTY plan, the
 * same posture already ratified for the impact spark.
 */
export function tracerPaintOps(
  positioned: readonly PositionedTracer[],
  reducedMotion: boolean,
  palette: Palette,
): readonly TracerPaintOp[] {
  if (reducedMotion) return [];
  return positioned.map((p) => ({ x: p.x, y: p.y, colour: palette.tower }));
}
