// run-length.test.ts — the run-length cap at sv17 (M3 story 2): `MAX_MATCH_TICKS` 72,000,
// read by both the compile gate (`compileRuleset`) and this package's validator, proven
// together on a synthetic 30-wave arc (`test-support.ts`) — the first schedule in the repo
// that the sv16 cap of 36,000 could not hold — and the validator's ceiling enforced at
// the far end, where a run that never ends is rejected as a timeout.

import { describe, it, expect } from 'vitest';
import {
  compileRuleset,
  createInitialState,
  step,
  DIAG_LEN,
  MAX_MATCH_TICKS,
  RulesetError,
  SIM_VERSION,
  type SimInput,
} from '@wynding/sim';
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

describe('the scripted defense plan is well formed — all 56 entries, without simulating', () => {
  // The suites below play only its first sixteen entries; the Verify wall-time measurement
  // plays all of them. So the rest are checked here by shape: a bad entry would be skipped
  // silently by `playScript`, shrinking the workload without failing anything.
  it('every anchor’s 2 × 2 footprint is on the board, off the entrance and exit, and overlaps no other; every tower is in the catalog and affordable from the start', () => {
    const board = thirtyWaveBundle(M2).boards[0]!;
    expect(DEFENSE_PLAN).toHaveLength(56);
    const taken = new Set<string>();
    for (const { col, row, towerId } of DEFENSE_PLAN) {
      for (const [c, r] of [
        [col, row],
        [col + 1, row],
        [col, row + 1],
        [col + 1, row + 1],
      ] as const) {
        expect(c >= 0 && c < board.widthTiles && r >= 0 && r < board.heightTiles).toBe(true);
        expect(`${c},${r}`).not.toBe(`${board.entrance.col},${board.entrance.row}`);
        expect(`${c},${r}`).not.toBe(`${board.exit.col},${board.exit.row}`);
        expect(taken.has(`${c},${r}`), `cell ${c},${r} is taken twice`).toBe(false);
        taken.add(`${c},${r}`);
      }
      const tower = M2.towerCatalog.find((t) => t.id === towerId);
      expect(tower, towerId).toBeDefined();
      expect(tower!.cost).toBeLessThanOrEqual(M2.balance.startingBounty);
    }
  });
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

describe('the validator’s catch-up ceiling', () => {
  it('a log that never reaches a terminal state by MAX_MATCH_TICKS is a timeout, not a hang', () => {
    // The one nonterminal state play can reach (M2-S6, chain-lock is permitted): two
    // always-stun towers, placed 20 ticks apart over a creep whose armor blanks their
    // damage, hold it forever — so its wave never resolves and the run never ends. The log
    // stops once the lock holds; the validator drives empty ticks to its ceiling and
    // rejects the replay there. `packages/sim`'s story-stun test 14 proves the lock over
    // the sim alone, on an injected creep; this one plays it from a real spawn through a
    // real log, so the rejection branch itself runs.
    const bundle: Ruleset = {
      formatVersion: 2,
      rulesetId: 'stun-lock',
      version: 1,
      creepCatalog: [
        {
          id: 'blanked',
          hp: 200,
          speedFp: 22,
          armor: 6,
          domain: 'ground',
          immunities: [],
          leakCost: 1,
          bounty: 1,
        },
      ],
      towerCatalog: [
        {
          id: 'stun-blank',
          cost: 10,
          attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 40, travelTicks: 2 },
          effects: [
            { kind: 'direct', form: 'single', damage: 4 },
            { kind: 'stun', chanceNum: 256, durationTicks: 20 },
          ],
        },
      ],
      balance: {
        startingLives: 10,
        startingBounty: 80,
        refundNum: 3,
        refundDen: 4,
        slowFloorNum: 1,
        slowFloorDen: 4,
        earlyCallBountyDivisor: 0,
      },
      scoring: { survivalMul: 25, starThresholds: [1, 6, 9], earlyCallScoreDivisor: 0 },
      boards: [
        {
          id: 'lane',
          widthTiles: 14,
          heightTiles: 14,
          entrance: { col: 0, row: 6 },
          exit: { col: 13, row: 6 },
          waves: [
            {
              index: 0,
              countdownTicks: 5,
              clearBonus: 0,
              entries: [{ creepId: 'blanked', count: 1, spacingTicks: 20 }],
            },
          ],
        },
      ],
    };
    const ruleset = compileRuleset(bundle, 'lane');
    let state = createInitialState(1, ruleset);
    const tickInputs: SimInput[][] = [];
    let lockedAt: { col: number; row: number; tick: number } | null = null;
    for (let t = 0; t < 400; t++) {
      const inputs: SimInput[] = [];
      const head = state.creeps.headCol[0];
      if (lockedAt === null && head !== undefined && head >= 5) {
        // Above the creep's row now, below it 20 ticks later: both in range, neither on it.
        lockedAt = { col: head, row: state.creeps.headRow[0]!, tick: t };
        inputs.push({
          kind: 'placeTower',
          anchor: { col: head, row: lockedAt.row - 2 },
          towerId: 'stun-blank',
        });
      } else if (lockedAt !== null && t === lockedAt.tick + 20) {
        inputs.push({
          kind: 'placeTower',
          anchor: { col: lockedAt.col, row: lockedAt.row + 2 },
          towerId: 'stun-blank',
        });
      }
      tickInputs.push(inputs);
      state = step(state, ruleset, inputs);
    }
    // The lock holds: both towers stand, and the creep is alive, unhurt and stunned.
    expect(state.towers.id).toHaveLength(2);
    expect(state.creeps.hp[0]).toBe(200);
    expect(state.creeps.stunUntilTick[0]).toBeGreaterThanOrEqual(state.tick);
    expect(state.phase).toBe('running');

    const r = validate(
      {
        seed: 1,
        boardId: 'lane',
        rulesetHash: currentRulesetHash(bundle),
        simVersion: SIM_VERSION,
        tickInputs,
      },
      bundle,
    );
    expect(r).toEqual({
      ok: false,
      reason: `replay did not terminate within ${MAX_MATCH_TICKS} ticks (timeout)`,
    });
  }, 60_000);
});
