// gate.test.ts — the ratio gate's arithmetic (PLAN step 21). `R = stressStat /
// controlStat`; the unset-`R0` path is a recording run, never a pass; `R = R0 ×
// TOLERANCE` passes and anything above fails — the boundary pinned explicitly, per
// gate.ts's "R = R0 * TOLERANCE itself PASSES" contract.

import { describe, it, expect } from 'vitest';
import {
  controlStat,
  stressStat,
  stressStatP95,
  stressStatP99,
  evaluateGate,
  TOLERANCE,
  R0,
} from './gate';
import type { SampledTick } from './harness';

function sample(ms: number): SampledTick {
  return {
    tick: 0,
    ms,
    dueBlasts: 1,
    liveCreeps: 300,
    slowedCreeps: 100,
    phase: 'running',
    dotTicks: 0,
    dotDropped: 0,
    dotRecords: 0,
    dotCarriers: 0,
    armoredLive: 0,
  };
}

describe('controlStat() — p50 over the control samples', () => {
  it('matches percentile(ms, 50)', () => {
    const samples = [0.1, 0.2, 0.3, 0.4, 0.5].map(sample);
    expect(controlStat(samples)).toBe(0.3);
  });
});

describe('stressStat() — p50 over the due-blast subset (M2-S6, moved from p95)', () => {
  it('matches percentile(ms, 50)', () => {
    const samples = Array.from({ length: 100 }, (_, i) => sample(i + 1)); // 1..100
    expect(stressStat(samples)).toBe(50);
  });

  it('throws on an empty due-blast subset (an oracle failure, not a silent NaN)', () => {
    expect(() => stressStat([])).toThrow();
  });

  // The two statistics this gate has REPLACED. Both are computed and reported but never
  // compared to anything, so nothing else in the suite would notice if either silently
  // stopped being what it claims — which would quietly destroy the audit trail each
  // switch was allowed to rely on.
  it('stressStatP95()/stressStatP99() still report the superseded statistics, for audit', () => {
    const samples = Array.from({ length: 100 }, (_, i) => sample(i + 1));
    expect(stressStatP95(samples)).toBe(95);
    expect(stressStatP99(samples)).toBe(99);
    expect(stressStatP95(samples)).not.toBe(stressStat(samples));
    expect(stressStatP99(samples)).not.toBe(stressStat(samples));
  });

  // The gate must carry ALL THREE statistics out to the report. A `GateResult` that
  // dropped an audit field would still pass every assertion above.
  it('evaluateGate carries the gating p50 and both audit statistics into its result', () => {
    // The two series are deliberately DIFFERENT. With both arms on the same statistic
    // since M2-S6, feeding both the same series makes `r === 1` and lets a mutated
    // `r = controlStat / controlStat` pass — the numerator would go untested. Offsetting
    // the stress series by 100 keeps every expectation exact while forcing `r != 1`.
    const control = Array.from({ length: 100 }, (_, i) => sample(i + 1)); // 1..100
    const dueBlast = Array.from({ length: 100 }, (_, i) => sample(i + 101)); // 101..200
    const result = evaluateGate(control, dueBlast);
    expect(result.controlStat).toBe(50);
    expect(result.stressStat).toBe(150);
    expect(result.stressStatP95).toBe(195);
    expect(result.stressStatP99).toBe(199);
    // And `r` is derived from the GATING statistic, not either audit one — and is not 1.
    expect(result.r).toBe(150 / 50);
  });
});

describe('R0 — the committed CI-runner baseline', () => {
  // Pinned by VALUE on purpose. `R0` is the one number in this package that a future
  // reader could plausibly "just nudge" to make a red gate go green, and a nudge is
  // invisible in a diff that only says `2.0` → `2.4`. Failing this test is the point:
  // it forces the edit to be deliberate, and it puts the justification PLAN step 21
  // requires ("an explicit committed edit with justification in the PR") in front of
  // whoever is doing the nudging. Update it only alongside gate.ts's provenance doc.
  //
  // RE-RECORDED at 1.00 (M2-S6 QC): the median of 17 CI samples — run 31041932972,
  // attempts 1-17, head a1600c9, `ubuntu-24.04` — rounded DOWN to the nearer hundredth,
  // against the p50/p50 statistic at `TOLERANCE` 1.10. The superseded 1.42 baselined
  // p95/p50 and does not describe this statistic. `gate.ts`'s `R0` doc carries the full
  // cohort, the sigma analysis, and why the recording took 17 samples rather than 5.
  //
  // The `null` window this replaced was the interesting state and is worth remembering
  // rather than deleting: a null `R0` is GREEN. `run.ts` counts `'unset'` as `gatePass`,
  // escalation does not fire, `perf` exits 0, and this suite passes — so a forgotten null
  // would have left the gate permanently unenforced with every check green. Nothing in
  // this file could have caught that; `ci.yml`'s default-branch alarm exists for it, and
  // even that only fires AFTER a merge. That is why the baseline is recorded here, in the
  // PR that changed the statistic, rather than left for a follow-up.
  it('is the re-recorded 1.00, not the stale 1.42 from the superseded p95/p50 statistic', () => {
    expect(R0).toBe(1.0);
  });

  // The ceiling the committed pair implies, asserted so `R0` and `TOLERANCE` cannot drift
  // apart silently — a reader checking "what does this gate actually permit?" gets one
  // number, and a change to EITHER constant has to come past it.
  it('with TOLERANCE, yields the 1.1000 ceiling the provenance doc records', () => {
    expect(R0).not.toBeNull();
    expect((R0 as number) * TOLERANCE).toBeCloseTo(1.1, 10);
  });
});

describe('evaluateGate() — the unset-R0 path', () => {
  it('is a RECORDING run, not a pass: status is "unset", no pass/fail is asserted', () => {
    const control = [0.1, 0.1, 0.1].map(sample);
    const dueBlast = [0.2, 0.2, 0.2].map(sample);
    const result = evaluateGate(control, dueBlast, null);
    expect(result.status).toBe('unset');
    expect(result).not.toHaveProperty('pass');
    expect(result.r).toBeCloseTo(2, 10);
  });
});

describe('evaluateGate() — the evaluated path, boundary pinned exactly', () => {
  // controlStat = 0.1 and stressStat = 0.2, each a percentile of five IDENTICAL values —
  // every percentile of a constant series is that constant, so this boundary case is
  // unaffected by any statistic move (p99 -> p95 at M2-S5b P11, p95 -> p50 at M2-S6)
  // -> R = 2. With r0 = 2 / TOLERANCE, R0 * TOLERANCE = 2 exactly:
  // R === ceiling, which must PASS (the gate fails on strictly `R > ceiling`).
  const control = new Array(5).fill(0.1).map(sample);
  const dueBlast = new Array(5).fill(0.2).map(sample);

  it('R === R0 * TOLERANCE passes (the boundary is inclusive)', () => {
    const r0 = 2 / TOLERANCE;
    const result = evaluateGate(control, dueBlast, r0);
    expect(result.status).toBe('evaluated');
    if (result.status !== 'evaluated') throw new Error('unreachable');
    expect(result.r).toBeCloseTo(2, 10);
    expect(result.ceiling).toBeCloseTo(2, 10);
    expect(result.pass).toBe(true);
  });

  it('R just above R0 * TOLERANCE fails', () => {
    // r0 chosen so the ceiling sits fractionally below the observed R = 2.
    const r0 = 2 / TOLERANCE - 0.001;
    const result = evaluateGate(control, dueBlast, r0);
    expect(result.status).toBe('evaluated');
    if (result.status !== 'evaluated') throw new Error('unreachable');
    expect(result.r).toBeGreaterThan(result.ceiling);
    expect(result.pass).toBe(false);
  });

  it('R comfortably below R0 * TOLERANCE passes', () => {
    const r0 = 10; // ceiling 11 (10 × TOLERANCE 1.10), R = 2
    const result = evaluateGate(control, dueBlast, r0);
    expect(result.status).toBe('evaluated');
    if (result.status !== 'evaluated') throw new Error('unreachable');
    expect(result.pass).toBe(true);
  });
});

describe('TOLERANCE', () => {
  // Tightened 1.25 -> 1.10 at M2-S6 alongside the p95 -> p50 statistic move, and
  // DECLARED BEFORE the new R0 was recorded. Pinned by value so a future widening has
  // to be a deliberate, reviewed edit to this line rather than a quiet drift.
  it('is pinned at 1.10', () => {
    expect(TOLERANCE).toBe(1.1);
  });
});

describe('evaluateGate() — a zero controlStat throws a named diagnostic', () => {
  it('throws rather than silently reporting an Infinity/NaN ratio', () => {
    const control = [0, 0, 0].map(sample);
    const dueBlast = [0.2, 0.2, 0.2].map(sample);
    expect(() => evaluateGate(control, dueBlast)).toThrow(/controlStat is 0ms/);
  });
});

describe('evaluateGate() — the default r0 parameter', () => {
  // Every other test above passes `r0` explicitly, so the default-parameter path
  // (`r0: number | null = R0`) was never exercised by this suite. Calling with only
  // two arguments is the one thing that actually runs that default.
  //
  // Written so BOTH states are meaningful: the branch tracks the COMMITTED constant rather
  // than restating it, so this test kept working across the `null` -> 1.00 re-record without
  // needing an edit on the day the baseline landed. `R0` is now a number, so the `else`
  // branch is the live one.
  it('reads the committed R0 constant when r0 is omitted', () => {
    const control = new Array(5).fill(0.1).map(sample);
    const dueBlast = new Array(5).fill(0.2).map(sample);
    const result = evaluateGate(control, dueBlast);
    // Tie the default to the CONSTANT in either state: passing `R0` explicitly must
    // produce the identical result.
    //
    // THIS LINE IS NOW LOAD-BEARING, and it was not always. While `R0` was null it was
    // degenerate — both sides passed `null`, so a mutant default of a hardcoded `= null`
    // satisfied it and it discriminated nothing. It was written in that state anyway, so it
    // would already be in place the day the baseline landed. That day has come: with `R0` a
    // number, a hardcoded `= null` default returns `'unset'` against an `'evaluated'`
    // right-hand side and fails here.
    expect(result).toEqual(evaluateGate(control, dueBlast, R0));
    if (R0 === null) {
      // A null baseline must surface as a RECORDING run and must never carry a `pass`
      // — the one way an un-baselined gate could be mistaken for a green one.
      expect(result.status).toBe('unset');
      expect(result).not.toHaveProperty('pass');
    } else {
      expect(result.status).toBe('evaluated');
      if (result.status !== 'evaluated') throw new Error('unreachable');
      expect(result.r0).toBe(R0);
    }
  });
});
