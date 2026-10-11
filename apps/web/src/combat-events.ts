// combat-events.ts — what one sim step did that the board shows as combat feedback (visual pass
// C1/C2, #181): which creeps it killed and how many it leaked, which flyer each targeted impact
// struck, and which shots in flight lost their tower. Pure and Phaser-free; the controller calls
// it once per tick, beside the impact points it already collects (`controller.ts`).
//
// NOTHING HERE IS NEW SIM STATE. Every answer is read from what the controller already holds:
// the view models either side of the step, the sim's own `leakedCount`, the bounty column it
// credits a kill from, its impact points and the shots it fired. Determinism and replay never
// see any of it.

import {
  footprintCentreFp,
  isDetonation,
  type CreepLookVM,
  type CreepVM,
  type KillVM,
  type RenderVM,
  type SparkPoint,
  type TowerVM,
  type TracerVM,
} from '@wynding/render';
import { cellCenterX, cellCenterY } from '@wynding/sim';

/** What one step removed from the board, as feedback shows it. */
export interface StepOutcome {
  /** The creeps it killed, each where it stood as the step began. */
  readonly kills: KillVM[];
  /** How many creeps reached the exit: the sim's `leakedCount` moved by this much. */
  readonly leaks: number;
}

/** A creep's id paired with the bounty its kill pays — the sim's per-creep `bounty` column, as
 *  it stood before the step (the column the kill sweep credits). */
export type BountyOf = (creepId: number) => number;

/**
 * The creeps the step from `before` to `after` removed, sorted into leaks and kills.
 *
 * A creep in `before` and not in `after` either reached the exit (the movement phase removes
 * it and adds one to `leakedCount`) or was killed (the combat phase sweeps it). (The sim also
 * removes a row it finds corrupt, with no leak and no bounty; no genuine run makes one, and one
 * would read here as a kill.) The sim does not say which creep did which, but it does count the
 * leaks exactly: `leaked`, the counter's move over the step. Every leak was within one step of
 * the exit as the step began, so the `leaked` vanished creeps NEAREST the exit — by
 * straight-line distance to its cell's centre, ties in view-model order — are the leaks, and the
 * rest are kills (#181's UAT ledger records the rule).
 * Each kill carries its look, its position as the step began (where the board last drew it)
 * and the bounty the sweep credited for it: the creep's own `bounty` column, which the sim sets
 * from the catalog at spawn and never changes — `bountyOf` reads it as it stood before the step,
 * and a value the sweep would not credit (not a whole number, or below zero) reads as 0.
 */
export function stepOutcome(
  before: RenderVM,
  after: RenderVM,
  leaked: number,
  exit: { readonly col: number; readonly row: number },
  bountyOf: BountyOf,
): StepOutcome {
  // The counter only grows; a move that is not a whole number above zero (a counter the sim
  // holds still at its limit) is no leak.
  const leaks = Number.isSafeInteger(leaked) && leaked > 0 ? leaked : 0;
  if (before.creeps.length === 0) return { kills: [], leaks };
  const still = new Set<number>();
  for (const c of after.creeps) still.add(c.id);
  const gone: CreepVM[] = [];
  for (const c of before.creeps) if (!still.has(c.id)) gone.push(c);
  if (gone.length === 0) return { kills: [], leaks };
  const ex = cellCenterX(exit.col);
  const ey = cellCenterY(exit.row);
  const far = (c: CreepVM): number => (c.x - ex) * (c.x - ex) + (c.y - ey) * (c.y - ey);
  // Nearest the exit first; `sort` is stable, so equal distances keep view-model order.
  const byExit = gone.map((c, i) => ({ c, i, d: far(c) })).sort((a, b) => a.d - b.d || a.i - b.i);
  const killed = byExit.slice(Math.min(leaks, byExit.length)).sort((a, b) => a.i - b.i);
  return {
    kills: killed.map(({ c }) => {
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

/** A key for a fixed-point point, one number: sim coordinates are whole and far below 2^26. */
const pointKey = (x: number, y: number): number => x * 67108864 + y;

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
 */
export function markFlyerSparks(
  points: readonly SparkPoint[],
  after: RenderVM,
  kills: readonly KillVM[],
): SparkPoint[] {
  if (!points.some((p) => p.radiusFp === 0)) return [...points];
  const at = new Map<number, CreepVM>();
  for (const c of after.creeps) at.set(pointKey(c.x, c.y), c);
  return points.map((p) => {
    if (p.radiusFp !== 0) return p;
    const struck: CreepLookVM | undefined = at.get(pointKey(p.x, p.y)) ?? nearest(kills, p);
    if (struck?.domain !== 'air') return p;
    return { ...p, flyer: { creepId: struck.creepId, boss: struck.boss } };
  });
}

function nearest(kills: readonly KillVM[], p: { x: number; y: number }): KillVM | undefined {
  let best: KillVM | undefined;
  let bestD = Infinity;
  for (const k of kills) {
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
  for (const t of towers) out.set(pointKey(footprintCentreFp(t.col), footprintCentreFp(t.row)), t);
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
    const key = pointKey(t.originX, t.originY);
    const fired = was.get(key);
    if (fired === undefined || now.get(key)?.id === fired.id) return;
    out ??= [...tracers];
    out[i] = { ...t, towerId: fired.towerId };
  });
  return out ?? tracers;
}
