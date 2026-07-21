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
// `TOWER_COST` (M1 has no upgrades), the 2×2 footprint is in-bounds and
// buildable-open, and it does not overlap an earlier valid row; on a duplicate id
// the first valid row wins. Any invalid row is skipped — invisible in the mask and
// not sellable — so a corrupt restored tower can never crash `step` or desync a
// re-simulation.

import type { Cell } from '@wynding/types';
import type { Grid } from './board';
import { computeDistanceField, isReachable } from './pathfinding';
import { occupiedCell } from './movement';

/**
 * Structure-of-arrays tower storage (mirrors `CreepArrays`). `(col,row)` is the
 * 2×2 anchor (top-left); the footprint is the anchor plus (1,0), (0,1), (1,1).
 * `spend` is the cumulative bounty invested — always `TOWER_COST` in M1; stored
 * now so refunds stay forward-compatible when upgrades land.
 */
export interface TowerArrays {
  id: number[];
  col: number[];
  row: number[];
  spend: number[];
}

/** Bounty cost of placing a tower. Sim scaffolding like STARTING_BOUNTY; migrating
 *  balance numbers into ruleset content (ADR 0007) is tracked as follow-up work. */
export const TOWER_COST = 5;
/** Sell refund ratio: floor(spend · REFUND_NUM / REFUND_DEN). */
export const REFUND_NUM = 3;
export const REFUND_DEN = 4;

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
      towers.spend[i] !== TOWER_COST
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
export function materializeTowerMask(grid: Grid, towers: TowerArrays): Uint8Array {
  const mask = new Uint8Array(grid.width * grid.height);
  forEachValidTower(grid, towers, (_i, _id, col, row) => {
    for (const [dc, dr] of FOOTPRINT_DELTAS) {
      mask[(row + dr) * grid.width + (col + dc)] = 1;
    }
  });
  return mask;
}

/** The index of the valid tower row with entity id `id`, or -1. Canonical rule:
 *  an invalid or shadowed-duplicate row is not sellable. */
export function findValidTowerIndex(grid: Grid, towers: TowerArrays, id: number): number {
  let found = -1;
  forEachValidTower(grid, towers, (i, rowId) => {
    if (found === -1 && rowId === id) found = i;
  });
  return found;
}

/**
 * Sell refund: floor(spend · 3/4), computed with quotient/remainder integer
 * arithmetic so no intermediate multiply can leave the safe-integer range even
 * for a large `spend`. For the only valid M1 spend (`TOWER_COST` = 5) this is 3.
 */
export function refundFor(spend: number): number {
  const q = Math.floor(spend / REFUND_DEN);
  const rem = spend % REFUND_DEN;
  return q * REFUND_NUM + Math.floor((rem * REFUND_NUM) / REFUND_DEN);
}

/**
 * The creep columns placement validation reads. Structural (not the barrel's
 * `CreepArrays`) so this module needs no import from the barrel — `CreepArrays`
 * is assignable to it.
 */
export interface CreepPlacementView {
  readonly id: number[];
  readonly col: number[];
  readonly row: number[];
  readonly headCol: number[];
  readonly headRow: number[];
  readonly edgeProgress: number[];
}

/**
 * The cell a creep occupies for placement, or `null` when its position is corrupt
 * (a non-safe-integer or out-of-bounds `(col,row)` — such a row is dropped or
 * re-routed by movement this same tick, so it neither occupies a footprint cell
 * nor constrains the invariant). Otherwise the single cell containing its point
 * (the never-build-on-a-creep unit, PRD 0001 §3): its `(col,row)` until it crosses
 * the step boundary, its head after — the same {@link occupiedCell} rule movement
 * uses, so the two agree on which cell is protected.
 */
function creepOccupiedCell(
  grid: Grid,
  creeps: CreepPlacementView,
  i: number,
): { readonly col: number; readonly row: number } | null {
  const ccol = creeps.col[i];
  const crow = creeps.row[i];
  if (!Number.isSafeInteger(ccol) || !Number.isSafeInteger(crow)) return null;
  const cc = ccol as number;
  const cr = crow as number;
  if (!grid.inBounds({ col: cc, row: cr })) return null;
  const occ = occupiedCell(cc, cr, creeps.headCol[i], creeps.headRow[i], creeps.edgeProgress[i]);
  // A far-side creep with a forged off-board head would yield an out-of-bounds
  // occupied cell; movement drops such a row this same tick, so it must not veto a
  // build (consistent with skipping position-corrupt rows above).
  return grid.inBounds(occ) ? occ : null;
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
 *   4. AFFORDABLE — `bounty` is a nonnegative safe integer ≥ `TOWER_COST`, so a
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
  if (!Number.isSafeInteger(bounty) || bounty < 0 || bounty < TOWER_COST) return false;

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
