// capability.ts — the per-`simVersion` capability profile (ADR 0007, PLAN M2-S1).
//
// The v2 schema is pinned STRUCTURALLY once (formatVersion 2, fixed for all of M2) —
// but a given sim BEHAVIOR version only implements a subset of what the shape can
// express (e.g. `SIM_VERSION` 6 simulates only direct/single-target damage against
// ground creeps and one tower, though now across a full multi-wave schedule). The
// capability profile is that subset, gating kinds, cardinalities, AND values in
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

/** `SIM_VERSION` 6 (imported from `./ruleset-shared`, the dependency-free leaf):
 *  the multi-wave engine — still one tower, a single direct/single-target effect,
 *  ground-only, no immunities/roles/armor, one uniform leak cost, but now up to
 *  64 board waves of up to 16 concurrent entries each, with a real stream offset
 *  and both economy divisors (and the per-wave clear bonus) live at full value.
 *
 *  ONE PROFILE, NOT A HISTORY (G11): the sv5 profile is deleted with this bump —
 *  a live sv5 entry would misdescribe v6 tick code, and replay's strict version
 *  equality already owns cross-version rejection, so there is nothing for a stale
 *  profile to serve.
 *
 *  sv6 CEILINGS DEFER TO THE SCHEMA (G11 as corrected in Codex R2): a capability
 *  ceiling narrows only what THIS SIM BUILD cannot correctly simulate — not a
 *  product/balance opinion (that is the ruleset schema's job). v6 simulates any
 *  magnitude the v2 schema can express on the wave/economy axes (waves, entries,
 *  offsets, clear bonus, both early-call divisors): the schema's own structural
 *  caps (64 waves, 16 entries/wave) and its `GENERIC_MAX` (1_000_000) are already
 *  the widest values `validateRulesetShape` lets through, saturating arithmetic
 *  (`satAdd`/`satMul`) makes an over-large divisor floor to 0 rather than
 *  misbehave, and the real constraint on a match's tick budget is the compile-time
 *  bound gate (`ruleset.ts`), not this profile. So these dimensions carry the
 *  schema's own ceiling verbatim rather than inventing a narrower product cap
 *  without spec authority. */
const PROFILES: Readonly<Record<number, CapabilityProfile>> = {
  6: {
    maxTowerCatalogSize: 1,
    maxWavesPerBoard: 64,
    maxEntriesPerWave: 16,
    maxOffsetTicks: 1_000_000,
    maxEffectsPerBundle: 1,
    allowedEffectKinds: ['direct'],
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
