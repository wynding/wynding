// escalation.ts — decides `run.ts`'s exit code from the workload oracle's assertions
// (both the stress-run oracle, `oracle.ts`, and `run.ts`'s own control-window sanity
// checks) plus the ratio gate's pass/fail, and separates "owner-acknowledged open
// findings" (`oracle.ts`'s `KNOWN_OPEN_ASSERTIONS`) from everything else (QC round-1
// fix 4). Pure — no I/O, no sim invocation — so it is unit-testable directly, unlike
// `run.ts` itself, which is a CLI entry point excluded from the coverage gate
// (`vitest.config.ts`) because its correctness is exercised by actually running it.
// Pulling this decision out into its own function is what makes it testable at all.

import { KNOWN_OPEN_ASSERTIONS, type OracleAssertion } from './oracle';

/** The result of folding one run's assertions + gate outcome into a single exit-code
 *  decision. */
export interface EscalationResult {
  /** True iff `run.ts` should exit non-zero for this run. */
  readonly exitNonZero: boolean;
  /** Failing assertions that are NOT on `KNOWN_OPEN_ASSERTIONS` — any one of these
   *  alone forces `exitNonZero`. */
  readonly nonKnownOpenFailures: readonly OracleAssertion[];
  /** Failing assertions that ARE on `KNOWN_OPEN_ASSERTIONS` — reported (still under
   *  the caller's `ESCALATION` block), but do not by themselves force `exitNonZero`. */
  readonly knownOpenFailures: readonly OracleAssertion[];
  /** Names from `KNOWN_OPEN_ASSERTIONS` whose assertion is currently PASSING this
   *  run — a stale waiver (`KNOWN_OPEN_ASSERTIONS`'s doc comment: "say so loudly and
   *  tell the reader to remove it — a stale waiver is its own defect"). Not itself a
   *  cause of `exitNonZero`: a stale waiver is a finding to report, not a failure. */
  readonly staleKnownOpen: readonly string[];
}

/**
 * `assertions` — every oracle-style assertion this run produced, from ANY source: the
 * stress workload oracle's `OracleResult.assertions` and `run.ts`'s control-window
 * sanity checks folded into the same list. Control-window checks
 * never match a `KNOWN_OPEN_ASSERTIONS` name, so they are always treated as ordinary,
 * un-waivable failures here — there is no mechanism for a control-window regression to
 * ride through on the maze's known-open waiver.
 *
 * `gatePass` — `true` when the ratio gate PASSED, or was NOT EVALUATED at all (an
 * `'unset'` R0 — a recording-only run — or no due-blast samples in the window, see
 * `run.ts`); `false` only when the gate WAS evaluated and failed. A gate that was not
 * evaluated cannot itself force `exitNonZero` — but note that "no due-blast samples"
 * is also always caught as an ordinary oracle failure (`DUE_BLAST_SAMPLES_THRESHOLD`),
 * so that specific case still exits non-zero via `nonKnownOpenFailures`, not via the
 * gate.
 */
export function evaluateEscalation(
  assertions: readonly OracleAssertion[],
  gatePass: boolean,
): EscalationResult {
  const failing = assertions.filter((a) => !a.pass);
  const isKnownOpen = (a: OracleAssertion): boolean => KNOWN_OPEN_ASSERTIONS.includes(a.name);
  const nonKnownOpenFailures = failing.filter((a) => !isKnownOpen(a));
  const knownOpenFailures = failing.filter(isKnownOpen);
  const staleKnownOpen = KNOWN_OPEN_ASSERTIONS.filter((name) =>
    assertions.some((a) => a.name === name && a.pass),
  );
  return {
    exitNonZero: nonKnownOpenFailures.length > 0 || !gatePass,
    nonKnownOpenFailures,
    knownOpenFailures,
    staleKnownOpen,
  };
}
