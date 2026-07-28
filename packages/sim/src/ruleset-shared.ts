// ruleset-shared.ts — the dependency-free leaf shared by the ruleset modules
// (`ruleset.ts`, `ruleset-schema.ts`, `capability.ts`), following the
// `field-access.ts` precedent for canonical helpers used across sim modules.
//
// Everything here is imported BY the ruleset modules and imports NOTHING from them,
// so the error type and the hash-critical canonicalization live in exactly one
// place without any two-way module cycle: schema/capability no longer reach back
// into `ruleset.ts` for `RulesetError`, and `normalizeForHash` no longer reaches
// into the schema module for the immunity order.

/** Thrown when a bundle is malformed, out of bounds, or describes something this
 *  sim build's capability profile does not (yet) simulate. Rejected at match
 *  creation, never inside `step` — the sim's totality guarantee is unaffected. */
export class RulesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesetError';
  }
}

/** This sim build's behavior version — stamped into replays; bump on any
 *  determinism-affecting change. Single-sourced HERE (the dependency-free leaf), so
 *  `ruleset.ts`'s capability/compile gating and `index.ts`'s public re-export can
 *  never drift apart the way the pre-S2 duplicated-literal scheme could (S1 deferred
 *  this single-sourcing to S2, which owns the first version bump).
 *  History: Story 5 (wave lifecycle, win/loss, score, per-creep columns) bumped
 *  4 → 5; M2 Story 2 (the multi-wave engine) bumps 5 → 6. */
export const SIM_VERSION = 6;

/** Canonical immunity order — `slow` before `stun` (decision: "one hash form"). */
const IMMUNITY_ORDER = ['slow', 'stun'] as const;

/** Canonicalize an immunity list: dedupe (set semantics) then sort into enum order —
 *  ONE hash form regardless of authored order/repetition. The single implementation
 *  shared by `validateRulesetShape` (parse-time canonicalization) and
 *  `normalizeForHash` (defensive re-canonicalization for hand-built bundles that
 *  bypass `parseRulesetJson`): the canonical order is a `rulesetHash` input, so two
 *  copies drifting apart would silently re-bucket every two-immunity bundle. */
export function canonicalImmunities(immunities: readonly ('slow' | 'stun')[]): ('slow' | 'stun')[] {
  return [...new Set(immunities)].sort(
    (a, b) => IMMUNITY_ORDER.indexOf(a) - IMMUNITY_ORDER.indexOf(b),
  );
}
