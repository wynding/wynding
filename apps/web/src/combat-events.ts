// combat-events.ts — what one sim step did that the board shows as combat feedback (visual pass
// C1/C2, #181): which creeps it killed and how many it leaked, which flyer each targeted impact
// struck, and which shots in flight lost their tower. Pure and Phaser-free; the controller calls
// it once per tick, beside the impact points it already collects (`controller.ts`).
//
// THE STEP REPORTS WHAT IT DID; NOTHING HERE GUESSES IT. The sim names, for a caller that asks,
// the creeps it killed (`StepEvents.killed`), the creeps that leaked (`StepEvents.leaked`) and the
// creep each targeted impact struck (`StepEvents.impactPoints`' `targetId`). Those are output-only
// events, never new sim state: never hash-relevant, never saved, and invisible to determinism
// and replay. All a view model still answers about a creep is where and how the board last drew
// a kill, so its burst shows as the player last saw it. Which shots lost their tower is read
// from the towers either side of a step.

import {
  creepLook,
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
import type { CompiledRuleset, StepEvents } from '@wynding/sim';

/** One creep a step killed, as the step reports it (`StepEvents.killed`). */
export type StepKill = NonNullable<StepEvents['killed']>[number];

/** One impact point, as the step reports it (`StepEvents.impactPoints`): a targeted one names the
 *  creep it struck (`targetId`), a blast names none. */
export type StepImpactPoint = StepEvents['impactPoints'][number];

/** What one step removed from the board, as feedback shows it. */
export interface StepOutcome {
  /** The creeps it killed, each where the board last drew it. */
  readonly kills: KillVM[];
  /** How many creeps reached the exit: the ids the step named as leaked. */
  readonly leaks: number;
}

/**
 * The kills and leaks of the step from `before`, as the step reports them: `killed`, every creep
 * its combat phase killed (`StepEvents.killed`), and `leaked`, the ids its movement phase removed
 * at the exit (`StepEvents.leaked`).
 *
 * Each kill carries the bounty the step credited for it and its position and look. A creep the
 * view model before the step drew keeps where it was drawn and the look it was drawn with, so its
 * burst shows where the player last saw it. A creep that view model did not draw — one the step
 * spawned and killed inside itself, which no view model either side holds — takes the position
 * the step left it at and the look its catalog id gives (`creepLook`, the joins `deriveViewModel`
 * draws every creep with).
 */
export function stepOutcome(
  before: RenderVM,
  killed: readonly StepKill[],
  leaked: readonly number[],
  ruleset: CompiledRuleset,
): StepOutcome {
  const leaks = leaked.length;
  if (killed.length === 0) return { kills: [], leaks };
  const drawn = new Map<number, CreepVM>();
  for (const c of before.creeps) drawn.set(c.id, c);
  return {
    kills: killed.map((k): KillVM => {
      const was = drawn.get(k.id);
      const look: CreepLookVM = was ?? creepLook(ruleset, k.creepId);
      const at = was ?? k;
      return {
        id: k.id,
        x: at.x,
        y: at.y,
        creepId: look.creepId,
        domain: look.domain,
        boss: look.boss,
        bounty: k.bounty,
      };
    }),
    leaks,
  };
}

/**
 * The step's impact points, each targeted one that struck a FLYER marked with that creep's look
 * (`SparkPoint.flyer`), so the board draws its spark on the flyer's lifted body rather than at the
 * true point the sim reports beneath it. Blast landings and impacts on ground creeps pass through
 * unchanged, the same objects, in a list of the function's own.
 *
 * A targeted point names the creep it struck (`targetId`). That creep is either still on the board
 * after the step, in `after`, or one the step killed, in `kills` (`stepOutcome`): the point is a
 * flyer's when that creep flies.
 */
export function markFlyerSparks(
  points: readonly StepImpactPoint[],
  after: RenderVM,
  kills: readonly KillVM[],
): SparkPoint[] {
  if (!points.some((p) => p.targetId !== undefined)) return [...points];
  const flyers = new Map<number, CreepLookVM>();
  for (const c of after.creeps) if (c.domain === 'air') flyers.set(c.id, c);
  for (const k of kills) if (k.domain === 'air') flyers.set(k.id, k);
  // With no flyer standing and none killed, no impact struck one: every point passes through.
  if (flyers.size === 0) return [...points];
  return points.map((p) => {
    const hit = p.targetId === undefined ? undefined : flyers.get(p.targetId);
    if (hit === undefined) return p;
    return { ...p, flyer: { creepId: hit.creepId, boss: hit.boss } };
  });
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
