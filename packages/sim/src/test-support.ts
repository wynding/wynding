// test-support.ts — shared fixtures for the sim test suite.
//
// Kept inside @wynding/sim (NOT importing @wynding/content) so tests — including the
// determinism golden — build their rulesets inline, with no sim→content edge. The
// numbers mirror the M1 content but tests may override the board/wave/economy.

import type { Ruleset, TowerDef } from '@wynding/types';
import type { GridSpec } from './board';
import { compileRuleset, type CompiledRuleset } from './ruleset';
import { cellCenterX, cellCenterY } from './movement';
import type { SimState } from './index';

/** The standard M1 single-target tower stat block. */
export const TEST_TOWER: TowerDef = {
  id: 'basic',
  cost: 5,
  attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
  effects: [{ kind: 'direct', form: 'single', damage: 10 }],
};

/** Overrides for a test bundle (all optional). `waveCount`/`waveSpacing` name the
 *  ENTRY inside each wave (kept from M1 for call-site continuity — an unfortunate
 *  but pre-existing name collision with the new multi-wave `waves` option below);
 *  `waves`, when given, REPLACES the single generated wave with a caller-built
 *  multi-wave schedule (each item optionally overriding count/spacing/countdown/
 *  clearBonus/offset per wave; everything else in this bundle — catalog, balance,
 *  scoring — still applies uniformly). */
export interface TestWaveOpts {
  readonly waveCount?: number;
  readonly waveSpacing?: number;
  readonly countdownTicks?: number;
  readonly waveClearBonus?: number;
  readonly offsetTicks?: number;
}
export interface TestBundleOpts {
  readonly creepHp?: number;
  readonly creepSpeedFp?: number;
  readonly creepBounty?: number;
  readonly waveCount?: number;
  readonly waveSpacing?: number;
  readonly countdownTicks?: number;
  readonly startingBounty?: number;
  readonly startingLives?: number;
  readonly waveClearBonus?: number;
  /** Overrides the single-wave default with an explicit N-wave schedule. */
  readonly waves?: readonly TestWaveOpts[];
  /** `0` = off (M1 default); `⌊ticksRemaining / earlyCallBountyDivisor⌋` bounty at
   *  an early call. */
  readonly earlyCallBountyDivisor?: number;
  /** `0` = off (M1 default); `⌊ticksRemaining / earlyCallScoreDivisor⌋` score credit
   *  at an early call. */
  readonly earlyCallScoreDivisor?: number;
}

/** Build a raw ruleset bundle for a board geometry, with M1-ish defaults. */
export function testBundle(spec: GridSpec, opts: TestBundleOpts = {}): Ruleset {
  const waveOpts: readonly TestWaveOpts[] = opts.waves ?? [
    {
      waveCount: opts.waveCount,
      waveSpacing: opts.waveSpacing,
      countdownTicks: opts.countdownTicks,
      waveClearBonus: opts.waveClearBonus,
    },
  ];
  return {
    formatVersion: 2,
    rulesetId: 'test-ruleset',
    version: 1,
    creepCatalog: [
      {
        id: 'normal',
        hp: opts.creepHp ?? 20,
        speedFp: opts.creepSpeedFp ?? 26,
        armor: 0,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: opts.creepBounty ?? 1,
      },
    ],
    towerCatalog: [TEST_TOWER],
    balance: {
      startingLives: opts.startingLives ?? 10,
      startingBounty: opts.startingBounty ?? 80,
      refundNum: 3,
      refundDen: 4,
      slowFloorNum: 1,
      slowFloorDen: 4,
      earlyCallBountyDivisor: opts.earlyCallBountyDivisor ?? 0,
    },
    scoring: {
      survivalMul: 25,
      starThresholds: [1, 6, 9],
      earlyCallScoreDivisor: opts.earlyCallScoreDivisor ?? 0,
    },
    boards: [
      {
        id: 'test',
        widthTiles: spec.widthTiles,
        heightTiles: spec.heightTiles,
        entrance: spec.entrance,
        exit: spec.exit,
        waves: waveOpts.map((w, index) => ({
          index,
          countdownTicks: w.countdownTicks ?? 500,
          clearBonus: w.waveClearBonus ?? 0,
          entries: [
            {
              creepId: 'normal',
              count: w.waveCount ?? 10,
              spacingTicks: w.waveSpacing ?? 20,
              ...(w.offsetTicks !== undefined ? { offsetTicks: w.offsetTicks } : {}),
            },
          ],
        })),
      },
    ],
  };
}

/** Compile a test bundle for its single board — the `CompiledRuleset` `step` takes. */
export function testRuleset(spec: GridSpec, opts: TestBundleOpts = {}): CompiledRuleset {
  return compileRuleset(testBundle(spec, opts), 'test');
}

/** Insert a creep directly into a state's SoA (bypassing the wave), resting at a
 *  cell centre — the manual setup movement/tower/combat unit tests need now that
 *  there is no `spawnCreep` command. */
export function pushCreep(
  state: SimState,
  args: {
    readonly id: number;
    readonly hp: number;
    readonly col: number;
    readonly row: number;
    readonly bounty?: number;
    readonly speed?: number;
    readonly wave?: number;
  },
): void {
  state.creeps.id.push(args.id);
  state.creeps.hp.push(args.hp);
  state.creeps.bounty.push(args.bounty ?? 1);
  state.creeps.speed.push(args.speed ?? 26);
  state.creeps.fromX.push(cellCenterX(args.col));
  state.creeps.fromY.push(cellCenterY(args.row));
  state.creeps.headCol.push(args.col);
  state.creeps.headRow.push(args.row);
  state.creeps.progress.push(0);
  state.creeps.wave.push(args.wave ?? 0);
}
