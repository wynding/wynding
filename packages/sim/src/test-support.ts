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
  kind: 'basic',
  cost: 5,
  damage: 10,
  rangeFp: 1024,
  cadenceTicks: 30,
  travelTicks: 4,
};

/** Overrides for a test bundle (all optional). */
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
  readonly earlyCallBonus?: number;
}

/** Build a raw ruleset bundle for a board geometry, with M1-ish defaults. */
export function testBundle(spec: GridSpec, opts: TestBundleOpts = {}): Ruleset {
  return {
    formatVersion: 1,
    rulesetId: 'test-ruleset',
    version: 1,
    creepCatalog: [
      {
        kind: 'normal',
        hp: opts.creepHp ?? 20,
        speedFp: opts.creepSpeedFp ?? 26,
        bounty: opts.creepBounty ?? 1,
        domain: 'ground',
      },
    ],
    towerCatalog: [TEST_TOWER],
    balance: {
      startingLives: opts.startingLives ?? 10,
      startingBounty: opts.startingBounty ?? 80,
      refundNum: 3,
      refundDen: 4,
      leakCost: 1,
      countdownTicks: opts.countdownTicks ?? 500,
      waveClearBonus: opts.waveClearBonus ?? 0,
      earlyCallBonus: opts.earlyCallBonus ?? 0,
    },
    scoring: { survivalMul: 25, starThresholds: [1, 6, 9] },
    boards: [
      {
        id: 'test',
        name: 'Test Board',
        widthTiles: spec.widthTiles,
        heightTiles: spec.heightTiles,
        entrance: spec.entrance,
        exit: spec.exit,
        waves: [
          {
            index: 0,
            entries: [
              { kind: 'normal', count: opts.waveCount ?? 10, spacingTicks: opts.waveSpacing ?? 20 },
            ],
          },
        ],
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
}
