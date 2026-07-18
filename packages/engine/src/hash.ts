// hash.ts — deterministic integer/string hashing for change-detection and the
// per-tick world-hash that underpins replay verification. Pure functions, no
// imports, no RNG draw — safe to call anywhere in the sim.

/** Murmur3 32-bit finalizer over a single integer. Good avalanche, no RNG draw. */
export function hash32(x: number): number {
  let h = Math.imul(x | 0, 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** FNV-1a over a string — fast, deterministic 8-hex-char digest (not crypto). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Deterministic content-hash of any JSON-serializable state. The sim uses this
 * on the serialized world each tick; identical inputs must yield an identical
 * digest, so callers must serialize in a stable key order.
 */
export function hashState(value: unknown): string {
  return fnv1a(JSON.stringify(value));
}
