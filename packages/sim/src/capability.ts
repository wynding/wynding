// capability.ts — the per-`simVersion` capability profile (ADR 0007, PLAN M2-S1).
//
// The v2 schema is pinned STRUCTURALLY once (formatVersion 2, fixed for all of M2) —
// but a given sim BEHAVIOR version only implements a subset of what the shape can
// express (e.g. `SIM_VERSION` 9 simulates a real tower catalog, each tower a direct
// effect — single-target or an AoE blast — plus an optional `slow` and/or `dot`
// effect, against ground creeps only, each creep now able to carry flat armor,
// across a full multi-wave schedule). The capability profile is that subset,
// gating kinds, cardinalities, AND values in
// `compileRuleset` — so a schema-valid bundle that describes something this sim
// build cannot yet simulate (armor past the ceiling, a DoT past the duration
// ceiling, ...) is rejected loudly at compile time rather than silently
// mis-simulated.
// `formatVersion` never bumps for this; only `simVersion` does, and each story that
// adds behavior widens its own dimension(s) here alongside its `SIM_VERSION` bump.
//
// DIMENSIONS THAT DEFER TO THE SCHEMA at sv9 (a profile field wider than or equal
// to the v2 schema's own ceiling on the same axis, so the schema wall rejects first
// and this profile's own gate has no rejection witness of its own —
// `capability.test.ts`'s header explains each): waves/entries/offsets/clearBonus/
// both early-call divisors, `maxTowerCatalogSize`, `maxEffectsPerBundle`, and (M2-
// S4a QC round-1 #12) `allowedDirectForms` — the schema's `form` field is a
// `'single' | 'aoe'` enum with no third legal value to test a reject against.

import { RulesetError } from './ruleset-shared';

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
  /** The exact `leakCost` every creep in the catalog must carry (1 at simVersion 9 —
   *  m2.md: "leakCost = 1 until S10"); the compiled surface exposes that single
   *  value as `CompiledBalance.leakCost`. */
  readonly requiredLeakCost: number;
  readonly maxClearBonus: number;
  readonly maxEarlyCallBountyDivisor: number;
  readonly maxEarlyCallScoreDivisor: number;
  /** Ceiling on an `aoe` effect's `radiusFp` (M2-S4a) — 2048 (8 tiles) at sv9:
   *  generous against the shipped `splash`'s 384, wide enough for a future combo
   *  tower, yet small enough to stop a board-spanning blast. Checked per aoe effect
   *  in `checkCapabilityGlobal` alongside the radius-uniform gate. */
  readonly maxAoeRadiusFp: number;
  /** Ceiling on a `dot` effect's `durationTicks` (M2-S5a) — 100,000 at sv9. Together
   *  with the schema's own `durationTicks >= cadenceTicks` rule, this bounds both
   *  operands a DoT's tick scheduling reads, so it can never saturate at any bundle
   *  that compiles. Checked per `dot` effect in `checkCapabilityGlobal`. */
  readonly maxDotDurationTicks: number;
}

/** `SIM_VERSION` 9 (imported from `./ruleset-shared`, the dependency-free leaf):
 *  flat armor arithmetic on top of sv8's AoE + form-uniform/radius-uniform
 *  "one-shot-one-shape" model — a tower's direct effect may be `aoe` as well as
 *  `single`, ground-only, no immunities/roles, one uniform leak cost, the same
 *  64-wave/16-entry/full-economy wave engine sv6/sv7 already simulated, each creep
 *  may carry flat armor up to this profile's `maxArmor` ceiling, and (M2-S5a P3) a
 *  tower may also carry a `dot` effect, applied and ticked by this same sim build.
 *
 *  ONE PROFILE, NOT A HISTORY (G11): the sv8 profile is deleted with this bump —
 *  a live sv8 entry would misdescribe v9 tick code (it could no longer compile
 *  armored-creep content correctly, since v9 widens the armor gate combat.ts now
 *  reads), and replay's strict version equality already owns cross-version
 *  rejection, so there is nothing for a stale profile to serve.
 *
 *  `maxArmor` widens `0 → 16` — a bounding ceiling, not a balance guard: it admits
 *  this story's `6` and a later story's `8`/`5` without a further widening, and any
 *  value at or above the catalog's largest damage blanks equally, so there is no
 *  meaningfully tighter number. `allowedEffectKinds` widens `['direct', 'slow'] →
 *  ['direct', 'slow', 'dot']` in this same packet (M2-S5a P3) that implements DoT
 *  application — a bundle can never compile an effect this sim build cannot apply.
 *  `maxDotDurationTicks: 100_000`, paired with the schema's own
 *  `durationTicks >= cadenceTicks` rule, bounds both operands a DoT's tick
 *  scheduling reads. Every other axis is untouched from sv8. */
const PROFILES: Readonly<Record<number, CapabilityProfile>> = {
  9: {
    maxTowerCatalogSize: 64,
    maxWavesPerBoard: 64,
    maxEntriesPerWave: 16,
    maxOffsetTicks: 1_000_000,
    maxEffectsPerBundle: 8,
    allowedEffectKinds: ['direct', 'slow', 'dot'],
    allowedDirectForms: ['single', 'aoe'],
    allowedTowerDomains: ['ground'],
    allowedCreepDomains: ['ground'],
    allowedImmunities: [],
    allowedRoles: [],
    maxArmor: 16,
    requiredLeakCost: 1,
    maxClearBonus: 1_000_000,
    maxEarlyCallBountyDivisor: 1_000_000,
    maxEarlyCallScoreDivisor: 1_000_000,
    maxAoeRadiusFp: 2048,
    maxDotDurationTicks: 100_000,
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
