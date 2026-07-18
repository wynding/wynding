// @wynding/content — level and wave data.
//
// Pure data: the shapes here describe a level's geometry, economy, and the
// ordered waves of creeps it sends. Content is consumed by the sim (to schedule
// spawns) and the app (to lay out the board); it holds no logic.

import type { CreepKind } from '@wynding/types';

/** One line item within a wave: N creeps of a kind, spaced by `spacingTicks`. */
export interface WaveEntry {
  readonly creep: CreepKind;
  readonly count: number;
  readonly hp: number;
  /** Ticks between successive spawns of this entry. */
  readonly spacingTicks: number;
}

/** An ordered burst of creeps the player must survive. */
export interface Wave {
  readonly index: number;
  readonly entries: readonly WaveEntry[];
  /** Ticks to wait before this wave begins after the previous one clears. */
  readonly leadInTicks: number;
}

/** A playable level: board geometry, starting economy, and its wave schedule. */
export interface Level {
  readonly id: string;
  readonly name: string;
  readonly widthTiles: number;
  readonly heightTiles: number;
  readonly startingLives: number;
  readonly startingBounty: number;
  readonly waves: readonly Wave[];
}

/** A first sample level — enough to exercise the pipeline end to end. */
export const sampleLevel: Level = {
  id: 'field-01',
  name: 'Open Field',
  widthTiles: 20,
  heightTiles: 14,
  startingLives: 20,
  startingBounty: 100,
  waves: [
    {
      index: 0,
      leadInTicks: 40,
      entries: [{ creep: 'normal', count: 10, hp: 10, spacingTicks: 8 }],
    },
    {
      index: 1,
      leadInTicks: 120,
      entries: [
        { creep: 'normal', count: 12, hp: 14, spacingTicks: 6 },
        { creep: 'fast', count: 4, hp: 8, spacingTicks: 10 },
      ],
    },
  ],
};

/** All bundled levels (campaign order). */
export const levels: readonly Level[] = [sampleLevel];
