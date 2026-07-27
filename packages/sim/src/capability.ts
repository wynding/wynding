// capability.ts — the per-`simVersion` capability profile (ADR 0007, PLAN M2-S1).
//
// The v2 schema is pinned STRUCTURALLY once (formatVersion 2, fixed for all of M2) —
// but a given sim BEHAVIOR version only implements a subset of what the shape can
// express (e.g. `SIM_VERSION` 5 simulates only direct/single-target damage against
// ground creeps, one tower, one wave). The capability profile is that subset,
// gating kinds, cardinalities, AND values in `compileRuleset` — so a schema-valid
// bundle that describes something this sim build cannot yet simulate (a `slow`
// effect, a second wave, nonzero armor, ...) is rejected loudly at compile time
// rather than silently mis-simulated. `formatVersion` never bumps for this; only
// `simVersion` does, and each story that adds behavior widens its own dimension(s)
// here alongside its `SIM_VERSION` bump.

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
  /** The exact `leakCost` every creep in the catalog must carry (1 at simVersion 5 —
   *  m2.md: "leakCost = 1 until S10"); the compiled surface exposes that single
   *  value as `CompiledBalance.leakCost`. */
  readonly requiredLeakCost: number;
  readonly maxClearBonus: number;
  readonly maxEarlyCallBountyDivisor: number;
  readonly maxEarlyCallScoreDivisor: number;
}

/** `SIM_VERSION` 5 (imported from `./index` would create a circular import — see
 *  `ruleset.ts`'s header comment — so this is keyed by the plain numeric literal,
 *  which the caller passes as `SIM_VERSION`): exactly M1 semantics — one tower, one
 *  board wave, one wave entry, no stream offset, a single direct/single-target
 *  effect, ground-only, no immunities/roles/armor, one uniform leak cost, and both
 *  early-call divisors and the wave clear bonus pinned off. */
const PROFILES: Readonly<Record<number, CapabilityProfile>> = {
  5: {
    maxTowerCatalogSize: 1,
    maxWavesPerBoard: 1,
    maxEntriesPerWave: 1,
    maxOffsetTicks: 0,
    maxEffectsPerBundle: 1,
    allowedEffectKinds: ['direct'],
    allowedDirectForms: ['single'],
    allowedTowerDomains: ['ground'],
    allowedCreepDomains: ['ground'],
    allowedImmunities: [],
    allowedRoles: [],
    maxArmor: 0,
    requiredLeakCost: 1,
    maxClearBonus: 0,
    maxEarlyCallBountyDivisor: 0,
    maxEarlyCallScoreDivisor: 0,
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
