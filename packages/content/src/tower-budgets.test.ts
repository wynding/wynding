// tower-budgets.test.ts — the tripwire for the replay validator's tower budgets (M3 story 2).
//
// `MAX_TOTAL_TOWER_COMMANDS` and `MAX_TOWER_PLACEMENTS` (`packages/sim/src/ruleset-shared.ts`)
// are derived from what legitimate play can issue, and that derivation rests on two facts
// about the CONTENT, not the sim: a run's whole income I, and the cheapest sell-and-rebuild
// flip's net cost n. With n ≥ 2 a run commits at most I / 2 placements and I commands, so the
// budgets hold while I ≤ 2,000. Stories 5–8 tune income, and nothing in the sim would notice a
// bundle that outgrew them: legitimate runs would start failing `validate()`. So this file
// holds every shipped board to the derivation, and a failure names the budget to re-derive.
//
// I is the upper bound the derivation uses: the starting bounty, every creep's kill bounty,
// every clear bonus, and every early call at its maximum — a wave called the tick after the
// one before it launched, its whole countdown unspent. That last term is checked against the
// sim itself below, so the formula cannot drift from the rule it bounds. n is measured, not
// computed: each tower kind is placed and sold through `step()`.

import { describe, it, expect } from 'vitest';
import {
  compileRuleset,
  createInitialState,
  step,
  MAX_TOTAL_TOWER_COMMANDS,
  MAX_TOWER_PLACEMENTS,
} from '@wynding/sim';
import type { Ruleset, RulesetBoard } from '@wynding/types';
import { bundledRulesetIds, getBundledRuleset } from './registry';

/** The upper bound on a run's income on `board`, by source. */
function maxIncome(bundle: Ruleset, board: RulesetBoard) {
  const bountyOf = new Map(bundle.creepCatalog.map((c) => [c.id, c.bounty]));
  let kills = 0;
  for (const wave of board.waves) {
    for (const entry of wave.entries) kills += entry.count * bountyOf.get(entry.creepId)!;
  }
  const clears = board.waves.reduce((sum, wave) => sum + wave.clearBonus, 0);
  const divisor = bundle.balance.earlyCallBountyDivisor;
  // The opening launch pays nothing (sv15): there is no "early" for the first wave.
  const earlyCalls =
    divisor === 0
      ? 0
      : board.waves
          .filter((wave) => wave.index > 0)
          .reduce((sum, wave) => sum + Math.floor(wave.countdownTicks / divisor), 0);
  const start = bundle.balance.startingBounty;
  return { start, kills, clears, earlyCalls, total: start + kills + clears + earlyCalls };
}

/** What every early call pays when each wave is called the tick after the last one launched. */
function earlyCallsAtTheirMaximum(bundle: Ruleset, boardId: string): number {
  const ruleset = compileRuleset(bundle, boardId);
  let state = createInitialState(1, ruleset);
  const before = state.bounty;
  for (let t = 0; t < 1_000 && state.waveCursor < ruleset.waves.length; t++) {
    state = step(state, ruleset, [{ kind: 'callWaveEarly' }]);
  }
  expect(state.waveCursor, 'every wave was called').toBe(ruleset.waves.length);
  expect(state.waveResolved.some(Boolean), 'no clear bonus is mixed in').toBe(false);
  return state.bounty - before;
}

/** What a place-then-sell of `towerId` costs, played through `step()` on an empty board. */
function flipNet(bundle: Ruleset, boardId: string, towerId: string): number {
  const cost = bundle.towerCatalog.find((t) => t.id === towerId)!.cost;
  // Enough bounty for any kind, so the measurement never depends on the starting purse.
  const funded: Ruleset = { ...bundle, balance: { ...bundle.balance, startingBounty: cost } };
  const ruleset = compileRuleset(funded, boardId);
  const { width, height } = ruleset.board.grid;
  for (let row = 1; row < height - 2; row++) {
    for (let col = 1; col < width - 2; col++) {
      let state = createInitialState(1, ruleset);
      const before = state.bounty;
      state = step(state, ruleset, [{ kind: 'placeTower', anchor: { col, row }, towerId }]);
      if (state.towers.id.length !== 1) continue; // not legal here: try the next anchor
      state = step(state, ruleset, [{ kind: 'sellTower', tower: state.towers.id[0]! }]);
      expect(state.towers.id, `${towerId} sold`).toHaveLength(0);
      return before - state.bounty;
    }
  }
  throw new Error(`no anchor on ${boardId} accepts a ${towerId}`);
}

describe('every shipped board stays inside the replay validator’s tower budgets', () => {
  const boards = bundledRulesetIds().flatMap((id) => {
    const bundle = getBundledRuleset(id);
    return bundle.boards.map((board) => ({ bundle, board, name: `${id}/${board.id}` }));
  });

  it.each(boards)('$name: the early-call term is what the sim pays', ({ bundle, board }) => {
    expect(earlyCallsAtTheirMaximum(bundle, board.id)).toBe(maxIncome(bundle, board).earlyCalls);
  });

  it.each(boards)('$name: the cheapest sell-and-rebuild nets at least 2', ({ bundle, board }) => {
    const nets = bundle.towerCatalog.map((t) => ({
      id: t.id,
      net: flipNet(bundle, board.id, t.id),
    }));
    const cheapest = nets.reduce((a, b) => (b.net < a.net ? b : a));
    expect(
      cheapest.net,
      `a ${cheapest.id} flip nets ${cheapest.net}: below 2, juggling outruns income — re-derive ` +
        'MAX_TOTAL_TOWER_COMMANDS and MAX_TOWER_PLACEMENTS (ruleset-shared.ts)',
    ).toBeGreaterThanOrEqual(2);
  });

  it.each(boards)('$name: its maximum income fits both budgets', ({ bundle, board, name }) => {
    const income = maxIncome(bundle, board);
    console.log(
      `[tower-budgets] ${name}: I = ${income.total} (${income.start} start + ${income.kills} ` +
        `kills + ${income.clears} clears + ${income.earlyCalls} early calls)`,
    );
    expect(
      income.total,
      `I = ${income.total} exceeds MAX_TOTAL_TOWER_COMMANDS (${MAX_TOTAL_TOWER_COMMANDS}) — ` +
        're-derive the tower-command budget (ruleset-shared.ts)',
    ).toBeLessThanOrEqual(MAX_TOTAL_TOWER_COMMANDS);
    expect(
      income.total,
      `I = ${income.total} exceeds 2 × MAX_TOWER_PLACEMENTS (${2 * MAX_TOWER_PLACEMENTS}) — ` +
        're-derive the placement budget, and MAX_DOT_RECORDS with it (ruleset-shared.ts, combat.ts)',
    ).toBeLessThanOrEqual(2 * MAX_TOWER_PLACEMENTS);
  });
});
