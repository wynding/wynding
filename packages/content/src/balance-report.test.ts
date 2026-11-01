// balance-report.test.ts — M3 story 1: the balance report's own lines on sets built to hit
// them — a set where nothing wins (a build that sells mid-wave, one that builds only before
// wave 1, one that builds nothing), and a set of winners where the first is a juggler and
// the next never finishes its plan. The registered M2 set's report is
// `balance-calibration.test.ts`'s.

import { describe, it, expect } from 'vitest';
import { compileRuleset } from '@wynding/sim';
import { getBundledRuleset } from './registry';
import { balanceReport } from './balance-report';
import { drawGrid, type ReferenceSet } from './reference-build';
import { M2_PINNED_LOSER, M2_SHOWCASE, M2_WINNER_A, M2_WINNER_B } from './reference-builds';

const ruleset = compileRuleset(getBundledRuleset('wynding-core'), 'field-01');

/** `grid` (as authored) with one more tower drawn over it. */
function withTower(grid: string, col: number, row: number, letter: string): string {
  return grid
    .trim()
    .split(/\n\s*/)
    .map((line, r) =>
      r === row || r === row + 1
        ? `${line.slice(0, col)}${letter}${letter}${line.slice(col + 2)}`
        : line,
    )
    .join('\n');
}

const LOSING_SET: ReferenceSet = {
  ...M2_SHOWCASE,
  id: 'probe',
  builds: [
    { id: 'undefended', summary: 'nothing built', grid: drawGrid(ruleset), order: '' },
    {
      id: 'one-basic',
      summary: 'one basic, before wave 1',
      grid: drawGrid(ruleset, [[2, 10, 'b']]),
      order: 'b2,10',
    },
    {
      ...M2_PINNED_LOSER,
      id: 'seller',
      summary: 'the pinned loser, selling a basic while wave 1 is on the board',
      order: `${M2_PINNED_LOSER.order} -b2,10@650`,
    },
  ],
};

const WINNING_SET: ReferenceSet = {
  ...M2_SHOWCASE,
  id: 'probe-winners',
  builds: [
    {
      ...M2_WINNER_A,
      id: 'juggler',
      summary: 'Winner A, selling and re-placing a basic while wave 1 walks',
      order: M2_WINNER_A.order
        .trim()
        .split(/\s+/)
        .flatMap((step, i) => (i === 7 ? [step, '-b2,10@560', 'b2,10'] : [step]))
        .join(' '),
    },
    {
      ...M2_WINNER_A,
      id: 'incomplete',
      summary: 'Winner A, with a last basic the run ends before',
      grid: withTower(M2_WINNER_A.grid, 2, 2, 'b'),
      order: `${M2_WINNER_A.order} b2,2@40000`,
    },
    M2_WINNER_B,
  ],
};

describe('the balance report', () => {
  it(
    'reports sells, how many came with creeps alive, and that no build won',
    { timeout: 120_000 },
    () => {
      const { text, failures } = balanceReport([LOSING_SET], getBundledRuleset);
      expect(text).toContain('== probe: wynding-core / field-01, seed 0x5eed ==');
      expect(text).toMatch(
        /undefended — nothing built\n {2}lost · .* · last tower never · lost to 1 normal from wave 1 while on wave 2\n/,
      );
      expect(text).toMatch(/one-basic — .*\n {2}lost · .* · last tower before wave 1 · lost to /);
      expect(text).toMatch(
        /seller — .*\n {2}lost · .* · sells 1 \(1 with creeps alive\) · lost to /,
      );
      expect(text).toContain('board-full: no build won without a live sell, so none is strongest');
      expect(failures).toEqual([]);
    },
  );

  it(
    'never names a juggler the strongest build, says when the strongest plan is incomplete, and fails on it',
    { timeout: 120_000 },
    () => {
      const { text, failures } = balanceReport([WINNING_SET], getBundledRuleset);
      // The juggler wins on 10 lives too, and is registered first: without the rule it
      // would be the strongest.
      expect(text).toMatch(
        /juggler — .*\n {2}won · .* · lives 10 · .* · sells 1 \(1 with creeps alive\)/,
      );
      expect(text).toContain(
        'board-full: the strongest build, incomplete (won on 10 lives), plan incomplete (40/41)',
      );
      expect(failures).toEqual(['probe-winners/incomplete: ran 40 of its 41 steps']);
    },
  );

  it('fails when no reference set is registered', () => {
    expect(balanceReport([], getBundledRuleset).failures).toEqual([
      'no reference sets are registered',
    ]);
  });
});
