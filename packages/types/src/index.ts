// @wynding/types — shared domain types.
//
// Kept dependency-free and framework-agnostic so both the deterministic core
// and the presentation/app layers can share one vocabulary. Its real job is the
// ADR 0007 ruleset schema below (the authored data shapes every package that
// touches a ruleset shares) plus the small set of domain types with actual
// production consumers, such as `Cell` (`board.ts`, `context.ts`,
// `pathfinding.ts`, `tower.ts`). It previously also carried a branded-primitive
// vocabulary (`Brand`/`Tick`/`Fixed`/`EntityId`/`Vec2`/`WorldHash`/`Seed`) meant
// to make unit mix-ups a type error; #113 removed it — fifteen stories in, it had
// zero real consumers (the sim's state is plain `number` throughout, and its one
// near-consumer, `Seed`, was erased at the door by a `Seed | number` union), so
// keeping it made a promise the codebase didn't keep.

/** Integer board coordinate (tile grid cell). */
export interface Cell {
  readonly col: number;
  readonly row: number;
}

// ── The ruleset bundle (ADR 0007) — v2 schema ─────────────────────────────────
//
// The single validated data bundle a match runs against — tower catalog, creep
// catalog, board geometry, wave schedules, and global balance constants — plus its
// `formatVersion`/`rulesetId`/`version`. These are the RAW authored shapes (pure
// data; `@wynding/sim`'s `ruleset-schema.ts` structurally validates them and
// `ruleset.ts` compiles + hashes them). The sim reads ALL sim-affecting tuning from
// here (ADR 0007), so nothing is a hardcoded engine constant. A tuning change bumps
// `rulesetHash` (a content digest); a shape change bumps `formatVersion`; a
// sim-behavior change bumps `simVersion` (the per-`simVersion` capability profile in
// `@wynding/sim` gates which of these shapes' kinds/cardinalities/values are legal —
// M1/M2-S1 pins the profile to exactly today's behavior, nothing more).
//
// Catalog and board ids are OPEN STRINGS (decision 4 — no closed `TowerKind`/
// `CreepKind` union): the capability profile gates capabilities, not spellings.
// Every identifier shares one format: `^[a-z][a-z0-9-]{0,31}$` (`CatalogId`,
// `RulesetBoard.id`, and by reference `WaveEntry.creepId`), enforced by
// `validateRulesetShape`, not by the type system.

/** A creep's traversal domain. Ground creeps obey the maze; air is later-milestone. */
export type CreepDomain = 'ground' | 'air';

/** A tower attack's target domain — `'both'` hits ground and air alike. */
export type TowerTargetDomain = 'ground' | 'air' | 'both';

/**
 * Stat block for one creep — the single authority for its numbers, covering all
 * five creep axes (speed, durability, domain, immunity, role). `id` is an open,
 * pattern-constrained catalog string (no closed union — decision 4).
 */
export interface CreepDef {
  /** Catalog id — `^[a-z][a-z0-9-]{0,31}$`, unique within `creepCatalog`. */
  readonly id: string;
  readonly hp: number; // int 1..1e6
  /** Travel budget per tick, fixed-point units (256 = 1 tile). Axis 1: speed. */
  readonly speedFp: number; // int 1..1e6
  /** Damage reduction stat, paired with `hp`. Axis 2: durability. */
  readonly armor: number; // int 0..1e6
  /** Axis 3: domain. */
  readonly domain: CreepDomain;
  /** Status immunities — 0..2, unique, canonical order (`slow` before `stun`).
   *  Axis 4: immunity. */
  readonly immunities: readonly ('slow' | 'stun')[];
  /** Omitted = no role. Axis 5: role. */
  readonly role?: 'boss';
  /** Lives lost per leak of THIS creep — replaces v1's global `balance.leakCost`.
   *  The M1/M2-S1 capability profile pinned a uniform value across the whole
   *  catalog through sv13 (`requiredLeakCost`); M2-S10 lifts that to a per-creep
   *  ceiling (`maxLeakCost`) and rewires `step` to resolve each leak's own cost —
   *  `CompiledCreep.leakCost`, not one flat `CompiledBalance` field. */
  readonly leakCost: number; // int 1..1000
  /** Bounty credited on kill (feeds score + spendable bounty). */
  readonly bounty: number; // int 0..1e6
}

/**
 * The discriminated effect-bundle union — the six sim effect primitives (direct,
 * slow, stun, dot, support, burst), with `direct`/`burst` each carrying a `single`/
 * `aoe` form — eight variants total. A tower's `effects` array authors these in
 * APPLICATION order (m2.md §Combat). Every kind beyond `direct`/`single` is
 * capability-gated OFF at M1/M2-S1 (`allowedEffectKinds`/`allowedDirectForms`).
 */
export type EffectDef =
  | { readonly kind: 'direct'; readonly form: 'single'; readonly damage: number } // int 1..1e6
  | {
      readonly kind: 'direct';
      readonly form: 'aoe';
      readonly damage: number; // int 1..1e6
      readonly radiusFp: number; // int 1..1e6
    }
  | {
      readonly kind: 'slow';
      readonly mulFp: number; // int 1..255 (×/256)
      readonly durationTicks: number; // int 1..1e6
    }
  | {
      readonly kind: 'stun';
      readonly chanceNum: number; // int 1..256 (/256)
      readonly durationTicks: number; // int 1..1e6
    }
  | {
      readonly kind: 'dot';
      readonly damagePerTick: number; // int 1..1e6
      readonly cadenceTicks: number; // int 1..1e6
      readonly durationTicks: number; // int ≥ cadenceTicks — a DoT must tick ≥ once
    }
  | {
      readonly kind: 'support';
      /** Must strengthen (> 1×) — a support effect that weakens is off-schema. */
      readonly damageMulFp: number; // int 257..1e6 (×/256)
    }
  | { readonly kind: 'burst'; readonly form: 'single'; readonly damage: number } // int 1..1e6 — one discharge, tower consumed
  | {
      readonly kind: 'burst';
      readonly form: 'aoe';
      readonly damage: number; // int 1..1e6
      readonly radiusFp: number; // int 1..1e6
    };

/**
 * Stat block for one tower. `attack` is present iff the bundle attacks — a
 * `support`-only bundle carries no `attack` (cross-field rule: `support` is
 * exclusive, exactly one effect, no `attack`; every other bundle requires
 * `attack`). `id` is an open, pattern-constrained catalog string (decision 4).
 */
export interface TowerDef {
  /** Catalog id — `^[a-z][a-z0-9-]{0,31}$`, unique within `towerCatalog`. */
  readonly id: string;
  readonly cost: number; // int 1..1e6
  readonly attack?: {
    /** Support-only bundles carry no `attack` at all (mask empty), so this is
     *  never itself the "no target" case. */
    readonly domain: TowerTargetDomain;
    /** For a burst bundle this is the TRIGGER range, not a per-shot range. */
    readonly rangeFp: number; // int 1..1e6
    /** REQUIRED unless the bundle has a `burst` effect (single-use, no cadence). */
    readonly cadenceTicks?: number; // int 1..1e6
    /** Projectile impact delay; `< cadenceTicks` when cadenced (≤1 impact in
     *  flight per tower, unchanged from v1). */
    readonly travelTicks: number; // int 1..1e6
  };
  /** Authored order = application order (m2.md §Combat). 1..8 entries. */
  readonly effects: readonly EffectDef[];
}

/** One line item within a wave: N creeps of a catalog `creepId`, spaced by
 *  `spacingTicks`. Carries NO inline stats — the creep catalog is the single stat
 *  authority. `offsetTicks` (stream offset) defaults to 0, canonicalized at parse. */
export interface WaveEntry {
  /** Must reference `creepCatalog`. */
  readonly creepId: string;
  readonly count: number; // int 1..1e6 (MAX_SCHEDULED_SPAWNS caps the aggregate)
  readonly spacingTicks: number; // int 1..1e6
  /** Omitted → 0 (stream offset), applied at parse. */
  readonly offsetTicks?: number; // int 0..1e6
}

/** An ordered wave the player must survive. Per-wave `countdownTicks`/`clearBonus`
 *  replace v1's global `balance.countdownTicks`/`balance.waveClearBonus`. */
export interface WaveSchedule {
  /** Must equal the wave's array position (contiguous from 0). */
  readonly index: number; // int ≥ 0
  /** Ticks from match start (or the prior wave's LAUNCH, for wave index > 0) to
   *  auto-launch; callable early from tick 0. */
  readonly countdownTicks: number; // int 1..1e6
  /** Paid once on a leak-free wave clear (0 at M1; mechanic present, valued off). */
  readonly clearBonus: number; // int 0..1e6
  /** Concurrent spawn streams (m2.md §Waves). 1..16. */
  readonly entries: readonly WaveEntry[];
}

/** A playable board: geometry + its wave schedule. Cell classes are DERIVED by the
 *  sim from the two openings; content carries only geometry, not a per-cell map.
 *  `name` is DELETED (decision 5 — v2 carries zero presentation fields; a
 *  catalog/board id IS the ADR 0004 "descriptor", display keys derive from it at
 *  the UI layer when a story actually renders them). */
export interface RulesetBoard {
  /** `^[a-z][a-z0-9-]{0,31}$`, unique within `boards`. */
  readonly id: string;
  readonly widthTiles: number; // int 1..1e6
  readonly heightTiles: number; // int 1..1e6
  readonly entrance: Cell; // in-bounds
  readonly exit: Cell; // in-bounds
  /** 1..64; `index` = position, contiguous from 0. */
  readonly waves: readonly WaveSchedule[];
}

/** Global balance constants (per-run economy). `leakCost`/`countdownTicks`/
 *  `waveClearBonus`/`earlyCallBonus` are REMOVED — leak cost moved to
 *  per-creep (`CreepDef.leakCost`), countdown/clear-bonus moved to per-wave
 *  (`WaveSchedule.countdownTicks`/`clearBonus`), and the flat early-call bonus is
 *  replaced by a divisor formula (below). All sim-affecting → hashed. */
export interface BalanceConstants {
  readonly startingLives: number; // int 1..1e6
  readonly startingBounty: number; // int 0..1e6
  /** Sell refund = ⌊refundNum/refundDen × cumulative spend⌋. */
  readonly refundNum: number; // int, 0 ≤ refundNum ≤ refundDen
  readonly refundDen: number; // int 1..1e6
  /** A slowed creep's floor speed = ⌈slowFloorNum/slowFloorDen × base speed⌉
   *  (M2: 1/4). */
  readonly slowFloorNum: number; // int, 0 ≤ slowFloorNum ≤ slowFloorDen
  readonly slowFloorDen: number; // int 1..1e6
  /** 0 = off; else bonus = ⌊ticksRemaining / earlyCallBountyDivisor⌋. The shipped bundle
   *  authors 50; the "pinned to 0 by the M1/M2-S1 capability profile" this used to claim
   *  lapsed when S2 implemented the divisor formula as its sim change. */
  readonly earlyCallBountyDivisor: number; // int 0..1e6
}

/** Scoring weights — the ladder measure (ADR 0006) + the casual star grade. */
export interface ScoringConfig {
  /** Weights the survival term of the WINNING score only — won = Σ kill-bounties +
   *  Σ early-call credit + max(0, lives) × survivalMul. A loss scores 0 outright since
   *  sv16 (#25), so this knob has no effect on a losing run's grade. */
  readonly survivalMul: number; // int 0..1e6
  /** Non-decreasing lives cutoffs for [1★, 2★, 3★]. Only a LOSS earns 0 stars: since
   *  sv16 (#25) a win floors at 1★, so the [0] cutoff is NOT READ by `deriveStars` at
   *  all — a win below it grades 1★ exactly as a win at it does. Authoring it lower or
   *  higher changes no grade; [1] and [2] are the live rungs. Kept in the shape because
   *  retiring a schema field is a content decision, not a grading one. */
  readonly starThresholds: readonly [number, number, number]; // positive ints ≤ 1e6, non-decreasing
  /** 0 = off; else credit = ⌊ticksRemaining / earlyCallScoreDivisor⌋. The shipped bundle
   *  authors 50; the "pinned to 0 by the M1/M2-S1 capability profile" this used to claim
   *  lapsed when S2 implemented the divisor formula. */
  readonly earlyCallScoreDivisor: number; // int 0..1e6
}

/** The full ruleset bundle (ADR 0007 §1/§4) — a match is pure over
 *  `(seed, ruleset, boardId, inputs)`. `formatVersion` is fixed at 2 for all of M2;
 *  stories S2–S10 grow only the capability profile and the content. */
export interface Ruleset {
  readonly formatVersion: 2;
  /** `^[a-z][a-z0-9-]{0,31}$`. */
  readonly rulesetId: string;
  readonly version: number; // int ≥ 0
  /** 1..64, ids unique. */
  readonly creepCatalog: readonly CreepDef[];
  /** 1..64, ids unique. */
  readonly towerCatalog: readonly TowerDef[];
  readonly balance: BalanceConstants;
  readonly scoring: ScoringConfig;
  /** 1..16, ids unique. */
  readonly boards: readonly RulesetBoard[];
}
