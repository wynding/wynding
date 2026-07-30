// capability.ts — the per-`simVersion` capability profile (ADR 0007, PLAN M2-S1).
//
// The v2 schema is pinned STRUCTURALLY once (formatVersion 2, fixed for all of M2) —
// but a given sim BEHAVIOR version only implements a subset of what the shape can
// express (e.g. `SIM_VERSION` 8 simulates a real tower catalog, each tower a direct
// effect — single-target or, now, an AoE blast — plus an optional `slow` effect,
// against ground creeps only, across a full multi-wave schedule). The capability
// profile is that subset,
// gating kinds, cardinalities, AND values in
// `compileRuleset` — so a schema-valid bundle that describes something this sim
// build cannot yet simulate (a `slow` effect, nonzero armor, ...) is rejected
// loudly at compile time rather than silently mis-simulated. `formatVersion` never
// bumps for this; only `simVersion` does, and each story that adds behavior widens
// its own dimension(s) here alongside its `SIM_VERSION` bump.

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
  /** The exact `leakCost` every creep in the catalog must carry (1 at simVersion 7 —
   *  m2.md: "leakCost = 1 until S10"); the compiled surface exposes that single
   *  value as `CompiledBalance.leakCost`. */
  readonly requiredLeakCost: number;
  readonly maxClearBonus: number;
  readonly maxEarlyCallBountyDivisor: number;
  readonly maxEarlyCallScoreDivisor: number;
  /** Ceiling on an `aoe` effect's `radiusFp` (M2-S4a) — 2048 (8 tiles) at sv8:
   *  generous against the shipped `splash`'s 384, wide enough for a future combo
   *  tower, yet small enough to stop a board-spanning blast. Checked per aoe effect
   *  in `checkCapabilityGlobal` alongside the radius-uniform gate. */
  readonly maxAoeRadiusFp: number;
}

/** `SIM_VERSION` 8 (imported from `./ruleset-shared`, the dependency-free leaf):
 *  AoE + the form-uniform/radius-uniform "one-shot-one-shape" model (M2-S4a) — a
 *  tower's direct effect may now be `aoe` as well as `single`, ground-only, no
 *  immunities/roles/armor, one uniform leak cost, the same 64-wave/16-entry/
 *  full-economy wave engine sv6/sv7 already simulated.
 *
 *  ONE PROFILE, NOT A HISTORY (G11): the sv7 profile is deleted with this bump —
 *  a live sv7 entry would misdescribe v8 tick code (it could no longer compile
 *  `splash`/`frost-splash`-shaped content correctly, since v8 relaxed the
 *  per-tower "direct effect" guard to accept either form), and replay's strict
 *  version equality already owns cross-version rejection, so there is nothing for
 *  a stale profile to serve.
 *
 *  `allowedDirectForms` gains `'aoe'` — the one new sim primitive this story
 *  implements — alongside a new `maxAoeRadiusFp` ceiling (2048 fp, 8 tiles: see its
 *  own doc). The two NEW cross-field gates the "one-shot-one-shape" model needs
 *  (form-uniform per tower, radius-uniform across a tower's aoe effects) are NOT
 *  profile fields — they compare effects WITHIN one tower, so they are compile-time
 *  checks in `ruleset.ts`'s `checkCapabilityGlobal`, run alongside this profile's
 *  own gates. Every other axis is untouched from sv7. */
const PROFILES: Readonly<Record<number, CapabilityProfile>> = {
  8: {
    maxTowerCatalogSize: 64,
    maxWavesPerBoard: 64,
    maxEntriesPerWave: 16,
    maxOffsetTicks: 1_000_000,
    maxEffectsPerBundle: 8,
    allowedEffectKinds: ['direct', 'slow'],
    allowedDirectForms: ['single', 'aoe'],
    allowedTowerDomains: ['ground'],
    allowedCreepDomains: ['ground'],
    allowedImmunities: [],
    allowedRoles: [],
    maxArmor: 0,
    requiredLeakCost: 1,
    maxClearBonus: 1_000_000,
    maxEarlyCallBountyDivisor: 1_000_000,
    maxEarlyCallScoreDivisor: 1_000_000,
    maxAoeRadiusFp: 2048,
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
