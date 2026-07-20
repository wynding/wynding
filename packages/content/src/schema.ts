// schema.ts — content data shapes (types only).
//
// The type definitions live here so both the public barrel (index.ts) and the
// authored data (boards.ts) import them directly, without routing the data module
// through the public barrel.

import type { Cell, CreepKind } from '@wynding/types';

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

/** A playable board: its geometry, starting economy, and wave schedule. */
export interface Board {
  readonly id: string;
  /**
   * Display name. Placeholder scaffold text today; per ADR 0004 this becomes a
   * localization key/descriptor (resolved to text at the UI layer) once the i18n
   * catalog lands — never a baked user-facing literal in shipped content.
   */
  readonly name: string;
  readonly widthTiles: number;
  readonly heightTiles: number;
  /**
   * The single walkable-unbuildable opening where creeps enter, on the border
   * ring. Cell classes (buildable-open / walkable-unbuildable / blocked) are
   * *derived* by the sim from this geometry — content carries only the openings.
   */
  readonly entrance: Cell;
  /** The single walkable-unbuildable opening creeps exit through (border ring). */
  readonly exit: Cell;
  readonly startingLives: number;
  readonly startingBounty: number;
  readonly waves: readonly Wave[];
}
