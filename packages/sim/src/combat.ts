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

import { FP_ONE } from '@wynding/engine';
import { ORTHO_COST, DIAG_COST, type Grid } from './board';
import type { DistanceField } from './pathfinding';
import { distAt } from './field-access';
import {
  advanceCreep,
  cellCenterX,
  cellCenterY,
  deriveValidCreepPosition,
  cellOf,
  type CreepGeometry,
} from './movement';
import { effectiveSpeedFp } from './ruleset-shared';
import { MAX_TOWERS, forEachValidTower, type TowerArrays } from './tower';
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
 *  `dot` (M2-S5a P2 — STATE SHAPE ONLY: no primitive reaches `applyDot` or a
 *  tick step yet, both P3) carries the same three fields the DoT record adopts
 *  on first application — `amount` per tick, `cadenceTicks` between ticks,
 *  `durationTicks` the record's total lifetime. */
export type EffectPrimitive =
  | { readonly kind: 'direct'; readonly amount: number }
  | { readonly kind: 'slow'; readonly mulFp: number; readonly durationTicks: number }
  | {
      readonly kind: 'dot';
      readonly amount: number;
      readonly cadenceTicks: number;
      readonly durationTicks: number;
    };

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
 */
export type Impact =
  | {
      readonly kind: 'targeted';
      readonly impactTick: number;
      readonly targetId: number;
      readonly sourceId: number;
      readonly effects: EffectPrimitive[];
    }
  | {
      readonly kind: 'blast';
      readonly impactTick: number;
      readonly x: number;
      readonly y: number;
      readonly radiusFp: number;
      readonly sourceId: number;
      readonly effects: EffectPrimitive[];
    };

/**
 * A per-source, per-target damage-over-time record (M2-S5a P2 — STATE SHAPE ONLY:
 * nothing in this packet appends, ticks, or expires one; that is P3's `applyDot` and
 * tick step). Lives in a flat `SimState.dots` array mirroring `impacts` — a
 * per-source DoT is a creep↔tower RELATION, not a creep attribute (unlike slow,
 * which collapses to one column pair because strongest-wins means at most one live
 * slow per creep; two `venom` towers keep independently-ticking records on the same
 * creep, per `docs/CONTEXT.md`'s Status effect entry).
 */
export interface DotRecord {
  readonly targetId: number; // creep ENTITY id (matches Impact.targetId)
  readonly sourceId: number; // firing tower's entity id — source identity
  readonly amount: number; // per-tick damage, re-adopted on refresh
  readonly cadenceTicks: number; // fixed for the record's life
  readonly nextTickTick: number; // the tick this record next deals damage
  readonly untilTick: number; // INCLUSIVE final tick
}

/** Forged-state / DoS backstop on the resident DoT-record table — the direct
 *  analogue of {@link MAX_IN_FLIGHT_IMPACTS}: `applyDot` (P3) simply drops a
 *  new-pair application once the table is full, the same deterministic-no-op
 *  precedent, already reviewed there. Deliberately NOT a per-creep source cap —
 *  that would contradict `docs/CONTEXT.md`'s Status effect entry ("each source's
 *  DoT coexists"). Its value is provisional in THIS packet; P4 measures it against
 *  a hostile-state benchmark and may bring it down before sv9 ships. */
export const MAX_DOT_RECORDS = 20_000;

/**
 * Optional per-step event collector (#31): NOT part of `SimState` (never serialized,
 * never hash-relevant) and NOT a `RenderVM` field — a transient out-param the caller
 * owns. `step()`/`runCombat()` only ever APPEND to it; the caller owns clearing and
 * lifetime. A terminal or no-op early-return `step()` path appends nothing, so a
 * pre-populated collector passed through either early return is left unchanged.
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
 *  creep, so a column pair is exactly right, not a shortcut). */
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
}

/** The empty 13-column creep SoA — the single factory, reused by the sim barrel. */
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
});

/** True iff `e` is a valid `EffectPrimitive`: `direct` — a positive safe-integer
 *  `amount`; `slow` — `mulFp` 1..255 and `durationTicks` a positive safe integer
 *  ≤ 1,000,000 (the schema's `GENERIC_MAX`); `dot` — `amount` a positive safe
 *  integer, `cadenceTicks` a positive safe integer, `durationTicks` a positive
 *  safe integer ≤ 1,000,000 (the same `GENERIC_MAX` bound `slow` already uses).
 *  Any other shape is invalid. */
function validEffectPrimitive(e: unknown): e is EffectPrimitive {
  if (e === null || typeof e !== 'object') return false;
  const rec = e as {
    kind?: unknown;
    amount?: unknown;
    mulFp?: unknown;
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
    return (
      Number.isSafeInteger(rec.amount) &&
      (rec.amount as number) > 0 &&
      Number.isSafeInteger(rec.cadenceTicks) &&
      (rec.cadenceTicks as number) > 0 &&
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
  return {
    kind: 'dot',
    amount: e.amount,
    cadenceTicks: e.cadenceTicks,
    durationTicks: e.durationTicks,
  };
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
 * otherwise flow into the world-hash and then (P3) into DoT state. Any other shape,
 * or an unrecognized `kind`, is dropped.
 */
function validImpact(imp: unknown, grid: Grid): imp is Impact {
  if (imp === null || typeof imp !== 'object') return false;
  const rec = imp as {
    kind?: unknown;
    impactTick?: unknown;
    effects?: unknown;
    sourceId?: unknown;
  };
  if (!Number.isSafeInteger(rec.impactTick)) return false;
  if (!Number.isSafeInteger(rec.sourceId) || (rec.sourceId as number) <= 0) return false;
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
            effects: imp.effects.map(canonicalEffectPrimitive),
          }
        : {
            kind: 'blast',
            impactTick: imp.impactTick,
            x: imp.x,
            y: imp.y,
            radiusFp: imp.radiusFp,
            sourceId: imp.sourceId,
            effects: imp.effects.map(canonicalEffectPrimitive),
          },
    );
  }
  return out;
}

/**
 * True iff `rec` is a valid `DotRecord`: `targetId`/`sourceId` positive safe
 * integers (entity ids; `0` is not one, mirroring `Impact.sourceId` above),
 * `amount ≥ 1`, `cadenceTicks ≥ 1`, `nextTickTick`/`untilTick` non-negative safe
 * integers with `untilTick ≥ nextTickTick` (a record whose expiry precedes its
 * next tick is structurally forged). Any other shape is invalid.
 */
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
    Number.isSafeInteger(r.nextTickTick) &&
    (r.nextTickTick as number) >= 0 &&
    Number.isSafeInteger(r.untilTick) &&
    (r.untilTick as number) >= 0 &&
    (r.untilTick as number) >= (r.nextTickTick as number)
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
 * Returns `null` when the next waypoint is unreachable (a forged row that can never be
 * a valid "first" target) — the same total, never-throw contract as the rest of combat.
 */
function remainingRouteDist(
  field: DistanceField,
  geom: CreepGeometry,
  fromX: number,
  fromY: number,
  headCol: number,
  headRow: number,
  progress: number,
): number | null {
  const headDist = distAt(field, headCol, headRow);
  if (headDist < 0) return null; // unreachable waypoint ⇒ not targetable
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
 *  primitive list stays exactly the shape `applyImpactToCreep` already knows. */
function snapshotEffects(effects: readonly CompiledEffect[]): EffectPrimitive[] {
  return effects.map((e) => {
    if (e.kind === 'slow') return { kind: 'slow', mulFp: e.mulFp, durationTicks: e.durationTicks };
    return { kind: 'direct', amount: e.amount }; // 'direct' or 'aoe' — same primitive
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
 * `slow` effect in authored order (the M2-S3 STATUS-EFFECT ORDER, file header).
 * Shared by `targeted` and `blast` resolution: m2.md's "per creep" nesting is
 * IDENTICAL for both — a blast's outer loop over its radius membership is the only
 * difference from a targeted impact's trivial one-creep "loop".
 *
 * `creepById` (M2-S5a) resolves this row's armor ONCE — a single lookup reused for
 * every `direct` effect in PASS 1, never re-resolved per effect. The `?? 0` is a
 * TOTALITY RAIL, not a balance choice: an unresolved `creepId` (forged state, or a
 * row whose catalog entry the caller never compiled) takes unarmored damage rather
 * than throwing — the same never-throw discipline every other lookup in this file
 * already carries.
 */
export function applyImpactToCreep(
  creeps: CombatCreeps,
  idx: number,
  effects: readonly EffectPrimitive[],
  tick: number,
  killedByImpact: Set<number>,
  creepById: Readonly<Partial<Record<string, CompiledCreep>>>,
): void {
  const armor = creepById[creeps.creepId[idx] as string]?.armor ?? 0;
  for (const effect of effects) {
    if (effect.kind === 'direct') applyDirect(creeps, idx, effect.amount, armor);
  }
  if ((creeps.hp[idx] as number) <= 0) {
    killedByImpact.add(idx);
  } else {
    for (const effect of effects) {
      if (effect.kind === 'slow') applySlow(creeps, idx, effect.mulFp, effect.durationTicks, tick);
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
 */
function predictBlastPoint(
  field: DistanceField,
  grid: Grid,
  survivors: CombatCreeps,
  idx: number,
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
 */
export function blastMembers(
  creeps: CombatCreeps,
  grid: Grid,
  imp: { readonly x: number; readonly y: number; readonly radiusFp: number },
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
 * source row) and `creeps.hp`/`slowMulFp`/`slowUntilTick` during resolution. `tick`
 * is the pre-increment `state.tick`. `slowFloorNum`/`slowFloorDen` (M2-S4a) are the
 * ruleset's slow floor — needed here (not just by movement) because a blast's
 * fire-time lead prediction reads the SAME `effectiveSpeedFp` formula.
 *
 * Order (PLAN §13, extended M2-S3 with the status-effect close, M2-S4a with blast
 * resolution): resolve due impacts (direct → death check → slow, per impact; a
 * `blast` impact's "per impact" loop runs over every creep in its radius, in
 * creep-id order) → sweep dead + credit bounty → per-tower target + fire (a
 * `targeted` or `blast` impact, per the tower's compiled effects) → EXPIRY SWEEP.
 * Impacts with `impactTick <= tick` resolve (draining forged overdue entries too)
 * in queue array-iteration order — a deterministic total order.
 *
 * `creepById` (M2-S5a) is REQUIRED, symmetric with `towerById` above it: it is the
 * armor lookup `applyImpactToCreep` resolves once per creep row for every `direct`
 * effect. Required rather than optional-with-a-`{}`-default deliberately — a
 * forgotten call site must fail to compile, not silently simulate unarmored,
 * which is exactly the class of bug this parameter exists to prevent.
 *
 * `dots` (M2-S5a P2 — STATE SHAPE ONLY) is canonicalized and returned UNCHANGED in
 * this packet: nothing here appends, ticks, or expires a record. P3 wires
 * `applyDot` and the tick step into the same order this doc describes.
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
  events?: StepEvents,
): {
  creeps: CombatCreeps;
  impacts: Impact[];
  dots: DotRecord[];
  bounty: number;
  killBounty: number;
} {
  const canonical = canonicalImpacts(impacts, grid);
  // P2: STATE SHAPE ONLY — canonicalized and returned unchanged. P3 wires the tick
  // step and `applyDot` into this function; nothing here reads or writes it yet.
  const canonicalDots = canonicalDotRecords(dots);

  // (1) RESOLVE due impacts; keep the rest. Per impact, the nesting is: outer loop
  //     = affected creeps (a `targeted` impact's single creep, or a `blast`'s
  //     radius-membership set in CREEP-ID ASCENDING order, ties by SoA row index —
  //     an EXPLICIT SORT, never spawn/array order, since forged state can carry any
  //     order or duplicate ids); per creep, PASS 1 applies every `direct` effect in
  //     authored order, THEN a death check, THEN — only if the creep survived —
  //     PASS 2 applies every `slow` effect in authored order via the stacking rule
  //     (a lethal hit applies no statuses — G7/decision; `applyImpactToCreep`).
  //     Track creeps an impact kills THIS tick (positive hp → 0) so only those earn
  //     bounty — a forged non-positive-hp row is swept with no bounty.
  const kept: Impact[] = [];
  const killedByImpact = new Set<number>();
  for (const imp of canonical) {
    if (imp.impactTick > tick) {
      kept.push(imp);
      continue;
    }
    if (imp.kind === 'targeted') {
      const found = findLiveCreep(creeps, imp.targetId, grid); // null ⇒ wasted shot
      if (found === null) continue;
      const { index: idx, point } = found;
      events?.impactPoints.push({ x: point.x, y: point.y, radiusFp: 0 }); // BEFORE damage
      applyImpactToCreep(creeps, idx, imp.effects, tick, killedByImpact, creepById);
      continue;
    }
    // BLAST — the presentation event is emitted UNCONDITIONALLY, before membership
    // scanning (Codex R1-12): a blast that catches nobody, or whose original target
    // is long dead, still resolved and still lands visibly. `findLiveCreep`'s
    // dead-target early-out is a `targeted`-only rule — a blast scans by radius
    // membership, never by the fire-time target's id.
    events?.impactPoints.push({ x: imp.x, y: imp.y, radiusFp: imp.radiusFp });
    for (const idx of blastMembers(creeps, grid, imp)) {
      applyImpactToCreep(creeps, idx, imp.effects, tick, killedByImpact, creepById);
    }
  }

  // (2) SWEEP dead (hp ≤ 0 or non-safe) into a fresh SoA; credit only impact kills,
  //     from each killed creep's own bounty column. `killBounty` is the total kill
  //     income this tick (the sim adds it to the monotonic score accumulator).
  //     `creepId`/`slowMulFp`/`slowUntilTick` thread through by source row like any
  //     other column.
  let nextBounty = bounty;
  let killBounty = 0;
  const survivors = emptyCreeps();
  for (let i = 0; i < creeps.id.length; i++) {
    if (!isLiveHp(creeps.hp[i])) {
      if (killedByImpact.has(i)) {
        const amount = Number.isSafeInteger(creeps.bounty[i]) ? (creeps.bounty[i] as number) : 0;
        nextBounty = satAdd(nextBounty, amount);
        killBounty += amount >= 0 ? amount : 0;
      }
      continue;
    }
    survivors.id.push(creeps.id[i] as number);
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
  }

  // (3) Precompute the targetable live creeps once (position-valid + reachable).
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
    const dist = remainingRouteDist(
      field,
      geom,
      survivors.fromX[i] as number,
      survivors.fromY[i] as number,
      survivors.headCol[i] as number,
      survivors.headRow[i] as number,
      survivors.progress[i] as number,
    );
    if (dist === null) continue; // unreachable next waypoint ⇒ not the "first" target
    live.push({ id: survivors.id[i] as number, index: i, x: geom.point.x, y: geom.point.y, dist });
  }

  // (4) Per valid tower: hold-or-acquire the sticky "first" target, then fire.
  //     `towerById[towers.towerId[i]]` resolves this row's per-kind stats — the SAME
  //     resolution `forEachValidTower` itself used to canonicalize the row, so a
  //     valid row always resolves here too.
  forEachValidTower(grid, towers, towerById, (i, id, col, row) => {
    const def = towerById[towers.towerId[i] as string];
    if (def === undefined) return; // unreachable: forEachValidTower already proved this row valid
    const range = def.rangeFp;
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
      const within = inRange(c.x, c.y, towerX, towerY, range);
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
    const impactTick = tick + def.travelTicks;
    const nextFire = tick + def.cadenceTicks;
    if (!Number.isSafeInteger(impactTick) || !Number.isSafeInteger(nextFire)) return; // overflow no-op

    const radiusFp = blastRadiusOf(def.effects);
    if (radiusFp === null) {
      // Single-target tower — unchanged pre-M2-S4a shape.
      kept.push({
        kind: 'targeted',
        impactTick,
        targetId: target,
        sourceId: id,
        effects: snapshotEffects(def.effects), // fresh objects per fire (Codex — hash-serialized)
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
        { x: targetLive.x, y: targetLive.y },
        def.travelTicks,
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
        effects: snapshotEffects(def.effects),
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

  // (5) EXPIRY SWEEP — closes the combat phase (M2-S3, G8): every creep whose
  //     `slowUntilTick` has reached this tick resets to `(0, 0)`. Durations end
  //     INCLUSIVELY (a slow applied at T for D ticks is observed through movement/
  //     firing at T+D, then cleared here so no expired record survives into the
  //     next tick's movement).
  for (let i = 0; i < survivors.id.length; i++) {
    if (survivors.slowMulFp[i] !== 0 && (survivors.slowUntilTick[i] as number) <= tick) {
      survivors.slowMulFp[i] = 0;
      survivors.slowUntilTick[i] = 0;
    }
  }

  return { creeps: survivors, impacts: kept, dots: canonicalDots, bounty: nextBounty, killBounty };
}
