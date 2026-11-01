// balance-report.test.ts — M3 story 1: the balance report's own lines on a set built to
// hit them — a build that sells mid-wave, one that builds only before wave 1, one that
// builds nothing, and so a set where nothing wins. The registered M2 set's report is
// `balance-calibration.test.ts`'s.

import { describe, it, expect } from 'vitest';
import { getBundledRuleset } from './registry';
import { balanceReport } from './balance-report';
import type { ReferenceSet } from './reference-build';
import { M2_PINNED_LOSER, M2_SHOWCASE } from './reference-builds';

const EMPTY_GRID = M2_PINNED_LOSER.grid.replace(/[a-z]/g, '.');

/** The empty board with one basic drawn on the anchor (2,10). */
const ONE_BASIC_GRID = EMPTY_GRID.split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .map((line, row) => (row === 10 || row === 11 ? `${line.slice(0, 2)}bb${line.slice(4)}` : line))
  .join('\n');

const LOSING_SET: ReferenceSet = {
  ...M2_SHOWCASE,
  id: 'probe',
  builds: [
    { id: 'undefended', summary: 'nothing built', grid: EMPTY_GRID, order: '' },
    { id: 'one-basic', summary: 'one basic, before wave 1', grid: ONE_BASIC_GRID, order: 'b2,10' },
    {
      ...M2_PINNED_LOSER,
      id: 'seller',
      summary: 'the pinned loser, selling a basic while wave 1 is on the board',
      order: `${M2_PINNED_LOSER.order} -b2,10@650`,
    },
  ],
};

describe('the balance report', () => {
  it(
    'reports sells, how many came with creeps alive, and that no build won',
    { timeout: 120_000 },
    () => {
      const text = balanceReport([LOSING_SET], getBundledRuleset);
      expect(text).toContain('== probe: wynding-core / field-01, seed 0x5eed ==');
      expect(text).toMatch(
        /undefended — nothing built\n {2}lost · .* · last tower never · lost to 1 normal from wave 1 while on wave 2\n/,
      );
      expect(text).toMatch(/one-basic — .*\n {2}lost · .* · last tower before wave 1 · lost to /);
      expect(text).toMatch(
        /seller — .*\n {2}lost · .* · sells 1 \(1 with creeps alive\) · lost to /,
      );
      expect(text).toContain('board-full: no build won, so there is no strongest build');
    },
  );
});
