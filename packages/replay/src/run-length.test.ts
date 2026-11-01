// run-length.test.ts — the run-length cap at sv17 (M3 story 2): `MAX_MATCH_TICKS` 72,000,
// read by both the compile gate (`compileRuleset`) and this package's validator, proven
// together on a synthetic 30-wave arc (`test-support.ts`) — the first schedule in the repo
// that the sv16 cap of 36,000 could not hold.

import { describe, it, expect } from 'vitest';
import { compileRuleset, DIAG_LEN, MAX_MATCH_TICKS, RulesetError, SIM_VERSION } from '@wynding/sim';
import { getBundledRuleset } from '@wynding/content';
import type { Ruleset } from '@wynding/types';
import { validate, currentRulesetHash } from './index';
import { DEFENSE_PLAN, playScript, thirtyWaveBundle, THIRTY_WAVE_BOARD_ID } from './test-support';

const M2 = getBundledRuleset();
const SV16_CAP = 36_000;

/** `compileRuleset`'s own bound, recomputed from the raw bundle: the hands-off latest
 *  spawn (wave k launches at the prefix sum of countdowns 1..k; its last spawn lands
 *  `tail_k` later) plus the slowest creep's full walk at the slow floor. Read off the
 *  bundle rather than typed, so a fixture edit moves what this computes. */
function compileBound(bundle: Ruleset): { latestSpawn: number; walk: number } {
  const board = bundle.boards[0]!;
  let prefix = 0;
  let latestSpawn = 0;
  for (const wave of board.waves) {
    prefix += wave.countdownTicks;
    for (const e of wave.entries) {
      latestSpawn = Math.max(
        latestSpawn,
        prefix + (e.offsetTicks ?? 0) + (e.count - 1) * e.spacingTicks,
      );
    }
  }
  const slow = bundle.towerCatalog.flatMap((t) => t.effects).find((e) => e.kind === 'slow');
  if (slow?.kind !== 'slow') throw new Error('the catalog has no slow effect');
  const { slowFloorNum, slowFloorDen } = bundle.balance;
  const minEff = Math.min(
    ...bundle.creepCatalog.map((c) =>
      Math.max(
        1,
        Math.floor((c.speedFp * slow.mulFp) / 256),
        Math.ceil((c.speedFp * slowFloorNum) / slowFloorDen),
      ),
    ),
  );
  const walk = Math.ceil((board.widthTiles * board.heightTiles * DIAG_LEN) / minEff);
  return { latestSpawn, walk };
}

describe('the synthetic 30-wave arc compiles at sv17 and would not have at sv16', () => {
  const bundle = thirtyWaveBundle(M2);

  it('its bound is the spec’s 17,790 + 27,030 = 44,820: past 36,000, inside MAX_MATCH_TICKS', () => {
    const { latestSpawn, walk } = compileBound(bundle);
    expect(latestSpawn).toBe(17_790);
    expect(walk).toBe(27_030); // the `boss`, 18 → 9 under `slow`, across 28 × 24
    expect(latestSpawn + walk).toBe(44_820);
    expect(latestSpawn + walk).toBeGreaterThan(SV16_CAP);
    expect(MAX_MATCH_TICKS).toBe(72_000);
    expect(latestSpawn + walk).toBeLessThanOrEqual(MAX_MATCH_TICKS);

    const compiled = compileRuleset(bundle, THIRTY_WAVE_BOARD_ID);
    expect(compiled.waves).toHaveLength(30);
    // The spec's budget table: 546 scheduled spawns over the run.
    expect(compiled.waves.reduce((n, w) => n + w.spawns.length, 0)).toBe(546);
  });

  it('the gate is sharp at the new cap: a bound of exactly 72,000 compiles, 72,001 does not', () => {
    const slack = MAX_MATCH_TICKS - 44_820;
    const atCap = thirtyWaveBundle(M2, { finaleDelayTicks: slack });
    const overCap = thirtyWaveBundle(M2, { finaleDelayTicks: slack + 1 });
    const bound = (b: Ruleset): number => {
      const { latestSpawn, walk } = compileBound(b);
      return latestSpawn + walk;
    };
    expect(bound(atCap)).toBe(72_000);
    expect(bound(overCap)).toBe(72_001);
    expect(() => compileRuleset(atCap, THIRTY_WAVE_BOARD_ID)).not.toThrow();
    expect(() => compileRuleset(overCap, THIRTY_WAVE_BOARD_ID)).toThrow(RulesetError);
    expect(() => compileRuleset(overCap, THIRTY_WAVE_BOARD_ID)).toThrow(
      'ruleset cannot reach a terminal state within the tick budget',
    );

    // ...and the validator turns the over-cap bundle away before simulating anything.
    const r = validate(
      {
        seed: 1,
        boardId: THIRTY_WAVE_BOARD_ID,
        rulesetHash: currentRulesetHash(overCap),
        simVersion: SIM_VERSION,
        tickInputs: [],
      },
      overCap,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('terminal state within the tick budget');
  }, 30_000);
});

describe('a played 30-wave run validates, and so does one that ends past 36,000 ticks', () => {
  // Sized for a test suite: a sixteen-tower slice of the scripted defense, and a hands-off
  // run for the long one. The whole 56-tower plan is what the Verify wall-time measurement
  // replays; under coverage it costs this suite a minute.
  it('a scripted defense of the whole arc re-simulates to the live terminal state', () => {
    const run = playScript(thirtyWaveBundle(M2), 7, DEFENSE_PLAN.slice(0, 16));
    expect(run.state.phase).toBe('won');
    expect(run.state.waveCursor).toBe(30);
    expect(run.placed).toBe(16);
    const ticks = run.replay.tickInputs.length;
    expect(ticks).toBe(run.state.tick);

    const result = validate(run.replay, thirtyWaveBundle(M2));
    expect(result.ok).toBe(true);
    expect(result.finalHash).toBe(run.liveFinalHash);
    expect(result.ticks).toBe(ticks);
  }, 60_000);

  it('a run whose finale waits 20,000 ticks longer ends past the sv16 cap and still validates', () => {
    // Under sv16 this bundle failed to compile, and a log this long was rejected for its
    // length before anything ran: both halves of the cap moved, or neither would pass.
    const bundle = thirtyWaveBundle(M2, { finaleDelayTicks: 20_000 });
    const run = playScript(bundle, 7, []);
    expect(run.state.phase).toBe('won');
    const ticks = run.replay.tickInputs.length;
    expect(ticks).toBeGreaterThan(SV16_CAP);
    expect(ticks).toBeLessThanOrEqual(MAX_MATCH_TICKS);

    const result = validate(run.replay, bundle);
    expect(result.ok).toBe(true);
    expect(result.finalHash).toBe(run.liveFinalHash);
    expect(result.ticks).toBe(ticks);
  }, 60_000);
});
