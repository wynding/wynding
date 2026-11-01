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
// here too, on runs with no defence that end as soon as wave 1 has leaked, along with the
// rule that credits a step by the sim's acceptance rather than the tower count, which a
// `mine` (it removes itself when it detonates) is what breaks.

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

describe('runBuildScript timed steps (M3 story 1)', { timeout: 120_000 }, () => {
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

  it('sells the tower on its anchor — not its neighbour of another kind — the first tick the sell is due, and the cursor moves on', () => {
    const plan = [
      { col: 2, row: 10, towerId: 'basic' },
      { col: 6, row: 10, towerId: 'venom' },
      { kind: 'sell', col: 6, row: 10, notBeforeTick: 50 },
      { col: 10, row: 10, towerId: 'basic' },
    ] as const satisfies readonly (Placement | Sell)[];
    const soldAt: number[] = [];
    const sellInputsBefore50: number[] = [];
    const bountyAround: number[] = [];
    let before = 0;
    const { state, placedCount } = runBuildScript(ruleset, SEED, plan, {
      beforeStep: (s) => {
        before = s.bounty;
      },
      afterStep: (s, _r, inputs, placed, { sold }) => {
        const tick = s.tick - 1;
        if (tick < 50 && inputs.some((i) => i.kind === 'sellTower')) sellInputsBefore50.push(tick);
        if (sold !== undefined) {
          soldAt.push(tick);
          bountyAround.push(before, s.bounty);
          expect(placed).toBeUndefined();
          expect(inputs).toEqual([{ kind: 'sellTower', tower: expect.any(Number) }]);
          expect(sold).toBe(plan[2]);
        }
      },
    });
    // Not due before tick 50, so no sell was even sent until then.
    expect(sellInputsBefore50).toEqual([]);
    expect(soldAt).toEqual([50]);
    // ⌊75% × 9⌋ = 6 back for the venom; nothing else pays on tick 50 of the opening countdown.
    expect(bountyAround[1]! - bountyAround[0]!).toBe(6);
    expect(placedCount).toBe(4);
    expect([state.towers.col, state.towers.row, state.towers.towerId]).toEqual([
      [2, 10],
      [10, 10],
      ['basic', 'basic'],
    ]);
  });

  it('a sell the sim rejects leaves the cursor in place and is retried until accepted', () => {
    // No valid run makes the sim reject a sell of a standing tower, so the test forges the
    // one condition it checks for: a corrupt (negative) bounty, set after tick 49 and
    // repaired after tick 59 — both between steps, so the runner reads the state as
    // `step()` will.
    const plan = [
      { col: 2, row: 10, towerId: 'basic' },
      { kind: 'sell', col: 2, row: 10, notBeforeTick: 50 },
      { col: 6, row: 10, towerId: 'basic' },
    ] as const satisfies readonly (Placement | Sell)[];
    const soldAt: number[] = [];
    const sellsSent: number[] = [];
    let kept = 0;
    const { placedCount, stalled } = runBuildScript(ruleset, SEED, plan, {
      afterStep: (s, _r, inputs, _placed, { sold }) => {
        const tick = s.tick - 1;
        if (inputs.some((i) => i.kind === 'sellTower')) sellsSent.push(tick);
        if (sold !== undefined) soldAt.push(tick);
        if (tick === 49) {
          kept = s.bounty;
          s.bounty = -1;
        }
        if (tick === 59) s.bounty = kept;
      },
    });
    expect(sellsSent).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
    expect(soldAt).toEqual([60]);
    expect(placedCount).toBe(3);
    // Rejected ten times, then accepted: the cursor moved on, so nothing is stalled.
    expect(stalled).toBe(false);
  });

  describe('a mine removes itself when it detonates — steps are credited by the sim’s acceptance, not the tower count', () => {
    // A mine at (10,12) sits 1.5 cells off the row-11 path; wave 1's lead creep sets it off
    // on tick 586 (measured — and re-checked in every test below, which would fail rather
    // than pass vacuously if that ever moved).
    const MINE = { col: 10, row: 12, towerId: 'mine' } as const;
    const DETONATION = 586;

    /** Run `plan`, recording the ticks a mine left the board and the ticks of credited steps. */
    function run(plan: readonly (Placement | Sell)[]) {
      const mineGone: number[] = [];
      const placedAt: number[] = [];
      const soldAt: number[] = [];
      let hadMine = false;
      const result = runBuildScript(ruleset, SEED, plan, {
        beforeStep: (s) => {
          hadMine = s.towers.towerId.includes('mine');
        },
        afterStep: (s, _r, _inputs, placed, { sold }) => {
          const tick = s.tick - 1;
          if (hadMine && !s.towers.towerId.includes('mine')) mineGone.push(tick);
          if (placed !== undefined) placedAt.push(tick);
          if (sold !== undefined) soldAt.push(tick);
        },
      });
      return { ...result, mineGone, placedAt, soldAt };
    }

    it('a detonation while a sell waits for its tick credits no sell', () => {
      const r = run([
        MINE,
        { col: 2, row: 2, towerId: 'basic' },
        { kind: 'sell', col: 2, row: 2, notBeforeTick: DETONATION + 1 },
      ]);
      expect(r.mineGone).toEqual([DETONATION]);
      expect(r.soldAt).toEqual([DETONATION + 1]);
      expect(r.state.towers.id).toEqual([]);
    });

    it('a placement made on the detonation tick is credited, and the steps after it still run', () => {
      const r = run([
        MINE,
        { col: 2, row: 2, towerId: 'basic', notBeforeTick: DETONATION },
        { col: 6, row: 2, towerId: 'basic' },
      ]);
      expect(r.mineGone).toEqual([DETONATION]);
      expect(r.placedAt).toEqual([0, DETONATION, DETONATION + 1]);
      expect(r.placedCount).toBe(3);
      expect(r.state.towers.col).toEqual([2, 6]);
    });

    it('a second mine on the same anchor waits, sending nothing, until the first has cleared it', () => {
      const sentAt: number[] = [];
      const r = runBuildScript(ruleset, SEED, [MINE, MINE, { col: 2, row: 2, towerId: 'basic' }], {
        afterStep: (s, _r, inputs) => {
          for (const i of inputs) {
            if (i.kind === 'placeTower' && i.towerId === 'mine') sentAt.push(s.tick - 1);
          }
        },
      });
      // One input for the mine, one for its re-arm — the tick after the first one fired —
      // and none while the spent mine still stood on the anchor.
      expect(sentAt).toEqual([0, DETONATION + 1]);
      expect(r.placedCount).toBe(3);
      expect(r.stalled).toBe(false);
    });

    it('a placement onto a tower that stays is sent and rejected — a stall, not a wait', () => {
      // (3,2) overlaps the basic at (2,2), which never leaves: waiting for it would hide an
      // authoring error as a queued step, so the input goes out and the sim refuses it.
      const sent: number[] = [];
      const r = runBuildScript(
        ruleset,
        SEED,
        [
          { col: 2, row: 2, towerId: 'basic' },
          { col: 3, row: 2, towerId: 'basic' },
        ],
        {
          afterStep: (s, _r, inputs) => {
            if (inputs.length > 0 && s.towers.id.length === 1) sent.push(s.tick - 1);
          },
        },
      );
      expect(r.placedCount).toBe(1);
      expect(r.stalled).toBe(true);
      expect(sent.length).toBeGreaterThan(1);
    });

    it('a placement held by a mine AND a tower that stays is sent, not held back for the mine', () => {
      // (3,2) overlaps the mine at (2,2) and the basic at (4,2): the mine would clear, the
      // basic never will, so the placement goes out every tick and the run reads as stalled.
      const r = runBuildScript(ruleset, SEED, [
        { col: 2, row: 2, towerId: 'mine' },
        { col: 4, row: 2, towerId: 'basic' },
        { col: 3, row: 2, towerId: 'basic' },
      ]);
      expect(r.placedCount).toBe(2);
      expect(r.stalled).toBe(true);
    });

    it('a mine that fires on the tick it lands is credited once, not placed again', () => {
      // Dropped at (16,12) on tick 645, a creep is already inside its trigger range, so it
      // lands and detonates within one step: the tower count never moves.
      let mineSeenAfterAStep = false;
      let spent = 0;
      let before = 0;
      const { placedCount, state } = runBuildScript(
        ruleset,
        SEED,
        [
          { col: 16, row: 12, towerId: 'mine', notBeforeTick: 645 },
          { col: 2, row: 2, towerId: 'basic' },
        ],
        {
          beforeStep: (s) => {
            before = s.towers.id.length;
          },
          afterStep: (s, _r, _inputs, placed) => {
            if (s.towers.towerId.includes('mine')) mineSeenAfterAStep = true;
            if (placed !== undefined) {
              spent += ruleset.towerById[placed.towerId]!.cost;
              if (placed.towerId === 'mine')
                expect([s.tick - 1, s.towers.id.length]).toEqual([645, before]);
            }
          },
        },
      );
      expect(mineSeenAfterAStep).toBe(false);
      expect(placedCount).toBe(2);
      expect(spent).toBe(11);
      expect(state.towers.towerId).toEqual(['basic']);
    });
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
