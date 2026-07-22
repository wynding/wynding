// combat.ts — Story 4 combat: scheduled-impact fire, sticky "first" targeting,
// per-kill bounty. Pure, deterministic, integer-only.
//
// A tower ACQUIRES the in-range creep nearest the exit (min route-distance, ties to
// the lower id) and holds it while it stays present, alive, and in range. Each fire
// SNAPSHOTS its effects and schedules an IMPACT at `tick + TRAVEL_TICKS`; the impact
// resolves later, in queue order, applying direct damage to the still-live target or
// — if it died or leaked in flight — being consumed as a WASTED shot. A kill credits
// `KILL_BOUNTY`. Everything reads the POST-MOVE world, and impacts resolve BEFORE
// firing so a kill can free a tower to re-acquire and fire the same tick.
//
// Effects go through a minimal `applyEffect` dispatch carrying `{kind:'direct',
// amount}`. This is a SHAPE for future primitives (a seam), not the full M2 stacking
// model — DoT's refresh-don't-stack needs a source/effect identity M2 will add then.
//
// TOTALITY: every restored container is validated/canonicalized like the SoA state.
// A malformed impact is dropped; the queue is capped at `MAX_IN_FLIGHT_IMPACTS`; new
// counters are safe-integer-guarded with a deterministic no-op on overflow. The cap
// is a forged-state / DoS backstop, NOT a genuine-play limit: each valid tower holds
// ≤1 impact in flight (`FIRE_INTERVAL 30 > TRAVEL_TICKS 4`) and placement enforces
// `MAX_TOWERS`, so in-flight ≈ live towers, with a bounded slack — a tower sold within
// the last `TRAVEL_TICKS` still has its impact resident until it resolves. On any
// budget-conforming board that slack stays far under the `MAX_TOWERS` (1000) cap vs
// the ~143 physical tower capacity, so the cap never bites genuine play; a caller that
// drives the queue to the cap by abusive sell/rebuild churn is exactly the forged/DoS
// case the backstop exists for, where a queue-full fire is a deterministic no-op that
// retries next tick (total and reproducible for every `step()` caller).

import { FP_ONE } from '@wynding/engine';
import type { Grid } from './board';
import type { DistanceField } from './pathfinding';
import { distAt } from './field-access';
import { deriveValidCreepPosition } from './movement';
import { MAX_TOWERS, forEachValidTower, type TowerArrays } from './tower';

/** Fixed-point combat range (4 tiles), measured tower-centre → creep point. */
export const RANGE = 1024;
/** Ticks between a tower firing and its impact resolving. */
export const TRAVEL_TICKS = 4;
/** Ticks between consecutive fires of one tower (no placement warm-up). */
export const FIRE_INTERVAL = 30;
/** Bounty credited for a creep killed by an impact. Scaffolding like TOWER_COST (#18). */
export const KILL_BOUNTY = 1;
/** The single M1 tower's per-hit direct damage. */
export const DIRECT_DAMAGE = 10;
/** Forged-state / DoS backstop on the resident impact queue (never bites real play). */
export const MAX_IN_FLIGHT_IMPACTS = MAX_TOWERS;

/** One effect primitive an impact applies. M1 emits exactly `direct`. */
export type EffectPrimitive = { readonly kind: 'direct'; readonly amount: number };

/** A scheduled impact: resolves at `impactTick`, hitting the creep `targetId`. */
export interface Impact {
  readonly impactTick: number;
  readonly targetId: number;
  readonly effects: EffectPrimitive[];
}

/** Structural creep SoA combat reads/mutates (CreepArrays is assignable to it). */
export interface CombatCreeps {
  id: number[];
  hp: number[];
  fromX: number[];
  fromY: number[];
  headCol: number[];
  headRow: number[];
  progress: number[];
}

/** The empty 7-column creep SoA — the single factory, reused by the sim barrel. */
export const emptyCreeps = (): CombatCreeps => ({
  id: [],
  hp: [],
  fromX: [],
  fromY: [],
  headCol: [],
  headRow: [],
  progress: [],
});

/**
 * True iff `imp` is M1's sole valid impact shape: safe-integer `impactTick`/
 * `targetId` and an `effects` array of length exactly 1 holding `{kind:'direct',
 * amount}` with `amount` a positive safe integer. Any other shape is dropped.
 */
function validImpact(imp: unknown): imp is Impact {
  if (imp === null || typeof imp !== 'object') return false;
  const { impactTick, targetId, effects } = imp as {
    impactTick?: unknown;
    targetId?: unknown;
    effects?: unknown;
  };
  if (!Number.isSafeInteger(impactTick) || !Number.isSafeInteger(targetId)) return false;
  if (!Array.isArray(effects) || effects.length !== 1) return false;
  const e = effects[0] as { kind?: unknown; amount?: unknown } | null;
  if (e === null || typeof e !== 'object') return false;
  if (e.kind !== 'direct') return false;
  if (!Number.isSafeInteger(e.amount) || (e.amount as number) <= 0) return false;
  return true;
}

/**
 * Canonicalize the restored impact queue: keep only valid entries (re-built to the
 * exact `{impactTick, targetId, effects:[{kind,amount}]}` shape so serialization is
 * stable), in array order, capped at {@link MAX_IN_FLIGHT_IMPACTS}. Excess forged
 * entries drop in array order.
 */
function canonicalImpacts(impacts: readonly unknown[]): Impact[] {
  const out: Impact[] = [];
  for (const imp of impacts) {
    if (out.length >= MAX_IN_FLIGHT_IMPACTS) break;
    if (!validImpact(imp)) continue;
    // validImpact guarantees effects.length === 1, so element 0 is present.
    const effect = imp.effects[0] as EffectPrimitive;
    out.push({
      impactTick: imp.impactTick,
      targetId: imp.targetId,
      effects: [{ kind: 'direct', amount: effect.amount }],
    });
  }
  return out;
}

/** A live creep for targeting: positive-hp, position-valid, reachable. */
interface LiveCreep {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly dist: number;
}

/** A creep is live iff its hp is a positive safe integer. */
function isLiveHp(hp: unknown): boolean {
  return Number.isSafeInteger(hp) && (hp as number) > 0;
}

/**
 * The index of the live creep matching `targetId` under the shared
 * first-matching-valid-row rule (mirrors `findValidTowerIndex`): the FIRST SoA row
 * whose id is `targetId`, whose hp is a positive safe integer, and whose position is
 * valid. Duplicate/forged ids resolve to that first row, so target-hold checks and
 * impact application always agree. Returns -1 when absent.
 */
function findLiveCreep(creeps: CombatCreeps, targetId: number, grid: Grid): number {
  for (let i = 0; i < creeps.id.length; i++) {
    if (creeps.id[i] !== targetId) continue;
    if (!isLiveHp(creeps.hp[i])) continue;
    const geom = deriveValidCreepPosition(
      creeps.fromX[i],
      creeps.fromY[i],
      creeps.headCol[i],
      creeps.headRow[i],
      creeps.progress[i],
      grid,
    );
    if (geom !== null) return i;
  }
  return -1;
}

/** Apply one effect to a creep row; direct damage is branch-saturating (no underflow). */
function applyEffect(creeps: CombatCreeps, idx: number, effect: EffectPrimitive): void {
  if (effect.kind === 'direct') {
    const hp = creeps.hp[idx] as number;
    // Subtraction runs only when amount < hp, so the result is always a positive
    // safe integer — never a raw subtraction that could pass MIN_SAFE_INTEGER.
    creeps.hp[idx] = effect.amount >= hp ? 0 : hp - effect.amount;
  }
}

/** True iff a creep point is within RANGE of a tower centre (inclusive, no sqrt). */
function inRange(cx: number, cy: number, towerX: number, towerY: number): boolean {
  const dx = cx - towerX;
  const dy = cy - towerY;
  if (Math.abs(dx) > RANGE || Math.abs(dy) > RANGE) return false; // overflow-proof early-out
  return dx * dx + dy * dy <= RANGE * RANGE;
}

/** Add `KILL_BOUNTY`, with the same safe-integer no-op-on-overflow guard as refunds. */
function creditKill(bounty: number): number {
  if (Number.isSafeInteger(bounty) && bounty <= Number.MAX_SAFE_INTEGER - KILL_BOUNTY) {
    return bounty + KILL_BOUNTY;
  }
  return bounty;
}

/**
 * Run the combat phase for one tick over the POST-MOVE world. Returns the new creep
 * SoA (dead creeps swept), the surviving impact queue, and the updated bounty;
 * mutates `towers.targetId`/`towers.nextFireTick` in place (by source row) and
 * `creeps.hp` during resolution. `tick` is the pre-increment `state.tick`.
 *
 * Order (PLAN §13): resolve due impacts → sweep dead + credit bounty → per-tower
 * target + fire. Impacts with `impactTick <= tick` resolve (draining forged overdue
 * entries too) in queue array-iteration order — a deterministic total order.
 */
export function runCombat(
  creeps: CombatCreeps,
  towers: TowerArrays,
  impacts: readonly unknown[],
  tick: number,
  bounty: number,
  field: DistanceField,
  grid: Grid,
): { creeps: CombatCreeps; impacts: Impact[]; bounty: number } {
  const canonical = canonicalImpacts(impacts);

  // (1) RESOLVE due impacts; keep the rest. Track creeps an impact kills THIS tick
  //     (positive hp → 0) so only those earn bounty — a forged non-positive-hp row
  //     is swept with no bounty.
  const kept: Impact[] = [];
  const killedByImpact = new Set<number>();
  for (const imp of canonical) {
    if (imp.impactTick > tick) {
      kept.push(imp);
      continue;
    }
    const idx = findLiveCreep(creeps, imp.targetId, grid); // -1 ⇒ wasted shot
    if (idx === -1) continue;
    for (const effect of imp.effects) applyEffect(creeps, idx, effect);
    if ((creeps.hp[idx] as number) <= 0) killedByImpact.add(idx);
  }

  // (2) SWEEP dead (hp ≤ 0 or non-safe) into a fresh SoA; credit only impact kills.
  let nextBounty = bounty;
  const survivors = emptyCreeps();
  for (let i = 0; i < creeps.id.length; i++) {
    if (!isLiveHp(creeps.hp[i])) {
      if (killedByImpact.has(i)) nextBounty = creditKill(nextBounty);
      continue;
    }
    survivors.id.push(creeps.id[i] as number);
    survivors.hp.push(creeps.hp[i] as number);
    survivors.fromX.push(creeps.fromX[i] as number);
    survivors.fromY.push(creeps.fromY[i] as number);
    survivors.headCol.push(creeps.headCol[i] as number);
    survivors.headRow.push(creeps.headRow[i] as number);
    survivors.progress.push(creeps.progress[i] as number);
  }

  // (3) Precompute the targetable live creeps once (position-valid + reachable).
  const live: LiveCreep[] = [];
  for (let i = 0; i < survivors.id.length; i++) {
    const geom = deriveValidCreepPosition(
      survivors.fromX[i],
      survivors.fromY[i],
      survivors.headCol[i],
      survivors.headRow[i],
      survivors.progress[i],
      grid,
    );
    if (geom === null) continue;
    const d = distAt(field, geom.occupancyCell.col, geom.occupancyCell.row);
    if (d < 0) continue; // unreachable cell can never be the "first" target
    live.push({ id: survivors.id[i] as number, x: geom.point.x, y: geom.point.y, dist: d });
  }

  // (4) Per valid tower: hold-or-acquire the sticky "first" target, then fire.
  forEachValidTower(grid, towers, (i, _id, col, row) => {
    // 2×2 footprint centre = the shared corner of its four cells (units-per-tile FP_ONE).
    const towerX = (col + 1) * FP_ONE;
    const towerY = (row + 1) * FP_ONE;

    // One pass over the live creeps resolves BOTH the sticky-hold check and the
    // nearest-in-range acquire: track whether the held lock's first-matching row is
    // in range, and (independently) the best in-range acquire candidate.
    const held =
      Number.isSafeInteger(towers.targetId[i]) && towers.targetId[i] !== 0
        ? (towers.targetId[i] as number)
        : 0;
    let heldSeen = false; // first matching row decides the hold — mirrors findLiveCreep
    let heldInRange = false;
    let best: LiveCreep | null = null;
    for (const c of live) {
      const within = inRange(c.x, c.y, towerX, towerY);
      if (held !== 0 && !heldSeen && c.id === held) {
        heldSeen = true;
        heldInRange = within;
      }
      if (
        within &&
        (best === null || c.dist < best.dist || (c.dist === best.dist && c.id < best.id))
      ) {
        best = c;
      }
    }
    // Hold the locked creep while it is present and in range; otherwise acquire the
    // in-range creep nearest the exit (ties → lower id), or none.
    const target = held !== 0 && heldInRange ? held : best === null ? 0 : best.id;
    towers.targetId[i] = target;

    if (target === 0) return;
    const nft = towers.nextFireTick[i];
    const fireable = !Number.isSafeInteger(nft) || tick >= (nft as number);
    if (!fireable) return;
    if (kept.length >= MAX_IN_FLIGHT_IMPACTS) return; // cap full — retry next tick, no advance
    const impactTick = tick + TRAVEL_TICKS;
    const nextFire = tick + FIRE_INTERVAL;
    if (!Number.isSafeInteger(impactTick) || !Number.isSafeInteger(nextFire)) return; // overflow no-op
    kept.push({
      impactTick,
      targetId: target,
      effects: [{ kind: 'direct', amount: DIRECT_DAMAGE }],
    });
    towers.nextFireTick[i] = nextFire;
  });

  return { creeps: survivors, impacts: kept, bounty: nextBounty };
}
