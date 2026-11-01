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
 *  and the per-source DoT model (`SimState.dots`, the tick step, inclusive expiry);
 *  M2 Story 6 bumps 9 → 10 — a tower may carry a chance-based `stun` effect, and a
 *  creep's `immunities` may gate out `slow` and/or `stun`; M2 Story 7 (Air) bumps
 *  10 → 11 — the domain axis activates, in three parts: air creeps fly a straight line
 *  to the exit, re-aimed each step from the occupied cell; an attacking tower's mask
 *  may target `ground`/`air`/`both`; and the impact snapshot carries a domain
 *  (hash-breaking even for ground-only play, since the `Impact` shape itself changes).
 *
 *  On the first of those, the ray is `occupancyCell → exit`, NOT a fixed
 *  entrance→exit ray. The two coincide on every board that SCHEDULES an air creep —
 *  the only scope the axis-alignment gate covers. sv11 still admits a non-axis-aligned
 *  board whose own waves never fly (`capability.test.ts` pins that cell of the matrix
 *  deliberately), and on one of those a forged or restored flyer — exactly what the
 *  wider-scoped size gate beside it exists for — walks a staircase rather than a ray.
 *
 *  M2 Story 8 (Support) bumps 11 → 12 — the support axis activates: a tower bundle may
 *  carry a `support` effect INSTEAD of an attack (so `compileRuleset` now admits an
 *  attackless, rangeless, cadenceless tower), and such a tower raises the damage
 *  amounts of the attacking towers whose 2×2 footprint shares a full cell edge with
 *  its own. The buff enters at the fire-time snapshot and lands in the EXISTING
 *  `effects[].amount`, so unlike S7 the `Impact` shape does not change — a board with
 *  no beacon placed simulates bit-for-bit as it did at sv11.
 *
 *  M2 Story 9 (Burst) bumps 12 → 13 — the burst axis activates, the sixth and last
 *  effect primitive: a tower bundle may carry a `burst` effect (an AoE discharge with
 *  no attack cadence), and such a tower fires exactly once, centring its blast on its
 *  own footprint, and is CONSUMED at its fire tick — the row is deleted, so the maze
 *  re-routes from the next movement step. Like S8 and unlike S7, the `Impact` shape
 *  does not change (a burst discharge is an ordinary `blast` impact), so a board with
 *  no mine placed simulates bit-for-bit as it did at sv12.
 *
 *  M2 Story 10 bumps 13 → 14 — the multi-life leak un-collapses. `leakCost` has been
 *  a per-creep v2 schema field since S1, but sv13's capability profile pinned every
 *  creep to a uniform value (`requiredLeakCost`) and `compileRuleset` collapsed the
 *  whole catalog into one flat `CompiledBalance.leakCost`. sv14 lifts that uniformity
 *  pin to a per-creep ceiling (`maxLeakCost`) and widens `allowedRoles` to admit
 *  `'boss'`: `CompiledCreep` now carries its own `leakCost` and, when present,
 *  `role`, and `step`'s leak branch subtracts each leaking creep's own cost instead
 *  of one collapsed value. `Impact`, `SimState` and `rulesetHash` are untouched — the
 *  raw bundle already projected per-creep `leakCost`/`role` into the hash, so this is
 *  a compiled-surface change only.
 *
 *  Issue #70 bumps 14 → 15 — and nothing about bundle legality moves with it. What
 *  changes is one STEP rule: the opening launch (wave index 0) pays neither the
 *  early-call bounty bonus nor the score credit, because beginning the run is the act
 *  that calls wave 1 and there is no "early" for it to be. Only a log containing an
 *  index-0 early call resolves differently; every other log is bit-for-bit sv14.
 *  `Impact`, `SimState` and `rulesetHash` are untouched, and so is the capability
 *  profile — this is the first bump that is PURELY a tick-rule change, which is
 *  precisely the class the version exists to fence off from stored replays.
 *
 *  Issue #25 bumps 15 → 16 — the TERMINAL GRADING CONTRACT, and the first bump that
 *  changes no tick rule at all. `step` is byte-identical to sv15: every hash, every
 *  trace, every `SimState` field is untouched, and the determinism golden does not move
 *  (verified, not assumed). What moves is what the two derived functions read OUT of a
 *  terminal state (owner rulings, 2026-08-22): a WIN now always earns ≥ 1 star
 *  (`deriveStars` floors to 1 below the lowest authored threshold), and a LOSS now
 *  scores 0 (`deriveScore`'s lost branch forfeits the kill bounty alongside the
 *  early-call credit, superseding the sv6–sv15 "Σ kill-bounties only" contract).
 *  Grading is nevertheless part of the versioned replay contract, not decoration: ADR
 *  0006 makes the validator accept only its OWN version precisely so two same-version
 *  implementations must agree on the score they hand back, so a build that grades a
 *  stored sv15 replay by sv16 rules would answer a question it was never asked. The
 *  capability profile is again unchanged — which bundles compile is identical either
 *  side of the bump.
 *
 *  M3 story 2 bumps 16 → 17 — the RUN-LENGTH CAP. `MAX_MATCH_TICKS` doubles from 36,000
 *  to 72,000 (`ruleset.ts`), so a 30-wave arc compiles. Like sv16, `step` is
 *  byte-identical: every hash, every trace and the determinism goldens stand. What moves
 *  is the edge of what is legal, on both sides of the replay contract: a bundle whose
 *  hands-off schedule plus worst-case walk lands between 36,001 and 72,000 ticks now
 *  compiles, and a replay that terminates in that range now validates where sv16 timed it
 *  out. By the code's own precedent (`AOE_SCAN_CEILING`), changing which bundles compile
 *  is a behaviour change, and an sv16 validator would reject the very replays sv17
 *  accepts. Two bounds move with it for the same run: the replay's tower-command budget
 *  doubles to 2,000 (`MAX_TOTAL_TOWER_COMMANDS`, below — it moved here from
 *  `packages/replay` so the next bound can be computed from it), and `MAX_DOT_RECORDS`
 *  (`combat.ts`), derived from that budget, doubles to 18,000; a table that never fills
 *  simulates exactly as before. The capability profile's fields are unchanged; none of
 *  the three is one of them. */
export const SIM_VERSION = 17;

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
  if (mulFp === 0) return Math.max(1, baseSpeedFp);
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

/**
 * The replay validator's budget of tower commands (`placeTower` + `sellTower`) across a
 * whole match. `packages/replay` enforces it, and it lives HERE, not there, because
 * `combat.ts`'s `MAX_DOT_RECORDS` rests on it (issue #77): every DoT source is a minted
 * tower id, and minting one takes a `placeTower`. `packages/sim` cannot import from
 * `packages/replay` without the layering back-edge AGENTS.md blocks, so the validator
 * imports this one — the `MAX_MATCH_TICKS` arrangement — and the two can no longer move
 * apart with no test failing.
 *
 * Its first job is CPU: every `placeTower` that reaches the maze-invariant check runs a
 * full-board search, and a rejected placement is a free no-op, so the economy cannot
 * rate-limit repeats.
 *
 * 2,000 since sv17 (M3 story 2; 1,000 before), derived from what legitimate play can
 * issue. A command that COMMITS is never free at the shipped catalog's prices: a placement
 * costs at least 5 (`basic`), and a sold tower refunds ⌊¾⌋ of its cost, so a
 * sell-and-rebuild flip — two commands — nets at least 2. A run whose whole income is I
 * and that keeps H towers (standing, or consumed like a mine) therefore commits at most
 * H + (I − 5H) = I − 4H tower commands, and never more than I. M3's first-pass I is
 * 1,423 (80 starting + 1,084 kills + 102 clear bonuses + 157 early calls,
 * `docs/milestones/m3.md`), and 1,000 did not cover it: 40 kept `basic`s and 481 flips are
 * 1,002 commands. 2,000 leaves the balance pass room to raise I by about 40%; if it goes
 * past 2,000, re-derive. The shipped client logs only commands its own preview accepts,
 * so the free no-ops the CPU half guards against do not come from play.
 */
export const MAX_TOTAL_TOWER_COMMANDS = 2_000;
