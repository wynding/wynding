// oracle.test.ts — proves the workload oracle (PLAN step 18) actually catches every
// silent-idle failure mode it exists for (HANDOFF-M2-S4B.md: "the workload oracle is
// the point of the whole story"). Every test here feeds SYNTHETIC sample arrays — no
// sim invocation — because `runOracle` is a pure function of `(samples,
// towersPlacedAfterBuild, leftoverBountyAfterBuild, routeLength)`.

import { describe, it, expect } from 'vitest';
import {
  runOracle,
  isQualifyingSample,
  MEDIAN_LIVE_CREEPS_THRESHOLD,
  ROUTE_LENGTH_FLOOR,
  PEAK_DOT_RECORDS_THRESHOLD,
  DOT_RECORD_DEPTH_THRESHOLD,
  DOT_ACTIVE_SAMPLES_THRESHOLD,
  PEAK_ARMORED_LIVE_THRESHOLD,
  DOT_DROPPED_THRESHOLD,
  KNOWN_OPEN_ASSERTIONS,
  type OracleInput,
} from './oracle';
import type { SampledTick } from './harness';

/** A single "everything comfortably passes" sample, reused as the base for every test
 *  below via spread-overrides — keeps each test's diff from the passing baseline
 *  legible instead of re-stating every field. The DoT/armor figures echo the real
 *  scene's measured stress-arm figures (175 records / 19 carriers, PLAN.md step 17's
 *  reference table), not round numbers, so a passing baseline stays representative of
 *  what the real run reports. */
function baseSample(overrides: Partial<SampledTick> = {}): SampledTick {
  return {
    tick: 0,
    ms: 0.2,
    dueBlasts: 1,
    liveCreeps: 300,
    slowedCreeps: 120,
    phase: 'running',
    dotTicks: 5,
    dotDropped: 0,
    dotRecords: 175,
    dotCarriers: 19,
    armoredLive: 60,
    ...overrides,
  };
}

/** A window of `n` passing samples, ticks numbered from `WARMUP_TICKS` (200) up —
 *  matching what `harness.ts`'s `runSampled` would produce for a genuinely healthy
 *  run. */
function passingWindow(n: number): SampledTick[] {
  return Array.from({ length: n }, (_, i) => baseSample({ tick: 200 + i }));
}

/** The full oracle input for a run that would pass every assertion, before any
 *  per-test override. */
function passingInput(overrides: Partial<OracleInput> = {}): OracleInput {
  return {
    samples: passingWindow(2_500),
    towersPlacedAfterBuild: 150,
    leftoverBountyAfterBuild: 0,
    routeLength: 700,
    dotDroppedTotal: 0,
    ...overrides,
  };
}

describe('a fully healthy run passes every assertion', () => {
  it('runOracle(passingInput()).pass is true', () => {
    const result = runOracle(passingInput());
    expect(result.pass).toBe(true);
    expect(result.assertions.every((a) => a.pass)).toBe(true);
  });
});

describe('phase !== running anywhere in the window fails the phase assertion', () => {
  it('a run that terminates mid-window fails "phase === running for every sample"', () => {
    const samples = passingWindow(2_500);
    // Simulate termination partway through: every sample from index 1000 onward is
    // 'won' — the terminal-freeze scenario PLAN step 18 names explicitly.
    for (let i = 1000; i < samples.length; i++) {
      samples[i] = { ...samples[i]!, phase: 'won' };
    }
    const result = runOracle(passingInput({ samples }));
    const phaseAssertion = result.assertions.find(
      (a) => a.name === 'phase === running for every sample',
    );
    expect(phaseAssertion?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('a single non-running sample is enough to fail it', () => {
    const samples = passingWindow(2_500);
    samples[2499] = { ...samples[2499]!, phase: 'lost' };
    const result = runOracle(passingInput({ samples }));
    const phaseAssertion = result.assertions.find(
      (a) => a.name === 'phase === running for every sample',
    );
    expect(phaseAssertion?.pass).toBe(false);
  });

  it('an EMPTY window fails closed rather than passing vacuously (QC: the empty-window vacuous pass)', () => {
    // `[].every(...)` is `true` in JavaScript — without an explicit non-empty guard,
    // an empty sampling window (itself a broken run) would report "every sample
    // passed" over zero samples.
    const result = runOracle(passingInput({ samples: [] }));
    const phaseAssertion = result.assertions.find(
      (a) => a.name === 'phase === running for every sample',
    );
    expect(phaseAssertion?.measured).toBe(false);
    expect(phaseAssertion?.pass).toBe(false);
  });
});

describe('the due-blast sample floor is a pinned boundary, not "roughly 500"', () => {
  it('499 due-blast samples fails', () => {
    const samples = passingWindow(2_500).map((s, i) => (i < 499 ? s : { ...s, dueBlasts: 0 }));
    const result = runOracle(passingInput({ samples }));
    const assertion = result.assertions.find((a) => a.name === 'samples with >= 1 due blast');
    expect(assertion?.measured).toBe(499);
    expect(assertion?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('500 due-blast samples passes', () => {
    const samples = passingWindow(2_500).map((s, i) => (i < 500 ? s : { ...s, dueBlasts: 0 }));
    const result = runOracle(passingInput({ samples }));
    const assertion = result.assertions.find((a) => a.name === 'samples with >= 1 due blast');
    expect(assertion?.measured).toBe(500);
    expect(assertion?.pass).toBe(true);
  });
});

describe('accepted tower placements is a pinned boundary', () => {
  it('149 towers fails', () => {
    const result = runOracle(passingInput({ towersPlacedAfterBuild: 149 }));
    const assertion = result.assertions.find((a) => a.name === 'accepted tower placements');
    expect(assertion?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('150 towers passes', () => {
    const result = runOracle(passingInput({ towersPlacedAfterBuild: 150 }));
    const assertion = result.assertions.find((a) => a.name === 'accepted tower placements');
    expect(assertion?.pass).toBe(true);
  });

  it('151 towers also fails (exactly 150, not "at least")', () => {
    const result = runOracle(passingInput({ towersPlacedAfterBuild: 151 }));
    const assertion = result.assertions.find((a) => a.name === 'accepted tower placements');
    expect(assertion?.pass).toBe(false);
  });
});

describe('non-zero leftover bounty fails, independently of the placement count', () => {
  it('leftoverBountyAfterBuild = 1 fails even when towersPlacedAfterBuild reads 150', () => {
    const result = runOracle(
      passingInput({ towersPlacedAfterBuild: 150, leftoverBountyAfterBuild: 1 }),
    );
    const assertion = result.assertions.find((a) => a.name === 'leftover bounty after build');
    expect(assertion?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('leftoverBountyAfterBuild = 0 passes', () => {
    const result = runOracle(passingInput({ leftoverBountyAfterBuild: 0 }));
    const assertion = result.assertions.find((a) => a.name === 'leftover bounty after build');
    expect(assertion?.pass).toBe(true);
  });
});

describe('a window where every sample has 0 live creeps fails the qualifying-samples assertion', () => {
  it('0 live creeps everywhere also drives peak concurrency and peak status to 0', () => {
    const samples = passingWindow(2_500).map((s) => ({ ...s, liveCreeps: 0, slowedCreeps: 0 }));
    const result = runOracle(passingInput({ samples }));
    const qualifying = result.assertions.find((a) => a.name === 'qualifying sustained samples');
    const peakLive = result.assertions.find((a) => a.name === 'peak concurrent live creeps');
    expect(qualifying?.measured).toBe(0);
    expect(qualifying?.pass).toBe(false);
    expect(peakLive?.measured).toBe(0);
    expect(peakLive?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });
});

describe('route length', () => {
  // ONE assertion since the owner ruling of 2026-07-31 re-pinned the floor from the
  // pre-measurement 600 to the measured 329. The story shipped two — a waived 600 and an
  // un-waivable 329 beneath it — because the waiver otherwise left everything below 329
  // unmonitored: a regression from 329 to 1 printed under the same `[KNOWN-OPEN]` tag and
  // exited 0. With the gap closed by ruling there is nothing left to waive, so the pair
  // collapses to a single un-waivable tripwire at the measured value.
  it('a route under the 329-cell floor fails', () => {
    const result = runOracle(passingInput({ routeLength: 328 }));
    const assertion = result.assertions.find((a) => a.name === 'scripted maze route length');
    expect(assertion?.measured).toBe(328);
    expect(assertion?.threshold).toBe(ROUTE_LENGTH_FLOOR);
    expect(assertion?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('exactly the 329-cell floor passes (>=, not >)', () => {
    const result = runOracle(passingInput({ routeLength: 329 }));
    const assertion = result.assertions.find((a) => a.name === 'scripted maze route length');
    expect(assertion?.pass).toBe(true);
    expect(result.pass).toBe(true);
  });

  it('is a zero-slack tripwire: the committed scene measures exactly the floor', () => {
    // Deliberate. The sim is deterministic against a committed replay, so an unchanged
    // layout reproduces 329 every run — there is no noise for slack to absorb, and any
    // drop is a real regression.
    expect(ROUTE_LENGTH_FLOOR).toBe(329);
  });

  it('there is exactly ONE route-length assertion — the waived twin is gone', () => {
    const result = runOracle(passingInput({ routeLength: 329 }));
    const routeAssertions = result.assertions.filter((a) => a.name.includes('route length'));
    expect(routeAssertions).toHaveLength(1);
  });
});

describe('median live creeps (sustained load) is a pinned boundary', () => {
  it('a median of 199 live creeps fails, 200 passes', () => {
    const failSamples = passingWindow(2_500).map((s, i) =>
      i < 1250 ? { ...s, liveCreeps: 199 } : { ...s, liveCreeps: 300 },
    );
    const failResult = runOracle(passingInput({ samples: failSamples }));
    const failAssertion = failResult.assertions.find(
      (a) => a.name === 'median live creeps (sustained load)',
    );
    expect(failAssertion?.measured).toBe(199);
    expect(failAssertion?.threshold).toBe(MEDIAN_LIVE_CREEPS_THRESHOLD);
    expect(failAssertion?.pass).toBe(false);
    expect(failResult.pass).toBe(false);

    const passSamples = passingWindow(2_500).map((s, i) =>
      i < 1250 ? { ...s, liveCreeps: 200 } : { ...s, liveCreeps: 300 },
    );
    const passResult = runOracle(passingInput({ samples: passSamples }));
    const passAssertion = passResult.assertions.find(
      (a) => a.name === 'median live creeps (sustained load)',
    );
    expect(passAssertion?.measured).toBe(200);
    expect(passAssertion?.pass).toBe(true);
  });

  // The degenerate window `oracle.ts`'s own doc comment names as the reason this
  // assertion exists: one tick at peak (304 live creeps) followed by every other tick
  // in the window at a single live creep. The peak-concurrency floor alone passes this
  // (peak = 304 >= 280); the median assertion is what catches it.
  it('one peak tick followed by 2,499 near-empty ticks fails the median even though peak passes', () => {
    const samples = passingWindow(2_500).map((s, i) =>
      i === 0 ? { ...s, liveCreeps: 304 } : { ...s, liveCreeps: 1 },
    );
    const result = runOracle(passingInput({ samples }));
    const peak = result.assertions.find((a) => a.name === 'peak concurrent live creeps');
    const median = result.assertions.find((a) => a.name === 'median live creeps (sustained load)');
    expect(peak?.measured).toBe(304);
    expect(peak?.pass).toBe(true);
    expect(median?.measured).toBe(1);
    expect(median?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  // An empty sampling window falls back to a median of 0 (`oracle.ts`: guarded the
  // same fail-closed way as `allRunning`, since `percentile` throws on an empty set) —
  // 0 reads as a real, failing measurement rather than an absent one.
  it('an EMPTY window reports a median of 0 and fails, rather than throwing or passing vacuously', () => {
    const result = runOracle(passingInput({ samples: [] }));
    const median = result.assertions.find((a) => a.name === 'median live creeps (sustained load)');
    expect(median?.measured).toBe(0);
    expect(median?.pass).toBe(false);
  });
});

describe('peak concurrent live creeps and peak active slow status are pinned boundaries', () => {
  it('a peak of 279 live creeps fails, 280 passes', () => {
    const failSamples = passingWindow(2_500).map((s, i) =>
      i === 0 ? { ...s, liveCreeps: 279 } : { ...s, liveCreeps: 100 },
    );
    const failResult = runOracle(passingInput({ samples: failSamples }));
    expect(failResult.assertions.find((a) => a.name === 'peak concurrent live creeps')?.pass).toBe(
      false,
    );

    const passSamples = passingWindow(2_500).map((s, i) =>
      i === 0 ? { ...s, liveCreeps: 280 } : { ...s, liveCreeps: 100 },
    );
    const passResult = runOracle(passingInput({ samples: passSamples }));
    expect(passResult.assertions.find((a) => a.name === 'peak concurrent live creeps')?.pass).toBe(
      true,
    );
  });

  it('a peak of 99 active-slow-status creeps fails, 100 passes', () => {
    const failSamples = passingWindow(2_500).map((s, i) =>
      i === 0 ? { ...s, slowedCreeps: 99 } : { ...s, slowedCreeps: 10 },
    );
    const failResult = runOracle(passingInput({ samples: failSamples }));
    expect(
      failResult.assertions.find((a) => a.name === 'creeps with an active slow status, at peak')
        ?.pass,
    ).toBe(false);

    const passSamples = passingWindow(2_500).map((s, i) =>
      i === 0 ? { ...s, slowedCreeps: 100 } : { ...s, slowedCreeps: 10 },
    );
    const passResult = runOracle(passingInput({ samples: passSamples }));
    expect(
      passResult.assertions.find((a) => a.name === 'creeps with an active slow status, at peak')
        ?.pass,
    ).toBe(true);
  });
});

describe('DoT/armor assertions (M2-S5b P10)', () => {
  it('peak concurrent DoT records is a pinned boundary', () => {
    // EVERY sample, not just index 0 — `baseSample`'s own default `dotRecords: 175`
    // would otherwise still supply the window's peak from the untouched samples.
    const failSamples = passingWindow(2_500).map((s) => ({
      ...s,
      dotRecords: PEAK_DOT_RECORDS_THRESHOLD - 1,
    }));
    const failResult = runOracle(passingInput({ samples: failSamples }));
    const failAssertion = failResult.assertions.find(
      (a) => a.name === 'peak concurrent DoT records',
    );
    expect(failAssertion?.measured).toBe(PEAK_DOT_RECORDS_THRESHOLD - 1);
    expect(failAssertion?.pass).toBe(false);
    expect(failResult.pass).toBe(false);

    const passSamples = passingWindow(2_500).map((s) => ({
      ...s,
      dotRecords: PEAK_DOT_RECORDS_THRESHOLD,
    }));
    const passResult = runOracle(passingInput({ samples: passSamples }));
    const passAssertion = passResult.assertions.find(
      (a) => a.name === 'peak concurrent DoT records',
    );
    expect(passAssertion?.measured).toBe(PEAK_DOT_RECORDS_THRESHOLD);
    expect(passAssertion?.pass).toBe(true);
  });

  it('DoT record depth is measured AT THE TICK WITH PEAK dotRecords, not the peak dotCarriers tick', () => {
    // A tick with MORE carriers but FEWER records must not be selected over the tick
    // that actually carries peak dotRecords — otherwise the depth computed would not
    // be the depth PLAN.md step 17's owner amendment actually pins.
    const samples = passingWindow(3).map((s, i) => {
      if (i === 0) return { ...s, dotRecords: 100, dotCarriers: 50 }; // depth 2, high carriers
      if (i === 1) return { ...s, dotRecords: 175, dotCarriers: 19 }; // peak records, depth ~9.2
      return { ...s, dotRecords: 50, dotCarriers: 10 };
    });
    const result = runOracle(passingInput({ samples }));
    const assertion = result.assertions.find(
      (a) => a.name === 'DoT record depth per carrier, at the tick with peak dotRecords',
    );
    expect(assertion?.measured).toBeCloseTo(175 / 19, 5);
    expect(assertion?.pass).toBe(true);
  });

  it('DoT record depth is a pinned boundary', () => {
    // EVERY sample uniform, so the peak-dotRecords tick the assertion selects is
    // provably one of these, not a leftover from `baseSample`'s own defaults.
    const failSamples = passingWindow(2_500).map((s) => ({
      ...s,
      dotRecords: 100,
      dotCarriers: 17, // 100/17 < 6
    }));
    const failResult = runOracle(passingInput({ samples: failSamples }));
    const failAssertion = failResult.assertions.find(
      (a) => a.name === 'DoT record depth per carrier, at the tick with peak dotRecords',
    );
    expect(failAssertion?.pass).toBe(false);

    const passSamples = passingWindow(2_500).map((s) => ({
      ...s,
      dotRecords: 120,
      dotCarriers: 20, // exactly 6
    }));
    const passResult = runOracle(passingInput({ samples: passSamples }));
    const passAssertion = passResult.assertions.find(
      (a) => a.name === 'DoT record depth per carrier, at the tick with peak dotRecords',
    );
    expect(passAssertion?.measured).toBe(DOT_RECORD_DEPTH_THRESHOLD);
    expect(passAssertion?.pass).toBe(true);
  });

  it('a window with zero DoT records anywhere reports depth 0 rather than NaN or throwing', () => {
    const samples = passingWindow(2_500).map((s) => ({ ...s, dotRecords: 0, dotCarriers: 0 }));
    const result = runOracle(passingInput({ samples }));
    const assertion = result.assertions.find(
      (a) => a.name === 'DoT record depth per carrier, at the tick with peak dotRecords',
    );
    expect(assertion?.measured).toBe(0);
    expect(assertion?.pass).toBe(false);
  });

  it('samples with >= 1 DoT tick applied is a pinned boundary', () => {
    const failSamples = passingWindow(2_500).map((s, i) =>
      i < DOT_ACTIVE_SAMPLES_THRESHOLD - 1 ? s : { ...s, dotTicks: 0 },
    );
    const failResult = runOracle(passingInput({ samples: failSamples }));
    const failAssertion = failResult.assertions.find(
      (a) => a.name === 'samples with >= 1 DoT tick applied',
    );
    expect(failAssertion?.measured).toBe(DOT_ACTIVE_SAMPLES_THRESHOLD - 1);
    expect(failAssertion?.pass).toBe(false);

    const passSamples = passingWindow(2_500).map((s, i) =>
      i < DOT_ACTIVE_SAMPLES_THRESHOLD ? s : { ...s, dotTicks: 0 },
    );
    const passResult = runOracle(passingInput({ samples: passSamples }));
    const passAssertion = passResult.assertions.find(
      (a) => a.name === 'samples with >= 1 DoT tick applied',
    );
    expect(passAssertion?.measured).toBe(DOT_ACTIVE_SAMPLES_THRESHOLD);
    expect(passAssertion?.pass).toBe(true);
  });

  it('peak concurrent armored live creeps is a pinned boundary', () => {
    const failSamples = passingWindow(2_500).map((s, i) =>
      i === 0 ? { ...s, armoredLive: PEAK_ARMORED_LIVE_THRESHOLD - 1 } : { ...s, armoredLive: 0 },
    );
    const failResult = runOracle(passingInput({ samples: failSamples }));
    const failAssertion = failResult.assertions.find(
      (a) => a.name === 'peak concurrent live creeps with nonzero armor',
    );
    expect(failAssertion?.measured).toBe(PEAK_ARMORED_LIVE_THRESHOLD - 1);
    expect(failAssertion?.pass).toBe(false);

    const passSamples = passingWindow(2_500).map((s, i) =>
      i === 0 ? { ...s, armoredLive: PEAK_ARMORED_LIVE_THRESHOLD } : { ...s, armoredLive: 0 },
    );
    const passResult = runOracle(passingInput({ samples: passSamples }));
    const passAssertion = passResult.assertions.find(
      (a) => a.name === 'peak concurrent live creeps with nonzero armor',
    );
    expect(passAssertion?.measured).toBe(PEAK_ARMORED_LIVE_THRESHOLD);
    expect(passAssertion?.pass).toBe(true);
  });

  it('dropped DoT applications is exactly 0 — a single whole-run drop fails, even with samples otherwise pristine', () => {
    const result = runOracle(passingInput({ dotDroppedTotal: 1 }));
    const assertion = result.assertions.find(
      (a) => a.name === 'dropped DoT applications, whole run (stress arm)',
    );
    expect(assertion?.measured).toBe(1);
    expect(assertion?.threshold).toBe(DOT_DROPPED_THRESHOLD);
    expect(assertion?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('dropped DoT applications of exactly 0 passes', () => {
    const result = runOracle(passingInput({ dotDroppedTotal: 0 }));
    const assertion = result.assertions.find(
      (a) => a.name === 'dropped DoT applications, whole run (stress arm)',
    );
    expect(assertion?.pass).toBe(true);
  });

  it('the MAX_DOT_RECORDS headroom row is reported, not gated — it passes even at an absurd measured value', () => {
    const samples = passingWindow(2_500).map((s, i) =>
      i === 0 ? { ...s, dotRecords: 999_999 } : s,
    );
    const result = runOracle(passingInput({ samples }));
    const assertion = result.assertions.find((a) =>
      a.name.startsWith('peak DoT records vs MAX_DOT_RECORDS'),
    );
    expect(assertion?.measured).toBe(999_999);
    expect(assertion?.pass).toBe(true);
    // The gated floor above it still reads the same peak and does not get fooled by
    // the headroom row's unconditional pass.
    const floorAssertion = result.assertions.find((a) => a.name === 'peak concurrent DoT records');
    expect(floorAssertion?.measured).toBe(999_999);
    expect(floorAssertion?.pass).toBe(true);
  });
});

describe('qualifying sustained samples is a pinned boundary', () => {
  it('1999 qualifying samples fails, 2000 passes', () => {
    const failSamples = passingWindow(2_500).map((s, i) =>
      i < 1999 ? s : { ...s, liveCreeps: 0 },
    );
    const failResult = runOracle(passingInput({ samples: failSamples }));
    const assertion = failResult.assertions.find((a) => a.name === 'qualifying sustained samples');
    expect(assertion?.measured).toBe(1999);
    expect(assertion?.pass).toBe(false);

    const passSamples = passingWindow(2_500).map((s, i) =>
      i < 2000 ? s : { ...s, liveCreeps: 0 },
    );
    const passResult = runOracle(passingInput({ samples: passSamples }));
    const passAssertion = passResult.assertions.find(
      (a) => a.name === 'qualifying sustained samples',
    );
    expect(passAssertion?.measured).toBe(2000);
    expect(passAssertion?.pass).toBe(true);
  });
});

describe('isQualifyingSample()', () => {
  it('requires both phase === running and liveCreeps > 0', () => {
    expect(isQualifyingSample(baseSample())).toBe(true);
    expect(isQualifyingSample(baseSample({ phase: 'won' }))).toBe(false);
    expect(isQualifyingSample(baseSample({ liveCreeps: 0 }))).toBe(false);
    expect(isQualifyingSample(baseSample({ phase: 'lost', liveCreeps: 0 }))).toBe(false);
  });
});

describe('KNOWN_OPEN_ASSERTIONS — pinned by value', () => {
  // The same reasoning `gate.test.ts` applies to `R0`, for the same reason: this list is
  // the ONLY mechanism in the package that turns a red assertion green, and widening it
  // is a one-line diff that reads as housekeeping. `oracle.ts` states that intent in
  // prose; a comment is not a guard.
  //
  // It is EMPTY as of the owner ruling of 2026-07-31, which resolved its single entry by
  // re-pinning the route-length floor to the measured value. Pinning empty is stricter
  // than pinning one name: any addition at all now fails here, which is exactly the
  // moment the ruling the list's doc requires should be written down.
  it('is empty — every oracle assertion currently stands on its own merits', () => {
    expect(KNOWN_OPEN_ASSERTIONS).toEqual([]);
  });

  it('does not contain the route-length assertion, which is now an un-waivable tripwire', () => {
    expect(KNOWN_OPEN_ASSERTIONS).not.toContain('scripted maze route length');
  });
});
