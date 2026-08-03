// test-support.ts — shared fixtures for the sim test suite.
//
// Kept inside @wynding/sim (NOT importing @wynding/content) so tests — including the
// determinism golden — build their rulesets inline, with no sim→content edge. The
// numbers mirror the M1 content but tests may override the board/wave/economy.

import type { CreepDef, Ruleset, TowerDef } from '@wynding/types';
import type { GridSpec } from './board';
import { compileRuleset, type CompiledRuleset } from './ruleset';
import { cellCenterX, cellCenterY } from './movement';
import type { SimState } from './index';
import { runCombat } from './combat';

/** The standard M1 single-target tower stat block. */
export const TEST_TOWER: TowerDef = {
  id: 'basic',
  cost: 5,
  attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
  effects: [{ kind: 'direct', form: 'single', damage: 10 }],
};

/** The M2-S3 `slow` tower stat block — ground-scoped, direct-then-slow authored
 *  order (mirrors the shipped `wynding-core` bundle's `slow` tower, step 12). */
export const TEST_SLOW_TOWER: TowerDef = {
  id: 'slow',
  cost: 8,
  attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 2 },
  effects: [
    { kind: 'direct', form: 'single', damage: 2 },
    { kind: 'slow', mulFp: 128, durationTicks: 40 },
  ],
};

/** The M2-S3 `fast` creep stat block (mirrors the shipped bundle's `fast` creep). */
export const TEST_FAST_CREEP: CreepDef = {
  id: 'fast',
  hp: 16,
  speedFp: 44,
  armor: 0,
  domain: 'ground',
  immunities: [],
  leakCost: 1,
  bounty: 2,
};

/** The M2-S5a `venom` tower stat block — ground-scoped, direct-then-dot authored
 *  order: cost 9, damage 2, DoT 2/tick every 10 ticks for 60 ticks, range 1024,
 *  cadence 30, travel 2. A **mechanics fixture, deliberately independent of the
 *  shipped catalog** — `packages/sim` cannot import `@wynding/content` under this
 *  file's own header (lines 3-5), so sim tests build rulesets inline instead of
 *  reading the shipped bundle. It was seeded from the shipped `venom`'s shape but
 *  no longer tracks its magnitude: the shipped tower went to DoT 4 per tick in
 *  M2-S5b PR A while this fixture stays at 2, and that divergence is deliberate.
 *  Before syncing it, note it has TWO dependents, both of which a change moves:
 *  `determinism.test.ts`'s world-hash golden (which must not move when content
 *  balance changes), and `story-dot.test.ts` — the sim's whole DoT behavioural
 *  suite, which derives its `AMOUNT`/`CADENCE`/`DURATION` from this block rather
 *  than hardcoding them. */
export const TEST_DOT_TOWER: TowerDef = {
  id: 'venom',
  cost: 9,
  attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 2 },
  effects: [
    { kind: 'direct', form: 'single', damage: 2 },
    { kind: 'dot', damagePerTick: 2, cadenceTicks: 10, durationTicks: 60 },
  ],
};

/** The M2-S4a AoE (blast) tower stat block — ground-scoped, a single `aoe` direct
 *  effect (mirrors the shipped `wynding-core` bundle's `splash` tower's shape,
 *  m2.md §The towers: cost 12, damage 8, radiusFp 384, range 1024, cadence 60,
 *  travel 8 — the story's showcase numbers, reused here so a sim-only fixture
 *  exercises the real showcase shape without any `@wynding/content` import). */
export const TEST_AOE_TOWER: TowerDef = {
  id: 'aoe',
  cost: 12,
  attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 60, travelTicks: 8 },
  effects: [{ kind: 'direct', form: 'aoe', damage: 8, radiusFp: 384 }],
};

/** The M2-S4a `swarm` creep stat block — AoE's showcase target (mirrors the
 *  shipped bundle's `swarm`: hp 7, speed 30, bounty 1, m2.md §The creeps). */
export const TEST_SWARM_CREEP: CreepDef = {
  id: 'swarm',
  hp: 7,
  speedFp: 30,
  armor: 0,
  domain: 'ground',
  immunities: [],
  leakCost: 1,
  bounty: 1,
};

/** Overrides for a test bundle (all optional). `waveCount`/`waveSpacing` name the
 *  ENTRY inside each wave (kept from M1 for call-site continuity — an unfortunate
 *  but pre-existing name collision with the new multi-wave `waves` option below);
 *  `waves`, when given, REPLACES the single generated wave with a caller-built
 *  multi-wave schedule (each item optionally overriding count/spacing/countdown/
 *  clearBonus/offset per wave; everything else in this bundle — catalog, balance,
 *  scoring — still applies uniformly). */
export interface TestWaveOpts {
  readonly waveCount?: number;
  readonly waveSpacing?: number;
  readonly countdownTicks?: number;
  readonly waveClearBonus?: number;
  readonly offsetTicks?: number;
  /** Which catalog creep this wave's single entry spawns (M2-S3; default 'normal') —
   *  pair with `TestBundleOpts.extraCreeps` to spawn a non-default catalog id. */
  readonly creepId?: string;
}
export interface TestBundleOpts {
  readonly creepHp?: number;
  readonly creepSpeedFp?: number;
  readonly creepBounty?: number;
  readonly waveCount?: number;
  readonly waveSpacing?: number;
  readonly countdownTicks?: number;
  readonly startingBounty?: number;
  readonly startingLives?: number;
  readonly waveClearBonus?: number;
  /** Overrides the single-wave default with an explicit N-wave schedule. */
  readonly waves?: readonly TestWaveOpts[];
  /** `0` = off (M1 default); `⌊ticksRemaining / earlyCallBountyDivisor⌋` bounty at
   *  an early call. */
  readonly earlyCallBountyDivisor?: number;
  /** `0` = off (M1 default); `⌊ticksRemaining / earlyCallScoreDivisor⌋` score credit
   *  at an early call. */
  readonly earlyCallScoreDivisor?: number;
  /** Extra tower catalog entries appended after the default 'basic' tower (M2-S3) —
   *  e.g. `[TEST_SLOW_TOWER]` for slow-application/stacking/capability tests. A
   *  bundle with ONLY these (no 'basic') is expressed by passing `towers` instead. */
  readonly extraTowers?: readonly TowerDef[];
  /** Full tower-catalog override (M2-S3) — replaces the default `[TEST_TOWER]`
   *  entirely (mutually exclusive with `extraTowers`; `extraTowers` is ignored if
   *  this is given). For the common "basic + slow" case, prefer `extraTowers`. */
  readonly towers?: readonly TowerDef[];
  /** Extra creep catalog entries appended after the default 'normal' creep
   *  (M2-S3) — e.g. `[TEST_FAST_CREEP]`, referenced by a wave's `creepId` override. */
  readonly extraCreeps?: readonly CreepDef[];
}

/** Build a raw ruleset bundle for a board geometry, with M1-ish defaults. */
export function testBundle(spec: GridSpec, opts: TestBundleOpts = {}): Ruleset {
  const waveOpts: readonly TestWaveOpts[] = opts.waves ?? [
    {
      waveCount: opts.waveCount,
      waveSpacing: opts.waveSpacing,
      countdownTicks: opts.countdownTicks,
      waveClearBonus: opts.waveClearBonus,
    },
  ];
  return {
    formatVersion: 2,
    rulesetId: 'test-ruleset',
    version: 1,
    creepCatalog: [
      {
        id: 'normal',
        hp: opts.creepHp ?? 20,
        speedFp: opts.creepSpeedFp ?? 26,
        armor: 0,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: opts.creepBounty ?? 1,
      },
      ...(opts.extraCreeps ?? []),
    ],
    towerCatalog: opts.towers ?? [TEST_TOWER, ...(opts.extraTowers ?? [])],
    balance: {
      startingLives: opts.startingLives ?? 10,
      startingBounty: opts.startingBounty ?? 80,
      refundNum: 3,
      refundDen: 4,
      slowFloorNum: 1,
      slowFloorDen: 4,
      earlyCallBountyDivisor: opts.earlyCallBountyDivisor ?? 0,
    },
    scoring: {
      survivalMul: 25,
      starThresholds: [1, 6, 9],
      earlyCallScoreDivisor: opts.earlyCallScoreDivisor ?? 0,
    },
    boards: [
      {
        id: 'test',
        widthTiles: spec.widthTiles,
        heightTiles: spec.heightTiles,
        entrance: spec.entrance,
        exit: spec.exit,
        waves: waveOpts.map((w, index) => ({
          index,
          countdownTicks: w.countdownTicks ?? 500,
          clearBonus: w.waveClearBonus ?? 0,
          entries: [
            {
              creepId: w.creepId ?? 'normal',
              count: w.waveCount ?? 10,
              spacingTicks: w.waveSpacing ?? 20,
              ...(w.offsetTicks !== undefined ? { offsetTicks: w.offsetTicks } : {}),
            },
          ],
        })),
      },
    ],
  };
}

/** Compile a test bundle for its single board — the `CompiledRuleset` `step` takes. */
export function testRuleset(spec: GridSpec, opts: TestBundleOpts = {}): CompiledRuleset {
  return compileRuleset(testBundle(spec, opts), 'test');
}

/** Insert a creep directly into a state's SoA (bypassing the wave) — the manual setup
 *  movement/tower/combat unit tests need now that there is no `spawnCreep` command.
 *  The row STARTS at the `(col,row)` cell centre (`fromX`/`fromY` are always that
 *  centre); by default it RESTS there (sentinel head), and the `headCol`/`headRow`/
 *  `progress` trio instead makes it a committed mid-edge row (QC r3 — the head differs
 *  from the origin and progress is nonzero). `creepId` defaults to `'normal'` (the
 *  default bundle's catalog id — override to `'fast'`/a test-bundle `extraCreeps` id
 *  when the ruleset under test carries a different catalog); `slowMulFp`/
 *  `slowUntilTick` default to `(0, 0)` — no active slow (M2-S3). */
export function pushCreep(
  state: SimState,
  args: {
    readonly id: number;
    readonly hp: number;
    readonly col: number;
    readonly row: number;
    readonly bounty?: number;
    readonly speed?: number;
    readonly wave?: number;
    readonly creepId?: string;
    readonly slowMulFp?: number;
    readonly slowUntilTick?: number;
    /** A committed mid-edge row: head differs from (col,row) and progress is nonzero
     *  (CodeRabbit #73 — `tower.test.ts`'s `committedCreep` delegates here so new SoA
     *  columns thread through ONE helper). Defaults keep the at-rest sentinel shape. */
    readonly headCol?: number;
    readonly headRow?: number;
    readonly progress?: number;
  },
): void {
  state.creeps.id.push(args.id);
  state.creeps.hp.push(args.hp);
  state.creeps.bounty.push(args.bounty ?? 1);
  state.creeps.speed.push(args.speed ?? 26);
  state.creeps.fromX.push(cellCenterX(args.col));
  state.creeps.fromY.push(cellCenterY(args.row));
  state.creeps.headCol.push(args.headCol ?? args.col);
  state.creeps.headRow.push(args.headRow ?? args.row);
  state.creeps.progress.push(args.progress ?? 0);
  state.creeps.wave.push(args.wave ?? 0);
  state.creeps.creepId.push(args.creepId ?? 'normal');
  state.creeps.slowMulFp.push(args.slowMulFp ?? 0);
  state.creeps.slowUntilTick.push(args.slowUntilTick ?? 0);
}

// `runCombat` gained a REQUIRED `creepById` armor-lookup parameter at M2-S5a P1 —
// this wrapper supplies an empty one (`{}`, unarmored) so pre-armor call sites across
// `combat.test.ts`/`story-aoe.test.ts`/`story-slow.test.ts` don't need one-by-one
// edits. M2-S5a P2 then added a `dots` parameter (STATE SHAPE ONLY — no behaviour in
// this packet), which this wrapper likewise defaults to `[]`. The param types are
// DERIVED from `runCombat` itself (never duplicated) via `Parameters<typeof
// runCombat>[N]` so this wrapper can never silently drift from the real signature.
// Tests that exercise armor or DoT state call `runCombat`/`applyImpactToCreep`
// directly with a real `creepById`/`dots`.
//
// CodeRabbit (PR #78, Major) flagged the THREE verbatim-identical copies of this
// wrapper (one per test file) as fragile: `runCombat`'s `tick`/`bounty` params are
// both bare `number`, and its `impacts`/`dots` params are both bare `readonly
// unknown[]` — two same-typed pairs sit adjacent in the parameter list, so a future
// positional shift in `runCombat` could silently retarget this wrapper at the wrong
// slot without a type error. The clean fix would be to reference each parameter BY
// NAME instead of by tuple index, but `runCombat`'s own signature (production code,
// off-limits for this packet) has no named-parameters form to reference — it takes
// 13 bare positional arguments, and the ambiguous pairs above have no more specific
// type to import that `runCombat` itself doesn't already erase (its `impacts`/`dots`
// parameters are typed `readonly unknown[]`, not `Impact[]`/`DotRecord[]`, so a
// narrower import wouldn't be enforced by `runCombat`'s own type and wouldn't catch a
// positional swap either). So this packet takes the acceptable fallback the plan
// allows: centralize the ONE `Parameters<...>[N]`-indexed definition here instead of
// three independent copies, so the hazard exists in exactly one place.
type RunCombatParams = Parameters<typeof runCombat>;
export function runCombatT(
  creeps: RunCombatParams[0],
  towers: RunCombatParams[1],
  impacts: RunCombatParams[2],
  tick: RunCombatParams[4],
  bounty: RunCombatParams[5],
  field: RunCombatParams[6],
  grid: RunCombatParams[7],
  towerById: RunCombatParams[8],
  slowFloorNum: RunCombatParams[10],
  slowFloorDen: RunCombatParams[11],
  events?: RunCombatParams[12],
): ReturnType<typeof runCombat> {
  return runCombat(
    creeps,
    towers,
    impacts,
    [],
    tick,
    bounty,
    field,
    grid,
    towerById,
    {},
    slowFloorNum,
    slowFloorDen,
    events,
  );
}
