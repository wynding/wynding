// story-hp-growth.test.ts — M3 story 3: per-wave creep HP growth.
//
// Each wave carries a whole-number `hpPercent` (100 = the catalog's hit points); at spawn
// every creep of the wave gets `max(1, ⌊catalog HP × hpPercent / 100⌋)` hit points. Armor,
// speed, bounty, leak cost, domain and immunities are unchanged. This file proves the
// formula (`spawnHp`, the one implementation the spawn site and the render view model
// share), that `step` applies it at spawn PER WAVE, its `max(1, …)` floor, and that no
// other creep stat moves.

import { describe, it, expect } from 'vitest';
import { createInitialState, step, spawnHp, type SimInput, type SimState } from './index';
import { testRuleset } from './test-support';

const OPEN = {
  widthTiles: 9,
  heightTiles: 5,
  entrance: { col: 0, row: 2 },
  exit: { col: 8, row: 2 },
} as const;

const callEarly: SimInput[] = [{ kind: 'callWaveEarly' }];

/** Step `s` with no input until `done(s)` holds (bounded, so a regression fails, not hangs). */
function runUntil(
  s: SimState,
  ruleset: ReturnType<typeof testRuleset>,
  done: (s: SimState) => boolean,
): SimState {
  for (let i = 0; i < 2000 && !done(s); i++) s = step(s, ruleset, []);
  expect(done(s), 'condition reached within 2000 ticks').toBe(true);
  return s;
}

describe('spawnHp — max(1, ⌊catalog HP × hpPercent / 100⌋)', () => {
  it('returns the catalog value unchanged at 100, and grows it above', () => {
    expect(spawnHp(20, 100)).toBe(20);
    expect(spawnHp(100, 175)).toBe(175);
    expect(spawnHp(20, 270)).toBe(54);
  });

  it('floors — never rounds — a fractional result', () => {
    expect(spawnHp(7, 33)).toBe(2); // 2.31
    expect(spawnHp(19, 175)).toBe(33); // 33.25
    expect(spawnHp(3, 50)).toBe(1); // 1.5
    expect(spawnHp(199, 50)).toBe(99); // 99.5 — a round-half-up would say 100
  });

  it('floors at 1: a tiny catalog value under a small percentage stays a live creep', () => {
    expect(spawnHp(1, 1)).toBe(1); // ⌊0.01⌋ = 0 → 1
    expect(spawnHp(99, 1)).toBe(1); // ⌊0.99⌋ = 0 → 1
    expect(spawnHp(100, 1)).toBe(1); // exactly 1, no floor needed
  });

  it('is exact at the schema ceiling of both operands (10⁶ × 10⁶ stays a safe integer)', () => {
    expect(spawnHp(1_000_000, 1_000_000)).toBe(10_000_000_000);
    expect(spawnHp(999_999, 999_999)).toBe(9_999_980_000); // ⌊9,999,980,000.01⌋
    expect(Number.isSafeInteger(spawnHp(999_999, 999_999))).toBe(true);
  });
});

describe('step applies the wave’s hpPercent at spawn', () => {
  // Three waves of the same catalog creep (hp 20) at 100, 175 and 1 percent. Spacing
  // keeps each wave's creeps on the board long enough to observe, and there are no
  // towers, so nothing has damaged a creep when it is first seen.
  const ruleset = testRuleset(OPEN, {
    creepHp: 20,
    creepSpeedFp: 8,
    creepBounty: 3,
    waves: [
      { waveCount: 2, waveSpacing: 5, countdownTicks: 5, hpPercent: 100 },
      { waveCount: 2, waveSpacing: 5, countdownTicks: 5, hpPercent: 175 },
      { waveCount: 2, waveSpacing: 5, countdownTicks: 5, hpPercent: 1 },
    ],
  });

  /** Every creep's (wave, hp) the first tick it is seen, across a whole hands-off run. */
  function spawnRecords(): Map<number, { wave: number; hp: number; speed: number; bounty: number }> {
    const seen = new Map<number, { wave: number; hp: number; speed: number; bounty: number }>();
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, callEarly);
    for (let t = 0; t < 2000 && s.phase === 'running'; t++) {
      const c = s.creeps;
      for (let i = 0; i < c.id.length; i++) {
        if (!seen.has(c.id[i]!)) {
          seen.set(c.id[i]!, {
            wave: c.wave[i]!,
            hp: c.hp[i]!,
            speed: c.speed[i]!,
            bounty: c.bounty[i]!,
          });
        }
      }
      s = step(s, ruleset, []);
    }
    return seen;
  }

  it('gives each wave’s creeps its own grown hit points: 20, 35, and the floor of 1', () => {
    const records = [...spawnRecords().values()];
    expect(records).toHaveLength(6);
    const hpByWave = (w: number): number[] => records.filter((r) => r.wave === w).map((r) => r.hp);
    expect(hpByWave(0)).toEqual([20, 20]); // 100% — the catalog value
    expect(hpByWave(1)).toEqual([35, 35]); // ⌊20 × 175 / 100⌋
    expect(hpByWave(2)).toEqual([1, 1]); // ⌊20 × 1 / 100⌋ = 0 → the max(1, …) floor
  });

  it('moves no other stat: speed and bounty are the catalog’s in every wave', () => {
    for (const r of spawnRecords().values()) {
      expect(r.speed).toBe(8);
      expect(r.bounty).toBe(3);
    }
  });

  it('a floored creep is a live creep: it walks the board and leaks for the catalog’s leak cost', () => {
    const floored = testRuleset(OPEN, {
      creepHp: 1,
      creepSpeedFp: 64,
      startingLives: 10,
      waves: [{ waveCount: 1, waveSpacing: 5, countdownTicks: 5, hpPercent: 1 }],
    });
    let s = createInitialState(1, floored);
    s = step(s, floored, callEarly);
    s = runUntil(s, floored, (x) => x.creeps.id.length === 1);
    expect(s.creeps.hp[0]).toBe(1);
    s = runUntil(s, floored, (x) => x.phase !== 'running');
    expect(s.leakedCount).toBe(1);
    expect(s.lives).toBe(9); // leakCost 1, unchanged by hpPercent
  });

  it('is part of the run: the same bundle at a different hpPercent is a different, still deterministic run', () => {
    const at = (hpPercent: number): string => {
      const r = testRuleset(OPEN, {
        creepHp: 20,
        waves: [{ waveCount: 3, waveSpacing: 5, countdownTicks: 5, hpPercent }],
      });
      let s = createInitialState(1, r);
      s = step(s, r, callEarly);
      for (let t = 0; t < 30; t++) s = step(s, r, []);
      return JSON.stringify(s.creeps.hp);
    };
    expect(at(150)).toBe(at(150));
    expect(at(150)).not.toBe(at(100));
  });
});
