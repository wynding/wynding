// @wynding/sim — the headless deterministic simulation.
//
// A tick is a pure function of (previous state, inputs, board). No wall-clock, no
// floats, no Math.random — randomness comes only from the seeded RNG carried in
// the state. This is what lets the server re-simulate a replay and derive the
// same score the client saw. Kept renderer-agnostic: no Phaser, no DOM.

import { hashState } from '@wynding/engine';
import type { Cell, Seed } from '@wynding/types';
import { advanceCreep } from './movement';
import { assertConsistent, type BoardContext } from './context';
import type { Grid } from './board';
import { computeDistanceField, type DistanceField } from './pathfinding';
import {
  TOWER_COST,
  canPlaceTower,
  findValidTowerIndex,
  forEachValidTower,
  materializeTowerMask,
  type TowerArrays,
  refundFor,
} from './tower';

/** Simulation cadence: 20 Hz. Must match the render loop's tick duration. */
export const MS_PER_TICK = 50;

/** Behavior version stamped into replays; bump on any determinism-affecting change. */
export const SIM_VERSION = 3;

/** Creep travel budget per tick, in fixed-point units (256 units = 1 tile). */
const CREEP_SPEED_FP = 26;

/** Starting lives; a creep reaching the exit costs one. */
const STARTING_LIVES = 10;

/** Starting bounty (player currency). */
const STARTING_BOUNTY = 80;

/**
 * Structure-of-arrays creep storage — cheap to iterate and serialize. Movement is
 * cell-relative: a creep is at cell `(col,row)` and `edgeProgress` fixed-point units
 * into the edge toward its committed head cell `(headCol,headRow)`. The head is a
 * binding commitment only while mid-edge (`edgeProgress > 0`); at rest the columns
 * hold the canonical sentinel `head == (col,row)` and the real heading is derived
 * from the current field the moment the creep moves (see movement.ts). No Euclidean
 * world position yet — it is trivially derivable and deferred until combat/render
 * need it (Story 4/6).
 */
export interface CreepArrays {
  id: number[];
  hp: number[]; // carried, inert until combat (Story 4)
  col: number[]; // current cell column (the cell it is travelling FROM)
  row: number[]; // current cell row
  headCol: number[]; // committed next cell (sentinel: == col/row while at rest)
  headRow: number[];
  edgeProgress: number[]; // fixed-point units travelled from (col,row), in [0, edgeLen)
}

/** Complete simulation state for one match. Fully serializable. */
export interface SimState {
  tick: number;
  rngState: number;
  lives: number;
  bounty: number;
  nextEntityId: number; // shared entity-id space: creeps and towers
  creeps: CreepArrays;
  towers: TowerArrays;
}

/** Per-tick inputs (the replayable command log). */
export type SimInput =
  | { readonly kind: 'placeTower'; readonly anchor: Cell } // 2×2 top-left anchor
  | { readonly kind: 'sellTower'; readonly tower: number } // EntityId of the tower
  | { readonly kind: 'spawnCreep'; readonly hp: number }
  | { readonly kind: 'noop' };

// The effective distance field is a pure function of `(grid, tower mask)`, so it
// can be reused across ticks until the mask changes — a hit is byte-identical to
// a cold recompute, with NO process-history dependence (a miss and a hit yield the
// same field), so a cold re-simulation reproduces every field exactly. This is the
// "correctly-keyed (content-hash, local, validated) field cache" PLAN §Risks flagged
// for when the per-tick Dijkstra stops being trivial: a hostile replay can place one
// tower and then submit the full MAX_TICKS of empty ticks, so without reuse every one
// of those ticks re-ran a grid-wide Dijkstra (~10s per max-length replay on the sample
// board — a validate() cost-amplification vector). Keyed on the immutable `grid`
// (WeakMap ⇒ evicted with the match, never module-global process state) and validated
// by FULL mask equality (the mask is the field's sole determinant), so a stale or
// colliding entry can never be served — unlike the `mazeVersion` counter PLAN §1
// rejected, whose keys collided across states.
const fieldCache = new WeakMap<
  Grid,
  { readonly mask: Uint8Array; readonly field: DistanceField }
>();

function maskEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The exit-sourced distance field for `grid` under the current tower SoA, reusing
 * the cached field while the materialized mask is unchanged. Pure in its result:
 * the returned field depends only on `(grid, towers)`, never on cache state.
 */
function effectiveField(grid: Grid, towers: TowerArrays): DistanceField {
  const mask = materializeTowerMask(grid, towers); // O(towers), never throws
  const memo = fieldCache.get(grid);
  if (memo !== undefined && maskEquals(memo.mask, mask)) return memo.field;
  const field = computeDistanceField(grid, mask);
  fieldCache.set(grid, { mask, field });
  return field;
}

/**
 * Totality guard (ADR 0006 §4): a restored or forged state may be missing whole
 * SoA containers or individual columns — e.g. a pre-v3 snapshot carries no
 * `towers` object and no creep `headCol`/`headRow` columns. Coerce any absent
 * container or column to an empty array so every downstream read follows the
 * existing ragged-row drop/skip policy (an absent column makes each row invalid)
 * instead of dereferencing `undefined` and throwing. For a well-formed state
 * (every column already an array) this is a no-op, so genuine runs are unchanged.
 */
function coerceSoa(state: SimState): void {
  if (state.creeps == null || typeof state.creeps !== 'object') {
    state.creeps = { id: [], hp: [], col: [], row: [], headCol: [], headRow: [], edgeProgress: [] };
  }
  const c = state.creeps;
  if (!Array.isArray(c.id)) c.id = [];
  if (!Array.isArray(c.hp)) c.hp = [];
  if (!Array.isArray(c.col)) c.col = [];
  if (!Array.isArray(c.row)) c.row = [];
  if (!Array.isArray(c.headCol)) c.headCol = [];
  if (!Array.isArray(c.headRow)) c.headRow = [];
  if (!Array.isArray(c.edgeProgress)) c.edgeProgress = [];

  if (state.towers == null || typeof state.towers !== 'object') {
    state.towers = { id: [], col: [], row: [], spend: [] };
  }
  const t = state.towers;
  if (!Array.isArray(t.id)) t.id = [];
  if (!Array.isArray(t.col)) t.col = [];
  if (!Array.isArray(t.row)) t.row = [];
  if (!Array.isArray(t.spend)) t.spend = [];
}

/** Build a fresh match state for a given seed. */
export function createInitialState(seed: Seed | number): SimState {
  return {
    tick: 0,
    rngState: seed >>> 0,
    lives: STARTING_LIVES,
    bounty: STARTING_BOUNTY,
    nextEntityId: 1,
    creeps: { id: [], hp: [], col: [], row: [], headCol: [], headRow: [], edgeProgress: [] },
    towers: { id: [], col: [], row: [], spend: [] },
  };
}

/**
 * Advance the simulation by exactly one tick. Mutates and returns `state`.
 * Deterministic: identical (state, inputs, board) always yield identical output.
 * `board` is a static, caller-supplied input (see {@link BoardContext}); it is
 * validated once per context object, not stored in `state`.
 *
 * Two phases. The INPUT phase applies commands in array order, each re-validated
 * against the then-current state; anything malformed or illegal is a
 * deterministic no-op (ADR 0006 §4 — `step` is total, it never throws on bad
 * input). The MOVEMENT phase then derives the effective distance field ONCE, as
 * a pure local, from the post-input tower state — so every creep (including one
 * spawned this tick, in either order relative to a build) heads off the final
 * geometry, and a cold re-simulation reproduces the field byte-identically with
 * no cache or ambient state (PLAN §1; the `mazeVersion` module cache Codex R1
 * rejected stays rejected — the per-tick Dijkstra is trivial at 28×24).
 */
export function step(state: SimState, inputs: readonly SimInput[], board: BoardContext): SimState {
  assertConsistent(board); // memoized; rejects a forged context loudly, once
  coerceSoa(state); // totality: never dereference a missing SoA container/column
  const { grid } = board;
  const { entrance } = grid;

  // 1) INPUT PHASE — array order; each command re-validated against evolving state.
  for (const input of inputs as readonly unknown[]) {
    // Entry guard: a null/primitive element or unknown kind is a no-op before
    // anything reads deeper — totality for direct/corrupt callers (the replay
    // validator rejects these earlier on the submission path).
    if (input === null || typeof input !== 'object') continue;
    const kind = (input as { kind?: unknown }).kind;

    if (kind === 'spawnCreep') {
      const hp = (input as { hp?: unknown }).hp;
      if (!Number.isSafeInteger(hp) || (hp as number) < 1) continue; // malformed hp — no-op
      state.creeps.id.push(state.nextEntityId++);
      state.creeps.hp.push(hp as number);
      state.creeps.col.push(entrance.col);
      state.creeps.row.push(entrance.row);
      state.creeps.headCol.push(entrance.col); // sentinel — heading derived at movement
      state.creeps.headRow.push(entrance.row);
      state.creeps.edgeProgress.push(0);
    } else if (kind === 'placeTower') {
      const anchor = (input as { anchor?: unknown }).anchor;
      const towerMask = materializeTowerMask(grid, state.towers);
      if (!canPlaceTower(grid, towerMask, anchor, state.creeps, state.bounty)) continue;
      const cell = anchor as Cell; // structurally validated by canPlaceTower
      state.towers.id.push(state.nextEntityId++);
      state.towers.col.push(cell.col);
      state.towers.row.push(cell.row);
      state.towers.spend.push(TOWER_COST);
      state.bounty -= TOWER_COST;
    } else if (kind === 'sellTower') {
      const towerId = (input as { tower?: unknown }).tower;
      if (!Number.isSafeInteger(towerId)) continue; // malformed id — no-op
      if (!Number.isSafeInteger(state.bounty) || state.bounty < 0) continue; // corrupt bounty — no-op
      const index = findValidTowerIndex(grid, state.towers, towerId as number);
      if (index === -1) continue; // unknown, corrupt, or shadowed tower — no-op
      const refund = refundFor(state.towers.spend[index] as number); // spend === TOWER_COST for a valid row
      if (state.bounty > Number.MAX_SAFE_INTEGER - refund) continue; // refund would overflow — no-op
      state.bounty += refund;
      // Compact via the same canonical rule that materialized the mask, dropping
      // the sold row (invalid rows are dropped with it — they were never visible).
      const src = state.towers;
      const compacted: TowerArrays = { id: [], col: [], row: [], spend: [] };
      forEachValidTower(grid, src, (i, id, col, row) => {
        if (i === index) return;
        compacted.id.push(id);
        compacted.col.push(col);
        compacted.row.push(row);
        compacted.spend.push(src.spend[i] as number);
      });
      state.towers = compacted;
    }
    // 'noop' and any unknown kind: nothing.
  }

  // 2) DERIVE the effective field once for this tick from the final tower SoA — a
  //    pure function of (board.grid, state.towers). With no towers the effective
  //    field IS the immutable base field (PLAN §1), reproduced byte-for-byte by an
  //    empty mask, so reuse it directly. With towers, `effectiveField` recomputes
  //    only when the tower mask actually changed and otherwise reuses the cached
  //    field — byte-identical to a recompute, so cold re-simulation is unaffected.
  const field = state.towers.id.length === 0 ? board.field : effectiveField(grid, state.towers);

  // 3) MOVEMENT PHASE — advance each creep over the post-input field. A creep that
  //    reaches the exit leaks (costs a life); a corrupt row is dropped (no life
  //    lost). Rebuild the arrays to compact both removals.
  const src = state.creeps;
  const next: CreepArrays = {
    id: [],
    hp: [],
    col: [],
    row: [],
    headCol: [],
    headRow: [],
    edgeProgress: [],
  };
  for (let i = 0; i < src.id.length; i++) {
    const outcome = advanceCreep(
      field,
      src.id[i],
      src.hp[i],
      src.col[i],
      src.row[i],
      src.headCol[i],
      src.headRow[i],
      src.edgeProgress[i],
      CREEP_SPEED_FP,
    );
    if (outcome.kind === 'drop') continue;
    if (outcome.kind === 'leak') {
      state.lives -= 1; // no clamp; win/loss is Story 5
      continue;
    }
    next.id.push(src.id[i] as number);
    next.hp.push(src.hp[i] as number);
    next.col.push(outcome.col);
    next.row.push(outcome.row);
    next.headCol.push(outcome.headCol);
    next.headRow.push(outcome.headRow);
    next.edgeProgress.push(outcome.edgeProgress);
  }
  state.creeps = next;

  state.tick += 1;
  return state;
}

/** Deterministic content-hash of the world — the per-tick determinism checksum. */
export function hashSimState(state: SimState): string {
  return hashState(state);
}

// Board model (grid + pathfinding, M1 Story 1) — now the sim's board input, built
// once per match by `loadBoard` and threaded through `step`.
export { buildGrid, neighbors, GridError } from './board';
export type { CellClass, GridSpec, Grid } from './board';
export { computeDistanceField, isReachable, shortestPath } from './pathfinding';
export type { DistanceField } from './pathfinding';
export { loadBoard } from './context';
export type { BoardContext } from './context';
// Towers (M1 Story 3): state shape and the economy constants.
export { TOWER_COST, REFUND_NUM, REFUND_DEN } from './tower';
export type { TowerArrays } from './tower';
