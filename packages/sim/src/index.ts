// @wynding/sim — the headless deterministic simulation.
//
// A tick is a pure function of (previous state, inputs, board). No wall-clock, no
// floats, no Math.random — randomness comes only from the seeded RNG carried in
// the state. This is what lets the server re-simulate a replay and derive the
// same score the client saw. Kept renderer-agnostic: no Phaser, no DOM.

import { hashState } from '@wynding/engine';
import type { Cell, Seed } from '@wynding/types';
import { advanceCreep, cellCenterX, cellCenterY } from './movement';
import { runCombat, emptyCreeps, type Impact } from './combat';
import { assertConsistent, type BoardContext } from './context';
import type { Grid } from './board';
import { computeDistanceField, type DistanceField } from './pathfinding';
import {
  TOWER_COST,
  MAX_TOWERS,
  canPlaceTower,
  countValidTowers,
  emptyTowers,
  findValidTowerIndex,
  forEachValidTower,
  materializeTowerMask,
  safeCombatColumn,
  type TowerArrays,
  refundFor,
} from './tower';

/** Simulation cadence: 20 Hz. Must match the render loop's tick duration. */
export const MS_PER_TICK = 50;

/** Behavior version stamped into replays; bump on any determinism-affecting change. */
export const SIM_VERSION = 4;

/** Creep travel budget per tick, in fixed-point units (256 units = 1 tile). */
const CREEP_SPEED_FP = 26;

/** Starting lives; a creep reaching the exit costs one. */
const STARTING_LIVES = 10;

/** Starting bounty (player currency). */
const STARTING_BOUNTY = 80;

/**
 * Structure-of-arrays creep storage — cheap to iterate and serialize. Movement is
 * POINT-AUTHORITATIVE (Story 4, closes #17): a creep carries a fixed-point segment
 * start point `(fromX,fromY)`, a waypoint cell `(headCol,headRow)` whose centre is
 * the segment end, and `progress` (arc-length travelled toward that centre). Its
 * Euclidean point and the cell it occupies are DERIVED, not stored, and its edge
 * length is derived too (never persisted — see movement.ts). At rest the head
 * columns hold the canonical sentinel `head == cellContaining(from)` with
 * `progress === 0`, and the heading is derived fresh the moment the creep moves.
 */
export interface CreepArrays {
  id: number[];
  hp: number[];
  fromX: number[]; // fixed-point segment start point (x)
  fromY: number[]; // fixed-point segment start point (y)
  headCol: number[]; // waypoint cell (sentinel: == cellContaining(from) at rest)
  headRow: number[];
  progress: number[]; // fixed-point arc-length travelled from `from`, in [0, edgeLen)
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
  impacts: Impact[]; // in-flight scheduled combat impacts (Story 4)
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
    state.creeps = emptyCreeps();
  }
  const c = state.creeps;
  if (!Array.isArray(c.id)) c.id = [];
  if (!Array.isArray(c.hp)) c.hp = [];
  if (!Array.isArray(c.fromX)) c.fromX = [];
  if (!Array.isArray(c.fromY)) c.fromY = [];
  if (!Array.isArray(c.headCol)) c.headCol = [];
  if (!Array.isArray(c.headRow)) c.headRow = [];
  if (!Array.isArray(c.progress)) c.progress = [];

  if (state.towers == null || typeof state.towers !== 'object') {
    state.towers = emptyTowers();
  }
  const t = state.towers;
  if (!Array.isArray(t.id)) t.id = [];
  if (!Array.isArray(t.col)) t.col = [];
  if (!Array.isArray(t.row)) t.row = [];
  if (!Array.isArray(t.spend)) t.spend = [];
  if (!Array.isArray(t.targetId)) t.targetId = [];
  if (!Array.isArray(t.nextFireTick)) t.nextFireTick = [];

  if (!Array.isArray(state.impacts)) state.impacts = [];
}

/** Build a fresh match state for a given seed. */
export function createInitialState(seed: Seed | number): SimState {
  return {
    tick: 0,
    rngState: seed >>> 0,
    lives: STARTING_LIVES,
    bounty: STARTING_BOUNTY,
    nextEntityId: 1,
    creeps: emptyCreeps(),
    towers: emptyTowers(),
    impacts: [],
  };
}

/**
 * Advance the simulation by exactly one tick. Mutates and returns `state`.
 * Deterministic: identical (state, inputs, board) always yield identical output.
 * `board` is a static, caller-supplied input (see {@link BoardContext}); it is
 * validated once per context object, not stored in `state`.
 *
 * Phases. The INPUT phase applies commands in array order, each re-validated
 * against the then-current state; anything malformed or illegal is a
 * deterministic no-op (ADR 0006 §4 — `step` is total, it never throws on bad
 * input). The tick then derives the effective distance field ONCE, as a pure
 * local, from the post-input tower state — so every creep (including one spawned
 * this tick, in either order relative to a build) heads off the final geometry,
 * and a cold re-simulation reproduces the field byte-identically with no cache or
 * ambient state (PLAN §1). The MOVEMENT phase advances creeps (leaks cost a life);
 * the COMBAT phase (Story 4) then resolves impacts, sweeps kills, and fires — all
 * over the post-move world — before the guarded `tick++`.
 */
export function step(state: SimState, inputs: readonly SimInput[], board: BoardContext): SimState {
  assertConsistent(board); // memoized; rejects a forged context loudly, once
  coerceSoa(state); // totality: never dereference a missing SoA container/column

  // TICK TOTALITY (Codex R2 #7): validate `state.tick` at entry and guard the final
  // increment. A forged non-safe/negative tick, or one so large that `tick + 1`
  // would leave the safe-integer range, makes the whole step a deterministic
  // terminal no-op (return state unchanged) rather than producing a platform-
  // sensitive value — a genuine match ends long before ~9e15 ticks.
  if (
    !Number.isSafeInteger(state.tick) ||
    state.tick < 0 ||
    state.tick + 1 > Number.MAX_SAFE_INTEGER
  ) {
    return state;
  }

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
      state.creeps.fromX.push(cellCenterX(entrance.col)); // rest on the entrance cell centre
      state.creeps.fromY.push(cellCenterY(entrance.row));
      state.creeps.headCol.push(entrance.col); // sentinel — heading derived at movement
      state.creeps.headRow.push(entrance.row);
      state.creeps.progress.push(0);
    } else if (kind === 'placeTower') {
      const anchor = (input as { anchor?: unknown }).anchor;
      // Sim-owned cap: a build past MAX_TOWERS is a deterministic no-op, so the
      // in-flight impact queue is bounded for every step() caller (see tower.ts).
      // The raw row count is an upper bound on the valid count, so the precise
      // O(towers) recount only runs in the (forged) case where even the raw array
      // already meets the cap — never on the genuine placement path.
      if (
        state.towers.id.length >= MAX_TOWERS &&
        countValidTowers(grid, state.towers) >= MAX_TOWERS
      ) {
        continue;
      }
      const towerMask = materializeTowerMask(grid, state.towers);
      if (!canPlaceTower(grid, towerMask, anchor, state.creeps, state.bounty)) continue;
      const cell = anchor as Cell; // structurally validated by canPlaceTower
      state.towers.id.push(state.nextEntityId++);
      state.towers.col.push(cell.col);
      state.towers.row.push(cell.row);
      state.towers.spend.push(TOWER_COST);
      state.towers.targetId.push(0); // no lock
      state.towers.nextFireTick.push(0); // no warm-up — may fire this tick
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
      // Carry the combat columns BY SOURCE ROW so selling one tower never resets a
      // survivor's target lock or cooldown (Codex R1 #4).
      const src = state.towers;
      const compacted: TowerArrays = emptyTowers();
      forEachValidTower(grid, src, (i, id, col, row) => {
        if (i === index) return;
        compacted.id.push(id);
        compacted.col.push(col);
        compacted.row.push(row);
        compacted.spend.push(src.spend[i] as number);
        // Coerce the combat columns so a ragged/forged source row (targetId or
        // nextFireTick shorter than id) can never persist `undefined`/`null` into
        // the survivor's number[] columns (or the world hash).
        compacted.targetId.push(safeCombatColumn(src.targetId[i]));
        compacted.nextFireTick.push(safeCombatColumn(src.nextFireTick[i]));
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
  const next: CreepArrays = emptyCreeps();
  for (let i = 0; i < src.id.length; i++) {
    const outcome = advanceCreep(
      field,
      src.id[i],
      src.hp[i],
      src.fromX[i],
      src.fromY[i],
      src.headCol[i],
      src.headRow[i],
      src.progress[i],
      CREEP_SPEED_FP,
    );
    if (outcome.kind === 'drop') continue;
    if (outcome.kind === 'leak') {
      // Guarded decrement (Codex R4 #2 / R5 #2): one canonical policy for every
      // non-genuine value — a non-safe `lives`, or one at MIN_SAFE_INTEGER, removes
      // the creep but leaves `lives` unchanged; otherwise decrement. No clamp on the
      // low end; win/loss is Story 5.
      if (Number.isSafeInteger(state.lives) && state.lives > Number.MIN_SAFE_INTEGER) {
        state.lives -= 1;
      }
      continue;
    }
    next.id.push(src.id[i] as number);
    next.hp.push(src.hp[i] as number);
    next.fromX.push(outcome.fromX);
    next.fromY.push(outcome.fromY);
    next.headCol.push(outcome.headCol);
    next.headRow.push(outcome.headRow);
    next.progress.push(outcome.progress);
  }
  state.creeps = next;

  // 4) COMBAT PHASE (Story 4) — over the POST-MOVE world: resolve due impacts,
  //    sweep dead creeps and credit per-kill bounty, then let each tower hold or
  //    acquire its sticky "first" target and fire. Impacts resolve before firing so
  //    a kill can free a tower to re-acquire and fire the same tick.
  const combat = runCombat(
    state.creeps,
    state.towers,
    state.impacts,
    state.tick,
    state.bounty,
    field,
    grid,
  );
  state.creeps = combat.creeps;
  state.impacts = combat.impacts;
  state.bounty = combat.bounty;

  state.tick += 1; // guarded at entry — `tick + 1` is in the safe-integer range here
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
