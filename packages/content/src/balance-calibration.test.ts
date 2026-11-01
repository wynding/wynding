// balance-calibration.test.ts — M3 story 1's DONE-CRITERION: the balance checker,
// calibrated on M2 before any M3 content exists (docs/milestones/m3.md, "The balance
// checker"). M2's Winner A, Winner B and pinned loser, re-expressed in the grid format
// (`reference-builds.ts`), must reproduce M2's pinned outcomes EXACTLY through the new
// format and the checker's own instrumented run:
//
//   - each grid build compiles to exactly the plan M2's pins run (`showcase-builds.ts`),
//     runs every step, and drives the sim to the same final world-hash as that plan run
//     bare — Winner A's to the M2 golden's own pinned hash;
//   - both winners win — on 10 lives, 3★, at M2's measured ticks, every creep killed;
//   - the loser loses at arc wave 8, LOCATED BY CREEP ID (the armored-flyer wave), and
//     clears M2's plausibility floors;
//   - the winners pass the section-A checks M3 will gate on: distinctness by M2's rule,
//     no sell while a creep is alive, peak creeps alive within budget.
//
// Every literal below is M2's own measured number (`story-showcase.test.ts`, m2.md
// story 11), not re-measured here. M2's runs are short (~4,000 ticks, a fraction of a
// second each outside coverage), so this lives in the default suite; M3's full-arc runs
// will be the slow, opt-in ones.

import { describe, it, expect } from 'vitest';
import { compileRuleset, deriveStars, hashSimState } from '@wynding/sim';
import { getBundledRuleset } from './registry';
import { compileReferenceBuild } from './reference-build';
import {
  M2_PINNED_LOSER,
  M2_SHOWCASE,
  M2_WINNER_A,
  M2_WINNER_B,
  REFERENCE_SETS,
} from './reference-builds';
import { LOSER, WINNER_A, WINNER_B } from './showcase-builds';
import { runBuildScript, type ScriptStep } from './script-runner';
import { runReferenceBuild, type BuildRun } from './balance-run';
import {
  checkAllStepsRan,
  checkDistinctness,
  checkLossWindow,
  checkNoSellWithLiveCreep,
  checkPlausibility,
  locateLoss,
  totalScheduledSpawns,
} from './balance-checks';
import { balanceReport } from './balance-report';
import { waveIndexForCreep } from './wave-lookup';

const ruleset = compileRuleset(getBundledRuleset(M2_SHOWCASE.rulesetId), M2_SHOWCASE.boardId);
const SEED = M2_SHOWCASE.seed;

/** M3's section-A budget on creeps alive at once. */
const PEAK_ALIVE_BUDGET = 200;

const CASES = [
  { build: M2_WINNER_A, legacy: WINNER_A },
  { build: M2_WINNER_B, legacy: WINNER_B },
  { build: M2_PINNED_LOSER, legacy: LOSER },
] as const;

describe('M3 story 1 — the balance checker, calibrated on M2', () => {
  // Lazy memos (the sibling story files' pattern): each full run happens inside the first
  // test that needs it, under that test's own timeout, never at collection time.
  const memo = new Map<string, BuildRun>();
  const measured = (id: string): BuildRun => {
    let run = memo.get(id);
    if (run === undefined) {
      const build = CASES.find((c) => c.build.id === id)!.build;
      run = runReferenceBuild(ruleset, SEED, compileReferenceBuild(build, ruleset));
      memo.set(id, run);
    }
    return run;
  };

  it('registers M2’s showcase on its own board and seed', () => {
    expect(REFERENCE_SETS).toContain(M2_SHOWCASE);
    expect(M2_SHOWCASE).toMatchObject({
      rulesetId: 'wynding-core',
      boardId: 'field-01',
      seed: 0x5eed,
    });
    expect(M2_SHOWCASE.builds).toEqual([M2_WINNER_A, M2_WINNER_B, M2_PINNED_LOSER]);
  });

  it.each(CASES)('$build.id compiles to exactly the plan M2’s pins run', ({ build, legacy }) => {
    const compiled: ScriptStep[] = compileReferenceBuild(build, ruleset);
    expect(compiled).toStrictEqual(legacy);
  });

  it.each(CASES)(
    '$build.id drives the sim to the same final world-hash as that plan run bare, every step run',
    { timeout: 120_000 },
    ({ build, legacy }) => {
      const bare = runBuildScript(ruleset, SEED, legacy);
      const run = measured(build.id);
      expect(hashSimState(run.state)).toBe(hashSimState(bare.state));
      expect(checkAllStepsRan(build.id, run)).toEqual([]);
    },
  );

  it(
    'Winner A in grid form lands on the M2 determinism golden’s own final hash',
    { timeout: 120_000 },
    () => {
      // `m2-golden.test.ts`'s `GOLDEN.finalHash` — the one M2 pin that holds a literal hash.
      expect(hashSimState(measured(M2_WINNER_A.id).state)).toBe('34cb27bf');
    },
  );

  it.each([
    [M2_WINNER_A.id, 4070],
    [M2_WINNER_B.id, 4062],
  ] as const)(
    '%s wins the arc on 10 lives, 3★, at tick %i, every creep killed and every step placed',
    { timeout: 120_000 },
    (id, tick) => {
      const run = measured(id);
      expect(run.state.phase).toBe('won');
      expect(run.state.lives).toBe(10);
      expect(deriveStars(run.state, ruleset)).toBe(3);
      expect(run.state.tick).toBe(tick);
      expect(run.leaks).toEqual([]);
      expect(run.kills).toBe(117);
      expect(run.kills).toBe(totalScheduledSpawns(ruleset));
      expect(run.stepsDone).toBe(40);
      expect(run.waves.map((w) => w.wave)).toEqual(ruleset.waves.map((_, k) => k));
    },
  );

  it(
    'the pinned loser loses at arc wave 8 — located by creep id — and clears M2’s plausibility floors',
    { timeout: 120_000 },
    () => {
      const run = measured(M2_PINNED_LOSER.id);
      const wall = waveIndexForCreep(ruleset, 'armored-flyer');
      expect(wall).toBe(7); // arc wave 8, re-asserted so a schedule edit fails here by name

      expect(run.state.phase).toBe('lost');
      expect(run.state.lives).toBe(0);
      expect(deriveStars(run.state, ruleset)).toBe(0);
      expect(run.state.waveLaunchTick[wall]).not.toBeNull();
      expect(
        checkLossWindow(M2_PINNED_LOSER.id, run, ruleset, {
          fromWaveOf: 'armored-flyer',
          toWaveOf: 'armored-flyer',
        }),
      ).toEqual([]);
      expect(locateLoss(run)!.fatalLeaks.map((l) => l.creepId)).toEqual(['armored-flyer']);

      // M2's own floors (story-showcase.test.ts) and its measured run: spend 82 across
      // three ids, 72 kills.
      expect(
        checkPlausibility(M2_PINNED_LOSER.id, run, ruleset, {
          minSpend: 60,
          minTowerKinds: 3,
          minKills: 40,
          reachesWaveOf: 'flying',
        }),
      ).toEqual([]);
      expect(run.spend).toBe(82);
      expect(Object.keys(run.spendById).sort()).toEqual(['basic', 'slow', 'venom']);
      expect(run.kills).toBe(72);
    },
  );

  it(
    'the winners pass section A: distinct by M2’s rule, no sell with a creep alive, peak alive within budget',
    { timeout: 120_000 },
    () => {
      const a = measured(M2_WINNER_A.id);
      const b = measured(M2_WINNER_B.id);
      expect(
        checkDistinctness([
          { id: M2_WINNER_A.id, spendById: a.spendById },
          { id: M2_WINNER_B.id, spendById: b.spendById },
        ]),
      ).toEqual([]);
      // M2's measured top-two spend: venom 198 / antiair 84 of 312; slow 96 / beacon 90 of 308.
      expect([a.spendById['venom'], a.spendById['antiair'], a.spend]).toEqual([198, 84, 312]);
      expect([b.spendById['slow'], b.spendById['beacon'], b.spend]).toEqual([96, 90, 308]);

      for (const [id, run] of [
        [M2_WINNER_A.id, a],
        [M2_WINNER_B.id, b],
      ] as const) {
        expect(checkNoSellWithLiveCreep(id, run)).toEqual([]);
        expect(run.peakAlive).toBeLessThanOrEqual(PEAK_ALIVE_BUDGET);
      }
      expect(totalScheduledSpawns(ruleset)).toBeLessThanOrEqual(2000);
    },
  );

  it(
    'the balance report runs every M2 build and names the board-full wave',
    { timeout: 120_000 },
    () => {
      // M2's set only: the command runs every registered set, and M3's full-arc runs
      // belong there, not in the default suite.
      const { text, failures } = balanceReport([M2_SHOWCASE], getBundledRuleset);
      expect(failures).toEqual([]);
      for (const build of M2_SHOWCASE.builds)
        expect(text).toContain(`${build.id} — ${build.summary}`);
      expect(text).toContain('won · tick 4070 · lives 10 · score 711 · 3★ · steps 40/40');
      expect(text).toContain('lost to 1 armored-flyer from wave 8 while on wave 9');
      // Winner A and B tie on lives and score; the first registered is the strongest, and
      // its last tower goes down in the boss wave's window.
      expect(text).toContain(
        'board-full: the strongest build, m2-winner-a (won on 10 lives), placed its last tower in wave 10',
      );
    },
  );
});
