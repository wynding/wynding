// balance-capacity.ts — M3 story 5: the board's CAPACITY in bounty, and when a schedule's
// income reaches it — the measurement behind m3.md's board-full target ("Economy": the wave
// where the strongest build places its last tower, aimed at about wave 24). Test/tooling
// support, NOT part of this package's public API — the `showcase-builds.ts` precedent.
//
// Both halves are arithmetic, never a run:
//   - a drawing's capacity is every tower its grid draws, at catalog cost — a reference
//     set's `fullBoard`, the strongest winner's maze drawn to the whole board at its mix;
//   - a schedule's income is what a run that kills every creep and clears every wave earns
//     by the end of each wave: the starting bounty, then each wave's kill bounty and clear
//     bonus. Beside it, the same with every early call made the tick its countdown starts,
//     `⌊countdown / divisor⌋` (wave 1 pays none: Start claims it) — the most a run can earn.
//
// A reference build never calls early (the runner has no such step), so the first column is
// its own income when it leaks nothing, and the wave that column first covers the capacity
// is where it places its last tower.

import type { CompiledRuleset } from '@wynding/sim';
import { compileReferenceBuild, type ReferenceBuild } from './reference-build';

export interface Capacity {
  readonly towers: number;
  /** Every drawn tower at its catalog cost. */
  readonly bounty: number;
  readonly spendById: Readonly<Record<string, number>>;
}

/** Every tower `build`'s grid draws — each anchor its order places — at catalog cost. */
export function drawnCapacity(build: ReferenceBuild, ruleset: CompiledRuleset): Capacity {
  const drawn = new Map<string, string>();
  for (const step of compileReferenceBuild(build, ruleset)) {
    if (step.kind !== 'sell') drawn.set(`${step.col},${step.row}`, step.towerId);
  }
  const spendById: Record<string, number> = Object.create(null) as Record<string, number>;
  let bounty = 0;
  for (const towerId of drawn.values()) {
    const cost = ruleset.towerById[towerId]!.cost;
    spendById[towerId] = (spendById[towerId] ?? 0) + cost;
    bounty += cost;
  }
  return { towers: drawn.size, bounty, spendById };
}

/** One wave's row of a schedule's income — see this file's header. */
export interface IncomeRow {
  /** The wave's index in the compiled schedule. */
  readonly wave: number;
  /** By the end of this wave: every kill and clear bonus so far, plus the starting bounty. */
  readonly earned: number;
  /** The same, plus every early call so far at its maximum. */
  readonly earnedWithCalls: number;
}

export function scheduleIncome(ruleset: CompiledRuleset): IncomeRow[] {
  const divisor = ruleset.balance.earlyCallBountyDivisor;
  let earned = ruleset.balance.startingBounty;
  let calls = 0;
  return ruleset.waves.map((wave, k) => {
    for (const spawn of wave.spawns) earned += ruleset.creepById[spawn.creepId]!.bounty;
    earned += wave.clearBonus;
    if (k > 0 && divisor > 0) calls += Math.floor(wave.countdownTicks / divisor);
    return { wave: k, earned, earnedWithCalls: earned + calls };
  });
}

/** The first wave by whose end `income` covers `bounty` — `null` if no wave's does. */
export function firstWaveCovering(
  income: readonly IncomeRow[],
  bounty: number,
  withCalls: boolean,
): number | null {
  const row = income.find((r) => (withCalls ? r.earnedWithCalls : r.earned) >= bounty);
  return row === undefined ? null : row.wave;
}
