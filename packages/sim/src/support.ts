// support.ts — the support-aura adjacency rule (M2-S8, sv12). Pure, deterministic,
// integer-only.
//
// A `support` tower (the shipped `beacon`) does not attack. It raises the DAMAGE
// AMOUNTS of the attacking towers whose 2×2 footprint shares at least one FULL CELL
// EDGE with its own (m2.md: corner-only touch is excluded). The buff enters play at
// the fire-time snapshot (`combat.ts`'s `snapshotEffects`), never as stored state:
// per the M2-S8 ruling, nothing here is written to the tower SoA, so a forged or
// restored `SimState` structurally cannot carry a stale buff — the same
// recompute-from-the-SoA discipline `tower.ts`'s module doc states for the blocked
// mask and the distance field.
//
// Unlike `domain.ts` (a true zero-import leaf) this module takes a `Grid` and reuses
// `forEachValidTower` — deliberately. Row validity has exactly ONE canonical rule
// (`tower.ts`'s "TOTALITY" note); re-deriving it locally is how two walks drift
// apart, so the dependency is the point rather than a cost.
//
// TWO PROPERTIES FALL OUT OF THE CONSTRUCTION rather than needing their own guards:
//  - EDGE-SHARE — stamping only the orthogonal neighbours of a beacon's four cells
//    IS "shares >= 1 full cell edge"; a diagonal neighbour is never stamped, so
//    corner-only touch can never buff.
//  - NO CHAINING — support towers never fire, so they never look the index up. A
//    beacon standing beside a beacon is stamped but never reads its own stamp.

import type { Grid } from './board';
import { forEachValidTower, type TowerValidityView } from './tower';

/** The no-buff multiplier (×1 in the 1/256 fixed-point the schema's `damageMulFp`
 *  uses). `auraMulFor` returns this for any cell no beacon reaches, so the buffed
 *  and unbuffed paths are the same arithmetic with different operands. */
export const SUPPORT_MUL_IDENTITY = 256;

/** The two fields the aura walk needs from a compiled tower — structural, not
 *  `ruleset.ts`'s `CompiledTower`, on `domain.ts`'s `CreepDomainLookup` and
 *  `tower.ts`'s `TowerCostLookup` precedent, so this module needs no import from
 *  `ruleset.ts`. `cost` is what `forEachValidTower` itself reads; `support` is
 *  present iff the bundle is a support bundle. */
export interface SupportLookup {
  readonly cost: number;
  readonly support?: { readonly damageMulFp: number };
}

/** The 2×2 footprint anchored top-left at `(col, row)` — the same deltas
 *  `tower.ts` uses, kept local so this module stays independent of that one's
 *  private constant. */
const FOOTPRINT_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/** The eight cells that share a full edge with a 2×2 footprint anchored at
 *  `(0, 0)` — its orthogonal ring, excluding the four diagonal corners
 *  ((-1,-1), (2,-1), (-1,2), (2,2)), which touch only at a point. This omission
 *  IS the corner-exclusion rule. */
const AURA_RING_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [-1, 1],
  [2, 0],
  [2, 1],
  [0, -1],
  [1, -1],
  [0, 2],
  [1, 2],
];

/**
 * The per-cell aura index for this board state: cell key `row * grid.width + col`
 * (exactly the keying `tower.ts` already uses for the blocked mask) → the STRONGEST
 * `damageMulFp` reaching that cell, or `null` when no support tower is placed.
 *
 * `max`, never a sum — "strongest single aura wins" (m2.md). Two beacons whose rings
 * overlap on one cell leave `max(a, b)` there, not `a + b`. `max` is also
 * order-independent, so nothing about the walk order is observable in the result;
 * the `Map` is only ever read by key.
 *
 * THE `null` SHORT-CIRCUIT IS A RAW PRE-SCAN of the `towerId` column, run BEFORE
 * `forEachValidTower` is invoked at all — not a "walk, then notice there were no
 * beacons". The walk allocates a fresh `Uint8Array(width · height)` for its overlap
 * bookkeeping on every call; on a 150-tower stress scene, in a combat phase that
 * runs every tick, "notice afterwards" would be a per-tick allocation for a feature
 * the board is not using. The pre-scan classifies nothing and allocates nothing —
 * an INVALID row whose `towerId` happens to name a beacon merely costs the walk it
 * would have skipped anyway, which is the safe direction to be wrong in.
 *
 * WHAT THE SHORT-CIRCUIT DOES NOT BUY, stated so it is not mistaken for more than it is:
 * once a beacon IS placed, `runCombat` pays this walk every tick on top of its own, so a
 * beacon board carries two `Uint8Array(width · height)` allocations plus this `Map` per
 * tick. The two walks are inherent — the index must be COMPLETE before any tower fires,
 * since a beacon later in the array must already have stamped — so this is an allocation
 * question, not a structural one. It is also currently UNMEASURED: the perf scenarios
 * (`packages/perf`) place no support tower, so the gate's `R` says nothing about this
 * path. Left as-is deliberately rather than optimized against no measurement.
 */
export function buildAuraIndex(
  grid: Grid,
  towers: TowerValidityView,
  towerById: Readonly<Partial<Record<string, SupportLookup>>>,
): Map<number, number> | null {
  let anySupport = false;
  for (let i = 0; i < towers.towerId.length; i++) {
    if (towerById[towers.towerId[i] as string]?.support !== undefined) {
      anySupport = true;
      break;
    }
  }
  if (!anySupport) return null;

  const index = new Map<number, number>();
  forEachValidTower(grid, towers, towerById, (i, _id, col, row) => {
    const def = towerById[towers.towerId[i] as string];
    const mulFp = def?.support?.damageMulFp;
    if (mulFp === undefined) return;
    for (const [dc, dr] of AURA_RING_DELTAS) {
      const c = col + dc;
      const r = row + dr;
      // Bounds-check even though the border ring is permanently blocked
      // (`board.ts`), so every VALID footprint already sits at least one cell in and
      // no ring cell can fall outside today. Without this, a future open-border board
      // would alias silently rather than fail: under `row * width + col`, the cell
      // `(-1, r)` keys to `r · width − 1`, which is exactly `(width − 1, r − 1)`.
      if (c < 0 || c >= grid.width || r < 0 || r >= grid.height) continue;
      const key = r * grid.width + c;
      const prior = index.get(key);
      if (prior === undefined || mulFp > prior) index.set(key, mulFp);
    }
  });
  return index;
}

/**
 * The multiplier reaching the tower whose 2×2 footprint is anchored at
 * `(col, row)` — the strongest over its four cells, or {@link SUPPORT_MUL_IDENTITY}
 * when no aura touches it (including the `index === null` no-beacons-placed case).
 */
export function auraMulFor(
  index: Map<number, number> | null,
  grid: Grid,
  col: number,
  row: number,
): number {
  if (index === null) return SUPPORT_MUL_IDENTITY;
  let best = SUPPORT_MUL_IDENTITY;
  for (const [dc, dr] of FOOTPRINT_DELTAS) {
    const c = col + dc;
    const r = row + dr;
    // The SAME bounds guard the stamp carries, and for the same reason — this is the
    // other half of the `row * width + col` keying, so leaving it off here would be
    // exactly the asymmetry that comment argues against. A read at `col = width - 1`
    // keys its `dc = 1` cells to column 0 of the NEXT row, and column 0 is genuinely
    // stamped by any beacon anchored at column 1, so the alias would return a real
    // multiplier for a tower nowhere near a beacon. Unreachable today (a valid anchor
    // caps at `width - 2` via `footprintBuildable`) — which is precisely why it needs
    // to be written down rather than relied upon.
    if (c < 0 || c >= grid.width || r < 0 || r >= grid.height) continue;
    const mulFp = index.get(r * grid.width + c);
    if (mulFp !== undefined && mulFp > best) best = mulFp;
  }
  return best;
}

/**
 * Apply a fixed-point damage multiplier: `floor(amount · mulFp / 256)`, integer-only
 * (the determinism contract — never float division). The identity multiplier
 * short-circuits so an unbuffed board's arithmetic is bit-for-bit what it was before
 * this story existed.
 *
 * OVERFLOW IS UNREACHABLE BY CONSTRUCTION, with the arithmetic written down rather than
 * asserted: `ruleset-schema.ts` validates `damage`/`damagePerTick` with `isPosInt`,
 * whose default ceiling is `GENERIC_MAX` = 1e6, and `capability.ts` caps
 * `maxSupportDamageMulFp` at 1024 — so the largest product any bundle that COMPILES can
 * produce is ~1.02e9, about seven orders of magnitude below `Number.MAX_SAFE_INTEGER`.
 * Two earlier versions of this function carried a saturation branch instead. Both were
 * wrong, in opposite directions (one returned ~256× less than its input past the
 * threshold, the other ~120× more), and both were justified by a claim that the schema
 * left `damage` unbounded — which, as the line numbers above show, it does not. Dead
 * code defended by a false premise is worse than either arm of it, so this states the
 * real bound and computes plainly. The `isSafeInteger` rail below is the totality rail
 * every lookup in this file carries, not an overflow guard.
 */
export function buffAmount(amount: number, mulFp: number): number {
  if (mulFp === SUPPORT_MUL_IDENTITY) return amount;
  if (!Number.isSafeInteger(amount) || amount <= 0) return amount;
  return Math.floor((amount * mulFp) / SUPPORT_MUL_IDENTITY);
}
