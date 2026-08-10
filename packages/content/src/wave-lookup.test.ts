// wave-lookup.test.ts — unit coverage for the S11 P2 test-support module itself.
//
// The story files exercise every happy path against real runs; what they never reach
// are the module's own guard branches (unknown creep id, out-of-range wave index, the
// pre-launch nulls on a fresh state). Those are pinned here directly — cheap, no sim
// stepping — so the guards stay covered and a regression in them fails HERE, not as a
// silent never-arming wall inside a 4,000-tick story scene.

import { describe, it, expect } from 'vitest';
import { compileRuleset, createInitialState } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';
import {
  waveIndexForCreep,
  waveCountdownStartTick,
  waveLaunchTickObserved,
  anchoredWallInputs,
} from './wave-lookup';

const bundle = getBundledRuleset();
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
const SEED = 0x5eed;

describe('waveIndexForCreep', () => {
  it('locates each showcase wave by FIRST spawn in the compiled schedule', () => {
    expect(waveIndexForCreep(ruleset, 'normal')).toBe(0);
    expect(waveIndexForCreep(ruleset, 'swarm')).toBe(1); // waves 4 and 8 also carry swarm
    expect(waveIndexForCreep(ruleset, 'flying')).toBe(5); // wave 8 also carries flying
    expect(waveIndexForCreep(ruleset, 'resolute')).toBe(6);
    expect(waveIndexForCreep(ruleset, 'boss')).toBe(9);
  });

  it('throws on a creep id no wave spawns, rather than returning a sentinel', () => {
    expect(() => waveIndexForCreep(ruleset, 'no-such-creep')).toThrow(/no-such-creep/);
  });
});

describe('the observed-transition readers on a fresh (pre-launch) state', () => {
  const state = createInitialState(SEED, ruleset);

  it('waveCountdownStartTick: wave 0 counts down from tick 0; later waves are null until the prior launch is observed', () => {
    expect(waveCountdownStartTick(state, 0)).toBe(0);
    expect(waveCountdownStartTick(state, 1)).toBeNull();
  });

  it('waveLaunchTickObserved: null before any launch', () => {
    expect(waveLaunchTickObserved(state, 0)).toBeNull();
  });
});

describe('anchoredWallInputs guards', () => {
  it('throws up front on a wave index outside the compiled schedule (both ends)', () => {
    expect(() => anchoredWallInputs(ruleset, ruleset.waves.length, [], 'basic', 0)).toThrow(
      /outside the compiled schedule/,
    );
    expect(() => anchoredWallInputs(ruleset, -1, [], 'basic', 0)).toThrow(
      /outside the compiled schedule/,
    );
  });

  it('throws up front on a non-positive spacingTicks (the modulo gate would never place)', () => {
    expect(() => anchoredWallInputs(ruleset, 1, [], 'basic', 0, 0)).toThrow(/must be positive/);
    expect(() => anchoredWallInputs(ruleset, 1, [], 'basic', 0, -5)).toThrow(/must be positive/);
  });

  it('produces no inputs before the target wave’s countdown start is observed', () => {
    const inputs = anchoredWallInputs(ruleset, 1, [{ col: 2, row: 10 }], 'basic', 0);
    const state = createInitialState(SEED, ruleset);
    expect(inputs(0, state)).toEqual([]);
  });
});
