// rng.ts — Mulberry32 seeded PRNG. LIVE since M2-S6 (ADR 0010): `SimState.rngState` is
// part of the hash-serialized world state, and `step()` (`packages/sim/src/index.ts`)
// constructs one `Rng` from it at the top of the combat phase, threads it into
// `runCombat`/`applyImpactToCreep` for the `stun` effect's `nextInt(256) < chanceNum`
// roll, and snapshots it back with `getState()` UNCONDITIONALLY at tick end — whether or
// not anything drew — so a stun-free run's `rngState` still round-trips byte-identically.
// `Rng` is exercised directly by `engine.test.ts` and indirectly by every stun-carrying
// sim test.
//
// This API is normative for byte-identity determinism: do not rename methods,
// add a `nextFloat()`, or create module-level singleton instances. The sim RNG is
// reconstructed from serialized state at tick start and snapshotted at tick end, keeping
// randomness a pure function of `(seed, ruleset, boardId, inputs)` — ADR 0007's tuple. The
// RULESET and BOARD belong in it, not just the seed and the input log: draws happen only
// for surviving, non-immune `stun` effects, so the compiled-per-board catalog determines
// the draw SCHEDULE, not merely each draw's outcome. See ADR 0010 for why the
// generator and the `nextInt` mapping are frozen as of this wiring — this was the last
// free moment to change them, and both documented weaknesses below were measured against
// this exact use rather than argued about.
//
// Cosmetic (render-only) randomness must use a SEPARATE generator — never draw
// from this one, or replays diverge.

export class Rng {
  private state: number; // internal uint32

  constructor(seed: number) {
    this.state = seed >>> 0; // coerce to uint32
  }

  /**
   * Deterministic 32-bit output, advancing state one step. NOT a uniform integer over
   * the full `[0, 0xFFFFFFFF]` range in the equidistribution sense — Mulberry32 has only
   * 32 bits of internal state, so it is approximately uniform but NOT equidistributed
   * over uint32 (a real, if unquantified here, fraction of the output space is
   * unreachable from any given state — see the generator's own analysis; we don't repeat
   * exact figures, which would presume a precision this generator doesn't have).
   */
  nextU32(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /**
   * Integer in [0, max) via `nextU32() % max`. `max` must be a positive integer no
   * larger than 2^32 — a single `nextU32()` draw supplies only 32 bits, so a wider
   * `max` cannot be filled (outputs stay inside [0, 2^32)). Adds
   * MODULO BIAS on top of `nextU32`'s own non-equidistribution whenever `max` does not
   * evenly divide 2^32 — low remainders are then very slightly more likely than high
   * ones. Rejection sampling alone would NOT fix this: it can only remove the bias modulo
   * bias itself introduces, not repair the underlying non-equidistribution `nextU32`
   * already has. Changing the generator and/or this mapping to reduce bias would change
   * the RNG output stream — a determinism-affecting change (`simVersion` bump) — and is
   * out of scope here. This caveat is general; it does NOT bite at the live consumer's
   * `max = 256` (`stun`'s `nextInt(256)`, `packages/sim/src/combat.ts`), where 256
   * divides 2^32 exactly and bias is zero — see ADR 0010, which measured rather than
   * argued this. A future consumer picking a non-power-of-two `max` inherits the caveat,
   * not that clearance.
   */
  nextInt(max: number): number {
    return this.nextU32() % max;
  }

  /** Integer in [min, max] inclusive via `nextInt`. Requires finite safe-integer
   *  `min`/`max` with `max >= min` and an inclusive span `max - min + 1` no larger than
   *  2^32 (same single-draw 32-bit ceiling as `nextInt`; fractional endpoints would
   *  yield non-integer results). Carries the same modulo-bias caveat as `nextInt`. */
  nextRange(min: number, max: number): number {
    return min + (this.nextU32() % (max - min + 1));
  }

  /** Snapshot PRNG state — `step()` calls this unconditionally at tick end to persist
   *  it alongside the rest of `SimState` (see the header). */
  getState(): number {
    return this.state;
  }

  /** Restore PRNG from serialized state — no production caller today; `step()` instead
   *  reconstructs via `new Rng(state.rngState)` each tick (equivalent, since the
   *  constructor's `>>> 0` coercion matches this method's). Exercised directly by
   *  `engine.test.ts`, and shaped for a future save/load or replay consumer that wants
   *  to mutate an existing instance rather than build a new one. */
  setState(state: number): void {
    this.state = state >>> 0;
  }
}
