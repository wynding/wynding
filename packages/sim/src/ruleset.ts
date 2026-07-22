// ruleset.ts — compile + validate + hash the ADR 0007 ruleset bundle.
//
// The sim reads ALL sim-affecting tuning from the bundle (ADR 0007), never from
// hardcoded constants. This module is the single seam between the raw authored
// `Ruleset` (pure JSON data from `@wynding/types`, authored in `@wynding/content`)
// and the running sim — so the sim NEVER imports `@wynding/content`; the caller
// (replay/client) hands the bundle in and we compile it here.
//
// Two responsibilities:
//   • `rulesetDigest(bundle)` — the collision-resistant content identity
//     (`rulesetHash`): normalize (strip presentation-only fields) → RFC 8785 JCS →
//     SHA-256, exactly per `docs/design-notes/ruleset-format.md`. Shared by replay
//     creation and validation so client and server never drift.
//   • `compileRuleset(bundle, boardId)` — validate per-field domains and resolve the
//     bundle into a branded `CompiledRuleset` (grid + distance field + indexed
//     catalogs + an explicit per-spawn schedule). Compilation happens at MATCH
//     CREATION, before the sim runs, so it MAY reject invalid content by throwing
//     `RulesetError`. `step` itself stays total.

import { canonicalJson, sha256Hex } from '@wynding/engine';
import type {
  BalanceConstants,
  CreepDef,
  CreepKind,
  Ruleset,
  RulesetBoard,
  ScoringConfig,
  TowerDef,
} from '@wynding/types';
import { loadBoard, type BoardContext } from './context';

/** Thrown when a bundle is malformed or out of bounds. Rejected at match creation,
 *  never inside `step` — the sim's totality guarantee is unaffected. */
export class RulesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesetError';
  }
}

/** One scheduled spawn: `offsetTicks` after launch, a creep of catalog `kind`. */
export interface ScheduledSpawn {
  readonly offsetTicks: number;
  readonly kind: CreepKind;
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
  readonly balance: BalanceConstants;
  readonly scoring: ScoringConfig;
  /** The single M1 tower stat block (one tower kind at M1). */
  readonly tower: TowerDef;
  /** Creep stat lookup by kind — a FROZEN plain record (not a Map, whose `set/delete`
   *  `Object.freeze` can't block), so a retained ruleset is genuinely immutable. */
  readonly creepByKind: Readonly<Partial<Record<CreepKind, CreepDef>>>;
  /** The board's single wave, flattened to an ordered per-spawn timeline. */
  readonly schedule: readonly ScheduledSpawn[];
  /** The content identity digest (`rulesetHash`). */
  readonly digest: string;
}

const validated = new WeakSet<CompiledRuleset>();

/** Recursively freeze plain objects/arrays (and a Map's values) so the compiled
 *  tuning is immutable at runtime — a caller can't mutate a retained ruleset and
 *  diverge a match from its fixed `digest` (Codex P2). Read-only at runtime already,
 *  so this only closes the tamper surface; typed-array/grid internals are left alone. */
function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o) && !ArrayBuffer.isView(o)) {
    if (o instanceof Map) {
      for (const v of o.values()) deepFreeze(v);
    } else {
      for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    }
    Object.freeze(o);
  }
  return o;
}

/** A safe positive integer within a generous bound (rejects 0, negatives, floats,
 *  NaN, and absurd magnitudes that could exhaust replay work). */
function isPosInt(v: unknown, max = 1_000_000): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max;
}

/** A safe non-negative integer within a bound (for bonuses / refundNum — 0 is legal). */
function isNonNegInt(v: unknown, max = 1_000_000): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
}

/** Hard cap on total scheduled spawns — a bounded, anti-DoS ceiling on wave size. */
const MAX_SCHEDULED_SPAWNS = 10_000;

/** The only ruleset schema version this sim understands (ADR 0007 `formatVersion`). */
const SUPPORTED_FORMAT_VERSION = 1;

/** Max ticks from match start to the LAST scheduled spawn. Kept below the replay
 *  validator's absolute tick ceiling (36 000) so a compiled bundle's wave always
 *  spawns out within budget — a bundle whose schedule can't fit is rejected here
 *  rather than compiling into replays that can only ever time out. */
const MAX_MATCH_HORIZON = 30_000;

function isCell(c: unknown, w: number, h: number): boolean {
  return (
    c != null &&
    typeof c === 'object' &&
    Number.isSafeInteger((c as { col?: unknown }).col) &&
    Number.isSafeInteger((c as { row?: unknown }).row) &&
    (c as { col: number }).col >= 0 &&
    (c as { col: number }).col < w &&
    (c as { row: number }).row >= 0 &&
    (c as { row: number }).row < h
  );
}

function validateBalance(b: BalanceConstants): void {
  if (b == null || typeof b !== 'object') throw new RulesetError('balance missing');
  if (!isPosInt(b.startingLives)) throw new RulesetError('startingLives must be a positive int');
  if (!isNonNegInt(b.startingBounty)) throw new RulesetError('startingBounty must be ≥ 0');
  if (!isNonNegInt(b.refundNum)) throw new RulesetError('refundNum must be ≥ 0');
  if (!isPosInt(b.refundDen)) throw new RulesetError('refundDen must be a positive int');
  if (b.refundNum > b.refundDen) throw new RulesetError('refund fraction must be ≤ 1');
  if (!isPosInt(b.leakCost)) throw new RulesetError('leakCost must be a positive int');
  if (!isPosInt(b.countdownTicks)) throw new RulesetError('countdownTicks must be a positive int');
  if (!isNonNegInt(b.waveClearBonus)) throw new RulesetError('waveClearBonus must be ≥ 0');
  if (!isNonNegInt(b.earlyCallBonus)) throw new RulesetError('earlyCallBonus must be ≥ 0');
}

function validateScoring(s: ScoringConfig): void {
  if (s == null || typeof s !== 'object') throw new RulesetError('scoring missing');
  if (!isNonNegInt(s.survivalMul)) throw new RulesetError('survivalMul must be ≥ 0');
  const t = s.starThresholds;
  if (!Array.isArray(t) || t.length !== 3 || !t.every((x) => isPosInt(x))) {
    throw new RulesetError('starThresholds must be three positive ints');
  }
  if (!(t[0] <= t[1] && t[1] <= t[2])) {
    throw new RulesetError('starThresholds must be ascending');
  }
}

function validateCreep(c: CreepDef): void {
  if (!isPosInt(c.hp)) throw new RulesetError(`creep ${String(c.kind)} hp must be positive`);
  if (!isPosInt(c.speedFp))
    throw new RulesetError(`creep ${String(c.kind)} speedFp must be positive`);
  if (!isNonNegInt(c.bounty)) throw new RulesetError(`creep ${String(c.kind)} bounty must be ≥ 0`);
  // M1 is GROUND-ONLY: movement runs every creep through the ground distance field and
  // combat targets without a domain check, so an `air` creep would (wrongly) obey the
  // maze and be hittable by the ground tower. Reject it until M2 adds domain-aware
  // movement + anti-air targeting (Codex P2). The type keeps `air` for that milestone.
  if (c.domain !== 'ground') {
    throw new RulesetError(
      `creep ${String(c.kind)} domain '${String(c.domain)}' unsupported at M1 (ground only)`,
    );
  }
}

function validateTower(t: TowerDef): void {
  if (!isPosInt(t.cost)) throw new RulesetError('tower cost must be positive');
  if (!isPosInt(t.damage)) throw new RulesetError('tower damage must be positive');
  if (!isPosInt(t.rangeFp)) throw new RulesetError('tower rangeFp must be positive');
  if (!isPosInt(t.cadenceTicks)) throw new RulesetError('tower cadenceTicks must be positive');
  // travelTicks ≥ 1: a scheduled impact resolves at the TOP of a later tick, so a
  // 0-travel ("instant") shot fired this tick would resolve a tick late (Codex P2).
  // A projectile always takes ≥1 tick; same-tick resolution is deferred until an
  // instant-hit tower is actually a milestone.
  if (!isPosInt(t.travelTicks)) throw new RulesetError('tower travelTicks must be positive');
}

/**
 * Normalize the bundle for hashing by projecting ONLY the known, sim-affecting schema
 * fields (ADR 0007 §3 + `ruleset-format.md`: "strip unknown fields, strip
 * presentation-only fields"). Building the canonical value from an explicit field list
 * — rather than copy-and-delete — means an unknown metadata property can never leak
 * into `rulesetHash` (two bundles equal in every supported field MUST share a digest),
 * and the board display `name` (presentation-only) is excluded so a rename never
 * invalidates a replay. A NEW sim-affecting field is added here deliberately, in the
 * same change that bumps `formatVersion`/`simVersion` — never silently, because an
 * unknown `formatVersion` is rejected at compile (see compileRuleset). Values are read
 * straight from the bundle, so `canonicalJson`'s non-finite / non-plain-object guards
 * still fire on a malformed field.
 */
function normalizeForHash(bundle: Ruleset): unknown {
  return {
    formatVersion: bundle.formatVersion,
    rulesetId: bundle.rulesetId,
    version: bundle.version,
    creepCatalog: bundle.creepCatalog.map((c) => ({
      kind: c.kind,
      hp: c.hp,
      speedFp: c.speedFp,
      bounty: c.bounty,
      domain: c.domain,
    })),
    towerCatalog: bundle.towerCatalog.map((t) => ({
      kind: t.kind,
      cost: t.cost,
      damage: t.damage,
      rangeFp: t.rangeFp,
      cadenceTicks: t.cadenceTicks,
      travelTicks: t.travelTicks,
    })),
    balance: {
      startingLives: bundle.balance.startingLives,
      startingBounty: bundle.balance.startingBounty,
      refundNum: bundle.balance.refundNum,
      refundDen: bundle.balance.refundDen,
      leakCost: bundle.balance.leakCost,
      countdownTicks: bundle.balance.countdownTicks,
      waveClearBonus: bundle.balance.waveClearBonus,
      earlyCallBonus: bundle.balance.earlyCallBonus,
    },
    scoring: {
      survivalMul: bundle.scoring.survivalMul,
      starThresholds: bundle.scoring.starThresholds,
    },
    boards: bundle.boards.map((b) => ({
      id: b.id,
      widthTiles: b.widthTiles,
      heightTiles: b.heightTiles,
      entrance: { col: b.entrance.col, row: b.entrance.row },
      exit: { col: b.exit.col, row: b.exit.row },
      // `name` excluded — presentation-only (ADR 0007 §3).
      waves: b.waves.map((w) => ({
        index: w.index,
        entries: w.entries.map((e) => ({
          kind: e.kind,
          count: e.count,
          spacingTicks: e.spacingTicks,
        })),
      })),
    })),
  };
}

/**
 * The ruleset content identity (`rulesetHash`): SHA-256 over the RFC 8785 canonical
 * form of the normalized bundle. Collision-resistant (ADR 0007 §3) — NOT the 32-bit
 * world-hash. One implementation shared by replay creation and validation.
 */
export function rulesetDigest(bundle: Ruleset): string {
  return sha256Hex(canonicalJson(normalizeForHash(bundle)));
}

/**
 * Compile + validate a bundle for a given board into a branded `CompiledRuleset`.
 * Throws `RulesetError` on any malformed/out-of-bounds field or unknown creep kind,
 * so invalid content is rejected before a match ever starts.
 */
export function compileRuleset(bundle: Ruleset, boardId: string): CompiledRuleset {
  if (bundle == null || typeof bundle !== 'object') throw new RulesetError('bundle missing');
  // Reject an unknown schema version rather than silently reading unfamiliar content
  // with v1 semantics (Codex P2) — `formatVersion` is the schema-evolution field.
  if (bundle.formatVersion !== SUPPORTED_FORMAT_VERSION) {
    throw new RulesetError(
      `unsupported formatVersion ${String(bundle.formatVersion)} (supported: ${SUPPORTED_FORMAT_VERSION})`,
    );
  }
  if (!Array.isArray(bundle.creepCatalog) || bundle.creepCatalog.length === 0) {
    throw new RulesetError('creepCatalog missing');
  }
  if (!Array.isArray(bundle.towerCatalog) || bundle.towerCatalog.length === 0) {
    throw new RulesetError('towerCatalog missing');
  }
  // M1 has a SINGLE tower kind: placeTower always builds towerCatalog[0] (no per-tower
  // kind selection yet), so extra defs would silently collapse to the first (Codex P2).
  // Reject until multi-tower placement is a milestone.
  if (bundle.towerCatalog.length !== 1) {
    throw new RulesetError('M1 supports exactly one tower kind');
  }
  validateBalance(bundle.balance);
  validateScoring(bundle.scoring);

  // Snapshot every compiled tuning value with structuredClone (Codex P1): a caller that
  // mutates the raw bundle AFTER compileRuleset must not be able to change a running
  // match's behaviour while its `digest` stays fixed (client/validator divergence). The
  // compiled ruleset owns detached copies, so the state it runs matches the hash.
  // Null-prototype record (Fable QC): a plain `{}` would let a JSON `kind: "__proto__"`
  // set the object's PROTOTYPE (not an own key) — escaping the deep-freeze — and would
  // make inherited names ("toString", "hasOwnProperty") pass the unknown-kind check
  // below. `Object.create(null)` has no `__proto__` accessor and inherits nothing.
  const creepByKind: Partial<Record<CreepKind, CreepDef>> = Object.create(null) as Partial<
    Record<CreepKind, CreepDef>
  >;
  for (const c of bundle.creepCatalog) {
    validateCreep(c);
    creepByKind[c.kind as CreepKind] = structuredClone(c);
  }
  for (const t of bundle.towerCatalog) validateTower(t);
  const tower = structuredClone(bundle.towerCatalog[0]) as TowerDef; // M1: single tower kind

  if (!Array.isArray(bundle.boards)) throw new RulesetError('boards must be an array');
  const board = bundle.boards.find((b: RulesetBoard) => b.id === boardId);
  if (board == null) throw new RulesetError(`unknown boardId '${String(boardId)}'`);
  if (!isCell(board.entrance, board.widthTiles, board.heightTiles)) {
    throw new RulesetError('entrance out of bounds');
  }
  if (!isCell(board.exit, board.widthTiles, board.heightTiles)) {
    throw new RulesetError('exit out of bounds');
  }

  // Build the grid + exit distance field; loadBoard rejects an unplayable board. Its
  // failure (a GridError — non-border opening, bad dims, over-cap cells) is re-thrown
  // as a RulesetError so ALL malformed content surfaces through one type and the
  // replay validator can turn it into a clean rejection rather than a 500 (Fable P2).
  let boardCtx;
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

  // Compile the board's single M1 wave into an explicit per-spawn timeline. General
  // over heterogeneous multi-entry waves (M2) — an entry's spacing applies between
  // its own successive spawns, laid down back-to-back after the prior entry.
  if (!Array.isArray(board.waves) || board.waves.length !== 1) {
    throw new RulesetError('M1 expects exactly one wave');
  }
  if (!Array.isArray(board.waves[0].entries)) {
    throw new RulesetError('wave entries must be an array');
  }
  const schedule: ScheduledSpawn[] = [];
  let cursor = 0;
  for (const entry of board.waves[0].entries) {
    if (entry == null || creepByKind[entry.kind as CreepKind] === undefined) {
      throw new RulesetError(`wave references unknown creep kind '${String(entry?.kind)}'`);
    }
    if (!isPosInt(entry.count)) throw new RulesetError('wave entry count must be positive');
    if (!isPosInt(entry.spacingTicks))
      throw new RulesetError('wave entry spacing must be positive');
    for (let i = 0; i < entry.count; i++) {
      schedule.push({ offsetTicks: cursor, kind: entry.kind });
      cursor += entry.spacingTicks;
      if (schedule.length > MAX_SCHEDULED_SPAWNS) {
        throw new RulesetError('wave exceeds the scheduled-spawn cap');
      }
    }
  }
  if (schedule.length === 0) throw new RulesetError('wave schedule is empty');

  // Reject a bundle whose launch + spawn schedule can't fit a validatable run
  // (Codex/code-review): if countdownTicks + the last spawn offset already exceeds the
  // match horizon, the wave can never spawn out within any replay budget, so every
  // replay on this board would time out. Fail fast at compile instead.
  const lastOffset = schedule[schedule.length - 1]!.offsetTicks;
  if (bundle.balance.countdownTicks + lastOffset > MAX_MATCH_HORIZON) {
    throw new RulesetError('wave launch + spawn schedule exceeds the match horizon');
  }

  // Digest an un-int-validated field (e.g. a float `wave.index`) can still trip
  // canonicalJson; funnel it through RulesetError so compileRuleset's documented
  // "throws only RulesetError" contract holds for every caller (Fable P3).
  let digest: string;
  try {
    digest = rulesetDigest(bundle);
  } catch (err) {
    throw new RulesetError(`ruleset is not hashable: ${(err as Error).message}`);
  }

  const compiled: CompiledRuleset = {
    __brand: 'CompiledRuleset',
    boardId,
    board: boardCtx,
    balance: structuredClone(bundle.balance), // detached snapshot (Codex P1)
    scoring: structuredClone(bundle.scoring),
    tower,
    creepByKind,
    schedule,
    digest,
  };
  // Freeze the compiled tuning (balance/scoring/tower/creep defs/schedule) so a
  // retained ruleset can't be mutated at runtime and diverge from its digest (Codex
  // P2). The board machinery (grid methods, typed-array fields) is intentionally left
  // untouched.
  deepFreeze(compiled.balance);
  deepFreeze(compiled.scoring);
  deepFreeze(compiled.tower);
  deepFreeze(compiled.schedule);
  deepFreeze(compiled.creepByKind);
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
