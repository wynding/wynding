// combat.ts — Story 4 combat + Story 3's (M2) status-effect framework: scheduled-
// impact fire, sticky "first" targeting, per-kill bounty, and per-impact direct/
// slow resolution. Pure, deterministic, integer-only.
//
// A tower ACQUIRES the in-range creep nearest the exit (min route-distance, ties to
// the lower id) and holds it while it stays present, alive, and in range. Each fire
// SNAPSHOTS its catalog effects (fresh plain objects — impacts serialize into the
// world-hash, so a shared reference across fires would let one impact's runtime
// state bleed into another's) and schedules an IMPACT at `tick + travelTicks`; the
// impact resolves later, in queue order, against the still-live target or — if it
// died or leaked in flight — is consumed as a WASTED shot. Everything reads the
// POST-MOVE world, and impacts resolve BEFORE firing so a kill can free a tower to
// re-acquire and fire the same tick.
//
// STATUS-EFFECT ORDER (M2-S3, the pinned combat order — G7/Codex R1-11): per
// impact, over its single affected creep, first pass applies EVERY `direct` effect
// in AUTHORED relative order, then a death check, then — only if the creep
// survived — a second pass applies every `slow` effect in authored relative order
// via the strongest-wins/refresh-at-equal stacking rule (a lethal hit applies no
// statuses). An EXPIRY SWEEP closes the combat phase after firing: every creep
// whose `slowUntilTick` has reached this tick resets to `(0, 0)` — durations end
// INCLUSIVELY (active through the tick it was applied for `D` more, gone from the
// very next tick's movement). This shape is built so stun (S6) and DoT (S5) slot
// in without reordering: direct-then-status-with-a-death-check-between is the
// GENERAL rule, not a slow-specific one.
//
// TOTALITY: every restored container is validated/canonicalized like the SoA state.
// A malformed impact is dropped; the queue is capped at `MAX_IN_FLIGHT_IMPACTS`; new
// counters are safe-integer-guarded with a deterministic no-op on overflow. The cap
// is a forged-state / DoS backstop, NOT a genuine-play limit: each valid tower holds
// ≤1 impact in flight (`travelTicks < cadenceTicks`, the schema's own rule) and
// placement enforces `MAX_TOWERS`, so in-flight ≈ live towers, with a bounded slack —
// a tower sold within the last `travelTicks` still has its impact resident until it
// resolves. On any budget-conforming board that slack stays far under the
// `MAX_TOWERS` (1000) cap vs the physical tower capacity, so the cap never bites
// genuine play; a caller that drives the queue to the cap by abusive sell/rebuild
// churn is exactly the forged/DoS case the backstop exists for, where a queue-full
// fire is a deterministic no-op that retries next tick (total and reproducible for
// every `step()` caller).

import { FP_ONE, type Rng } from '@wynding/engine';
import type { TowerTargetDomain } from '@wynding/types';
import { ORTHO_COST, DIAG_COST, type Grid } from './board';
import type { DistanceField } from './pathfinding';
import { distAt } from './field-access';
import {
  advanceCreep,
  cellCenterX,
  cellCenterY,
  deriveValidCreepPosition,
  cellOf,
  isqrt,
  type CreepGeometry,
} from './movement';
import { effectiveSpeedFp, MAX_DOT_DURATION_CADENCE_RATIO } from './ruleset-shared';
import { MAX_TOWERS, forEachValidTower, type TowerArrays } from './tower';
// The single domain resolver lives in the leaf `domain.ts`, not here — `tower.ts`
// needs it too and already exports into this file, so defining it here would be
// circular. Rationale and call sites are documented at its definition.
import { resolveCreepDomain } from './domain';
import { buildAuraIndex, auraMulFor, buffAmount } from './support';
import type { CompiledCreep, CompiledEffect, CompiledTower } from './ruleset';

// Combat tuning (range, per-hit damage, fire cadence, projectile travel) is NO
// LONGER a hardcoded constant here — Story 5 migrated it into the ruleset bundle
// (ADR 0007); M2-S3 migrates the whole EFFECT LIST (direct + slow) the same way.
// Tower stats arrive as the `towerById` param of `runCombat` — the sim-owned
// compiled catalog lookup (v2's raw `TowerDef` carries a discriminated `effects`
// array; `compileRuleset` resolves it into `CompiledEffect[]` per tower, in
// authored order); kill bounty is a per-creep SoA column credited from the killed
// creep's own value (correct for mixed-kind waves).

/** Forged-state / DoS backstop on the resident impact queue (never bites real play). */
export const MAX_IN_FLIGHT_IMPACTS = MAX_TOWERS;

/** Hard cap on effects per impact — mirrors the schema's own per-tower effects
 *  ceiling (8), since a snapshot carries the whole tower bundle. Deliberately a
 *  SEPARATE constant from the capability profiles' `maxEffectsPerBundle` (CodeRabbit
 *  #73): each profile is a verbatim per-simVersion record whose numbers must never
 *  move because another layer was edited, so the layers share an INVARIANT, not a
 *  binding — `capability.test.ts` pins the LIVE profile's ceiling under this cap
 *  (the only one: dead profiles are deleted at each bump, G11). */
export const MAX_IMPACT_EFFECTS = 8;

/** One effect primitive an impact applies, snapshotted fresh per fire from the
 *  tower's `CompiledEffect[]` (M2-S3 generalizes M1's `direct`-only shape).
 *  `dot` (M2-S5a P2 shaped the state; P3 wires it up) carries the same three
 *  fields the DoT record adopts on first application — `amount` per tick,
 *  `cadenceTicks` between ticks, `durationTicks` the record's total lifetime;
 *  `applyImpactToCreep`'s PASS 2 hands a `dot` primitive to `applyDot`. */
export type EffectPrimitive =
  | { readonly kind: 'direct'; readonly amount: number }
  | { readonly kind: 'slow'; readonly mulFp: number; readonly durationTicks: number }
  | {
      readonly kind: 'dot';
      readonly amount: number;
      readonly cadenceTicks: number;
      readonly durationTicks: number;
    }
  | { readonly kind: 'stun'; readonly chanceNum: number; readonly durationTicks: number };

/**
 * A scheduled impact, resolving at `impactTick` (M2-S4a: a discriminated union —
 * hash-breaking even for single-target play, hence the sv8 bump and golden re-pin):
 *   - `targeted` — bound to one creep (`targetId`); wasted if that creep is dead or
 *     gone by `impactTick` (the pre-S4a shape, renamed).
 *   - `blast` — point-locked at `(x,y)` (the fire-time predicted lead point, see
 *     `predictBlastPoint`), affecting every creep within `radiusFp` at resolution,
 *     whether or not the original target survived the flight.
 * Both carry the same `effects` shape — the impact's `kind` is what distinguishes
 * "one creep" from "every creep in a radius"; the per-creep effect application
 * (`applyImpactToCreep`) is identical either way.
 *
 * `sourceId` (M2-S5a P2) is the firing tower's entity id, snapshotted at fire time
 * on BOTH variants: a DoT record's refresh rule (P3) is keyed on source identity,
 * and the impact is the only carrier between fire time and impact time — by the
 * time an impact resolves, the firing tower may have sold or been replaced, so this
 * is the sole surviving record of who fired it. This DOES change the world-hash,
 * even for single-target play, hence the golden re-pin in this packet.
 *
 * `domain` (M2-S7 P3) is the firing tower's target-domain MASK, snapshotted at
 * fire time on both variants for the same reason `sourceId` is: by the time an
 * impact resolves, the firing tower may have been sold, so the fire-time snapshot
 * is the sole surviving record of which domain(s) it was allowed to hit. Enforced
 * again at impact — `blastMembers` filters its radius-membership scan by it, and a
 * `targeted` impact re-checks it before applying any effect — so a tower sold
 * between fire and impact still cannot land on a domain it never covered. This
 * changes the world-hash, exactly as `sourceId` did at M2-S5a.
 */
export type Impact =
  | {
      readonly kind: 'targeted';
      readonly impactTick: number;
      readonly targetId: number;
      readonly sourceId: number;
      readonly domain: TowerTargetDomain;
      readonly effects: EffectPrimitive[];
    }
  | {
      readonly kind: 'blast';
      readonly impactTick: number;
      readonly x: number;
      readonly y: number;
      readonly radiusFp: number;
      readonly sourceId: number;
      readonly domain: TowerTargetDomain;
      readonly effects: EffectPrimitive[];
    };

/**
 * A per-source, per-target damage-over-time record (M2-S5a P2 shaped this state; P3
 * is `applyDot` and the tick step below that append/refresh/tick/expire one). Lives
 * in a flat `SimState.dots` array mirroring `impacts` — a per-source DoT is a
 * creep↔tower RELATION, not a creep attribute (unlike slow, which collapses to one
 * column pair because strongest-wins means at most one live slow per creep; two
 * `venom` towers keep independently-ticking records on the same creep, per
 * `docs/CONTEXT.md`'s Status effect entry).
 */
export interface DotRecord {
  readonly targetId: number; // creep ENTITY id (matches Impact.targetId)
  readonly sourceId: number; // firing tower's entity id — source identity
  readonly amount: number; // per-tick damage, re-adopted on refresh
  readonly cadenceTicks: number; // fixed for the record's life
  readonly nextTickTick: number; // the tick this record next deals damage
  readonly untilTick: number; // INCLUSIVE final tick
}

/**
 * Forged-state / DoS backstop on the resident DoT-record table — the analogue of
 * {@link MAX_IN_FLIGHT_IMPACTS}, expressed the same structural way (a multiple of
 * {@link MAX_TOWERS}, not a bare literal): `applyDot` deterministically drops a NEW-PAIR
 * application once the table is full. Deliberately NOT a per-creep source cap, which would
 * contradict `docs/CONTEXT.md`'s Status effect entry ("each source's DoT coexists").
 *
 * DERIVED, not chosen. One source holds at most `RATIO + 1` records: `RATIO` prior
 * residents — bounded by the compile-time duration:cadence gate in `checkCapabilityGlobal`,
 * which is what makes this rail derived rather than judged — plus the landing being applied,
 * which still sees the oldest record because impacts resolve in step (1) while expiry runs
 * in step (6), and that is exactly when `applyDot` tests capacity. A re-hit refreshes rather
 * than appends, so it can never add a target. Across sources the count `S` is
 * `min(MAX_TOWERS, MAX_TOTAL_TOWER_COMMANDS)` = 1,000 (see the HAZARD below — sources are
 * minted tower ids, not live towers, since a sold tower's records keep ticking). So the
 * worst legitimate table at a capacity test is `(RATIO+1)*S - 1 = 8,999`, just under the
 * rail: compiled content driven by an accepted replay can REACH it, never EXCEED it.
 *
 * Do not widen the duration:cadence gate — nor the aoe-plus-dot rejection beside it, whose
 * blast fan-out breaks the per-source bound — without re-deriving this;
 * `capability.test.ts` pins gate and rail together. The dangerous direction is DOWN: set
 * too low, real DoT applications silently become no-ops (`controller.ts`'s `dotDropped`
 * counter is the tripwire). Too high costs only DoS resistance, since real play never
 * nears the rail.
 *
 * HAZARD (issue #77): only the duration:cadence half is compiler-visible. `packages/sim`
 * does not bound tower-id minting — its placement gate is a live-count check, and
 * build/sell/build mints fresh ids indefinitely — so the SOURCE COUNT rests on
 * `packages/replay`'s `MAX_TOTAL_TOWER_COMMANDS` (1,000). That equals `MAX_TOWERS` by
 * COINCIDENCE, not by binding: it is motivated there as a pathfinding-CPU budget and says
 * nothing about DoT. Raise it to allow longer matches — a change touching nothing in this
 * package — and a replay could mint that many sources and silently drop applications, with
 * no test failing. It cannot be imported here without the layering back-edge AGENTS.md
 * blocks, the same caveat issue #77 records.
 *
 * Cost evidence, and the limits of that evidence: `packages/perf/src/dot-bench.ts`.
 *
 * Reaching the rail is a hostile state, not a play cost — it needs ~1,000 DoT sources in
 * sustained contact, against ~150 towers on the whole stress scene, and real tables sit in
 * the hundreds. The per-source bound is analytic, not measured on a DoT-bearing scene: none
 * exists yet (`stress-40x40.json` carries `direct` and `slow` only, and `dot-bench.ts` seeds
 * SYNTHETIC filler to reach the cap). S5b adds the DoT-bearing stress twin; until then, do
 * not cite a measured concurrency figure here.
 *
 * Capability-shaped like `AOE_SCAN_CEILING`: once sv9 ships, moving this is a behaviour
 * change owing its own `simVersion` bump. If S5b's stress scene lands anywhere near it, that
 * is a finding to raise, not a constant to nudge.
 */
export const MAX_DOT_RECORDS = (MAX_DOT_DURATION_CADENCE_RATIO + 1) * MAX_TOWERS;

/**
 * Optional per-step event collector (#31): NOT part of `SimState` (never serialized,
 * never hash-relevant) and NOT a `RenderVM` field — a transient out-param the caller
 * owns. The contract: presentational, never hash-relevant, never serialized —
 * append-only ARRAYS plus two MUTABLE COUNTERS (M2-S5a P3 adds `dotTicks`/
 * `dotDropped`, below — the first fields on this interface that are not append-only,
 * so this doc comment's older "only ever APPEND" wording no longer holds and is
 * revised here rather than left standing beside a contradiction). The caller owns
 * clearing and lifetime for both shapes. A terminal or no-op early-return `step()`
 * path touches neither arrays nor counters, so a pre-populated collector passed
 * through either early return is left unchanged.
 */
export interface StepEvents {
  /** Resolution points of impacts that RESOLVED this tick, in queue-resolution
   *  order. `radiusFp` (M2-S4a) is `0` for a `targeted` impact (a spark, captured
   *  BEFORE damage applies, ONLY when it hit a still-live target — a wasted
   *  targeted shot appends nothing) or the blast's true radius for a `blast`
   *  impact (emitted UNCONDITIONALLY, before membership scanning — every resolved
   *  blast lands visibly even if it catches nobody, or its original target died in
   *  flight; Codex R1-12). Phase 3 (out of this story's sim-only scope) threads
   *  `radiusFp` through `RenderOverlay.sparks`; the sim emits the shape now so a
   *  later builder never has to touch this type again. */
  readonly impactPoints: { x: number; y: number; radiusFp: number }[];
  /** Shots FIRED this tick (#32), in fire order — fp-unit origin (firing tower centre)
   *  + the target locked AT FIRE TIME (never re-derived from `state.impacts`: a tower
   *  that retargets before the shot resolves would otherwise break the association —
   *  this carries the ORIGINAL target's identity/timing over the tick regardless of
   *  later retargeting). Purely presentational: append-only, never hash-relevant,
   *  never serialized — same contract as `impactPoints` (combat.ts, #31 precedent).
   *  A discriminated union (M2-S4a step 12, mirroring `Impact`): a `targeted` shot's
   *  tracer chases its target's CURRENT position (`targetId`, resolved by the render
   *  layer's per-frame interpolation); a `blast` shot is already point-locked at fire
   *  time (`destX`/`destY`, the same `predictBlastPoint` lead point the impact itself
   *  will land at) — left undiscriminated, every blast tracer would visibly fly toward
   *  wherever its fire-time target ends up, not where the blast actually lands. */
  readonly fired: (
    | {
        readonly kind: 'targeted';
        readonly originX: number;
        readonly originY: number;
        readonly targetId: number;
        readonly launchTick: number;
        readonly impactTick: number;
      }
    | {
        readonly kind: 'blast';
        readonly originX: number;
        readonly originY: number;
        readonly targetId: number;
        readonly destX: number;
        readonly destY: number;
        readonly launchTick: number;
        readonly impactTick: number;
      }
  )[];
  /** Count of DoT ticks actually applied this step (M2-S5a P3) — a SCALAR, not an
   *  array, so the timed region allocates nothing extra for it. Incremented only
   *  when the collector supplies it (`if (events?.dotTicks !== undefined)
   *  events.dotTicks++;`, the same optional-collector idiom `impactPoints`/`fired`
   *  use for their own guard), so every pre-existing `{ impactPoints: [], fired: [] }`
   *  construction site elsewhere in the codebase compiles unchanged. */
  dotTicks?: number;
  /** Count of DoT-record applications DROPPED this step for want of table capacity
   *  (`applyDot`'s drop branch, {@link MAX_DOT_RECORDS}) — a SCALAR, same optional-
   *  collector idiom and rationale as {@link StepEvents.dotTicks} above. */
  dotDropped?: number;
}

/** Structural creep SoA combat reads/mutates (CreepArrays is assignable to it).
 *  `wave` (M2-S2) — the owning wave index — carries through every rebuild here like
 *  any other column: dropping it on a combat-phase compaction would erase wave
 *  identity the instant a wave overlaps with combat, falsely settling waves.
 *  `creepId`/`slowMulFp`/`slowUntilTick` (M2-S3) are appended AFTER `wave` (hash-
 *  load-bearing position, mirrored in `index.ts`'s `CreepArrays`/
 *  `ReadonlyCreepArrays`): `creepId` is the catalog id (named for the open-catalog-
 *  id language, matching `ScheduledSpawn.creepId`); `slowMulFp`/`slowUntilTick` are
 *  the per-creep slow status pair — `slowMulFp === 0` means no active slow (the
 *  full model, G6: strongest-wins non-stacking means at most one live slow per
 *  creep, so a column pair is exactly right, not a shortcut). `stunUntilTick` (M2-S6)
 *  is appended immediately AFTER `slowUntilTick` (same hash-load-bearing position
 *  rule) — `0` means not stunned. There is no paired magnitude column: stun is
 *  binary, so the `slowMulFp === 0 ⟺ slowUntilTick === 0` biconditional has no
 *  analogue here. */
export interface CombatCreeps {
  id: number[];
  hp: number[];
  bounty: number[]; // kill bounty resolved from the creep's catalog kind at spawn
  speed: number[]; // travel budget/tick (fixed-point), resolved from kind at spawn
  fromX: number[];
  fromY: number[];
  headCol: number[];
  headRow: number[];
  progress: number[];
  wave: number[];
  creepId: string[]; // catalog id, resolved at spawn
  slowMulFp: number[]; // 0 = no active slow
  slowUntilTick: number[]; // 0 = no active slow (paired with slowMulFp)
  stunUntilTick: number[]; // 0 = not stunned (M2-S6, no paired magnitude column)
}

/** The empty 14-column creep SoA — the single factory, reused by the sim barrel. */
export const emptyCreeps = (): CombatCreeps => ({
  id: [],
  hp: [],
  bounty: [],
  speed: [],
  fromX: [],
  fromY: [],
  headCol: [],
  headRow: [],
  progress: [],
  wave: [],
  creepId: [],
  slowMulFp: [],
  slowUntilTick: [],
  stunUntilTick: [],
});

/** True iff `e` is a valid `EffectPrimitive`: `direct` — a positive safe-integer
 *  `amount`; `slow` — `mulFp` 1..255 and `durationTicks` a positive safe integer
 *  ≤ 1,000,000 (the schema's `GENERIC_MAX`); `dot` — `amount` and `cadenceTicks`
 *  positive safe integers, `durationTicks` a positive safe integer ≤ 1,000,000 (the
 *  same `GENERIC_MAX` bound `slow` already uses) AND `≥ cadenceTicks`, mirroring the
 *  schema's own pair rule. That pair rule is the load-bearing one: without it a forged
 *  impact mints a record whose first tick is already past its expiry. `stun` (M2-S6)
 *  — `chanceNum` a positive safe integer ≤ 256 and `durationTicks` a positive safe
 *  integer ≤ 1,000,000 (the same `slow`-arm ceiling). Any other shape is invalid. */
function validEffectPrimitive(e: unknown): e is EffectPrimitive {
  if (e === null || typeof e !== 'object') return false;
  const rec = e as {
    kind?: unknown;
    amount?: unknown;
    mulFp?: unknown;
    chanceNum?: unknown;
    cadenceTicks?: unknown;
    durationTicks?: unknown;
  };
  if (rec.kind === 'direct') {
    return Number.isSafeInteger(rec.amount) && (rec.amount as number) > 0;
  }
  if (rec.kind === 'slow') {
    return (
      Number.isSafeInteger(rec.mulFp) &&
      (rec.mulFp as number) >= 1 &&
      (rec.mulFp as number) <= 255 &&
      Number.isSafeInteger(rec.durationTicks) &&
      (rec.durationTicks as number) > 0 &&
      (rec.durationTicks as number) <= 1_000_000
    );
  }
  if (rec.kind === 'dot') {
    // The pair rule `durationTicks >= cadenceTicks` mirrors the schema's own
    // (`ruleset-schema.ts`), and bounds `cadenceTicks` transitively via `durationTicks`'
    // own ceiling — so no separate cadence ceiling is needed here (QC round 2 proved a
    // standalone one was dead code). The pair rule itself is load-bearing (QC round 1):
    // `applyDot` derives `nextTickTick = satAdd(tick, cadenceTicks)` and
    // `untilTick = satAdd(tick, durationTicks)`, so without them a forged impact with a
    // huge `cadenceTicks` minted a record with `untilTick < nextTickTick` — exactly the
    // shape `validDotRecord` calls structurally forged. That record was world-hashed on
    // the tick it landed and silently dropped by `canonicalDotRecords` on the next,
    // leaving `SimState.dots` not closed under its own canonical form. Deterministic
    // either way, but it made "structurally forged ⇒ dropped" depend on which door the
    // record came through.
    return (
      Number.isSafeInteger(rec.amount) &&
      (rec.amount as number) > 0 &&
      Number.isSafeInteger(rec.cadenceTicks) &&
      (rec.cadenceTicks as number) > 0 &&
      Number.isSafeInteger(rec.durationTicks) &&
      (rec.durationTicks as number) > 0 &&
      (rec.durationTicks as number) <= 1_000_000 &&
      (rec.durationTicks as number) >= (rec.cadenceTicks as number)
    );
  }
  if (rec.kind === 'stun') {
    return (
      Number.isSafeInteger(rec.chanceNum) &&
      (rec.chanceNum as number) > 0 &&
      (rec.chanceNum as number) <= 256 &&
      Number.isSafeInteger(rec.durationTicks) &&
      (rec.durationTicks as number) > 0 &&
      (rec.durationTicks as number) <= 1_000_000
    );
  }
  return false;
}

/** Rebuild one validated effect primitive to its exact canonical shape (never a
 *  spread — an unknown extra property on a forged effect must not leak into the
 *  world-hash), per variant. */
function canonicalEffectPrimitive(e: EffectPrimitive): EffectPrimitive {
  if (e.kind === 'direct') return { kind: 'direct', amount: e.amount };
  if (e.kind === 'slow') return { kind: 'slow', mulFp: e.mulFp, durationTicks: e.durationTicks };
  // EXHAUSTIVE on purpose — `dot` is matched, never a fallthrough (CodeRabbit, PR #78).
  // A trailing `return {kind:'dot', ...}` would rebuild any future fourth variant AS a
  // dot, reading `amount`/`cadenceTicks`/`durationTicks` off an object that has none of
  // them, and that result goes straight into the world-hash. That is precisely the defect
  // `snapshotEffects` carried in the other direction (collapsing everything non-`slow`
  // into `direct`), documented at its own definition. The `never` check below makes
  // adding a variant a COMPILE error here instead.
  if (e.kind === 'dot') {
    return {
      kind: 'dot',
      amount: e.amount,
      cadenceTicks: e.cadenceTicks,
      durationTicks: e.durationTicks,
    };
  }
  if (e.kind === 'stun') {
    return { kind: 'stun', chanceNum: e.chanceNum, durationTicks: e.durationTicks };
  }
  const unreachable: never = e;
  return unreachable;
}

/** Structural cap on a blast's radius — DELIBERATELY a SEPARATE constant from the
 *  capability profile's `maxAoeRadiusFp` (mirrors `MAX_IMPACT_EFFECTS`'s
 *  relationship to `maxEffectsPerBundle`, above): this is combat's own runtime
 *  totality bound on a resolved impact, independent of any one `simVersion`'s
 *  authoring ceiling. The layers share an INVARIANT, not a binding —
 *  `capability.test.ts` pins the LIVE profile's `maxAoeRadiusFp` under this cap, so
 *  one layer can never silently drift wider than the other. */
export const MAX_BLAST_RADIUS_FP = 2048;

/**
 * True iff `imp` is a valid impact shape: safe-integer `impactTick`, an `effects`
 * array of length 1..{@link MAX_IMPACT_EFFECTS} (mirrors the schema's own per-tower
 * effects cap, since a snapshot carries the whole bundle) holding only valid
 * {@link EffectPrimitive} entries, and — per `kind` — a safe-integer `targetId`
 * (`targeted`) or a bounds-checked `(x, y, radiusFp)` (`blast`): `x`/`y` must fall
 * ON-BOARD (`[0, grid.width·FP_ONE)` / `[0, grid.height·FP_ONE)` — an out-of-board
 * blast is structurally forged, never real fire-time output; this ON-BOARD bound
 * alone is necessary AND sufficient — the schema caps each axis at `GENERIC_MAX`
 * (1e6 tiles: `ruleset-schema.ts`'s `widthTiles`/`heightTiles`), not board area
 * (`CELL_CAP` is `buildGrid`'s own cap, not the schema's), so a legal board can run
 * up to a million tiles along one axis, and `inRange`'s own overflow-proof early-out
 * (`Math.abs(dx) > range`) already keeps the membership arithmetic bounded to
 * `|dx| ≤ MAX_BLAST_RADIUS_FP` regardless
 * of how far `x`/`y` sit from a creep — so no separate coordinate ceiling is needed)
 * AND `radiusFp` under {@link MAX_BLAST_RADIUS_FP}. **`sourceId`** (M2-S5a P2) is
 * REQUIRED on both variants — a safe positive integer, rejected otherwise: adding a
 * field to the union does nothing on its own, and a malformed `sourceId` would
 * otherwise flow into the world-hash and then (P3) into DoT state. **`domain`**
 * (M2-S7 P3) is likewise REQUIRED on both variants — one of `'ground'`/`'air'`/
 * `'both'`, rejected otherwise (a missing or invalid mask is dropped, never
 * defaulted): the mask is enforced again at impact time (`blastMembers`, and the
 * targeted re-check in `runCombat`), so a malformed value here would silently
 * widen or narrow what a sold tower's in-flight shot can still hit. Any other
 * shape, or an unrecognized `kind`, is dropped.
 */
function validImpact(imp: unknown, grid: Grid): imp is Impact {
  if (imp === null || typeof imp !== 'object') return false;
  const rec = imp as {
    kind?: unknown;
    impactTick?: unknown;
    effects?: unknown;
    sourceId?: unknown;
    domain?: unknown;
  };
  if (!Number.isSafeInteger(rec.impactTick)) return false;
  if (!Number.isSafeInteger(rec.sourceId) || (rec.sourceId as number) <= 0) return false;
  if (rec.domain !== 'ground' && rec.domain !== 'air' && rec.domain !== 'both') return false;
  if (
    !Array.isArray(rec.effects) ||
    rec.effects.length < 1 ||
    rec.effects.length > MAX_IMPACT_EFFECTS ||
    !rec.effects.every(validEffectPrimitive)
  ) {
    return false;
  }
  if (rec.kind === 'targeted') {
    const targetId = (imp as { targetId?: unknown }).targetId;
    return Number.isSafeInteger(targetId);
  }
  if (rec.kind === 'blast') {
    const { x, y, radiusFp } = imp as { x?: unknown; y?: unknown; radiusFp?: unknown };
    const maxX = grid.width * FP_ONE - 1;
    const maxY = grid.height * FP_ONE - 1;
    return (
      Number.isSafeInteger(x) &&
      (x as number) >= 0 &&
      (x as number) <= maxX &&
      Number.isSafeInteger(y) &&
      (y as number) >= 0 &&
      (y as number) <= maxY &&
      Number.isSafeInteger(radiusFp) &&
      (radiusFp as number) >= 1 &&
      (radiusFp as number) <= MAX_BLAST_RADIUS_FP
    );
  }
  return false;
}

/**
 * Canonicalize the restored impact queue: keep only valid entries (on-board for a
 * `blast`, per `validImpact`'s `grid` bound), each rebuilt PER-VARIANT to its exact
 * canonical shape (never a spread — an unknown extra property on a forged impact
 * must not leak into the world-hash; `canonicalEffectPrimitive` precedent above,
 * `sourceId` rebuilt explicitly like every other field), in array order, capped at
 * {@link MAX_IN_FLIGHT_IMPACTS}. Excess or malformed entries drop in array order —
 * a mixed queue of well-formed and forged/malformed `targeted`/`blast` entries
 * resolves only its valid members.
 *
 * The walk itself is ALSO capped at `4 ×` {@link MAX_IN_FLIGHT_IMPACTS} RAW entries
 * inspected (M2-S5a P2 — a pre-existing latent defect, closed here alongside
 * `canonicalDotRecords`'s twin below): breaking only on `out.length >=
 * MAX_IN_FLIGHT_IMPACTS` bounds the walk only when entries are VALID — a forged
 * array of any length whose entries are all invalid would otherwise still be
 * walked in full.
 */
function canonicalImpacts(impacts: readonly unknown[], grid: Grid): Impact[] {
  const out: Impact[] = [];
  const maxRawScan = 4 * MAX_IN_FLIGHT_IMPACTS;
  let scanned = 0;
  for (const imp of impacts) {
    if (out.length >= MAX_IN_FLIGHT_IMPACTS) break;
    if (scanned >= maxRawScan) break;
    scanned++;
    if (!validImpact(imp, grid)) continue;
    out.push(
      imp.kind === 'targeted'
        ? {
            kind: 'targeted',
            impactTick: imp.impactTick,
            targetId: imp.targetId,
            sourceId: imp.sourceId,
            domain: imp.domain,
            effects: imp.effects.map(canonicalEffectPrimitive),
          }
        : {
            kind: 'blast',
            impactTick: imp.impactTick,
            x: imp.x,
            y: imp.y,
            radiusFp: imp.radiusFp,
            sourceId: imp.sourceId,
            domain: imp.domain,
            effects: imp.effects.map(canonicalEffectPrimitive),
          },
    );
  }
  return out;
}

/**
 * True iff `rec` is a valid `DotRecord`: `targetId`/`sourceId` positive safe
 * integers (entity ids; `0` is not one, mirroring `Impact.sourceId` above),
 * `amount ≥ 1`, `1 ≤ cadenceTicks ≤ 1,000,000`, `nextTickTick`/`untilTick`
 * non-negative safe integers. Any other shape is invalid.
 *
 * There is deliberately NO `untilTick ≥ nextTickTick` rule (QC round 2). The first
 * draft had one, calling the opposite shape "structurally forged" — but the SIM ITSELF
 * produces it on the ordinary gameplay path: the tick step advances `nextTickTick` by
 * one cadence without regard to `untilTick`, so any record whose remaining duration is
 * not a whole number of cadences ends its life with its next tick scheduled past its
 * expiry. That is a perfectly well-formed record meaning "no further ticks are due, but
 * the effect has not expired yet". With the rule in place, `canonicalDotRecords` deleted
 * such records on the very next tick — several ticks early — so the poisoned telegraph
 * blinked off before the DoT actually ended, and `SimState.dots` was not closed under
 * its own canonical form on the shipped `venom`'s normal path.
 *
 * The `cadenceTicks` ceiling moved HERE from `validEffectPrimitive`, where it was dead
 * code (that conjunction already implied it via `durationTicks`). Here it is the only
 * thing bounding the operand `satAdd(nextTickTick, cadenceTicks)` reads on a restored
 * table, so it is load-bearing rather than decorative.
 */
/** The largest `cadenceTicks` a restored `DotRecord` may carry. Exported (CodeRabbit,
 *  PR #78) so `packages/perf`'s DoT benchmark BINDS to the real bound instead of
 *  restating the literal in its own package — a restated copy would drift silently, and
 *  a filler that violates this is dropped by `canonicalDotRecords` mid-`step()`, which
 *  is exactly how the benchmark came to be timing an empty table. */
export const MAX_DOT_CADENCE_TICKS = 1_000_000;

function validDotRecord(rec: unknown): rec is DotRecord {
  if (rec === null || typeof rec !== 'object') return false;
  const r = rec as {
    targetId?: unknown;
    sourceId?: unknown;
    amount?: unknown;
    cadenceTicks?: unknown;
    nextTickTick?: unknown;
    untilTick?: unknown;
  };
  return (
    Number.isSafeInteger(r.targetId) &&
    (r.targetId as number) > 0 &&
    Number.isSafeInteger(r.sourceId) &&
    (r.sourceId as number) > 0 &&
    Number.isSafeInteger(r.amount) &&
    (r.amount as number) >= 1 &&
    Number.isSafeInteger(r.cadenceTicks) &&
    (r.cadenceTicks as number) >= 1 &&
    (r.cadenceTicks as number) <= MAX_DOT_CADENCE_TICKS &&
    Number.isSafeInteger(r.nextTickTick) &&
    (r.nextTickTick as number) >= 0 &&
    Number.isSafeInteger(r.untilTick) &&
    (r.untilTick as number) >= 0
  );
}

/**
 * Canonicalize the restored DoT-record table: keep only valid entries (per
 * `validDotRecord`), each rebuilt to its exact canonical shape (never a spread —
 * mirrors `canonicalImpacts`), in array order, DEDUPLICATED on `(targetId,
 * sourceId)` keeping the FIRST occurrence — two individually-valid duplicates would
 * both tick for one source and make P3's refresh rule depend on which one it
 * happened to find, so the pair is a canonical-form invariant enforced here, not in
 * `applyDot`. Capped at {@link MAX_DOT_RECORDS} valid records kept, and at `4 ×`
 * {@link MAX_DOT_RECORDS} RAW entries inspected (same rationale as
 * `canonicalImpacts`'s raw-scan bound above — a long all-invalid array must not be
 * walked in full).
 */
function canonicalDotRecords(records: readonly unknown[]): DotRecord[] {
  const out: DotRecord[] = [];
  const seen = new Set<string>();
  const maxRawScan = 4 * MAX_DOT_RECORDS;
  let scanned = 0;
  for (const rec of records) {
    if (out.length >= MAX_DOT_RECORDS) break;
    if (scanned >= maxRawScan) break;
    scanned++;
    if (!validDotRecord(rec)) continue;
    const key = `${rec.targetId}:${rec.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      targetId: rec.targetId,
      sourceId: rec.sourceId,
      amount: rec.amount,
      cadenceTicks: rec.cadenceTicks,
      nextTickTick: rec.nextTickTick,
      untilTick: rec.untilTick,
    });
  }
  return out;
}

/** A live creep for targeting: positive-hp, position-valid, reachable. `index` is
 *  its row in `survivors` (M2-S4a) — a blast fire needs the target's raw movement
 *  columns (`predictBlastPoint`), not just its derived point. */
interface LiveCreep {
  readonly id: number;
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly dist: number;
  /** Resolved once, at precompute time, via {@link resolveCreepDomain} (M2-S7 P3) —
   *  the tower loop filters acquisition (both the sticky-hold check and the fresh
   *  acquire candidate) by comparing this against each tower's own mask. */
  readonly domain: 'ground' | 'air';
}

/**
 * Fixed-point scale for the "first"-target metric. Field cost units (`ORTHO_COST`/
 * `DIAG_COST`) are multiplied by `DIST_SCALE` so the still-untraveled fraction of the
 * current edge — always less than one whole step — refines the ordering *below* a cell
 * without floats. A safe integer throughout: `maxDist·DIST_SCALE` and the intermediate
 * `DIAG_COST·DIST_SCALE·edgeLen` both stay far under `2⁵³` for any real board.
 */
const DIST_SCALE = 1 << 16;

/**
 * The creep's **weighted remaining route-distance to the exit** (PRD 0001, "Targeting
 * is sticky"), scaled by {@link DIST_SCALE}: the flow-field distance from its next
 * waypoint (`head`) PLUS the cost-weighted fraction of the current edge it has yet to
 * travel (`edgeCost · remaining / edgeLen`). This is what makes "first" the creep most
 * about to leak — two creeps sharing a cell at different `progress` order by who is
 * physically nearer the exit, and the lower-id tie-break applies only to genuinely
 * equal remaining distance (not to a whole-cell quantum). Mirrors the field's own edge
 * costing: `distAt(fromCell) = distAt(head) + edgeCost` on a descending edge, so a
 * creep resting at a cell centre and one just starting that cell's edge agree.
 *
 * On a transitional (re-path) segment `edgeLen` can be well below one cell, and the
 * untraveled fraction is still charged the whole `edgeCost` — an approximation bounded
 * by one edge cost (≤ `DIAG_COST`), strictly finer than the old whole-cell quantum,
 * deterministic, and transient (it converges the instant the creep reaches its head).
 *
 * Returns `null` only when the next waypoint AND the from-cell are both unreachable — a
 * genuinely stranded row that can never be a valid "first" target. An unreachable head
 * alone falls back to the from-cell (M2-S6: a stunned creep cannot re-path, so a tower
 * built on its head cell must not make it unshootable — see the body). Same total,
 * never-throw contract as the rest of combat.
 *
 * `domain` (M2-S7 P3) branches the whole metric. GROUND is every rule above,
 * unchanged. AIR is the straight-line remaining distance to the EXIT CENTRE from
 * the creep's own derived point, `isqrt(dx² + dy²)`, converted into the same
 * shared unit as the ground metric by the pinned formula `⌊airDistanceFp ×
 * ORTHO_COST × DIST_SCALE / FP_ONE⌋` — air never consults the distance field, so
 * it has no stranded/`null` case.
 *
 * SAFE-INTEGER BOUND (P1-gated: every admissible board is ≤ 1024 cells/side, so
 * `dx_fp, dy_fp ≤ 2¹⁸`): `dx² + dy² ≤ 2³⁷` (the `isqrt` operand); `airDistanceFp
 * ≤ 2¹⁸·√2 < 370,728`; the pre-division product `airDistanceFp × ORTHO_COST ×
 * DIST_SCALE < 2.5e11`. Every intermediate is under 2⁵³ by more than four orders
 * of magnitude.
 */
function remainingRouteDist(
  field: DistanceField,
  domain: 'ground' | 'air',
  geom: CreepGeometry,
  fromX: number,
  fromY: number,
  headCol: number,
  headRow: number,
  progress: number,
): number | null {
  if (domain === 'air') {
    const exitX = cellCenterX(field.exit.col);
    const exitY = cellCenterY(field.exit.row);
    const dx = geom.point.x - exitX;
    const dy = geom.point.y - exitY;
    const airDistanceFp = isqrt(dx * dx + dy * dy);
    // The `Math.floor` is m2.md's pinned formula written verbatim, and at TODAY'S
    // constants it is a NO-OP: `DIST_SCALE / FP_ONE = 65536 / 256 = 256`, so the whole
    // expression is exactly `airDistanceFp * 2560`. Kept rather than simplified away, so
    // the code and the spec read identically — but do not mistake it for a live rounding
    // rule. The only truncation in this metric is `isqrt`'s own, above. If a later story
    // moves `ORTHO_COST` or `DIST_SCALE` to a pair that is not a whole multiple of
    // `FP_ONE`, this floor starts discarding a fraction and air-vs-ground ordering shifts
    // at ties — re-derive the metric then, do not assume the floor was always absorbing it.
    return Math.floor((airDistanceFp * ORTHO_COST * DIST_SCALE) / FP_ONE);
  }
  const headDist = distAt(field, headCol, headRow);
  if (headDist < 0) {
    // The next waypoint is unreachable — normally impossible, because movement re-paths
    // before combat runs, so a moving creep's head is always valid by the time we get
    // here. A STUNNED creep (M2-S6) is the exception: it does not move, so it cannot
    // re-path, and a tower built on the cell it was heading into leaves that head blocked
    // for the whole stun. Returning `null` here would drop it from the live list and make
    // it UNTARGETABLE until the stun expired — a stunned creep that no tower can shoot is
    // the opposite of the mechanic (Codex P2).
    //
    // Fall back to the cell the creep is standing on. That is the same metric the at-rest
    // branch below uses, it is a sound lower bound on what remains (the creep must still
    // traverse from here), and it keeps the creep targetable until it re-paths on its
    // first moving tick. Only `null` if the FROM cell is unreachable too, which means a
    // genuinely stranded row rather than a stale waypoint.
    const strandedCol = cellOf(fromX);
    const strandedRow = cellOf(fromY);
    const fromDist = distAt(field, strandedCol, strandedRow);
    return fromDist < 0 ? null : fromDist * DIST_SCALE;
  }
  const fromCol = cellOf(fromX);
  const fromRow = cellOf(fromY);
  // At rest the head IS the from-cell (movement's rest sentinel): no edge remains, so
  // the metric is exactly the cell's field distance.
  if (headCol === fromCol && headRow === fromRow) return headDist * DIST_SCALE;
  const edgeCost = headCol !== fromCol && headRow !== fromRow ? DIAG_COST : ORTHO_COST;
  const remaining = geom.edgeLen - progress; // arc-length still to travel to the head centre
  return headDist * DIST_SCALE + Math.floor((edgeCost * DIST_SCALE * remaining) / geom.edgeLen);
}

/** A creep is live iff its hp is a positive safe integer. */
function isLiveHp(hp: unknown): boolean {
  return Number.isSafeInteger(hp) && (hp as number) > 0;
}

/** Coerce a stored slow-column value to a safe integer, defaulting a
 *  missing/forged (ragged) entry to 0 — mirrors `tower.ts`'s `safeCombatColumn`. */
function safeSlowColumn(value: number | undefined): number {
  return Number.isSafeInteger(value) ? (value as number) : 0;
}

/** The result of a live-creep lookup: the SoA row index plus its already-derived
 *  resolution point (avoids re-deriving `deriveValidCreepPosition` at the call site). */
interface LiveCreepLookup {
  readonly index: number;
  readonly point: { x: number; y: number };
}

/**
 * The live creep matching `targetId` under the shared first-matching-valid-row rule
 * (mirrors `findValidTowerIndex`): the FIRST SoA row whose id is `targetId`, whose hp is
 * a positive safe integer, and whose position is valid. Duplicate/forged ids resolve to
 * that first row, so target-hold checks and impact application always agree. Returns
 * `null` when absent (a wasted/leaked-target shot).
 */
function findLiveCreep(creeps: CombatCreeps, targetId: number, grid: Grid): LiveCreepLookup | null {
  for (let i = 0; i < creeps.id.length; i++) {
    if (creeps.id[i] !== targetId) continue;
    if (!isLiveHp(creeps.hp[i])) continue;
    const geom = deriveValidCreepPosition(
      creeps.fromX[i],
      creeps.fromY[i],
      creeps.headCol[i],
      creeps.headRow[i],
      creeps.progress[i],
      grid,
    );
    if (geom !== null) return { index: i, point: geom.point };
  }
  return null;
}

/** Apply one `direct` effect to a creep row, net of flat `armor` (M2-S5a):
 *  `max(0, amount - armor)` blanks a hit at or under the creep's armor entirely.
 *  Still branch-saturating (no underflow) on the ARMORED amount — armor can only
 *  shrink the damage applied here, never change the no-underflow discipline
 *  itself, so a `0`-armor call is byte-identical to the pre-armor subtraction. */
function applyDirect(creeps: CombatCreeps, idx: number, amount: number, armor: number): void {
  const hp = creeps.hp[idx] as number;
  const armored = amount > armor ? amount - armor : 0;
  // Subtraction runs only when armored < hp, so the result is always a positive
  // safe integer — never a raw subtraction that could pass MIN_SAFE_INTEGER.
  creeps.hp[idx] = armored >= hp ? 0 : hp - armored;
}

/**
 * Apply one `slow` effect to a creep row under the STRONGEST-WINS, refresh-only-
 * at-equal-or-stronger stacking rule (G6/decision, Codex R1-11's within-class
 * authored-order proof): no active slow, or one strictly weaker than `mulFp`
 * (smaller `mulFp` ⇒ stronger — the creep moves slower) → write the new pair
 * (`mulFp`, `satAdd(tick, durationTicks)`); an EQUAL-strength active slow refreshes
 * its expiry to the NEW duration (restart-the-clock — the later-authored
 * application controls the final expiry among same-strength effects, sequential
 * refresh, never a max); a genuinely weaker incoming slow is a no-write no-op.
 */
function applySlow(
  creeps: CombatCreeps,
  idx: number,
  mulFp: number,
  durationTicks: number,
  tick: number,
): void {
  const active = creeps.slowMulFp[idx] as number;
  if (active === 0 || mulFp < active) {
    creeps.slowMulFp[idx] = mulFp;
    creeps.slowUntilTick[idx] = satAdd(tick, durationTicks);
  } else if (mulFp === active) {
    creeps.slowUntilTick[idx] = satAdd(tick, durationTicks);
  }
  // else: mulFp > active (weaker) — no write.
}

/**
 * Apply one `stun` effect to a creep row (M2-S6): takes the LATER of the active
 * expiry and the new one, `Math.max(active, satAdd(tick, durationTicks))` — longest-
 * remaining wins, never a plain refresh. A stun effect carries no magnitude
 * (`chanceNum` only gates whether it applies at all, at the call site, before this
 * is reached), but `durationTicks` IS a perfectly good ordering key: a fresh 1-tick
 * stun landing on a creep with 19 ticks already banked must not shorten it to 1.
 * Equal durations still land on the same expiry either way, so refresh-on-equal
 * (and therefore chain-lock, decision 5) is unaffected — this only changes the
 * outcome when the new expiry would be EARLIER than the active one.
 */
function applyStun(creeps: CombatCreeps, idx: number, durationTicks: number, tick: number): void {
  creeps.stunUntilTick[idx] = Math.max(
    creeps.stunUntilTick[idx] as number,
    satAdd(tick, durationTicks),
  );
}

/**
 * Apply one `dot` effect to the `(targetId, sourceId)` pair, mutating `dots` IN
 * PLACE (a refresh reassigns an existing array element — `DotRecord`'s fields are
 * `readonly`, so the element itself must be a fresh object, but the ARRAY is the
 * same reference throughout; append/drop use `push`/no-op on that same array).
 *
 * Order, LOAD-BEARING (M2-S5a P3 spec):
 *   1. Look the pair up FIRST (linear scan, mirrors `findLiveCreep`'s style).
 *   2. FOUND and still LIVE (`untilTick >= tick`) → refresh: adopt the new `amount`,
 *      extend `untilTick` to `satAdd(tick, effect.durationTicks)`, and leave
 *      `nextTickTick` UNTOUCHED. That single omission IS the rule that the tick cadence
 *      stays anchored to the record's first application — a refresh never resets or
 *      suppresses it. Note the boundary is INCLUSIVE, matching expiry everywhere else:
 *      a resident whose `untilTick` IS this tick is LIVE here, so its final due tick is
 *      never suppressed by a landing that coincides with it.
 *   2b. FOUND but already EXPIRED (`untilTick < tick` — forged/restored only; step (6)
 *      sweeps every phase) → NOT a refresh. It restarts on the incoming effect's own
 *      terms, identical to item 4 minus the append. Anchoring it instead was a hole
 *      through the tick step's expiry guard: extending `untilTick` past `tick` while
 *      keeping a stale overdue `nextTickTick` made the guard see a live, overdue record
 *      and fire it immediately (Codex P2, PR #78).
 *   3. NOT found, capacity full (`dots.length >= MAX_DOT_RECORDS`) → drop the
 *      insertion and count it (`events?.dotDropped`). The impact's direct damage
 *      (PASS 1, already applied before `applyImpactToCreep` ever calls here) still
 *      landed regardless — only the new DoT record is dropped.
 *   4. NOT found, capacity available → append a fresh record.
 *
 * The capacity check runs AFTER the lookup, deliberately: an early guard at the top
 * of this function would wrongly freeze every live DoT at the cap once the table is
 * full, because a REFRESH of an EXISTING pair would then also read as "at capacity"
 * and get wrongly rejected — but a refresh writes no new record (it replaces one
 * that is already there), so it must always succeed, capacity or not. Ordering the
 * lookup first is what keeps "the table is full" meaning "no more DISTINCT pairs",
 * not "no more DoT activity at all".
 *
 * `satAdd`, never `+`, for both `nextTickTick`/`untilTick`: the capability ceiling
 * makes overflow unreachable for compiled content, but forged state (tests
 * construct `DotRecord`s directly, and `runCombat` accepts `dots: readonly
 * unknown[]` from potentially-forged callers) reaches this function too.
 *
 * SOLD-SOURCE RULE — owner ruling (Rob, 2026-07-31): an impact fired before its
 * tower was sold still applies, and still REFRESHES, when it lands. The fire-time
 * snapshot — the impact carries its own `sourceId`, captured at fire time — is the
 * single authority here, exactly as it already is for damage and AoE lead points
 * elsewhere in this file. "A sold source can no longer refresh" (a phrase used
 * elsewhere in project docs) means the sold tower fires no NEW shots — it does NOT
 * mean an already-in-flight impact's refresh is suppressed. No code is needed to
 * make this true: it is emergent from the impact carrying its own `sourceId`, never
 * re-derived from currently-alive towers, so a later reader should not "fix" this by
 * adding a check against `towers` here.
 */
export function dotIndexKey(targetId: number, sourceId: number): string {
  return `${targetId}:${sourceId}`;
}

/** Build the `(targetId, sourceId) → row` index `applyDot` consults, ONCE per combat
 *  phase. Without it `applyDot` linear-scanned the whole table per application, so a
 *  restored state resolving up to `MAX_IN_FLIGHT_IMPACTS` due impacts — blast impacts
 *  visiting many creeps each — cost `O(impacts × affected creeps × records)`
 *  (CodeRabbit, PR #78). Same defect class as the duplicate-id traversal blow-up fixed
 *  in the tick step, and the same remedy: pay `O(records)` once, then `O(1)` per lookup.
 *  `canonicalDotRecords` has already deduped the pair, so one row per key is exact. */
export function buildDotIndex(dots: readonly DotRecord[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < dots.length; i++) {
    const rec = dots[i] as DotRecord;
    index.set(dotIndexKey(rec.targetId, rec.sourceId), i);
  }
  return index;
}

export function applyDot(
  dots: DotRecord[],
  index: Map<string, number>,
  targetId: number,
  sourceId: number,
  effect: Extract<EffectPrimitive, { kind: 'dot' }>,
  tick: number,
  events?: StepEvents,
): void {
  // `SimState.dots` STAYS CLOSED UNDER `canonicalDotRecords` — this is the third of the
  // three closure rules, and it lives here beside the other two (dedup via `index`, the
  // `MAX_DOT_RECORDS` cap below) rather than at the call site, so the set is symmetric and
  // a second caller cannot reopen the hole this function is `export`ed into (QC round 3).
  // The predicate is `validDotRecord`'s own `targetId` conjunction, verbatim. Every OTHER
  // operand arrives already proved — `validImpact` establishes `sourceId > 0`,
  // `validEffectPrimitive` the effect's magnitudes, `step()`'s entry guard `tick >= 0` —
  // but the target id is read straight off the creep SoA, which nothing validates:
  // `coerceSoa`'s row filter narrows only on `wave`/`creepId`. Unscreened, a forged row
  // with `id <= 0` (or a non-safe id) minted a record `canonicalDotRecords` then REJECTS:
  // resident and world-hashed for one tick, gone by the next phase — so that creep was
  // permanently DoT-immune while still burning a cap slot on every shot. Not a `dotDropped`
  // event: nothing was dropped at capacity, the application was never admissible.
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return;
  const key = dotIndexKey(targetId, sourceId);
  const at = index.get(key);
  if (at !== undefined) {
    const rec = dots[at] as DotRecord;
    // An ALREADY-EXPIRED resident is not a refresh target. It is a FRESH application that
    // happens to find the pair's slot still occupied, so it restarts on the incoming
    // effect's own terms — identical to the append below, minus the append (Codex P2).
    //
    // Anchoring an expired row was a hole straight through the tick step's expiry guard.
    // That guard skips `untilTick < tick`, but this branch runs FIRST (impacts resolve
    // before DoT ticks) and pushed `untilTick` out to `tick + durationTicks` while leaving
    // the stale, long-overdue `nextTickTick` in place — so the due-check that was meant to
    // reject the record instead saw it live with a tick overdue and fired it IMMEDIATELY,
    // for armor-bypassing damage a fresh application would not deal until a full cadence
    // later. Same forged/restored reachability as the guard it defeats: the sim never
    // leaves an expired record resident, because step (6) sweeps every phase.
    const expired = rec.untilTick < tick;
    dots[at] = {
      targetId,
      sourceId,
      amount: effect.amount,
      // A LIVE row keeps its own cadence and schedule — that is the anchoring rule, and a
      // refresh must never reset or suppress a tick already due. An expired row has no
      // schedule left to anchor to.
      cadenceTicks: expired ? effect.cadenceTicks : rec.cadenceTicks,
      nextTickTick: expired ? satAdd(tick, effect.cadenceTicks) : rec.nextTickTick,
      untilTick: satAdd(tick, effect.durationTicks),
    };
    return;
  }
  if (dots.length >= MAX_DOT_RECORDS) {
    if (events?.dotDropped !== undefined) events.dotDropped++;
    return;
  }
  index.set(key, dots.length);
  dots.push({
    targetId,
    sourceId,
    amount: effect.amount,
    cadenceTicks: effect.cadenceTicks,
    nextTickTick: satAdd(tick, effect.cadenceTicks),
    untilTick: satAdd(tick, effect.durationTicks),
  });
}

/** True iff a creep point is within `range` of a tower centre (inclusive, no sqrt). */
function inRange(cx: number, cy: number, towerX: number, towerY: number, range: number): boolean {
  const dx = cx - towerX;
  const dy = cy - towerY;
  if (Math.abs(dx) > range || Math.abs(dy) > range) return false; // overflow-proof early-out
  return dx * dx + dy * dy <= range * range;
}

/**
 * SATURATING non-negative integer add (bounty / kill bounty / early-call credit /
 * every score branch): clamps to `Number.MAX_SAFE_INTEGER` on overflow — genuinely
 * saturating, per the spec's "saturating arithmetic" (M2-S1's `safeAdd` instead
 * returned the OLD value on overflow, a guard rather than saturation; identical to
 * `satAdd` at every value real content ever reaches, since overflow is unreachable
 * there — see `capability.ts`'s sv6 rationale). A non-safe or negative operand
 * leaves `base` unchanged (still a deterministic no-op, never a platform-sensitive
 * value). The single implementation, shared by the combat and wave/score paths
 * (sim/index.ts). */
export function satAdd(base: number, amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0) return base;
  const b = Number.isSafeInteger(base) ? base : 0;
  return b <= Number.MAX_SAFE_INTEGER - amount ? b + amount : Number.MAX_SAFE_INTEGER;
}

/**
 * SATURATING non-negative integer multiply — the `satAdd` companion for the
 * scorer's `lives × survivalMul` term. A non-safe or negative operand yields `0`
 * (mirrors `satAdd`'s non-safe-input handling, never a platform-sensitive value);
 * overflow clamps to `Number.MAX_SAFE_INTEGER` rather than wrapping/losing
 * precision through float multiplication.
 */
export function satMul(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(b) || b < 0) return 0;
  if (a === 0 || b === 0) return 0;
  return a <= Math.floor(Number.MAX_SAFE_INTEGER / b) ? a * b : Number.MAX_SAFE_INTEGER;
}

/** Fresh per-fire snapshot of one tower's compiled effect bundle, in authored order
 *  (impacts serialize into the world-hash — a shared reference across fires would
 *  let one impact's runtime object identity bleed into another's). An `aoe`
 *  compiled effect collapses to the same `direct` {@link EffectPrimitive} a
 *  single-target effect would — the impact's OWN `kind` (`targeted` vs `blast`)
 *  already carries "this direct damage applies over an area"; the per-creep
 *  primitive list stays exactly the shape `applyImpactToCreep` already knows.
 *  `slow` and `dot` each map to their OWN explicit primitive — critically, `dot`
 *  is NOT allowed to fall through to the `direct`/`aoe` collapse above: a compiled
 *  `dot` that fell through would fire as raw direct damage, silently dropping its
 *  cadence/duration and never reaching `applyDot`. */
function snapshotEffects(effects: readonly CompiledEffect[], mulFp: number): EffectPrimitive[] {
  return effects.flatMap((e): EffectPrimitive[] => {
    if (e.kind === 'slow') {
      return [{ kind: 'slow', mulFp: e.mulFp, durationTicks: e.durationTicks }];
    }
    if (e.kind === 'dot') {
      return [
        {
          kind: 'dot',
          amount: buffAmount(e.amount, mulFp),
          cadenceTicks: e.cadenceTicks,
          durationTicks: e.durationTicks,
        },
      ];
    }
    if (e.kind === 'stun') {
      return [{ kind: 'stun', chanceNum: e.chanceNum, durationTicks: e.durationTicks }];
    }
    // A `support` effect is the AURA ITSELF, not something the bearer fires — and a
    // support bundle never reaches this function anyway (the fire step skips attackless
    // rows). Dropping it keeps `EffectPrimitive` — the hash-serialized shape — exactly
    // what it was at sv11.
    if (e.kind === 'support') return [];
    // 'direct' or 'aoe' — same primitive. BOTH are buffed: `aoe` is a DISTINCT compiled
    // kind that only collapses here, so keying the buff on `'direct'` alone would ship an
    // unbuffed `splash` — precisely the boss-armor lever this story exists to prove
    // (m2.md).
    return [{ kind: 'direct', amount: buffAmount(e.amount, mulFp) }];
  });
}

/** The AoE radius this tower's compiled bundle fires as a blast, or `null` for a
 *  single-target tower. Form-uniform and radius-uniform BY CONSTRUCTION
 *  (ruleset.ts's `checkCapabilityGlobal` sv8 compile-time gates, scoped PER TOWER,
 *  not capability.ts's profile: a tower's direct effects are all `single` or all
 *  `aoe`, and every `aoe` effect ON THAT TOWER shares one radius — not a
 *  catalog-wide radius, so `frost-splash` and `splash` can differ), so this simply
 *  locates the (unique, if present) radius rather than reconciling several. */
function blastRadiusOf(effects: readonly CompiledEffect[]): number | null {
  for (const e of effects) {
    if (e.kind === 'aoe') return e.radiusFp;
  }
  return null;
}

/**
 * Apply one impact's effects to a single creep row: PASS 1 every `direct` effect
 * in AUTHORED order → death check → PASS 2 (only if the creep survived) every
 * `slow`/`dot` effect in authored order (the M2-S3 STATUS-EFFECT ORDER, file
 * header — `dot` slots in as a second status kind alongside `slow` without
 * reordering, exactly as that header predicted). Shared by `targeted` and `blast`
 * resolution: m2.md's "per creep" nesting is IDENTICAL for both — a blast's outer
 * loop over its radius membership is the only difference from a targeted impact's
 * trivial one-creep "loop".
 *
 * `creepById` (M2-S5a P1) resolves this row's armor ONCE — a single lookup reused
 * for every `direct` effect in PASS 1, never re-resolved per effect. The `?? 0` is a
 * TOTALITY RAIL, not a balance choice: an unresolved `creepId` (forged state, or a
 * row whose catalog entry the caller never compiled) takes unarmored damage rather
 * than throwing — the same never-throw discipline every other lookup in this file
 * already carries.
 *
 * `dots`/`sourceId`/`events` (M2-S5a P3) thread PASS 2's `dot` effects to
 * `applyDot`, mutating the caller's `dots` table in place: `sourceId` is THIS
 * impact's fire-time source (never re-derived), and a lethal hit reaching PASS 1's
 * death check applies no `dot` (or `slow`/`stun`) either — the same "a lethal hit
 * consumes no draw" rule falls out for free since PASS 2 (every effect kind) only
 * runs when the creep survived PASS 1.
 *
 * `rng` (M2-S6) is the ONE draw source for PASS 2's `stun` roll — required, not
 * optional, for the same reason `creepById` above it is: a forgotten call site must
 * fail to compile, not silently simulate without stun. An immune target consumes no
 * draw either (the immunity check short-circuits before `rng.nextInt` is ever
 * called), so `rngState` only advances on a genuine, non-immune stun attempt.
 */
export function applyImpactToCreep(
  creeps: CombatCreeps,
  idx: number,
  effects: readonly EffectPrimitive[],
  tick: number,
  killedThisPhase: Set<number>,
  creepById: Readonly<Partial<Record<string, CompiledCreep>>>,
  dots: DotRecord[],
  dotIndex: Map<string, number>,
  sourceId: number,
  rng: Rng,
  events?: StepEvents,
): void {
  const def = creepById[creeps.creepId[idx] as string];
  const armor = def?.armor ?? 0;
  const immunities = def?.immunities ?? [];
  for (const effect of effects) {
    if (effect.kind === 'direct') applyDirect(creeps, idx, effect.amount, armor);
  }
  if ((creeps.hp[idx] as number) <= 0) {
    killedThisPhase.add(idx);
  } else {
    for (const effect of effects) {
      // `slow`'s immunity filter is NEW here (M2-S6) — `applySlow` itself has no
      // immunity check; `resolute`'s whole mechanic is this filter, kept at the call
      // site alongside stun's so both immunity kinds read as one rule.
      if (effect.kind === 'slow' && !immunities.includes('slow')) {
        applySlow(creeps, idx, effect.mulFp, effect.durationTicks, tick);
      }
      // Stun (M2-S6): an immune target short-circuits before `rng.nextInt` is ever
      // called, so it consumes no draw. Otherwise, one draw per attempt; every
      // stun is equal-strength, so a landed roll just calls `applyStun`.
      if (effect.kind === 'stun' && !immunities.includes('stun')) {
        if (rng.nextInt(256) < effect.chanceNum) {
          applyStun(creeps, idx, effect.durationTicks, tick);
        }
      }
      if (effect.kind === 'dot') {
        // A forged non-positive/non-safe `creeps.id` is screened INSIDE `applyDot`, beside
        // the dedup and cap rules it already owns — see its own note.
        applyDot(dots, dotIndex, creeps.id[idx] as number, sourceId, effect, tick, events);
      }
    }
  }
}

/**
 * Predict a blast's fire-time landing POINT for a target at row `idx` of
 * `survivors` — REUSES `advanceCreep` VERBATIM (M2-S4a step 2; no new geometry
 * code). The budget is `travelTicks × effectiveSpeedFp(...)` — the SAME formula
 * movement itself reads — spent in ONE re-path call, right now, rather than
 * simulated tick-by-tick:
 *   - `move`  → the projected point, re-derived via {@link deriveValidCreepPosition}
 *     (the single seam movement/targeting/placement all share).
 *   - `leak`  → the exit centre — m2.md's "clamped to the exit" falls straight out
 *     of `advanceCreep`'s own `leak` branch; no separate clamp to write.
 *   - `drop`  → the target's CURRENT point (`currentPoint`, already derived by the
 *     caller) — a TOTALITY RAIL. Precisely (QC round 3, reconciling this with
 *     `blastMembers`' own note, which said the opposite): `live` proves each row
 *     position-valid and reachable, but it does NOT prove `id` is a safe integer —
 *     `live.push` casts it — and a non-safe `id` is `advanceCreep`'s FIRST guard. So
 *     the rail IS reachable when `runCombat` is called directly, as the sim tests do.
 *     It is NOT reachable through `step()`, because movement runs before combat and
 *     drops such rows first. Kept so this seam, like every other in this file, never
 *     throws on a state it cannot itself prove impossible.
 *
 * TWO DELIBERATE APPROXIMATIONS — both acceptable because this is a PREDICTION,
 * not a re-simulation, so it must be DETERMINISTIC, never required to match real
 * movement tick-for-tick:
 *   (a) ONE re-path computed AT FIRE TIME, never recomputed per tick even if the
 *       maze changes under it afterward — a blast tower commits to its shot's
 *       landing point the instant it fires, like a real shot already in the
 *       air.
 *   (b) `travelTicks × effectiveSpeedFp` spends the WHOLE budget in a single call
 *       rather than flooring per-tick the way genuine movement accumulates it — the
 *       two can only ever differ by sub-cell rounding at a waypoint boundary.
 * Routing BOTH through `advanceCreep` itself — movement's own function — is what
 * keeps prediction and real movement from drifting into two independent
 * geometries.
 *
 * LOOP BOUND (no new DoS surface): a hostile bundle could author an enormous
 * `travelTicks × speedFp` product, but `advanceCreep`'s internal walk is bounded by
 * ROUTE LENGTH, not by `budget` — the distance field strictly DESCENDS every step,
 * so the walk reaches the exit (⇒ `leak`) within at most the board's max route
 * length regardless of how large `budget` is, then the point clamps there. This is
 * `advanceCreep`'s own existing termination proof (movement.ts), which already
 * covers budgets far larger than one tick's worth — a blast's one-shot budget adds
 * nothing new to that argument.
 *
 * DELIBERATELY DOES NOT READ STUN (M2-S6): the lead below runs through
 * `effectiveSpeedFp` exactly as movement does, un-stunned, so a blast fired at a
 * creep that is stunned before the shot lands leads ahead of a target that will not
 * move — and can miss. PRD 0001 §4 pins this: "only a state change in flight
 * (re-path, slow, stun, death, leak) makes a lead miss, and that is the counterplay,
 * not a bug." Folding stun into this prediction would be more "accurate" and would
 * contradict that spec.
 *
 * `domain` (M2-S7 P2) is threaded straight into `advanceCreep` — the target's own
 * `LiveCreep.domain`, resolved once by the caller. Left unthreaded, an AoE aimed
 * at a flyer would lead it along the GROUND flow field instead of straight at the
 * exit, the same hazard `advanceCreep`'s own header warns both callers about.
 */
function predictBlastPoint(
  field: DistanceField,
  grid: Grid,
  survivors: CombatCreeps,
  idx: number,
  domain: 'ground' | 'air',
  currentPoint: { readonly x: number; readonly y: number },
  travelTicks: number,
  slowFloorNum: number,
  slowFloorDen: number,
): { readonly x: number; readonly y: number } {
  const budget =
    travelTicks *
    effectiveSpeedFp(
      survivors.speed[idx] as number,
      safeSlowColumn(survivors.slowMulFp[idx]),
      slowFloorNum,
      slowFloorDen,
    );
  const outcome = advanceCreep(
    field,
    survivors.id[idx],
    survivors.hp[idx],
    survivors.fromX[idx],
    survivors.fromY[idx],
    survivors.headCol[idx],
    survivors.headRow[idx],
    survivors.progress[idx],
    budget,
    domain,
  );
  if (outcome.kind === 'leak') {
    return { x: cellCenterX(field.exit.col), y: cellCenterY(field.exit.row) };
  }
  if (outcome.kind === 'move') {
    const geom = deriveValidCreepPosition(
      outcome.fromX,
      outcome.fromY,
      outcome.headCol,
      outcome.headRow,
      outcome.progress,
      grid,
    );
    if (geom !== null) return geom.point;
  }
  return currentPoint; // 'drop' (totality rail, unreachable for a live-proved target)
}

/**
 * Gather a blast's radius-membership set, sorted CREEP-ID ASCENDING with a
 * row-index tiebreak (m2.md §Combat: "outer loop = affected creeps in creep-id
 * order"). Returns SoA row indices, not ids — a duplicate/forged id is kept as a
 * distinct row (M2-S4a's forged-SoA fixture).
 *
 * DO NOT REMOVE THIS SORT AS DEAD WORK (QC round-1 #6 keeps the prior "unobservable
 * today" reasoning below, now DIRECTLY PINNED rather than only order-independence-
 * tested — `story-aoe.test.ts` asserts the returned order itself, against the same
 * shuffled/duplicate-id fixture the order-independence test already used): at sv8
 * the traversal order is still NOT outcome-observable through `runCombat` — every
 * affected creep is damaged independently, deaths are collected in an index Set,
 * and bounty is credited by the later SoA sweep — but the order becomes
 * load-bearing at S6, when stun's chance roll draws from the sim RNG *inside* this
 * traversal and m2.md pins the draw sequence to exactly this order — a per-tick
 * divergence that would break replay determinism. It is established now,
 * unobservably through `runCombat` alone, so S6 inherits it rather than having to
 * introduce it: the same reason combat.ts already fixes the direct-then-status
 * shape ahead of the stories that need it. Extracting this as its own exported
 * function is what makes the order itself — not just its irrelevance to today's
 * outcome — directly assertable.
 *
 * `creepById`/`imp.domain` (M2-S7 P3): the impact's fire-time domain mask is
 * enforced HERE, per member, not just at acquisition — a ground blast must not
 * catch a flyer inside its radius even under forged state. `resolveCreepDomain`
 * is the shared totality rail (an unresolved `creepId` defaults to ground).
 */
export function blastMembers(
  creeps: CombatCreeps,
  grid: Grid,
  creepById: Readonly<Partial<Record<string, CompiledCreep>>>,
  imp: {
    readonly x: number;
    readonly y: number;
    readonly radiusFp: number;
    readonly domain: TowerTargetDomain;
  },
): readonly number[] {
  const members: { readonly idx: number; readonly id: number }[] = [];
  for (let i = 0; i < creeps.id.length; i++) {
    if (!isLiveHp(creeps.hp[i])) continue;
    const geom = deriveValidCreepPosition(
      creeps.fromX[i],
      creeps.fromY[i],
      creeps.headCol[i],
      creeps.headRow[i],
      creeps.progress[i],
      grid,
    );
    if (geom === null) continue;
    if (!inRange(geom.point.x, geom.point.y, imp.x, imp.y, imp.radiusFp)) continue;
    if (imp.domain !== 'both' && imp.domain !== resolveCreepDomain(creepById, creeps.creepId[i])) {
      continue;
    }
    const id = creeps.id[i];
    // NOT dead, but narrower than QC round-1 #9's comment claimed (corrected round 3):
    // the restore path (`coerceSoa`, index.ts) validates only `wave`/`creepId` per row,
    // never `id`, so a forged state can carry a non-safe-integer `id` on an otherwise-
    // live row — reachable when `runCombat` is called DIRECTLY (the sim tests do), which
    // is why this branch has a witness. Through `step()` it is unreachable: movement
    // precedes combat and `advanceCreep` drops such a row first. So this branch is a
    // totality rail for direct callers, not the production drop site — the same
    // reconciliation `predictBlastPoint`'s `drop` rail now carries.
    if (!Number.isSafeInteger(id)) continue;
    members.push({ idx: i, id: id as number });
  }
  members.sort((a, b) => a.id - b.id || a.idx - b.idx);
  return members.map((m) => m.idx);
}

/**
 * Run the combat phase for one tick over the POST-MOVE world. Returns the new creep
 * SoA (dead creeps swept), the surviving impact queue, the DoT-record table, and the
 * updated bounty; mutates `towers.targetId`/`towers.nextFireTick` in place (by
 * source row) and `creeps.hp`/`slowMulFp`/`slowUntilTick`/`stunUntilTick` during
 * resolution. `tick` is the pre-increment `state.tick`. `slowFloorNum`/`slowFloorDen`
 * (M2-S4a) are the ruleset's slow floor — needed here (not just by movement) because
 * a blast's fire-time lead prediction reads the SAME `effectiveSpeedFp` formula.
 *
 * Order (PLAN §13, extended M2-S3 with the status-effect close, M2-S4a with blast
 * resolution, M2-S5a P3 with the DoT tick step): (1) resolve due impacts (direct →
 * death check → slow/dot, per impact; a `blast` impact's "per impact" loop runs
 * over every creep in its radius, in creep-id order) → (2) DoT TICK every surviving
 * creep's due records, in creep-id order → (3) sweep dead + credit bounty (crediting
 * BOTH impact kills from step 1 and DoT kills from step 2 through the same
 * `killedThisPhase` set) → (4) precompute targetable live creeps → (5) per-tower
 * target + fire (a `targeted` or `blast` impact, per the tower's compiled effects)
 * → (6) EXPIRY SWEEP. Impacts with `impactTick <= tick` resolve (draining forged
 * overdue entries too) in queue array-iteration order — a deterministic total order.
 *
 * Step (2) runs BEFORE step (3)'s sweep, over the ORIGINAL `creeps` SoA (not yet
 * compacted into survivors) filtered to `isLiveHp` rows — this is what "inserted
 * between (1) and (2)" means literally: it slots between the OLD step (1) [resolve
 * impacts] and the OLD step (2) [sweep dead], reading the same live/dead state step
 * (1) just left behind, so a creep an impact killed THIS tick correctly does not
 * tick (its row already reads non-live) and a creep a DoT tick kills THIS tick is
 * swept by step (3) exactly like an impact kill, crediting bounty the same way.
 *
 * `creepById` (M2-S5a P1) is REQUIRED, symmetric with `towerById` above it: it is
 * the armor lookup `applyImpactToCreep` resolves once per creep row for every
 * `direct` effect. Required rather than optional-with-a-`{}`-default deliberately —
 * a forgotten call site must fail to compile, not silently simulate unarmored,
 * which is exactly the class of bug this parameter exists to prevent.
 *
 * `dots` (M2-S5a P2 shaped the state; P3 wires it up) is canonicalized, then
 * mutated by `applyDot` calls inside step (1)'s `applyImpactToCreep`, then ticked
 * by step (2), then filtered by step (6) to drop both non-surviving targets' records
 * and expired (`untilTick <= tick`) records — the table this function returns is the
 * fully closed-out phase result, never the unchanged canonicalization P2 returned.
 *
 * `rng` (M2-S6) is REQUIRED, placed after the last existing required parameter and
 * before the optional `events` — the same reasoning as `creepById` above it: a
 * forgotten call site must fail to compile, not silently simulate without stun. The
 * caller (`index.ts`'s `step()`) constructs it fresh from `state.rngState` once per
 * tick and writes the post-combat state back unconditionally; this function never
 * constructs or persists an `Rng` itself, only draws from the one it is handed.
 */
export function runCombat(
  creeps: CombatCreeps,
  towers: TowerArrays,
  impacts: readonly unknown[],
  dots: readonly unknown[],
  tick: number,
  bounty: number,
  field: DistanceField,
  grid: Grid,
  towerById: Readonly<Partial<Record<string, CompiledTower>>>,
  creepById: Readonly<Partial<Record<string, CompiledCreep>>>,
  slowFloorNum: number,
  slowFloorDen: number,
  rng: Rng,
  events?: StepEvents,
): {
  creeps: CombatCreeps;
  impacts: Impact[];
  dots: DotRecord[];
  bounty: number;
  killBounty: number;
} {
  const canonical = canonicalImpacts(impacts, grid);
  let canonicalDots = canonicalDotRecords(dots);

  // (1) RESOLVE due impacts; keep the rest. Per impact, the nesting is: outer loop
  //     = affected creeps (a `targeted` impact's single creep, or a `blast`'s
  //     radius-membership set in CREEP-ID ASCENDING order, ties by SoA row index —
  //     an EXPLICIT SORT, never spawn/array order, since forged state can carry any
  //     order or duplicate ids); per creep, PASS 1 applies every `direct` effect in
  //     authored order, THEN a death check, THEN — only if the creep survived —
  //     PASS 2 applies every `slow`/`dot` effect in authored order via the stacking
  //     rule (a lethal hit applies no statuses — G7/decision; `applyImpactToCreep`).
  //     Track creeps an impact kills THIS tick (positive hp → 0) so only those earn
  //     bounty — a forged non-positive-hp row is swept with no bounty. `killedThisPhase`
  //     (renamed from `killedByImpact`, M2-S5a P3) also collects step (2)'s DoT kills
  //     below — one death-tracking set for the whole phase, one sweep credits both.
  const kept: Impact[] = [];
  const killedThisPhase = new Set<number>();
  // Built ONCE per phase and mutated by `applyDot` on append — see `buildDotIndex`.
  const dotIndex = buildDotIndex(canonicalDots);
  for (const imp of canonical) {
    if (imp.impactTick > tick) {
      kept.push(imp);
      continue;
    }
    if (imp.kind === 'targeted') {
      const found = findLiveCreep(creeps, imp.targetId, grid); // null ⇒ wasted shot
      if (found === null) continue;
      const { index: idx, point } = found;
      // DOMAIN RE-CHECK (M2-S7 P3): resolved BEFORE the event or any effect/RNG draw —
      // a domain-rejected impact is a wasted shot in every observable way (no event,
      // no effect, no RNG draw), the same as a dead/gone target above. A tower sold
      // between fire and impact still cannot land on a domain its fire-time mask
      // never covered.
      if (
        imp.domain !== 'both' &&
        imp.domain !== resolveCreepDomain(creepById, creeps.creepId[idx])
      ) {
        continue;
      }
      events?.impactPoints.push({ x: point.x, y: point.y, radiusFp: 0 }); // BEFORE damage
      applyImpactToCreep(
        creeps,
        idx,
        imp.effects,
        tick,
        killedThisPhase,
        creepById,
        canonicalDots,
        dotIndex,
        imp.sourceId,
        rng,
        events,
      );
      continue;
    }
    // BLAST — the presentation event is emitted UNCONDITIONALLY, before membership
    // scanning (Codex R1-12): a blast that catches nobody, or whose original target
    // is long dead, still resolved and still lands visibly. `findLiveCreep`'s
    // dead-target early-out is a `targeted`-only rule — a blast scans by radius
    // membership, never by the fire-time target's id.
    events?.impactPoints.push({ x: imp.x, y: imp.y, radiusFp: imp.radiusFp });
    for (const idx of blastMembers(creeps, grid, creepById, imp)) {
      applyImpactToCreep(
        creeps,
        idx,
        imp.effects,
        tick,
        killedThisPhase,
        creepById,
        canonicalDots,
        dotIndex,
        imp.sourceId,
        rng,
        events,
      );
    }
  }

  // (2) DoT TICK — every SURVIVING creep's due DoT records, traversed CREEP-ID
  //     ASCENDING with a row-index tiebreak (the same idiom `blastMembers` already
  //     uses: `a.id - b.id || a.idx - b.idx`), applied in ARRAY ORDER per creep
  //     (application order, since `applyDot` appends). Runs over the ORIGINAL
  //     `creeps` SoA — not yet swept into `survivors` — filtered to `isLiveHp` rows,
  //     which is exactly what makes this "between (1) and (2)" in the file's step
  //     numbering: a row an impact just killed this tick already reads non-live here
  //     and correctly does not tick.
  //
  //     THE ID KEY IS CURRENTLY UNOBSERVABLE, and is kept deliberately (QC round 1
  //     tried hard to witness it and could not, so no test pretends to). `liveOrder` is
  //     built by an ascending row scan, so it is already idx-ascending before the sort;
  //     the idx tiebreak alone therefore reproduces the relative order of same-id rows
  //     whatever the id key does, and because `dotsByTarget` buckets BY id, the order
  //     in which distinct ids are visited cannot affect any bucket's outcome. It is
  //     canonical-form belt-and-braces: nothing inside THIS traversal consumes shared
  //     state, so the id key never becomes load-bearing here. (An earlier draft of this
  //     comment predicted S6's stun roll would draw from the sim RNG inside the DoT
  //     tick — it does not. The draw happens only in impact resolution, over
  //     `blastMembers`' creep-id-ascending order (`applyImpactToCreep`'s PASS 2), which
  //     runs before this traversal. That IS replay-load-bearing, and is where the id
  //     key earns its keep; this one stays belt-and-braces for canonical form alone.)
  //     Do not "simplify" it away.
  //
  //     O(creeps + records), NEVER O(creeps × records): one pass over `canonicalDots`
  //     (mutated by step (1)'s `applyDot` calls above) buckets record INDICES by
  //     `targetId`, preserving array order; then one pass over the id-sorted live
  //     rows looks each bucket up by id. A per-creep `dots.filter(...)` would be
  //     O(creeps × records) — deliberately not written.
  const dotsByTarget = new Map<number, number[]>();
  for (let i = 0; i < canonicalDots.length; i++) {
    const targetId = (canonicalDots[i] as DotRecord).targetId;
    const bucket = dotsByTarget.get(targetId);
    if (bucket === undefined) dotsByTarget.set(targetId, [i]);
    else bucket.push(i);
  }
  const liveOrder: { readonly id: number; readonly idx: number }[] = [];
  for (let i = 0; i < creeps.id.length; i++) {
    if (!isLiveHp(creeps.hp[i])) continue;
    // `Number.isSafeInteger` guard, matching `blastMembers`' identical sort (see its
    // own note): `liveOrder` is gated on hp, never on `id`, and the push below casts.
    // A non-safe `id` would make the comparator return `NaN`, and an inconsistent
    // comparator yields an IMPLEMENTATION-DEFINED permutation — which for a project
    // whose server re-sims in Node while clients run browser engines is a determinism
    // hazard, not a tidiness one. Unreachable through `step()` (movement drops such
    // rows first) but reachable when `runCombat` is called directly, as the sim tests
    // do — the same reachability `blastMembers` already guards. Like the id key below,
    // it has no independent test witness and no test pretends otherwise: a non-safe id
    // matches no record's `targetId`, so removing the guard changes no output — it
    // changes only whether a `NaN` can reach the comparator.
    if (!Number.isSafeInteger(creeps.id[i])) continue;
    liveOrder.push({ id: creeps.id[i] as number, idx: i });
  }
  liveOrder.sort((a, b) => a.id - b.id || a.idx - b.idx);
  // AT MOST ONE TICK PER RECORD PER SIM TICK, enforced STRUCTURALLY by a per-bucket
  // CURSOR rather than by a membership test. `dotsByTarget` is keyed by creep id, so when
  // several live rows share one id — forged/restored state; `coerceSoa` does not
  // de-duplicate `creeps.id` — every such row re-enters the SAME bucket. Three QC rounds
  // landed on this shape, each closing a defect the previous one left:
  //
  //   * With the due-check as the only bound, a backdated record fired once PER ROW, so
  //     `tick - nextTickTick > cadenceTicks × (rows - 1)` produced a burst: the
  //     invariant, its "totality proof" prose, and `StepEvents.dotTicks` were all wrong
  //     together (round 1).
  //   * A `tickedRecords` Set fixed the burst, but bounded only the WORK a duplicate row
  //     could redo — not the ITERATIONS it spent discovering there was none. Each row
  //     still re-walked the bucket from index 0, so the traversal stayed O(rows ×
  //     records): 2,000 forged same-id rows against a full table measured 46 ms in one
  //     `step()` (round 2).
  //   * Deleting a fully-walked bucket fixed that only where the row SURVIVES the walk. A
  //     record that KILLS its row leaves by the liveness `break` below, and every later
  //     row sharing the id re-scanned from zero, advancing the frontier by one record
  //     each — Σk ≈ records²/2, ~40M iterations in a single `step()` at the cap (round 3).
  //
  // Always deleting the bucket instead is NOT the fix, and the difference is observable:
  // a bucket abandoned mid-walk still owes its unvisited records to the next live row
  // sharing this id, and dropping them changes damage, `nextTickTick`, and the world hash
  // (witnessed by `an abandoned bucket is resumed by the next row sharing the id`).
  //
  // A cursor satisfies both constraints at once. It advances monotonically per bucket and
  // is never rewound, so each record is examined at most once per sim tick across ALL
  // rows sharing its target id: at-most-one-tick now falls out of the traversal rather
  // than being re-checked, every path is O(creeps + records), and a `tickedRecords`
  // membership test alongside it would be provably dead code.
  //
  // THE PREMISE THAT CARRIES THAT PROOF is the bucket build above: each record index is
  // pushed EXACTLY ONCE, into exactly one bucket (keyed by its own `targetId`). A Set was
  // robust to that failing; a cursor is not — a bucket holding a duplicated index (`[5,
  // 5]`) would tick record 5 twice within a SINGLE row, resurrecting the round-1 burst.
  // Nothing may filter, re-order or re-enter that build without re-deriving this.
  const bucketCursor = new Map<number, number>();
  for (const { id, idx } of liveOrder) {
    const bucket = dotsByTarget.get(id);
    if (bucket === undefined) continue;
    let cursor = bucketCursor.get(id) ?? 0;
    // `continue` below runs the `cursor++`, consuming a not-due record deliberately: not
    // due cannot become due within one tick, so no later row owes it a second look.
    for (; cursor < bucket.length; cursor++) {
      // Re-checked EVERY iteration, not just when `liveOrder` was built: an earlier
      // record in this same bucket may already have killed this row, and a corpse must
      // not keep ticking. Without this, `applyDirect` was a no-op at hp 0 but
      // `dotTicks` still counted the phantom and `nextTickTick` still advanced. The
      // `break` leaves `cursor` ON the record it did not consume — precisely what the
      // next live row sharing this id is owed.
      if (!isLiveHp(creeps.hp[idx])) break;
      const ri = bucket[cursor] as number;
      const record = canonicalDots[ri] as DotRecord;
      // No catch-up loop: even a forged backdated `nextTickTick` (far behind `tick`)
      // ticks exactly once and advances by exactly one `cadenceTicks`, never a burst.
      // This single `if` (not a `while`), together with the monotonic cursor above, is
      // the totality proof against a spinning/catch-up record.
      //
      // `untilTick < tick` skips a record that ALREADY EXPIRED before this tick (Codex
      // P2, PR #78). Note the strict `<`: inclusive expiry is preserved, so a record
      // whose `untilTick` IS this tick still ticks — that is the documented rule, and
      // step (6) removes it afterwards. Only a restored state reaches this: the sim
      // never leaves an expired record resident, because step (6) runs every phase. But
      // `canonicalDotRecords` cannot filter it — it never sees `tick` — so without this
      // guard a hand-edited save got one free tick of armor-bypassing damage, able to
      // kill and award bounty, from a DoT that had already ended.
      if (record.nextTickTick > tick || record.untilTick < tick) continue;
      // The literal `0` here is INTENTIONAL — armor bypass, not a forgotten/
      // placeholder argument: a DoT tick deals its `amount` bypassing armor
      // entirely, reusing `applyDirect`'s already-reviewed branch-saturating
      // no-underflow path rather than a second damage-application code path.
      applyDirect(creeps, idx, record.amount, 0);
      if (events?.dotTicks !== undefined) events.dotTicks++;
      // `DotRecord`'s fields are `readonly` — advancing `nextTickTick` builds a new
      // record object, written back to the same array slot (never mutated in place).
      // Rebuilt FIELD-BY-FIELD, never a spread, matching the discipline every other
      // hash-serialized rebuild in this file follows (`canonicalEffectPrimitive`,
      // `canonicalImpacts`, `canonicalDotRecords`, `applyDot`). Safe either way here
      // — every element of `canonicalDots` was itself built explicitly — but the
      // rule is kept uniform so this line can never be copied into a canonicalizer,
      // where a spread WOULD leak a forged property into the world-hash.
      canonicalDots[ri] = {
        targetId: record.targetId,
        sourceId: record.sourceId,
        amount: record.amount,
        cadenceTicks: record.cadenceTicks,
        nextTickTick: satAdd(record.nextTickTick, record.cadenceTicks),
        untilTick: record.untilTick,
      };
      if ((creeps.hp[idx] as number) <= 0) killedThisPhase.add(idx);
    }
    bucketCursor.set(id, cursor);
  }

  // (3) SWEEP dead (hp ≤ 0 or non-safe) into a fresh SoA; credit kills from step (1)
  //     AND step (2) alike (both tracked in `killedThisPhase`), from each killed
  //     creep's own bounty column. `killBounty` is the total kill income this tick
  //     (the sim adds it to the monotonic score accumulator). `creepId`/`slowMulFp`/
  //     `slowUntilTick` thread through by source row like any other column.
  //     `survivorIds` (M2-S5a P3) collects the surviving id set alongside the
  //     compaction itself — reused by step (6)'s DoT-record cleanup below so that
  //     pass never has to re-derive it from `survivors.id`.
  let nextBounty = bounty;
  let killBounty = 0;
  const survivors = emptyCreeps();
  const survivorIds = new Set<number>();
  for (let i = 0; i < creeps.id.length; i++) {
    if (!isLiveHp(creeps.hp[i])) {
      if (killedThisPhase.has(i)) {
        const amount = Number.isSafeInteger(creeps.bounty[i]) ? (creeps.bounty[i] as number) : 0;
        nextBounty = satAdd(nextBounty, amount);
        killBounty += amount >= 0 ? amount : 0;
      }
      continue;
    }
    survivors.id.push(creeps.id[i] as number);
    survivorIds.add(creeps.id[i] as number);
    survivors.hp.push(creeps.hp[i] as number);
    survivors.bounty.push(
      Number.isSafeInteger(creeps.bounty[i]) ? (creeps.bounty[i] as number) : 0,
    );
    survivors.speed.push(Number.isSafeInteger(creeps.speed[i]) ? (creeps.speed[i] as number) : 0);
    survivors.fromX.push(creeps.fromX[i] as number);
    survivors.fromY.push(creeps.fromY[i] as number);
    survivors.headCol.push(creeps.headCol[i] as number);
    survivors.headRow.push(creeps.headRow[i] as number);
    survivors.progress.push(creeps.progress[i] as number);
    survivors.wave.push(Number.isSafeInteger(creeps.wave[i]) ? (creeps.wave[i] as number) : 0);
    survivors.creepId.push(
      typeof creeps.creepId[i] === 'string' ? (creeps.creepId[i] as string) : '',
    );
    survivors.slowMulFp.push(safeSlowColumn(creeps.slowMulFp[i]));
    survivors.slowUntilTick.push(safeSlowColumn(creeps.slowUntilTick[i]));
    survivors.stunUntilTick.push(safeSlowColumn(creeps.stunUntilTick[i]));
  }

  // (4) Precompute the targetable live creeps once (position-valid + reachable).
  const live: LiveCreep[] = [];
  for (let i = 0; i < survivors.id.length; i++) {
    const geom = deriveValidCreepPosition(
      survivors.fromX[i],
      survivors.fromY[i],
      survivors.headCol[i],
      survivors.headRow[i],
      survivors.progress[i],
      grid,
    );
    if (geom === null) continue;
    const domain = resolveCreepDomain(creepById, survivors.creepId[i]);
    const dist = remainingRouteDist(
      field,
      domain,
      geom,
      survivors.fromX[i] as number,
      survivors.fromY[i] as number,
      survivors.headCol[i] as number,
      survivors.headRow[i] as number,
      survivors.progress[i] as number,
    );
    if (dist === null) continue; // stranded (neither waypoint nor from-cell reachable)
    live.push({
      id: survivors.id[i] as number,
      index: i,
      x: geom.point.x,
      y: geom.point.y,
      dist,
      domain,
    });
  }

  // (5) Per valid tower: hold-or-acquire the sticky "first" target, then fire.
  //     `towerById[towers.towerId[i]]` resolves this row's per-kind stats — the SAME
  //     resolution `forEachValidTower` itself used to canonicalize the row, so a
  //     valid row always resolves here too.
  //     M2-S8: the support aura is derived ONCE per combat phase, here, and never
  //     stored — a forged or restored `SimState` structurally cannot carry a stale buff.
  //     `null` when no support tower is placed, which is the whole cost on a beacon-free
  //     board (see `buildAuraIndex`'s pre-scan note).
  const auraIndex = buildAuraIndex(grid, towers, towerById);
  forEachValidTower(grid, towers, towerById, (i, id, col, row) => {
    const def = towerById[towers.towerId[i] as string];
    if (def === undefined) return; // unreachable: forEachValidTower already proved this row valid
    const attack = def.attack;
    // M2-S8: a support tower has no attack at all, so it never targets and never fires.
    // Skipped BEFORE any attack field is read. Both combat columns are zeroed rather than
    // left untouched: `coerceSoa`'s `safeCombatColumn` admits a forged or restored beacon
    // row carrying nonzero `targetId` AND `nextFireTick`, and an untouched skip would
    // leave either resident in the world hash forever. Zeroing only one of two equally
    // forgeable columns would be an asymmetry with no reason behind it.
    if (attack === undefined) {
      towers.targetId[i] = 0;
      towers.nextFireTick[i] = 0;
      return;
    }
    const range = attack.rangeFp;
    // 2×2 footprint centre = the shared corner of its four cells (units-per-tile FP_ONE).
    const towerX = (col + 1) * FP_ONE;
    const towerY = (row + 1) * FP_ONE;

    // One pass over the live creeps resolves BOTH the sticky-hold check and the
    // nearest-in-range acquire: track whether the held lock's first-matching row is
    // in range, and (independently) the best in-range acquire candidate.
    const held =
      Number.isSafeInteger(towers.targetId[i]) && towers.targetId[i] !== 0
        ? (towers.targetId[i] as number)
        : 0;
    let heldSeen = false; // first matching row decides the hold — mirrors findLiveCreep
    let heldInRange = false;
    let heldLive: LiveCreep | null = null;
    let best: LiveCreep | null = null;
    for (const c of live) {
      // DOMAIN FILTER (M2-S7 P3): a creep the tower's mask does not cover is skipped
      // for BOTH the sticky-hold check and the acquire candidate — the two must agree
      // or a tower could hold a target it may not fire on.
      const covered = attack.domain === 'both' || attack.domain === c.domain;
      const within = covered && inRange(c.x, c.y, towerX, towerY, range);
      if (held !== 0 && !heldSeen && c.id === held) {
        heldSeen = true;
        heldInRange = within;
        heldLive = c;
      }
      if (
        within &&
        (best === null || c.dist < best.dist || (c.dist === best.dist && c.id < best.id))
      ) {
        best = c;
      }
    }
    // Hold the locked creep while it is present and in range; otherwise acquire the
    // in-range creep nearest the exit (ties → lower id), or none. `targetLive` is the
    // SAME row this decision was made from — `heldLive` for a hold, `best` for a fresh
    // acquire — never re-derived, so a blast fire below reuses exactly what targeting saw.
    const targetLive = held !== 0 && heldInRange ? heldLive : best;
    const target = targetLive === null ? 0 : targetLive.id;
    towers.targetId[i] = target;

    if (targetLive === null) return;
    const nft = towers.nextFireTick[i];
    const fireable = !Number.isSafeInteger(nft) || tick >= (nft as number);
    if (!fireable) return;
    if (kept.length >= MAX_IN_FLIGHT_IMPACTS) return; // cap full — retry next tick, no advance
    const impactTick = tick + attack.travelTicks;
    const nextFire = tick + attack.cadenceTicks;
    if (!Number.isSafeInteger(impactTick) || !Number.isSafeInteger(nextFire)) return; // overflow no-op

    // M2-S8: the buff is read at FIRE TIME and baked into the snapshot, so an impact
    // already in flight keeps the multiplier that was live when it launched — the same
    // fire-time-snapshot authority the rest of the effect bundle already has. Selling the
    // beacon returns the recipient to base damage on its NEXT fire, not this one.
    const mulFp = auraMulFor(auraIndex, grid, col, row);
    const radiusFp = blastRadiusOf(def.effects);
    if (radiusFp === null) {
      // Single-target tower — unchanged pre-M2-S4a shape.
      kept.push({
        kind: 'targeted',
        impactTick,
        targetId: target,
        sourceId: id,
        domain: attack.domain,
        effects: snapshotEffects(def.effects, mulFp), // fresh objects per fire (Codex — hash-serialized)
      });
      events?.fired.push({
        kind: 'targeted',
        originX: towerX,
        originY: towerY,
        targetId: target,
        launchTick: tick,
        impactTick,
      });
    } else {
      // Blast tower (M2-S4a step 2): lead the target along its route at fire-time
      // effective speed, from the SAME `LiveCreep` row the selection pass above
      // already matched (`targetLive`, non-null here — checked above) — no re-scan.
      const point = predictBlastPoint(
        field,
        grid,
        survivors,
        targetLive.index,
        targetLive.domain,
        { x: targetLive.x, y: targetLive.y },
        attack.travelTicks,
        slowFloorNum,
        slowFloorDen,
      );
      kept.push({
        kind: 'blast',
        impactTick,
        x: point.x,
        y: point.y,
        radiusFp,
        sourceId: id,
        domain: attack.domain,
        effects: snapshotEffects(def.effects, mulFp),
      });
      events?.fired.push({
        kind: 'blast',
        originX: towerX,
        originY: towerY,
        targetId: target,
        destX: point.x,
        destY: point.y,
        launchTick: tick,
        impactTick,
      });
    }
    towers.nextFireTick[i] = nextFire;
  });

  // (6) EXPIRY SWEEP — closes the combat phase (M2-S3, G8, extended M2-S5a P3 to
  //     `dots`): every creep whose `slowUntilTick` has reached this tick resets to
  //     `(0, 0)`. Durations end INCLUSIVELY (a slow applied at T for D ticks is
  //     observed through movement/firing at T+D, then cleared here so no expired
  //     record survives into the next tick's movement).
  for (let i = 0; i < survivors.id.length; i++) {
    if (survivors.slowMulFp[i] !== 0 && (survivors.slowUntilTick[i] as number) <= tick) {
      survivors.slowMulFp[i] = 0;
      survivors.slowUntilTick[i] = 0;
    }
    if (survivors.stunUntilTick[i] !== 0 && (survivors.stunUntilTick[i] as number) <= tick) {
      survivors.stunUntilTick[i] = 0;
    }
  }
  // `dots` cleanup (M2-S5a P3), combined into one filter pass — both are simply
  // predicates on the same array, no perf requirement forces two passes:
  //   - a record's `targetId` not among `survivorIds` (point 5 — a creep's records
  //     die with it, whether killed this phase or leaked/removed some other way);
  //   - `untilTick <= tick` (point 6 — INCLUSIVE expiry: a DoT tick due exactly on
  //     `untilTick` still applied in step (2) above, which ran BEFORE this expiry
  //     step in the same phase, then the record is removed here before the next
  //     tick boundary).
  canonicalDots = canonicalDots.filter((r) => survivorIds.has(r.targetId) && r.untilTick > tick);

  return { creeps: survivors, impacts: kept, dots: canonicalDots, bounty: nextBounty, killBounty };
}
