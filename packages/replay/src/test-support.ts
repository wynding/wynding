// test-support.ts — the synthetic 30-wave run (M3 story 2), shared by this package's
// tests. Not part of the public API (`./index.ts` does not re-export it), the
// `packages/sim/src/test-support.ts` precedent.
//
// THE BUNDLE is M3's first-pass 30-wave arc (`docs/milestones/m3.md`, "First-pass arc"):
// its compositions, spacings, offsets, countdowns and clear bonuses, with every stream
// sent from the one entrance a format-2 board has (entrances arrive with format 3, story
// 3) and no `hpPercent` (format 3 too). It stands on M2's 28 × 24 board geometry with
// M2's catalog and economy, which the caller passes in, so this module needs no edge to
// `@wynding/content`. Its compile bound is the spec's own: hands-off latest spawn 17,790
// plus the worst-case walk 27,030 = 44,820 ticks, past sv16's 36,000 cap and inside
// sv17's 72,000.
//
// THE REPLAY is a fixed scripted defense played to its terminal tick and recorded the
// way the client records: each tick's inputs through the terminal one and nothing after.

import {
  compileRuleset,
  createInitialState,
  hashSimState,
  isTerminalPhase,
  step,
  MAX_MATCH_TICKS,
  SIM_VERSION,
  type SimInput,
  type SimState,
} from '@wynding/sim';
import type { Ruleset, WaveEntry, WaveSchedule } from '@wynding/types';
import { currentRulesetHash, type Replay } from './index';

export const THIRTY_WAVE_BOARD_ID = 'thirty-wave';

/** One stream of a wave: `count` × `creepId` every `spacingTicks`, starting `offsetTicks`
 *  after the wave's launch. */
type Stream = readonly [creepId: string, count: number, spacingTicks: number, offsetTicks?: number];

/** The first-pass arc, row for row: streams, countdown, clear bonus. The spec's W and N
 *  routes collapse onto the one entrance. */
// prettier-ignore
const ARC: readonly (readonly [streams: readonly Stream[], countdown: number, clear: number])[] = [
  // One wave per line, numbered in the trailing comment and held that way by the
  // `prettier-ignore` above: a table a reader checks against the spec's by eye.
  [[['normal', 10, 20]], 600, 2],                                                        //  1
  [[['swarm', 16, 5]], 500, 2],                                                          //  2
  [[['normal', 10, 20]], 500, 2],                                                        //  3
  [[['fast', 8, 15], ['fast', 6, 15, 60]], 500, 2],                                      //  4
  [[['armored', 6, 25], ['normal', 8, 20]], 500, 2],                                     //  5
  [[['flying', 8, 15]], 500, 2],                                                         //  6
  [[['normal', 12, 15], ['swarm', 10, 6]], 500, 2],                                      //  7
  [[['resolute', 6, 15], ['fast', 6, 15]], 500, 2],                                      //  8
  [[['armored-flyer', 6, 20], ['normal', 8, 20, 100]], 500, 2],                          //  9
  [[['boss', 1, 20], ['normal', 8, 20, 600]], 600, 6],                                   // 10
  [[['normal', 8, 20], ['normal', 8, 20]], 700, 3],                                      // 11
  [[['swarm', 14, 5], ['swarm', 12, 5]], 500, 3],                                        // 12
  [[['resolute', 8, 15], ['resolute', 8, 15]], 500, 3],                                  // 13
  [[['armored', 6, 25], ['armored', 6, 25]], 500, 3],                                    // 14
  [[['normal', 10, 15], ['swarm', 10, 5], ['fast', 6, 15, 120]], 500, 3],                // 15
  [[['flying', 10, 12]], 550, 3],                                                        // 16
  [[['fast', 12, 12], ['resolute', 8, 15]], 500, 3],                                     // 17
  [[['armored', 8, 20], ['swarm', 16, 5]], 500, 3],                                      // 18
  [[['armored-flyer', 8, 18], ['armored', 8, 20], ['swarm', 10, 5, 120]], 550, 3],       // 19
  [[['boss', 1, 20], ['boss', 1, 20, 200], ['normal', 8, 20, 600],
    ['normal', 8, 20, 800]], 700, 7],                                                    // 20
  [[['normal', 6, 15], ['normal', 6, 15]], 800, 4],                                      // 21
  [[['swarm', 16, 4], ['swarm', 10, 4]], 500, 4],                                        // 22
  [[['fast', 10, 12], ['fast', 10, 12]], 550, 4],                                        // 23
  [[['armored', 8, 20], ['armored', 8, 20]], 550, 4],                                    // 24
  [[['normal', 10, 12], ['normal', 10, 12], ['swarm', 8, 4, 150]], 550, 4],              // 25
  [[['armored-flyer', 10, 15], ['flying', 10, 15]], 600, 4],                             // 26
  [[['swarm', 14, 4], ['fast', 8, 12, 60], ['resolute', 6, 12]], 550, 4],                // 27
  [[['armored', 8, 20], ['armored', 8, 20], ['fast', 8, 12, 100]], 550, 4],              // 28
  [[['armored-flyer', 8, 15], ['armored-flyer', 6, 15], ['armored', 8, 18],
    ['swarm', 8, 4, 120]], 600, 4],                                                      // 29
  [[['boss', 2, 400], ['boss', 1, 20, 200], ['armored-flyer', 8, 20, 1000],
    ['armored-flyer', 8, 20, 800]], 700, 8],                                             // 30
];

export interface ThirtyWaveOptions {
  /** Ticks added to the finale's countdown — the knob the bound tests move the compile
   *  bound with, one tick at a time. Default 0: the spec's own 700. */
  readonly finaleDelayTicks?: number;
  /** Default 1,000, so a scripted defense that leaks still plays all thirty waves: the
   *  fixture measures run length, not balance. */
  readonly startingLives?: number;
}

/** The synthetic 30-wave bundle, on `base`'s catalog, balance and scoring. */
export function thirtyWaveBundle(base: Ruleset, options: ThirtyWaveOptions = {}): Ruleset {
  const waves: WaveSchedule[] = ARC.map(([streams, countdown, clear], index) => ({
    index,
    countdownTicks:
      index === ARC.length - 1 ? countdown + (options.finaleDelayTicks ?? 0) : countdown,
    clearBonus: clear,
    entries: streams.map(([creepId, count, spacingTicks, offsetTicks]): WaveEntry =>
      offsetTicks === undefined
        ? { creepId, count, spacingTicks }
        : { creepId, count, spacingTicks, offsetTicks },
    ),
  }));
  return {
    ...base,
    rulesetId: 'thirty-wave-synthetic',
    balance: { ...base.balance, startingLives: options.startingLives ?? 1_000 },
    boards: [
      {
        id: THIRTY_WAVE_BOARD_ID,
        widthTiles: 28,
        heightTiles: 24,
        entrance: { col: 0, row: 11 },
        exit: { col: 27, row: 11 },
        waves,
      },
    ],
  };
}

/** One scripted placement. */
export interface Placement {
  readonly col: number;
  readonly row: number;
  readonly towerId: string;
}

/** The scripted defense: 56 2 × 2 towers on a 3-tile lattice (a one-tile lane between any
 *  two, so no placement can seal the path), nearest the entrance → exit row first, eight of
 *  the catalog's kinds in turn (every kind but the `mine`, which its first trigger consumes,
 *  leaving its cell empty). Built to give the re-simulation a real workload, not to win on
 *  merit. */
export const DEFENSE_PLAN: readonly Placement[] = (() => {
  const kinds = ['basic', 'antiair', 'venom', 'slow', 'splash', 'stun', 'frost-splash', 'beacon'];
  const anchors: { col: number; row: number }[] = [];
  for (let col = 2; col <= 23; col += 3) {
    for (let row = 2; row <= 20; row += 3) anchors.push({ col, row });
  }
  // Distance from the lane between rows 10 and 11, doubled to stay in integers.
  anchors.sort((a, b) => Math.abs(2 * a.row - 21) - Math.abs(2 * b.row - 21) || a.col - b.col);
  return anchors.map((a, i) => ({ ...a, towerId: kinds[i % kinds.length]! }));
})();

export interface ScriptedRun {
  readonly replay: Replay;
  /** The live run's terminal state, for comparing against the re-simulation. */
  readonly state: SimState;
  readonly liveFinalHash: string;
  /** Towers the sim accepted (a rejected placement is skipped, never retried). */
  readonly placed: number;
}

/**
 * Play `plan` on `bundle`'s only board: each placement is issued the first tick its cost
 * is covered, and the script moves on whether or not the sim accepts it. No early calls —
 * every wave launches on its own countdown. Recording stops at the terminal tick, the
 * client's own contract, so the log validates.
 */
export function playScript(
  bundle: Ruleset,
  seed: number,
  plan: readonly Placement[] = DEFENSE_PLAN,
): ScriptedRun {
  const boardId = bundle.boards[0]!.id;
  const ruleset = compileRuleset(bundle, boardId);
  let state = createInitialState(seed, ruleset);
  const tickInputs: (readonly SimInput[])[] = [];
  let cursor = 0;
  let placed = 0;
  while (state.tick < MAX_MATCH_TICKS && !isTerminalPhase(state.phase)) {
    const inputs: SimInput[] = [];
    const next = plan[cursor];
    if (next !== undefined && state.bounty >= ruleset.towerById[next.towerId]!.cost) {
      inputs.push({
        kind: 'placeTower',
        anchor: { col: next.col, row: next.row },
        towerId: next.towerId,
      });
    }
    const before = state.towers.id.length;
    tickInputs.push(inputs);
    state = step(state, ruleset, inputs);
    if (inputs.length > 0) {
      cursor++;
      if (state.towers.id.length > before) placed++;
    }
  }
  return {
    replay: {
      seed,
      boardId,
      rulesetHash: currentRulesetHash(bundle),
      simVersion: SIM_VERSION,
      tickInputs,
    },
    state,
    liveFinalHash: hashSimState(state),
    placed,
  };
}
