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
 *  4 → 5; M2 Story 2 (the multi-wave engine) bumped 5 → 6; M2 Story 3 (catalog
 *  towers + the status-effect framework: a real tower catalog, `slow`, per-creep
 *  status columns) bumped 6 → 7; M2 Story 4a (AoE: `Impact` becomes a
 *  `targeted`/`blast` discriminated union — hash-breaking even for single-target
 *  play — plus the `aoe` direct form and the form-uniform/radius-uniform
 *  compile-time gates) bumped 7 → 8; M2 Story 5a bumps 8 → 9 — THREE
 *  determinism-affecting changes, not one: flat armor arithmetic on the `direct`
 *  primitive (resolved per creep row via the `creepById` combat seam), a REQUIRED
 *  `sourceId` on both `Impact` variants (hash-breaking for single-target play too),
 *  and the per-source DoT model (`SimState.dots`, the tick step, inclusive expiry). */
export const SIM_VERSION = 9;

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

/** Integer ceiling division — `⌈a/b⌉` via `Math.floor((a+b-1)/b)`, never float
 *  division (the determinism contract). Used once, below, but named for its own
 *  proof obligation (Codex R2-4's formula cites it explicitly). */
function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

/**
 * The ONE effective-speed formula (M2-S3, Codex R2-4): both the compile-time bound
 * gate (`ruleset.ts`) and runtime movement (`index.ts`'s `advanceCreep` call site)
 * call this EXACT function, so the replay-bound authority can never drift from
 * actual movement. `mulFp === 0` means "no active slow" (the creep's own column
 * pair, or the catalog-wide "no slow tower" case for the bound gate) — the base
 * speed, untouched. Otherwise the effective speed is the largest of three floors,
 * so a schema-legal degenerate bundle can never mint a permanent 0-speed stall:
 *   - `1` — the totality rail (unreachable at any shipped content).
 *   - `⌊base·mulFp/256⌋` — the authored multiplier (floor rounding).
 *   - `⌈base·slowFloorNum/slowFloorDen⌉` — the ruleset's slow floor (ceil rounding),
 *     so the floor is never UNDER-applied by truncation.
 */
export function effectiveSpeedFp(
  baseSpeedFp: number,
  mulFp: number,
  slowFloorNum: number,
  slowFloorDen: number,
): number {
  if (mulFp === 0) return baseSpeedFp;
  return Math.max(
    1,
    Math.floor((baseSpeedFp * mulFp) / 256),
    ceilDiv(baseSpeedFp * slowFloorNum, slowFloorDen),
  );
}

/** The DoT duration:fire-cadence ratio the capability profile admits, and the basis the
 *  record rail is derived from — as `RATIO + 1` per source, NOT `RATIO`; see
 *  `MAX_DOT_RECORDS` in `combat.ts` for why the extra one is real and where it is spent. A tower lands `floor((durationTicks - 1) / fire cadence) + 1` shots
 *  inside a duration window, each able to seed a different creep (a re-hit refreshes
 *  rather than adds), so when the capability profile admits `durationTicks` up to
 *  `N × fire cadence` that expression is exactly `N`. Cross-checked against the shipped
 *  `venom` (60/30): `floor(59/30) + 1 = 2`, which is what it actually holds.
 *
 *  `capability.ts`'s `maxDotDurationCadenceRatio` MUST equal this — that gate is what
 *  makes the derivation true rather than aspirational, and `capability.test.ts` pins the
 *  gate and the rail together. */
export const MAX_DOT_DURATION_CADENCE_RATIO = 8;
