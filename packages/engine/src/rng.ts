// rng.ts — Mulberry32 seeded PRNG, the deterministic randomness source for the sim.
//
// This API is normative for byte-identity determinism: do not rename methods,
// add a `nextFloat()`, or create module-level singleton instances. The sim RNG
// is reconstructed from serialized state at tick start and snapshotted at tick
// end, keeping randomness a pure function of the seed and the input log.
//
// Cosmetic (render-only) randomness must use a SEPARATE generator — never draw
// from this one, or replays diverge.

export class Rng {
  private state: number; // internal uint32

  constructor(seed: number) {
    this.state = seed >>> 0; // coerce to uint32
  }

  /** Uniform integer in [0, 0xFFFFFFFF]. Advances state one step. */
  nextU32(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform integer in [0, max). `max` must be a positive integer. */
  nextInt(max: number): number {
    return this.nextU32() % max;
  }

  /** Uniform integer in [min, max] inclusive. Requires `max >= min`. */
  nextRange(min: number, max: number): number {
    return min + (this.nextU32() % (max - min + 1));
  }

  /** Snapshot PRNG state (persist alongside the world state at tick end). */
  getState(): number {
    return this.state;
  }

  /** Restore PRNG from serialized state (save/load, replay). */
  setState(state: number): void {
    this.state = state >>> 0;
  }
}
