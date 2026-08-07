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
// DIMENSIONS THAT DEFER TO THE SCHEMA at sv12 (a profile field wider than or equal
// to the v2 schema's own ceiling on the same axis, so the schema wall rejects first
// and this profile's own gate has no rejection witness of its own —
// `capability.test.ts`'s header explains each): waves/entries/offsets/clearBonus/
// both early-call divisors, `maxTowerCatalogSize`, `maxEffectsPerBundle`, (M2-
// S4a QC round-1 #12) `allowedDirectForms` — the schema's `form` field is a
// `'single' | 'aoe'` enum with no third legal value to test a reject against —
// (M2-S6 P4) `allowedImmunities`, now `['slow','stun']`, exactly the v2 schema's own
// immunity enum: no third legal value exists to test a reject against, deliberately
// (see the sv10 profile's own doc comment for why the widening goes past what S6
// ships) — and (M2-S7 P1) `allowedTowerDomains`/`allowedCreepDomains`, now
// `['ground','air','both']`/`['ground','air']`, exactly the v2 schema's own
// `TowerTargetDomain`/`CreepDomain` enums: no third legal value exists on either
// axis to test a reject against (see the sv11 profile's own doc comment — in this file's git history, not above; G11 deletes each profile at its bump — for why the
// widening isn't a narrower ceiling instead).

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
  /** Ceiling on a `support` effect's `damageMulFp` (M2-S8) — 1024 (×4) at sv12. The
   *  v2 schema admits 257..1e6, which is a ×3906 beacon; the profile is where value
   *  ceilings live (`maxArmor: 16`, `maxAoeRadiusFp: 2048` set the precedent). ×4 is
   *  generous against the shipped `beacon`'s ×1.5 while keeping every buffed amount a
   *  compiling bundle can produce far inside the safe-integer domain. Checked per
   *  `support` effect in `checkCapabilityGlobal`. */
  readonly maxSupportDamageMulFp: number;
}

/** `SIM_VERSION` 12 (imported from `./ruleset-shared`, the dependency-free leaf):
 *  sv11's domain axis plus (M2-S8) the SUPPORT axis activates — a tower's bundle may
 *  carry a `support` effect instead of an attack, raising the damage amounts of the
 *  attacking towers whose footprint shares a full cell edge with its own. Every other
 *  axis is untouched from sv11.
 *
 *  ONE PROFILE, NOT A HISTORY (G11): the sv11 profile is deleted with this bump —
 *  a live sv11 entry would misdescribe v12 tick code (it could not compile an
 *  attackless bundle, which v12's `compileRuleset` now admits and whose aura
 *  `combat.ts` now reads every phase), and replay's strict version equality already
 *  owns cross-version rejection, so there is nothing for a stale profile to serve.
 *
 *  `allowedEffectKinds` widens `[...] → [..., 'support']` in the same packet (M2-S8
 *  P3) that implements the compile, aura and combat paths the kind newly reaches.
 *  Unlike the S7 domain axes — which widened to exactly the v2 schema's own enums and
 *  so kept no rejection witness — this widening leaves `'burst'` still excluded, so
 *  `allowedEffectKinds` RETAINS a live reject witness of its own (S9 owns `burst`);
 *  `capability.test.ts`'s witness does not have to move. The NEW ceiling
 *  `maxSupportDamageMulFp` is genuinely narrower than the schema's own 1e6 wall, so
 *  it too has a rejection witness rather than deferring to the schema. */
const PROFILES: Readonly<Record<number, CapabilityProfile>> = {
  12: {
    maxTowerCatalogSize: 64,
    maxWavesPerBoard: 64,
    maxEntriesPerWave: 16,
    maxOffsetTicks: 1_000_000,
    maxEffectsPerBundle: 8,
    allowedEffectKinds: ['direct', 'slow', 'dot', 'stun', 'support'],
    allowedDirectForms: ['single', 'aoe'],
    allowedTowerDomains: ['ground', 'air', 'both'],
    allowedCreepDomains: ['ground', 'air'],
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
    maxSupportDamageMulFp: 1024,
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
