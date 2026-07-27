// ruleset-schema.ts — the v2 structural validator + JSON parser (ADR 0007, M2-S1).
//
// Owns ALL shape/structural validation: types, bounds, id patterns, catalog/board id
// uniqueness, cross-field rules (support-exclusivity, burst-cadence-exclusivity, wave
// index contiguity, `creepId` reference resolution), and STRICT unknown-key rejection
// at every nesting level (a modder's typo must fail loudly, not silently no-op).
// `compileRuleset` (ruleset.ts) calls `validateRulesetShape` FIRST, then performs
// semantic compilation (board playability, schedule, the capability profile, the
// digest) — this module never touches any of that.
//
// Returns a deep-frozen NORMALIZED copy, never the caller's object: canonical
// defaults are applied here (`offsetTicks` omitted → 0; `immunities` deduped and
// sorted into enum order, `slow` before `stun`), so every downstream consumer
// (`compileRuleset`, `rulesetDigest`, a hand-built test fixture that bypasses
// `parseRulesetJson`) sees one canonical shape regardless of how the raw bundle
// was authored.

import type {
  BalanceConstants,
  Cell,
  CreepDef,
  EffectDef,
  Ruleset,
  RulesetBoard,
  ScoringConfig,
  TowerDef,
  WaveEntry,
  WaveSchedule,
} from '@wynding/types';
import { RulesetError } from './ruleset';

/** Parse-input text cap — 1,048,576 UTF-16 code units (`text.length`), counted
 *  identically in every JS runtime and checkable BEFORE `JSON.parse` at zero
 *  allocation cost. ~1 MiB for ASCII JSON; an anti-absurd bound, not a wire
 *  protocol. */
export const MAX_RULESET_TEXT_UNITS = 1_048_576;

const GENERIC_MAX = 1_000_000;
/** Shared by `rulesetId`, every catalog entry `id`, and `RulesetBoard.id`. */
const CATALOG_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Canonical immunity order — `slow` before `stun` (decision: "one hash form"). */
const IMMUNITY_ORDER = ['slow', 'stun'] as const;

/** Canonicalize an immunity list: dedupe (set semantics) then sort into enum order —
 *  ONE hash form regardless of authored order/repetition. Exported as the single
 *  implementation shared with `ruleset.ts`'s `normalizeForHash` (which re-applies it
 *  defensively for hand-built bundles): the canonical order is a `rulesetHash` input,
 *  so two copies drifting apart would silently re-bucket every two-immunity bundle. */
export function canonicalImmunities(immunities: readonly ('slow' | 'stun')[]): ('slow' | 'stun')[] {
  return [...new Set(immunities)].sort(
    (a, b) => IMMUNITY_ORDER.indexOf(a) - IMMUNITY_ORDER.indexOf(b),
  );
}

function isPosInt(v: unknown, max = GENERIC_MAX): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max;
}
function isNonNegInt(v: unknown, max = GENERIC_MAX): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isCatalogId(v: unknown): v is string {
  return typeof v === 'string' && CATALOG_ID_RE.test(v);
}

function requireRecord(v: unknown, where: string): Record<string, unknown> {
  if (!isRecord(v)) throw new RulesetError(`${where} must be an object`);
  return v;
}

function requireArray(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new RulesetError(`${where} must be an array`);
  return v;
}

/** Reject any key on `obj` outside `allowed` — strict unknown-key rejection at
 *  every nesting level (decision 3). */
function assertNoUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new RulesetError(`unknown property '${key}' in ${where}`);
    }
  }
}

/** Recursively freeze plain objects/arrays — mirrors `ruleset.ts`'s `deepFreeze`,
 *  duplicated here (rather than imported) so this module's normalized-copy
 *  contract doesn't depend on `ruleset.ts` internals beyond `RulesetError`. */
function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

function validateCell(raw: unknown, width: number, height: number, where: string): Cell {
  const rec = requireRecord(raw, where);
  assertNoUnknownKeys(rec, ['col', 'row'], where);
  if (!isNonNegInt(rec.col) || rec.col >= width) {
    throw new RulesetError(`${where}.col must be an in-bounds int (0..${width - 1})`);
  }
  if (!isNonNegInt(rec.row) || rec.row >= height) {
    throw new RulesetError(`${where}.row must be an in-bounds int (0..${height - 1})`);
  }
  return { col: rec.col, row: rec.row };
}

function validateCreepDef(raw: unknown, index: number): CreepDef {
  const rec = requireRecord(raw, `creepCatalog[${index}]`);
  assertNoUnknownKeys(
    rec,
    ['id', 'hp', 'speedFp', 'armor', 'domain', 'immunities', 'role', 'leakCost', 'bounty'],
    `creepCatalog[${index}]`,
  );
  if (!isCatalogId(rec.id)) {
    throw new RulesetError(`creepCatalog[${index}].id must match ^[a-z][a-z0-9-]{0,31}$`);
  }
  if (!isPosInt(rec.hp)) throw new RulesetError(`creepCatalog[${index}].hp must be a positive int`);
  if (!isPosInt(rec.speedFp)) {
    throw new RulesetError(`creepCatalog[${index}].speedFp must be a positive int`);
  }
  if (!isNonNegInt(rec.armor)) throw new RulesetError(`creepCatalog[${index}].armor must be ≥ 0`);
  if (rec.domain !== 'ground' && rec.domain !== 'air') {
    throw new RulesetError(`creepCatalog[${index}].domain must be 'ground' or 'air'`);
  }
  const immunitiesArr = requireArray(rec.immunities, `creepCatalog[${index}].immunities`);
  if (immunitiesArr.length > 2) {
    throw new RulesetError(`creepCatalog[${index}].immunities may have at most 2 entries`);
  }
  for (const im of immunitiesArr) {
    if (im !== 'slow' && im !== 'stun') {
      throw new RulesetError(`creepCatalog[${index}].immunities entries must be 'slow' or 'stun'`);
    }
  }
  const immunities = canonicalImmunities(immunitiesArr as ('slow' | 'stun')[]);
  let role: 'boss' | undefined;
  if (rec.role !== undefined) {
    if (rec.role !== 'boss') throw new RulesetError(`creepCatalog[${index}].role must be 'boss'`);
    role = 'boss';
  }
  if (!isPosInt(rec.leakCost, 1000)) {
    throw new RulesetError(`creepCatalog[${index}].leakCost must be a positive int ≤ 1000`);
  }
  if (!isNonNegInt(rec.bounty)) throw new RulesetError(`creepCatalog[${index}].bounty must be ≥ 0`);

  const def: CreepDef = {
    id: rec.id,
    hp: rec.hp,
    speedFp: rec.speedFp,
    armor: rec.armor,
    domain: rec.domain,
    immunities,
    leakCost: rec.leakCost,
    bounty: rec.bounty,
  };
  return role === undefined ? def : { ...def, role };
}

function validateEffectDef(raw: unknown, effIndex: number, parent: string): EffectDef {
  const where = `${parent}.effects[${effIndex}]`;
  const rec = requireRecord(raw, where);
  const kind = rec.kind;

  if (kind === 'direct' || kind === 'burst') {
    const form = rec.form;
    if (form === 'single') {
      assertNoUnknownKeys(rec, ['kind', 'form', 'damage'], where);
      if (!isPosInt(rec.damage)) throw new RulesetError(`${where}.damage must be a positive int`);
      return { kind, form: 'single', damage: rec.damage };
    }
    if (form === 'aoe') {
      assertNoUnknownKeys(rec, ['kind', 'form', 'damage', 'radiusFp'], where);
      if (!isPosInt(rec.damage)) throw new RulesetError(`${where}.damage must be a positive int`);
      if (!isPosInt(rec.radiusFp))
        throw new RulesetError(`${where}.radiusFp must be a positive int`);
      return { kind, form: 'aoe', damage: rec.damage, radiusFp: rec.radiusFp };
    }
    throw new RulesetError(`${where}.form must be 'single' or 'aoe'`);
  }
  if (kind === 'slow') {
    assertNoUnknownKeys(rec, ['kind', 'mulFp', 'durationTicks'], where);
    if (!isPosInt(rec.mulFp, 255)) throw new RulesetError(`${where}.mulFp must be 1..255`);
    if (!isPosInt(rec.durationTicks)) {
      throw new RulesetError(`${where}.durationTicks must be a positive int`);
    }
    return { kind: 'slow', mulFp: rec.mulFp, durationTicks: rec.durationTicks };
  }
  if (kind === 'stun') {
    assertNoUnknownKeys(rec, ['kind', 'chanceNum', 'durationTicks'], where);
    if (!isPosInt(rec.chanceNum, 256)) throw new RulesetError(`${where}.chanceNum must be 1..256`);
    if (!isPosInt(rec.durationTicks)) {
      throw new RulesetError(`${where}.durationTicks must be a positive int`);
    }
    return { kind: 'stun', chanceNum: rec.chanceNum, durationTicks: rec.durationTicks };
  }
  if (kind === 'dot') {
    assertNoUnknownKeys(rec, ['kind', 'damagePerTick', 'cadenceTicks', 'durationTicks'], where);
    if (!isPosInt(rec.damagePerTick)) {
      throw new RulesetError(`${where}.damagePerTick must be a positive int`);
    }
    if (!isPosInt(rec.cadenceTicks)) {
      throw new RulesetError(`${where}.cadenceTicks must be a positive int`);
    }
    if (!isPosInt(rec.durationTicks)) {
      throw new RulesetError(`${where}.durationTicks must be a positive int`);
    }
    if (rec.durationTicks < rec.cadenceTicks) {
      throw new RulesetError(
        `${where}.durationTicks must be ≥ cadenceTicks (a DoT must tick ≥ once)`,
      );
    }
    return {
      kind: 'dot',
      damagePerTick: rec.damagePerTick,
      cadenceTicks: rec.cadenceTicks,
      durationTicks: rec.durationTicks,
    };
  }
  if (kind === 'support') {
    assertNoUnknownKeys(rec, ['kind', 'damageMulFp'], where);
    if (!isPosInt(rec.damageMulFp) || rec.damageMulFp <= 256) {
      throw new RulesetError(`${where}.damageMulFp must be 257..1e6 (must strengthen)`);
    }
    return { kind: 'support', damageMulFp: rec.damageMulFp };
  }
  throw new RulesetError(`${where} has unknown kind '${String(kind)}'`);
}

function validateAttack(
  raw: unknown,
  hasBurst: boolean,
  towerIndex: number,
): NonNullable<TowerDef['attack']> {
  const where = `towerCatalog[${towerIndex}].attack`;
  const rec = requireRecord(raw, where);
  assertNoUnknownKeys(rec, ['domain', 'rangeFp', 'cadenceTicks', 'travelTicks'], where);
  if (rec.domain !== 'ground' && rec.domain !== 'air' && rec.domain !== 'both') {
    throw new RulesetError(`${where}.domain must be 'ground', 'air', or 'both'`);
  }
  if (!isPosInt(rec.rangeFp)) throw new RulesetError(`${where}.rangeFp must be a positive int`);
  if (!isPosInt(rec.travelTicks))
    throw new RulesetError(`${where}.travelTicks must be a positive int`);

  if (hasBurst) {
    if (rec.cadenceTicks !== undefined) {
      throw new RulesetError(
        `${where}.cadenceTicks must be omitted for a burst bundle (single-use)`,
      );
    }
    return { domain: rec.domain, rangeFp: rec.rangeFp, travelTicks: rec.travelTicks };
  }
  if (!isPosInt(rec.cadenceTicks)) {
    throw new RulesetError(
      `${where}.cadenceTicks must be a positive int (required unless bursting)`,
    );
  }
  // travelTicks < cadenceTicks keeps ≤1 impact in flight per tower (unchanged from v1).
  if (rec.travelTicks >= rec.cadenceTicks) {
    throw new RulesetError(`${where}.travelTicks must be less than cadenceTicks`);
  }
  return {
    domain: rec.domain,
    rangeFp: rec.rangeFp,
    cadenceTicks: rec.cadenceTicks,
    travelTicks: rec.travelTicks,
  };
}

function validateTowerDef(raw: unknown, index: number): TowerDef {
  const where = `towerCatalog[${index}]`;
  const rec = requireRecord(raw, where);
  assertNoUnknownKeys(rec, ['id', 'cost', 'attack', 'effects'], where);
  if (!isCatalogId(rec.id)) throw new RulesetError(`${where}.id must match ^[a-z][a-z0-9-]{0,31}$`);
  if (!isPosInt(rec.cost)) throw new RulesetError(`${where}.cost must be a positive int`);

  const effectsArr = requireArray(rec.effects, `${where}.effects`);
  if (effectsArr.length < 1 || effectsArr.length > 8) {
    throw new RulesetError(`${where}.effects must have 1..8 entries`);
  }
  const effects = effectsArr.map((e, i) => validateEffectDef(e, i, where));
  const supportCount = effects.filter((e) => e.kind === 'support').length;
  const burstCount = effects.filter((e) => e.kind === 'burst').length;

  // `support` is exclusive: the bundle's only effect, and carries no `attack`.
  if (supportCount > 0 && (effects.length !== 1 || rec.attack !== undefined)) {
    throw new RulesetError(
      `${where} a support effect must be the bundle's only effect and carry no attack`,
    );
  }
  if (burstCount > 1) {
    throw new RulesetError(`${where} a bundle may have at most one burst effect`);
  }

  if (supportCount > 0) {
    return { id: rec.id, cost: rec.cost, effects };
  }
  if (rec.attack === undefined) {
    throw new RulesetError(`${where} a non-support bundle requires attack`);
  }
  const attack = validateAttack(rec.attack, burstCount > 0, index);
  return { id: rec.id, cost: rec.cost, attack, effects };
}

function validateBalance(raw: unknown): BalanceConstants {
  const rec = requireRecord(raw, 'balance');
  assertNoUnknownKeys(
    rec,
    [
      'startingLives',
      'startingBounty',
      'refundNum',
      'refundDen',
      'slowFloorNum',
      'slowFloorDen',
      'earlyCallBountyDivisor',
    ],
    'balance',
  );
  if (!isPosInt(rec.startingLives))
    throw new RulesetError('balance.startingLives must be a positive int');
  if (!isNonNegInt(rec.startingBounty))
    throw new RulesetError('balance.startingBounty must be ≥ 0');
  if (!isNonNegInt(rec.refundNum)) throw new RulesetError('balance.refundNum must be ≥ 0');
  if (!isPosInt(rec.refundDen)) throw new RulesetError('balance.refundDen must be a positive int');
  if (rec.refundNum > rec.refundDen) throw new RulesetError('balance refund fraction must be ≤ 1');
  if (!isNonNegInt(rec.slowFloorNum)) throw new RulesetError('balance.slowFloorNum must be ≥ 0');
  if (!isPosInt(rec.slowFloorDen))
    throw new RulesetError('balance.slowFloorDen must be a positive int');
  if (rec.slowFloorNum > rec.slowFloorDen) {
    throw new RulesetError('balance slowFloor fraction must be ≤ 1');
  }
  if (!isNonNegInt(rec.earlyCallBountyDivisor)) {
    throw new RulesetError('balance.earlyCallBountyDivisor must be ≥ 0');
  }
  return {
    startingLives: rec.startingLives,
    startingBounty: rec.startingBounty,
    refundNum: rec.refundNum,
    refundDen: rec.refundDen,
    slowFloorNum: rec.slowFloorNum,
    slowFloorDen: rec.slowFloorDen,
    earlyCallBountyDivisor: rec.earlyCallBountyDivisor,
  };
}

function validateScoring(raw: unknown): ScoringConfig {
  const rec = requireRecord(raw, 'scoring');
  assertNoUnknownKeys(rec, ['survivalMul', 'starThresholds', 'earlyCallScoreDivisor'], 'scoring');
  if (!isNonNegInt(rec.survivalMul)) throw new RulesetError('scoring.survivalMul must be ≥ 0');
  const t = rec.starThresholds;
  if (!Array.isArray(t) || t.length !== 3 || !t.every((x) => isPosInt(x))) {
    throw new RulesetError('scoring.starThresholds must be three positive ints');
  }
  if (!(t[0]! <= t[1]! && t[1]! <= t[2]!)) {
    throw new RulesetError('scoring.starThresholds must be non-decreasing');
  }
  if (!isNonNegInt(rec.earlyCallScoreDivisor)) {
    throw new RulesetError('scoring.earlyCallScoreDivisor must be ≥ 0');
  }
  return {
    survivalMul: rec.survivalMul,
    starThresholds: [t[0] as number, t[1] as number, t[2] as number],
    earlyCallScoreDivisor: rec.earlyCallScoreDivisor,
  };
}

function validateWaveEntry(
  raw: unknown,
  index: number,
  creepIds: ReadonlySet<string>,
  parent: string,
): WaveEntry {
  const where = `${parent}.entries[${index}]`;
  const rec = requireRecord(raw, where);
  assertNoUnknownKeys(rec, ['creepId', 'count', 'spacingTicks', 'offsetTicks'], where);
  if (typeof rec.creepId !== 'string' || !creepIds.has(rec.creepId)) {
    throw new RulesetError(`${where} references unknown creepId '${String(rec.creepId)}'`);
  }
  if (!isPosInt(rec.count)) throw new RulesetError(`${where}.count must be a positive int`);
  if (!isPosInt(rec.spacingTicks))
    throw new RulesetError(`${where}.spacingTicks must be a positive int`);
  let offsetTicks = 0; // canonical default, applied at parse
  if (rec.offsetTicks !== undefined) {
    if (!isNonNegInt(rec.offsetTicks)) throw new RulesetError(`${where}.offsetTicks must be ≥ 0`);
    offsetTicks = rec.offsetTicks;
  }
  return { creepId: rec.creepId, count: rec.count, spacingTicks: rec.spacingTicks, offsetTicks };
}

function validateWaveSchedule(
  raw: unknown,
  index: number,
  creepIds: ReadonlySet<string>,
  parent: string,
): WaveSchedule {
  const where = `${parent}.waves[${index}]`;
  const rec = requireRecord(raw, where);
  assertNoUnknownKeys(rec, ['index', 'countdownTicks', 'clearBonus', 'entries'], where);
  if (!isNonNegInt(rec.index) || rec.index !== index) {
    throw new RulesetError(`${where}.index must equal its array position (${index})`);
  }
  if (!isPosInt(rec.countdownTicks))
    throw new RulesetError(`${where}.countdownTicks must be a positive int`);
  if (!isNonNegInt(rec.clearBonus)) throw new RulesetError(`${where}.clearBonus must be ≥ 0`);
  const entriesArr = requireArray(rec.entries, `${where}.entries`);
  if (entriesArr.length < 1 || entriesArr.length > 16) {
    throw new RulesetError(`${where}.entries must have 1..16 entries`);
  }
  const entries = entriesArr.map((e, i) => validateWaveEntry(e, i, creepIds, where));
  return { index, countdownTicks: rec.countdownTicks, clearBonus: rec.clearBonus, entries };
}

function validateBoard(raw: unknown, index: number, creepIds: ReadonlySet<string>): RulesetBoard {
  const where = `boards[${index}]`;
  const rec = requireRecord(raw, where);
  assertNoUnknownKeys(rec, ['id', 'widthTiles', 'heightTiles', 'entrance', 'exit', 'waves'], where);
  if (!isCatalogId(rec.id)) throw new RulesetError(`${where}.id must match ^[a-z][a-z0-9-]{0,31}$`);
  if (!isPosInt(rec.widthTiles))
    throw new RulesetError(`${where}.widthTiles must be a positive int`);
  if (!isPosInt(rec.heightTiles))
    throw new RulesetError(`${where}.heightTiles must be a positive int`);
  const entrance = validateCell(rec.entrance, rec.widthTiles, rec.heightTiles, `${where}.entrance`);
  const exit = validateCell(rec.exit, rec.widthTiles, rec.heightTiles, `${where}.exit`);
  const wavesArr = requireArray(rec.waves, `${where}.waves`);
  if (wavesArr.length < 1 || wavesArr.length > 64) {
    throw new RulesetError(`${where}.waves must have 1..64 entries`);
  }
  const waves = wavesArr.map((w, i) => validateWaveSchedule(w, i, creepIds, where));
  return {
    id: rec.id,
    widthTiles: rec.widthTiles,
    heightTiles: rec.heightTiles,
    entrance,
    exit,
    waves,
  };
}

const TOP_LEVEL_KEYS = [
  'formatVersion',
  'rulesetId',
  'version',
  'creepCatalog',
  'towerCatalog',
  'balance',
  'scoring',
  'boards',
] as const;

/**
 * The v2 structural validator: types, bounds, id patterns, catalog/board id
 * uniqueness, cross-field rules, and strict unknown-key rejection at every nesting
 * level. Throws {@link RulesetError} on the first violation; on success, returns a
 * DEEP-FROZEN NORMALIZED COPY (never the caller's object) with canonical defaults
 * applied (`offsetTicks` omitted → 0; `immunities` deduped and sorted).
 */
export function validateRulesetShape(value: unknown): Ruleset {
  const raw = requireRecord(value, 'ruleset');
  assertNoUnknownKeys(raw, TOP_LEVEL_KEYS, 'ruleset');

  if (raw.formatVersion !== 2) {
    throw new RulesetError(`unsupported formatVersion ${String(raw.formatVersion)} (supported: 2)`);
  }
  if (!isCatalogId(raw.rulesetId)) {
    throw new RulesetError('rulesetId must match ^[a-z][a-z0-9-]{0,31}$');
  }
  if (!isNonNegInt(raw.version)) throw new RulesetError('version must be a non-negative int');

  const creepArr = requireArray(raw.creepCatalog, 'creepCatalog');
  if (creepArr.length < 1 || creepArr.length > 64) {
    throw new RulesetError('creepCatalog must have 1..64 entries');
  }
  const creepCatalog: CreepDef[] = [];
  const creepIds = new Set<string>();
  creepArr.forEach((c, i) => {
    const def = validateCreepDef(c, i);
    if (creepIds.has(def.id)) throw new RulesetError(`duplicate creep id '${def.id}'`);
    creepIds.add(def.id);
    creepCatalog.push(def);
  });

  const towerArr = requireArray(raw.towerCatalog, 'towerCatalog');
  if (towerArr.length < 1 || towerArr.length > 64) {
    throw new RulesetError('towerCatalog must have 1..64 entries');
  }
  const towerCatalog: TowerDef[] = [];
  const towerIds = new Set<string>();
  towerArr.forEach((t, i) => {
    const def = validateTowerDef(t, i);
    if (towerIds.has(def.id)) throw new RulesetError(`duplicate tower id '${def.id}'`);
    towerIds.add(def.id);
    towerCatalog.push(def);
  });

  const balance = validateBalance(raw.balance);
  const scoring = validateScoring(raw.scoring);

  const boardArr = requireArray(raw.boards, 'boards');
  if (boardArr.length < 1 || boardArr.length > 16) {
    throw new RulesetError('boards must have 1..16 entries');
  }
  const boards: RulesetBoard[] = [];
  const boardIds = new Set<string>();
  boardArr.forEach((b, i) => {
    const def = validateBoard(b, i, creepIds);
    if (boardIds.has(def.id)) throw new RulesetError(`duplicate board id '${def.id}'`);
    boardIds.add(def.id);
    boards.push(def);
  });

  const normalized: Ruleset = {
    formatVersion: 2,
    rulesetId: raw.rulesetId,
    version: raw.version,
    creepCatalog,
    towerCatalog,
    balance,
    scoring,
    boards,
  };
  return deepFreeze(normalized);
}

/**
 * Parse + validate ruleset JSON text: enforces {@link MAX_RULESET_TEXT_UNITS}
 * (UTF-16 code units, via `text.length`) BEFORE `JSON.parse` — allocation-free and
 * identical in every JS runtime — then `JSON.parse`, then {@link validateRulesetShape}.
 * A parse failure becomes a `RulesetError` so every caller sees one error family.
 */
export function parseRulesetJson(text: string): Ruleset {
  if (text.length > MAX_RULESET_TEXT_UNITS) {
    throw new RulesetError(
      `ruleset JSON text exceeds the ${MAX_RULESET_TEXT_UNITS}-UTF-16-code-unit cap`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new RulesetError(`ruleset JSON is not parseable: ${(err as Error).message}`);
  }
  return validateRulesetShape(value);
}
