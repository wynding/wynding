// gate.test.ts — the ratio gate's arithmetic (PLAN step 21). `R = stressStat /
// controlStat`; the unset-`R0` path is a recording run, never a pass; `R = R0 ×
// TOLERANCE` passes and anything above fails — the boundary pinned explicitly, per
// gate.ts's "R = R0 * TOLERANCE itself PASSES" contract.

import { describe, it, expect } from 'vitest';
import { controlStat, stressStat, evaluateGate, TOLERANCE, R0 } from './gate';
import type { SampledTick } from './harness';

function sample(ms: number): SampledTick {
  return { tick: 0, ms, dueBlasts: 1, liveCreeps: 300, slowedCreeps: 100, phase: 'running' };
}

describe('controlStat() — p50 over the control samples', () => {
  it('matches percentile(ms, 50)', () => {
    const samples = [0.1, 0.2, 0.3, 0.4, 0.5].map(sample);
    expect(controlStat(samples)).toBe(0.3);
  });
});

describe('stressStat() — p99 over the due-blast subset', () => {
  it('matches percentile(ms, 99)', () => {
    const samples = Array.from({ length: 100 }, (_, i) => sample(i + 1)); // 1..100
    expect(stressStat(samples)).toBe(99);
  });

  it('throws on an empty due-blast subset (an oracle failure, not a silent NaN)', () => {
    expect(() => stressStat([])).toThrow();
  });
});

describe('R0 — the committed first-run baseline', () => {
  // Pinned by VALUE on purpose. `R0` is the one number in this package that a future
  // reader could plausibly "just nudge" to make a red gate go green, and a nudge is
  // invisible in a diff that only says `2.0` → `2.4`. Failing this test is the point:
  // it forces the edit to be deliberate, and it puts the justification PLAN step 21
  // requires ("an explicit committed edit with justification in the PR") in front of
  // whoever is doing the nudging. Update it only alongside gate.ts's provenance doc.
  it('is the 1.69 recorded by S4b, not an inferred or rebaselined value', () => {
    expect(R0).toBe(1.69);
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
  // controlStat = 0.1 (p50 of five identical values), stressStat = 0.2 (p99 of five
  // identical values) -> R = 2. With r0 = 2 / TOLERANCE, R0 * TOLERANCE = 2 exactly:
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
    const r0 = 10; // ceiling 12.5, R = 2
    const result = evaluateGate(control, dueBlast, r0);
    expect(result.status).toBe('evaluated');
    if (result.status !== 'evaluated') throw new Error('unreachable');
    expect(result.pass).toBe(true);
  });
});

describe('TOLERANCE', () => {
  it('is pinned at 1.25', () => {
    expect(TOLERANCE).toBe(1.25);
  });
});

describe('evaluateGate() — a zero controlStat throws a named diagnostic', () => {
  it('throws rather than silently reporting an Infinity/NaN ratio', () => {
    const control = [0, 0, 0].map(sample);
    const dueBlast = [0.2, 0.2, 0.2].map(sample);
    expect(() => evaluateGate(control, dueBlast)).toThrow(/controlStat is 0ms/);
  });
});

describe('evaluateGate() — the default r0 parameter (QC: the default-parameter path was untested)', () => {
  // Every other test above passes `r0` explicitly, so the default-parameter path
  // (`r0: number | null = R0`) was never exercised by this suite. Calling with only
  // two arguments is the one thing that actually runs that default.
  it('reads the committed R0 constant when r0 is omitted', () => {
    const control = new Array(5).fill(0.1).map(sample);
    const dueBlast = new Array(5).fill(0.2).map(sample);
    const result = evaluateGate(control, dueBlast);
    expect(result.status).toBe('evaluated');
    if (result.status !== 'evaluated') throw new Error('unreachable');
    expect(result.r0).toBe(R0);
  });
});
