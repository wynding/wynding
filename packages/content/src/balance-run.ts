// balance-run.ts — M3 story 1: ONE instrumented reference-build run, the measurement the
// balance checker's checks (`balance-checks.ts`) and report (`balance-report.ts`) read.
// Test/tooling support, NOT part of this package's public API — the `showcase-builds.ts`
// precedent.
//
// It drives `runBuildScript` with an observer and never touches the sim's state: every
// number below is read off the post-step state or the tick's own `StepEvents`, which the
// sim documents as never hash-relevant. A leak and a kill are told apart by identity
// (`StepEvents.leaked` / `.killed`), never inferred from counts.
//
// TWO KINDS OF PER-WAVE NUMBER, deliberately. Waves overlap — a wave's creeps can still be
// walking after the next one launches — so:
//   - what a CREEP did (leaks, lives lost, closest approach) is booked to the creep's own
//     wave, from the sim's `wave` column;
//   - what the BOARD looked like (lives, towers, unspent bounty, creeps alive) is booked
//     to the wave's WINDOW: from its launch tick up to the next wave's launch (the last
//     wave's window runs to the end of the run), sampled after every tick, so a wave's row
//     holds its window's last sample (and its peak).
//
// CLOSEST APPROACH is the smallest fraction of its empty-board distance that any of the
// wave's creeps still had to cover: a ground creep by path distance on the maze as it
// stood that tick, an air creep by straight line to the exit, each over the same measure
// on the empty board; a leak is 0. A maze longer than the empty board starts its creeps
// above 1.

import {
  cellCenterX,
  cellCenterY,
  computeDistanceField,
  materializeTowerMask,
  projectCreep,
  resolveCreepLeakCost,
  type CompiledRuleset,
  type DistanceField,
  type SimState,
} from '@wynding/sim';
import { runBuildScript, type ScriptStep } from './script-runner';

/** A distance field's unit: one orthogonal step costs this much (`pathfinding.ts`'s
 *  `ORTHO_COST`, not exported by the sim). `balance-run.test.ts` pins it against the
 *  empty board, so a change to the sim's metric fails there rather than skewing ratios. */
export const FIELD_UNITS_PER_CELL = 10;

/** One wave's row of the pressure profile — see this file's header for how each number
 *  is booked. */
export interface WaveProfile {
  /** The wave's index in the compiled schedule (the arc's wave number is this + 1). */
  readonly wave: number;
  /** This wave's creeps that leaked, and the lives they cost. */
  readonly leaks: number;
  readonly livesLost: number;
  /** `null` when none of this wave's creeps was ever seen on the board. */
  readonly closestApproach: number | null;
  /** At the end of the wave's window. */
  readonly lives: number;
  readonly towers: number;
  readonly unspent: number;
  /** Placements accepted during the wave's window. */
  readonly placed: number;
  /** The most creeps alive at once during the wave's window. */
  readonly peakAlive: number;
}

export interface LeakRecord {
  readonly tick: number;
  readonly creepId: string;
  readonly wave: number;
}

export interface SellRecord {
  readonly tick: number;
  readonly col: number;
  readonly row: number;
  readonly towerId: string;
  /** Creeps on the board when the sell was applied (the state the step consumed). */
  readonly creepsAlive: number;
}

export interface BuildRun {
  readonly state: SimState;
  /** Script steps the sim accepted, of `stepCount`. */
  readonly stepsDone: number;
  readonly stepCount: number;
  /** Bounty spent per tower id, every accepted placement at its catalog cost (a sold
   *  tower's spend stays counted — M2's measure, which had no sells). */
  readonly spendById: Readonly<Record<string, number>>;
  readonly spend: number;
  readonly kills: number;
  readonly leaks: readonly LeakRecord[];
  readonly sells: readonly SellRecord[];
  /** The most creeps alive at once, over the whole run. */
  readonly peakAlive: number;
  /** The wave whose window held the last accepted placement: `-1` if it came before
   *  wave 1 launched, `null` if nothing was ever placed. */
  readonly lastPlacementWave: number | null;
  /** One row per launched wave, in wave order. */
  readonly waves: readonly WaveProfile[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Two tower masks of one board (so of one length) mark the same cells. */
function sameMask(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Creep row `i`'s remaining distance as a fraction of its empty-board distance (this
 * file's header), with `field` the maze's distance field this tick — or `null` for a row
 * whose position doesn't derive, or a ground creep whose next cell the maze has just
 * covered (it re-routes next tick; this tick it has no path distance to read). The board
 * has one entrance and one exit until M3 story 3 gives each creep its own destination.
 */
export function remainingFraction(
  ruleset: CompiledRuleset,
  state: SimState,
  i: number,
  field: DistanceField,
): number | null {
  const { grid, field: emptyField } = ruleset.board;
  const { entrance, exit } = grid;
  const point = projectCreep(state.creeps, i, grid);
  if (point === null) return null;
  const exitX = cellCenterX(exit.col);
  const exitY = cellCenterY(exit.row);
  if (ruleset.creepById[state.creeps.creepId[i]!]?.domain === 'air') {
    const emptyAir = Math.hypot(
      cellCenterX(entrance.col) - exitX,
      cellCenterY(entrance.row) - exitY,
    );
    return Math.hypot(point.x - exitX, point.y - exitY) / emptyAir;
  }
  const headCol = state.creeps.headCol[i]!;
  const headRow = state.creeps.headRow[i]!;
  const headDist = field.dist[headRow * grid.width + headCol]!;
  if (headDist < 0) return null;
  const fpPerCell = cellCenterX(1) - cellCenterX(0);
  const toHead = Math.hypot(cellCenterX(headCol) - point.x, cellCenterY(headRow) - point.y);
  const emptyDist = emptyField.dist[entrance.row * grid.width + entrance.col]!;
  return (headDist + (toHead / fpPerCell) * FIELD_UNITS_PER_CELL) / emptyDist;
}

/** Run `plan` from `seed` and measure it. */
export function runReferenceBuild(
  ruleset: CompiledRuleset,
  seed: number,
  plan: readonly ScriptStep[],
): BuildRun {
  const { grid, field: emptyField } = ruleset.board;

  // The maze's field, recomputed only when the tower mask changes.
  let mazeField: DistanceField = emptyField;
  let mazeMask: Uint8Array | null = null;
  const fieldFor = (state: SimState): DistanceField => {
    if (state.towers.id.length === 0) return emptyField;
    const mask = materializeTowerMask(grid, state.towers, ruleset.towerById);
    if (mazeMask === null || !sameMask(mask, mazeMask)) {
      mazeField = computeDistanceField(grid, mask);
      mazeMask = mask;
    }
    return mazeField;
  };

  const rows: Mutable<WaveProfile>[] = [];
  const known = new Map<number, { readonly creepId: string; readonly wave: number }>();
  const standing = new Map<string, string>();
  const spendById: Record<string, number> = {};
  const leaks: LeakRecord[] = [];
  const sells: SellRecord[] = [];
  let spend = 0;
  let kills = 0;
  let peakAlive = 0;
  let lastPlacementWave: number | null = null;
  let tickBefore = 0;
  let aliveBefore = 0;

  const { state, placedCount } = runBuildScript(ruleset, seed, plan, {
    collectEvents: true,
    beforeStep: (state) => {
      tickBefore = state.tick;
      aliveBefore = state.creeps.id.length;
    },
    afterStep: (state, _ruleset, _inputs, placed, { sold, events }) => {
      while (rows.length < state.waveCursor) {
        rows.push({
          wave: rows.length,
          leaks: 0,
          livesLost: 0,
          closestApproach: null,
          lives: state.lives,
          towers: state.towers.id.length,
          unspent: state.bounty,
          placed: 0,
          peakAlive: 0,
        });
      }
      const window = rows[state.waveCursor - 1];
      const creeps = state.creeps;
      const alive = creeps.id.length;
      for (let i = 0; i < alive; i++) {
        const id = creeps.id[i]!;
        if (!known.has(id)) known.set(id, { creepId: creeps.creepId[i]!, wave: creeps.wave[i]! });
      }

      // A creep leaks in the movement phase, so it was on the board after an earlier tick
      // and `known` already holds it.
      for (const id of events!.leaked!) {
        const creep = known.get(id)!;
        leaks.push({ tick: tickBefore, ...creep });
        const row = rows[creep.wave]!;
        row.leaks++;
        row.livesLost += resolveCreepLeakCost(ruleset.creepById, creep.creepId);
        row.closestApproach = 0;
      }
      kills += events!.killed!.length;

      if (placed !== undefined) {
        const cost = ruleset.towerById[placed.towerId]!.cost;
        spendById[placed.towerId] = (spendById[placed.towerId] ?? 0) + cost;
        spend += cost;
        standing.set(`${placed.col},${placed.row}`, placed.towerId);
        lastPlacementWave = state.waveCursor - 1;
        if (window !== undefined) window.placed++;
      }
      if (sold !== undefined) {
        const key = `${sold.col},${sold.row}`;
        sells.push({
          tick: tickBefore,
          col: sold.col,
          row: sold.row,
          towerId: standing.get(key)!,
          creepsAlive: aliveBefore,
        });
        standing.delete(key);
      }

      peakAlive = Math.max(peakAlive, alive);
      if (window !== undefined) {
        window.lives = state.lives;
        window.towers = state.towers.id.length;
        window.unspent = state.bounty;
        window.peakAlive = Math.max(window.peakAlive, alive);
      }

      if (alive > 0) {
        const field = fieldFor(state);
        for (let i = 0; i < alive; i++) {
          const fraction = remainingFraction(ruleset, state, i, field);
          if (fraction === null) continue;
          const row = rows[creeps.wave[i]!]!;
          if (row.closestApproach === null || fraction < row.closestApproach) {
            row.closestApproach = fraction;
          }
        }
      }
    },
  });

  return {
    state,
    stepsDone: placedCount,
    stepCount: plan.length,
    spendById,
    spend,
    kills,
    leaks,
    sells,
    peakAlive,
    lastPlacementWave,
    waves: rows,
  };
}
