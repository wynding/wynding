// balance-report.ts — M3 story 1: the balance report, section B of "What tuned means"
// (docs/milestones/m3.md) as terminal text. Test/tooling support, NOT part of this
// package's public API — `balance-cli.ts` prints it (`pnpm --filter @wynding/content run
// balance`), and `balance-calibration.test.ts` reads it.
//
// For every registered reference build: one summary line, then the per-wave pressure
// profile `balance-run.ts` measures. After each set: the board-full wave of its strongest
// build — the build that won on the most lives (then the highest score) — which is the
// wave whose window held that build's last placement.

import { compileRuleset, deriveScore, deriveStars, type CompiledRuleset } from '@wynding/sim';
import type { Ruleset } from '@wynding/types';
import { compileReferenceBuild, type ReferenceBuild, type ReferenceSet } from './reference-build';
import { runReferenceBuild, type BuildRun } from './balance-run';
import { locateLoss } from './balance-checks';

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
        w.closestApproach === null ? '-' : w.closestApproach.toFixed(2),
        `${w.towers} +${w.placed}`,
        String(w.unspent),
        String(w.peakAlive),
      ]),
    ),
  ];
}

/** The build that won on the most lives, then the highest score; first wins a tie.
 *  `null` if no build won. */
function strongest(
  runs: readonly { readonly build: ReferenceBuild; readonly run: BuildRun }[],
  ruleset: CompiledRuleset,
): { readonly build: ReferenceBuild; readonly run: BuildRun } | null {
  let best: { readonly build: ReferenceBuild; readonly run: BuildRun } | null = null;
  for (const entry of runs) {
    const { state } = entry.run;
    if (state.phase !== 'won') continue;
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

/** Run every build of every set and render the report. `load` returns a bundled ruleset
 *  by id — the registry in tests, the on-disk artifact from the command line. */
export function balanceReport(
  sets: readonly ReferenceSet[],
  load: (rulesetId: string) => Ruleset,
): string {
  const lines: string[] = [
    "Per wave — leaks, lost (lives): the wave's own creeps · closest: the smallest fraction of",
    'its empty-board distance any of them still had to cover (0 = a leak) · lives, towers',
    "(+placed), unspent, peak (creeps alive): the board over the wave's window, launch to next",
    '',
  ];
  for (const set of sets) {
    const ruleset = compileRuleset(load(set.rulesetId), set.boardId);
    lines.push(
      `== ${set.id}: ${set.rulesetId} / ${set.boardId}, seed 0x${set.seed.toString(16)} ==`,
      '',
    );
    const runs = set.builds.map((build) => ({
      build,
      run: runReferenceBuild(ruleset, set.seed, compileReferenceBuild(build, ruleset)),
    }));
    for (const { build, run } of runs) {
      lines.push(`${build.id} — ${build.summary}`, `  ${summaryLine(run, ruleset)}`);
      lines.push(...profileTable(run).map((l) => `  ${l}`), '');
    }
    const best = strongest(runs, ruleset);
    lines.push(
      best === null
        ? 'board-full: no build won, so there is no strongest build'
        : `board-full: the strongest build, ${best.build.id} (won on ${best.run.state.lives} ` +
            `lives), placed its last tower ${placementLabel(best.run.lastPlacementWave)}`,
      '',
    );
  }
  return lines.join('\n');
}
