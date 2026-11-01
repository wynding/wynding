// balance-checks.ts — M3 story 1: the balance checker's section-A checks (docs/milestones/
// m3.md, "What tuned means"), as reusable functions over measured runs. Test/tooling
// support, NOT part of this package's public API — the `showcase-builds.ts` precedent.
//
// Every `check*` function returns its violations as readable strings — empty means the
// check passed — so a test asserts `toEqual([])` and a failure prints what broke, by
// build. They judge; they never run anything (`balance-run.ts` does that).

import type { Cell } from '@wynding/types';
import type { CompiledRuleset } from '@wynding/sim';
import type { BuildRun } from './balance-run';
import { waveIndexForCreep } from './wave-lookup';

/** M2's distinctness floor: each of a build's top-two tower ids by spend carries at least
 *  this share of that build's own spend. */
export const TOP_TWO_SPEND_SHARE_FLOOR = 0.25;

/** A build's tower ids ordered by bounty spent on each, descending; ties break on the id
 *  so the order is total and reproducible (M2's `idsBySpend`). */
export function idsBySpend(spendById: Readonly<Record<string, number>>): string[] {
  return Object.keys(spendById).sort((a, b) => spendById[b]! - spendById[a]! || a.localeCompare(b));
}

/**
 * M2's structural-distinctness rule across a set of builds: no tower id is in the top two
 * by spend of more than one build, and each build's own top-two ids each carry at least
 * {@link TOP_TWO_SPEND_SHARE_FLOOR} of its spend.
 */
export function checkDistinctness(
  builds: readonly { readonly id: string; readonly spendById: Readonly<Record<string, number>> }[],
): string[] {
  const violations: string[] = [];
  const topTwo = builds.map((b) => idsBySpend(b.spendById).slice(0, 2));
  builds.forEach((b, i) => {
    const total = Object.values(b.spendById).reduce((sum, v) => sum + v, 0);
    for (const id of topTwo[i]!) {
      const share = b.spendById[id]! / total;
      if (share < TOP_TWO_SPEND_SHARE_FLOOR) {
        violations.push(
          `${b.id}: top-two id '${id}' is ${(share * 100).toFixed(1)}% of its spend, under 25%`,
        );
      }
    }
    for (let j = i + 1; j < builds.length; j++) {
      for (const id of topTwo[i]!.filter((t) => topTwo[j]!.includes(t))) {
        violations.push(`${b.id} and ${builds[j]!.id} share top-two id '${id}'`);
      }
    }
  });
  return violations;
}

/** Every sell the run applied while a creep was on the board — A1 requires a winner to
 *  win without one, so juggling is never the only way to win. */
export function checkNoSellWithLiveCreep(id: string, run: BuildRun): string[] {
  return run.sells
    .filter((s) => s.creepsAlive > 0)
    .map(
      (s) =>
        `${id}: sold the ${s.towerId} at (${s.col},${s.row}) on tick ${s.tick} with ${s.creepsAlive} creep(s) alive`,
    );
}

/** M2-style plausibility floors for a losing build — each optional, each checked only
 *  when set. A loser that clears them spent its income and engaged the arc, so its loss
 *  says something about what it lacks rather than that it declined to play. */
export interface PlausibilityFloors {
  /** Total bounty spent on placements. */
  readonly minSpend?: number;
  /** Spend as a share of all the bounty the run ever received (spend + what is left). */
  readonly minSpentShare?: number;
  /** Distinct tower ids placed. */
  readonly minTowerKinds?: number;
  readonly minKills?: number;
  /** The first wave that spawns this creep id must have launched — located by creep id,
   *  never by wave index (M2's de-indexing). */
  readonly reachesWaveOf?: string;
}

export function checkPlausibility(
  id: string,
  run: BuildRun,
  ruleset: CompiledRuleset,
  floors: PlausibilityFloors,
): string[] {
  const violations: string[] = [];
  const below = (what: string, value: number, floor: number | undefined, shown = String(value)) => {
    if (floor !== undefined && value < floor)
      violations.push(`${id}: ${what} ${shown}, under ${floor}`);
  };
  below('spend', run.spend, floors.minSpend);
  const share = run.spend / (run.spend + run.state.bounty);
  below('spent share', share, floors.minSpentShare, share.toFixed(3));
  below('tower kinds', Object.keys(run.spendById).length, floors.minTowerKinds);
  below('kills', run.kills, floors.minKills);
  if (floors.reachesWaveOf !== undefined) {
    const wave = waveIndexForCreep(ruleset, floors.reachesWaveOf);
    if (run.state.waveLaunchTick[wave] === null) {
      violations.push(
        `${id}: never launched wave ${wave + 1}, the first with '${floors.reachesWaveOf}'`,
      );
    }
  }
  return violations;
}

/** Where a losing run lost. A loss is LOCATED by the creeps that took the last lives —
 *  their own wave, from the sim's `wave` column — not by whichever wave happened to be
 *  counting down when they leaked: a flyer can still be crossing the board after the next
 *  wave launches, and the next wave did nothing to end the run. */
export interface LossLocation {
  readonly tick: number;
  /** The latest wave launched when the run was lost — the wave the player was on. */
  readonly reachedWave: number;
  /** The leaks on the final tick: the creeps that took the last lives, and their waves. */
  readonly fatalLeaks: readonly { readonly creepId: string; readonly wave: number }[];
}

/** `null` unless the run was lost. */
export function locateLoss(run: BuildRun): LossLocation | null {
  if (run.state.phase !== 'lost') return null;
  const tick = run.state.tick - 1;
  return {
    tick,
    reachedWave: run.state.waveCursor - 1,
    fatalLeaks: run.leaks
      .filter((l) => l.tick === tick)
      .map(({ creepId, wave }) => ({ creepId, wave })),
  };
}

/** A span of waves, each end located by creep id — the first wave that spawns it — and
 *  either end left open by omitting it. */
export interface WaveWindow {
  readonly fromWaveOf?: string;
  readonly toWaveOf?: string;
}

/** The run must be LOST, to creeps whose waves all lie inside `window` (both ends
 *  inclusive) — M2's de-indexed "the loser reaches arc wave 8", generalized. */
export function checkLossWindow(
  id: string,
  run: BuildRun,
  ruleset: CompiledRuleset,
  window: WaveWindow,
): string[] {
  const loss = locateLoss(run);
  if (loss === null) return [`${id}: did not lose (${run.state.phase})`];
  const from = window.fromWaveOf === undefined ? 0 : waveIndexForCreep(ruleset, window.fromWaveOf);
  const to =
    window.toWaveOf === undefined
      ? ruleset.waves.length - 1
      : waveIndexForCreep(ruleset, window.toWaveOf);
  return loss.fatalLeaks
    .filter((l) => l.wave < from || l.wave > to)
    .map(
      (l) =>
        `${id}: lost to ${l.creepId} from wave ${l.wave + 1}, outside waves ${from + 1}–${to + 1}`,
    );
}

/** Every creep the schedule spawns — the total-spawn budget's reader. */
export function totalScheduledSpawns(ruleset: CompiledRuleset): number {
  return ruleset.waves.reduce((n, w) => n + w.spawns.length, 0);
}

/** How a two-path build's mazes relate. */
export type PathSharing = 'merged' | 'separate' | 'neither';

/**
 * Tells a build that merges both paths into one maze from one that defends them
 * separately, from each path's cells on the final maze. Two paths share a maze when both
 * streams walk the same cells: MERGED if at least half the shorter path's cells are on
 * the other path too, SEPARATE if at most a tenth are (little more than where they
 * cross), NEITHER in between — so a build counts as one or the other only when it
 * clearly is.
 */
export function classifyPathSharing(a: readonly Cell[], b: readonly Cell[]): PathSharing {
  if (a.length === 0 || b.length === 0) throw new Error('classifyPathSharing: an empty path');
  const key = (c: Cell): string => `${c.col},${c.row}`;
  const onA = new Set(a.map(key));
  const onB = new Set(b.map(key));
  const shared = [...onB].filter((k) => onA.has(k)).length;
  const shorter = Math.min(onA.size, onB.size);
  if (shared * 2 >= shorter) return 'merged';
  if (shared * 10 <= shorter) return 'separate';
  return 'neither';
}
