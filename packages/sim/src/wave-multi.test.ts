// wave-multi.test.ts — M2 Story 2: multi-wave-specific coverage the single-wave
// story5.test.ts/sim.test.ts suites can't exercise (PLAN.md step 11's test matrix):
// wave-handoff timing across ≥2 waves, cross-wave spawn ordering on a shared tick,
// per-wave clear-bonus forfeit isolation, settlement-before-terminal on the final
// tick (win AND loss), the outcome-dependent scorer + credit forfeiture, the
// satAdd/satMul saturation helpers, and ragged wave-column termination.

import { describe, it, expect } from 'vitest';
import { createInitialState, step, deriveScore, hashSimState, type SimInput } from './index';
import { satAdd, satMul } from './combat';
import { testBundle, testRuleset } from './test-support';
import { compileRuleset } from './ruleset';

const OPEN = {
  widthTiles: 9,
  heightTiles: 5,
  entrance: { col: 0, row: 2 },
  exit: { col: 8, row: 2 },
} as const;

const callEarly: SimInput[] = [{ kind: 'callWaveEarly' }];

describe('satAdd / satMul — true saturation (not the old keep-on-overflow guard)', () => {
  it('satAdd clamps to MAX_SAFE_INTEGER on overflow, rather than returning the old value', () => {
    expect(satAdd(Number.MAX_SAFE_INTEGER - 1, 5)).toBe(Number.MAX_SAFE_INTEGER);
    expect(satAdd(10, 5)).toBe(15);
    expect(satAdd(10, -1)).toBe(10); // negative amount — no-op
    expect(satAdd(10, Number.NaN)).toBe(10); // non-safe amount — no-op
    expect(satAdd(Number.NaN, 5)).toBe(5); // non-safe base treated as 0
  });

  it('satMul clamps to MAX_SAFE_INTEGER on overflow and returns 0 for non-safe/negative operands', () => {
    expect(satMul(3, 4)).toBe(12);
    expect(satMul(0, 999)).toBe(0);
    expect(satMul(Number.MAX_SAFE_INTEGER, 2)).toBe(Number.MAX_SAFE_INTEGER);
    expect(satMul(-1, 5)).toBe(0);
    expect(satMul(5, Number.NaN)).toBe(0);
  });
});

describe('wave handoff timing (G1) — a wave never decrements on its own flip tick', () => {
  it('wave 2 counts down from the tick AFTER wave 1 launches, not the launch tick itself', () => {
    const ruleset = testRuleset(OPEN, {
      waves: [
        { waveCount: 1, waveSpacing: 5, countdownTicks: 100 },
        { waveCount: 1, waveSpacing: 5, countdownTicks: 10 },
      ],
    });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly); // launches wave 0 at tick 0
    expect(s.waveCursor).toBe(1);
    expect(s.countdownRemaining).toBe(10); // wave 1's full countdown, undecremented
    s = step(s, ruleset, []); // tick 1 — wave 1's FIRST decrement
    expect(s.countdownRemaining).toBe(9);
    for (let i = 0; i < 8; i++) s = step(s, ruleset, []); // ticks 2..9
    expect(s.waveLaunchTick[1]).toBeNull();
    expect(s.countdownRemaining).toBe(1);
    s = step(s, ruleset, []); // tick 10 === countdownTicks — launches
    expect(s.waveLaunchTick[1]).toBe(10);
  });
});

describe('cross-wave same-tick spawn ordering', () => {
  it('when two launched waves both have a spawn due the same tick, the earlier-launched wave spawns first (lower entity id)', () => {
    // A GENUINE same-tick collision (the previous construction never produced
    // one): wave 0 launches at tick 0 (early call), entries spaced 5
    // ⇒ spawns at ticks 0 and 5. Wave 1 launches at tick 1 (early call) with entry
    // offset 4 ⇒ its first spawn is due at tick 1 + 4 = 5 — the SAME tick as wave
    // 0's second spawn. Index-order draining must append wave 0's creep first.
    const ruleset = testRuleset(OPEN, {
      waves: [
        { waveCount: 2, waveSpacing: 5, countdownTicks: 5 },
        { waveCount: 2, waveSpacing: 5, countdownTicks: 1, offsetTicks: 4 },
      ],
    });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly); // tick 0: launches wave 0 (spawn @ 0)
    s = step(s, ruleset, callEarly); // tick 1: launches wave 1 (first spawn due @ 5)
    expect(s.waveLaunchTick[0]).toBe(0);
    expect(s.waveLaunchTick[1]).toBe(1);
    for (let t = 2; t <= 5; t++) s = step(s, ruleset, []);
    // Through tick 5: wave 0 spawned @0 and @5, wave 1 spawned @5 — three creeps,
    // and the two same-tick spawns landed wave-0-then-wave-1 with ascending ids.
    expect(s.creeps.wave).toEqual([0, 0, 1]);
    const ids = s.creeps.id as number[];
    expect(ids[1]!).toBeGreaterThan(ids[0]!);
    expect(ids[2]!).toBeGreaterThan(ids[1]!); // the tick-5 pair: wave 0 first
  });
});

describe('per-wave clear-bonus forfeit isolation', () => {
  it("a leak in wave 2 forfeits ONLY wave 2's clear bonus, not wave 1's", () => {
    // Wave 1: a single 1-hp creep, killed by a tower before it can leak — clear
    // bonus paid. Wave 2: launched early with no defense — its creep leaks —
    // clear bonus forfeited. Both wave-clear bonuses are nonzero and DISTINCT so a
    // cross-forfeit bug (either direction) is visible in the final bounty.
    const wideOpen = {
      widthTiles: 9,
      heightTiles: 5,
      entrance: { col: 0, row: 2 },
      exit: { col: 8, row: 2 },
    } as const;
    const bundle = testBundle(wideOpen, {
      creepHp: 1,
      startingBounty: 80,
      waves: [
        { waveCount: 1, waveSpacing: 5, countdownTicks: 10, waveClearBonus: 40 },
        { waveCount: 1, waveSpacing: 5, countdownTicks: 500, waveClearBonus: 90 },
      ],
    });
    const ruleset = compileRuleset(bundle, 'test');
    const towerCost = bundle.towerCatalog[0]!.cost;
    const killBounty = bundle.creepCatalog[0]!.bounty;
    let s = createInitialState(1, ruleset);
    // Build a tower dead-center in the lane before wave 1 launches.
    s = step(s, ruleset, [{ kind: 'placeTower', anchor: { col: 3, row: 1 }, towerId: 'basic' }]);
    s = step(s, ruleset, callEarly); // launch wave 1
    for (let t = 0; t < 200 && !s.waveResolved[0]; t++) s = step(s, ruleset, []);
    expect(s.waveResolved[0]).toBe(true);
    expect(s.waveLeaked[0]).toBe(false); // the tower killed it before it reached the exit
    // EXACT credited amount — flags alone don't witness payment:
    // starting 80 − tower cost + the kill's bounty + wave 1's clear bonus (40),
    // nothing else (both early-call divisors are 0 in this fixture).
    const bountyAfterWave1 = s.bounty;
    expect(bountyAfterWave1).toBe(80 - towerCost + killBounty + 40);

    s = step(s, ruleset, callEarly); // launch wave 2 early — no defense left in its path
    // Sell the tower so wave 2's creep is guaranteed to leak (isolating the forfeit).
    const towerId = s.towers.id[0] as number;
    s = step(s, ruleset, [{ kind: 'sellTower', tower: towerId }]);
    for (let t = 0; t < 500 && s.phase === 'running'; t++) s = step(s, ruleset, []);
    expect(s.waveLeaked[1]).toBe(true);
    expect(s.waveResolved[1]).toBe(true);
    // Wave 2's creep leaked: its 90 bonus is forfeited and no kill bounty accrues —
    // the ONLY income after wave 1 settled is the sell refund. Exact, not an
    // inequality: a cross-forfeit bug in either direction changes this sum.
    const sellRefund = Math.floor((towerCost * 3) / 4);
    expect(s.bounty).toBe(bountyAfterWave1 + sellRefund);
  });
});

describe('settlement precedes terminal, uniformly, on the final tick (G8)', () => {
  it('a wave clearing on the SAME tick lives reach 0 still pays its bonus before the loss terminal', () => {
    // The REAL construction (the previous body never built the collision it
    // named). Wave 0's sole creep is unkillable and leaks the last
    // life at a fixed tick L; wave 1's sole creep is one-shottable. The board is
    // wide enough that the leaker exits the tower's range long before it leaks, so
    // the tower is free to fire at the mark — whose impact (fire + travel ticks)
    // can land on any tick as wave 1's call tick shifts its arrival. We sweep that
    // call tick until the kill genuinely lands ON the leak tick: movement (the
    // leak, lives → 0) → combat (the in-flight impact lands, the mark dies) →
    // resolution (wave 1 settles and PAYS, then the loss terminal is marked). The
    // sweep FAILS the test if no collision exists — it cannot pass vacuously.
    const wideOpen = {
      widthTiles: 16,
      heightTiles: 5,
      entrance: { col: 0, row: 2 },
      exit: { col: 15, row: 2 },
    } as const;
    const base = testBundle(wideOpen, { startingLives: 1, startingBounty: 80 });
    const bundle = {
      ...base,
      creepCatalog: [
        { ...base.creepCatalog[0]!, id: 'leaker', hp: 1_000_000 },
        { ...base.creepCatalog[0]!, id: 'mark', hp: 10 },
      ],
      boards: [
        {
          ...base.boards[0]!,
          waves: [
            {
              index: 0,
              countdownTicks: 10,
              clearBonus: 3,
              entries: [{ creepId: 'leaker', count: 1, spacingTicks: 5 }],
            },
            {
              index: 1,
              countdownTicks: 500,
              clearBonus: 7,
              entries: [{ creepId: 'mark', count: 1, spacingTicks: 5 }],
            },
          ],
        },
      ],
    };
    const ruleset = compileRuleset(bundle, 'test');
    const killBounty = base.creepCatalog[0]!.bounty;
    let witnessed = false;
    for (let t1 = 1; t1 <= 200 && !witnessed; t1++) {
      let s = createInitialState(1, ruleset);
      s = step(s, ruleset, [
        { kind: 'placeTower', anchor: { col: 3, row: 1 }, towerId: 'basic' },
        ...callEarly,
      ]);
      let leakTick = -1;
      let killTick = -1;
      for (let t = 1; t <= 600 && s.phase === 'running'; t++) {
        const kbBefore = s.cumulativeKillBounty;
        const livesBefore = s.lives;
        const bountyBefore = s.bounty;
        s = step(s, ruleset, t === t1 ? callEarly : []);
        if (livesBefore > 0 && s.lives <= 0) leakTick = t;
        if (s.cumulativeKillBounty > kbBefore) killTick = t;
        if (leakTick === t && killTick === t) {
          // The collision tick: wave 1 killed clean AND the last life leaked.
          witnessed = true;
          expect(s.phase).toBe('lost');
          expect(s.waveResolved[1]).toBe(true);
          expect(s.waveLeaked[1]).toBe(false);
          // Settlement PAID before the terminal was marked: this tick credited
          // the mark's kill bounty AND wave 1's clear bonus (7) — wave 0's bonus
          // is forfeited (it leaked). Exact delta, no inequality.
          expect(s.bounty).toBe(bountyBefore + killBounty + 7);
          // Loss priority: deriveScore in the lost branch is kill-bounty ONLY.
          expect(deriveScore(s, ruleset)).toBe(s.cumulativeKillBounty);
        }
      }
    }
    expect(witnessed).toBe(true);
  });

  it('the final wave resolving on the very tick the match becomes total (all waves cleared) pays its bonus in a WIN', () => {
    const bundle = testBundle(OPEN, {
      creepHp: 10,
      waves: [{ waveCount: 1, waveSpacing: 5, countdownTicks: 5, waveClearBonus: 7 }],
    });
    const ruleset = compileRuleset(bundle, 'test');
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [
      { kind: 'placeTower', anchor: { col: 3, row: 1 }, towerId: 'basic' },
      ...callEarly,
    ]);
    for (let t = 0; t < 200 && s.phase === 'running'; t++) s = step(s, ruleset, []);
    expect(s.phase).toBe('won');
    expect(s.waveResolved[0]).toBe(true);
    expect(s.waveLeaked[0]).toBe(false);
    // The credited AMOUNT, not just the flags: starting 80 −
    // tower cost + the one kill's bounty + the clear bonus (7); divisors are 0.
    expect(s.bounty).toBe(80 - bundle.towerCatalog[0]!.cost + bundle.creepCatalog[0]!.bounty + 7);
  });
});

describe('deriveScore — outcome-dependent branches + credit forfeiture on a loss', () => {
  it('running: kill bounty + early-call credit (the live readout)', () => {
    const ruleset = testRuleset(OPEN, {
      waveCount: 10,
      waveSpacing: 20,
      countdownTicks: 100,
      earlyCallScoreDivisor: 10,
    });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly); // rem = 100 → credit = 10
    expect(s.phase).toBe('running');
    expect(deriveScore(s, ruleset)).toBe(s.cumulativeKillBounty + 10);
  });

  it('won: kill bounty + credit + lives × survivalMul', () => {
    const ruleset = testRuleset(OPEN, {
      creepHp: 10,
      waveCount: 3,
      waveSpacing: 20,
      countdownTicks: 100,
      earlyCallScoreDivisor: 10,
    });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [
      { kind: 'placeTower', anchor: { col: 3, row: 1 }, towerId: 'basic' },
      ...callEarly,
    ]);
    for (let t = 0; t < 500 && s.phase === 'running'; t++) s = step(s, ruleset, []);
    expect(s.phase).toBe('won');
    const expected =
      s.cumulativeKillBounty + s.cumulativeEarlyCallCredit + s.lives * ruleset.scoring.survivalMul;
    expect(deriveScore(s, ruleset)).toBe(expected);
    expect(s.cumulativeEarlyCallCredit).toBeGreaterThan(0); // the credit is retained on a win
  });

  it('lost: kill bounty ONLY — the early-call credit is forfeited entirely, even if positive', () => {
    const ruleset = testRuleset(OPEN, {
      waveCount: 10,
      waveSpacing: 5,
      startingLives: 2,
      countdownTicks: 50,
      earlyCallScoreDivisor: 1, // maximizes the credit so forfeiture is unmissable
    });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly);
    for (let t = 0; t < 2000 && s.phase === 'running'; t++) s = step(s, ruleset, []);
    expect(s.phase).toBe('lost');
    expect(s.cumulativeEarlyCallCredit).toBeGreaterThan(0); // credit WAS accrued live...
    expect(deriveScore(s, ruleset)).toBe(s.cumulativeKillBounty); // ...but forfeited on loss
  });
});

describe('ragged wave-state termination (coerceSoa creep-wave-column totality)', () => {
  it('creep rows with a forged/invalid `wave` id are dropped, and the run still reaches a terminal', () => {
    const ruleset = testRuleset(OPEN, { waveCount: 3, waveSpacing: 20, countdownTicks: 20 });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly);
    // Forge every creep's `wave` column with a mix of invalid values.
    s.creeps.wave = s.creeps.wave.map((_w, i) =>
      i % 3 === 0 ? -1 : i % 3 === 1 ? 999 : (Number.NaN as unknown as number),
    );
    const before = s.creeps.id.length;
    expect(before).toBeGreaterThan(0);
    s = step(s, ruleset, []); // coerceSoa runs at entry — every row above is invalid
    expect(s.creeps.id).toHaveLength(0); // all dropped — no crash, no desync
    // The run still reaches SOME terminal within a generous cap (never hangs).
    let terminalReached = s.phase !== 'running';
    for (let t = 0; t < 2000 && !terminalReached; t++) {
      s = step(s, ruleset, []);
      terminalReached = s.phase !== 'running';
    }
    expect(terminalReached).toBe(true);
  });

  it('a creep row whose wave id is exactly waves.length (one past the end) is dropped, leaving its siblings intact', () => {
    const ruleset = testRuleset(OPEN, { waveCount: 2, waveSpacing: 1, countdownTicks: 20 });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly);
    s = step(s, ruleset, []); // second creep spawns (spacing 1)
    expect(s.creeps.id.length).toBe(2);
    const survivingId = s.creeps.id[1];
    s.creeps.wave[0] = ruleset.waves.length; // one past the valid range [0, waves.length)
    s = step(s, ruleset, []);
    expect(s.creeps.id).toHaveLength(1); // only the corrupted row was dropped
    expect(s.creeps.id[0]).toBe(survivingId);
  });

  it('a `wave` column longer than `id` is truncated on the terminal-freeze path, and live rows survive the rebuild', () => {
    // On a running state the movement rebuild (bounded by id.length) would erase
    // the forged tail whether or not coerceSoa's length guard exists — a test
    // there is vacuous for the guard (mutation-proven). A path
    // where movement never runs (here: the terminal freeze; the tick-totality
    // no-op and previewInputs are the others) leaves only the guard between the
    // forged tail and the hash. The terminal is a LOSS so live creeps remain on
    // the board (a won terminal has zero rows, which let a
    // wipe-everything-on-mismatch mutant survive — the survivors assertion is
    // load-bearing).
    const ruleset = testRuleset(OPEN, {
      creepHp: 10,
      startingLives: 2,
      waves: [{ waveCount: 6, waveSpacing: 3, countdownTicks: 5 }],
    });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly); // no towers — the first two leaks end the run
    for (let t = 0; t < 400 && s.phase === 'running'; t++) s = step(s, ruleset, []);
    expect(s.phase).toBe('lost'); // terminal WITH survivors still on the board
    const survivors = [...s.creeps.id];
    expect(survivors.length).toBeGreaterThan(0);
    const twin = JSON.parse(JSON.stringify(s)) as typeof s;
    s.creeps.wave.push(0); // forged trailing element beyond the row authority (`id`)
    s = step(s, ruleset, []); // freeze path: coerceSoa runs, movement does not
    const twinStepped = step(twin, ruleset, []);
    expect(s.creeps.wave.length).toBe(s.creeps.id.length); // tail gone via the guard alone
    expect(s.creeps.id).toEqual(survivors); // live rows untouched by the rebuild
    expect(hashSimState(s)).toBe(hashSimState(twinStepped)); // and the hash never saw it
  });

  it('a forged non-numeric or negative tick cannot poison repaired launch ticks, and the repaired state is stable', () => {
    // coerceSoa runs BEFORE step()'s tick-totality guard; the repair source is
    // clamped (a poisoned state.tick repairs launch ticks to 0, never to NaN or a
    // negative), so the repaired LIFECYCLE BLOCK is canonical and a second pass
    // leaves the hash unchanged. (`state.tick` itself stays poisoned — the
    // totality guard no-ops the step; only the lifecycle fields are repaired.)
    // Both clamp branches are exercised — NaN (non-safe-int) and -5 (safe but
    // negative — kills the mutant that drops the sign check) — plus a third forged
    // value on NaN's branch: Infinity (safe-int check dropped ⇒ repairTick =
    // Infinity makes EVERY comparison pass, so the repair never fires and the
    // forged 999 rides into the hash unrepaired — a distinct failure mode from
    // both others).
    for (const forged of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const ruleset = testRuleset(OPEN, { waveCount: 1, countdownTicks: 20 });
      let s = createInitialState(1, ruleset);
      s = step(s, ruleset, callEarly); // wave 0 launched at tick 0
      s.tick = forged as unknown as number;
      s.waveLaunchTick[0] = 999; // forged future launch tick — forces a repair write
      s = step(s, ruleset, []); // coerce repairs; the totality guard then no-ops
      expect(s.waveLaunchTick[0]).toBe(0); // clamped repair source, cascade applied
      expect(s.waveSpawnCursor[0]).toBe(0);
      expect(s.waveResolved[0]).toBe(false);
      const h1 = hashSimState(s);
      s = step(s, ruleset, []); // an identical second pass moves nothing
      expect(hashSimState(s)).toBe(h1);
    }
  });
});

describe('bound gate — the terminal-tick budget', () => {
  const compileAtCountdown = (countdownTicks: number) =>
    compileRuleset(testBundle(OPEN, { waveCount: 1, countdownTicks }), 'test');

  it('accepts exactly at the boundary and rejects one past it (a SHARP gate, not a vibe)', () => {
    // With one single-spawn wave (tail 0), the gate is countdown + maxTraversal ≤
    // MAX_MATCH_TICKS — binary-search the maximal accepted countdown, then prove
    // the boundary is sharp: C* compiles, C*+1 throws (the previous test neither
    // landed on the boundary nor exercised the rejection).
    let lo = 1;
    let hi = 36_000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi + 1) / 2);
      let ok = true;
      try {
        compileAtCountdown(mid);
      } catch {
        ok = false;
      }
      if (ok) lo = mid;
      else hi = mid - 1;
    }
    const maxAccepted = lo;
    // The OPEN test board's traversal term is small but nonzero — the boundary
    // must sit strictly inside (30_000, 36_000).
    expect(maxAccepted).toBeGreaterThan(30_000);
    expect(maxAccepted).toBeLessThan(36_000);
    expect(() => compileAtCountdown(maxAccepted)).not.toThrow();
    expect(() => compileAtCountdown(maxAccepted + 1)).toThrow(
      /cannot reach a terminal state within the tick budget/,
    );
  });

  it("an EARLY wave's tail can be the peak — a schedule whose first-wave tail exceeds the budget is rejected even though later prefixes are tiny", () => {
    // Kills the "last wave wins" mutant: the true peak is
    // prefix_0 + tail_0 = 100 + 35_900 = 36_000, which with the nonzero traversal
    // term must throw; a no-max formula reads wave 1's 200 and would accept.
    expect(() =>
      compileRuleset(
        testBundle(OPEN, {
          waves: [
            { waveCount: 1, waveSpacing: 5, countdownTicks: 100, offsetTicks: 35_900 },
            { waveCount: 1, waveSpacing: 5, countdownTicks: 100 },
          ],
        }),
        'test',
      ),
    ).toThrow(/cannot reach a terminal state within the tick budget/);
  });

  it("overlapping tails don't double-count: an early wave's long tail under later countdowns compiles", () => {
    // countdowns [10k, 10k] with wave 0 carrying a 20k spawn offset: the latest
    // spawn is max(10k+20k, 20k+0) = 30k — feasible. The superseded
    // Σcountdowns + maxTail formula would have read 40k and falsely rejected.
    const ruleset = compileRuleset(
      testBundle(OPEN, {
        waves: [
          { waveCount: 1, waveSpacing: 5, countdownTicks: 10_000, offsetTicks: 20_000 },
          { waveCount: 1, waveSpacing: 5, countdownTicks: 10_000 },
        ],
      }),
      'test',
    );
    expect(ruleset.waves).toHaveLength(2);
  });

  it('entriesSummary orders by FIRST ARRIVAL over the sorted timeline, not authored row order', () => {
    // Three entries whose arrival order [swift, normal, tank] is a NON-TRIVIAL
    // permutation of authored order [normal, swift, tank] and anti-correlated
    // with counts (2, 3, 4) — so authored order, reversed-authored order,
    // count-descending, and count-ascending are ALL killed by the one fixture
    // (a two-entry fixture couldn't separate them).
    const base = testBundle(OPEN);
    const bundle = {
      ...base,
      creepCatalog: [
        base.creepCatalog[0]!,
        { ...base.creepCatalog[0]!, id: 'swift' },
        { ...base.creepCatalog[0]!, id: 'tank' },
      ],
      boards: [
        {
          ...base.boards[0]!,
          waves: [
            {
              index: 0,
              countdownTicks: 10,
              clearBonus: 0,
              entries: [
                { creepId: 'normal', count: 2, spacingTicks: 5, offsetTicks: 50 },
                { creepId: 'swift', count: 3, spacingTicks: 5 }, // offset 0 — arrives first
                { creepId: 'tank', count: 4, spacingTicks: 5, offsetTicks: 100 },
              ],
            },
          ],
        },
      ],
    };
    const ruleset = compileRuleset(bundle, 'test');
    expect(ruleset.waves[0]!.entriesSummary).toEqual([
      { creepId: 'swift', count: 3 },
      { creepId: 'normal', count: 2 },
      { creepId: 'tank', count: 4 },
    ]);
  });
});
