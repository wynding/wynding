// capability.ts — the per-`simVersion` capability profile (ADR 0007, PLAN M2-S1).
//
// The v2 schema is pinned STRUCTURALLY once (formatVersion 2, fixed for all of M2) —
// but a given sim BEHAVIOR version only implements a subset of what the shape can
// express (e.g. `SIM_VERSION` 10 simulates a real tower catalog, each tower a direct
// effect — single-target or an AoE blast — plus an optional `slow`, `dot` and/or
// `stun` effect, against ground creeps only, each creep now able to carry flat armor
// and slow/stun immunities, across a full multi-wave schedule). The capability
// profile is that subset, gating kinds, cardinalities, AND values in
// `compileRuleset` — so a schema-valid bundle that describes something this sim
// build cannot yet simulate (armor past the ceiling, a DoT past the duration
// ceiling, ...) is rejected loudly at compile time rather than silently
// mis-simulated.
// `formatVersion` never bumps for this; only `simVersion` does, and each story that
// adds behavior widens its own dimension(s) here alongside its `SIM_VERSION` bump.
//
// DIMENSIONS THAT DEFER TO THE SCHEMA at sv10 (a profile field wider than or equal
// to the v2 schema's own ceiling on the same axis, so the schema wall rejects first
// and this profile's own gate has no rejection witness of its own —
// `capability.test.ts`'s header explains each): waves/entries/offsets/clearBonus/
// both early-call divisors, `maxTowerCatalogSize`, `maxEffectsPerBundle`, (M2-
// S4a QC round-1 #12) `allowedDirectForms` — the schema's `form` field is a
// `'single' | 'aoe'` enum with no third legal value to test a reject against — and
// (M2-S6 P4) `allowedImmunities`, now `['slow','stun']`, exactly the v2 schema's own
// immunity enum: no third legal value exists to test a reject against, deliberately
// (see the sv10 profile's own doc comment for why the widening goes past what S6
// ships).

import { RulesetError, MAX_DOT_DURATION_CADENCE_RATIO } from './ruleset-shared';

/** The gated dimensions a `compileRuleset` call enforces against a bundle, keyed by
 *  the sim's behavior version. Every field here is a CEILING (or, for the allow-
 *  lists, the complete legal set) — nothing wider than this may compile. */
export interface CapabilityProfile {
  readonly maxTowerCatalogSize: number;
  readonly maxWavesPerBoard: number;
  readonly maxEntriesPerWave: number;
  readonly maxOffsetTicks: number;
  readonly maxEffectsPerBundle: number;
  readonly allowedEffectKinds: readonly string[];
  readonly allowedDirectForms: readonly string[];
  readonly allowedTowerDomains: readonly string[];
  readonly allowedCreepDomains: readonly string[];
  readonly allowedImmunities: readonly string[];
  readonly allowedRoles: readonly string[];
  readonly maxArmor: number;
  /** The exact `leakCost` every creep in the catalog must carry (1 at simVersion 10 —
   *  m2.md: "leakCost = 1 until S10"); the compiled surface exposes that single
   *  value as `CompiledBalance.leakCost`. */
  readonly requiredLeakCost: number;
  readonly maxClearBonus: number;
  readonly maxEarlyCallBountyDivisor: number;
  readonly maxEarlyCallScoreDivisor: number;
  /** Ceiling on an `aoe` effect's `radiusFp` (M2-S4a) — 2048 (8 tiles) at sv10:
   *  generous against the shipped `splash`'s 384, wide enough for a future combo
   *  tower, yet small enough to stop a board-spanning blast. Checked per aoe effect
   *  in `checkCapabilityGlobal` alongside the radius-uniform gate. */
  readonly maxAoeRadiusFp: number;
  /** Ceiling on a `dot` effect's `durationTicks` (M2-S5a) — 100,000 at sv10. Together
   *  with the schema's own `durationTicks >= cadenceTicks` rule, this bounds both
   *  operands a DoT's tick scheduling reads, so it can never saturate at any bundle
   *  that compiles. Checked per `dot` effect in `checkCapabilityGlobal`. */
  readonly maxDotDurationTicks: number;
  /** Ceiling on a `dot` effect's `durationTicks` as a MULTIPLE of its tower's own attack
   *  cadence (M2-S5a, Codex P2 on PR #78) — 8 at sv10. This is what bounds how many live
   *  records ONE source can hold: a tower lands at most `durationTicks / fire cadence`
   *  shots inside a duration window, each potentially on a different creep, and a re-hit
   *  refreshes rather than adds. `maxDotDurationTicks` alone does not bound it —
   *  100,000 ticks against a 2-tick cadence admits ~50,000 records from a single tower,
   *  which is an order of magnitude past `MAX_DOT_RECORDS`. 8 admits the shipped `venom`
   *  (60/30 = 2) and the stress bundle's longer twin (200/30 ≈ 6.7) with room, while
   *  cutting the worst case per source from ~50,000 to 9 (the ratio plus the one record still
   *  resident when the next shot lands — see `MAX_DOT_RECORDS`). Checked per `dot` effect in
   *  `checkCapabilityGlobal`, against the tower's OWN attack cadence. */
  readonly maxDotDurationCadenceRatio: number;
}

/** `SIM_VERSION` 10 (imported from `./ruleset-shared`, the dependency-free leaf):
 *  sv9's armor-and-DoT model plus (M2-S6) a tower may also carry a `stun` effect —
 *  chance-based (`chanceNum` out of 256), duration-based, applied and drawn from the
 *  sim RNG by this same sim build — and a creep's `immunities` may now be non-empty,
 *  gating out `slow` and/or `stun` per creep. Every other axis is untouched from sv9.
 *
 *  ONE PROFILE, NOT A HISTORY (G11): the sv9 profile is deleted with this bump —
 *  a live sv9 entry would misdescribe v10 tick code (it could no longer compile
 *  stun/immunity content correctly, since v10 widens the effect-kind and immunity
 *  gates combat.ts now reads), and replay's strict version equality already owns
 *  cross-version rejection, so there is nothing for a stale profile to serve.
 *
 *  `allowedEffectKinds` widens `['direct', 'slow', 'dot'] → [..., 'stun']` in the
 *  same packet (M2-S6 P1/P2) that implements stun application — a bundle can never
 *  compile an effect this sim build cannot apply.
 *
 *  `allowedImmunities` widens `[] → ['slow', 'stun']` — DELIBERATELY WIDER than what
 *  S6 ships (only `resolute`'s `['slow']`). This is the one axis on this bump that is
 *  not a tight ceiling: with `['slow']` alone, no compilable bundle could ever carry
 *  a stun-immune creep, and m2.md pins "an immune target consumes no draw" as a
 *  stun-specific rule that then has no production witness to test against. The cost,
 *  paid on record: content could ship a stun-immune creep before S10 authors one
 *  (its `boss`), and — since `['slow','stun']` now equals the v2 schema's own
 *  immunity enum exactly — this axis has no rejection witness of its own; see the
 *  "DIMENSIONS THAT DEFER TO THE SCHEMA" note above. (M2-S6, Key decision #2.) */
const PROFILES: Readonly<Record<number, CapabilityProfile>> = {
  10: {
    maxTowerCatalogSize: 64,
    maxWavesPerBoard: 64,
    maxEntriesPerWave: 16,
    maxOffsetTicks: 1_000_000,
    maxEffectsPerBundle: 8,
    allowedEffectKinds: ['direct', 'slow', 'dot', 'stun'],
    allowedDirectForms: ['single', 'aoe'],
    allowedTowerDomains: ['ground'],
    allowedCreepDomains: ['ground'],
    allowedImmunities: ['slow', 'stun'],
    allowedRoles: [],
    maxArmor: 16,
    requiredLeakCost: 1,
    maxClearBonus: 1_000_000,
    maxEarlyCallBountyDivisor: 1_000_000,
    maxEarlyCallScoreDivisor: 1_000_000,
    maxAoeRadiusFp: 2048,
    maxDotDurationTicks: 100_000,
    maxDotDurationCadenceRatio: MAX_DOT_DURATION_CADENCE_RATIO,
  },
};

// Deep-freeze every profile at module init: `Readonly<…>` is erased at compile time,
// and the returned profile is the live object every later `compileRuleset` gate
// reads — a caller mutating it (or an allow-list array inside it) could silently
// widen or narrow the gate for the whole process, diverging the two loaders. Same
// discipline as the compiled-surface deep-freeze in `ruleset.ts`.
for (const profile of Object.values(PROFILES)) {
  for (const value of Object.values(profile)) {
    if (Array.isArray(value)) Object.freeze(value);
  }
  Object.freeze(profile);
}
Object.freeze(PROFILES);

/** Look up the capability profile for a sim behavior version. Throws `RulesetError`
 *  on an unknown `simVersion` — there is no "default" profile, since a wider one
 *  would silently accept content this sim build cannot correctly simulate. */
export function capabilityProfile(simVersion: number): CapabilityProfile {
  const profile = PROFILES[simVersion];
  if (profile === undefined) {
    throw new RulesetError(`no capability profile for simVersion ${String(simVersion)}`);
  }
  return profile;
}
