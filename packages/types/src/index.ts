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

// ── The ruleset bundle (ADR 0007) ─────────────────────────────────────────────
//
// The single validated data bundle a match runs against — tower catalog, creep
// catalog, board geometry, wave schedules, and global balance constants — plus its
// `formatVersion`/`rulesetId`/`version`. These are the RAW authored shapes (pure
// data; the sim compiles + validates them). The sim reads ALL sim-affecting tuning
// from here (ADR 0007), so nothing is a hardcoded engine constant. A tuning change
// bumps `rulesetHash` (a content digest); a shape change bumps `simVersion`.

/** A creep's traversal domain. Ground creeps obey the maze; air is later-milestone. */
export type CreepDomain = 'ground' | 'air';

/** Stat block for one creep kind — the single authority for its numbers. */
export interface CreepDef {
  readonly kind: CreepKind;
  readonly hp: number;
  /** Travel budget per tick, fixed-point units (256 = 1 tile). */
  readonly speedFp: number;
  /** Bounty credited on kill (feeds score + spendable bounty). */
  readonly bounty: number;
  readonly domain: CreepDomain;
}

/** Stat block for one tower kind. */
export interface TowerDef {
  readonly kind: TowerKind;
  readonly cost: number;
  readonly damage: number;
  /** Range radius, fixed-point units (Euclidean from the 2×2 footprint centre). */
  readonly rangeFp: number;
  /** Ticks between successive shots. */
  readonly cadenceTicks: number;
  /** Projectile impact delay: impact scheduled at fire_tick + travelTicks. */
  readonly travelTicks: number;
}

/** One line item within a wave: N creeps of a catalog `kind`, spaced by `spacingTicks`.
 *  Carries NO inline stats — the creep catalog is the single stat authority. */
export interface WaveEntry {
  readonly kind: CreepKind;
  readonly count: number;
  readonly spacingTicks: number;
}

/** An ordered wave the player must survive. */
export interface WaveSchedule {
  readonly index: number;
  readonly entries: readonly WaveEntry[];
}

/** A playable board: geometry + its wave schedule. Cell classes are DERIVED by the
 *  sim from the two openings; content carries only geometry, not a per-cell map. */
export interface RulesetBoard {
  readonly id: string;
  /** Display name — presentation-only, resolved to a localization key at the UI
   *  layer (ADR 0004) and STRIPPED from the ruleset hash so renaming never
   *  invalidates a replay. */
  readonly name: string;
  readonly widthTiles: number;
  readonly heightTiles: number;
  readonly entrance: Cell;
  readonly exit: Cell;
  readonly waves: readonly WaveSchedule[];
}

/** Global balance constants (per-run economy + timing). All sim-affecting → hashed. */
export interface BalanceConstants {
  readonly startingLives: number;
  readonly startingBounty: number;
  /** Sell refund = ⌊refundNum/refundDen × cumulative spend⌋. */
  readonly refundNum: number;
  readonly refundDen: number;
  /** Lives lost per leak (a boss may exceed 1 in a later milestone). */
  readonly leakCost: number;
  /** Ticks from match start to auto-launch; callable early from tick 0. */
  readonly countdownTicks: number;
  /** Paid once on a leak-free wave clear (0 at M1; mechanic present, valued off). */
  readonly waveClearBonus: number;
  /** Paid on an early wave call (0 at M1). */
  readonly earlyCallBonus: number;
}

/** Scoring weights — the ladder measure (ADR 0006) + the casual star grade. */
export interface ScoringConfig {
  /** score = Σ kill-bounties + max(0, lives) × survivalMul. */
  readonly survivalMul: number;
  /** Ascending lives cutoffs for [1★, 2★, 3★]; a loss earns 0 stars. */
  readonly starThresholds: readonly [number, number, number];
}

/** The full ruleset bundle (ADR 0007 §1/§4) — a match is pure over
 *  `(seed, ruleset, boardId, inputs)`. */
export interface Ruleset {
  readonly formatVersion: number;
  readonly rulesetId: string;
  readonly version: number;
  readonly boards: readonly RulesetBoard[];
  readonly creepCatalog: readonly CreepDef[];
  readonly towerCatalog: readonly TowerDef[];
  readonly balance: BalanceConstants;
  readonly scoring: ScoringConfig;
}
