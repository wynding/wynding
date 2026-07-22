// canonical.ts — RFC 8785 (JSON Canonicalization Scheme) serialization and a
// SHA-256 digest, for the ruleset identity hash (ADR 0007 §3, design note
// `docs/design-notes/ruleset-format.md`).
//
// This is NOT the per-tick world-hash: that stays on `fnv1a` (fast, an internal
// determinism checksum). `rulesetHash` is a content/security boundary — it buckets
// leaderboard scores and must be collision-resistant across client and server — so
// it is a cryptographic digest over a canonical byte form. Client and server MUST
// produce byte-identical output from equivalent content, which is exactly what
// canonicalization guarantees.
//
// Scope: the ruleset bundle is integer/string/boolean/null/array/object only — no
// floats (ADR 0007: no floats in sim-affecting fields). So the JCS number rule
// reduces to plain integer formatting, and we reject any non-integer/non-finite
// number loudly rather than emit a lossy or platform-dependent form.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Serialize `value` to its RFC 8785 canonical JSON string. Object keys are sorted
 * by UTF-16 code unit (JS string comparison order, which is the JCS requirement);
 * arrays keep their order; strings use JSON's minimal escaping (correct for the
 * ASCII content-identifier strings the ruleset carries). Numbers must be finite
 * integers — a float or non-finite throws, since the bundle schema admits no floats
 * and a silent lossy encoding would let two distinct rulesets collide.
 */
export function canonicalJson(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      // Reject any non-safe integer: values ≥ 2⁵³ serialize in exponent form and can
      // double-round-collide, so they must never enter the content digest.
      if (!Number.isSafeInteger(value)) {
        throw new RangeError(`canonicalJson: ${value} is not a safe integer`);
      }
      // Integer ECMAScript Number::toString — the JCS number form for integers.
      return String(value);
    case 'string':
      // JSON minimal escaping; JCS-equivalent for the BMP/ASCII strings here.
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => encode(v)).join(',')}]`;
      }
      // Only plain objects are representable — a Date/Map/class instance would encode
      // as `{}` and silently drop its content, so reject anything non-plain.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('canonicalJson: only plain objects are supported');
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined) // omitted ≡ absent (JSON drops undefined)
        .sort(); // default sort = UTF-16 code-unit order (the JCS key ordering)
      return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k])}`).join(',')}}`;
    }
    default:
      // undefined / function / symbol / bigint — not representable in the bundle.
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}

/**
 * SHA-256 of a UTF-8 string, as a 64-char lowercase hex digest. Collision-resistant
 * (unlike the 32-bit world-hash) and isomorphic — one synchronous implementation
 * (`@noble/hashes`) shared by every caller so client and server never drift.
 */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}
