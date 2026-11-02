// balance-report.ts — M3 story 1: the balance report, section B of "What tuned means"
// (docs/milestones/m3.md) as terminal text. Test/tooling support, NOT part of this
// package's public API — `balance-cli.ts` prints it (`pnpm --filter @wynding/content run
// balance`), and `balance-calibration.test.ts` reads it.
//
// For every registered reference build: one summary line, then the per-wave pressure
// profile `balance-run.ts` measures. After each set: the board-full wave of its strongest
// build — the build that won on the most lives (then the highest score), leaving out any
// that sold with a creep alive (the juggling build is reported beside the honest
// winners, never as one) — which is the wave whose window held that build's last
// placement, unless its plan never finished. A set that draws its board full (`fullBoard`)
// then gets the board's capacity in bounty and the wave whose income first covers it
// (`balance-capacity.ts`): where the strongest build would place its last tower once the
// schedule is long enough to fill the board.
//
// Beside the text it returns what makes the report untrustworthy — no set registered, a set
// with no builds, a build whose plan didn't finish or whose run never ended, or a capacity
// drawing the sim will not take as drawn (`placeCapacityDrawing`: a sell, a refused tower, a
// creep on the board before it stands) or that does not draw the strongest build (the towers
// it places must begin with that build's), whose price is still printed — so the command can
// fail.

import { compileRuleset, deriveScore, deriveStars, type CompiledRuleset } from '@wynding/sim';
import type { Ruleset } from '@wynding/types';
import { compileReferenceBuild, type ReferenceBuild, type ReferenceSet } from './reference-build';
import { runReferenceBuild, type BuildRun } from './balance-run';
import {
  checkAllStepsRan,
  checkNoSellWithLiveCreep,
  idsBySpend,
  locateLoss,
} from './balance-checks';
import {
  drawnCapacity,
  firstWaveCovering,
  placeCapacityDrawing,
  scheduleIncome,
} from './balance-capacity';

/** Where a placement fell: a wave's window as the arc numbers it, before the first, or
 *  nowhere. */
function placementLabel(wave: number | null): string {
  if (wave === null) return 'never';
  return wave < 0 ? 'before wave 1' : `in wave ${wave + 1}`;
}

function summaryLine(run: BuildRun, ruleset: CompiledRuleset): string {
  const { state } = run;
  const parts = [
    state.phase,
    `tick ${state.tick}`,
    `lives ${state.lives}`,
    `score ${deriveScore(state, ruleset)}`,
    `${deriveStars(state, ruleset)}★`,
    `steps ${run.stepsDone}/${run.stepCount}`,
    `spend ${run.spend}`,
    `kills ${run.kills}`,
    `peak alive ${run.peakAlive}`,
    `last tower ${placementLabel(run.lastPlacementWave)}`,
  ];
  if (run.sells.length > 0) {
    const live = run.sells.filter((s) => s.creepsAlive > 0).length;
    parts.push(`sells ${run.sells.length} (${live} with creeps alive)`);
  }
  const loss = locateLoss(run);
  if (loss !== null) {
    const counts = new Map<string, number>();
    for (const l of loss.fatalLeaks) {
      const key = `${l.creepId} from wave ${l.wave + 1}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const fatal = [...counts].map(([key, n]) => `${n} ${key}`).join(', ');
    parts.push(`lost to ${fatal} while on wave ${loss.reachedWave + 1}`);
  }
  return parts.join(' · ');
}

const COLUMNS = ['wave', 'leaks', 'lost', 'lives', 'closest', 'towers', 'unspent', 'peak'];
const WIDTHS = [4, 5, 4, 5, 7, 8, 7, 4];

function tableRow(cells: readonly string[]): string {
  return cells.map((c, i) => c.padStart(WIDTHS[i]!)).join(' ');
}

function profileTable(run: BuildRun): string[] {
  return [
    tableRow(COLUMNS),
    ...run.waves.map((w) =>
      tableRow([
        String(w.wave + 1),
        String(w.leaks),
        String(w.livesLost),
        String(w.lives),
        w.closestApproach === null ? '-' : closestText(w.closestApproach),
        `${w.towers} +${w.placed}`,
        String(w.unspent),
        String(w.peakAlive),
      ]),
    ),
  ];
}

/** A closest approach to two places — but a near miss above 0 reads `<0.01`, never `0.00`,
 *  because the legend keeps `0` for a leak. */
export function closestText(fraction: number): string {
  return fraction > 0 && fraction < 0.005 ? '<0.01' : fraction.toFixed(2);
}

/** The build that won on the most lives, then the highest score, never selling with a
 *  creep alive; first wins a tie. `null` if no build qualifies. */
export function strongest(
  runs: readonly { readonly build: ReferenceBuild; readonly run: BuildRun }[],
  ruleset: CompiledRuleset,
): { readonly build: ReferenceBuild; readonly run: BuildRun } | null {
  let best: { readonly build: ReferenceBuild; readonly run: BuildRun } | null = null;
  for (const entry of runs) {
    const { state } = entry.run;
    if (state.phase !== 'won' || checkNoSellWithLiveCreep(entry.build.id, entry.run).length > 0) {
      continue;
    }
    if (
      best === null ||
      state.lives > best.run.state.lives ||
      (state.lives === best.run.state.lives &&
        deriveScore(state, ruleset) > deriveScore(best.run.state, ruleset))
    ) {
      best = entry;
    }
  }
  return best;
}

/** The board-full line for one set's runs. */
function boardFullLine(
  runs: readonly { readonly build: ReferenceBuild; readonly run: BuildRun }[],
  ruleset: CompiledRuleset,
): string {
  const best = strongest(runs, ruleset);
  if (best === null) return 'board-full: no build won without a live sell, so none is strongest';
  const { run } = best;
  const where =
    run.stepsDone < run.stepCount
      ? `plan incomplete (${run.stepsDone}/${run.stepCount})`
      : `placed its last tower ${placementLabel(run.lastPlacementWave)}`;
  return `board-full: the strongest build, ${best.build.id} (won on ${run.state.lives} lives), ${where}`;
}

/** The towers `build` places, each anchor once, in the order it first builds on them — its
 *  maze, without the timing or a juggle's sell and re-place. */
function mazeOrder(build: ReferenceBuild, ruleset: CompiledRuleset): string[] {
  const order: string[] = [];
  for (const step of compileReferenceBuild(build, ruleset)) {
    if (step.kind === 'sell') continue;
    const key = `${step.towerId} ${step.col},${step.row}`;
    if (!order.includes(key)) order.push(key);
  }
  return order;
}

/** What makes `full` no drawing of the strongest build, `best`: the towers it places must
 *  begin with that build's, tower for tower and in order (each anchor once, its timing
 *  ignored), so the capacity priced is a drawing of that build's maze. Nothing to check when
 *  no build is strongest; the board-full line already says so. */
export function checkDrawsStrongest(
  label: string,
  full: ReferenceBuild,
  best: { readonly build: ReferenceBuild } | null,
  ruleset: CompiledRuleset,
): string[] {
  if (best === null) return [];
  const drawn = mazeOrder(full, ruleset);
  const built = mazeOrder(best.build, ruleset);
  if (built.every((tower, i) => drawn[i] === tower)) return [];
  return [
    `${label}: the capacity drawing does not draw the strongest build, ${best.build.id} — its towers do not begin with that build's`,
  ];
}

/** The capacity lines for a set that draws its board full (`balance-capacity.ts`): what the
 *  drawing holds, and the wave whose income first covers it, without and with early calls. */
function capacityLines(full: ReferenceBuild, ruleset: CompiledRuleset): string[] {
  const { towers, bounty, spendById } = drawnCapacity(full, ruleset);
  const mix = idsBySpend(spendById)
    .map((id) => `${id} ${spendById[id]}`)
    .join(', ');
  const income = scheduleIncome(ruleset);
  const last = income[income.length - 1]!;
  const covered = (withCalls: boolean, what: string): string => {
    const wave = firstWaveCovering(income, bounty, withCalls);
    if (wave !== null) return `  ${what} covers it by the end of wave ${wave + 1}`;
    const reached = withCalls ? last.earnedWithCalls : last.earned;
    return `  ${what} reaches ${reached} by the end of wave ${last.wave + 1}, short of it`;
  };
  return [
    `capacity: ${full.id} draws ${towers} towers worth ${bounty} bounty — ${mix}`,
    covered(false, 'income (every kill and clear bonus)'),
    covered(true, 'income with every early call at its maximum'),
  ];
}

export interface BalanceReport {
  readonly text: string;
  /** What makes the report untrustworthy; the command fails on any. */
  readonly failures: readonly string[];
}

/** How the report measures one build: a fresh run of its plan (`balance-run.ts`). */
export type MeasureBuild = (
  build: ReferenceBuild,
  ruleset: CompiledRuleset,
  seed: number,
) => BuildRun;

const runBuild: MeasureBuild = (build, ruleset, seed) =>
  runReferenceBuild(ruleset, seed, compileReferenceBuild(build, ruleset));

/** Run every build of every set and render the report. `load` returns a bundled ruleset
 *  by id — the registry in tests, the on-disk artifact from the command line. `measure`
 *  runs a build; a test that has already run a set's builds on the same bundle and seed
 *  passes its own runs, so a whole-arc report is not simulated twice. */
export function balanceReport(
  sets: readonly ReferenceSet[],
  load: (rulesetId: string) => Ruleset,
  measure: MeasureBuild = runBuild,
): BalanceReport {
  const failures: string[] = [];
  if (sets.length === 0) failures.push('no reference sets are registered');
  const lines: string[] = [
    "Per wave — leaks, lost (lives): the wave's own creeps · closest: the smallest fraction of",
    'its empty-board distance any of them still had to cover (0 = a leak) · lives, towers',
    "(+placed), unspent, peak (creeps alive): the board over the wave's window, launch to next",
    '',
  ];
  for (const set of sets) {
    if (set.builds.length === 0) failures.push(`${set.id}: the set has no builds`);
    const ruleset = compileRuleset(load(set.rulesetId), set.boardId);
    lines.push(
      `== ${set.id}: ${set.rulesetId} / ${set.boardId}, seed 0x${set.seed.toString(16)} ==`,
      '',
    );
    const runs = set.builds.map((build) => ({ build, run: measure(build, ruleset, set.seed) }));
    for (const { build, run } of runs) {
      lines.push(`${build.id} — ${build.summary}`, `  ${summaryLine(run, ruleset)}`);
      lines.push(...profileTable(run).map((l) => `  ${l}`), '');
      failures.push(...checkAllStepsRan(`${set.id}/${build.id}`, run));
    }
    lines.push(boardFullLine(runs, ruleset), '');
    if (set.fullBoard !== undefined) {
      const label = `${set.id}/${set.fullBoard.id}`;
      failures.push(...placeCapacityDrawing(label, set.fullBoard, ruleset, set.seed).failures);
      failures.push(
        ...checkDrawsStrongest(label, set.fullBoard, strongest(runs, ruleset), ruleset),
      );
      lines.push(...capacityLines(set.fullBoard, ruleset), '');
    }
  }
  return { text: lines.join('\n'), failures };
}
