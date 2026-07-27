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
//   • The COMPILED SURFACE is frozen to keep its value roles, meanings, and
//     behavior identical to the v1 shipped sim: `CompiledBalance`/`CompiledScoring`/
//     `CompiledTower`/`CompiledCreep` carry the v1 field set verbatim (module
//     header of PLAN.md M2-S1 invariant 1), with exactly two authorized renames —
//     `creepByKind` → `creepById`, and the compiled tower/schedule `kind` → `id`/
//     `creepId` (a catalog id is now an open string, not a closed union member).
//
// `ruleset.ts` ↔ `ruleset-schema.ts` ↔ `capability.ts` form a small import cycle
// (this module imports `validateRulesetShape`/`capabilityProfile`; those modules
// import `RulesetError` from here) — safe because every cross-module reference is
// used only inside function bodies, never at module-evaluation time, so by the
// time any of these functions actually run, every module has finished initializing
// and the live bindings are populated. `index.ts` cannot supply `SIM_VERSION` here
// instead (see the capability-profile call below) without the reverse cycle
// `ruleset.ts` → `index.ts` → `ruleset.ts` (`index.ts` already imports
// `CompiledRuleset`/`assertRuleset` from this module), so the sim's behavior
// version is duplicated as a comment-pinned literal here rather than imported.

import { canonicalJson, sha256Hex } from '@wynding/engine';
import type { EffectDef, Ruleset, RulesetBoard, TowerDef } from '@wynding/types';
import { loadBoard, type BoardContext } from './context';
import { canonicalImmunities, validateRulesetShape } from './ruleset-schema';
import { capabilityProfile, type CapabilityProfile } from './capability';

/** Thrown when a bundle is malformed, out of bounds, or describes something this
 *  sim build's capability profile does not (yet) simulate. Rejected at match
 *  creation, never inside `step` — the sim's totality guarantee is unaffected. */
export class RulesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesetError';
  }
}

/** One scheduled spawn: `offsetTicks` after launch, a creep of catalog `creepId`.
 *  (Renamed from v1's `kind` — catalog ids are open strings now, decision 4.) */
export interface ScheduledSpawn {
  readonly offsetTicks: number;
  readonly creepId: string;
}

/** Sim-owned compile-time projection of `BalanceConstants` — the v1 field set
 *  VERBATIM, so `step`'s reads are unchanged. `leakCost`/`countdownTicks`/
 *  `waveClearBonus` are now DERIVED (read from the per-creep/per-wave v2 schema
 *  under the capability profile's uniformity/single-wave guarantees) rather than
 *  raw bundle fields; `earlyCallBonus` is hardcoded 0 (see `compileRuleset`). */
export interface CompiledBalance {
  readonly startingLives: number;
  readonly startingBounty: number;
  readonly refundNum: number;
  readonly refundDen: number;
  readonly leakCost: number;
  readonly countdownTicks: number;
  readonly waveClearBonus: number;
  readonly earlyCallBonus: number;
}

/** Sim-owned compile-time projection of `ScoringConfig` — v1 field set verbatim. */
export interface CompiledScoring {
  readonly survivalMul: number;
  readonly starThresholds: readonly [number, number, number];
}

/** Sim-owned compile-time projection of `TowerDef` — v1 field set, `kind` renamed
 *  `id`. `damage` is read from the bundle's single direct/single effect (the
 *  capability profile guarantees exactly one effect, kind `direct`, form
 *  `single`, at this sim's behavior version). */
export interface CompiledTower {
  readonly id: string;
  readonly cost: number;
  readonly damage: number;
  readonly rangeFp: number;
  readonly cadenceTicks: number;
  readonly travelTicks: number;
}

/** Sim-owned compile-time projection of `CreepDef` — v1 field set, `kind`
 *  renamed `id`. */
export interface CompiledCreep {
  readonly id: string;
  readonly hp: number;
  readonly speedFp: number;
  readonly bounty: number;
  readonly domain: 'ground' | 'air';
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
  /** The single M1 tower stat block (one tower kind at M1). */
  readonly tower: CompiledTower;
  /** Creep stat lookup by id — a FROZEN plain record (not a Map, whose `set/delete`
   *  `Object.freeze` can't block), so a retained ruleset is genuinely immutable.
   *  Renamed from v1's `creepByKind` (decision 4/M2-S1 invariant 1). */
  readonly creepById: Readonly<Partial<Record<string, CompiledCreep>>>;
  /** The board's single wave, flattened to an ordered per-spawn timeline. */
  readonly schedule: readonly ScheduledSpawn[];
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

/** Fixed-point diagonal step length (≈ √2 × 256); the generous per-cell route-length
 *  unit used for the worst-case traversal bound (mirrors replay's re-simulation
 *  ceiling, `MAX_MATCH_TICKS` above). */
const FP_DIAG_LEN = 362;

/** This sim build's behavior version — MUST equal `index.ts`'s exported
 *  `SIM_VERSION` (5). Duplicated as a literal rather than imported to avoid the
 *  `ruleset.ts` ↔ `index.ts` import cycle `index.ts`'s existing
 *  `import { assertRuleset, type CompiledRuleset } from './ruleset'` would create;
 *  `scripts/check-determinism-version.mjs` + the determinism golden are the
 *  tripwire if these two literals were ever to drift. */
const COMPILED_SIM_VERSION = 5;

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
 *  kinds/forms, leak-cost uniformity, the early-call divisors). Board/wave-scoped
 *  dimensions (`maxWavesPerBoard`, `maxEntriesPerWave`, `maxOffsetTicks`,
 *  `maxClearBonus`) are checked separately, only against the board actually being
 *  compiled — mirroring v1's board-scoped wave validation. */
function checkCapabilityGlobal(bundle: Ruleset, profile: CapabilityProfile): void {
  const v = COMPILED_SIM_VERSION;
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
  }
  // The profile pins the VALUE, not just uniformity (m2.md: "leakCost = 1 until
  // S10") — a uniform-but-nonzero catalog is still content this sim build cannot
  // correctly simulate (multi-life leak is S10's sim rule).
  for (const creep of bundle.creepCatalog) {
    if (creep.leakCost !== profile.requiredLeakCost) {
      throw new RulesetError(
        `creep '${creep.id}' leakCost ${creep.leakCost} unsupported at simVersion ${v} (must be ${profile.requiredLeakCost})`,
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
      if (
        (effect.kind === 'direct' || effect.kind === 'burst') &&
        !profile.allowedDirectForms.includes(effect.form)
      ) {
        throw new RulesetError(`effect form '${effect.form}' unsupported at simVersion ${v}`);
      }
    }
    if (tower.attack !== undefined && !profile.allowedTowerDomains.includes(tower.attack.domain)) {
      throw new RulesetError(
        `tower attack domain '${tower.attack.domain}' unsupported at simVersion ${v}`,
      );
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

/** Gate the board/wave-scoped capability dimensions against the board actually
 *  being compiled (v1 only ever validated the chosen board's wave, not every
 *  board in the catalog). */
function checkCapabilityBoard(board: RulesetBoard, profile: CapabilityProfile): void {
  const v = COMPILED_SIM_VERSION;
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
  const profile = capabilityProfile(COMPILED_SIM_VERSION);
  checkCapabilityGlobal(normalized, profile);

  const board = normalized.boards.find((b) => b.id === boardId);
  if (board === undefined) throw new RulesetError(`unknown boardId '${boardId}'`);
  checkCapabilityBoard(board, profile);

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
    };
  }
  // Per-creep leakCost REPLACES v1's global `balance.leakCost` in the schema; the
  // compiled surface still exposes one flat value (ADR 0007 no-balance-magic: read
  // from content, never a code literal), safe because the capability profile's
  // `requiredLeakCost` gate (checkCapabilityGlobal, above) already proved every
  // catalog entry carries exactly that value.
  const leakCost = normalized.creepCatalog[0]!.leakCost;

  const towerDef: TowerDef = normalized.towerCatalog[0]!; // profile: exactly one tower
  // damage := the bundle's single direct/single effect's damage (profile: exactly
  // one effect, kind direct, form single, at this sim's behavior version).
  const directEffect = towerDef.effects.find(
    (e): e is Extract<EffectDef, { kind: 'direct'; form: 'single' }> =>
      e.kind === 'direct' && e.form === 'single',
  );
  if (directEffect === undefined) {
    throw new RulesetError(
      `tower '${towerDef.id}' must have a direct/single effect at simVersion ${COMPILED_SIM_VERSION}`,
    );
  }
  if (towerDef.attack === undefined) {
    throw new RulesetError(
      `tower '${towerDef.id}' must have an attack at simVersion ${COMPILED_SIM_VERSION}`,
    );
  }
  if (towerDef.attack.cadenceTicks === undefined) {
    throw new RulesetError(
      `tower '${towerDef.id}' attack.cadenceTicks is required at simVersion ${COMPILED_SIM_VERSION}`,
    );
  }
  const tower: CompiledTower = {
    id: towerDef.id,
    cost: towerDef.cost,
    damage: directEffect.damage,
    rangeFp: towerDef.attack.rangeFp,
    cadenceTicks: towerDef.attack.cadenceTicks,
    travelTicks: towerDef.attack.travelTicks,
  };

  // Compile the board's single wave (profile: maxWavesPerBoard 1) into an explicit
  // per-spawn timeline; the single-entry wave (profile: maxEntriesPerWave 1) compiles
  // through the same cursor logic v1 used for back-to-back multi-entry waves —
  // identical to today's stream semantics at exactly one entry. DELIBERATE OMISSION:
  // `entry.offsetTicks` is schema-validated, hashed, and capability-gated
  // (`maxOffsetTicks: 0`) but NOT consumed here — concurrent streams (every entry's
  // first spawn at launch + its own offset) are S2's semantics, implemented when S2
  // rewrites this loop under its own SIM_VERSION bump; consuming the field early
  // would ship a slice of S2's behavior without its version gate.
  const wave0 = board.waves[0]!;
  const schedule: ScheduledSpawn[] = [];
  let cursor = 0;
  for (const entry of wave0.entries) {
    if (creepById[entry.creepId] === undefined) {
      throw new RulesetError(`wave references unknown creep id '${entry.creepId}'`);
    }
    for (let i = 0; i < entry.count; i++) {
      schedule.push({ offsetTicks: cursor, creepId: entry.creepId });
      cursor += entry.spacingTicks;
      if (schedule.length > MAX_SCHEDULED_SPAWNS) {
        throw new RulesetError('wave exceeds the scheduled-spawn cap');
      }
    }
  }
  if (schedule.length === 0) throw new RulesetError('wave schedule is empty');

  // Reject a bundle whose BASELINE run can't reach a terminal state within the replay
  // validator's absolute tick ceiling — otherwise it compiles but every replay on it
  // times out. Bound the worst-case baseline: launch deadline + last spawn offset +
  // the slowest creep's full traversal (max route length ÷ min speed). Only the
  // baseline must fit; adversarial build/sell juggling beyond it is caught by the
  // validator's timeout.
  const lastOffset = schedule[schedule.length - 1]!.offsetTicks;
  // Minimum speed over the ids THIS board's schedule actually spawns — not the whole
  // catalog, so an unrelated slow creep used only by another board can't wrongly
  // reject this board.
  let minSpeedFp = Number.MAX_SAFE_INTEGER;
  for (const s of schedule) {
    const def = creepById[s.creepId];
    if (def !== undefined && def.speedFp < minSpeedFp) minSpeedFp = def.speedFp;
  }
  const cells = boardCtx.grid.width * boardCtx.grid.height;
  const maxTraversalTicks = Math.ceil((cells * FP_DIAG_LEN) / minSpeedFp);
  const countdownTicks = wave0.countdownTicks;
  if (countdownTicks + lastOffset + maxTraversalTicks > MAX_MATCH_TICKS) {
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
    leakCost,
    countdownTicks,
    waveClearBonus: wave0.clearBonus,
    // Derived from the profile-pinned divisor-off state (maxEarlyCallBountyDivisor:
    // 0, enforced by checkCapabilityGlobal above) — not a raw bundle field. S2
    // replaces this flat compiled field with the real divisor formula.
    earlyCallBonus: 0,
  };
  const scoring: CompiledScoring = {
    survivalMul: normalized.scoring.survivalMul,
    starThresholds: normalized.scoring.starThresholds,
  };

  const compiled: CompiledRuleset = {
    __brand: 'CompiledRuleset',
    boardId,
    board: boardCtx,
    balance,
    scoring,
    tower,
    creepById,
    schedule,
    digest,
  };
  // Freeze the compiled tuning (balance/scoring/tower/creep defs/schedule) so a
  // retained ruleset can't be mutated at runtime and diverge from its digest. The
  // board machinery (grid methods, typed-array fields) is intentionally left
  // untouched.
  deepFreeze(compiled.balance);
  deepFreeze(compiled.scoring);
  deepFreeze(compiled.tower);
  deepFreeze(compiled.schedule);
  deepFreeze(compiled.creepById);
  Object.freeze(compiled); // freeze the WRAPPER too, so `ruleset.tower = …` can't replace a field
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
