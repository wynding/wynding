#!/usr/bin/env -S tsx
// run.ts — the perf harness CLI (PLAN steps 19/21). Loads the bundle and both
// committed replays, runs the control scenario then the stress scenario IN ONE
// PROCESS, runs the workload oracle (`oracle.ts`, PLAN step 18) against the stress
// run, the control-window sanity checks against the control run, computes the ratio
// gate (`gate.ts`, PLAN step 21), and prints a human report plus one machine-readable
// `PERF-REPORT: ` JSON line.
//
// This file is a CLI entry point — like `generate.ts`, it is excluded from the
// coverage gate (`vitest.config.ts`) because its correctness is exercised by actually
// running it (this packet's Definition of Done), not by a unit test that would just
// re-mock every import to assert `console.log` was called. The one piece of real
// decision logic this file has — "does this run's combination of assertion failures
// and gate outcome exit non-zero" — is pulled out into `escalation.ts`'s pure
// `evaluateEscalation`, which IS unit-tested directly (`escalation.test.ts`).
//
// Phase 4 wired this into a root `perf` script (`pnpm run perf` -> `pnpm -C
// packages/perf run perf` -> this file) and a dedicated CI job (`.github/workflows/
// ci.yml`'s `perf` job) — deliberately NOT part of local `verify` (PLAN step 20): a
// multi-second sustained stress run in every pre-commit loop is exactly what step 20
// says to avoid. Run it directly with `pnpm run perf` or `pnpm -C packages/perf run
// perf` — never `pnpm --filter @wynding/perf …`: `ci.yml`'s `perf` job comment
// documents that a `--filter` matching no package prints "No projects matched the
// filters" and exits 0 (verified on pnpm 10.33.0), so that idiom would silently pass
// having run nothing if this package were ever renamed or moved out of the workspace
// glob.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRulesetJson, compileRuleset } from '@wynding/sim';
import type { Replay } from '@wynding/replay';
import { STRESS_RULESET_URL } from '@wynding/content/stress';
import { runSampled, WARMUP_TICKS, SAMPLE_TICKS, type SampledTick } from './harness';
import { stressRouteLength } from './layout';
import { runOracle, KNOWN_OPEN_ASSERTIONS, type OracleAssertion, isDueBlastSample } from './oracle';
import { evaluateGate, TOLERANCE, R0, type GateResult } from './gate';
import { evaluateEscalation } from './escalation';
import { percentile, min, max, mean } from './stats';

const scenariosDir = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');

// 1) Load the bundle — the genuine `readFileSync` + `parseRulesetJson` path
// (`generate.ts`'s precedent), never a bespoke `JSON.parse`.
const bundleText = readFileSync(STRESS_RULESET_URL, 'utf8');
const bundle = parseRulesetJson(bundleText);

// 2) Read both committed replays — the exact bytes the real replay path would consume.
function readReplay(fileName: string): Replay {
  return JSON.parse(readFileSync(join(scenariosDir, fileName), 'utf8')) as Replay;
}
const controlReplay = readReplay('control-40x40.replay.json');
const stressReplay = readReplay('stress-40x40.replay.json');

// 3) Control FIRST, then stress — IN ONE PROCESS. Not arbitrary ordering: besides
// being the calibration workload the gate's `controlStat` reads, running it first
// warms V8's JIT on `step()` before the gated stress run times anything, which is the
// warm-up ADR 0005's measurement methodology requires (each run also has its OWN
// `WARMUP_TICKS`-tick in-scenario warm-up on top of this cross-scenario JIT warm-up).
console.log('Running control scenario (blast-free calibration workload)...');
const controlResult = runSampled(controlReplay, bundle);
console.log('Running stress scenario...');
const stressResult = runSampled(stressReplay, bundle);

// 4) The workload oracle (PLAN step 18) — against the STRESS run. `routeLength` is
// computed once, off the INTENDED layout (`layout.ts`'s `stressRouteLength`), not
// from either run's realized `state.towers`.
const routeLength = stressRouteLength(compileRuleset(bundle, stressReplay.boardId));
const oracleResult = runOracle({
  samples: stressResult.samples,
  towersPlacedAfterBuild: stressResult.towersPlacedAfterBuild,
  leftoverBountyAfterBuild: stressResult.leftoverBountyAfterBuild,
  routeLength,
});

// 5) The control-window sanity checks. Nothing previously checked the control run at
// all — a control whose SCENE degenerated (wrong phase, fewer accepted placements,
// leftover bounty, or a stray blast) would silently corrupt the ratio gate's
// denominator; the four structural checks below catch exactly that. They do NOT, on
// their own, catch a control that stayed structurally intact but merely got SLOWER or
// HEAVIER — a scene-shaped control whose creep population quietly drifted (QC round
// 2: the earlier version of this comment claimed they did). Two more checks close
// that gap. The control's MEDIAN live creeps must stay within a stated band of the
// value recorded here (`CONTROL_MEDIAN_LIVE_CREEPS_RECORDED`) — a directional swing
// in the control's weight, the one thing the first four checks cannot see, fails
// here instead. And the control's PEAK slowed creeps must be > 0: the chill pair's
// slow coverage is load-bearing for what `R` measures (`scenario.ts`'s
// `buildControlReplay` doc) and was previously unobserved entirely — see the "slowed
// creeps (control)" summary line below for the measured population.
function controlAssertion(
  name: string,
  measured: boolean | number,
  threshold: boolean | number,
  pass: boolean,
): OracleAssertion {
  return { name, measured, threshold, pass };
}
const controlAllRunning =
  controlResult.samples.length > 0 && controlResult.samples.every((s) => s.phase === 'running');
const controlNoBlasts =
  controlResult.samples.length > 0 && controlResult.samples.every((s) => s.dueBlasts === 0);

/** The control's measured MEDIAN live-creep count this story recorded — 181 — and the
 *  band this sanity check tolerates around it. The sim is fully deterministic (a fixed
 *  seed against a fixed, committed replay), so a rerun of UNCHANGED code reproduces
 *  this exact number every time — this band is not absorbing run-to-run noise, because
 *  there isn't any. It exists so an incidental, unrelated engine change elsewhere
 *  (e.g. a movement-rounding tweak) does not force a needless edit here for a
 *  few-creep drift that is not itself a control regression, while the failure this
 *  check exists for — the control's scene quietly getting heavier or lighter — moves
 *  the median by many multiples of this band, not a handful of creeps. */
const CONTROL_MEDIAN_LIVE_CREEPS_RECORDED = 181;
const CONTROL_MEDIAN_LIVE_CREEPS_BAND = 20;
const controlMedianLiveCreeps = percentile(
  controlResult.samples.map((s) => s.liveCreeps),
  50,
);
const controlMedianWithinBand =
  Math.abs(controlMedianLiveCreeps - CONTROL_MEDIAN_LIVE_CREEPS_RECORDED) <=
  CONTROL_MEDIAN_LIVE_CREEPS_BAND;
const controlPeakSlowedCreeps = controlResult.samples.reduce(
  (peak, s) => Math.max(peak, s.slowedCreeps),
  0,
);
const controlHasSlowedCreeps = controlPeakSlowedCreeps > 0;
const controlAssertions: OracleAssertion[] = [
  controlAssertion(
    'control: phase === running for every sample',
    controlAllRunning,
    true,
    controlAllRunning,
  ),
  controlAssertion(
    'control: accepted tower placements',
    controlResult.towersPlacedAfterBuild,
    150,
    controlResult.towersPlacedAfterBuild === 150,
  ),
  controlAssertion(
    'control: leftover bounty after build',
    controlResult.leftoverBountyAfterBuild,
    0,
    controlResult.leftoverBountyAfterBuild === 0,
  ),
  controlAssertion(
    'control: due blasts across every sample',
    controlNoBlasts,
    true,
    controlNoBlasts,
  ),
  controlAssertion(
    `control: median live creeps within ${CONTROL_MEDIAN_LIVE_CREEPS_BAND} of the recorded ${CONTROL_MEDIAN_LIVE_CREEPS_RECORDED}`,
    controlMedianLiveCreeps,
    CONTROL_MEDIAN_LIVE_CREEPS_RECORDED,
    controlMedianWithinBand,
  ),
  controlAssertion(
    'control: peak slowed creeps > 0',
    controlPeakSlowedCreeps,
    0,
    controlHasSlowedCreeps,
  ),
];

// 6) Report tables and per-sample summaries.
function msOf(samples: readonly SampledTick[]): number[] {
  return samples.map((s) => s.ms);
}
function percentileTable(samples: readonly SampledTick[]): {
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  const ms = msOf(samples);
  return {
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    p99: percentile(ms, 99),
    max: max(ms),
  };
}
function fmtTable(
  label: string,
  table: { p50: number; p95: number; p99: number; max: number },
): void {
  console.log(
    `  ${label.padEnd(18)} p50=${table.p50.toFixed(3)}ms p95=${table.p95.toFixed(3)}ms ` +
      `p99=${table.p99.toFixed(3)}ms max=${table.max.toFixed(3)}ms`,
  );
}
function medianOf(xs: readonly number[]): number {
  return percentile(xs, 50);
}
function fmtSummary(label: string, xs: readonly number[]): void {
  console.log(`  ${label.padEnd(18)} min=${min(xs)} median=${medianOf(xs)} max=${max(xs)}`);
}

const dueBlastSamples = stressResult.samples.filter(isDueBlastSample);

console.log('');
console.log(
  `=== step() ms percentile tables (WARMUP_TICKS=${WARMUP_TICKS}, SAMPLE_TICKS=${SAMPLE_TICKS}) ===`,
);
const controlTable = percentileTable(controlResult.samples);
const stressAllTable = percentileTable(stressResult.samples);
const stressDueBlastTable = dueBlastSamples.length > 0 ? percentileTable(dueBlastSamples) : null;
fmtTable('control', controlTable);
fmtTable('stress-all', stressAllTable);
if (stressDueBlastTable !== null) {
  fmtTable(`stress-due-blast (n=${dueBlastSamples.length})`, stressDueBlastTable);
} else {
  console.log('  stress-due-blast    <no due-blast samples in window>');
}

console.log('');
console.log('=== per-sample summaries ===');
fmtSummary(
  'due blasts/tick',
  stressResult.samples.map((s) => s.dueBlasts),
);
fmtSummary(
  'live creeps',
  stressResult.samples.map((s) => s.liveCreeps),
);
fmtSummary(
  'live creeps (control)',
  controlResult.samples.map((s) => s.liveCreeps),
);
fmtSummary(
  'slowed creeps',
  stressResult.samples.map((s) => s.slowedCreeps),
);
fmtSummary(
  'slowed creeps (control)',
  controlResult.samples.map((s) => s.slowedCreeps),
);

console.log('');
console.log('=== workload oracle (PLAN step 18) ===');
for (const a of oracleResult.assertions) {
  console.log(
    `  [${a.pass ? 'PASS' : 'FAIL'}] ${a.name}: measured=${a.measured} threshold=${a.threshold}`,
  );
}

console.log('');
console.log('=== control sanity checks ===');
for (const a of controlAssertions) {
  console.log(
    `  [${a.pass ? 'PASS' : 'FAIL'}] ${a.name}: measured=${a.measured} threshold=${a.threshold}`,
  );
}

// 7) The ratio gate (PLAN step 21) — moved BELOW the report/oracle printing (QC
// round-1 fix 2: `evaluateGate` used to run FIRST, before anything was printed, and
// `stressStat` THROWS (via `percentile`) on an empty `dueBlastSamples` — "no blasts
// actually due during the sampling window" is one of PLAN step 18's own named failure
// modes, and it used to produce a bare stack trace instead of the oracle escalation
// block. Short-circuit cleanly here instead: report it as a loud, named failure (the
// oracle's own "samples with >= 1 due blast" assertion already covers it above), not
// a crash.
console.log('');
console.log('=== gate (PLAN step 21) ===');
let gateResult: GateResult | null = null;
if (dueBlastSamples.length === 0) {
  console.log('  gate NOT evaluated — no due-blast samples in the stress window. See the workload');
  console.log('  oracle failure above ("samples with >= 1 due blast"): this is that failure,');
  console.log('  not a separate one, and it already forces a non-zero exit.');
} else {
  gateResult = evaluateGate(controlResult.samples, dueBlastSamples);
  if (gateResult.status === 'unset') {
    console.log(
      `  R0 is unset — recording run only, gate not enforced; commit this value. Observed R = ${gateResult.r.toFixed(4)} ` +
        `(controlStat p50=${gateResult.controlStat.toFixed(3)}ms, stressStat p99=${gateResult.stressStat.toFixed(3)}ms)`,
    );
  } else {
    console.log(
      `  R = ${gateResult.r.toFixed(4)} vs ceiling ${gateResult.ceiling.toFixed(4)} ` +
        `(R0=${gateResult.r0} × TOLERANCE=${TOLERANCE}) — ${gateResult.pass ? 'PASS' : 'FAIL'}`,
    );
  }
}

// 8) The known-open exit-code decision — `escalation.ts`'s
// `evaluateEscalation`, folding the stress oracle's assertions AND the control
// sanity checks (never known-open — see `escalation.ts`'s doc) into one list. A gate
// that was not evaluated (recording-only R0, or no due-blast samples) counts as
// `gatePass: true`: it cannot itself force a non-zero exit, though the empty-subset
// case is already caught above as an ordinary oracle failure.
const allAssertions: OracleAssertion[] = [...oracleResult.assertions, ...controlAssertions];
const gatePass = gateResult === null || gateResult.status === 'unset' ? true : gateResult.pass;
const escalation = evaluateEscalation(allAssertions, gatePass);

const allFailing = allAssertions.filter((a) => !a.pass);
if (allFailing.length > 0) {
  console.log('');
  console.log('=== ESCALATION: assertion(s) missed their committed threshold ===');
  console.log(
    'PLAN step 18: "If tuning cannot reach a floor, that is escalated as a finding, never',
  );
  console.log(
    'lowered to fit." The following are findings for the owner, not bugs in this harness:',
  );
  for (const a of allFailing) {
    const tag = KNOWN_OPEN_ASSERTIONS.includes(a.name) ? ' [KNOWN-OPEN]' : '';
    console.log(`  - ${a.name}: measured=${a.measured}, committed threshold=${a.threshold}${tag}`);
  }
}

if (escalation.knownOpenFailures.length > 0) {
  console.log('');
  console.log('=== KNOWN-OPEN: owner-acknowledged findings, pending an owner ruling ===');
  console.log('These do NOT block this run by themselves (oracle.ts: KNOWN_OPEN_ASSERTIONS) —');
  console.log('they still print under ESCALATION above, and the list only shrinks by an');
  console.log('explicit owner ruling, never by a passing (or failing) run:');
  for (const a of escalation.knownOpenFailures) {
    console.log(`  - ${a.name}`);
  }
}

if (escalation.staleKnownOpen.length > 0) {
  console.log('');
  console.log('=== STALE KNOWN-OPEN WAIVER ===');
  console.log('The following are on oracle.ts KNOWN_OPEN_ASSERTIONS but PASSED this run.');
  console.log('A stale waiver is its own defect — remove the entry (owner ruling, not');
  console.log('auto-removed by this passing run):');
  for (const name of escalation.staleKnownOpen) {
    console.log(`  - ${name}`);
  }
}

if (gateResult !== null && gateResult.status === 'evaluated' && !gateResult.pass) {
  console.log('');
  console.log('=== GATE FAILURE: R exceeds R0 × TOLERANCE ===');
}

// 9) Machine-readable report — a single JSON line, prefixed `PERF-REPORT: `, so Phase 6
// can lift these tables into the spike document without re-running the harness.
const report = {
  warmupTicks: WARMUP_TICKS,
  sampleTicks: SAMPLE_TICKS,
  control: {
    percentiles: controlTable,
    sampleCount: controlResult.samples.length,
    liveCreeps: {
      min: min(controlResult.samples.map((s) => s.liveCreeps)),
      median: medianOf(controlResult.samples.map((s) => s.liveCreeps)),
      max: max(controlResult.samples.map((s) => s.liveCreeps)),
      mean: mean(controlResult.samples.map((s) => s.liveCreeps)),
    },
    slowedCreeps: {
      min: min(controlResult.samples.map((s) => s.slowedCreeps)),
      median: medianOf(controlResult.samples.map((s) => s.slowedCreeps)),
      max: max(controlResult.samples.map((s) => s.slowedCreeps)),
      mean: mean(controlResult.samples.map((s) => s.slowedCreeps)),
    },
    towersPlacedAfterBuild: controlResult.towersPlacedAfterBuild,
    leftoverBountyAfterBuild: controlResult.leftoverBountyAfterBuild,
    assertions: controlAssertions,
  },
  stress: {
    percentilesAll: stressAllTable,
    percentilesDueBlast: stressDueBlastTable,
    dueBlastSampleCount: dueBlastSamples.length,
    sampleCount: stressResult.samples.length,
    liveCreeps: {
      min: min(stressResult.samples.map((s) => s.liveCreeps)),
      median: medianOf(stressResult.samples.map((s) => s.liveCreeps)),
      max: max(stressResult.samples.map((s) => s.liveCreeps)),
      mean: mean(stressResult.samples.map((s) => s.liveCreeps)),
    },
    dueBlasts: {
      min: min(stressResult.samples.map((s) => s.dueBlasts)),
      median: medianOf(stressResult.samples.map((s) => s.dueBlasts)),
      max: max(stressResult.samples.map((s) => s.dueBlasts)),
      mean: mean(stressResult.samples.map((s) => s.dueBlasts)),
    },
    slowedCreeps: {
      min: min(stressResult.samples.map((s) => s.slowedCreeps)),
      median: medianOf(stressResult.samples.map((s) => s.slowedCreeps)),
      max: max(stressResult.samples.map((s) => s.slowedCreeps)),
      mean: mean(stressResult.samples.map((s) => s.slowedCreeps)),
    },
    towersPlacedAfterBuild: stressResult.towersPlacedAfterBuild,
    leftoverBountyAfterBuild: stressResult.leftoverBountyAfterBuild,
    routeLength,
  },
  oracle: oracleResult,
  gate: gateResult,
  tolerance: TOLERANCE,
  r0: R0,
  knownOpenAssertions: KNOWN_OPEN_ASSERTIONS,
  escalation,
};
console.log('');
console.log(`PERF-REPORT: ${JSON.stringify(report)}`);

if (escalation.exitNonZero) {
  process.exitCode = 1;
}
