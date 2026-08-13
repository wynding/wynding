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
// DIMENSIONS THAT DEFER TO THE SCHEMA at sv15 (a profile field wider than or equal
// to the v2 schema's own ceiling on the same axis, so the schema wall rejects first
// and this profile's own gate has no rejection witness of its own —
// `capability.test.ts`'s header explains each): waves/entries/offsets/clearBonus/
// both early-call divisors, `maxTowerCatalogSize`, `maxEffectsPerBundle`, (M2-
// S4a QC round-1 #12) `allowedDirectForms` — the schema's `form` field is a
// `'single' | 'aoe'` enum with no third legal value to test a reject against —
// (M2-S6 P4) `allowedImmunities`, now `['slow','stun']`, exactly the v2 schema's own
// immunity enum: no third legal value exists to test a reject against, deliberately
// (see the sv10 profile's own doc comment for why the widening goes past what S6
// ships) — (M2-S7 P1) `allowedTowerDomains`/`allowedCreepDomains`, now
// `['ground','air','both']`/`['ground','air']`, exactly the v2 schema's own
// `TowerTargetDomain`/`CreepDomain` enums: no third legal value exists on either
// axis to test a reject against (see the sv11 profile's own doc comment — in this file's git history, not above; G11 deletes each profile at its bump — for why the
// widening isn't a narrower ceiling instead) — and (M2-S9 P1) `allowedEffectKinds`,
// now all six kinds, exactly the v2 schema's own `EffectDef` enum: no seventh legal
// value exists to test a reject against; `allowedBurstForms` is the narrower axis
// that carries the replacement witness — and (M2-S10 P1) `allowedRoles`, now
// `['boss']`, exactly the v2 schema's own role enum (`CreepDef.role?: 'boss'`): no
// second legal role value exists to test a reject against. Deleting
// `requiredLeakCost` removes a second witness (the "must be exactly 1" reject);
// `maxLeakCost`, genuinely narrower than the schema's own 1..1000, is the
// replacement and carries both.

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
  /** Ceiling on a creep's `leakCost` (M2-S10) — 16 at sv14. A POLICY ceiling, not a
   *  derived safety rail: nothing overflows at 1000 (the leak subtraction in `step`
   *  is already `MIN_SAFE_INTEGER`-guarded), and 16 echoes `maxArmor: 16`, which is
   *  equally soft. Checked per creep in `checkCapabilityGlobal`. */
  readonly maxLeakCost: number;
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
  /** Ceiling on a `support` effect's `damageMulFp` (M2-S8) — 1024 (×4) at sv13. The
   *  v2 schema admits 257..1e6, which is a ×3906 beacon; the profile is where value
   *  ceilings live (`maxArmor: 16`, `maxAoeRadiusFp: 2048` set the precedent). ×4 is
   *  generous against the shipped `beacon`'s ×1.5 while keeping every buffed amount a
   *  compiling bundle can produce far inside the safe-integer domain. Checked per
   *  `support` effect in `checkCapabilityGlobal`. */
  readonly maxSupportDamageMulFp: number;
  /** The complete legal set of `form` values a `burst` effect may carry (M2-S9) —
   *  `['aoe']` at sv13. The v2 schema admits `burst/single` too; nothing ships it,
   *  and supporting it would mean wiring the sticky-target path into the consumption
   *  branch — real code with zero shipped content. This is the `maxSupportDamageMulFp`
   *  pattern: a profile genuinely narrower than the schema, so it keeps a live
   *  rejection witness — and it is the one that REPLACES the witness
   *  `allowedEffectKinds` loses at this bump. Enforced per burst effect in
   *  `checkCapabilityGlobal`, split out from `allowedDirectForms` (which now covers
   *  only `direct`). */
  readonly allowedBurstForms: readonly string[];
  /** Ceiling on a BURST tower's `attack.travelTicks` (M2-S9) — 8 at sv13. This one
   *  exists because activating the burst axis makes a schema path live that skips the
   *  only bound `travelTicks` ever had. For a CADENCED tower the schema enforces
   *  `travelTicks < cadenceTicks` (`ruleset-schema.ts`), and that is precisely what
   *  makes `combat.ts`'s `MAX_IN_FLIGHT_IMPACTS` sizing work: each live tower holds ≤1
   *  impact in flight, so in-flight ≤ live towers ≤ `MAX_TOWERS`, which IS the cap. A
   *  burst bundle carries no cadence, so that rule does not run and the only remaining
   *  bound is the schema's generic 1..1e6.
   *
   *  The per-tower framing is what breaks, not the per-tower count: a consumed mine
   *  keeps its one discharge resident for `travelTicks` while its tower slot is FREED
   *  for a rebuild, so place→trigger→place churn accumulates resident impacts that no
   *  longer correspond to any live tower. At a schema-legal `travelTicks: 1_000_000`
   *  every discharge of a whole match stays resident, the queue reaches the cap, and
   *  the cap-full branch then makes EVERY tower's fire a no-op — a bundle that compiles
   *  clean and silently stops the game. Shipped content is nowhere near it (`mine` has
   *  `travelTicks: 1`), but rulesets are moddable data (ADR 0007) and the profile is
   *  exactly where "content this sim build cannot correctly simulate" gets rejected.
   *
   *  8 is the longest travel any shipped tower uses (`splash`/`frost-splash`), so it
   *  constrains nothing a real bundle wants while keeping a burst discharge a SHOT
   *  rather than a resident.
   *
   *  WHAT THIS CEILING DOES AND DOES NOT BOUND (ship-review corrected an earlier draft
   *  that claimed the residue sits "far inside" the cap — it does not, and the number
   *  mattered because this is the derivation a future widening would lean on). It bounds
   *  the residency WINDOW, not the total: per-tick consumptions are limited only by how
   *  many mines are live (≤ `MAX_TOWERS`), so an 8-tick window admits far more than
   *  `MAX_IN_FLIGHT_IMPACTS` in the worst case. `MAX_IN_FLIGHT_IMPACTS` remains the hard
   *  backstop, exactly as it was before this ceiling existed. What the ceiling buys is
   *  that reaching the backstop now costs a placement per resident impact — 6 bounty and
   *  a free 2×2 anchor each, against ~143 anchors on the shipped board — instead of
   *  being handed to any bundle that authors a large `travelTicks`. That is the same
   *  posture every other value ceiling here takes: make the bad case cost something
   *  proportional, and leave the absolute rail to the runtime bound.
   *
   *  Genuinely narrower than the schema's own 1e6, so like `allowedBurstForms` it carries
   *  a real rejection witness. Checked per tower (burst bundles only) in
   *  `checkCapabilityGlobal`. */
  readonly maxBurstTravelTicks: number;
}

/** `SIM_VERSION` 15 (imported from `./ruleset-shared`, the dependency-free leaf):
 *  sv14's capability surface, field for field. No axis activates, no ceiling moves,
 *  no witness changes hands — this entry is the sv14 profile's contents verbatim, and
 *  that is not an oversight. The bump (issue #70) exists for a step-behavior change no
 *  profile can express: the opening launch pays nothing, so a log carrying an index-0
 *  early call resolves differently than it did at sv14. Which bundles COMPILE is
 *  identical either side of the bump.
 *
 *  ONE PROFILE, NOT A HISTORY (G11): the sv14 profile is deleted with this bump. This
 *  is the first bump whose deleted entry would still have described bundle legality
 *  accurately — and it goes anyway, because a profile's job is to describe what THIS
 *  build can correctly SIMULATE, not what it can parse. v15 tick code resolves an
 *  index-0 early call differently, so a live sv14 entry would stand as a claim that
 *  this build honours sv14 semantics; it does not. Replay's strict version equality
 *  already owns cross-version rejection, so there is nothing for a stale profile to
 *  serve.
 *
 *  WITNESSES ARE UNCHANGED here — every ceiling genuinely narrower than the v2 schema
 *  (`maxArmor`, `maxLeakCost`, `maxDotDurationTicks`, `maxDotDurationCadenceRatio`,
 *  `maxSupportDamageMulFp`, `maxAoeRadiusFp`, `maxBurstTravelTicks`, `allowedBurstForms`)
 *  carries its live rejection witness across untouched, so unlike a widening bump this one
 *  needs no replacement witness at all. (The sv13 → sv14 handover that widened `allowedRoles` to the
 *  schema's own enum and retired `requiredLeakCost` is history, not a description of
 *  this profile.) */
const PROFILES: Readonly<Record<number, CapabilityProfile>> = {
  15: {
    maxTowerCatalogSize: 64,
    maxWavesPerBoard: 64,
    maxEntriesPerWave: 16,
    maxOffsetTicks: 1_000_000,
    maxEffectsPerBundle: 8,
    allowedEffectKinds: ['direct', 'slow', 'dot', 'stun', 'support', 'burst'],
    allowedDirectForms: ['single', 'aoe'],
    allowedTowerDomains: ['ground', 'air', 'both'],
    allowedCreepDomains: ['ground', 'air'],
    allowedImmunities: ['slow', 'stun'],
    allowedRoles: ['boss'],
    maxArmor: 16,
    maxLeakCost: 16,
    maxClearBonus: 1_000_000,
    maxEarlyCallBountyDivisor: 1_000_000,
    maxEarlyCallScoreDivisor: 1_000_000,
    maxAoeRadiusFp: 2048,
    maxDotDurationTicks: 100_000,
    maxDotDurationCadenceRatio: MAX_DOT_DURATION_CADENCE_RATIO,
    maxSupportDamageMulFp: 1024,
    allowedBurstForms: ['aoe'],
    maxBurstTravelTicks: 8,
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
