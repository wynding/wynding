// @wynding/content — level and wave data.
//
// The type definitions and loaders in this file are AGPL-3.0-or-later *code*.
// The authored data *values* live in ./levels.ts and are CC-BY-SA 4.0 content
// (see ../../../docs/adr/0002-asset-and-content-licensing.md). This file holds
// the shapes and re-exports the data; it holds no game logic.

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

// Authored content data (CC-BY-SA 4.0) — see ./levels.ts.
export { sampleLevel, levels } from './levels';
