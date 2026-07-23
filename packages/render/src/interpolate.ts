// interpolate.ts — blend two render snapshots for smooth motion between fixed 20 Hz
// ticks. Pure. Matches creeps BY ENTITY ID (the sim's SoA compacts rows as creeps
// die/leak, so index-based blending would smear identities). A creep only in the
// current snapshot (just spawned) is drawn at its current point; one only in the
// previous snapshot (died/leaked) is dropped. Towers/impacts are taken from `cur`.

import type { RenderVM, CreepVM } from './types';
import { clamp01 } from './num';

/**
 * Interpolated creeps at `alpha` between `prev` and `cur`. Each current creep is blended
 * from its previous-snapshot counterpart (same id) if present, else shown at its current
 * point. The returned list mirrors `cur`'s membership — nothing that has left the world
 * is resurrected.
 */
export function interpolateCreeps(prev: RenderVM | null, cur: RenderVM, alpha: number): CreepVM[] {
  const a = clamp01(alpha);
  const prevById = new Map<number, CreepVM>();
  if (prev !== null) for (const c of prev.creeps) prevById.set(c.id, c);

  const out: CreepVM[] = [];
  for (const c of cur.creeps) {
    const p = prevById.get(c.id);
    if (p === undefined) {
      out.push(c); // just spawned — no prior sample to blend from
    } else {
      out.push({
        id: c.id,
        x: p.x + (c.x - p.x) * a,
        y: p.y + (c.y - p.y) * a,
        hpFrac: c.hpFrac, // health snaps to current (no visual value in blending it)
      });
    }
  }
  return out;
}

/**
 * Impacts that RESOLVE on `cur.tick`, for drawing an impact-spark. Derived by
 * multiset-diffing prev vs cur `impacts[]` keyed by `(targetId, impactTick)` — `Impact`
 * has no id, and two towers can produce indistinguishable impacts. An impact present in
 * `prev` and absent (consumed) in `cur` resolved this tick; its target point comes from
 * `prev`'s creep of that `targetId`. If no prior target point exists (the creep had
 * already leaked), the spark is suppressed. Returns the spark points (pixel projection
 * is the scene's job).
 */
export function resolvedImpactPoints(
  prev: RenderVM | null,
  cur: RenderVM,
): { x: number; y: number }[] {
  if (prev === null) return [];
  // Fast path for the common no-combat tick: an impact can only RESOLVE if it was pending
  // in `prev`, so with no prev impacts there is nothing to diff — skip building the maps.
  if (prev.impacts.length === 0) return [];

  const key = (targetId: number, impactTick: number): string => `${targetId}:${impactTick}`;
  const curCounts = new Map<string, number>();
  for (const im of cur.impacts) {
    const k = key(im.targetId, im.impactTick);
    curCounts.set(k, (curCounts.get(k) ?? 0) + 1);
  }

  // First pass: which prev impacts actually RESOLVED (present in prev, consumed in cur).
  // Only build the per-creep position map if at least one did — the common combat tick
  // resolves nothing, so this avoids walking every creep for no sparks.
  const resolvedTargetIds: number[] = [];
  for (const im of prev.impacts) {
    const k = key(im.targetId, im.impactTick);
    const remaining = curCounts.get(k) ?? 0;
    if (remaining > 0) {
      curCounts.set(k, remaining - 1); // still pending — consume one and skip
      continue;
    }
    resolvedTargetIds.push(im.targetId); // resolved this tick
  }
  if (resolvedTargetIds.length === 0) return [];

  // Prefer the target's CURRENT position (a creep that survived the hit is at its cur-tick
  // point, so the flash lands ON it, not a tick behind); fall back to its previous point
  // only if it died/left this tick (absent from cur). Suppress if neither has it.
  const curPointById = new Map<number, { x: number; y: number }>();
  for (const c of cur.creeps) curPointById.set(c.id, { x: c.x, y: c.y });
  const prevPointById = new Map<number, { x: number; y: number }>();
  for (const c of prev.creeps) prevPointById.set(c.id, { x: c.x, y: c.y });

  const sparks: { x: number; y: number }[] = [];
  for (const targetId of resolvedTargetIds) {
    const pt = curPointById.get(targetId) ?? prevPointById.get(targetId);
    if (pt !== undefined) sparks.push(pt);
  }
  return sparks;
}
