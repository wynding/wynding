// @wynding/perf — the ADR 0005 stress scenario and its measurement harness.
//
// This package sits at the MOST-DOWNSTREAM point of the workspace dependency graph: it
// depends on `@wynding/sim`, `@wynding/replay`, `@wynding/content`, and `@wynding/types`.
// Nothing shipped may import `@wynding/perf` — apps/web's production build, and every
// other package, must stay unaware this package exists.
//
// It cannot live inside `packages/sim`: sim depends only on `@wynding/engine` and
// `@wynding/types` (the one-way graph `types ← engine ← sim ← {render, replay, content}
// ← apps` is an AGENTS.md hard rule), and this package needs the stress bundle (in
// `content`) and the real replay path (in `replay`) — both downstream of sim. Importing
// either from inside sim would be a layering back-edge.
//
// It cannot live in `scripts/` either: the root `package.json` declares no workspace
// dependencies, so a root-level script has no way to import `@wynding/sim` et al. at all.
//
// Hence a dedicated workspace package, downstream of everything it needs and upstream
// of nothing that ships. THREE guards hold the "nothing shipped may import this"
// invariant, as of #112/#129 — this comment used to say there was no automated
// dependency-direction lint at all, which was true when it was written and is not now:
//   - `eslint.config.mjs`'s APP ZONES — `apps/web/src` and `apps/server/src`. Not the
//     generated layering zones, and the distinction is #112's whole point: the graph
//     PERMITS `apps <- perf` (perf is upstream of apps), so a generated zone has no
//     reason to forbid this import. The app zones carry the narrower never-ship
//     invariant, and they are why a DECLARED devDependency of `apps/web` — the import
//     nothing else in the toolchain objects to — goes red;
//   - `pnpm run check:build-layering`, which asserts over the BUILT web app that no
//     emitted file carries this package's or the synthetic bundles' markers — the
//     authority, because it asks Vite rather than reading source text;
//   - `layering.test.ts` (QC: this package's dev-only reverse dependency), the cheap grep
//     over every shipped `src` tree, which is the arm that still covers `apps/server`
//     (which `check:build-layering` does not scan — esbuild bundles it, but that check reads
//     the web app's output only) and dynamic `import()` spellings.
//
// QC corrected a stale claim here: this file used to say the invariant was held "by
// this package's own total absence of reverse dependencies" — no longer true.
// `apps/web` DEV-depends on `@wynding/perf` (`apps/web/perf/main-perf.ts`, the
// perf-only browser entry point, PLAN step 22) so it can drive the real controller
// against the stress scenario. The PRODUCTION graph stays genuinely clean —
// `apps/web/src/**` (the shipped app) imports neither this package nor
// `@wynding/content/stress` — but "this package has no reverse dependencies at all"
// was simply false the moment that dev-only entry point existed, and a stated
// guarantee that is wrong is worse than no guarantee, because a reader trusts it.

export { BAND_COLS, TAIL_BAFFLES, stressAnchors, towerIdAt, stressRouteLength } from './layout';
export type { StressTowerId } from './layout';
// The catalog scene (M2-S11 P7) — additive; nothing above changes.
export {
  CATALOG_TOWER_ID_AT,
  catalogTowerIdAt,
  catalogPlacements,
  CATALOG_MINE_PADS,
  CATALOG_DETONATOR_PAD_COUNT,
  CATALOG_DETONATING_MINE_INDICES,
  CATALOG_SURVIVING_MINE_INDICES,
  CATALOG_DETONATOR_ROUTE_INDICES,
  CATALOG_DETONATOR_LOWER_BOUND_TICKS,
  CATALOG_TOWER_COUNT,
  CATALOG_TOTAL_SPEND,
  catalogRoutePath,
  catalogRouteLength,
  catalogRouteCumulativeFp,
} from './layout';
export type { CatalogTowerId, CatalogPlacement } from './layout';
export {
  buildStressReplay,
  buildControlReplay,
  buildCatalogReplay,
  CATALOG_SEED,
  CATALOG_BUILD_TICKS,
  BUILD_TICKS,
  PLACEMENTS_PER_TICK,
} from './scenario';
export {
  runCatalogScene,
  catalogAssertions,
  adversarialDamagePerTickMilli,
  CATALOG_WARMUP_AFTER_BUILD_TICKS,
  CATALOG_SAMPLE_START_TICK,
  CATALOG_SAMPLE_TICKS,
  CATALOG_SAMPLE_END_TICK,
  CATALOG_LEAK_PROBE_MAX_TICK,
  CATALOG_ATTACKER_COUNTS,
  GROUND_FAMILY_EXACT,
  GROUND_FAMILY_TOTAL,
  LIVE_AIR_FLOOR,
  LIVE_CREEPS_FLOOR,
  LIVE_TOWERS_EXACT,
  POST_DETONATION_TOWERS,
  LEFTOVER_BOUNTY_EXACT,
  CATALOG_ROUTE_LENGTH,
  type CatalogSample,
  type CatalogSceneResult,
  type CatalogAssertion,
  type LeakProbeResult,
} from './oracle-catalog';
export { percentile, min, max, mean } from './stats';
export {
  runSampled,
  WARMUP_TICKS,
  SAMPLE_TICKS,
  type SampledTick,
  type RunSampledResult,
} from './harness';
export {
  runOracle,
  isQualifyingSample,
  TOWERS_PLACED_THRESHOLD,
  PEAK_LIVE_CREEPS_THRESHOLD,
  MEDIAN_LIVE_CREEPS_THRESHOLD,
  ROUTE_LENGTH_FLOOR,
  REQUIRE_ALL_RUNNING,
  DUE_BLAST_SAMPLES_THRESHOLD,
  PEAK_SLOWED_CREEPS_THRESHOLD,
  PEAK_DOT_RECORDS_THRESHOLD,
  DOT_RECORD_DEPTH_THRESHOLD,
  DOT_ACTIVE_SAMPLES_THRESHOLD,
  PEAK_ARMORED_LIVE_THRESHOLD,
  DOT_DROPPED_THRESHOLD,
  QUALIFYING_SAMPLES_THRESHOLD,
  LEFTOVER_BOUNTY_THRESHOLD,
  KNOWN_OPEN_ASSERTIONS,
  type OracleAssertion,
  type OracleResult,
  type OracleInput,
} from './oracle';
export {
  controlStat,
  stressStat,
  // The two superseded gating statistics, kept for audit — `stressStatP95` gated between
  // M2-S5b P11 and M2-S6, `stressStatP99` before that. Exported alongside the statistic
  // that replaced them so a consumer can render all three, not just the one that gates.
  stressStatP95,
  stressStatP99,
  evaluateGate,
  TOLERANCE,
  R0,
  type GateResult,
} from './gate';
export { evaluateEscalation, type EscalationResult } from './escalation';
