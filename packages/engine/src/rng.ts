// rng.ts — Mulberry32 seeded PRNG. RESERVED FOR FUTURE use: `SimState.rngState` is
// currently inert (nothing in the sim draws from an `Rng` instance — `Rng` is exercised
// only by `engine.test.ts`) but IS part of the hash-serialized world state (world-hash
// identity, not free to delete). A future consumer must carry the state through the tick
// boundary exactly as `getState()`/`setState()` below are shaped for — those are NOT an
// already-wired save path today, just the seam a future consumer will use.
//
// This API is normative for byte-identity determinism: do not rename methods,
// add a `nextFloat()`, or create module-level singleton instances. Once wired, the sim
// RNG would be reconstructed from serialized state at tick start and snapshotted at tick
// end, keeping randomness a pure function of the seed and the input log.
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
   * out of scope here; `Rng` currently has no production consumer to migrate anyway.
   */
  nextInt(max: number): number {
    return this.nextU32() % max;
  }

  /** Integer in [min, max] inclusive via `nextInt`. Requires `max >= min` and an
   *  inclusive span `max - min + 1` no larger than 2^32 (same single-draw 32-bit ceiling
   *  as `nextInt`). Carries the same modulo-bias caveat as `nextInt` (above). */
  nextRange(min: number, max: number): number {
    return min + (this.nextU32() % (max - min + 1));
  }

  /** Snapshot PRNG state — shaped for a future caller to persist alongside the world
   *  state at tick end; no current caller does this (see the header). */
  getState(): number {
    return this.state;
  }

  /** Restore PRNG from serialized state — shaped for a future save/load or replay
   *  consumer; no current caller does this (see the header). */
  setState(state: number): void {
    this.state = state >>> 0;
  }
}
