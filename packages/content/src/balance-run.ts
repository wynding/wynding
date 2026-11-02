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
// above 1. Every one of those is the creep's OWN destination's (M3 story 3, ADR 0015):
// its own field, its own exit, and the empty-board distance from the entrance that
// destination serves.

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
import type { Cell } from '@wynding/types';
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
  /** Sampled at the end of every tick from the creeps still on the board, and 0 for a leak.
   *  A creep's movement on the tick it dies is not sampled — at most one tick of travel,
   *  well under 1% of a route — and `null` means none of the wave's creeps survived a tick
   *  to be sampled. */
  readonly closestApproach: number | null;
  /** At the end of the wave's window. */
  readonly lives: number;
  readonly towers: number;
  readonly unspent: number;
  /** Placements accepted during the wave's window. */
  readonly placed: number;
  /** The most creeps alive at once during the wave's window — a tick counting the creeps
   *  its own leaks and kills removed, since they were all on the board as it began. */
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
  /** The step left at the cursor was sent and rejected by the sim — the runner's
   *  `stalled`: blocked, rather than queued behind its tick or its bounty. */
  readonly stalled: boolean;
  /** Bounty spent per tower id, every accepted placement at its catalog cost (a sold
   *  tower's spend stays counted — M2's measure, which had no sells). */
  readonly spendById: Readonly<Record<string, number>>;
  readonly spend: number;
  readonly kills: number;
  readonly leaks: readonly LeakRecord[];
  readonly sells: readonly SellRecord[];
  /** The most creeps alive at once over the whole run, counted as `WaveProfile`'s is. */
  readonly peakAlive: number;
  /** The wave whose window held the last placement on an anchor never built on before —
   *  where the board filled, so a re-arm or a juggle re-placement doesn't move it: `-1`
   *  if it came before wave 1 launched, `null` if nothing was ever placed. */
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
 * The entrance destination `d` serves — the empty-board distance a creep bound there is
 * measured against. The sim records a creep's destination, not its entrance, so a
 * destination two entrances share has no single answer: that throws, loudly, rather than
 * measuring a creep from the wrong entrance. (Every board so far gives each destination
 * one entrance; the first that shares one must record the creep's entrance first.)
 */
function entranceServing(ruleset: CompiledRuleset, d: number): Cell {
  const { grid, entranceDestination } = ruleset.board;
  const serving = grid.entrances.filter((_, e) => entranceDestination[e] === d);
  if (serving.length !== 1) {
    throw new Error(
      `remainingFraction: destination ${d} is served by ${serving.length} entrances — the ` +
        `empty-board distance needs the creep's own entrance, which the sim does not record`,
    );
  }
  return serving[0]!;
}

/**
 * Creep row `i`'s remaining distance as a fraction of its empty-board distance (this
 * file's header), with `fields` the maze's distance fields this tick — one per
 * destination, index-parallel to `ruleset.board.fields` — read at the creep's OWN
 * destination. `null` for a row whose position doesn't derive, whose destination names
 * no field, or a ground creep whose next cell the maze has just covered (it re-routes
 * next tick; this tick it has no path distance to read).
 */
export function remainingFraction(
  ruleset: CompiledRuleset,
  state: SimState,
  i: number,
  fields: readonly DistanceField[],
): number | null {
  const { grid } = ruleset.board;
  const d = state.creeps.destination[i]!;
  const emptyField = ruleset.board.fields[d];
  const field = fields[d];
  if (emptyField === undefined || field === undefined) return null;
  const entrance = entranceServing(ruleset, d);
  const { exit } = emptyField;
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
  const { grid, fields: emptyFields } = ruleset.board;

  // The maze's fields, one per destination, recomputed only when the tower mask changes.
  let mazeFields: readonly DistanceField[] = emptyFields;
  let mazeMask: Uint8Array | null = null;
  const fieldsFor = (state: SimState): readonly DistanceField[] => {
    if (state.towers.id.length === 0) return emptyFields;
    const mask = materializeTowerMask(grid, state.towers, ruleset.towerById);
    if (mazeMask === null || !sameMask(mask, mazeMask)) {
      mazeFields = emptyFields.map((f) => computeDistanceField(grid, f.exit, mask));
      mazeMask = mask;
    }
    return mazeFields;
  };

  const rows: Mutable<WaveProfile>[] = [];
  const known = new Map<number, { readonly creepId: string; readonly wave: number }>();
  const standing = new Map<string, string>();
  const builtOn = new Set<string>();
  // No prototype: a tower id such as `constructor` must read as unspent, not as Object's.
  const spendById: Record<string, number> = Object.create(null) as Record<string, number>;
  const leaks: LeakRecord[] = [];
  const sells: SellRecord[] = [];
  let spend = 0;
  let kills = 0;
  let peakAlive = 0;
  let lastPlacementWave: number | null = null;
  let tickBefore = 0;
  let aliveBefore = 0;

  const { state, placedCount, stalled } = runBuildScript(ruleset, seed, plan, {
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
      const leaked = events!.leaked!;
      const killed = events!.killed!;
      for (let i = 0; i < alive; i++) {
        const id = creeps.id[i]!;
        if (!known.has(id)) known.set(id, { creepId: creeps.creepId[i]!, wave: creeps.wave[i]! });
      }

      // A creep leaks in the movement phase, so it was on the board after an earlier tick
      // and `known` already holds it.
      for (const id of leaked) {
        const creep = known.get(id);
        if (creep === undefined) {
          // Only a creep that crosses its whole route within one tick could leak unseen; no
          // legal board and catalog allow that, so say so loudly rather than guess its wave.
          throw new Error(`balance run: creep ${id} leaked on the tick it spawned`);
        }
        leaks.push({ tick: tickBefore, ...creep });
        const row = rows[creep.wave]!;
        row.leaks++;
        row.livesLost += resolveCreepLeakCost(ruleset.creepById, creep.creepId);
        row.closestApproach = 0;
      }
      kills += killed.length;

      if (placed !== undefined) {
        const key = `${placed.col},${placed.row}`;
        const cost = ruleset.towerById[placed.towerId]!.cost;
        spendById[placed.towerId] = (spendById[placed.towerId] ?? 0) + cost;
        spend += cost;
        standing.set(key, placed.towerId);
        // Board-full is "no new tower fits": a re-arm or a juggle re-placement takes no
        // new room, so only a first placement on its anchor moves it.
        if (!builtOn.has(key)) {
          builtOn.add(key);
          lastPlacementWave = state.waveCursor - 1;
        }
        if (window !== undefined) window.placed++;
      }
      if (sold !== undefined) {
        const key = `${sold.col},${sold.row}`;
        const towerId = standing.get(key);
        if (towerId === undefined) throw new Error(`balance run: sold (${key}), never placed`);
        sells.push({
          tick: tickBefore,
          col: sold.col,
          row: sold.row,
          towerId,
          creepsAlive: aliveBefore,
        });
        standing.delete(key);
      }

      // The tick's own peak: every creep on the board when movement began — those still
      // standing, plus the ones this tick's leaks and kills removed.
      const inTick = alive + leaked.length + killed.length;
      peakAlive = Math.max(peakAlive, inTick);
      if (window !== undefined) {
        window.lives = state.lives;
        window.towers = state.towers.id.length;
        window.unspent = state.bounty;
        window.peakAlive = Math.max(window.peakAlive, inTick);
      }

      if (alive > 0) {
        const fields = fieldsFor(state);
        for (let i = 0; i < alive; i++) {
          const fraction = remainingFraction(ruleset, state, i, fields);
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
    stalled,
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
