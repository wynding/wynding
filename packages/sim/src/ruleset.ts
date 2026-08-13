// ruleset.ts — compile + validate + hash the ADR 0007 ruleset bundle (v2 schema).
//
// The sim reads ALL sim-affecting tuning from the bundle (ADR 0007), never from
// hardcoded constants. This module is the single seam between the raw authored
// `Ruleset` (pure JSON data from `@wynding/types`, authored in `@wynding/content`)
// and the running sim — so the sim NEVER imports `@wynding/content`; the caller
// (replay/client) hands the bundle in and we compile it here.
//
// Three responsibilities:
//   • `rulesetDigest(bundle)` — the collision-resistant content identity
//     (`rulesetHash`): normalize (project every known field explicitly) → RFC 8785
//     JCS → SHA-256, exactly per `docs/design-notes/ruleset-format.md`. Shared by
//     replay creation and validation so client and server never drift.
//   • `compileRuleset(bundle, boardId)` — (1) `validateRulesetShape` (ruleset-schema.ts)
//     for ALL shape/structural/cross-field validation, (2) the per-`simVersion`
//     capability profile (capability.ts) gating kinds/cardinalities/values to
//     exactly this sim build's behavior, (3) board playability + schedule
//     compilation, (4) the digest — assembled into a branded `CompiledRuleset`
//     (grid + distance field + indexed catalogs + an explicit per-spawn schedule).
//     Compilation happens at MATCH CREATION, before the sim runs, so it MAY reject
//     invalid/unsupported content by throwing `RulesetError`. `step` itself stays
//     total.
//   • The COMPILED SURFACE is frozen so a retained ruleset can't diverge from its
//     digest at runtime. M2-S2 moves `countdownTicks`/`waveClearBonus` from
//     `CompiledBalance` onto each `CompiledWave` (v2's per-wave home) and replaces
//     the flat M1 `earlyCallBonus`/`schedule` with real divisors and a per-wave
//     `waves[]` schedule; `CompiledCreep` gains the preview-facing `armor`/
//     `immunities` axes. `creepByKind` → `creepById`, and the compiled tower/
//     schedule `kind` → `id`/`creepId` (a catalog id is an open string, not a
//     closed union member) are M2-S1's renames, unchanged here. M2-S3 replaces
//     the single `CompiledTower` field with `towers[]`/`towerById` (a real
//     catalog), deletes flat `damage` for an authored-order `effects: CompiledEffect[]`
//     (direct/slow), and moves `slowFloorNum`/`slowFloorDen` onto `CompiledBalance`.
//
// The module graph is one-way: `ruleset-shared.ts` (the leaf: `RulesetError`,
// `canonicalImmunities`, `SIM_VERSION`) ← {`ruleset-schema.ts`, `capability.ts`} ←
// this module — no two-way cycles. `RulesetError` is re-exported below so every
// existing `import { RulesetError } from './ruleset'` site (and the barrel) stays
// valid. `SIM_VERSION` is single-sourced on the leaf (M2-S2; S1 deferred this) so
// this module and `index.ts`'s public re-export can never drift apart.

import { canonicalJson, sha256Hex } from '@wynding/engine';
import type {
  CreepDef,
  EffectDef,
  Ruleset,
  RulesetBoard,
  TowerDef,
  TowerTargetDomain,
} from '@wynding/types';
import { loadBoard, type BoardContext } from './context';
import { RulesetError, canonicalImmunities, effectiveSpeedFp, SIM_VERSION } from './ruleset-shared';
import { validateRulesetShape } from './ruleset-schema';
import { DIAG_LEN } from './movement';
import { capabilityProfile, type CapabilityProfile } from './capability';
import { MAX_TOWERS } from './tower';

export { RulesetError } from './ruleset-shared';

/** One scheduled spawn: `offsetTicks` TICKS AFTER ITS WAVE'S LAUNCH, a creep of
 *  catalog `creepId`. (Renamed from v1's `kind` — catalog ids are open strings
 *  now, decision 4.) */
export interface ScheduledSpawn {
  readonly offsetTicks: number;
  readonly creepId: string;
}

/** One compiled board wave: the countdown/clear-bonus pair plus its fully
 *  pre-expanded, stable-sorted spawn timeline and the preview-facing aggregate.
 *
 *  `spawns` pre-expands every entry's stream (first spawn at `offsetTicks`, then
 *  every `spacingTicks`, `count` times) and stable-sorts the whole wave's spawns by
 *  `(offsetTicks, entryRow)` — the concurrent-stream interleave runs ONCE at
 *  compile time, so the sim only ever drains a cursor over pinned data, never
 *  runtime-interleaves streams itself (G7).
 *
 *  `entriesSummary` aggregates `spawns` back down to one row per creep id, in
 *  first-ARRIVAL order over the sorted spawn timeline (an offset can make a later
 *  table row arrive first) — the authoritative source for the wave preview (a
 *  duplicate-creepId entry, or several entries sharing a creepId, still shows one
 *  summed count). */
export interface CompiledWave {
  readonly countdownTicks: number;
  readonly clearBonus: number;
  readonly spawns: readonly ScheduledSpawn[];
  readonly entriesSummary: readonly { readonly creepId: string; readonly count: number }[];
}

/** Sim-owned compile-time projection of `BalanceConstants` — the v1 field set,
 *  with `countdownTicks`/`waveClearBonus` now PER-WAVE (`CompiledWave`, not flat
 *  here — v2 moved them to the wave schedule) and the flat `earlyCallBonus`
 *  replaced by the real divisor the wave phase reads at launch time.
 *  `slowFloorNum`/`slowFloorDen` (M2-S3) compile straight through from the
 *  validated bundle — the ratio `effectiveSpeedFp` (ruleset-shared.ts) floors a
 *  slowed creep's speed against, shared verbatim by the bound gate and movement. */
export interface CompiledBalance {
  readonly startingLives: number;
  readonly startingBounty: number;
  readonly refundNum: number;
  readonly refundDen: number;
  readonly slowFloorNum: number;
  readonly slowFloorDen: number;
  readonly earlyCallBountyDivisor: number;
}

/** Sim-owned compile-time projection of `ScoringConfig` — v1 field set plus the
 *  early-call SCORE credit divisor the wave phase reads at launch time. */
export interface CompiledScoring {
  readonly survivalMul: number;
  readonly starThresholds: readonly [number, number, number];
  readonly earlyCallScoreDivisor: number;
}

/** One compiled effect primitive a tower's fire snapshots per shot, in AUTHORED
 *  order (m2.md §Combat) — the fire-time application list `combat.ts` clones fresh
 *  per fire (impacts serialize into the world-hash, so a shared reference across
 *  fires would let one impact's runtime mutation bleed into another's). `aoe`
 *  (M2-S4a) is direct damage's AREA form — a separate compiled kind from `direct`
 *  (single-target) because ONLY it carries `radiusFp` and only its presence turns a
 *  tower's fire into a `blast` impact (`combat.ts`'s firing logic keys on it). Only
 *  the kinds the LIVE capability profile allows (`allowedEffectKinds`/
 *  `allowedDirectForms`) ever appear here; a future story widens this union
 *  alongside its own capability bump.
 *
 *  M2-S9: at sv13 kind `'aoe'` is reached by BOTH a `direct/aoe` effect AND a
 *  `burst/aoe` effect — burst-ness is the tower's FIRING DISCIPLINE (`attack.mode`),
 *  not a property of the damage payload, so it does not get its own compiled kind. A
 *  reader of a compiled bundle therefore cannot tell burst-ness from the effect
 *  alone; it lives on `CompiledTower.attack.mode`. */
export type CompiledEffect =
  | { readonly kind: 'direct'; readonly amount: number }
  | { readonly kind: 'aoe'; readonly amount: number; readonly radiusFp: number }
  | { readonly kind: 'slow'; readonly mulFp: number; readonly durationTicks: number }
  | {
      readonly kind: 'dot';
      readonly amount: number;
      readonly cadenceTicks: number;
      readonly durationTicks: number;
    }
  | { readonly kind: 'stun'; readonly chanceNum: number; readonly durationTicks: number }
  | { readonly kind: 'support'; readonly damageMulFp: number };

/** Sim-owned compile-time projection of `TowerDef` — `kind` renamed `id` (decision
 *  4). `effects` REPLACES v1's flat `damage` (G3): the fire-time snapshot needs the
 *  whole authored-order bundle (a parallel `damage` field would be a second source
 *  of truth), projected from the bundle's `effects` array in authored order.
 *  `domain` (from `attack.domain`) was projected ahead of the story that lets it
 *  vary; that story has LANDED (M2-S7, sv11), so it is now a live value — the sv11
 *  profile admits `'ground'`/`'air'`/`'both'`, the shipped catalog compiles `antiair`
 *  as `'air'` and `slow` as `'both'`, and `runCombat` reads it as a targeting filter
 *  on both the hold and acquire paths. Never assume it is `'ground'`. */
export interface CompiledTower {
  readonly id: string;
  readonly cost: number;
  readonly effects: readonly CompiledEffect[];
  /** Present IFF this bundle attacks, mirroring `TowerDef.attack` exactly (M2-S8,
   *  sv12). A `support` bundle carries no attack, and modelling that as an optional
   *  NESTED object rather than flat fields guarded with `?? 0` is deliberate: the
   *  `?? 0` form makes "a beacon has range 0 and fires every tick" representable and
   *  merely wrong at runtime, where the optional makes it a compile error at every
   *  one of the ~dozen sites that read an attack field. Same ruling as the Panel's
   *  omit-rather-than-zero rows.
   *
   *  M2-S9 splits it on `mode`. A BURST tower has an attack — that is where its
   *  **trigger range** lives — but no cadence, because it never fires twice. One
   *  optional `cadenceTicks?: number` would have invited `?? 0` again, the exact lie
   *  the S8 Panel ruling rejected; the union makes "a burst tower has a cadence"
   *  **unrepresentable**. Both variants carry `domain`/`rangeFp`/`travelTicks`, so
   *  every consumer of those is untouched — the churn is one fire-path read and one
   *  Panel row. */
  readonly attack?:
    | {
        readonly mode: 'cadenced';
        readonly domain: TowerTargetDomain;
        readonly rangeFp: number;
        readonly cadenceTicks: number;
        readonly travelTicks: number;
      }
    | {
        readonly mode: 'burst';
        readonly domain: TowerTargetDomain;
        readonly rangeFp: number;
        readonly travelTicks: number;
      };
  /** Present IFF this bundle carries a `support` effect (M2-S8, sv12) — hoisted out
   *  of `effects` so the aura walk (`support.ts`) can test one field rather than
   *  re-scanning the bundle per tower per combat phase. `ruleset-schema.ts` already
   *  enforces support-exclusivity, so `attack` and `support` are never both present. */
  readonly support?: { readonly damageMulFp: number };
}

/** Sim-owned compile-time projection of `CreepDef` — v1 field set, `kind`
 *  renamed `id`, plus the preview-facing axes the render VM joins on: `armor` and
 *  frozen `immunities` (both capability-gated to `0`/`[]` at sv7 — present on the
 *  compiled surface now so the preview text can read them without a schema import,
 *  ahead of the story that lets them vary). */
export interface CompiledCreep {
  readonly id: string;
  readonly hp: number;
  readonly speedFp: number;
  readonly bounty: number;
  readonly domain: 'ground' | 'air';
  readonly armor: number;
  readonly immunities: readonly ('slow' | 'stun')[];
  readonly leakCost: number;
  /** Omitted = no role, mirroring `normalizeForHash`'s role projection —
   *  projected only when present, never `role: undefined`. */
  readonly role?: 'boss';
}

/**
 * A validated, resolved ruleset ready for `step`. Opaque/branded: `assertRuleset`
 * rejects anything that isn't a genuine `compileRuleset` product, mirroring the
 * `assertConsistent(board)` totality posture at the sim boundary.
 */
export interface CompiledRuleset {
  readonly __brand: 'CompiledRuleset';
  readonly boardId: string;
  readonly board: BoardContext;
  readonly balance: CompiledBalance;
  readonly scoring: CompiledScoring;
  /** The full compiled tower catalog, in AUTHORED order (M2-S3 — replaces M1/M2-S1's
   *  single flat `tower`). */
  readonly towers: readonly CompiledTower[];
  /** Tower stat lookup by catalog id — a FROZEN null-prototype plain record (the
   *  `creepById` precedent), so a retained ruleset is genuinely immutable and a
   *  JSON `id: "__proto__"` can't escape the deep-freeze via the prototype chain. */
  readonly towerById: Readonly<Partial<Record<string, CompiledTower>>>;
  /** Creep stat lookup by id — a FROZEN plain record (not a Map, whose `set/delete`
   *  `Object.freeze` can't block), so a retained ruleset is genuinely immutable.
   *  Renamed from v1's `creepByKind` (decision 4/M2-S1 invariant 1). */
  readonly creepById: Readonly<Partial<Record<string, CompiledCreep>>>;
  /** The board's wave schedule, index order, each pre-compiled per `CompiledWave`. */
  readonly waves: readonly CompiledWave[];
  /** The content identity digest (`rulesetHash`). */
  readonly digest: string;
}

const validated = new WeakSet<CompiledRuleset>();

/** Recursively freeze plain objects/arrays so the compiled tuning is immutable at
 *  runtime — a caller can't mutate a retained ruleset and diverge a match from its
 *  fixed `digest`. Read-only at runtime already, so this only closes the tamper
 *  surface; typed-array/grid internals are left alone. */
function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o) && !ArrayBuffer.isView(o)) {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** Hard cap on total scheduled spawns — a bounded, anti-DoS ceiling on wave size. */
const MAX_SCHEDULED_SPAWNS = 10_000;

/** The absolute tick ceiling a match must terminate within. `compileRuleset` rejects a
 *  bundle whose baseline run (launch + spawn + slowest full traversal) can't reach a
 *  terminal state within it, and the replay validator re-simulates to exactly this
 *  ceiling — so replay imports THIS constant (rather than duplicating the literal) and
 *  the two can never drift into a compiles-but-times-out gap. */
export const MAX_MATCH_TICKS = 36_000;

/**
 * Compile-time ceiling on AoE scan-work (M2-S4a, step 7 — Codex R1-4/R1-5): per-tick
 * combat cost is `residentImpacts + dueBlasts × liveCreeps` (only impacts DUE this
 * tick scan creeps; resident future impacts are queue traversal only). A bundle
 * whose CATALOG contains any `aoe` tower is rejected here if its worst-legal
 * workload — `MAX_TOWERS × totalScheduledSpawns` (every placed tower could be a
 * blast tower, due the same tick, scanning every creep the bundle could ever have
 * concurrently alive, bounded above by the total spawn count) — exceeds this many
 * distance tests per tick. `2_000_000` admits `MAX_TOWERS` (1000) × 2,000 scheduled
 * spawns; the shipped bundle schedules 34, the stress scene (S4b) ~304. A REAL
 * compile-time REJECTION (never a runtime truncation, decision 6): truncating a
 * blast mid-scan would silently drop damage, the corner-cut this project forbids.
 * `story-aoe.test.ts` pins this derivation (the formula, the accept/reject boundary at
 * 2,000/2,001 spawns, and an aoe-gated negative control) so the constant cannot silently
 * drift; `ruleset.test.ts` only redirects readers there. FROZEN AT S4A
 * (risk log): S4b may report evidence about the order of magnitude but may not move
 * it — changing it changes which bundles compile, a behavior change requiring its
 * own `simVersion` bump. */
export const AOE_SCAN_CEILING = 2_000_000;

// `canonicalImmunities` is imported from `ruleset-schema.ts` (one shared
// implementation — the canonical order is a `rulesetHash` input, so a second copy
// drifting would silently re-bucket content identity). It is re-applied in
// `normalizeForHash` because `rulesetDigest`/`compileRuleset` must not assume every
// caller went through `parseRulesetJson` first (a hand-built fixture can bypass it).

/** Explicit per-kind projection of an effect for hashing — the allowlist pattern all
 *  the way down. A spread (`{ ...e }`) would let a hand-built bundle's unknown effect
 *  property leak into the digest (production bundles are strict-validated first, but
 *  `rulesetDigest` must uphold "equal in every supported field ⇒ equal digest" for
 *  every caller). */
function projectEffect(e: EffectDef): Record<string, unknown> {
  switch (e.kind) {
    case 'direct':
    case 'burst':
      return e.form === 'aoe'
        ? { kind: e.kind, damage: e.damage, form: e.form, radiusFp: e.radiusFp }
        : { kind: e.kind, damage: e.damage, form: e.form };
    case 'slow':
      return { kind: e.kind, mulFp: e.mulFp, durationTicks: e.durationTicks };
    case 'stun':
      return { kind: e.kind, chanceNum: e.chanceNum, durationTicks: e.durationTicks };
    case 'dot':
      return {
        kind: e.kind,
        damagePerTick: e.damagePerTick,
        cadenceTicks: e.cadenceTicks,
        durationTicks: e.durationTicks,
      };
    case 'support':
      return { kind: e.kind, damageMulFp: e.damageMulFp };
  }
  // Exhaustive over EffectDef at compile time; a hand-built bundle can still carry a
  // non-schema kind at runtime — fail loudly (canonicalJson's malformed-field
  // philosophy; compileRuleset funnels this into its RulesetError boundary).
  throw new TypeError(
    `normalizeForHash: unknown effect kind '${String((e as { kind?: unknown }).kind)}'`,
  );
}

/**
 * Normalize the bundle for hashing by projecting EVERY known, sim-affecting schema
 * field (ADR 0007 §3 + `ruleset-format.md`). Building the canonical value from an
 * explicit field list — rather than copy-and-delete — means an unknown metadata
 * property can never leak into `rulesetHash` (two bundles equal in every supported
 * field MUST share a digest). v2 carries NO presentation-only fields (board `name`
 * is deleted from the schema entirely — decision 5), so every projected field here
 * is sim-affecting. `role` is projected only when present (never `role: undefined`).
 * `offsetTicks`/immunity order are always canonical post-`validateRulesetShape`, but
 * re-applied defensively here too, since a hand-built bundle can reach this function
 * (via `rulesetDigest`/`compileRuleset`) without going through `parseRulesetJson`.
 * Values are read straight from the bundle, so `canonicalJson`'s non-finite/
 * non-plain-object guards still fire on a malformed field.
 */
function normalizeForHash(bundle: Ruleset): unknown {
  return {
    formatVersion: bundle.formatVersion,
    rulesetId: bundle.rulesetId,
    version: bundle.version,
    creepCatalog: bundle.creepCatalog.map((c) => {
      const proj: Record<string, unknown> = {
        id: c.id,
        hp: c.hp,
        speedFp: c.speedFp,
        armor: c.armor,
        domain: c.domain,
        immunities: canonicalImmunities(c.immunities),
        leakCost: c.leakCost,
        bounty: c.bounty,
      };
      if (c.role !== undefined) proj.role = c.role; // omitted key, never `role: undefined`
      return proj;
    }),
    towerCatalog: bundle.towerCatalog.map((t) => {
      const proj: Record<string, unknown> = {
        id: t.id,
        cost: t.cost,
        effects: t.effects.map(projectEffect),
      };
      if (t.attack !== undefined) {
        const attack: Record<string, unknown> = {
          domain: t.attack.domain,
          rangeFp: t.attack.rangeFp,
          travelTicks: t.attack.travelTicks,
        };
        if (t.attack.cadenceTicks !== undefined) attack.cadenceTicks = t.attack.cadenceTicks;
        proj.attack = attack;
      }
      return proj;
    }),
    balance: {
      startingLives: bundle.balance.startingLives,
      startingBounty: bundle.balance.startingBounty,
      refundNum: bundle.balance.refundNum,
      refundDen: bundle.balance.refundDen,
      slowFloorNum: bundle.balance.slowFloorNum,
      slowFloorDen: bundle.balance.slowFloorDen,
      earlyCallBountyDivisor: bundle.balance.earlyCallBountyDivisor,
    },
    scoring: {
      survivalMul: bundle.scoring.survivalMul,
      starThresholds: bundle.scoring.starThresholds,
      earlyCallScoreDivisor: bundle.scoring.earlyCallScoreDivisor,
    },
    boards: bundle.boards.map((b) => ({
      id: b.id,
      widthTiles: b.widthTiles,
      heightTiles: b.heightTiles,
      entrance: { col: b.entrance.col, row: b.entrance.row },
      exit: { col: b.exit.col, row: b.exit.row },
      waves: b.waves.map((w) => ({
        index: w.index,
        countdownTicks: w.countdownTicks,
        clearBonus: w.clearBonus,
        entries: w.entries.map((e) => ({
          creepId: e.creepId,
          count: e.count,
          spacingTicks: e.spacingTicks,
          offsetTicks: e.offsetTicks ?? 0,
        })),
      })),
    })),
  };
}

/**
 * The ruleset content identity (`rulesetHash`): SHA-256 over the RFC 8785 canonical
 * form of the normalized bundle. Collision-resistant (ADR 0007 §3) — NOT the 32-bit
 * world-hash. One implementation shared by replay creation and validation. Runs over
 * ANY structurally-valid bundle (not gated by the capability profile), so a
 * full-schema fixture exercising kinds this sim build doesn't yet simulate can still
 * be hashed and hash-tested.
 */
export function rulesetDigest(bundle: Ruleset): string {
  return sha256Hex(canonicalJson(normalizeForHash(bundle)));
}

/** Gate every capability dimension that is NOT scoped to a single board (catalog
 *  cardinality, creep/tower per-entry domains, armor, immunities, roles, effect
 *  kinds/forms, leak-cost ceiling, the early-call divisors). Board/wave-scoped
 *  dimensions (`maxWavesPerBoard`, `maxEntriesPerWave`, `maxOffsetTicks`,
 *  `maxClearBonus`, and — M2-S7 P1 — the air-domain size and axis-alignment gates)
 *  are checked separately, only against the board actually being compiled —
 *  mirroring v1's board-scoped wave validation. The size gate's TRIGGER is
 *  catalog-wide (any air creep at all) even though the OBJECT it bounds is one
 *  board's dimensions; see `checkCapabilityBoard`'s own comment for why it still
 *  lives there. */
function checkCapabilityGlobal(bundle: Ruleset, profile: CapabilityProfile): void {
  const v = SIM_VERSION;
  if (bundle.towerCatalog.length > profile.maxTowerCatalogSize) {
    throw new RulesetError(
      `towerCatalog size ${bundle.towerCatalog.length} exceeds ${profile.maxTowerCatalogSize} at simVersion ${v}`,
    );
  }
  for (const creep of bundle.creepCatalog) {
    if (!profile.allowedCreepDomains.includes(creep.domain)) {
      throw new RulesetError(`creep domain '${creep.domain}' unsupported at simVersion ${v}`);
    }
    if (creep.armor > profile.maxArmor) {
      throw new RulesetError(
        `creep '${creep.id}' armor ${creep.armor} exceeds ${profile.maxArmor} at simVersion ${v}`,
      );
    }
    for (const immunity of creep.immunities) {
      if (!profile.allowedImmunities.includes(immunity)) {
        throw new RulesetError(`creep immunity '${immunity}' unsupported at simVersion ${v}`);
      }
    }
    if (creep.role !== undefined && !profile.allowedRoles.includes(creep.role)) {
      throw new RulesetError(`creep role '${creep.role}' unsupported at simVersion ${v}`);
    }
    // A POLICY ceiling, not a derived safety rail (M2-S10) — see `maxLeakCost`'s own
    // doc comment in `capability.ts`.
    if (creep.leakCost > profile.maxLeakCost) {
      throw new RulesetError(
        `creep '${creep.id}' leakCost ${creep.leakCost} exceeds ${profile.maxLeakCost} at simVersion ${v}`,
      );
    }
  }
  for (const tower of bundle.towerCatalog) {
    if (tower.effects.length > profile.maxEffectsPerBundle) {
      throw new RulesetError(
        `tower '${tower.id}' has ${tower.effects.length} effects, exceeds ${profile.maxEffectsPerBundle} at simVersion ${v}`,
      );
    }
    for (const effect of tower.effects) {
      if (!profile.allowedEffectKinds.includes(effect.kind)) {
        throw new RulesetError(`effect kind '${effect.kind}' unsupported at simVersion ${v}`);
      }
      if (effect.kind === 'direct' && !profile.allowedDirectForms.includes(effect.form)) {
        throw new RulesetError(`effect form '${effect.form}' unsupported at simVersion ${v}`);
      }
      // M2-S9: burst forms get their OWN allow-list, split out of `allowedDirectForms`.
      // Before this split the two kinds shared `['single','aoe']`, so the instant
      // `'burst'` joined `allowedEffectKinds` a `burst/single` bundle would have
      // compiled into a live untested mechanic and `allowedBurstForms` would have been
      // dead code — the exact failure this file's ceilings exist to prevent.
      if (effect.kind === 'burst' && !profile.allowedBurstForms.includes(effect.form)) {
        throw new RulesetError(`burst effect form '${effect.form}' unsupported at simVersion ${v}`);
      }
      // M2-S9: a burst tower fires exactly once, so the ratio gate below — whose whole
      // rationale is bounding live records per SOURCE by how many shots land inside a
      // duration window — has no derived bound to check against. Before this clause the
      // combination was still rejected, but ACCIDENTALLY: `cadenceTicks ?? 0` made the
      // ceiling 0 and the message named "its 0-tick attack cadence", a sentence that is
      // simply false. Reject deliberately, and for the real reason. Same posture as the
      // aoe+dot rejection below: unvalidated content is rejected LOUDLY at compile time
      // until a story needs it and re-derives the bound.
      if (effect.kind === 'dot' && tower.effects.some((e) => e.kind === 'burst')) {
        throw new RulesetError(
          `tower '${tower.id}' combines a burst effect with a dot effect, unsupported at simVersion ${v}`,
        );
      }
      // maxDotDurationTicks bounds the tick-scheduling operand the schema's own
      // `durationTicks >= cadenceTicks` rule doesn't: together the two rules bound
      // both a DoT's cadence and its duration, so tick scheduling can never
      // saturate at any bundle that compiles.
      // An `aoe` direct effect plus a `dot` on ONE tower is rejected at sv9 (Codex P2,
      // PR #78). The sim could simulate it, but `MAX_DOT_RECORDS` was sized on the
      // single-target application model — about `durationTicks / fire cadence` records
      // per tower, since each shot lands on one creep. A blast applies the DoT to EVERY
      // member it catches, so ~41 such towers over 100 creeps in radius needs 4,100
      // distinct (targetId, sourceId) records and silently starts dropping applications
      // at a rail that compiled clean. No tower in M2's catalog combines the two, so
      // rather than inflate a capability-shaped constant for content that does not
      // exist, reject the combination LOUDLY at compile time until a story needs it and
      // re-derives the bound. Same posture as S4a's form-uniform/radius-uniform gates,
      // which exist to stop exactly this kind of unvalidated composition.
      // Bound how many live records ONE source can hold, by tying a DoT's duration to
      // its tower's own fire cadence (Codex P2, PR #78). `maxDotDurationTicks` bounds
      // the absolute number but not the RATIO, and the ratio is what sets record count:
      // ~`durationTicks / fire cadence` shots land inside a duration window, each able
      // to seed a different creep. At the profile's 100,000 ticks against a 2-tick
      // cadence that is ~50,000 records from a single tower, an order of magnitude past
      // `MAX_DOT_RECORDS` — reachable by a bundle that compiles clean.
      if (effect.kind === 'dot' && tower.attack !== undefined) {
        const fireCadence = tower.attack.cadenceTicks ?? 0;
        const ratioCeiling = profile.maxDotDurationCadenceRatio * fireCadence;
        // `?? 0` keeps this total on a pre-schema-validation shape; a 0 cadence makes the
        // ceiling 0, so any positive duration is rejected — the safe direction. M2-S9's
        // explicit burst+dot rejection above now covers the one case (a burst bundle,
        // which carries no `cadenceTicks`) that used to make this ceiling of 0 fire.
        if (effect.durationTicks > ratioCeiling) {
          throw new RulesetError(
            `tower '${tower.id}' dot durationTicks ${effect.durationTicks} exceeds ${ratioCeiling} ` +
              `(${profile.maxDotDurationCadenceRatio}× its ${fireCadence}-tick attack cadence) at simVersion ${v}`,
          );
        }
      }
      // Scoped to `direct` only, deliberately not widened to `burst` (M2-S9): a
      // burst+dot bundle is already rejected WHOLESALE by the clause above, so a
      // `burst/aoe` + `dot` case can never reach this check — widening it here would
      // be unreachable.
      if (
        effect.kind === 'dot' &&
        tower.effects.some((e) => e.kind === 'direct' && e.form === 'aoe')
      ) {
        throw new RulesetError(
          `tower '${tower.id}' combines an aoe direct effect with a dot effect, unsupported at simVersion ${v}`,
        );
      }
      if (effect.kind === 'dot' && effect.durationTicks > profile.maxDotDurationTicks) {
        throw new RulesetError(
          `tower '${tower.id}' dot durationTicks ${effect.durationTicks} exceeds ${profile.maxDotDurationTicks} at simVersion ${v}`,
        );
      }
      // M2-S8: the profile's support ceiling needs an ENFORCEMENT SITE, or it is dead
      // code — the v2 schema admits `damageMulFp` up to 1e6, so without this a
      // schema-legal ×3906 beacon would compile. Value ceilings live here alongside
      // `maxArmor`, `maxAoeRadiusFp` and the dot ceilings; the field and its check
      // land together or not at all.
      if (effect.kind === 'support' && effect.damageMulFp > profile.maxSupportDamageMulFp) {
        throw new RulesetError(
          `tower '${tower.id}' support damageMulFp ${effect.damageMulFp} exceeds ${profile.maxSupportDamageMulFp} at simVersion ${v}`,
        );
      }
    }
    if (tower.attack !== undefined && !profile.allowedTowerDomains.includes(tower.attack.domain)) {
      throw new RulesetError(
        `tower attack domain '${tower.attack.domain}' unsupported at simVersion ${v}`,
      );
    }
    // M2-S9: the enforcement site for `maxBurstTravelTicks`. A CADENCED tower's
    // `travelTicks` is bounded by the schema's own `travelTicks < cadenceTicks` rule —
    // which is what makes `MAX_IN_FLIGHT_IMPACTS` sizing hold (≤1 impact in flight per
    // live tower). A burst bundle has no cadence, so that rule never runs and nothing
    // else bounds the field; worse, a CONSUMED mine keeps its discharge resident while
    // freeing its tower slot, so the residency no longer tracks live towers at all. See
    // `capability.ts`'s own doc for the full derivation. Without this clause the profile
    // field is dead code and a schema-legal `travelTicks: 1_000_000` burst tower compiles.
    if (
      tower.attack !== undefined &&
      tower.effects.some((e) => e.kind === 'burst') &&
      tower.attack.travelTicks > profile.maxBurstTravelTicks
    ) {
      throw new RulesetError(
        `tower '${tower.id}' burst travelTicks ${tower.attack.travelTicks} exceeds ${profile.maxBurstTravelTicks} at simVersion ${v}`,
      );
    }
    // FORM-UNIFORM (sv8, "one-shot-one-shape"): a tower's damage-carrying effects
    // must be ALL single-target or ALL aoe, never mixed — one fire produces exactly
    // one impact SHAPE (`combat.ts` builds either a `targeted` or a `blast` impact
    // per tower, never both). Originally scoped to `kind === 'direct'` only, on the
    // claim that "`burst`'s own form isn't reachable at sv8 — `allowedEffectKinds`
    // already excludes it". That tripwire stops being true at sv13: `allowedEffectKinds`
    // now admits `burst`, so a bundle of `direct/single` + `burst/aoe` used to slip
    // through with `directForms.size === 1` — then `blastRadiusOf` found the aoe and
    // built a blast, silently applying the `single` effect to every creep in the
    // radius. M2-S9 widens the set to union `direct` AND `burst` forms, so one fire
    // still produces exactly one impact shape regardless of which kind carries it.
    const damageForms = new Set(
      tower.effects.filter((e) => e.kind === 'direct' || e.kind === 'burst').map((e) => e.form),
    );
    if (damageForms.size > 1) {
      throw new RulesetError(
        `tower '${tower.id}' mixes damage effect forms (single + aoe) across its direct/burst effects — must be form-uniform at simVersion ${v}`,
      );
    }
    // RADIUS-UNIFORM: every `aoe` effect ON ONE TOWER (QC round-1 #10 — a prior
    // version of this comment said "one bundle", which wrongly implied a CATALOG-
    // WIDE radius; the check below is scoped to `tower.effects`, per-tower, so
    // `frost-splash` and `splash` can freely carry different radii) must share
    // exactly one radius, so the blast's radius is unambiguous (`frost-splash`,
    // S10, rides its `slow` on the SAME blast as its `aoe` damage — there must be
    // exactly one radius to draw that tower's blast from). Also enforces the
    // profile's own radius ceiling per aoe effect (`maxAoeRadiusFp`). Originally
    // scoped to `direct/aoe` only — before the M2-S9 widening, a `burst/aoe`
    // effect's `radiusFp` was never checked against the profile ceiling AT ALL, so a
    // bundle could author `radiusFp: 1_000_000` (≈3906 tiles) and compile clean.
    // Widened to cover `direct/aoe` AND `burst/aoe`, so both the radius-uniform set
    // and the per-effect ceiling loop below now cover burst.
    const aoeEffects = tower.effects.filter(
      (e): e is Extract<EffectDef, { kind: 'direct' | 'burst'; form: 'aoe' }> =>
        (e.kind === 'direct' || e.kind === 'burst') && e.form === 'aoe',
    );
    const aoeRadii = new Set(aoeEffects.map((e) => e.radiusFp));
    if (aoeRadii.size > 1) {
      throw new RulesetError(
        `tower '${tower.id}' has multiple aoe radii — must share one radius at simVersion ${v}`,
      );
    }
    for (const e of aoeEffects) {
      if (e.radiusFp > profile.maxAoeRadiusFp) {
        throw new RulesetError(
          `tower '${tower.id}' aoe radiusFp ${e.radiusFp} exceeds ${profile.maxAoeRadiusFp} at simVersion ${v}`,
        );
      }
    }
  }
  if (bundle.balance.earlyCallBountyDivisor > profile.maxEarlyCallBountyDivisor) {
    throw new RulesetError(
      `earlyCallBountyDivisor ${bundle.balance.earlyCallBountyDivisor} exceeds ${profile.maxEarlyCallBountyDivisor} at simVersion ${v}`,
    );
  }
  if (bundle.scoring.earlyCallScoreDivisor > profile.maxEarlyCallScoreDivisor) {
    throw new RulesetError(
      `earlyCallScoreDivisor ${bundle.scoring.earlyCallScoreDivisor} exceeds ${profile.maxEarlyCallScoreDivisor} at simVersion ${v}`,
    );
  }
}

/** Ceiling on a board's `widthTiles`/`heightTiles` (M2-S7 P1), enforced only when
 *  the CATALOG contains an air creep at all — see `checkCapabilityBoard`'s air-gate
 *  block for why that scope is deliberately wider than the axis-alignment gate
 *  beside it. `CELL_CAP = 1 << 20` (board.ts) bounds cell COUNT, not per-side
 *  dimensions — a legal 1,048,576 × 1 board is otherwise admissible and drives
 *  `dx_fp²` (the air metric's `isqrt` operand, combat.ts) to ≈2⁵⁶, past the safe-
 *  integer range. At ≤1024 cells per side, `dx_fp ≤ 2¹⁸`, so `dx_fp² + dy_fp² ≤
 *  2³⁷` — safe with enormous margin, on ANY admissible board rather than only the
 *  one M2 ships. */
export const MAX_AIR_BOARD_SIDE_TILES = 1024;

/** Gate the board/wave-scoped capability dimensions against the board actually
 *  being compiled (v1 only ever validated the chosen board's wave, not every
 *  board in the catalog). `creepCatalog` is threaded through (M2-S7 P1) so the two
 *  air-domain board gates below can resolve a wave entry's `creepId` to its domain —
 *  the same lookup shape `checkCapabilityGlobal` already uses elsewhere in this
 *  file, not a new one. */
function checkCapabilityBoard(
  board: RulesetBoard,
  profile: CapabilityProfile,
  creepCatalog: readonly CreepDef[],
): void {
  const v = SIM_VERSION;
  if (board.waves.length > profile.maxWavesPerBoard) {
    throw new RulesetError(
      `board '${board.id}' has ${board.waves.length} waves, exceeds ${profile.maxWavesPerBoard} at simVersion ${v}`,
    );
  }
  for (const wave of board.waves) {
    if (wave.entries.length > profile.maxEntriesPerWave) {
      throw new RulesetError(
        `board '${board.id}' wave ${wave.index} has ${wave.entries.length} entries, exceeds ${profile.maxEntriesPerWave} at simVersion ${v}`,
      );
    }
    if (wave.clearBonus > profile.maxClearBonus) {
      throw new RulesetError(
        `board '${board.id}' wave ${wave.index} clearBonus ${wave.clearBonus} exceeds ${profile.maxClearBonus} at simVersion ${v}`,
      );
    }
    for (const entry of wave.entries) {
      const offset = entry.offsetTicks ?? 0;
      if (offset > profile.maxOffsetTicks) {
        throw new RulesetError(
          `board '${board.id}' wave ${wave.index} entry offsetTicks ${offset} exceeds ${profile.maxOffsetTicks} at simVersion ${v}`,
        );
      }
    }
  }

  // SIZE CEILING (M2-S7 P1) — triggered by the CATALOG containing an air creep AT
  // ALL, scheduled or not, deliberately wider than the axis-alignment gate below.
  // It protects safe-integer ARITHMETIC (`MAX_AIR_BOARD_SIDE_TILES`'s doc comment),
  // and `coerceSoa` accepts any catalog-resolved `creepId` — so a forged or restored
  // air row on a large ground-only-scheduled board would reach the air metric with
  // no scheduled flyer anywhere on this board, or any board, to have tripped a
  // narrower gate. Checked HERE, against the one board actually being compiled,
  // because a match only ever compiles one board (`compileRuleset`'s `boardId`) —
  // there is no separate "whole catalog" object to bound width/height against.
  if (creepCatalog.some((c) => c.domain === 'air')) {
    if (board.widthTiles > MAX_AIR_BOARD_SIDE_TILES) {
      throw new RulesetError(
        `board '${board.id}' widthTiles ${board.widthTiles} exceeds ${MAX_AIR_BOARD_SIDE_TILES} at simVersion ${v} (the catalog contains an air creep)`,
      );
    }
    if (board.heightTiles > MAX_AIR_BOARD_SIDE_TILES) {
      throw new RulesetError(
        `board '${board.id}' heightTiles ${board.heightTiles} exceeds ${MAX_AIR_BOARD_SIDE_TILES} at simVersion ${v} (the catalog contains an air creep)`,
      );
    }
  }

  // AXIS-ALIGNMENT (M2-S7 P1) — triggered ONLY when THIS board's own wave schedule
  // references an air-domain creep, deliberately NARROWER than the size gate above:
  // it protects measurement FIDELITY (the straight-line metric movement.ts/
  // combat.ts assume for a flyer), which only genuinely scheduled flight can reach
  // — a catalog-wide test here would reject an unrelated ground-only board just
  // because some OTHER board in the same catalog schedules a flyer. Fidelity has no
  // meaning under forged state (the size gate's concern); overflow does — the two
  // gates cannot share a scope. An entry referencing an unresolved `creepId` is NOT
  // treated as air (same `?? 'ground'`-shaped fallback as every other totality rail
  // in the sim) — a schema-valid-but-unknown id is rejected later, by wave
  // compilation, not here.
  const boardFliesAir = board.waves.some((wave) =>
    wave.entries.some(
      (entry) => creepCatalog.find((c) => c.id === entry.creepId)?.domain === 'air',
    ),
  );
  if (boardFliesAir) {
    const axisAligned =
      board.entrance.col === board.exit.col || board.entrance.row === board.exit.row;
    if (!axisAligned) {
      throw new RulesetError(
        `board '${board.id}' entrance (${board.entrance.col},${board.entrance.row}) -> exit ` +
          `(${board.exit.col},${board.exit.row}) is not axis-aligned at simVersion ${v} ` +
          `(its wave schedule flies an air creep)`,
      );
    }
  }
}

/**
 * Compile + validate a bundle for a given board into a branded `CompiledRuleset`.
 * (1) `validateRulesetShape` — ALL shape/structural/cross-field validation;
 * (2) the capability profile — kinds/cardinalities/values this sim build actually
 * simulates; (3) board playability + schedule compilation; (4) the digest.
 * Throws `RulesetError` on any violation, so invalid or unsupported content is
 * rejected before a match ever starts.
 */
export function compileRuleset(bundle: Ruleset, boardId: string): CompiledRuleset {
  const normalized = validateRulesetShape(bundle);
  const profile = capabilityProfile(SIM_VERSION);
  checkCapabilityGlobal(normalized, profile);

  const board = normalized.boards.find((b) => b.id === boardId);
  if (board === undefined) throw new RulesetError(`unknown boardId '${boardId}'`);
  checkCapabilityBoard(board, profile, normalized.creepCatalog);

  // Build the grid + exit distance field; loadBoard rejects an unplayable board. Its
  // failure (a GridError — non-border opening, bad dims, over-cap cells) is re-thrown
  // as a RulesetError so ALL malformed content surfaces through one type and the
  // replay validator can turn it into a clean rejection rather than a 500.
  let boardCtx: BoardContext;
  try {
    boardCtx = loadBoard({
      widthTiles: board.widthTiles,
      heightTiles: board.heightTiles,
      entrance: board.entrance,
      exit: board.exit,
    });
  } catch (err) {
    throw new RulesetError(`unplayable board '${boardId}': ${(err as Error).message}`);
  }

  // Null-prototype record: a plain `{}` would let a JSON `id: "__proto__"` set the
  // object's PROTOTYPE (not an own key) — escaping the deep-freeze — and would make
  // inherited names ("toString", "hasOwnProperty") pass an unknown-id check.
  // `Object.create(null)` has no `__proto__` accessor and inherits nothing.
  const creepById: Partial<Record<string, CompiledCreep>> = Object.create(null) as Partial<
    Record<string, CompiledCreep>
  >;
  for (const c of normalized.creepCatalog) {
    creepById[c.id] = {
      id: c.id,
      hp: c.hp,
      speedFp: c.speedFp,
      bounty: c.bounty,
      domain: c.domain,
      armor: c.armor,
      immunities: c.immunities,
      leakCost: c.leakCost,
      // Omitted key, never `role: undefined` (mirrors `normalizeForHash`'s role projection).
      ...(c.role !== undefined ? { role: c.role } : {}),
    };
  }

  // Compile EVERY catalog tower (sv7: `maxTowerCatalogSize` widens to the schema cap
  // 64 — step 3) — the same per-tower guards M1/sv6 ran on its lone entry (attack
  // present, cadence present, ≥ 1 direct effect) now run over each one. M2-S4a widens
  // "direct effect" from single-target-only to EITHER form (single or aoe) — `splash`
  // has no single-target effect and would be rejected by the old single-only guard.
  function compileEffect(e: EffectDef, towerId: string): CompiledEffect {
    if (e.kind === 'direct' && e.form === 'single') return { kind: 'direct', amount: e.damage };
    if (e.kind === 'direct' && e.form === 'aoe') {
      return { kind: 'aoe', amount: e.damage, radiusFp: e.radiusFp };
    }
    // M2-S9: burst-ness is the tower's firing DISCIPLINE, not a property of the
    // damage payload, so `CompiledEffect` gains NO new variant — this collapses
    // `burst/aoe` into the SAME compiled `'aoe'` kind `direct/aoe` already produces,
    // the identical transformation two lines up. The dividend: `blastRadiusOf`,
    // `snapshotEffects`, the beacon buff, `BLAST_RADIUS_FP` and the ghost's blast
    // preview all work on a burst tower unchanged. The `burst/single` arm below is
    // UNREACHABLE under sv13's `allowedBurstForms: ['aoe']` — kept only so this
    // function stays total, exactly like the defensive throw at its bottom.
    if (e.kind === 'burst' && e.form === 'aoe') {
      return { kind: 'aoe', amount: e.damage, radiusFp: e.radiusFp };
    }
    if (e.kind === 'burst' && e.form === 'single') return { kind: 'direct', amount: e.damage };
    if (e.kind === 'slow') return { kind: 'slow', mulFp: e.mulFp, durationTicks: e.durationTicks };
    if (e.kind === 'dot') {
      return {
        kind: 'dot',
        amount: e.damagePerTick,
        cadenceTicks: e.cadenceTicks,
        durationTicks: e.durationTicks,
      };
    }
    if (e.kind === 'stun') {
      return { kind: 'stun', chanceNum: e.chanceNum, durationTicks: e.durationTicks };
    }
    if (e.kind === 'support') return { kind: 'support', damageMulFp: e.damageMulFp };
    // Unreachable at the LIVE profile, whatever its version: `allowedEffectKinds`/
    // `allowedDirectForms` already rejected anything else in `checkCapabilityGlobal`,
    // above. Defensive, not load-bearing. Deliberately not naming a version — this line
    // said "sv10" two bumps after it stopped being true, which is what a version number
    // in a sentence that does not depend on the version buys you.
    throw new RulesetError(
      `tower '${towerId}' has an effect this sim build cannot compile at simVersion ${SIM_VERSION}`,
    );
  }
  const towers: CompiledTower[] = normalized.towerCatalog.map((towerDef: TowerDef) => {
    // M2-S8 (sv12): the three attack-shaped guards below hold for ATTACKING bundles
    // only. A `support` bundle legitimately carries no direct effect, no attack, and
    // therefore no cadence — `ruleset-schema.ts` already enforces that a support
    // effect is EXCLUSIVE (a bundle is support or it attacks, never both), so this
    // one predicate splits the catalog cleanly and no bundle escapes both branches.
    const supportEffect = towerDef.effects.find(
      (e): e is Extract<EffectDef, { kind: 'support' }> => e.kind === 'support',
    );
    if (supportEffect !== undefined) {
      return {
        id: towerDef.id,
        cost: towerDef.cost,
        effects: towerDef.effects.map((e) => compileEffect(e, towerDef.id)),
        support: { damageMulFp: supportEffect.damageMulFp },
      };
    }
    // M2-S9: `burst` is a damage payload too, so a burst-only bundle (the `mine`)
    // legitimately carries no `direct` effect. Widened rather than exempted: the
    // invariant this guard defends is "an attacking bundle deals damage", and burst
    // satisfies it. Miss this and the shipped catalog stops compiling — a runtime
    // RulesetError taking registry, parity and app boot with it.
    const burstEffect = towerDef.effects.find(
      (e): e is Extract<EffectDef, { kind: 'burst' }> => e.kind === 'burst',
    );
    const damageEffect =
      towerDef.effects.find(
        (e): e is Extract<EffectDef, { kind: 'direct' }> => e.kind === 'direct',
      ) ?? burstEffect;
    if (damageEffect === undefined) {
      throw new RulesetError(
        `tower '${towerDef.id}' must have a direct or burst effect (single or aoe) at simVersion ${SIM_VERSION}`,
      );
    }
    // NOT exempted for burst, deliberately: a burst bundle DOES carry an `attack` —
    // that is where its trigger range lives — and `ruleset-schema.ts`'s
    // `validateTowerDef` already requires it for every non-support bundle,
    // burst included.
    if (towerDef.attack === undefined) {
      throw new RulesetError(
        `tower '${towerDef.id}' must have an attack at simVersion ${SIM_VERSION}`,
      );
    }
    // The only one of these three guards that DOES get a burst exemption:
    // `ruleset-schema.ts`'s `validateAttack` already rejects a burst bundle that
    // CARRIES `cadenceTicks` (single-use, never fires twice), so the two rules meet
    // exactly — burst ⇒ absent, cadenced ⇒ present. Written as an if/else (not a
    // compound `burstEffect === undefined && cadenceTicks === undefined` guard) so
    // TypeScript narrows `cadenceTicks` honestly in the branch below, with no `!`
    // and no `as` on the value.
    let attack: NonNullable<CompiledTower['attack']>;
    if (burstEffect !== undefined) {
      attack = {
        mode: 'burst',
        domain: towerDef.attack.domain,
        rangeFp: towerDef.attack.rangeFp,
        travelTicks: towerDef.attack.travelTicks,
      };
    } else {
      if (towerDef.attack.cadenceTicks === undefined) {
        throw new RulesetError(
          `tower '${towerDef.id}' attack.cadenceTicks is required at simVersion ${SIM_VERSION}`,
        );
      }
      attack = {
        mode: 'cadenced',
        domain: towerDef.attack.domain,
        rangeFp: towerDef.attack.rangeFp,
        cadenceTicks: towerDef.attack.cadenceTicks,
        travelTicks: towerDef.attack.travelTicks,
      };
    }
    return {
      id: towerDef.id,
      cost: towerDef.cost,
      // Mapped HERE, after the three guards above, not hoisted before the support branch:
      // `compileEffect` can throw its own "cannot compile" error, so evaluating it early
      // would change which diagnostic a doubly-malformed bundle reports (an uncompilable
      // effect AND no direct effect used to surface as "must have a direct effect").
      // Both are `RulesetError` and the capability gate rejects such bundles earlier in
      // practice, but a content author's error message is not a thing to change as a side
      // effect of adding a branch.
      effects: towerDef.effects.map((e) => compileEffect(e, towerDef.id)),
      attack,
    };
  });
  // Null-prototype record — see `creepById`'s doc for why (`__proto__` catalog ids).
  const towerById: Partial<Record<string, CompiledTower>> = Object.create(null) as Partial<
    Record<string, CompiledTower>
  >;
  for (const t of towers) towerById[t.id] = t;

  // The catalog-wide STRONGEST slow (min mulFp — smaller multiplies speed down
  // further) over every compiled tower's slow effects; `0` iff no catalog tower
  // carries one (the bound gate then uses `effectiveSpeedFp`'s `mulFp === 0`
  // no-slow case, matching movement's own no-active-slow case exactly).
  let strongestMulFp = 0;
  for (const t of towers) {
    for (const e of t.effects) {
      if (e.kind === 'slow' && (strongestMulFp === 0 || e.mulFp < strongestMulFp)) {
        strongestMulFp = e.mulFp;
      }
    }
  }

  // Compile EVERY board wave into an explicit per-spawn timeline (G7): each entry's
  // stream (first spawn at `offsetTicks`, then every `spacingTicks`, `count` times)
  // is expanded, then the whole wave's spawns are stable-sorted by
  // `(offsetTicks, entryRow)` — the concurrent-stream interleave runs ONCE here, so
  // the sim only ever drains a pre-sorted cursor, never runtime-interleaves. Also
  // aggregates the wave's `entriesSummary` (one row per creep id, FIRST-ARRIVAL
  // order over the sorted timeline) — the wave-preview's authoritative source.
  let totalSpawns = 0; // MAX_SCHEDULED_SPAWNS caps the aggregate across ALL waves.
  // The bound gate's terminal-tick bound must survive hostile SELF-SLOWING (a
  // built `slow` tower stretches every traversal) — so this tracks the MINIMUM
  // EFFECTIVE speed (step 4, Codex R2-4's `effectiveSpeedFp`, shared verbatim with
  // movement) under the catalog-wide `strongestMulFp` above, not the raw base
  // speed. Without any catalog slow effect, `strongestMulFp` is 0 and
  // `effectiveSpeedFp` returns `speedFp` unchanged — byte-identical to sv6.
  let minEffSpeedFp = Number.MAX_SAFE_INTEGER; // over every creep id ANY wave spawns.
  const tails: number[] = []; // per-wave max spawn offset — the bound gate's tail_k.
  const waves: CompiledWave[] = [];
  for (const wave of board.waves) {
    interface RawSpawn {
      readonly offsetTicks: number;
      readonly creepId: string;
      readonly entryRow: number;
    }
    const rawSpawns: RawSpawn[] = [];
    const summaryCount = new Map<string, number>();
    wave.entries.forEach((entry, entryRow) => {
      if (creepById[entry.creepId] === undefined) {
        throw new RulesetError(`wave references unknown creep id '${entry.creepId}'`);
      }
      // `offsetTicks` is optional on the raw type but always canonicalized to a
      // definite number by `validateRulesetShape` (omitted ⇒ 0) before `normalized`
      // reaches here — `?? 0` only satisfies the wider type, never masks a real gap.
      let offset = entry.offsetTicks ?? 0;
      for (let i = 0; i < entry.count; i++) {
        rawSpawns.push({ offsetTicks: offset, creepId: entry.creepId, entryRow });
        offset += entry.spacingTicks;
        totalSpawns++;
        if (totalSpawns > MAX_SCHEDULED_SPAWNS) {
          throw new RulesetError('wave schedule exceeds the scheduled-spawn cap');
        }
      }
      summaryCount.set(entry.creepId, (summaryCount.get(entry.creepId) ?? 0) + entry.count);
    });
    // Stable sort by (offsetTicks, entryRow): `Array.prototype.sort` is spec-stable,
    // but the explicit entryRow tie-break also totally orders same-offset spawns
    // FROM DIFFERENT entries deterministically regardless of engine, matching the
    // pinned cross-wave/same-tick ordering contract.
    rawSpawns.sort((a, b) => a.offsetTicks - b.offsetTicks || a.entryRow - b.entryRow);
    if (rawSpawns.length === 0) throw new RulesetError('wave schedule is empty');
    const spawns: ScheduledSpawn[] = rawSpawns.map((s) => ({
      offsetTicks: s.offsetTicks,
      creepId: s.creepId,
    }));
    tails.push(spawns[spawns.length - 1]!.offsetTicks); // sorted ascending ⇒ last is max
    for (const s of spawns) {
      const def = creepById[s.creepId]!; // resolved above
      // A SLOW-IMMUNE creep is never slowed, so modelling it under `strongestMulFp`
      // is not conservatism — it is a wrong number in the rejecting direction (M2-S6,
      // Codex P2). A lower `minEffSpeedFp` yields a LARGER `maxTraversalTicks`, so a
      // bundle whose waves spawn only slow-immune creeps could be rejected as unable
      // to terminate, even though at their real speed they comfortably do. Newly
      // reachable at sv10: before this story `allowedImmunities` was `[]`, so no
      // compilable bundle could carry an immune creep at all. Widening only — this
      // can accept bundles previously rejected, never the reverse — and hash-neutral,
      // since `maxTraversalTicks` is a local gate value that never enters the digest.
      const slowable = !def.immunities.includes('slow');
      const eff = effectiveSpeedFp(
        def.speedFp,
        slowable ? strongestMulFp : 0,
        normalized.balance.slowFloorNum,
        normalized.balance.slowFloorDen,
      );
      if (eff < minEffSpeedFp) minEffSpeedFp = eff;
    }
    // Preview order = FIRST-ARRIVAL order over the SORTED spawn timeline, not the
    // authored entry order: with per-entry offsets the first creeps a player sees can
    // come from a later table row, and the wave-preview contract (m2.md §Waves) wants
    // the composition in schedule order as it will actually arrive (Codex PR #68).
    const summaryOrder: string[] = [];
    const summarySeen = new Set<string>();
    for (const s of rawSpawns) {
      if (!summarySeen.has(s.creepId)) {
        summarySeen.add(s.creepId);
        summaryOrder.push(s.creepId);
      }
    }
    const entriesSummary = summaryOrder.map((creepId) => ({
      creepId,
      count: summaryCount.get(creepId)!,
    }));
    waves.push({
      countdownTicks: wave.countdownTicks,
      clearBonus: wave.clearBonus,
      spawns,
      entriesSummary,
    });
  }

  // AoE scan-work ceiling (M2-S4a, step 7): only gated when the catalog contains ANY
  // aoe tower — a catalog with none can never schedule a blast, so its per-tick
  // combat cost is bounded by `residentImpacts` alone, unaffected by creep count.
  const hasAoeTower = towers.some((t) => t.effects.some((e) => e.kind === 'aoe'));
  if (hasAoeTower) {
    const worstCaseScanWork = MAX_TOWERS * totalSpawns;
    if (worstCaseScanWork > AOE_SCAN_CEILING) {
      throw new RulesetError(
        `AoE scan-work ceiling exceeded: MAX_TOWERS (${MAX_TOWERS}) × totalScheduledSpawns (${totalSpawns}) = ${worstCaseScanWork} > ${AOE_SCAN_CEILING}`,
      );
    }
  }

  // Reject a bundle whose BASELINE run can't reach a terminal state within the replay
  // validator's absolute tick ceiling — otherwise it compiles but every replay on it
  // times out. Hands-off, wave k launches at the PREFIX SUM of countdowns 1..k (each
  // countdown starts the tick after the previous launch), so its last spawn lands at
  // prefix_k + tail_k, and the run's latest spawn is the MAX of that over k — NOT
  // Σ countdowns + max tail, which double-counts time an early long tail overlaps
  // with later countdowns and would falsely reject feasible bundles (Codex PR #68:
  // countdowns [10k, 10k] + tails [20k, 0] peak at 30k, not 40k). Add the slowest
  // creep's full traversal (max route length ÷ min speed, over every creep any wave
  // spawns). Only the baseline must fit; adversarial build/sell juggling beyond it
  // is caught by the validator's timeout.
  // `minEffSpeedFp` deliberately never accounts for stun (M2-S6): `effectiveSpeedFp`
  // is shared verbatim with movement, but movement's `stunned` branch (index.ts)
  // passes a synthetic 0 budget straight to `advanceCreep` rather than threading a
  // `stunned` parameter through this function — the honest value here would make
  // the gate see speed 0 for any catalog carrying a stun effect, `maxTraversalTicks`
  // infinite, and every such bundle rejected. Unlike slow, stun has no floor by
  // design (chain-lock is permitted, decision 5), so there is no bounded worst case
  // to model. Stun-induced overrun therefore sits on the same side of the line this
  // comment already draws for build/sell juggling: caught by the replay validator's
  // `MAX_TICKS` timeout, not this compile-time gate.
  let prefixCountdown = 0;
  let latestSpawnTick = 0;
  waves.forEach((w, k) => {
    prefixCountdown += w.countdownTicks;
    const last = prefixCountdown + tails[k]!;
    if (last > latestSpawnTick) latestSpawnTick = last;
  });
  const cells = boardCtx.grid.width * boardCtx.grid.height;
  const maxTraversalTicks = Math.ceil((cells * DIAG_LEN) / minEffSpeedFp);
  if (latestSpawnTick + maxTraversalTicks > MAX_MATCH_TICKS) {
    throw new RulesetError('ruleset cannot reach a terminal state within the tick budget');
  }

  // Digest an un-int-validated field can still trip canonicalJson; funnel it through
  // RulesetError so compileRuleset's documented "throws only RulesetError" contract
  // holds for every caller. (Every field IS int-validated post-`validateRulesetShape`,
  // but this stays a defensive boundary against a future field that isn't.)
  let digest: string;
  try {
    digest = rulesetDigest(normalized);
  } catch (err) {
    throw new RulesetError(`ruleset is not hashable: ${(err as Error).message}`);
  }

  const balance: CompiledBalance = {
    startingLives: normalized.balance.startingLives,
    startingBounty: normalized.balance.startingBounty,
    refundNum: normalized.balance.refundNum,
    refundDen: normalized.balance.refundDen,
    slowFloorNum: normalized.balance.slowFloorNum,
    slowFloorDen: normalized.balance.slowFloorDen,
    earlyCallBountyDivisor: normalized.balance.earlyCallBountyDivisor,
  };
  const scoring: CompiledScoring = {
    survivalMul: normalized.scoring.survivalMul,
    starThresholds: normalized.scoring.starThresholds,
    earlyCallScoreDivisor: normalized.scoring.earlyCallScoreDivisor,
  };

  const compiled: CompiledRuleset = {
    __brand: 'CompiledRuleset',
    boardId,
    board: boardCtx,
    balance,
    scoring,
    towers,
    towerById,
    creepById,
    waves,
    digest,
  };
  // Freeze the compiled tuning (balance/scoring/tower catalog/creep defs/waves) so
  // a retained ruleset can't be mutated at runtime and diverge from its digest. The
  // board machinery (grid methods, typed-array fields) is intentionally left
  // untouched.
  deepFreeze(compiled.balance);
  deepFreeze(compiled.scoring);
  deepFreeze(compiled.towers);
  deepFreeze(compiled.towerById);
  deepFreeze(compiled.waves);
  deepFreeze(compiled.creepById);
  Object.freeze(compiled); // freeze the WRAPPER too, so `ruleset.towers = …` can't replace a field
  validated.add(compiled);
  return compiled;
}

/**
 * Totality boundary guard (mirrors `assertConsistent`): reject a forged/out-of-band
 * object handed to `step`/`createInitialState`. Only a genuine `compileRuleset`
 * product carries the brand membership, so a hand-built literal is refused loudly
 * before any tick reads a field. Memoized by identity.
 */
export function assertRuleset(ruleset: CompiledRuleset): void {
  if (validated.has(ruleset)) return;
  throw new RulesetError('ruleset was not produced by compileRuleset — refusing to simulate');
}
