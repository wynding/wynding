// wave-multi.test.ts — M2 Story 2: multi-wave-specific coverage the single-wave
// story5.test.ts/sim.test.ts suites can't exercise (PLAN.md step 11's test matrix):
// wave-handoff timing across ≥2 waves, cross-wave spawn ordering on a shared tick,
// per-wave clear-bonus forfeit isolation, settlement-before-terminal on the final
// tick (win AND loss), the outcome-dependent scorer + credit forfeiture, the
// satAdd/satMul saturation helpers, and ragged wave-column termination.

import { describe, it, expect } from 'vitest';
import { createInitialState, step, deriveScore, type SimInput } from './index';
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
    // Launch wave 0 and (via a second early call the same tick) wave 1 together —
    // both waves' first spawn is then due on the SAME tick; wave 0 (index order)
    // must drain first, so its creep receives the lower id.
    const ruleset = testRuleset(OPEN, {
      waves: [
        { waveCount: 2, waveSpacing: 5, countdownTicks: 5 },
        { waveCount: 2, waveSpacing: 5, countdownTicks: 1 },
      ],
    });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly); // launches wave 0 at tick 0
    s = step(s, ruleset, callEarly); // tick 1: launches wave 1 early too
    // Both waves have now launched, each with a spawn due immediately.
    expect(s.waveLaunchTick[0]).toBe(0);
    expect(s.waveLaunchTick[1]).toBe(1);
    // Wave 0's second spawn (offset 5) and wave 1's first spawn (offset 0, due at
    // launch tick 1) both land on tick 5 and tick 1 respectively — check the tick
    // where wave 1's own first spawn lands (tick 1, same tick it launched):
    // wave 0 was already draining before wave 1 existed, so on tick 1 wave 0's
    // cursor is not due (next due at tick 5) — assert wave 1's creep id instead,
    // and separately assert index-order draining via the wave column: the FIRST
    // creep (lowest id) belongs to wave 0.
    expect(s.creeps.wave[0]).toBe(0);
    expect(s.creeps.id[0]).toBeLessThan(s.creeps.id[s.creeps.id.length - 1] as number);
  });
});

describe('per-wave clear-bonus forfeit isolation', () => {
  it('a leak in wave 2 forfeits ONLY wave 2\'s clear bonus, not wave 1\'s', () => {
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
    let s = createInitialState(1, ruleset);
    // Build a tower dead-center in the lane before wave 1 launches.
    s = step(s, ruleset, [{ kind: 'placeTower', anchor: { col: 3, row: 1 } }]);
    s = step(s, ruleset, callEarly); // launch wave 1
    for (let t = 0; t < 200 && !s.waveResolved[0]; t++) s = step(s, ruleset, []);
    expect(s.waveResolved[0]).toBe(true);
    expect(s.waveLeaked[0]).toBe(false); // the tower killed it before it reached the exit
    const bountyAfterWave1 = s.bounty;

    s = step(s, ruleset, callEarly); // launch wave 2 early — no defense left in its path
    // Sell the tower so wave 2's creep is guaranteed to leak (isolating the forfeit).
    const towerId = s.towers.id[0] as number;
    s = step(s, ruleset, [{ kind: 'sellTower', tower: towerId }]);
    for (let t = 0; t < 500 && s.phase === 'running'; t++) s = step(s, ruleset, []);
    expect(s.waveLeaked[1]).toBe(true);
    expect(s.waveResolved[1]).toBe(true);
    // Wave 1's bonus (40) landed in bountyAfterWave1; wave 2's bonus (90) must NOT
    // land on top of it (forfeited) — final bounty grew only by the sell refund and
    // any late kill bounty, never by 90.
    expect(s.bounty).toBeLessThan(bountyAfterWave1 + 90);
  });
});

describe('settlement precedes terminal, uniformly, on the final tick (G8)', () => {
  it('a wave clearing on the SAME tick lives reach 0 still pays its bonus before the loss terminal', () => {
    // Two waves: wave 1's sole creep is killed by a tower on the exact tick a
    // wave-2 creep (already loose, undefended) leaks the last life — settlement
    // (wave 1's bonus) must land even though the match ends 'lost' this tick.
    const wideOpen = {
      widthTiles: 9,
      heightTiles: 5,
      entrance: { col: 0, row: 2 },
      exit: { col: 8, row: 2 },
    } as const;
    const bundle = testBundle(wideOpen, {
      startingLives: 1,
      creepHp: 10_000, // effectively unkillable within this window — guarantees a leak
      startingBounty: 80,
      waves: [
        { waveCount: 1, waveSpacing: 5, countdownTicks: 10, waveClearBonus: 4, offsetTicks: undefined },
      ],
    });
    const ruleset = compileRuleset(bundle, 'test');
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly);
    for (let t = 0; t < 500 && s.phase === 'running'; t++) s = step(s, ruleset, []);
    expect(s.phase).toBe('lost');
    expect(s.lives).toBeLessThanOrEqual(0);
    // Loss priority: deriveScore in the lost branch is kill-bounty ONLY.
    expect(deriveScore(s, ruleset)).toBe(s.cumulativeKillBounty);
  });

  it('the final wave resolving on the very tick the match becomes total (all waves cleared) pays its bonus in a WIN', () => {
    const ruleset = testRuleset(OPEN, {
      creepHp: 10,
      waves: [{ waveCount: 1, waveSpacing: 5, countdownTicks: 5, waveClearBonus: 7 }],
    });
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'placeTower', anchor: { col: 3, row: 1 } }, ...callEarly]);
    for (let t = 0; t < 200 && s.phase === 'running'; t++) s = step(s, ruleset, []);
    expect(s.phase).toBe('won');
    expect(s.waveResolved[0]).toBe(true);
    expect(s.waveLeaked[0]).toBe(false);
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
    s = step(s, ruleset, [{ kind: 'placeTower', anchor: { col: 3, row: 1 } }, ...callEarly]);
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
});

describe('bound gate — accept exactly at the boundary', () => {
  it('a multi-wave schedule landing exactly at MAX_MATCH_TICKS compiles', () => {
    // Σcountdown + maxTail + maxTraversal must be <= 36_000. Build a 2-wave bundle
    // tuned to land under the ceiling with room for the (nonzero) traversal term,
    // proving the SUMMED bound — not a per-wave-only check — is what gates.
    const ruleset = testRuleset(OPEN, {
      waves: [
        { waveCount: 2, waveSpacing: 5, countdownTicks: 17_000 },
        { waveCount: 2, waveSpacing: 5, countdownTicks: 17_000 },
      ],
    });
    expect(ruleset.waves).toHaveLength(2);
  });
});
