// m2-golden.test.ts — M2 Story 11 P5: the M2 CLOSE-OUT determinism golden.
//
// A full WINNING run over the finished ten-wave arc, using WINNER A ("the poisoner",
// `./showcase-builds.ts` — the same script `story-showcase.test.ts`'s P4 balance pass
// plays, reused unduplicated) against the REAL shipped `wynding-core` bundle
// (`compileRuleset` -> `createInitialState` -> `step`), pinning `finalHash` and
// `traceDigest` (the `determinism.test.ts` per-tick hash-trace pattern, packages/sim/
// src/determinism.test.ts) plus score and stars.
//
// A MID-TRACE ENGAGEMENT PROBE is asserted BEFORE any terminal assertion: the run
// reaches wave 10 (index 9), the boss took damage (observed mid-run, before it died),
// and the terminal is a win. This is what makes the golden un-re-pinnable-green after a
// change that makes wave 10 unreachable — a golden that only pinned the terminal hash
// could be "fixed" by moving the goalposts (e.g. a change that quietly caps the arc at
// wave 9) simply by re-recording it; the probe fails first and names what broke.
//
// `packages/sim/src/determinism.test.ts`'s own `GOLDEN` (a synthetic bundle, the sim's
// OWN version gate, gated by `SIM_VERSION`) is NOT touched here and must not move: S11
// changes no sim code, so a move there would be a defect signal, never a re-pin.
//
// Every numeric literal below is MEASURED and `console.log`'d on every run — regenerate
// with:
//   pnpm --filter @wynding/content exec vitest run m2-golden

import { describe, it, expect } from 'vitest';
import {
  compileRuleset,
  hashSimState,
  deriveScore,
  deriveStars,
  type SimState,
  type CompiledRuleset,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';
import { waveIndexForCreep } from './wave-lookup';
import { WINNER_A } from './showcase-builds';
import { runBuildScript } from './script-runner';
// The package's ONE fnv1a copy (test-digest.ts) — parity.test.ts digests through the
// same function; a drifted duplicate would let both files keep passing while producing
// different digests for the same trace.
import { fnv1a } from './test-digest';

const SCENARIO_SEED = 0x5eed;

interface GoldenRun {
  readonly state: SimState;
  readonly ruleset: CompiledRuleset;
  readonly trace: readonly string[];
  /** The boss's hp was observed to DECREASE at least once before the run's terminal —
   *  a real hit landed mid-run, not merely that a full-hp boss was seen spawning. */
  readonly bossDamagedMidRun: boolean;
  /** `state.waveLaunchTick` at the boss's wave index, observed at the terminal — `null`
   *  if that wave never launched. */
  readonly bossWaveLaunchTick: number | null;
}

/** Run WINNER A's script to its terminal, collecting the per-tick hash trace (the
 *  `determinism.test.ts` pattern) and the mid-trace engagement probe's observations. */
function runGolden(): GoldenRun {
  const bundle = getBundledRuleset();
  const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
  const bossWaveIndex = waveIndexForCreep(ruleset, 'boss');
  const trace: string[] = [];

  const prevBossHp = new Map<number, number>();
  let bossDamagedMidRun = false;

  const { state } = runBuildScript(ruleset, SCENARIO_SEED, WINNER_A, {
    afterStep: (state) => {
      for (let i = 0; i < state.creeps.id.length; i++) {
        if (state.creeps.creepId[i] !== 'boss') continue;
        const id = state.creeps.id[i]!;
        const hp = state.creeps.hp[i]!;
        const prev = prevBossHp.get(id);
        if (prev !== undefined && hp < prev) bossDamagedMidRun = true;
        prevBossHp.set(id, hp);
      }

      trace.push(hashSimState(state));
    },
  });

  return {
    state,
    ruleset,
    trace,
    bossDamagedMidRun,
    bossWaveLaunchTick: state.waveLaunchTick[bossWaveIndex] ?? null,
  };
}

// --- GOLDEN — a behavior change here requires a SIM_VERSION bump (S11 changes no sim
// code, so a move here without one is a defect signal, never a re-pin) ---------------
// Recompute with: pnpm --filter @wynding/content exec vitest run m2-golden
const GOLDEN = {
  finalHash: '34cb27bf',
  traceDigest: 'bb093415',
  score: 711,
  stars: 3,
} as const;
// -------------------------------------------------------------------------------------

describe('M2-S11 P5 — the M2 close-out determinism golden (Winner A, "the poisoner", over the finished ten-wave arc)', () => {
  // 120s test budgets: each of these drives a full ~4,070-tick arc run (the first one
  // twice, for the reproduction proof). Vitest's 5s default passes on a dev machine and
  // times out on the slower CI runner under coverage — observed on PR #93's first run.
  it('reproduces a byte-identical trace from the same (seed, script)', () => {
    const a = runGolden();
    const b = runGolden();
    expect(a.trace).toEqual(b.trace);
    expect(hashSimState(a.state)).toBe(hashSimState(b.state));
  }, 120_000);

  it('the MID-TRACE ENGAGEMENT PROBE, before any terminal assertion: wave 10 (index 9) is reached, the boss took damage mid-run, and the terminal is a win', () => {
    const r = runGolden();
    const bossWaveIndex = waveIndexForCreep(r.ruleset, 'boss');
    console.log(
      `[m2-golden] bossWaveIndex=${bossWaveIndex} bossWaveLaunchTick=${r.bossWaveLaunchTick} ` +
        `bossDamagedMidRun=${r.bossDamagedMidRun} phase=${r.state.phase}`,
    );

    // Wave 10 is index 9 in the compiled schedule — LOCATED by creep id (ruling 1),
    // never a hardcoded index, and re-asserted as the literal 9 so a schedule edit that
    // moves the boss off wave 10 fails here BY NAME, not just silently elsewhere.
    expect(bossWaveIndex).toBe(9);
    expect(r.bossWaveLaunchTick).not.toBeNull();

    // The boss took a real hit before it died — this is what a future change making
    // wave 10 unreachable (or the boss unengaged) cannot re-pin green: the probe below
    // fails FIRST, before the hash/score/stars assertions ever run.
    expect(r.bossDamagedMidRun).toBe(true);

    // ...AND WON.
    expect(r.state.phase).toBe('won');
  }, 120_000);

  it('matches the committed golden: finalHash, traceDigest, score, stars', () => {
    const r = runGolden();
    const finalHash = hashSimState(r.state);
    const traceDigest = fnv1a(r.trace.join(':'));
    const score = deriveScore(r.state, r.ruleset);
    const stars = deriveStars(r.state, r.ruleset);
    console.log(
      `[m2-golden] finalHash=${finalHash} traceDigest=${traceDigest} score=${score} stars=${stars} ` +
        `tick=${r.state.tick} lives=${r.state.lives} phase=${r.state.phase}`,
    );

    expect(finalHash).toBe(GOLDEN.finalHash);
    expect(traceDigest).toBe(GOLDEN.traceDigest);
    expect(score).toBe(GOLDEN.score);
    expect(stars).toBe(GOLDEN.stars);
  }, 120_000);
});
