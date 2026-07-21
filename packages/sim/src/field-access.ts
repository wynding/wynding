// field-access.ts — the canonical low-level reads over a DistanceField's row-major
// arrays: "is this cell blocked?" and "what is its exit-distance?".
//
// The descent rule (firstDescentNeighbor), shortest-path reconstruction, and the
// creep follower (advanceCreep) all read the field through these, so the OOB check
// and `r*width+c` indexing that back the single canonical descent rule have ONE
// definition and cannot quietly diverge across those sites. Plain functions over
// `field` rather than a closure-capturing factory, so the accessors add no
// allocation of their own in the per-tick movement loop; the `DistanceField` import
// is type-only (erased at compile time), keeping this a dependency-free leaf module
// with no runtime import cycle.
//
// (isReachable keeps its own read: its "in-bounds AND dist >= 0" test ignores the
// blocked mask, so it is deliberately not expressed through blockedAt.)

import type { DistanceField } from './pathfinding';

/** True if (c,r) is out of bounds or blocked in `field`'s effective mask. */
export function blockedAt(field: DistanceField, c: number, r: number): boolean {
  const { width, height } = field;
  if (c < 0 || r < 0 || c >= width || r >= height) return true; // OOB is blocked
  return (field.blockedMask[r * width + c] as number) !== 0;
}

/**
 * The exit-distance at (c,r) in the octile metric (`-1` = unreachable). Does NOT
 * bounds-check — callers pass in-bounds cells (guarded by {@link blockedAt} or an
 * explicit range check), matching the field's row-major layout.
 */
export function distAt(field: DistanceField, c: number, r: number): number {
  return field.dist[r * field.width + c] as number;
}
