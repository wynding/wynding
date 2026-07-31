#!/usr/bin/env -S tsx
// dot-bench.ts — the DoT resident-table cost measurement (PLAN step 21). Its whole
// purpose is to set `MAX_DOT_RECORDS` (`@wynding/sim`'s `combat.ts`) on evidence,
// before sv9 ships: once shipped, moving it is a behaviour change owing its own
// `simVersion` bump (the `AOE_SCAN_CEILING` rule), so this is the only chance.
//
// A CLI task, not a Vitest test (`run.ts`'s precedent). `packages/perf`'s `test`
// script runs `vitest run --coverage`, and `scenario.test.ts` already documents why
// a sustained simulation run does not belong there: under coverage the same order
// of work cost ~7.5s locally and over 20s on `ubuntu-latest`. A wall-clock gate
// inside an instrumented test measures the instrumentation, not the workload. So:
// `bench:dot` (`tsx src/dot-bench.ts`) in `package.json`, run directly as
// `pnpm -C packages/perf run bench:dot` — never wired into `pnpm run perf`,
// `verify`, or any CI workflow (this is a measurement a human reads once, in this
// story's PR, to CHOOSE a constant — not a gate anything depends on).
// `vitest.config.ts` excludes this file from the coverage gate for the same reason
// it excludes `run.ts`/`generate.ts`: its correctness is exercised by actually
// running it, and `dot-bench.test.ts` covers only the pure, structural helpers
// below (`topUpDotRecords`/`makeFillerDotRecord`) — never a wall-clock assertion.
//
// Reports p95 and p99, never a mean (`gate.ts`'s own case: a mean hides exactly the
// GC/scheduler tails a sustained run exists to expose). Relative, not an absolute
// millisecond gate (`gate.ts`'s `R0` doc: an absolute threshold on an unpinned
// runner cannot speak to ADR 0005's device budget — the untransferable `R0 = 1.69`
// mistake). So the same scene runs TWICE in one process, once with the DoT record
// table held AT the cap, once with `dots: []`, and this file reports both
// percentiles for each arm plus their ratio.
//
// The scene is `scenario.ts`'s CONTROL replay — reused, not reinvented
// (`buildControlReplay`, blast-free): this bench is isolating the cost of a full
// `dots` table, and `gate.ts` already established that a blast-bearing scenario
// mixes in AoE membership-scan cost that would dilute exactly the signal this file
// exists to isolate. `MAX_DOT_RECORDS` synthetic filler records are seeded against
// the scene's OWN live creep ids (never a fabricated id) so the per-tick bucket
// lookup (`combat.ts`'s `runCombat`, `dotsByTarget`) resolves against real SoA
// rows, not phantom targets the sweep would silently never match — exercising the
// real lookup, not just the bucketing pass over an already-known-empty target set.
//
// CAP-ADJACENCY IS ASSERTED PER SAMPLE (the property most easily lost, PLAN step
// 21's own warning): movement, leaks, deaths and expiry all drain a resident
// `dots` table mid-window, which would quietly measure a smaller table than the
// cap and publish that as if it were the cap. So: warm-up, window length and every
// filler record's retention are pinned (`WARMUP_TICKS`/`SAMPLE_TICKS`, reused from
// `harness.ts`; `FILLER_HORIZON_TICKS` below keeps every filler record's
// `nextTickTick`/`untilTick` far past the sampled window, so nothing a filler
// record itself does can drain the table), the table is topped back up to exactly
// `MAX_DOT_RECORDS` OUTSIDE the timed region whenever the scene's own deaths/leaks
// shrink it, and `runArm` asserts the exact expected count (`MAX_DOT_RECORDS` or
// `0`) immediately before every timed `step()`. A run that cannot hold the table at
// the cap (the scene has zero live creeps to seed against) throws loudly rather
// than reporting a smaller-table number as though it were the cap.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  compileRuleset,
  createInitialState,
  parseRulesetJson,
  step,
  MAX_DOT_RECORDS,
  type CompiledRuleset,
  type DotRecord,
  type SimState,
  type StepEvents,
} from '@wynding/sim';
import type { Replay } from '@wynding/replay';
import { STRESS_RULESET_URL } from '@wynding/content/stress';
import { buildControlReplay } from './scenario';
import { WARMUP_TICKS, SAMPLE_TICKS } from './harness';
import { percentile } from './stats';

/** Base for synthetic filler DoT-record source ids — comfortably beyond any id
 *  `state.nextEntityId` reaches on the control scenario's 150 towers and few
 *  hundred creeps, so a filler record's `sourceId` can never collide with a
 *  genuine entity's. Only the SEQUENCE from here matters for uniqueness within one
 *  arm's run (`makeSourceIdAllocator`) — the exact base is arbitrary. */
const FILLER_SOURCE_ID_BASE = 1_000_000_000;

/** Strictly beyond `WARMUP_TICKS + SAMPLE_TICKS` (2,700) — a filler record's
 *  `cadenceTicks`/`nextTickTick`/`untilTick` are pinned to this so NO filler record
 *  ever ticks or expires inside this bench's run. Deliberate, not an oversight: the
 *  two arms this file compares (`dots` at the cap vs. `dots: []`) are constructed
 *  to differ ONLY in resident-table size, never in whether a tick actually fires
 *  `applyDirect` — so the measured delta is the cost of carrying `MAX_DOT_RECORDS`
 *  records through `canonicalDotRecords`, the per-tick bucketing pass, and the
 *  live-creep bucket lookup (`combat.ts`'s `runCombat`), never the cost of a real
 *  firing record's damage/death cascade — that path is already exercised by
 *  `combat.test.ts`. */
const FILLER_HORIZON_TICKS = 10_000_000;

/** Returns a closure handing out a strictly increasing, never-repeating source id
 *  starting at `FILLER_SOURCE_ID_BASE` — every filler record created in one arm's
 *  run gets its own id, so `canonicalDotRecords`'s `(targetId, sourceId)` dedup
 *  (`combat.ts`) never treats a fresh top-up as a REFRESH of an existing record; a
 *  top-up is always a genuine new entry, which is what growing the table back to
 *  the cap requires. */
export function makeSourceIdAllocator(): () => number {
  let next = FILLER_SOURCE_ID_BASE;
  return () => next++;
}

/** One synthetic, never-firing DoT record targeting a LIVE creep id — never a
 *  fabricated one, so the per-creep bucket lookup this bench exists to exercise
 *  resolves against a real SoA row, not a phantom target the sweep silently never
 *  matches. See `FILLER_HORIZON_TICKS` for why it never ticks or expires. */
export function makeFillerDotRecord(targetId: number, sourceId: number): DotRecord {
  return {
    targetId,
    sourceId,
    amount: 1,
    cadenceTicks: FILLER_HORIZON_TICKS,
    nextTickTick: FILLER_HORIZON_TICKS,
    untilTick: FILLER_HORIZON_TICKS,
  };
}

/**
 * Tops `existing` back up to exactly `cap` records, cycling `liveCreepIds` in
 * order so records spread across every currently-live creep rather than piling
 * onto one — the bucket lookup this bench measures is per-CREEP, not per-record,
 * so a table entirely on one target would under-exercise it. Each filler's
 * `sourceId` comes from `allocateSourceId` (never reused), so a top-up always
 * GROWS the table rather than refreshing an existing pair. A no-op (returns
 * `existing`, truncated defensively to `cap`) once already at capacity.
 *
 * Throws if `existing.length < cap` and `liveCreepIds` is empty: there is no live
 * creep to seed a valid record against, and PLAN step 21 is explicit that "a run
 * that cannot hold the table at the cap must fail loudly, not report a
 * smaller-table number as if it were the cap" — silently returning a short table
 * would be exactly that.
 */
export function topUpDotRecords(
  existing: readonly DotRecord[],
  liveCreepIds: readonly number[],
  cap: number,
  allocateSourceId: () => number,
): DotRecord[] {
  if (existing.length >= cap) return existing.slice(0, cap);
  if (liveCreepIds.length === 0) {
    throw new Error(
      `topUpDotRecords: table has ${existing.length}/${cap} records and the scene has ` +
        'ZERO live creeps to seed the rest against — cannot hold the table at the cap. ' +
        'Widen the warm-up or pick a different sampled window rather than reporting a ' +
        'smaller-table number as the cap.',
    );
  }
  const out = existing.slice();
  let i = 0;
  while (out.length < cap) {
    const targetId = liveCreepIds[i % liveCreepIds.length] as number;
    out.push(makeFillerDotRecord(targetId, allocateSourceId()));
    i++;
  }
  return out;
}

/** One sampled tick's raw `step()` wall-clock — deliberately narrower than
 *  `harness.ts`'s `SampledTick`: this bench needs nothing beyond the timing
 *  itself, since the cap-adjacency assertion runs BEFORE the timed region, not
 *  from anything the sample would carry. */
export interface DotBenchSample {
  readonly tick: number;
  readonly ms: number;
}

interface RunArmResult {
  readonly samples: readonly DotBenchSample[];
}

/**
 * Runs `replay.tickInputs` against `ruleset` for `WARMUP_TICKS + SAMPLE_TICKS`
 * ticks (`harness.ts`'s own constants, reused rather than re-declared). When
 * `atCap` is true, every sampled tick's `dots` table is topped back up to exactly
 * `MAX_DOT_RECORDS` — using the CURRENT live creep ids, i.e. whatever the previous
 * tick's `step()` left behind — outside the timed region, then asserted before the
 * timed `step()` call; when false, `dots` is asserted empty (this scene's towers
 * carry no `dot` effect, so it never grows on its own — the assertion is a
 * cross-check against silent drift, not a tautology this file relies on).
 */
function runArm(replay: Replay, ruleset: CompiledRuleset, atCap: boolean): RunArmResult {
  let state: SimState = createInitialState(replay.seed, ruleset);
  const allocateSourceId = makeSourceIdAllocator();
  const totalTicks = WARMUP_TICKS + SAMPLE_TICKS;
  const samples: DotBenchSample[] = [];

  for (let tick = 0; tick < totalTicks; tick++) {
    const inputs = replay.tickInputs[tick] ?? [];
    const inSample = tick >= WARMUP_TICKS;

    if (inSample) {
      if (atCap) {
        state.dots = topUpDotRecords(
          state.dots,
          state.creeps.id,
          MAX_DOT_RECORDS,
          allocateSourceId,
        );
      }
      const expected = atCap ? MAX_DOT_RECORDS : 0;
      if (state.dots.length !== expected) {
        throw new Error(
          `dot-bench: expected ${expected} resident dot record(s) immediately before ` +
            `tick ${tick}'s timed step(), found ${state.dots.length}.`,
        );
      }
    }

    // Allocated OUTSIDE the timed region, matching `harness.ts`'s `runSampled`:
    // `StepEvents`'s arrays are a per-tick presentational out-param, unrelated to
    // `step()`'s own cost.
    const events: StepEvents = { impactPoints: [], fired: [] };
    const start = performance.now();
    state = step(state, ruleset, inputs, events);
    const ms = performance.now() - start;

    if (inSample) samples.push({ tick, ms });
  }

  return { samples };
}

interface PercentileTable {
  readonly p95: number;
  readonly p99: number;
}

function percentileTable(samples: readonly DotBenchSample[]): PercentileTable {
  const ms = samples.map((s) => s.ms);
  return { p95: percentile(ms, 95), p99: percentile(ms, 99) };
}

function main(): void {
  const bundleText = readFileSync(STRESS_RULESET_URL, 'utf8');
  const bundle = parseRulesetJson(bundleText);
  // The CONTROL scenario, not the stress one: blast-free, so this bench isolates
  // the DoT-table cost from the AoE membership-scan cost `gate.ts` already
  // measures separately.
  const replay = buildControlReplay(bundle);
  const ruleset = compileRuleset(bundle, replay.boardId);

  console.log(`Running dot-bench: dots at cap (MAX_DOT_RECORDS=${MAX_DOT_RECORDS})...`);
  const atCapResult = runArm(replay, ruleset, true);
  console.log('Running dot-bench: dots empty...');
  const emptyResult = runArm(replay, ruleset, false);

  const atCapTable = percentileTable(atCapResult.samples);
  const emptyTable = percentileTable(emptyResult.samples);
  const ratio = { p95: atCapTable.p95 / emptyTable.p95, p99: atCapTable.p99 / emptyTable.p99 };

  console.log('');
  console.log(
    `=== dot-bench step() ms (WARMUP_TICKS=${WARMUP_TICKS}, SAMPLE_TICKS=${SAMPLE_TICKS}) ===`,
  );
  console.log(
    `  dots at cap (n=${atCapResult.samples.length})  p95=${atCapTable.p95.toFixed(3)}ms ` +
      `p99=${atCapTable.p99.toFixed(3)}ms`,
  );
  console.log(
    `  dots empty  (n=${emptyResult.samples.length})  p95=${emptyTable.p95.toFixed(3)}ms ` +
      `p99=${emptyTable.p99.toFixed(3)}ms`,
  );
  console.log('');
  console.log(
    `  ratio (at-cap / empty)  p95=${ratio.p95.toFixed(4)}x  p99=${ratio.p99.toFixed(4)}x`,
  );
  console.log('');
  console.log(
    'This is a MEASUREMENT — read once, by a human, to choose MAX_DOT_RECORDS in this ' +
      "story's PR. Nothing in CI depends on it: not wired into `pnpm run perf`, `verify`, " +
      'or any workflow (PLAN step 21).',
  );

  const report = {
    warmupTicks: WARMUP_TICKS,
    sampleTicks: SAMPLE_TICKS,
    maxDotRecords: MAX_DOT_RECORDS,
    atCap: { percentiles: atCapTable, sampleCount: atCapResult.samples.length },
    empty: { percentiles: emptyTable, sampleCount: emptyResult.samples.length },
    ratio,
  };
  console.log('');
  console.log(`DOT-BENCH-REPORT: ${JSON.stringify(report)}`);
}

// Guarded, unlike `run.ts`/`generate.ts` (which have no exports at all a test
// could import): `dot-bench.test.ts` imports this file's pure helpers
// (`topUpDotRecords`/`makeFillerDotRecord`), and importing a module must never
// itself run a multi-thousand-tick sustained simulation. `main()` only runs when
// this file is the process's own entry point — i.e. `tsx src/dot-bench.ts`,
// exactly the `bench:dot` script.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) main();
