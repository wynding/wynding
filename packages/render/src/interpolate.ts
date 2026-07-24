// interpolate.ts — blend two render snapshots for smooth motion between fixed 20 Hz
// ticks. Pure. Matches creeps BY ENTITY ID (the sim's SoA compacts rows as creeps
// die/leak, so index-based blending would smear identities). A creep only in the
// current snapshot (just spawned) is drawn at its current point; one only in the
// previous snapshot (died/leaked) is dropped. Towers are taken from `cur`.

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
