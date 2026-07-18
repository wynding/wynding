// @wynding/types — shared domain types.
//
// Kept dependency-free and framework-agnostic so both the deterministic core
// and the presentation/app layers can share one vocabulary. Nominal (branded)
// primitives make it a type error to mix, say, a raw tile count with a
// fixed-point quantity.

/** Branded nominal type helper. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** A discrete simulation step index. Game time is `tick * MS_PER_TICK`. */
export type Tick = Brand<number, 'Tick'>;

/** Seed for the deterministic RNG (uint32). */
export type Seed = Brand<number, 'Seed'>;

/**
 * A fixed-point scalar (integer encoding of a fractional quantity). See
 * `@wynding/engine` for the FP_SHIFT / conversion helpers. Never a JS float.
 */
export type Fixed = Brand<number, 'Fixed'>;

/** Stable identifier for a simulation entity (creep, tower, ...). */
export type EntityId = Brand<number, 'EntityId'>;

/** A position in fixed-point board space. */
export interface Vec2 {
  readonly x: Fixed;
  readonly y: Fixed;
}

/** Integer board coordinate (tile grid cell). */
export interface Cell {
  readonly col: number;
  readonly row: number;
}

/** Kinds of tower the maze can be built from (generic, project-owned identifiers). */
export type TowerKind = 'basic' | 'rapid' | 'splash' | 'slow' | 'antiair';

/** Kinds of creep that traverse the maze. */
export type CreepKind = 'normal' | 'fast' | 'armored' | 'flying' | 'boss';

/** A hex string content-hash of serialized state (see world-hash in the engine). */
export type WorldHash = Brand<string, 'WorldHash'>;
