// game-loop.ts — fixed-timestep accumulator loop.
//
// Decouples wall-clock frame delivery from the simulation's fixed tick. The sim
// only ever advances in whole `msPerTick` steps, so behavior is independent of
// frame rate — a prerequisite for deterministic replays. A spiral-of-death
// clamp bounds catch-up work after a stall (e.g. a backgrounded tab).

/** Default simulation cadence: 20 Hz (50 ms per tick). */
export const DEFAULT_MS_PER_TICK = 50;

/** Default cap on ticks executed for a single `advance()` call. */
export const DEFAULT_MAX_CATCHUP_TICKS = 5;

export interface FixedLoopOptions {
  /** Milliseconds per simulation tick. Defaults to DEFAULT_MS_PER_TICK. */
  msPerTick?: number;
  /** Max ticks run per advance() call (spiral-of-death clamp). */
  maxCatchUpTicks?: number;
}

export interface FixedLoop {
  /** Feed elapsed wall-clock ms; runs whole ticks and returns how many fired. */
  advance(dtMs: number): number;
  /** Unconsumed time carried to the next advance() call. */
  readonly accumulatorMs: number;
  /** Reset the accumulator (e.g. on resume, to avoid a catch-up burst). */
  reset(): void;
}

export function createFixedLoop(onTick: () => void, options: FixedLoopOptions = {}): FixedLoop {
  const msPerTick = options.msPerTick ?? DEFAULT_MS_PER_TICK;
  const maxCatchUpTicks = options.maxCatchUpTicks ?? DEFAULT_MAX_CATCHUP_TICKS;
  const maxAccumulator = msPerTick * maxCatchUpTicks;

  let accumulatorMs = 0;

  return {
    advance(dtMs: number): number {
      accumulatorMs += dtMs;
      if (accumulatorMs > maxAccumulator) accumulatorMs = maxAccumulator;
      let ticks = 0;
      while (accumulatorMs >= msPerTick) {
        onTick();
        accumulatorMs -= msPerTick;
        ticks++;
      }
      return ticks;
    },
    get accumulatorMs() {
      return accumulatorMs;
    },
    reset(): void {
      accumulatorMs = 0;
    },
  };
}
