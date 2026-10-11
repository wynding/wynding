// combat-events.ts — what one sim step did that the board shows as combat feedback (visual pass
// C1/C2, #181): which creeps it killed and how many it leaked, which flyer each targeted impact
// struck, and which shots in flight lost their tower. Pure and Phaser-free; the controller calls
// it once per tick, beside the impact points it already collects (`controller.ts`).
//
// NOTHING HERE IS NEW SIM STATE. Every answer is read from what the controller already holds:
// the view models either side of the step, the ids the step reports as leaked (the optional
// presentational `StepEvents.leaked`, never hash-relevant), the bounty column it credits a kill
// from, its impact points and the shots it fired. Determinism and replay never see any of it.

import {
  footprintCentreFp,
  fpPointKey,
  isDetonation,
  type CreepLookVM,
  type CreepVM,
  type KillVM,
  type RenderVM,
  type SparkPoint,
  type TowerVM,
  type TracerVM,
} from '@wynding/render';
import type { SimState } from '@wynding/sim';

/** What one step removed from the board, as feedback shows it. */
export interface StepOutcome {
  /** The creeps it killed, each where it stood as the step began. */
  readonly kills: KillVM[];
  /** How many creeps reached the exit: the ids the step named as leaked. */
  readonly leaks: number;
}

/** A creep's id paired with the bounty its kill pays — the sim's per-creep `bounty` column, as
 *  it stood before the step (the column the kill sweep credits). */
export type BountyOf = (creepId: number) => number;

/**
 * The creeps the step from `before` to `after` removed, sorted into leaks and kills.
 *
 * A creep in `before` and not in `after` either reached the exit (the movement phase removes
 * it) or was killed (the combat phase sweeps it). (The sim also removes a row it finds corrupt,
 * with no leak and no bounty; no genuine run makes one, and one would read here as a kill.) The
 * step itself says which: `leaked`, the entity ids its movement phase removed as leaks
 * (`StepEvents.leaked`). So a vanished creep whose id is named there leaked, every other is a
 * kill, and the leak count is the number of ids the step named.
 * Each kill carries its look, its position as the step began (where the board last drew it)
 * and the bounty the sweep credited for it: the creep's own `bounty` column, which the sim sets
 * from the catalog at spawn and never changes — `bountyOf` reads it as it stood before the step,
 * and a value the sweep would not credit (not a whole number, or below zero) reads as 0.
 */
export function stepOutcome(
  before: RenderVM,
  after: RenderVM,
  leaked: readonly number[],
  bountyOf: BountyOf,
): StepOutcome {
  const leaks = leaked.length;
  if (before.creeps.length === 0) return { kills: [], leaks };
  const gone = vanished(before.creeps, after.creeps);
  if (gone.length === 0) return { kills: [], leaks };
  const left = new Set(leaked);
  return {
    kills: gone
      .filter((c) => !left.has(c.id))
      .map((c) => {
        const b = bountyOf(c.id);
        return {
          id: c.id,
          x: c.x,
          y: c.y,
          creepId: c.creepId,
          domain: c.domain,
          boss: c.boss,
          bounty: Number.isSafeInteger(b) && b > 0 ? b : 0,
        };
      }),
    leaks,
  };
}

/** Whether every creep in `creeps` has a higher entity id than the one before it. */
function risingIds(creeps: readonly CreepVM[]): boolean {
  for (let i = 1; i < creeps.length; i++) {
    if (!((creeps[i] as CreepVM).id > (creeps[i - 1] as CreepVM).id)) return false;
  }
  return true;
}

/**
 * The creeps in `before` that are not in `after`, in `before`'s order. Called once a tick, so
 * it walks rather than builds a set: the sim keeps its creep rows in the order they spawned (it
 * compacts a removed row out and appends each new creep) and gives each new creep a higher
 * entity id than any before it, so both lists run in rising id order and one walk down the two
 * finds every creep that vanished. Lists that do not (a forged state's) take the set.
 */
function vanished(before: readonly CreepVM[], after: readonly CreepVM[]): CreepVM[] {
  const gone: CreepVM[] = [];
  if (!risingIds(before) || !risingIds(after)) {
    const still = new Set<number>();
    for (const c of after) still.add(c.id);
    for (const c of before) if (!still.has(c.id)) gone.push(c);
    return gone;
  }
  let j = 0;
  for (const c of before) {
    while (j < after.length && (after[j] as CreepVM).id < c.id) j++;
    if (j < after.length && (after[j] as CreepVM).id === c.id) j++;
    else gone.push(c);
  }
  return gone;
}

/**
 * The creeps the next step strikes with a targeted impact, read from the state before it runs:
 * the target of every targeted impact due by its tick. `step` resolves exactly these — an impact
 * lands once `impactTick <= tick`, the tick before the step advances it (`combat.ts`) — and drops
 * them from the queue, so they are read first. One whose creep is gone by then (killed earlier in
 * the same step, or out at the exit) lands on nothing and makes no point.
 */
export function dueTargets(state: Pick<SimState, 'tick' | 'impacts'>): Set<number> {
  const out = new Set<number>();
  for (const imp of state.impacts) {
    if (imp.kind === 'targeted' && imp.impactTick <= state.tick) out.add(imp.targetId);
  }
  return out;
}

/**
 * The step's impact points, each targeted one that struck a FLYER marked with that creep's look
 * (`SparkPoint.flyer`), so the board draws its spark on the flyer's lifted body rather than at
 * the true point the sim reports beneath it. Blast landings and impacts on ground creeps pass
 * through unchanged.
 *
 * A targeted impact's point is where its creep stood when it landed (`combat.ts` reports the
 * creep's position, after the step's movement) — exactly where the view model after the step
 * puts it, if it survived: the same derivation gives both. One that matches no survivor struck a
 * creep the step killed, and a killed creep is reported where the step began, a step's movement
 * back: the kill nearest the point is the one.
 *
 * `struck` holds the entity ids the step's due targeted impacts name (`dueTargets`, read before
 * the step): only those creeps can be what a point matches, so a ground creep and a flyer
 * sharing a point are told apart — unless one step struck both, when every point there takes
 * one of the two looks (no measured run has met it).
 */
export function markFlyerSparks(
  points: readonly SparkPoint[],
  after: RenderVM,
  kills: readonly KillVM[],
  struck: ReadonlySet<number>,
): SparkPoint[] {
  if (!points.some((p) => p.radiusFp === 0)) return [...points];
  // With no flyer standing and none killed, no impact struck one: every point passes through.
  if (!after.creeps.some((c) => c.domain === 'air') && !kills.some((k) => k.domain === 'air')) {
    return [...points];
  }
  const at = new Map<number, CreepVM>();
  for (const c of after.creeps) if (struck.has(c.id)) at.set(fpPointKey(c.x, c.y), c);
  return points.map((p) => {
    if (p.radiusFp !== 0) return p;
    const hit: CreepLookVM | undefined = at.get(fpPointKey(p.x, p.y)) ?? nearest(kills, p, struck);
    if (hit?.domain !== 'air') return p;
    return { ...p, flyer: { creepId: hit.creepId, boss: hit.boss } };
  });
}

function nearest(
  kills: readonly KillVM[],
  p: { x: number; y: number },
  struck: ReadonlySet<number>,
): KillVM | undefined {
  let best: KillVM | undefined;
  let bestD = Infinity;
  for (const k of kills) {
    if (!struck.has(k.id)) continue;
    const d = (k.x - p.x) * (k.x - p.x) + (k.y - p.y) * (k.y - p.y);
    if (d < bestD) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

/** Each tower in `towers` by its footprint centre, where its shots start. */
function byOrigin(towers: readonly TowerVM[]): Map<number, TowerVM> {
  const out = new Map<number, TowerVM>();
  for (const t of towers)
    out.set(fpPointKey(footprintCentreFp(t.col), footprintCentreFp(t.row)), t);
  return out;
}

/**
 * `tracers`, each shot whose tower the step took off the board — sold, or sold and another built
 * on its footprint — given that tower's catalog id (`TracerVM.towerId`), found by its footprint
 * centre in the view model from BEFORE the step. The renderer finds a shot's tower by that
 * centre the first time it sees the shot; once its tower is gone that lookup finds nothing, or
 * the new tower, so the shot carries its own. Called for the shots already in flight as the step
 * began, before its own shots join them: a tower that fires in a step is still standing after it
 * (only a mine removes itself, and its detonation has no shot to style). A tracer that already
 * carries an id keeps it, and so does a mine's detonation, which never needs one. The same list
 * comes back when nothing changed.
 */
export function noteTowerless(tracers: TracerVM[], before: RenderVM, after: RenderVM): TracerVM[] {
  if (tracers.length === 0) return tracers;
  const was = byOrigin(before.towers);
  const now = byOrigin(after.towers);
  let out: TracerVM[] | null = null;
  tracers.forEach((t, i) => {
    if (t.towerId !== undefined || isDetonation(t)) return;
    const key = fpPointKey(t.originX, t.originY);
    const fired = was.get(key);
    if (fired === undefined || now.get(key)?.id === fired.id) return;
    out ??= [...tracers];
    out[i] = { ...t, towerId: fired.towerId };
  });
  return out ?? tracers;
}
