#!/usr/bin/env -S tsx
// run.ts — the perf harness CLI (PLAN steps 19/21). Loads the bundle and both
// committed replays, runs the control scenario then the stress scenario IN ONE
// PROCESS, runs the workload oracle (`oracle.ts`, PLAN step 18) against the stress
// run, the control-window sanity checks against the control run, computes the ratio
// gate (`gate.ts`, PLAN step 21), asserts the real replay validator ACCEPTS both
// committed replays, and prints a human report plus one machine-readable
// `PERF-REPORT: ` JSON line.
//
// This file is a CLI entry point — like `generate.ts`, it is excluded from the
// coverage gate (`vitest.config.ts`) because its correctness is exercised by actually
// running it (this packet's Definition of Done), not by a unit test that would just
// re-mock every import to assert `console.log` was called. Everything here that is a
// real DECISION rather than printing lives in `escalation.ts` and is unit-tested there
// (`escalation.test.ts`): `allRunAssertions` assembles this run's assertions, including
// the two replay-validator verdicts, and `evaluateEscalation` folds them plus the gate
// outcome into the single `process.exitCode` assignment at the bottom of this file.
//
// One caveat, since the point of that structure is that the report and the exit code
// agree: it holds for every DECIDED outcome, not for a THROW. `evaluateGate` throws on a
// zero-millisecond control median, `compileRuleset` throws on an unbuildable bundle, and
// `stats.ts` throws on an empty series — any of those exits non-zero from a bare stack
// trace with no `PERF-REPORT:` line emitted at all. `runSampled` (M2-S5b P10) adds two
// more: the pass-divergence throw (the timed and untimed passes' final sim state
// disagreeing) and the `dotDropped`-mismatch throw (the two passes' summed
// `dotDropped` disagreeing despite identical final state) — see `harness.ts`'s
// `runSampled` doc for both. That is the intended behaviour (a broken measurement
// must not publish numbers), but a consumer parsing for the report line must treat
// "absent" as a third outcome, not as success.
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
import { validate, type Replay, type ValidationResult } from '@wynding/replay';
import { STRESS_RULESET_URL } from '@wynding/content/stress';
import { runSampled, WARMUP_TICKS, SAMPLE_TICKS, type SampledTick } from './harness';
import { stressRouteLength } from './layout';
import {
  runOracle,
  KNOWN_OPEN_ASSERTIONS,
  DUE_BLAST_SAMPLES_THRESHOLD,
  type OracleAssertion,
  isDueBlastSample,
  peakDotRecords,
  dotCarriersAtPeakDotRecords,
  dotRecordDepthAtPeak,
  peakDotCarriers,
  dotActiveSampleCount,
  peakArmoredLive,
} from './oracle';
import { evaluateGate, TOLERANCE, R0, type GateResult } from './gate';
import {
  evaluateEscalation,
  allRunAssertions,
  REPLAY_ACCEPTED_ASSERTIONS,
  REPLAY_KEYS,
  type ReplayKey,
} from './escalation';
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
// DECLINED, on record (packet M2-S5b P10 §7) — do not "fix" this by reordering.
// A review noted that the control run's own UNTIMED pass (`harness.ts`'s Pass 2,
// ~2,700 `Set` allocations for `dotCarriers`) lands immediately upstream, right
// here, of the next call's TIMED pass — the one that feeds the gate — so a GC pause
// induced by those allocations could in principle land inside the measured region.
// We are NOT reordering the passes to put distance between them: `stressStat` is a
// p95 over the due-blast subset (1,427 samples as measured post-P9), not a max, so a
// single induced pause cannot move it — and the argument is STRONGER under p95 than it
// was under the p99 this originally cited, since p95 discards more of the tail. And
// the measured `R` carries >2x headroom to the ceiling. Reordering would require
// splitting `runSampled`'s API into separately callable timed/untimed phases — a
// structural change with a real chance of introducing the very timed/untimed
// divergence its own post-pass equality proof (`harness.ts`'s hash/tick/phase
// check) exists to catch. Considered and declined, 2026-08-03.
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
  dotDroppedTotal: stressResult.dotDroppedTotal,
});

// 5) The control-window sanity checks. Nothing previously checked the control run at
// all — a control whose SCENE degenerated (wrong phase, fewer accepted placements,
// leftover bounty, or a stray blast) would silently corrupt the ratio gate's
// denominator; the four structural checks below catch exactly that. They do NOT, on
// their own, catch a control that stayed structurally intact but merely got SLOWER or
// HEAVIER — a scene-shaped control whose creep population quietly drifted (an
// earlier version of this comment claimed they did). Two more checks close
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
// The control's own copy of the stress arm's "dropped DoT applications, whole run"
// oracle assertion (`oracle.ts`'s `DOT_DROPPED_THRESHOLD`) — the control now carries
// `stress-venom` too (`scenario.ts`'s `buildControlReplay`), and it supplies the
// ratio gate's DENOMINATOR, so a silent DoT truncation there would corrupt `R` even
// with the stress arm clean.
const controlDotDropped = controlResult.dotDroppedTotal === 0;
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
  controlAssertion(
    'control: dropped DoT applications, whole run',
    controlResult.dotDroppedTotal,
    0,
    controlDotDropped,
  ),
  // REPORTED, NOT GATED (packet §2, owner ruling 2026-08-03) — the control arm's
  // copy of `oracle.ts`'s "peak DoT carriers (dispersion, reported not gated)" row.
  // Shares that file's `peakDotCarriers` reduction rather than hand-deriving it
  // again here.
  controlAssertion(
    'control: peak DoT carriers (dispersion, reported not gated)',
    peakDotCarriers(controlResult.samples),
    true,
    true,
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

// DoT/armor preflight (PLAN step 13, packet §6) — computed for BOTH arms, reported
// BEFORE the oracle table below asserts anything against it. The four reductions
// (plus `peakDotCarriers`/`dotCarriersAtPeakDotRecords`) are now IMPORTED from
// `oracle.ts` (packet §3) rather than hand-derived here a second time — `oracle.ts`'s
// own `runOracle` calls the identical functions, so the stress arm's gated figures
// and this preflight's copy of them are, by construction, the same derivation, not
// two that currently happen to agree.
function dotPreflight(samples: readonly SampledTick[]): {
  peakDotRecords: number;
  carriersAtPeakRecords: number;
  recordDepthAtPeak: number;
  dotActiveSampleCount: number;
  peakArmoredLive: number;
} {
  return {
    peakDotRecords: peakDotRecords(samples),
    // The value the depth ratio below was actually computed from — NOT the
    // window-wide peak of `dotCarriers` (see `fmtPreflight`'s label and packet §5:
    // the two need not land on the same tick, and printing the wrong one under a
    // label that looks like the depth ratio's denominator is exactly the ambiguity
    // this field exists to remove).
    carriersAtPeakRecords: dotCarriersAtPeakDotRecords(samples),
    recordDepthAtPeak: dotRecordDepthAtPeak(samples),
    dotActiveSampleCount: dotActiveSampleCount(samples),
    peakArmoredLive: peakArmoredLive(samples),
  };
}
const controlDotPreflight = dotPreflight(controlResult.samples);
const stressDotPreflight = dotPreflight(stressResult.samples);

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
fmtSummary(
  'dot records',
  stressResult.samples.map((s) => s.dotRecords),
);
fmtSummary(
  'dot records (control)',
  controlResult.samples.map((s) => s.dotRecords),
);
fmtSummary(
  'dot carriers',
  stressResult.samples.map((s) => s.dotCarriers),
);
fmtSummary(
  'dot carriers (control)',
  controlResult.samples.map((s) => s.dotCarriers),
);
fmtSummary(
  'armored live',
  stressResult.samples.map((s) => s.armoredLive),
);
fmtSummary(
  'armored live (control)',
  controlResult.samples.map((s) => s.armoredLive),
);

console.log('');
console.log('=== DoT/armor preflight (PLAN step 13, packet §6 — both arms) ===');
function fmtPreflight(
  label: string,
  p: {
    peakDotRecords: number;
    carriersAtPeakRecords: number;
    recordDepthAtPeak: number;
    dotActiveSampleCount: number;
    peakArmoredLive: number;
  },
): void {
  // `carriers@peakRecords=` (packet §5), NOT `peak dotCarriers=`: the old label
  // printed the window-wide peak of `dotCarriers`, which happens to equal the
  // record-depth ratio's actual denominator on the stress arm but NOT on the
  // control arm (127 window-wide peak vs 126 at the peak-dotRecords tick) — a
  // reader dividing the first two printed numbers would get the right answer on one
  // arm and the wrong one on the other. This field is now the exact denominator the
  // ratio was computed from, so the label matches what it prints. The window-wide
  // peak is still available in the "dot carriers" per-sample summary line above
  // (its `max=`) and in the oracle/control-sanity tables' dispersion row below.
  console.log(
    `  ${label.padEnd(10)} peak dotRecords=${p.peakDotRecords} carriers@peakRecords=${p.carriersAtPeakRecords} ` +
      `record depth @peak=${p.recordDepthAtPeak.toFixed(3)} dotTicks-active samples=${p.dotActiveSampleCount} ` +
      `peak armoredLive=${p.peakArmoredLive}`,
  );
}
fmtPreflight('stress', stressDotPreflight);
fmtPreflight('control', controlDotPreflight);
console.log(
  `  dotDropped whole run — stress=${stressResult.dotDroppedTotal} control=${controlResult.dotDroppedTotal}`,
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

// 7) The ratio gate (PLAN step 21) — moved BELOW the report/oracle printing:
// `evaluateGate` used to run FIRST, before anything was printed, and
// `stressStat` THROWS (via `percentile`) on an empty `dueBlastSamples` — "no blasts
// actually due during the sampling window" is one of PLAN step 18's own named failure
// modes, and it used to produce a bare stack trace instead of the oracle escalation
// block. Short-circuit cleanly here instead: report it as a loud, named failure (the
// oracle's own "samples with >= 1 due blast" assertion already covers it above), not
// a crash.
//
// The short-circuit is the oracle's FLOOR, not merely "> 0". `stressStat`'s whole
// not-the-maximum argument rests on that floor: over 3 due-blast samples,
// `percentile(…, 95)` returns the MAXIMUM — the single noisiest tick, exactly the
// statistic a percentile was chosen to avoid. Such a run already exits non-zero via the
// oracle, but with `>0` it would still publish `{"status":"evaluated","pass":true}` in
// `PERF-REPORT`, indistinguishable from a real 1,427-sample run (the post-P9 measured
// subset) to anyone diffing that line against a later re-measurement.
console.log('');
console.log('=== gate (PLAN step 21) ===');
let gateResult: GateResult | null = null;
// The `=== 0` disjunct is not redundant with the floor: it is what keeps this guard
// correct if `DUE_BLAST_SAMPLES_THRESHOLD` is ever set to 0 (the natural way to write "no
// floor"), where `length < 0` is never true and an empty subset would reach `stressStat`
// and throw — the bare stack trace an earlier fix removed.
if (dueBlastSamples.length === 0 || dueBlastSamples.length < DUE_BLAST_SAMPLES_THRESHOLD) {
  console.log(
    `  gate NOT evaluated — only ${dueBlastSamples.length} due-blast samples in the stress window,`,
  );
  console.log(
    `  under the ${DUE_BLAST_SAMPLES_THRESHOLD} the statistic requires. See the workload`,
  );
  console.log('  oracle failure above ("samples with >= 1 due blast"): this is that failure,');
  console.log('  not a separate one, and it already forces a non-zero exit.');
} else {
  gateResult = evaluateGate(controlResult.samples, dueBlastSamples);
  if (gateResult.status === 'unset') {
    console.log(
      `  R0 is unset — recording run only, gate not enforced; commit this value. Observed R = ${gateResult.r.toFixed(4)} ` +
        `(controlStat p50=${gateResult.controlStat.toFixed(3)}ms, stressStat p95=${gateResult.stressStat.toFixed(3)}ms, ` +
        `audit-only stressStat p99=${gateResult.stressStatP99.toFixed(3)}ms)`,
    );
  } else {
    console.log(
      `  R = ${gateResult.r.toFixed(4)} vs ceiling ${gateResult.ceiling.toFixed(4)} ` +
        `(R0=${gateResult.r0} × TOLERANCE=${TOLERANCE}) — ${gateResult.pass ? 'PASS' : 'FAIL'}`,
    );
  }
}

// 8) The replay-validator checks — are the committed replays accepted by the REAL
// `validate()` re-simulation the server runs against an untrusted client submission? A
// scenario the validator would reject is not one worth measuring: overlapping anchors,
// exhausted bounty, or inputs past the validator's per-tick cap would all still *sample*
// fine and post plausible percentiles.
//
// BOTH replays, not just the stress one: the control supplies the gate's DENOMINATOR
// (`gate.ts`'s `controlStat`), so the argument above applies to it verbatim. Checking one
// and not the other was an asymmetry with no defence.
//
// These run after the measured runs, and that ordering is NOT load-bearing — an earlier
// version of this comment claimed placing them first acted as JIT warm-up and moved
// locally-measured R by 37%. That was refuted by 32 interleaved A/B runs in a standalone
// harness: the measured ordering effect was 0.973x, and the claimed mechanism is absent —
// warm-up would have to lower the control median, and the two arms' control medians
// differed by a factor of 1.001. (That series ran in a throwaway review harness, not
// committed, so its absolute millisecond figures are not this file's `controlStat` and are
// not reproducible from the repo; only the ratio transfers.) The original "1.68 -> 2.31"
// was two samples from a distribution spanning 56% on that machine — see `gate.ts`'s R0
// doc for how noisy this measurement is. The calls stay here only because this is the
// shape R0 was recorded under, and there is no reason to perturb it.
//
// They live in this job rather than in `scenario.test.ts` (where the stress one started)
// because of where the cost lands, not how large it is: the two calls are ~0.6s each
// (stress 645ms, control 576ms), while the test that held the stress one took 21.2s and
// 28.1s on two `ubuntu-latest` runs of the same commit, against a 20s ceiling. See
// `scenario.test.ts`'s note for the measured breakdown.
// ONE keyed record, read by all three consumers below (the FATAL message, the assertion
// list, the report fields). Keeping it keyed removes the loose per-replay booleans that used to
// be transposable between them — a mutation that swapped those two arguments left the
// FATAL line naming one replay while the escalation line named the other, telling the
// operator two different things in one run. It does NOT make transposition
// impossible: handing `allRunAssertions` a re-keyed record still typechecks, and no test
// sees this file. See `escalation.ts` for what that seam does and does not cover.
const validations: Readonly<Record<ReplayKey, ValidationResult>> = {
  stress: validate(stressReplay, bundle),
  control: validate(controlReplay, bundle),
};
for (const key of REPLAY_KEYS) {
  const result = validations[key];
  if (result.ok) continue;
  console.error(
    `\nFATAL: the committed ${key} replay is REJECTED by the replay validator — ` +
      `${result.reason ?? 'no reason given'}.\n` +
      `Every number above was measured against a scenario the real replay path does not ` +
      `accept. If a simVersion bump landed, regenerate with ` +
      `\`pnpm -C packages/perf run gen:scenario\`.`,
  );
}

// 9) The known-open exit-code decision — `escalation.ts`'s `evaluateEscalation`, over
// `allRunAssertions`: the stress oracle's assertions, the control sanity checks, and both
// replay-validator verdicts (none of the last two groups is ever known-open — see
// `escalation.ts`'s doc). A gate that was not evaluated (recording-only R0, or too few
// due-blast samples) counts as `gatePass: true`: it cannot itself force a non-zero exit,
// though the too-few case is already caught above as an ordinary oracle failure.
//
// The validation verdicts join that list rather than setting `process.exitCode` beside
// it, so `evaluateEscalation` stays the ONE place the exit code is decided and the
// `PERF-REPORT:` line below cannot disagree with it (it used to publish
// `"exitNonZero": false` on a run that exited 1). The list is ASSEMBLED in
// `escalation.ts` rather than here for the same reason: this file is excluded from the
// coverage gate and reached by no test, so a verdict dropped from the array here would
// restore that bug with every test still green.
const allAssertions: OracleAssertion[] = allRunAssertions({
  oracle: oracleResult.assertions,
  control: controlAssertions,
  replays: validations,
});
const gatePass = gateResult === null || gateResult.status === 'unset' ? true : gateResult.pass;

const escalation = evaluateEscalation(allAssertions, gatePass);

// Printed, not just reported: without this block an accepted replay and a `validate()`
// call quietly replaced by `{ ok: true }` produce byte-identical human output, and the
// only positive evidence lives in the JSON line — the same "the report can see it, the
// operator cannot" asymmetry this check was added to remove, pointing the other way.
// Selected by NAME EQUALITY against the exported constants, never by a string suffix: a
// suffix literal duplicated here is one a rename would silently drop a row from, and one
// a future oracle assertion could accidentally match into — verified by
// mutation.
const replayAssertionNames = new Set<string>(Object.values(REPLAY_ACCEPTED_ASSERTIONS));
console.log('');
console.log('=== replay validator (the real re-simulation path) ===');
for (const a of allAssertions.filter((x) => replayAssertionNames.has(x.name))) {
  console.log(
    `  [${a.pass ? 'PASS' : 'FAIL'}] ${a.name}: measured=${a.measured} threshold=${a.threshold}`,
  );
}

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
  console.log('=== STALE KNOWN-OPEN WAIVER — THIS FAILS THE JOB ===');
  console.log('The following are on oracle.ts KNOWN_OPEN_ASSERTIONS but PASSED this run.');
  console.log('A stale waiver is its own defect and exits non-zero (owner ruling,');
  console.log('2026-07-31): a waived assertion that gets fixed and later regresses lands');
  console.log('back inside its own waiver band and would otherwise pass unnoticed. The');
  console.log('fix is to remove the entry — an owner ruling, never an auto-removal by a');
  console.log('passing run:');
  for (const name of escalation.staleKnownOpen) {
    console.log(`  - ${name}`);
  }
}

if (gateResult !== null && gateResult.status === 'evaluated' && !gateResult.pass) {
  console.log('');
  console.log('=== GATE FAILURE: R exceeds R0 × TOLERANCE ===');
}

// 10) Machine-readable report — a single JSON line, prefixed `PERF-REPORT: `, so Phase 6
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
    dotPreflight: controlDotPreflight,
    dotDroppedTotal: controlResult.dotDroppedTotal,
    towersPlacedAfterBuild: controlResult.towersPlacedAfterBuild,
    leftoverBountyAfterBuild: controlResult.leftoverBountyAfterBuild,
    assertions: controlAssertions,
    /** As `stress.replayValid`, for the replay that supplies the gate's denominator. */
    replayValid: validations.control.ok,
    replayRejectionReason: validations.control.ok ? null : (validations.control.reason ?? null),
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
    dotPreflight: stressDotPreflight,
    dotDroppedTotal: stressResult.dotDroppedTotal,
    towersPlacedAfterBuild: stressResult.towersPlacedAfterBuild,
    leftoverBountyAfterBuild: stressResult.leftoverBountyAfterBuild,
    routeLength,
    /** Whether the REAL replay validator accepts the committed stress replay. `false`
     *  means every percentile above was measured against a scenario the replay path
     *  rejects, and none of them should be lifted into a document. */
    replayValid: validations.stress.ok,
    replayRejectionReason: validations.stress.ok ? null : (validations.stress.reason ?? null),
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
