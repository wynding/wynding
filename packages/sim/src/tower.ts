// tower.ts — tower state (structure-of-arrays), the derived tower mask, and the
// place/sell validation rules. Pure, deterministic, integer-only.
//
// Towers are walls: a 2×2 footprint of blocked cells layered over the base grid.
// The tower SoA lives in `SimState`; everything derived from it (the blocked mask,
// the effective distance field) is recomputed from the SoA on demand, so a cold
// serialize/restore reproduces identical behavior with no ambient/cache state.
//
// TOTALITY — one canonical iteration rule. Materialization, id lookup (sell), and
// compaction all classify rows with the SAME `forEachValidTower` walk: a row is
// valid iff all four columns are present safe integers, `spend` is exactly
// the ruleset tower `cost` (M1 has no upgrades), the 2×2 footprint is in-bounds and
// buildable-open, and it does not overlap an earlier valid row; on a duplicate id
// the first valid row wins. Any invalid row is skipped — invisible in the mask and
// not sellable — so a corrupt restored tower can never crash `step` or desync a
// re-simulation.

import type { Cell } from '@wynding/types';
import type { Grid } from './board';
import { computeDistanceField, isReachable } from './pathfinding';
import { deriveValidCreepPosition } from './movement';

/**
 * Structure-of-arrays tower storage (mirrors `CreepArrays`). `(col,row)` is the
 * 2×2 anchor (top-left); the footprint is the anchor plus (1,0), (0,1), (1,1).
 * `spend` is the cumulative bounty invested — always the tower `cost` in M1; stored
 * now so refunds stay forward-compatible when upgrades land. `targetId` is the
 * sticky locked creep (`0` = none) and `nextFireTick` the earliest tick this tower
 * may fire (`0` = no warm-up) — the Story-4 combat columns, carried by source row
 * through every construction/compaction path so a sell never resets a survivor.
 */
export interface TowerArrays {
  id: number[];
  col: number[];
  row: number[];
  spend: number[];
  targetId: number[];
  nextFireTick: number[];
}

/** The empty 6-column tower SoA — the single factory (mirrors `emptyCreeps`), so a
 *  future column is added in ONE place, never re-hand-rolled across call sites. */
export function emptyTowers(): TowerArrays {
  return { id: [], col: [], row: [], spend: [], targetId: [], nextFireTick: [] };
}

/** Coerce a stored combat column value to a safe integer, defaulting a
 *  missing/forged (ragged) entry to 0 so `number[]` columns never persist `null`. */
export function safeCombatColumn(value: number | undefined): number {
  return Number.isSafeInteger(value) ? (value as number) : 0;
}

/**
 * Sim-owned cap on the number of live valid towers, enforced in the `placeTower`
 * path (a build past the cap is a deterministic no-op). Sized far above any M1
 * board's physical tower capacity (~143 on the sample board), so it never bites
 * real play — it exists so "in-flight impacts are bounded" is a SIM invariant
 * (`in-flight ≤ live towers ≤ MAX_TOWERS`) independent of the replay layer, with NO
 * sim→replay import cycle. Replay's own command cap is a separate, larger budget.
 */
export const MAX_TOWERS = 1_000;

// Tower cost and the sell-refund ratio are NO LONGER hardcoded here — Story 5 moved
// them into the ruleset bundle (ADR 0007). The expected `cost` (a valid row's exact
// `spend`, since M1 has no upgrades) is threaded into the SoA-classification helpers,
// and `refundFor` takes the refund ratio; both come from `ruleset` at the call site.

/** The 2×2 footprint offsets relative to the anchor. */
const FOOTPRINT_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/** True iff the 2×2 footprint anchored at safe-integer (col,row) is fully
 *  in-bounds and every cell is buildable-open base terrain. */
function footprintBuildable(grid: Grid, col: number, row: number): boolean {
  for (const [dc, dr] of FOOTPRINT_DELTAS) {
    const cell: Cell = { col: col + dc, row: row + dr };
    if (!grid.inBounds(cell) || grid.classAt(cell) !== 'buildable-open') return false;
  }
  return true;
}

/**
 * Walk the VALID tower rows of `towers` in index order — the single canonical
 * classification every consumer (mask, sell lookup, compaction) shares, so they
 * can never disagree about which rows exist. See the module doc for the rule.
 */
export function forEachValidTower(
  grid: Grid,
  towers: TowerArrays,
  cost: number,
  visit: (index: number, id: number, col: number, row: number) => void,
): void {
  const seenIds = new Set<number>();
  const occupied = new Uint8Array(grid.width * grid.height);
  for (let i = 0; i < towers.id.length; i++) {
    const id = towers.id[i];
    const col = towers.col[i];
    const row = towers.row[i];
    if (
      !Number.isSafeInteger(id) ||
      !Number.isSafeInteger(col) ||
      !Number.isSafeInteger(row) ||
      towers.spend[i] !== cost
    ) {
      continue;
    }
    const c = col as number;
    const r = row as number;
    if (!footprintBuildable(grid, c, r)) continue;
    let overlaps = false;
    for (const [dc, dr] of FOOTPRINT_DELTAS) {
      if (occupied[(r + dr) * grid.width + (c + dc)] !== 0) overlaps = true;
    }
    if (overlaps) continue;
    if (seenIds.has(id as number)) continue; // duplicate id — first valid row won
    seenIds.add(id as number);
    for (const [dc, dr] of FOOTPRINT_DELTAS) {
      occupied[(r + dr) * grid.width + (c + dc)] = 1;
    }
    visit(i, id as number, c, r);
  }
}

/**
 * Rematerialize the row-major tower blocked mask from the SoA — a pure function
 * of `(grid, towers)`, recomputed rather than cached so it can never desync from
 * the state it derives from. Only valid rows contribute; every marked cell is
 * buildable-open, so the mask can never cover an opening (the exit stays legal
 * for `computeDistanceField`).
 */
export function materializeTowerMask(grid: Grid, towers: TowerArrays, cost: number): Uint8Array {
  const mask = new Uint8Array(grid.width * grid.height);
  forEachValidTower(grid, towers, cost, (_i, _id, col, row) => {
    for (const [dc, dr] of FOOTPRINT_DELTAS) {
      mask[(row + dr) * grid.width + (col + dc)] = 1;
    }
  });
  return mask;
}

/** The index of the valid tower row with entity id `id`, or -1. Canonical rule:
 *  an invalid or shadowed-duplicate row is not sellable. */
export function findValidTowerIndex(
  grid: Grid,
  towers: TowerArrays,
  id: number,
  cost: number,
): number {
  let found = -1;
  forEachValidTower(grid, towers, cost, (i, rowId) => {
    if (found === -1 && rowId === id) found = i;
  });
  return found;
}

/**
 * Sell refund: floor(spend · 3/4), computed with quotient/remainder integer
 * arithmetic so no intermediate multiply can leave the safe-integer range even
 * for a large `spend`. For the M1 tower cost (5) at the 3/4 M1 ratio this is 3.
 */
export function refundFor(spend: number, refundNum: number, refundDen: number): number {
  const q = Math.floor(spend / refundDen);
  const rem = spend % refundDen;
  return q * refundNum + Math.floor((rem * refundNum) / refundDen);
}

/** The number of live valid tower rows in `towers` (for the placement cap). */
export function countValidTowers(grid: Grid, towers: TowerArrays, cost: number): number {
  let count = 0;
  forEachValidTower(grid, towers, cost, () => {
    count++;
  });
  return count;
}

/**
 * The creep columns placement validation reads. Structural (not the barrel's
 * `CreepArrays`) so this module needs no import from the barrel — `CreepArrays`
 * is assignable to it.
 */
export interface CreepPlacementView {
  readonly id: number[];
  readonly fromX: number[];
  readonly fromY: number[];
  readonly headCol: number[];
  readonly headRow: number[];
  readonly progress: number[];
}

/**
 * The cell a creep occupies for placement, or `null` when its position is corrupt
 * (such a row is dropped or re-routed by movement this same tick, so it neither
 * occupies a footprint cell nor constrains the invariant). Otherwise the single
 * cell containing its derived point (the never-build-on-a-creep unit, PRD 0001 §3)
 * — via the same {@link deriveValidCreepPosition} seam movement and targeting use,
 * so all three agree on which cell is protected.
 */
function creepOccupiedCell(
  grid: Grid,
  creeps: CreepPlacementView,
  i: number,
): { readonly col: number; readonly row: number } | null {
  const geom = deriveValidCreepPosition(
    creeps.fromX[i],
    creeps.fromY[i],
    creeps.headCol[i],
    creeps.headRow[i],
    creeps.progress[i],
    grid,
  );
  return geom === null ? null : geom.occupancyCell;
}

/**
 * Full `placeTower` acceptance test (ADR 0006 §4 — anything short of full
 * acceptance is a deterministic no-op, never a throw):
 *
 *   1. STRUCTURAL — `anchor` is a `{col,row}` object with safe-integer coords
 *      (crash-safety backstop for direct/corrupt callers; a submitted replay with
 *      a malformed command is rejected earlier by the replay validator).
 *   2. BUILDABLE — the 2×2 footprint is in-bounds, every cell buildable-open base
 *      terrain AND free in the current tower mask (the mask check is what
 *      prevents tower overlap; `classAt` describes base terrain only).
 *   3. UNOCCUPIED — no footprint cell is the cell a live creep currently occupies
 *      (PRD 0001 §3: you may build *adjacent* to a creep, only never on the cell
 *      containing its point — the cell it is heading toward stays buildable until
 *      it crosses in; a creep on the near side of the boundary then re-routes off
 *      the new field rather than entering the wall).
 *   4. AFFORDABLE — `bounty` is a nonnegative safe integer ≥ the tower `cost`, so a
 *      corrupt restored bounty can never flow through the spend arithmetic.
 *   5. MAZE INVARIANT — in the candidate field (current mask + footprint) the exit
 *      remains reachable from the entrance and from every live creep's occupied
 *      cell (PRD 0001 §1), so no build can strand a creep.
 *
 * The candidate field is validation-scoped and discarded; `step` derives the
 * post-input field once, separately, for movement.
 */
export function canPlaceTower(
  grid: Grid,
  towerMask: Uint8Array,
  anchor: unknown,
  creeps: CreepPlacementView,
  bounty: number,
  cost: number,
): boolean {
  // 1) structural
  if (anchor === null || typeof anchor !== 'object') return false;
  const { col, row } = anchor as { col?: unknown; row?: unknown };
  if (!Number.isSafeInteger(col) || !Number.isSafeInteger(row)) return false;
  const c = col as number;
  const r = row as number;

  // 2) buildable + unmasked
  if (!footprintBuildable(grid, c, r)) return false;
  for (const [dc, dr] of FOOTPRINT_DELTAS) {
    if (towerMask[(r + dr) * grid.width + (c + dc)] !== 0) return false;
  }

  // 3) unoccupied — the footprint may not cover any creep's occupied cell.
  const inFootprint = (cc: number, rr: number): boolean =>
    cc >= c && cc <= c + 1 && rr >= r && rr <= r + 1;
  for (let i = 0; i < creeps.id.length; i++) {
    const occ = creepOccupiedCell(grid, creeps, i);
    if (occ !== null && inFootprint(occ.col, occ.row)) return false;
  }

  // 4) affordable
  if (!Number.isSafeInteger(bounty) || bounty < 0 || bounty < cost) return false;

  // 5) maze invariant on the candidate field
  const candidateMask = new Uint8Array(towerMask);
  for (const [dc, dr] of FOOTPRINT_DELTAS) {
    candidateMask[(r + dr) * grid.width + (c + dc)] = 1;
  }
  const candidate = computeDistanceField(grid, candidateMask);
  if (!isReachable(candidate, grid.entrance)) return false;
  for (let i = 0; i < creeps.id.length; i++) {
    const occ = creepOccupiedCell(grid, creeps, i);
    if (occ !== null && !isReachable(candidate, occ)) return false;
  }
  return true;
}
