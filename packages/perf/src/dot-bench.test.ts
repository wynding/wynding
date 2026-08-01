// dot-bench.test.ts — structural coverage ONLY (PLAN step 21): that the state
// builder (`topUpDotRecords`) produces the intended record count and record shape,
// and that `makeFillerDotRecord` never ticks or expires within any plausible
// sampled window. No wall-clock assertion here — `dot-bench.ts`'s own header
// explains why timing belongs in the CLI (`pnpm -C packages/perf run bench:dot`),
// never in a test `turbo run test`/`pnpm run verify` runs on every change.

import { describe, it, expect } from 'vitest';
import { MAX_DOT_RECORDS, compileRuleset, createInitialState, step } from '@wynding/sim';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STRESS_RULESET_URL, STRESS_BOARD_ID } from '@wynding/content/stress';
import { makeFillerDotRecord, makeSourceIdAllocator, topUpDotRecords } from './dot-bench';
import { WARMUP_TICKS, SAMPLE_TICKS } from './harness';

describe('makeFillerDotRecord()', () => {
  it('carries the given targetId/sourceId and a valid, ≥1 amount/cadence', () => {
    const rec = makeFillerDotRecord(7, 1_000_000_007);
    expect(rec.targetId).toBe(7);
    expect(rec.sourceId).toBe(1_000_000_007);
    expect(rec.amount).toBeGreaterThanOrEqual(1);
    expect(rec.cadenceTicks).toBeGreaterThanOrEqual(1);
    expect(rec.untilTick).toBeGreaterThanOrEqual(rec.nextTickTick);
  });

  it('never becomes due, and never expires, within WARMUP_TICKS + SAMPLE_TICKS', () => {
    // The cap-adjacency property the whole bench depends on: a filler record that
    // ticked or expired mid-window would drain the table on its own, independent
    // of the scene's deaths/leaks `topUpDotRecords` exists to compensate for.
    const rec = makeFillerDotRecord(1, 1);
    const totalTicks = WARMUP_TICKS + SAMPLE_TICKS;
    expect(rec.nextTickTick).toBeGreaterThan(totalTicks);
    expect(rec.untilTick).toBeGreaterThan(totalTicks);
  });
});

describe('makeSourceIdAllocator()', () => {
  it('hands out strictly increasing, never-repeating ids', () => {
    const next = makeSourceIdAllocator();
    const a = next();
    const b = next();
    const c = next();
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('two independent allocators start from the same value (fresh per arm)', () => {
    const first = makeSourceIdAllocator()();
    const second = makeSourceIdAllocator()();
    expect(first).toBe(second);
  });
});

describe('topUpDotRecords()', () => {
  it('grows an empty table to exactly `cap`, cycling the given live creep ids', () => {
    const liveCreepIds = [11, 12, 13];
    const out = topUpDotRecords([], liveCreepIds, 10, makeSourceIdAllocator());
    expect(out).toHaveLength(10);
    // Every record targets a LIVE creep id — never a fabricated one (PLAN step 21:
    // "seeded against live creep ids ... not just the bucketing pass").
    for (const rec of out) {
      expect(liveCreepIds).toContain(rec.targetId);
    }
    // Cycles round-robin over the live ids in order, so every target gets a fair
    // share of the table rather than one id absorbing it all.
    expect(out.map((r) => r.targetId)).toEqual([11, 12, 13, 11, 12, 13, 11, 12, 13, 11]);
  });

  it('every filler record gets a distinct sourceId, so growth is real, never a refresh', () => {
    const out = topUpDotRecords([], [1], 5, makeSourceIdAllocator());
    const sourceIds = new Set(out.map((r) => r.sourceId));
    expect(sourceIds.size).toBe(5);
  });

  it('is a no-op (returns the existing table) once already at `cap`', () => {
    const existing = topUpDotRecords([], [1, 2], 4, makeSourceIdAllocator());
    const result = topUpDotRecords(existing, [1, 2], 4, makeSourceIdAllocator());
    expect(result).toHaveLength(4);
    expect(result).toEqual(existing);
  });

  it('truncates defensively if somehow handed more than `cap` already', () => {
    const over = topUpDotRecords([], [1], 6, makeSourceIdAllocator());
    const result = topUpDotRecords(over, [1], 4, makeSourceIdAllocator());
    expect(result).toHaveLength(4);
    expect(result).toEqual(over.slice(0, 4));
  });

  it('tops a partially-drained table back up to exactly `cap`, keeping existing records', () => {
    const seeded = topUpDotRecords([], [1, 2, 3], MAX_DOT_RECORDS, makeSourceIdAllocator());
    const drained = seeded.slice(0, MAX_DOT_RECORDS - 5); // simulate 5 creep deaths
    const allocator = makeSourceIdAllocator();
    const topped = topUpDotRecords(drained, [4, 5], MAX_DOT_RECORDS, allocator);
    expect(topped).toHaveLength(MAX_DOT_RECORDS);
    expect(topped.slice(0, drained.length)).toEqual(drained);
  });

  it('throws rather than silently reporting a short table when no live creeps exist', () => {
    expect(() => topUpDotRecords([], [], 10, makeSourceIdAllocator())).toThrow(
      /cannot hold the table at the cap/,
    );
  });

  it('does not throw when already at cap even with zero live creeps (nothing left to seed)', () => {
    const atCap = topUpDotRecords([], [1], 3, makeSourceIdAllocator());
    expect(() => topUpDotRecords(atCap, [], 3, makeSourceIdAllocator())).not.toThrow();
  });
});

// The regression Codex caught on PR #78. A filler must survive `validDotRecord`, or every
// timed `step()` canonicalizes the table to empty and the bench measures nothing — while
// its own pre-step length assertion still passes, because the top-up runs before it. QC
// round 2 moved a `cadenceTicks <= 1_000_000` bound onto `validDotRecord` and broke the
// tool that way (the curve itself predates the bound and still reproduces).
//
// This is deliberately an END-TO-END witness, not an assertion that the cadence is under
// some literal: restating a bound defined in THIS package would stay green if
// `validDotRecord` tightened again, which is precisely the recurrence it must prevent.
// It drives a real `step()` and asserts the record is still resident afterwards.
describe('makeFillerDotRecord() — survives the sim canonicalizer (PR #78)', () => {
  it('a filler seeded into SimState.dots is still resident after a real step()', () => {
    const bundle = JSON.parse(
      readFileSync(fileURLToPath(STRESS_RULESET_URL), 'utf8'),
    ) as Parameters<typeof compileRuleset>[0];
    const ruleset = compileRuleset(bundle, STRESS_BOARD_ID);
    // Step until the scene actually has a live creep: a record whose target is not among
    // the survivors is dropped by the SWEEP, which would mask the canonicalization
    // question this test exists to ask.
    let state = createInitialState(1, ruleset);
    for (let t = 0; t < 400 && state.creeps.id.length === 0; t++) {
      state = step(state, ruleset, []);
    }
    expect(state.creeps.id.length).toBeGreaterThan(0);
    const targetId = state.creeps.id[0]!;
    state.dots = [makeFillerDotRecord(targetId, 5_000)];

    const next = step(state, ruleset, []);

    expect(next.dots.length).toBe(1);
    expect(next.dots[0]).toMatchObject({ sourceId: 5_000 });
  });
});
