// @wynding/sim — the headless deterministic simulation.
//
// A tick is a pure function of (previous state, inputs). No wall-clock, no
// floats, no Math.random — randomness comes only from the seeded RNG carried in
// the state. This is what lets the server re-simulate a replay and derive the
// same score the client saw. Kept renderer-agnostic: no Phaser, no DOM.

import { Rng, toFixed, hashState } from '@wynding/engine';
import type { Seed } from '@wynding/types';

/** Simulation cadence: 20 Hz. Must match the render loop's tick duration. */
export const MS_PER_TICK = 50;

/** Behavior version stamped into replays; bump on any determinism-affecting change. */
export const SIM_VERSION = 1;

/** Board width in tiles; the exit is the left edge (x = 0). */
export const BOARD_WIDTH_TILES = 20;

/** Creep travel speed, in fixed-point units per tick (256 units = 1 tile). */
const CREEP_SPEED_FP = 64;

/** Starting lives; reaching the exit costs one. */
const STARTING_LIVES = 20;

/** Starting bounty (player currency). */
const STARTING_BOUNTY = 100;

/** Structure-of-arrays creep storage — cheap to iterate and serialize. */
export interface CreepArrays {
  id: number[];
  x: number[]; // fixed-point board position
  y: number[]; // fixed-point lane position
  hp: number[];
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
  | { readonly kind: 'spawnCreep'; readonly hp: number; readonly lane: number }
  | { readonly kind: 'noop' };

/** Build a fresh match state for a given seed. */
export function createInitialState(seed: Seed | number): SimState {
  return {
    tick: 0,
    rngState: seed >>> 0,
    lives: STARTING_LIVES,
    bounty: STARTING_BOUNTY,
    nextEntityId: 1,
    creeps: { id: [], x: [], y: [], hp: [] },
  };
}

/**
 * Advance the simulation by exactly one tick. Mutates and returns `state`.
 * Deterministic: identical (state, inputs) always yield identical output.
 */
export function step(state: SimState, inputs: readonly SimInput[]): SimState {
  const rng = new Rng(state.rngState);

  // 1) Apply this tick's inputs. Spawns draw from the sim RNG so randomness
  //    stays part of the replayable state.
  for (const input of inputs) {
    if (input.kind === 'spawnCreep') {
      const laneJitter = rng.nextInt(3); // -0/+2 tiles of lane spread
      state.creeps.id.push(state.nextEntityId++);
      state.creeps.x.push(toFixed(BOARD_WIDTH_TILES));
      state.creeps.y.push(toFixed(input.lane + laneJitter));
      state.creeps.hp.push(input.hp);
    }
  }

  // 2) Advance creeps toward the exit. A creep that reaches x <= 0 leaks (costs
  //    a life) and is removed. Rebuild the arrays to compact removals.
  const src = state.creeps;
  const next: CreepArrays = { id: [], x: [], y: [], hp: [] };
  for (let i = 0; i < src.id.length; i++) {
    const id = src.id[i];
    const y = src.y[i];
    const hp = src.hp[i];
    const prevX = src.x[i];
    if (id === undefined || y === undefined || hp === undefined || prevX === undefined) continue;

    const x = prevX - CREEP_SPEED_FP;
    if (x <= 0) {
      state.lives -= 1;
      continue;
    }
    next.id.push(id);
    next.x.push(x);
    next.y.push(y);
    next.hp.push(hp);
  }
  state.creeps = next;

  state.tick += 1;
  state.rngState = rng.getState();
  return state;
}

/** Deterministic content-hash of the world — the per-tick determinism checksum. */
export function hashSimState(state: SimState): string {
  return hashState(state);
}

// Grid + pathfinding foundation (M1 Story 1). Standalone and pure — deliberately
// NOT wired into `step()` yet, so the determinism golden above is unaffected;
// Story 2 (creep movement) consumes these and bumps SIM_VERSION once.
export { buildGrid, neighbors } from './board';
export type { CellClass, GridSpec, Grid } from './board';
export { computeDistanceField, isReachable, shortestPath } from './pathfinding';
export type { DistanceField } from './pathfinding';
