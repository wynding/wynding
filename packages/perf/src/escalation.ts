// escalation.ts — decides `run.ts`'s exit code from the workload oracle's assertions
// (both the stress-run oracle, `oracle.ts`, and `run.ts`'s own control-window sanity
// checks) plus the ratio gate's pass/fail, and separates "owner-acknowledged open
// findings" (`oracle.ts`'s `KNOWN_OPEN_ASSERTIONS`) from everything else. Pure — no I/O, no sim invocation — so it is unit-testable directly, unlike
// `run.ts` itself, which is a CLI entry point excluded from the coverage gate
// (`vitest.config.ts`) because its correctness is exercised by actually running it.
// Pulling this decision out into its own function is what makes it testable at all.

import { KNOWN_OPEN_ASSERTIONS, type OracleAssertion } from './oracle';

/** The names `run.ts`'s two replay-validation checks report under. Exported so a test can
 *  assert neither is on `KNOWN_OPEN_ASSERTIONS` — a rejected replay must never be
 *  waivable, because every number in the run was measured against a scenario the real
 *  replay path does not accept. */
export const REPLAY_ACCEPTED_ASSERTIONS = {
  stress: 'stress replay accepted by the replay validator',
  control: 'control replay accepted by the replay validator',
} as const;

/** The replays `run.ts` validates, as a key list, so `allRunAssertions` below and
 *  `run.ts`'s FATAL loop walk one declared set rather than each restating the pair. (The
 *  printed block and the report fields key off the same `validations` record — see
 *  `run.ts` — so all four stay in step.)
 *
 *  Adding a third replay takes three edits: a name above, a key here, and a `validate()`
 *  call in `run.ts`'s `validations` record. ALL THREE are enforced — two by the compiler,
 *  the third by a test. Forget the NAME and the `satisfies` below errors (TS2322: the new
 *  key is not assignable to `ReplayKey`). Forget the `validate()` CALL and `run.ts`'s
 *  `Record<ReplayKey, ValidationResult>` literal errors (TS2741: property missing). Forget
 *  the KEY and the compiler sees nothing — `satisfies` checks each element against
 *  `ReplayKey`, never that the list covers it — so that one is caught by
 *  `escalation.test.ts`'s "always carries EVERY replay verdict", which iterates the names
 *  rather than this list. (Verified against the repo's own tsc, both directions.) */
export const REPLAY_KEYS = ['stress', 'control'] as const satisfies readonly ReplayKey[];

/** One of the replays `run.ts` puts through the real validator. */
export type ReplayKey = keyof typeof REPLAY_ACCEPTED_ASSERTIONS;

/** Wraps `validate()`'s verdict as an ordinary assertion, so the one decision function
 *  (`evaluateEscalation`) sees it and `run.ts`'s `PERF-REPORT:` line and exit code agree.
 *  Before this existed the check set `process.exitCode` directly and the machine-readable
 *  report still published `"exitNonZero": false` with a clean-looking table set and no
 *  field recording the rejection at all — the one artifact downstream consumers read was
 *  the only one that could not see the failure. */
export function replayAcceptedAssertion(which: ReplayKey, ok: boolean): OracleAssertion {
  return { name: REPLAY_ACCEPTED_ASSERTIONS[which], measured: ok, threshold: true, pass: ok };
}

/**
 * Every assertion one `run.ts` invocation produces, in one place.
 *
 * It lives here rather than inline in `run.ts` because `run.ts` is excluded from the
 * coverage gate and reached by no test: assembled there, dropping a replay verdict from
 * the array restored the exact bug this module exists to prevent — a rejected replay
 * exiting 0, beside a report claiming `"exitNonZero": false` — with every test still
 * green — verified by mutation. Assembled here, that same mistake IS a test failure.
 *
 * Be precise about what that does and does not cover, because an earlier version of this
 * comment overclaimed it. A verdict dropped or mis-built INSIDE this
 * function is caught by `escalation.test.ts`. The CALL SITE is not: nothing stops
 * `run.ts` passing a hard-coded `{ ok: true }`, or abandoning this function for an inline
 * array literal, and no unit test can see either while `run.ts` is a coverage-excluded
 * CLI whose only real exercise is running the job. What the signature CAN remove is the
 * mis-wiring in between — it takes the validator's own result objects, keyed, so there is
 * no per-replay boolean at the call site to transpose.
 */
export function allRunAssertions(parts: {
  readonly oracle: readonly OracleAssertion[];
  readonly control: readonly OracleAssertion[];
  readonly replays: Readonly<Record<ReplayKey, { readonly ok: boolean }>>;
}): OracleAssertion[] {
  return [
    ...parts.oracle,
    ...parts.control,
    ...REPLAY_KEYS.map((key) => replayAcceptedAssertion(key, parts.replays[key].ok)),
  ];
}

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
   *  tell the reader to remove it — a stale waiver is its own defect").
   *
   *  This DOES force `exitNonZero` (owner ruling, 2026-07-31). It previously did not, on
   *  the reasoning that a stale waiver is a finding to report rather than a failure. The
   *  hole that left: a waived assertion that gets fixed and later regresses lands back
   *  inside its own waiver band and exits 0 — for the route length, anything between the
   *  floor and the waived threshold would have been invisible. Failing costs a one-line
   *  edit at exactly the moment someone has improved things and can see why; not failing
   *  costs a silent regression later. */
  readonly staleKnownOpen: readonly string[];
}

/**
 * `assertions` — every oracle-style assertion this run produced, from ANY source: the
 * stress workload oracle's `OracleResult.assertions`, `run.ts`'s control-window sanity
 * checks, and both replay-validator verdicts (`replayAcceptedAssertion`), all folded into
 * the same list. Neither the control-window checks nor the validator verdict ever match a
 * `KNOWN_OPEN_ASSERTIONS` name, so they are always treated as ordinary, un-waivable
 * failures here — there is no mechanism for a control-window regression, or either replay
 * being rejected by the validator, to ride through on the maze's known-open waiver.
 *
 * `knownOpen` — the waiver list, defaulting to the module's `KNOWN_OPEN_ASSERTIONS`. A
 * parameter rather than a hard reference so this function's behaviour around waivers can
 * be tested against a list of the test's choosing — the committed list is EMPTY today
 * (its one entry was resolved by owner ruling), and a waiver mechanism that only has
 * tests while some finding happens to be open is a mechanism that rots between uses. The
 * same shape `evaluateGate` uses for `r0`; `run.ts` always takes the default.
 *
 * `gatePass` — `true` when the ratio gate PASSED, or was NOT EVALUATED at all (an
 * `'unset'` R0 — a recording-only run — or fewer than `DUE_BLAST_SAMPLES_THRESHOLD`
 * due-blast samples in the window, see `run.ts`); `false` only when the gate WAS evaluated
 * and failed. A gate that was not evaluated cannot itself force `exitNonZero` — but note
 * that too few due-blast samples is also always caught as an ordinary oracle failure
 * (`DUE_BLAST_SAMPLES_THRESHOLD` again, the same constant), so that specific case still
 * exits non-zero via `nonKnownOpenFailures`, not via the gate.
 */
export function evaluateEscalation(
  assertions: readonly OracleAssertion[],
  gatePass: boolean,
  knownOpen: readonly string[] = KNOWN_OPEN_ASSERTIONS,
): EscalationResult {
  const failing = assertions.filter((a) => !a.pass);
  const isKnownOpen = (a: OracleAssertion): boolean => knownOpen.includes(a.name);
  const nonKnownOpenFailures = failing.filter((a) => !isKnownOpen(a));
  const knownOpenFailures = failing.filter(isKnownOpen);
  const staleKnownOpen = knownOpen.filter((name) =>
    assertions.some((a) => a.name === name && a.pass),
  );
  return {
    exitNonZero: nonKnownOpenFailures.length > 0 || !gatePass || staleKnownOpen.length > 0,
    nonKnownOpenFailures,
    knownOpenFailures,
    staleKnownOpen,
  };
}
