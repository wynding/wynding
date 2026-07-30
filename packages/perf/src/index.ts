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
// of nothing that ships. There is no automated dependency-direction lint for this (the
// repo's one custom rule, `eslint-rules/no-ui-literals.mjs`, checks something else
// entirely) — the "nothing shipped may import this" invariant is held by review, PLUS
// `layering.test.ts` (QC: this package's dev-only reverse dependency), which greps
// `apps/web/src/**` for an import of this package or of `@wynding/content/stress`.
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
export {
  buildStressReplay,
  buildControlReplay,
  BUILD_TICKS,
  PLACEMENTS_PER_TICK,
} from './scenario';
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
  ROUTE_LENGTH_THRESHOLD,
  ROUTE_LENGTH_FLOOR,
  REQUIRE_ALL_RUNNING,
  DUE_BLAST_SAMPLES_THRESHOLD,
  PEAK_ACTIVE_STATUS_THRESHOLD,
  QUALIFYING_SAMPLES_THRESHOLD,
  LEFTOVER_BOUNTY_THRESHOLD,
  KNOWN_OPEN_ASSERTIONS,
  type OracleAssertion,
  type OracleResult,
  type OracleInput,
} from './oracle';
export { controlStat, stressStat, evaluateGate, TOLERANCE, R0, type GateResult } from './gate';
export { evaluateEscalation, type EscalationResult } from './escalation';
