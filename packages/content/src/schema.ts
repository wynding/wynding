// schema.ts — content data shapes (types only). AGPL-3.0-or-later code.
//
// The type definitions live here so both the public barrel (index.ts) and the
// authored data (levels.ts, CC-BY-SA content) import them directly, without
// routing the data module through the public barrel.

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
