// harness.test.ts — a single structural smoke test of `runSampled` against the real
// committed CONTROL replay (the blast-free scenario, cheaper to reason about than the
// stress scenario). This deliberately does NOT assert any oracle-style pass/fail
// threshold — that is `run.ts`'s job, exercised by this packet's Definition of Done
// (`pnpm run perf`), not by `turbo run test`
// (PLAN step 20: a sustained stress run does not belong in the local `verify` loop).
// This test exists only so `harness.ts`'s plumbing (warmup/sample split, build-tick
// snapshot, per-tick field derivation) is covered and proven not to throw — one
// ~2,700-tick run of the lighter control scenario, not the full two-scenario,
// oracle-and-gate pipeline `run.ts` runs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseRulesetJson } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from '@wynding/content';
import type { Replay } from '@wynding/replay';
import { STRESS_RULESET_URL } from '@wynding/content/stress';
import { runSampled, WARMUP_TICKS, SAMPLE_TICKS } from './harness';
import { QUALIFYING_SAMPLES_THRESHOLD } from './oracle';

const bundle = parseRulesetJson(readFileSync(STRESS_RULESET_URL, 'utf8'));
const scenariosDir = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');
const controlReplay = JSON.parse(
  readFileSync(join(scenariosDir, 'control-40x40.replay.json'), 'utf8'),
) as Replay;

describe('runSampled() against the committed control replay', () => {
  const result = runSampled(controlReplay, bundle);

  it('splits exactly WARMUP_TICKS warmup samples and SAMPLE_TICKS sampled ticks', () => {
    expect(result.warmup).toHaveLength(WARMUP_TICKS);
    expect(result.samples).toHaveLength(SAMPLE_TICKS);
  }, 30_000);

  it('tick numbers are contiguous across warmup then samples, starting at 0', () => {
    expect(result.warmup[0]?.tick).toBe(0);
    expect(result.warmup[WARMUP_TICKS - 1]?.tick).toBe(WARMUP_TICKS - 1);
    expect(result.samples[0]?.tick).toBe(WARMUP_TICKS);
    expect(result.samples[SAMPLE_TICKS - 1]?.tick).toBe(WARMUP_TICKS + SAMPLE_TICKS - 1);
  });

  it('every ms is a finite, non-negative number', () => {
    for (const s of [...result.warmup, ...result.samples]) {
      expect(Number.isFinite(s.ms)).toBe(true);
      expect(s.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('snapshots towersPlacedAfterBuild/leftoverBountyAfterBuild after the build-tick prefix', () => {
    // The control replay places all 150 anchors with the blast-free single-form twins
    // — 100 `stress-single` + 50 `stress-chill-single` (`scenario.ts`'s
    // `buildControlReplay`) — same cost (12) as the stress replay's towers either way,
    // so the same "150 × 12 == startingBounty" identity (`layout.ts`'s `towerIdAt`
    // doc) applies here too.
    expect(result.towersPlacedAfterBuild).toBe(150);
    expect(result.leftoverBountyAfterBuild).toBe(0);
  });
});

// QC: the control-only suite above is blast-free (and — before matching the chill
// pair's slow effect — was also slow-free), so `harness.ts`'s `dueBlasts++` and
// `slowedCreeps++` increments (inside `runSampled`'s per-tick loop) never executed
// under any test, and the package's own coverage report named both lines uncovered.
// Surviving mutants included
// `radiusFp > 0` -> `false`, `slowedCreeps` never incremented, `liveCreeps` hard-coded
// to `999`, `phase` hard-coded to `'running'`, `ms` hard-coded to `0`, `WARMUP_TICKS`
// 200->20, `SAMPLE_TICKS` 2500->250, and moving the `StepEvents` allocation INSIDE the
// timed region. This suite runs the real, gated STRESS replay and asserts the actual
// numbers it produces, closing that gap.
const stressReplay = JSON.parse(
  readFileSync(join(scenariosDir, 'stress-40x40.replay.json'), 'utf8'),
) as Replay;

describe('runSampled() against the committed STRESS replay — real due-blast/status coverage', () => {
  const result = runSampled(stressReplay, bundle);

  it('SAMPLE_TICKS is at least the qualifying-sample floor it is measured against — otherwise a shrunk window would be self-confirming rather than caught', () => {
    // The prior `toHaveLength(SAMPLE_TICKS)` assertions above prove nothing about
    // SAMPLE_TICKS's own value: both sides of that comparison read the same
    // (possibly-mutated) constant. This compares it against an INDEPENDENT constant
    // from `oracle.ts` instead.
    expect(SAMPLE_TICKS).toBeGreaterThanOrEqual(QUALIFYING_SAMPLES_THRESHOLD);
  });

  it('peak live creeps reaches 304 — every scheduled spawn (16 x 19) concurrently live at peak', () => {
    const peak = result.samples.reduce((max, s) => Math.max(max, s.liveCreeps), 0);
    expect(peak).toBe(304);
  });

  it('peak slowed creeps reaches 304 — the chill towers keep the whole live population under an active status at peak', () => {
    const peak = result.samples.reduce((max, s) => Math.max(max, s.slowedCreeps), 0);
    expect(peak).toBe(304);
  });

  it('due blasts per sample: max 8, median 1', () => {
    const dueBlasts = result.samples.map((s) => s.dueBlasts);
    const measuredMax = dueBlasts.reduce((m, n) => Math.max(m, n), 0);
    const sorted = [...dueBlasts].sort((a, b) => a - b);
    const medianIndex = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(0.5 * sorted.length) - 1),
    );
    expect(measuredMax).toBe(8);
    expect(sorted[medianIndex]).toBe(1);
  });

  it('at least some ms > 0 — step() actually took measurable wall-clock time', () => {
    expect(result.samples.some((s) => s.ms > 0)).toBe(true);
  });
}, 30_000);

// QC, continued: the un-short-circuited loop is `runSampled`'s single
// most argued-for design decision (its own header comment: "the ENTIRE POINT of the
// un-short-circuited loop"), yet nothing exercised it — every replay above stays
// `running` for its whole sampled window. This builds a genuinely tiny scenario (the
// shipped `wynding-core` bundle, 10 starting lives, 10 unstopped creeps at leakCost 1
// each — an empty `tickInputs` places no towers, so the wave leaks out entirely and
// the match reaches `lost` well inside the sampled window) and proves the harness
// keeps stepping past that terminal phase instead of stopping.
describe('runSampled() does not short-circuit at a terminal phase', () => {
  const coreBundle = getBundledRuleset('wynding-core');
  const boardId = defaultBoardId(coreBundle);
  const terminatingReplay: Replay = {
    seed: 1,
    boardId,
    rulesetHash: '',
    simVersion: 0,
    tickInputs: [],
  };
  const result = runSampled(terminatingReplay, coreBundle);

  it('still records a full SAMPLE_TICKS-length window, not a short one', () => {
    expect(result.samples).toHaveLength(SAMPLE_TICKS);
  }, 30_000);

  it('contains at least one non-running sample — the match resolved inside the window and the loop kept stepping past it', () => {
    expect(result.samples.some((s) => s.phase !== 'running')).toBe(true);
  });
});
