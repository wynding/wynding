// escalation.test.ts — the known-open exit-code decision (QC: separating owner-
// acknowledged open findings from ordinary failures). Every
// scenario PLAN's fix asked for by name: a non-known-open failure exits non-zero; a
// known-open failure alone does not; a gate failure alone does; a known-open
// assertion that passes is reported as stale.

import { describe, it, expect } from 'vitest';
import { evaluateEscalation } from './escalation';
import { KNOWN_OPEN_ASSERTIONS } from './oracle';
import type { OracleAssertion } from './oracle';

function assertion(name: string, pass: boolean): OracleAssertion {
  return { name, measured: pass, threshold: true, pass };
}

const KNOWN_OPEN_NAME = KNOWN_OPEN_ASSERTIONS[0]!;

describe('evaluateEscalation()', () => {
  it('a non-known-open failure exits non-zero', () => {
    const result = evaluateEscalation([assertion('peak concurrent live creeps', false)], true);
    expect(result.exitNonZero).toBe(true);
    expect(result.nonKnownOpenFailures.map((a) => a.name)).toEqual(['peak concurrent live creeps']);
  });

  it('a known-open failure alone does not exit non-zero', () => {
    const result = evaluateEscalation([assertion(KNOWN_OPEN_NAME, false)], true);
    expect(result.exitNonZero).toBe(false);
    expect(result.knownOpenFailures.map((a) => a.name)).toEqual([KNOWN_OPEN_NAME]);
    expect(result.nonKnownOpenFailures).toHaveLength(0);
  });

  it('a gate failure alone exits non-zero, even when every assertion passes', () => {
    const result = evaluateEscalation([assertion('peak concurrent live creeps', true)], false);
    expect(result.exitNonZero).toBe(true);
    expect(result.nonKnownOpenFailures).toHaveLength(0);
  });

  it('a known-open assertion that currently passes is reported as a stale waiver', () => {
    const result = evaluateEscalation([assertion(KNOWN_OPEN_NAME, true)], true);
    expect(result.staleKnownOpen).toEqual([KNOWN_OPEN_NAME]);
    expect(result.exitNonZero).toBe(false);
  });

  it('a known-open failure plus a gate failure still exits non-zero — the gate forces it, not the waiver', () => {
    const result = evaluateEscalation([assertion(KNOWN_OPEN_NAME, false)], false);
    expect(result.exitNonZero).toBe(true);
    expect(result.knownOpenFailures).toHaveLength(1);
  });

  it('a fully passing run with a passing gate does not exit non-zero and reports no stale waiver when the known-open assertion is absent from this run', () => {
    const result = evaluateEscalation([assertion('peak concurrent live creeps', true)], true);
    expect(result.exitNonZero).toBe(false);
    expect(result.staleKnownOpen).toHaveLength(0);
  });
});
