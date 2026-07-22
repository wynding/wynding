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
  readonly creepByKind: ReadonlyMap<CreepKind, CreepDef>;
  /** The board's single wave, flattened to an ordered per-spawn timeline. */
  readonly schedule: readonly ScheduledSpawn[];
  /** The content identity digest (`rulesetHash`). */
  readonly digest: string;
}

const validated = new WeakSet<CompiledRuleset>();

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
  if (c.domain !== 'ground' && c.domain !== 'air') {
    throw new RulesetError(`creep ${String(c.kind)} domain invalid`);
  }
}

function validateTower(t: TowerDef): void {
  if (!isPosInt(t.cost)) throw new RulesetError('tower cost must be positive');
  if (!isPosInt(t.damage)) throw new RulesetError('tower damage must be positive');
  if (!isPosInt(t.rangeFp)) throw new RulesetError('tower rangeFp must be positive');
  if (!isPosInt(t.cadenceTicks)) throw new RulesetError('tower cadenceTicks must be positive');
  if (!isNonNegInt(t.travelTicks)) throw new RulesetError('tower travelTicks must be ≥ 0');
}

/**
 * Normalize the bundle for hashing: strip presentation-only fields (board display
 * `name`) so a rename never invalidates a replay, and drop nothing sim-affecting.
 * The result is fed to `canonicalJson` (which sorts keys), so we need only remove
 * the excluded fields — key order here is irrelevant.
 */
function normalizeForHash(bundle: Ruleset): unknown {
  // FAIL-SAFE (Fable P3): copy the WHOLE bundle and DELETE only the presentation-only
  // fields, so any future sim-affecting field is hashed by default — never silently
  // excluded (which would let two behaviourally-different rulesets share a digest, the
  // exact spoof the hash prevents). Presentation-only = board display `name` (ADR 0007
  // §3); catalogs/balance/scoring carry no presentation fields. `structuredClone` (NOT
  // a JSON round-trip, which would coerce NaN/Infinity→null and Date/Map→a plain shape,
  // silently defeating canonicalJson's non-finite / non-plain-object guards) deep-copies
  // faithfully, so a malformed value still throws loudly at hash time (Fable P3).
  const clone = structuredClone(bundle) as Ruleset;
  if (Array.isArray(clone.boards)) {
    for (const b of clone.boards) delete (b as { name?: unknown }).name;
  }
  return clone;
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
  if (!Array.isArray(bundle.creepCatalog) || bundle.creepCatalog.length === 0) {
    throw new RulesetError('creepCatalog missing');
  }
  if (!Array.isArray(bundle.towerCatalog) || bundle.towerCatalog.length === 0) {
    throw new RulesetError('towerCatalog missing');
  }
  validateBalance(bundle.balance);
  validateScoring(bundle.scoring);

  const creepByKind = new Map<CreepKind, CreepDef>();
  for (const c of bundle.creepCatalog) {
    validateCreep(c);
    creepByKind.set(c.kind, c);
  }
  for (const t of bundle.towerCatalog) validateTower(t);
  const tower = bundle.towerCatalog[0] as TowerDef; // M1: single tower kind

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
    if (entry == null || !creepByKind.has(entry.kind)) {
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
    balance: bundle.balance,
    scoring: bundle.scoring,
    tower,
    creepByKind,
    schedule,
    digest,
  };
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
