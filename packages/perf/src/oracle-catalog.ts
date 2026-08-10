// oracle-catalog.ts — the catalog scene's own oracle (M2-S11 P7).
//
// A SEPARATE module from `oracle.ts`, deliberately. That one is the stress scene's
// oracle: its thresholds are stress-scene measurements, its `OracleInput` is shaped by
// `harness.ts`'s two-pass `SampledTick`, and it feeds the ratio gate. The catalog scene
// emits no `R`, feeds no gate, and asserts a different set of things (per-kind creep
// equalities, engagement probes over `state.impacts`, a burst probe and a leak probe that
// both run PAST the sampling window). Sharing one module would mean widening the stress
// oracle's input shape for rows it never checks — so this scene brings its own, and
// `oracle.ts` is left byte-identical.
//
// EVERYTHING HERE IS STATE-DERIVED, in ONE UNTIMED pass. No wall-clock is read anywhere
// in this file or in `run-catalog.ts`: the catalog scene's timing measurement is the
// BROWSER frame-time spike (`apps/web/e2e-perf/catalog.perf.spec.ts`), and this Node
// process exists only to prove the scene is the workload it declares. That separation is
// why `perf:catalog` is its own process: the ratio harness never runs in it, so it cannot
// be warmed or contaminated by it.

import {
  compileRuleset,
  createInitialState,
  step,
  countValidTowers,
  materializeTowerMask,
  computeDistanceField,
  shortestPath,
  type CompiledRuleset,
  type SimPhase,
  type SimState,
  type StepEvents,
} from '@wynding/sim';
import type { Replay } from '@wynding/replay';
import type { Ruleset } from '@wynding/types';
import { CATALOG_BUILD_TICKS } from './scenario';
import {
  catalogRoutePath,
  CATALOG_MINE_PADS,
  CATALOG_DETONATOR_PAD_COUNT,
  CATALOG_DETONATOR_LOWER_BOUND_TICKS,
  CATALOG_TOWER_COUNT,
} from './layout';

// ── The scene's timing constants ───────────────────────────────────────────────

/** Ticks of settling AFTER the replay's build-tick prefix resolves, before the sample
 *  window opens. A NEW constant with distinct semantics from `harness.ts`'s
 *  `WARMUP_TICKS`, which is ABSOLUTE from tick 0 — this one is RELATIVE to the end of
 *  the build. Distinct name, distinct meaning; do not unify them.
 *
 *  This constant is held at 1,000 and the ABSOLUTE window is derived from it. The packet
 *  originally pinned both 1,000 AND an absolute window of [1050, 3549], which were
 *  consistent only while the scene placed 150 towers in 50 build ticks; the amendment
 *  that moved the mines onto their own pads makes the build 55 ticks (165 placements at
 *  3/tick), and the two can no longer both hold. The named constant wins, because
 *  "relative to the end of the build" is its whole stated reason for existing. */
export const CATALOG_WARMUP_AFTER_BUILD_TICKS = 1000;

/** The sample window's first ABSOLUTE tick — 55 build ticks + 1000 settling = 1055. */
export const CATALOG_SAMPLE_START_TICK = CATALOG_BUILD_TICKS + CATALOG_WARMUP_AFTER_BUILD_TICKS;

/** Sampled ticks — 2,500, so the window is the CLOSED range [1055, 3554] under the
 *  harness's own `start + SAMPLE_TICKS - 1` convention. A closed [1055, 3555] would be
 *  2,501 samples and contradict it. */
export const CATALOG_SAMPLE_TICKS = 2_500;

/** The window's last absolute tick — 3,554. */
export const CATALOG_SAMPLE_END_TICK = CATALOG_SAMPLE_START_TICK + CATALOG_SAMPLE_TICKS - 1;

/** The untimed pass's total length. It runs PAST the window — that extension is where
 *  both the burst probe (the ten detonations, observed at ticks 3,559..3,720) and the
 *  multi-life leak probe (the first `cat-heavy` leak, route-cost-bounded at ≥ 3,761 and
 *  observed at 3,802) find their witnesses. The cap exists so a scene that stops
 *  detonating or stops leaking fails loudly instead of running forever. */
export const CATALOG_LEAK_PROBE_MAX_TICK = 6_000;

// ── The scene's declared thresholds ───────────────────────────────────────────

/** Exact live count per ground-family kind at EVERY sampled tick. 6 × 19 `cat-ground`,
 *  4 × 19 `cat-immune`, 2 × 19 `cat-heavy` — all spawned by tick 399, none able to leak
 *  before tick 3,751 (≥ 100 + ⌈328 × 256 / 23⌉), and no combat death is reachable at
 *  1,000,000 hp (see `adversarialDamagePerTickMilli`). Equalities, not floors. */
export const GROUND_FAMILY_EXACT: Readonly<Record<string, number>> = {
  'cat-ground': 114,
  'cat-immune': 76,
  'cat-heavy': 38,
};
/** 114 + 76 + 38. */
export const GROUND_FAMILY_TOTAL = 228;
/** Steady-state floor on live `cat-air`: 4 streams × ⌊434 / 24⌋ = 72. An equality is
 *  impossible — air dwell depends on slow uptime — so air carries a floor. */
export const LIVE_AIR_FLOOR = 72;
/** 228 + 72, the sustained counterpart of ADR 0005's measured 304 peak. */
export const LIVE_CREEPS_FLOOR = 300;
/** Live towers at EVERY sampled tick. A flat 165 — every mine pad is route-neutral, so no
 *  detonation changes the maze, and none lands inside the window: the earliest the scene
 *  actually produces is tick 3,559, five ticks past the close. That is an OBSERVED margin,
 *  not a proven one (`layout.ts`'s `CATALOG_DETONATOR_LOWER_BOUND_TICKS` explains why the
 *  strict bound, 3,553, cannot carry the claim), which is why the burst rows below assert
 *  it from the observed detonation count and the window's minimum tower count rather than
 *  from the bound table. */
export const LIVE_TOWERS_EXACT = CATALOG_TOWER_COUNT;
/** Live towers once all ten detonators have fired — 165 − 10. */
export const POST_DETONATION_TOWERS = CATALOG_TOWER_COUNT - CATALOG_DETONATOR_PAD_COUNT;
/** Placements accepted after the build prefix. */
export const PLACEMENTS_EXACT = CATALOG_TOWER_COUNT;
/** Bounty left after the build prefix — the placement table's cost is the bundle's entire
 *  `startingBounty` (1,601), so anything but 0 means a placement was silently refused. */
export const LEFTOVER_BOUNTY_EXACT = 0;
/** The scene's committed route length, inherited from the stress geometry. */
export const CATALOG_ROUTE_LENGTH = 329;
/** Sampled ticks carrying ≥ 1 stunned creep. Re-pinned from the proposed 1,000 by owner
 *  ruling (Rob, 2026-08-09, S11 close-out) at the measured 531: the ground family walks
 *  the 329-cell route as a ~27-cell convoy, so only ~1-2 of the 19 stun sources are in
 *  contact at any tick — the proposed value assumed all sources simultaneous. */
export const STUNNED_SAMPLES_FLOOR = 400;
/** Peak simultaneously-slowed creeps. */
export const PEAK_SLOWED_FLOOR = 50;
/** Peak resident DoT records (19 `venom` sources). Re-pinned from the proposed 20 by the
 *  same owner ruling at the measured 12 — the same convoy arithmetic caps concurrent
 *  venom contact at ~6 sources. */
export const PEAK_DOT_RECORDS_FLOOR = 10;
/** DoT applications dropped for want of table capacity, over the WHOLE run. */
export const DOT_DROPPED_EXACT = 0;
/** Impacts observed in flight whose snapshotted `effects[].amount` exceeds the source
 *  kind's unbuffed authored amount — the support aura, witnessed in resident state. */
export const SUPPORT_PROBE_FLOOR = 100;
/** Slow-bearing impacts observed in flight targeting a `cat-immune` creep. */
export const IMMUNITY_PROBE_FLOOR = 100;
/** Impacts observed in flight bound to an air-domain creep. */
export const AIR_PROBE_FLOOR = 100;

/** The seven attacking kinds' placement counts over the 135 non-beacon anchors — the
 *  basis the adversarial damage ceiling is computed over. Declared, not read back from
 *  the realized SoA: the ceiling must bound the whole probe pass. */
export const CATALOG_ATTACKER_COUNTS: Readonly<Record<string, number>> = {
  basic: 20,
  slow: 20,
  splash: 19,
  venom: 19,
  stun: 19,
  antiair: 19,
  'frost-splash': 19,
};

// ── Result shapes ─────────────────────────────────────────────────────────────

/** One sampled tick's state-derived record. */
export interface CatalogSample {
  readonly tick: number;
  readonly phase: SimPhase;
  readonly liveCreeps: number;
  /** Live count per catalog creep id. */
  readonly byKind: Readonly<Record<string, number>>;
  readonly slowedCreeps: number;
  readonly stunnedCreeps: number;
  readonly dotRecords: number;
  readonly liveTowers: number;
  /** True iff EVERY live `cat-immune` row reads `slowMulFp === 0 && slowUntilTick === 0
   *  && stunUntilTick === 0` this tick. */
  readonly immuneColumnsClean: boolean;
}

/** One leaked creep, as enumerated by the SoA diff across the leak tick. */
export interface LeakedCreep {
  readonly id: number;
  readonly creepId: string;
  readonly leakCost: number;
}

/** The multi-life leak probe's witness. */
export interface LeakProbeResult {
  readonly tick: number;
  readonly leaked: readonly LeakedCreep[];
  readonly livesDelta: number;
  readonly expectedDelta: number;
  readonly heavySummand: number;
  readonly heavyCount: number;
}

/** Everything `run-catalog.ts` reports on. */
export interface CatalogSceneResult {
  readonly compiled: CompiledRuleset;
  readonly samples: readonly CatalogSample[];
  readonly towersAfterBuild: number;
  readonly leftoverBountyAfterBuild: number;
  readonly towersAtWindowStart: number;
  readonly minTowersInWindow: number;
  /** Every tick at which the live-tower count fell, one entry PER TOWER LOST, ascending. */
  readonly detonationTicks: readonly number[];
  readonly finalTowers: number;
  /** True iff a live tower still stands on each of the five survivor pads at run end. */
  readonly survivorsAliveAtEnd: number;
  readonly asBuiltRoute: readonly { col: number; row: number }[];
  /** The route recomputed from the REALIZED tower SoA at the end of the probe pass —
   *  i.e. after every detonation. */
  readonly postDetonationRoute: readonly { col: number; row: number }[];
  readonly dotDroppedTotal: number;
  readonly supportProbeImpacts: number;
  readonly immunityProbeImpacts: number;
  readonly airProbeImpacts: number;
  readonly leak: LeakProbeResult | null;
  readonly adversarialDamageCeiling: number;
  readonly creepHp: number;
  /** DIAGNOSTIC, not an assertion: how many DISTINCT towers of each kind ever fired a
   *  shot during the whole probe pass, against how many were placed. The ground family
   *  spawns across only 299 ticks (100..399) at 23 fp/tick, so it travels the route as a
   *  ~6,877 fp convoy — roughly 27 cells of a 329-cell route — and only the towers whose
   *  range covers that moving band can ever engage. This is the number that explains a
   *  status-floor miss, so it is reported alongside the rows rather than left to be
   *  re-derived by whoever reads the failure. */
  readonly firingTowersByKind: Readonly<Record<string, number>>;
  readonly placedTowersByKind: Readonly<Record<string, number>>;
}

/** One reported oracle row. */
export interface CatalogAssertion {
  readonly name: string;
  readonly measured: number | string | boolean;
  readonly bound: string;
  readonly pass: boolean;
}

// ── The run ───────────────────────────────────────────────────────────────────

function routeFromLiveTowers(
  compiled: CompiledRuleset,
  state: SimState,
): readonly { col: number; row: number }[] {
  const grid = compiled.board.grid;
  const mask = materializeTowerMask(grid, state.towers, compiled.towerById);
  const field = computeDistanceField(grid, mask);
  return shortestPath(grid, field, grid.entrance) ?? [];
}

/**
 * The adversarial per-tick damage ceiling for ONE creep, recomputed from the compiled
 * bundle rather than restated: every attacking tower of every kind firing exclusively at
 * that creep, every blast catching it, every source buffed by a beacon (×`damageMulFp` /
 * 256), all DoT resident. Returned in HP per tick, ×1000 so the arithmetic stays integer
 * (the caller divides). Deliberately generous in every direction — armor ignored, no
 * travel time, no cadence phase — because its job is to prove a headroom, not to predict.
 */
export function adversarialDamagePerTickMilli(
  compiled: CompiledRuleset,
  counts: Readonly<Record<string, number>>,
): number {
  const beacon = compiled.towerById['beacon'];
  const mulFp = beacon?.support?.damageMulFp ?? 256;
  let milli = 0;
  for (const [towerId, n] of Object.entries(counts)) {
    const def = compiled.towerById[towerId];
    if (def === undefined) throw new Error(`adversarial ceiling: unknown tower '${towerId}'`);
    const attack = def.attack;
    if (attack === undefined || attack.mode !== 'cadenced') continue;
    for (const e of def.effects) {
      if (e.kind === 'direct' || e.kind === 'aoe') {
        milli += Math.ceil((1000 * n * e.amount * mulFp) / (256 * attack.cadenceTicks));
      } else if (e.kind === 'dot') {
        milli += Math.ceil((1000 * n * e.amount * mulFp) / (256 * e.cadenceTicks));
      }
    }
  }
  return milli;
}

/**
 * Runs the catalog replay against the catalog bundle for the whole probe pass — build
 * prefix, warm-up, the 2,500-tick sample window, and then onward to
 * `CATALOG_LEAK_PROBE_MAX_TICK`, where the burst probe's ten detonations and the
 * multi-life leak probe's first `cat-heavy` leak both land.
 *
 * ONE pass, not two: nothing here is timed, so there is no timed/untimed split to make.
 * The loop is this module's own rather than `harness.ts`'s `runSampled` for two reasons
 * that are structural, not stylistic — `runSampled` runs a FIXED `WARMUP_TICKS +
 * SAMPLE_TICKS` length with no way to extend past the window, and it collects none of the
 * resident-state fields the engagement probes read (`state.impacts`, the creep SoA's
 * status columns). `harness.ts` is left untouched.
 */
export function runCatalogScene(replay: Replay, bundle: Ruleset): CatalogSceneResult {
  const compiled = compileRuleset(bundle, replay.boardId);
  const grid = compiled.board.grid;
  let state: SimState = createInitialState(replay.seed, compiled);

  const samples: CatalogSample[] = [];
  let towersAfterBuild = -1;
  let leftoverBountyAfterBuild = -1;
  let towersAtWindowStart = -1;
  let minTowersInWindow = Number.POSITIVE_INFINITY;
  let finalTowers = -1;
  let dotDroppedTotal = 0;
  const detonationTicks: number[] = [];

  // Engagement probes. Impacts are re-canonicalized (fresh objects) every tick, so an
  // impact is identified STRUCTURALLY, not by reference: a tower holds at most one impact
  // in flight, so `sourceId:impactTick` is unique per FIRE and counts each fired impact
  // exactly once however many ticks it stays resident.
  const seenImpacts = new Set<string>();
  let supportProbeImpacts = 0;
  let immunityProbeImpacts = 0;
  let airProbeImpacts = 0;
  // Entity id -> catalog id, accumulated from the live SoAs (a consumed mine or a leaked
  // creep must still resolve when an impact it is bound to is inspected).
  const towerKindById = new Map<number, string>();
  const creepKindById = new Map<number, string>();
  // Distinct firing tower ids per kind — the diagnostic behind any status-floor miss.
  const firingSources = new Map<string, Set<number>>();

  // The unbuffed authored amount per (tower kind, effect index) — what a snapshotted
  // `effects[].amount` must EXCEED for the support probe to count it.
  const baseAmounts = new Map<string, number[]>();
  for (const tower of compiled.towers) {
    baseAmounts.set(
      tower.id,
      tower.effects.map((e) =>
        e.kind === 'direct' || e.kind === 'aoe' || e.kind === 'dot' ? e.amount : 0,
      ),
    );
  }

  let leak: LeakProbeResult | null = null;
  const buildLastTick = replay.tickInputs.length - 1;
  let previousTowers = 0;

  for (let tick = 0; tick <= CATALOG_LEAK_PROBE_MAX_TICK; tick++) {
    const inputs = replay.tickInputs[tick] ?? [];
    const events: StepEvents = { impactPoints: [], fired: [], dotTicks: 0, dotDropped: 0 };

    // Pre-step snapshot for the leak probe's SoA diff — id -> catalog id and the lives
    // count, taken before `step` removes anything.
    const beforeIds = new Map<number, string>();
    for (let i = 0; i < state.creeps.id.length; i++) {
      beforeIds.set(state.creeps.id[i]!, state.creeps.creepId[i]!);
    }
    const livesBefore = state.lives;

    state = step(state, compiled, inputs, events);
    dotDroppedTotal += events.dotDropped ?? 0;

    for (let i = 0; i < state.towers.id.length; i++) {
      towerKindById.set(state.towers.id[i]!, state.towers.towerId[i]!);
    }
    for (let i = 0; i < state.creeps.id.length; i++) {
      creepKindById.set(state.creeps.id[i]!, state.creeps.creepId[i]!);
    }

    // Engagement probes — resident in-flight impacts, counted once per fire.
    for (const imp of state.impacts) {
      const key = `${imp.sourceId}:${imp.impactTick}:${imp.kind}`;
      if (seenImpacts.has(key)) continue;
      seenImpacts.add(key);
      const sourceKind = towerKindById.get(imp.sourceId);
      if (sourceKind !== undefined) {
        let seen = firingSources.get(sourceKind);
        if (seen === undefined) {
          seen = new Set<number>();
          firingSources.set(sourceKind, seen);
        }
        seen.add(imp.sourceId);
      }
      const base = sourceKind === undefined ? undefined : baseAmounts.get(sourceKind);
      if (base !== undefined) {
        for (let e = 0; e < imp.effects.length; e++) {
          const eff = imp.effects[e]!;
          const amount = eff.kind === 'direct' || eff.kind === 'dot' ? eff.amount : 0;
          if (amount > (base[e] ?? 0)) {
            supportProbeImpacts++;
            break;
          }
        }
      }
      if (imp.kind === 'targeted') {
        const targetKind = creepKindById.get(imp.targetId);
        if (targetKind === 'cat-immune' && imp.effects.some((e) => e.kind === 'slow')) {
          immunityProbeImpacts++;
        }
        if (targetKind === 'cat-air') airProbeImpacts++;
      }
    }

    const liveTowers = countValidTowers(grid, state.towers, compiled.towerById);
    finalTowers = liveTowers;
    // A burst tower is CONSUMED at its fire tick, so a fall in the valid-tower count is a
    // detonation. Recorded once per tower lost, so a tick that consumes two mines
    // contributes two entries — the probe counts detonations, not ticks.
    if (tick > buildLastTick && liveTowers < previousTowers) {
      for (let n = 0; n < previousTowers - liveTowers; n++) detonationTicks.push(tick);
    }
    previousTowers = liveTowers;

    if (tick === buildLastTick) {
      towersAfterBuild = liveTowers;
      leftoverBountyAfterBuild = state.bounty;
    }
    if (tick === CATALOG_SAMPLE_START_TICK) towersAtWindowStart = liveTowers;

    if (tick >= CATALOG_SAMPLE_START_TICK && tick <= CATALOG_SAMPLE_END_TICK) {
      if (liveTowers < minTowersInWindow) minTowersInWindow = liveTowers;
      const byKind: Record<string, number> = {};
      let slowed = 0;
      let stunned = 0;
      let immuneClean = true;
      for (let i = 0; i < state.creeps.id.length; i++) {
        const kind = state.creeps.creepId[i]!;
        byKind[kind] = (byKind[kind] ?? 0) + 1;
        const slowMul = state.creeps.slowMulFp[i]!;
        const slowUntil = state.creeps.slowUntilTick[i]!;
        const stunUntil = state.creeps.stunUntilTick[i]!;
        if (slowMul !== 0) slowed++;
        if (stunUntil !== 0) stunned++;
        if (kind === 'cat-immune' && (slowMul !== 0 || slowUntil !== 0 || stunUntil !== 0)) {
          immuneClean = false;
        }
      }
      samples.push({
        tick,
        phase: state.phase,
        liveCreeps: state.creeps.id.length,
        byKind,
        slowedCreeps: slowed,
        stunnedCreeps: stunned,
        dotRecords: state.dots.length,
        liveTowers,
        immuneColumnsClean: immuneClean,
      });
    }

    // Multi-life leak probe — armed only once the window has closed, so it can never
    // truncate the sampled series, and latched on the FIRST `cat-heavy` leak.
    if (leak === null && tick > CATALOG_SAMPLE_END_TICK) {
      const survivorIds = new Set(state.creeps.id);
      const leaked: LeakedCreep[] = [];
      for (const [id, creepId] of beforeIds) {
        if (survivorIds.has(id)) continue;
        const def = compiled.creepById[creepId];
        leaked.push({ id, creepId, leakCost: def?.leakCost ?? 0 });
      }
      if (leaked.some((l) => l.creepId === 'cat-heavy')) {
        const heavy = leaked.filter((l) => l.creepId === 'cat-heavy');
        leak = {
          tick,
          leaked,
          livesDelta: livesBefore - state.lives,
          expectedDelta: leaked.reduce((s, l) => s + l.leakCost, 0),
          heavySummand: heavy.reduce((s, l) => s + l.leakCost, 0),
          heavyCount: heavy.length,
        };
      }
    }
  }

  // Survivor pads still standing at run end, resolved against the realized tower SoA.
  const standing = new Set<string>();
  for (let i = 0; i < state.towers.id.length; i++) {
    standing.add(`${state.towers.col[i]},${state.towers.row[i]}`);
  }
  let survivorsAliveAtEnd = 0;
  for (const pad of CATALOG_MINE_PADS.slice(CATALOG_DETONATOR_PAD_COUNT)) {
    if (standing.has(`${pad.col},${pad.row}`)) survivorsAliveAtEnd++;
  }

  const perTickMilli = adversarialDamagePerTickMilli(compiled, CATALOG_ATTACKER_COUNTS);
  const mineDef = compiled.towerById['mine'];
  const mineAmount = mineDef?.effects.find((e) => e.kind === 'aoe')?.amount ?? 0;
  const beaconMul = compiled.towerById['beacon']?.support?.damageMulFp ?? 256;
  const mineTotal = Math.ceil((CATALOG_MINE_PADS.length * mineAmount * beaconMul) / 256);
  const adversarialDamageCeiling =
    // The probe loop is INCLUSIVE of CATALOG_LEAK_PROBE_MAX_TICK — 6,001 steps — so the
    // ceiling multiplies by max tick + 1 to genuinely bound the whole pass.
    Math.ceil((perTickMilli * (CATALOG_LEAK_PROBE_MAX_TICK + 1)) / 1000) + mineTotal;

  return {
    compiled,
    samples,
    towersAfterBuild,
    leftoverBountyAfterBuild,
    towersAtWindowStart,
    minTowersInWindow: minTowersInWindow === Number.POSITIVE_INFINITY ? -1 : minTowersInWindow,
    detonationTicks,
    finalTowers,
    survivorsAliveAtEnd,
    asBuiltRoute: catalogRoutePath(compiled),
    postDetonationRoute: routeFromLiveTowers(compiled, state),
    dotDroppedTotal,
    supportProbeImpacts,
    immunityProbeImpacts,
    airProbeImpacts,
    leak,
    adversarialDamageCeiling,
    creepHp: compiled.creepById['cat-ground']?.hp ?? 0,
    firingTowersByKind: Object.fromEntries(
      [...firingSources].map(([kind, ids]) => [kind, ids.size]),
    ),
    placedTowersByKind: (() => {
      const counts: Record<string, number> = { ...CATALOG_ATTACKER_COUNTS, beacon: 15, mine: 15 };
      return counts;
    })(),
  };
}

function sameRoute(
  a: readonly { col: number; row: number }[],
  b: readonly { col: number; row: number }[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.col !== b[i]!.col || a[i]!.row !== b[i]!.row) return false;
  }
  return true;
}

/** Folds a scene run into the packet's oracle rows, in the packet's own order. Pure —
 *  `run-catalog.ts` only prints and exits on what this returns. */
export function catalogAssertions(r: CatalogSceneResult): CatalogAssertion[] {
  const rows: CatalogAssertion[] = [];
  const add = (name: string, measured: number | string | boolean, bound: string, pass: boolean) =>
    rows.push({ name, measured, bound, pass });

  const s = r.samples;
  add('sampled ticks', s.length, `== ${CATALOG_SAMPLE_TICKS}`, s.length === CATALOG_SAMPLE_TICKS);

  for (const [kind, exact] of Object.entries(GROUND_FAMILY_EXACT)) {
    let minSeen = Number.POSITIVE_INFINITY;
    let maxSeen = 0;
    for (const t of s) {
      const n = t.byKind[kind] ?? 0;
      if (n < minSeen) minSeen = n;
      if (n > maxSeen) maxSeen = n;
    }
    add(
      `live ${kind}, every sampled tick`,
      minSeen === maxSeen ? minSeen : `${minSeen}..${maxSeen}`,
      `== ${exact}`,
      minSeen === exact && maxSeen === exact,
    );
  }
  {
    let minTotal = Number.POSITIVE_INFINITY;
    for (const t of s) {
      const n =
        (t.byKind['cat-ground'] ?? 0) +
        (t.byKind['cat-immune'] ?? 0) +
        (t.byKind['cat-heavy'] ?? 0);
      if (n < minTotal) minTotal = n;
    }
    add(
      'ground-family creeps, min over window',
      minTotal,
      `== ${GROUND_FAMILY_TOTAL}`,
      minTotal === GROUND_FAMILY_TOTAL,
    );
  }
  {
    let minAir = Number.POSITIVE_INFINITY;
    for (const t of s) {
      const n = t.byKind['cat-air'] ?? 0;
      if (n < minAir) minAir = n;
    }
    add('live cat-air, min over window', minAir, `>= ${LIVE_AIR_FLOOR}`, minAir >= LIVE_AIR_FLOOR);
  }
  {
    let minLive = Number.POSITIVE_INFINITY;
    for (const t of s) if (t.liveCreeps < minLive) minLive = t.liveCreeps;
    add(
      'total live creeps, min over window',
      minLive,
      `>= ${LIVE_CREEPS_FLOOR}`,
      minLive >= LIVE_CREEPS_FLOOR,
    );
  }
  {
    const bad = s.filter((t) => t.liveTowers !== LIVE_TOWERS_EXACT).length;
    add(
      'live towers, every sampled tick',
      bad === 0 ? LIVE_TOWERS_EXACT : `${bad} ticks off`,
      `== ${LIVE_TOWERS_EXACT}`,
      bad === 0,
    );
  }
  add(
    'route length, as-built',
    r.asBuiltRoute.length,
    `== ${CATALOG_ROUTE_LENGTH}`,
    r.asBuiltRoute.length === CATALOG_ROUTE_LENGTH,
  );
  add(
    'route CELL SEQUENCE, as-built vs post-detonation',
    sameRoute(r.asBuiltRoute, r.postDetonationRoute) ? 'identical' : 'DIFFERENT',
    'identical',
    sameRoute(r.asBuiltRoute, r.postDetonationRoute),
  );
  add(
    'accepted placements after build',
    r.towersAfterBuild,
    `== ${PLACEMENTS_EXACT}`,
    r.towersAfterBuild === PLACEMENTS_EXACT,
  );
  add(
    'leftover bounty after build',
    r.leftoverBountyAfterBuild,
    `== ${LEFTOVER_BOUNTY_EXACT}`,
    r.leftoverBountyAfterBuild === LEFTOVER_BOUNTY_EXACT,
  );
  {
    const bad = s.filter((t) => t.phase !== 'running').length;
    add(
      'phase, every sampled tick',
      bad === 0 ? 'running' : `${bad} non-running`,
      'running',
      bad === 0,
    );
  }
  {
    const n = s.filter((t) => t.stunnedCreeps >= 1).length;
    add(
      'samples with >= 1 stunned creep',
      n,
      `>= ${STUNNED_SAMPLES_FLOOR} of ${CATALOG_SAMPLE_TICKS}`,
      n >= STUNNED_SAMPLES_FLOOR,
    );
  }
  {
    const peak = s.reduce((m, t) => Math.max(m, t.slowedCreeps), 0);
    add('peak slowed creeps', peak, `>= ${PEAK_SLOWED_FLOOR}`, peak >= PEAK_SLOWED_FLOOR);
  }
  {
    const peak = s.reduce((m, t) => Math.max(m, t.dotRecords), 0);
    add(
      'peak resident DoT records',
      peak,
      `>= ${PEAK_DOT_RECORDS_FLOOR}`,
      peak >= PEAK_DOT_RECORDS_FLOOR,
    );
  }
  add(
    'dropped DoT applications',
    r.dotDroppedTotal,
    `== ${DOT_DROPPED_EXACT}`,
    r.dotDroppedTotal === DOT_DROPPED_EXACT,
  );
  add(
    'support probe (buffed in-flight impacts)',
    r.supportProbeImpacts,
    `>= ${SUPPORT_PROBE_FLOOR}`,
    r.supportProbeImpacts >= SUPPORT_PROBE_FLOOR,
  );
  add(
    'immunity probe (slow-bearing impacts on cat-immune)',
    r.immunityProbeImpacts,
    `>= ${IMMUNITY_PROBE_FLOOR}`,
    r.immunityProbeImpacts >= IMMUNITY_PROBE_FLOOR,
  );
  {
    const bad = s.filter((t) => !t.immuneColumnsClean).length;
    add(
      'immunity probe (cat-immune status columns all zero)',
      bad === 0 ? 'clean' : `${bad} dirty ticks`,
      'clean at every sampled tick',
      bad === 0,
    );
  }
  add(
    'air probe (impacts bound to air creeps)',
    r.airProbeImpacts,
    `>= ${AIR_PROBE_FLOOR}`,
    r.airProbeImpacts >= AIR_PROBE_FLOOR,
  );

  // ── Burst probe (re-specified by the P7 amendment) ──────────────────────────
  add(
    'burst probe: towers after build',
    r.towersAfterBuild,
    `== ${CATALOG_TOWER_COUNT}`,
    r.towersAfterBuild === CATALOG_TOWER_COUNT,
  );
  add(
    "burst probe: towers at window's first tick",
    r.towersAtWindowStart,
    `== ${LIVE_TOWERS_EXACT}`,
    r.towersAtWindowStart === LIVE_TOWERS_EXACT,
  );
  {
    const inWindow = r.detonationTicks.filter((t) => t <= CATALOG_SAMPLE_END_TICK).length;
    add(
      'burst probe: NO detonation inside the window',
      inWindow,
      `== 0 (min towers in window ${r.minTowersInWindow})`,
      inWindow === 0 && r.minTowersInWindow === LIVE_TOWERS_EXACT,
    );
  }
  add(
    'burst probe: detonations during the leak-probe extension',
    r.detonationTicks.length,
    `== ${CATALOG_DETONATOR_PAD_COUNT}`,
    r.detonationTicks.length === CATALOG_DETONATOR_PAD_COUNT,
  );
  add(
    'burst probe: towers at end of probe pass',
    r.finalTowers,
    `== ${POST_DETONATION_TOWERS}`,
    r.finalTowers === POST_DETONATION_TOWERS,
  );
  {
    // Each observed detonation must clear a route-cost lower bound. Both series are
    // sorted before the pairwise compare: the pads' bounds are index-parallel to
    // `CATALOG_MINE_PADS`, not to fire order, and which pad fires k-th is not something
    // this probe claims to know — only that the k-th EARLIEST detonation cannot precede
    // the k-th SMALLEST bound.
    const observed = [...r.detonationTicks].sort((a, b) => a - b);
    const bounds = [...CATALOG_DETONATOR_LOWER_BOUND_TICKS].sort((a, b) => a - b);
    const violations = observed.filter((t, i) => t < (bounds[i] ?? Number.NEGATIVE_INFINITY));
    add(
      'burst probe: every detonation tick >= its route-cost lower bound',
      violations.length === 0 ? 'all clear' : `${violations.length} early`,
      `pairwise, sorted (earliest bound ${bounds[0]})`,
      violations.length === 0 && observed.length === bounds.length,
    );
  }
  add(
    'burst probe: surviving mines still standing at run end',
    r.survivorsAliveAtEnd,
    `== ${CATALOG_MINE_PADS.length - CATALOG_DETONATOR_PAD_COUNT}`,
    r.survivorsAliveAtEnd === CATALOG_MINE_PADS.length - CATALOG_DETONATOR_PAD_COUNT,
  );

  add(
    'no combat deaths: adversarial damage ceiling',
    r.adversarialDamageCeiling,
    `< ${r.creepHp} (creep hp)`,
    r.adversarialDamageCeiling < r.creepHp,
  );
  if (r.leak === null) {
    add(
      'multi-life leak probe',
      'NO cat-heavy leak observed',
      `<= tick ${CATALOG_LEAK_PROBE_MAX_TICK}`,
      false,
    );
  } else {
    add(
      'multi-life leak probe: lives delta == sum of leakCost over leaked ids',
      `${r.leak.livesDelta} vs ${r.leak.expectedDelta}`,
      'equal',
      r.leak.livesDelta === r.leak.expectedDelta,
    );
    add(
      "multi-life leak probe: cat-heavy's own summand",
      r.leak.heavySummand,
      `== 3 x ${r.leak.heavyCount} heavy leaks`,
      r.leak.heavySummand === 3 * r.leak.heavyCount && r.leak.heavyCount >= 1,
    );
    add(
      'multi-life leak probe: leak tick within bound',
      r.leak.tick,
      `<= ${CATALOG_LEAK_PROBE_MAX_TICK}`,
      r.leak.tick <= CATALOG_LEAK_PROBE_MAX_TICK,
    );
  }
  return rows;
}
