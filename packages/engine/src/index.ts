// @wynding/engine — the determinism toolkit.
//
// Byte-identity core shared by the sim and the replay validator: a seeded RNG,
// fixed-point math, a fixed-timestep loop, and deterministic hashing. No DOM,
// no Phaser, no floats in the sim path, no Math.random, no Date.

export { Rng } from './rng';
export { FP_SHIFT, FP_ONE, fpMul, fpDiv, toFixed, toFloat } from './fixed';
export {
  DEFAULT_MS_PER_TICK,
  DEFAULT_MAX_CATCHUP_TICKS,
  createFixedLoop,
  type FixedLoop,
  type FixedLoopOptions,
} from './game-loop';
export { hash32, fnv1a, hashState } from './hash';
export { canonicalJson, sha256Hex } from './canonical';
