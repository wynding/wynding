// @wynding/sim — the headless deterministic simulation.
//
// A tick is a pure function of (previous state, inputs, board). No wall-clock, no
// floats, no Math.random — randomness comes only from the seeded RNG carried in
// the state. This is what lets the server re-simulate a replay and derive the
// same score the client saw. Kept renderer-agnostic: no Phaser, no DOM.

import { hashState } from '@wynding/engine';
import type { Seed } from '@wynding/types';
import { advanceCreep } from './movement';
import { assertConsistent, type BoardContext } from './context';

/** Simulation cadence: 20 Hz. Must match the render loop's tick duration. */
export const MS_PER_TICK = 50;

/** Behavior version stamped into replays; bump on any determinism-affecting change. */
export const SIM_VERSION = 2;

/** Creep travel budget per tick, in fixed-point units (256 units = 1 tile). */
const CREEP_SPEED_FP = 26;

/** Starting lives; a creep reaching the exit costs one. */
const STARTING_LIVES = 10;

/** Starting bounty (player currency). */
const STARTING_BOUNTY = 80;

/**
 * Structure-of-arrays creep storage — cheap to iterate and serialize. Movement is
 * cell-relative: a creep is at cell `(col,row)` and `edgeProgress` fixed-point units
 * into the edge toward its next descent cell. No Euclidean world position yet — it is
 * trivially derivable and deferred until combat/render need it (Story 4/6).
 */
export interface CreepArrays {
  id: number[];
  hp: number[]; // carried, inert until combat (Story 4)
  col: number[]; // current cell column (the cell it is travelling FROM)
  row: number[]; // current cell row
  edgeProgress: number[]; // fixed-point units travelled from (col,row), in [0, edgeLen)
}

/** Complete simulation state for one match. Fully serializable. */
export interface SimState {
  tick: number;
  rngState: number;
  lives: number;
  bounty: number;
  nextEntityId: number;
  creeps: CreepArrays;
}

/** Per-tick inputs (the replayable command log). */
export type SimInput =
  { readonly kind: 'spawnCreep'; readonly hp: number } | { readonly kind: 'noop' };

/** Build a fresh match state for a given seed. */
export function createInitialState(seed: Seed | number): SimState {
  return {
    tick: 0,
    rngState: seed >>> 0,
    lives: STARTING_LIVES,
    bounty: STARTING_BOUNTY,
    nextEntityId: 1,
    creeps: { id: [], hp: [], col: [], row: [], edgeProgress: [] },
  };
}

/**
 * Advance the simulation by exactly one tick. Mutates and returns `state`.
 * Deterministic: identical (state, inputs, board) always yield identical output.
 * `board` is a static, caller-supplied input (see {@link BoardContext}); it is
 * validated once per context object, not stored in `state`.
 */
export function step(state: SimState, inputs: readonly SimInput[], board: BoardContext): SimState {
  assertConsistent(board); // memoized; rejects a forged context loudly, once
  const { field } = board;
  const { entrance } = board.grid;

  // 1) Spawn phase: each spawn enters at the board entrance with fresh progress.
  //    No RNG draw — M1 movement is pure integer math; `rngState` is carried
  //    unchanged for a future stochastic mechanic.
  for (const input of inputs) {
    if (input.kind === 'spawnCreep') {
      state.creeps.id.push(state.nextEntityId++);
      state.creeps.hp.push(input.hp);
      state.creeps.col.push(entrance.col);
      state.creeps.row.push(entrance.row);
      state.creeps.edgeProgress.push(0);
    }
  }

  // 2) Movement phase: advance each creep along the gradient. A creep that reaches
  //    the exit leaks (costs a life); a corrupt row is dropped (no life lost).
  //    Rebuild the arrays to compact both removals.
  const src = state.creeps;
  const next: CreepArrays = { id: [], hp: [], col: [], row: [], edgeProgress: [] };
  for (let i = 0; i < src.id.length; i++) {
    const outcome = advanceCreep(
      field,
      src.id[i],
      src.hp[i],
      src.col[i],
      src.row[i],
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
