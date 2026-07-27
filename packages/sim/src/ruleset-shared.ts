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
