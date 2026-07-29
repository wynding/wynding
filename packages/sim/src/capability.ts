// capability.ts — the per-`simVersion` capability profile (ADR 0007, PLAN M2-S1).
//
// The v2 schema is pinned STRUCTURALLY once (formatVersion 2, fixed for all of M2) —
// but a given sim BEHAVIOR version only implements a subset of what the shape can
// express (e.g. `SIM_VERSION` 7 simulates a real tower catalog, each tower still
// direct/single-target plus an optional `slow` effect, against ground creeps only,
// across a full multi-wave schedule). The capability profile is that subset,
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
  /** The exact `leakCost` every creep in the catalog must carry (1 at simVersion 6 —
   *  m2.md: "leakCost = 1 until S10"); the compiled surface exposes that single
   *  value as `CompiledBalance.leakCost`. */
  readonly requiredLeakCost: number;
  readonly maxClearBonus: number;
  readonly maxEarlyCallBountyDivisor: number;
  readonly maxEarlyCallScoreDivisor: number;
}

/** `SIM_VERSION` 7 (imported from `./ruleset-shared`, the dependency-free leaf):
 *  catalog towers + the status-effect framework — a REAL tower catalog (up to 64
 *  entries, the schema's own ceiling) each still exactly a direct/single effect
 *  PLUS now an optional `slow` effect, ground-only, no immunities/roles/armor, one
 *  uniform leak cost, the same 64-wave/16-entry/full-economy wave engine sv6
 *  already simulated.
 *
 *  ONE PROFILE, NOT A HISTORY (G11): the sv6 profile is deleted with this bump —
 *  a live sv6 entry would misdescribe v7 tick code, and replay's strict version
 *  equality already owns cross-version rejection, so there is nothing for a stale
 *  profile to serve.
 *
 *  `maxTowerCatalogSize`/`maxEffectsPerBundle` WIDEN TO THE SCHEMA CAP (the
 *  narrows-only-what-the-build-cannot-simulate principle, G11/Codex R2): sv7
 *  compiles every catalog entry (step 3), so the catalog-cardinality ceiling is no
 *  longer this sim build's own restriction — it defers to the schema's own widest
 *  legal catalog (64) exactly like the wave/economy axes already do. Likewise
 *  `maxEffectsPerBundle` widens to the schema's per-tower effects cap (8) now that
 *  a bundle may legitimately carry both a direct and a slow effect (2 of 8) — still
 *  narrower than 8 would be an invented product opinion this profile has no
 *  authority to hold. `allowedEffectKinds` gains `'slow'` — the one new sim
 *  primitive this story implements. Every other axis is untouched from sv6. */
const PROFILES: Readonly<Record<number, CapabilityProfile>> = {
  7: {
    maxTowerCatalogSize: 64,
    maxWavesPerBoard: 64,
    maxEntriesPerWave: 16,
    maxOffsetTicks: 1_000_000,
    maxEffectsPerBundle: 8,
    allowedEffectKinds: ['direct', 'slow'],
    allowedDirectForms: ['single'],
    allowedTowerDomains: ['ground'],
    allowedCreepDomains: ['ground'],
    allowedImmunities: [],
    allowedRoles: [],
    maxArmor: 0,
    requiredLeakCost: 1,
    maxClearBonus: 1_000_000,
    maxEarlyCallBountyDivisor: 1_000_000,
    maxEarlyCallScoreDivisor: 1_000_000,
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
