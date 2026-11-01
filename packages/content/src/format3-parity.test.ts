// format3-parity.test.ts — M3 story 3's PARITY GATE: `field-01` expressed in `formatVersion`
// 3 reproduces format 2's run over the M2 golden replay, tick for tick.
//
// The reference below is NOT a golden to re-pin. It is the format-2 record: the
// `m2-golden.test.ts` values measured on `main` immediately before story 3 began (sv16,
// format 2, `field-01` with its single `entrance`/`exit`) — the per-tick world-hash trace
// of WINNER A's run, its final hash, the terminal outcome, the score, the stars and the
// final tick. Story 3 re-encodes `field-01` as one entrance → exit pair (`west` →
// `east`, every wave entry on `west`, every `hpPercent` 100) and must change NOTHING about
// that run: every pre-existing `SimState` field, on every tick.
//
// What the comparison deliberately leaves out is the NEW per-creep state story 3 adds —
// the `destination` creep column (the index of the creep's destination flow-field, ADR
// 0015). It is appended LAST on the creep SoA, so projecting it out leaves exactly the
// format-2 state's JSON — same keys, same order — and `hashSimState` of that projection
// is byte-comparable with the format-2 hash. Everything else is in the comparison.
//
// `m2-golden.test.ts` itself re-pins at story 3's `SIM_VERSION` bump (the destination
// column enters the world hash); this file never does. If it goes red, format 3 changed
// how `field-01` plays — a defect, not a re-pin.

import { describe, it, expect } from 'vitest';
import { compileRuleset, hashSimState, deriveScore, deriveStars } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';
import { WINNER_A } from './showcase-builds';
import { runBuildScript } from './script-runner';
import { fnv1a, withoutDestination } from './test-digest';

/** `m2-golden.test.ts`'s seed — the same run. */
const SCENARIO_SEED = 0x5eed;

/** The format-2 run of WINNER A over `field-01` (sv16, measured on `main` at 3d8d410,
 *  before any story-3 change). Frozen: a historical record, never re-measured. */
const FORMAT2_REFERENCE = {
  traceHashDigest: 'bb093415',
  finalStateHash: '34cb27bf',
  phase: 'won',
  score: 711,
  stars: 3,
  tick: 4070,
  lives: 10,
} as const;

describe('M3 story 3 — format 3 parity: field-01 reproduces the format-2 run of the M2 golden replay', () => {
  it('the bundle under test IS format 3, one entrance → exit pair, every hpPercent 100', () => {
    const bundle = getBundledRuleset();
    expect(bundle.formatVersion).toBe(3);
    const board = bundle.boards[0]!;
    expect(board.entrances.map((e) => e.id)).toEqual(['west']);
    expect(board.exits.map((x) => x.id)).toEqual(['east']);
    expect(board.waves.every((w) => w.hpPercent === 100)).toBe(true);
    expect(board.waves.every((w) => w.entries.every((e) => e.entrance === 'west'))).toBe(true);
  });

  it('matches the format-2 run tick for tick: every pre-existing state field, the outcome, the score and the final tick', () => {
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const trace: string[] = [];
    const { state } = runBuildScript(ruleset, SCENARIO_SEED, WINNER_A, {
      afterStep: (s) => {
        trace.push(hashSimState(withoutDestination(s)));
      },
    });
    const traceHashDigest = fnv1a(trace.join(':'));
    const finalStateHash = hashSimState(withoutDestination(state));
    console.log(
      `[format3-parity] traceHashDigest=${traceHashDigest} finalStateHash=${finalStateHash} ` +
        `phase=${state.phase} score=${deriveScore(state, ruleset)} stars=${deriveStars(state, ruleset)} ` +
        `tick=${state.tick} lives=${state.lives}`,
    );

    // The per-tick digest covers every tick's whole projected state, so it alone proves
    // tick-for-tick parity; the terminal observables are asserted separately so a failure
    // names WHAT diverged, not only that something did.
    expect(state.phase).toBe(FORMAT2_REFERENCE.phase);
    expect(state.tick).toBe(FORMAT2_REFERENCE.tick);
    expect(trace).toHaveLength(FORMAT2_REFERENCE.tick);
    expect(state.lives).toBe(FORMAT2_REFERENCE.lives);
    expect(deriveScore(state, ruleset)).toBe(FORMAT2_REFERENCE.score);
    expect(deriveStars(state, ruleset)).toBe(FORMAT2_REFERENCE.stars);
    expect(finalStateHash).toBe(FORMAT2_REFERENCE.finalStateHash);
    expect(traceHashDigest).toBe(FORMAT2_REFERENCE.traceHashDigest);
  }, 120_000);
});
