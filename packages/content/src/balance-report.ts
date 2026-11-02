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
// placement, unless its plan never finished. Then each honest winner's share of spend on
// anti-air (M3 story 8), and, where the set names them, its juggling build's result beside
// the honest winners' (`juggling`) and whether its centre-only anti-air build survives the
// waves that fly two lanes at once (`centreAntiAir`). A set that draws its board full
// (`fullBoard`) then gets the board's capacity in bounty and the wave whose income first
// covers it (`balance-capacity.ts`): where the strongest build would place its last tower
// once the schedule is long enough to fill the board.
//
// Beside the text it returns what makes the report untrustworthy — no set registered, a set
// with no builds, a build whose plan didn't finish or whose run never ended, a juggling or
// centre-only build that is not one of the set's builds, a juggling build that never sold
// with a creep alive, or a capacity drawing the sim will not take as drawn
// (`placeCapacityDrawing`: a sell, a refused tower, a creep on the board before it stands)
// or that does not draw the strongest build (the towers it places must begin with that
// build's), whose price is still printed — so the command can fail.

import {
  compileRuleset,
  deriveScore,
  deriveStars,
  resolveCreepLeakCost,
  type CompiledRuleset,
} from '@wynding/sim';
import type { Ruleset } from '@wynding/types';
import { compileReferenceBuild, type ReferenceBuild, type ReferenceSet } from './reference-build';
import { runReferenceBuild, type BuildRun } from './balance-run';
import {
  checkAllStepsRan,
  checkCommandBudgets,
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

type Entry = { readonly build: ReferenceBuild; readonly run: BuildRun };

/** The builds that won without a sell while a creep was alive — A1's winners. */
function honestWinners(runs: readonly Entry[]): Entry[] {
  return runs.filter(
    (e) => e.run.state.phase === 'won' && checkNoSellWithLiveCreep(e.build.id, e.run).length === 0,
  );
}

/** `part` of `whole` as a whole percent. */
function percent(part: number, whole: number): string {
  return `${whole > 0 ? Math.round((part * 100) / whole) : 0}%`;
}

/** How much of each honest winner's spend went on anti-air — the towers that hit only
 *  flyers, then every tower that can hit one (m3.md's flag that every winner carries
 *  `antiair`; the owner asked how heavily winning leans on it). */
function antiAirLines(runs: readonly Entry[], ruleset: CompiledRuleset): string[] {
  const winners = honestWinners(runs);
  if (winners.length === 0) return [];
  const spentWhere = (run: BuildRun, domains: readonly string[]) =>
    Object.entries(run.spendById)
      .filter(([id]) => domains.includes(ruleset.towerById[id]?.attack?.domain ?? 'none'))
      .reduce((n, [, spend]) => n + spend, 0);
  return [
    'anti-air share of spend — on towers that hit only flyers, then on every tower that can hit one:',
    ...winners.map(({ build, run }) => {
      const only = spentWhere(run, ['air']);
      const any = spentWhere(run, ['air', 'both']);
      return `  ${build.id}: ${only} of ${run.spend} (${percent(only, run.spend)}), ${any} (${percent(any, run.spend)})`;
    }),
  ];
}

/** The juggling build's line beside the honest winners' (m3.md, B). Its spend counts every
 *  placement, re-placements too (M2's measure), so the line also gives it net of what its
 *  sells refunded: ⌊refundNum / refundDen⌋ of each sold tower's cost, the sim's rule. */
function jugglingLines(entry: Entry, runs: readonly Entry[], ruleset: CompiledRuleset): string[] {
  const { build, run } = entry;
  const { refundNum, refundDen } = ruleset.balance;
  const refunds = run.sells.reduce(
    (n, s) => n + Math.floor((ruleset.towerById[s.towerId]!.cost * refundNum) / refundDen),
    0,
  );
  const live = run.sells.filter((s) => s.creepsAlive > 0).length;
  const result = (r: BuildRun) =>
    `${r.state.phase} on ${r.state.lives} lives (${deriveStars(r.state, ruleset)}★)`;
  const beside = honestWinners(runs).map(
    ({ build: b, run: r }) => `${b.id} ${result(r)}, spend ${r.spend}`,
  );
  const { place, sell } = run.commands;
  return [
    `juggling: ${build.id} ${result(run)} — ${run.sells.length} sells, ${live} with creeps alive; spend ${run.spend}, ${run.spend - refunds} net of refunds; ${place + sell} tower commands, ${place} of them placements`,
    `  beside the honest winners: ${beside.length > 0 ? beside.join('; ') : 'none'}`,
  ];
}

/** The first wave that flies more than one air lane at once — block 3's two-lane air,
 *  located by content: flyers from two entrances or more. `null` if none does. */
export function firstMultiLaneAirWave(ruleset: CompiledRuleset): number | null {
  const wave = ruleset.waves.findIndex(
    (w) =>
      new Set(
        w.spawns
          .filter((s) => ruleset.creepById[s.creepId]?.domain === 'air')
          .map((s) => s.entrance),
      ).size > 1,
  );
  return wave < 0 ? null : wave;
}

/** Whether the centre-only anti-air build survives the waves that fly both lanes at once
 *  (m3.md, B), with the lives each of those waves' flyers took. */
function centreAntiAirLines(entry: Entry, ruleset: CompiledRuleset): string[] {
  const { build, run } = entry;
  const both = firstMultiLaneAirWave(ruleset);
  if (both === null) return [`centre-only anti-air: ${build.id} — no wave flies two lanes at once`];
  const lost = new Map<number, number>();
  for (const l of run.leaks) {
    if (l.wave < both || ruleset.creepById[l.creepId]?.domain !== 'air') continue;
    lost.set(l.wave, (lost.get(l.wave) ?? 0) + resolveCreepLeakCost(ruleset.creepById, l.creepId));
  }
  const air = [...lost].map(([w, n]) => `wave ${w + 1}: ${n}`).join(', ') || 'none';
  const from = `the air down two lanes at once from wave ${both + 1}`;
  const loss = locateLoss(run);
  const verdict =
    loss === null
      ? `${run.state.phase} on ${run.state.lives} lives — it survives ${from}`
      : loss.reachedWave < both
        ? `lost on wave ${loss.reachedWave + 1}, before ${from}`
        : `lost on wave ${loss.reachedWave + 1} — it does not survive ${from}`;
  return [
    `centre-only anti-air: ${build.id} ${verdict}`,
    `  lives its flyers took from wave ${both + 1} on: ${air}`,
  ];
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
    const antiAir = antiAirLines(runs, ruleset);
    if (antiAir.length > 0) lines.push(...antiAir, '');
    if (set.juggling !== undefined) {
      const entry = runs.find((e) => e.build === set.juggling);
      if (entry === undefined) {
        failures.push(
          `${set.id}: its juggling build, ${set.juggling.id}, is not one of its builds`,
        );
      } else {
        if (checkNoSellWithLiveCreep(entry.build.id, entry.run).length === 0) {
          failures.push(
            `${set.id}/${entry.build.id}: the juggling build never sold with a creep alive`,
          );
        }
        failures.push(...checkCommandBudgets(`${set.id}/${entry.build.id}`, entry.run));
        lines.push(...jugglingLines(entry, runs, ruleset), '');
      }
    }
    if (set.centreAntiAir !== undefined) {
      const entry = runs.find((e) => e.build === set.centreAntiAir);
      if (entry === undefined) {
        failures.push(
          `${set.id}: its centre-only anti-air build, ${set.centreAntiAir.id}, is not one of its builds`,
        );
      } else {
        lines.push(...centreAntiAirLines(entry, ruleset), '');
      }
    }
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
