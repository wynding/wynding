// script-runner.test.ts — unit coverage for the shared script-runner core itself (G1-b,
// #94), the same convention wave-lookup.test.ts already carries for this package's other
// shared test-support module.
//
// Every story file that adopts `runBuildScript` only ever scripts real catalog tower ids,
// so none of them reach its own guard branch (an unknown towerId in the script — a fixture
// bug, never a legitimate placement attempt). Pinned here directly — cheap, no full-arc run
// needed — so the guard stays covered and a regression in it fails HERE, not as a silent
// never-arming wall inside a 4,000-tick story scene.
//
// M3 story 1's two additions — a step that waits for its tick, and a sell — are pinned
// here too, on runs with no defence that end as soon as wave 1 has leaked.

import { describe, it, expect } from 'vitest';
import { compileRuleset, hashSimState } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';
import { runBuildScript, type Placement, type Sell } from './script-runner';
import { WINNER_A } from './showcase-builds';

const bundle = getBundledRuleset();
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
const SEED = 0x5eed;

describe('runBuildScript guards', () => {
  it('throws up front on an unknown towerId in the script — a fixture bug, not a legitimate placement attempt', () => {
    expect(() =>
      runBuildScript(ruleset, SEED, [{ col: 2, row: 10, towerId: 'no-such-tower' }]),
    ).toThrow(/unknown towerId/);
  });

  it('throws when a sell falls due with no tower on its anchor', () => {
    expect(() => runBuildScript(ruleset, SEED, [{ kind: 'sell', col: 2, row: 10 }])).toThrow(
      /no tower anchored at \(2,10\) to sell/,
    );
  });
});

describe('runBuildScript timed steps (M3 story 1)', () => {
  it('holds a placement until its notBeforeTick, even when bounty covers it sooner', () => {
    const placedAt: number[] = [];
    const { state, placedCount } = runBuildScript(
      ruleset,
      SEED,
      [{ col: 2, row: 10, towerId: 'basic', notBeforeTick: 100 }],
      {
        afterStep: (s, _r, _inputs, placed) => {
          if (placed !== undefined) placedAt.push(s.tick - 1);
        },
      },
    );
    expect(placedAt).toEqual([100]);
    expect(placedCount).toBe(1);
    expect(state.towers.col).toEqual([2]);
  });

  it('a placement with no notBeforeTick still goes down on the first affordable tick', () => {
    const placedAt: number[] = [];
    runBuildScript(ruleset, SEED, [{ col: 2, row: 10, towerId: 'basic' }], {
      afterStep: (s, _r, _inputs, placed) => {
        if (placed !== undefined) placedAt.push(s.tick - 1);
      },
    });
    expect(placedAt).toEqual([0]);
  });

  it('sells the tower on its anchor the first tick the sell is due, refunding into bounty, and the cursor moves on', () => {
    const plan = [
      { col: 2, row: 10, towerId: 'basic' },
      { kind: 'sell', col: 2, row: 10, notBeforeTick: 50 },
      { col: 6, row: 10, towerId: 'basic' },
    ] as const satisfies readonly (Placement | Sell)[];
    const soldAt: number[] = [];
    const bountyAround: number[] = [];
    let before = 0;
    const { state, placedCount } = runBuildScript(ruleset, SEED, plan, {
      beforeStep: (s) => {
        before = s.bounty;
      },
      afterStep: (s, _r, inputs, placed, { sold }) => {
        if (sold !== undefined) {
          soldAt.push(s.tick - 1);
          bountyAround.push(before, s.bounty);
          expect(placed).toBeUndefined();
          expect(inputs).toEqual([{ kind: 'sellTower', tower: expect.any(Number) }]);
          expect(sold).toBe(plan[1]);
        }
      },
    });
    expect(soldAt).toEqual([50]);
    // ⌊75% × 5⌋ = 3 back; nothing else pays on tick 50 of the opening countdown.
    expect(bountyAround[1]! - bountyAround[0]!).toBe(3);
    expect(placedCount).toBe(3);
    expect(state.towers.col).toEqual([6]);
  });

  it('hands afterStep a StepEvents collector only when asked, and the run is the same either way', () => {
    const plan = WINNER_A.slice(0, 6);
    let sawEvents = false;
    let sawNone = true;
    const withEvents = runBuildScript(ruleset, SEED, plan, {
      collectEvents: true,
      afterStep: (_s, _r, _i, _p, { events }) => {
        if (events?.leaked !== undefined && events.killed !== undefined) sawEvents = true;
      },
    });
    const without = runBuildScript(ruleset, SEED, plan, {
      afterStep: (_s, _r, _i, _p, { events }) => {
        if (events !== undefined) sawNone = false;
      },
    });
    expect(sawEvents).toBe(true);
    expect(sawNone).toBe(true);
    expect(hashSimState(withEvents.state)).toBe(hashSimState(without.state));
  });
});
