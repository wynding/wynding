// escalation.test.ts — the known-open exit-code decision, separating owner-
// acknowledged open findings from ordinary failures. Every
// scenario PLAN's fix asked for by name: a non-known-open failure exits non-zero; a
// known-open failure alone does not; a gate failure alone does; a known-open
// assertion that passes is reported as stale.

import { describe, it, expect } from 'vitest';
import {
  evaluateEscalation,
  replayAcceptedAssertion,
  allRunAssertions,
  REPLAY_ACCEPTED_ASSERTIONS,
  REPLAY_KEYS,
  type ReplayKey,
} from './escalation';
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

describe('replayAcceptedAssertion() — the validator verdict as an ordinary assertion', () => {
  // The defect this closes: `run.ts` used to set `process.exitCode = 1` beside
  // `evaluateEscalation` rather than through it, so a run whose committed replay the
  // validator REJECTED exited 1 while its machine-readable `PERF-REPORT:` line still
  // published `"exitNonZero": false` — with a clean-looking table set and no field
  // recording the rejection at all. Routing it through the one decision function is what
  // makes the two agree.
  it('a rejected replay is a FAILING assertion that forces a non-zero exit', () => {
    // Pinned whole, not just `.pass`: `measured` and `threshold` are what `run.ts` prints
    // under ESCALATION and what lands in `PERF-REPORT`, so asserting only `.pass` would
    // let a rejected replay be reported as `measured: true` in both places.
    const a = replayAcceptedAssertion('stress', false);
    expect(a).toEqual({
      name: REPLAY_ACCEPTED_ASSERTIONS.stress,
      measured: false,
      threshold: true,
      pass: false,
    });
    const result = evaluateEscalation([a], true);
    expect(result.exitNonZero).toBe(true);
    expect(result.nonKnownOpenFailures.map((x) => x.name)).toEqual([
      REPLAY_ACCEPTED_ASSERTIONS.stress,
    ]);
  });

  it('an accepted replay passes and forces nothing', () => {
    const a = replayAcceptedAssertion('control', true);
    expect(a).toEqual({
      name: REPLAY_ACCEPTED_ASSERTIONS.control,
      measured: true,
      threshold: true,
      pass: true,
    });
    expect(evaluateEscalation([a], true).exitNonZero).toBe(false);
  });

  it('NO replay check is waivable — a rejected replay can never ride through on the known-open list', () => {
    // Pinned by value rather than by "it currently isn't": a rejected replay means every
    // number in the run was measured against a scenario the real replay path does not
    // accept, so there is no reading under which waiving it is right. If someone adds any
    // of these names to KNOWN_OPEN_ASSERTIONS, this test is what stops them. Iterated over
    // the constant rather than naming the two by hand, so a third replay added later is
    // covered without anyone remembering to extend this.
    for (const name of Object.values(REPLAY_ACCEPTED_ASSERTIONS)) {
      expect(KNOWN_OPEN_ASSERTIONS).not.toContain(name);
    }
    for (const key of REPLAY_KEYS) {
      expect(
        evaluateEscalation([replayAcceptedAssertion(key, false)], true).knownOpenFailures,
      ).toEqual([]);
    }
  });
});

describe('allRunAssertions() — the whole run in one list', () => {
  // This assembly lives in this module, not in `run.ts`, precisely so it can be tested:
  // `run.ts` is excluded from the coverage gate and reached by no test, so a replay
  // verdict dropped from the array there would exit 0 on a rejected replay with every
  // test still green. Assembled here, the same omission is a test failure — which is what
  // the cases below hold.
  const oracle = [assertion('peak concurrent live creeps', true)];
  const control = [assertion('control: accepted tower placements', true)];
  const replays = (...rejected: readonly ReplayKey[]) =>
    Object.fromEntries(REPLAY_KEYS.map((k) => [k, { ok: !rejected.includes(k) }])) as Record<
      ReplayKey,
      { ok: boolean }
    >;

  it('always carries EVERY replay verdict, whatever the oracle and control checks say', () => {
    const names = allRunAssertions({ oracle, control, replays: replays() }).map((a) => a.name);
    for (const name of Object.values(REPLAY_ACCEPTED_ASSERTIONS)) {
      expect(names).toContain(name);
    }
    expect(names).toHaveLength(oracle.length + control.length + REPLAY_KEYS.length);
  });

  // Both directions, not just one: a mutation that dropped only the STRESS verdict used to
  // survive everything except an incidental length check.
  for (const key of REPLAY_KEYS) {
    it(`a rejected ${key} replay exits non-zero — every replay the run measures against is load-bearing`, () => {
      const result = evaluateEscalation(
        allRunAssertions({ oracle, control, replays: replays(key) }),
        true,
      );
      expect(result.exitNonZero).toBe(true);
      expect(result.nonKnownOpenFailures.map((a) => a.name)).toEqual([
        REPLAY_ACCEPTED_ASSERTIONS[key],
      ]);
    });
  }

  it('passes the oracle and control assertions through unchanged and in order', () => {
    const all = allRunAssertions({ oracle, control, replays: replays() });
    expect(all[0]).toEqual(oracle[0]);
    expect(all[1]).toEqual(control[0]);
  });
});
