import { describe, it, expect } from 'vitest';
import { canonicalJson, sha256Hex } from './canonical';

describe('canonicalJson — RFC 8785 subset', () => {
  it('sorts object keys by UTF-16 code unit, independent of insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    // Same content, different insertion order ⇒ identical canonical form.
    expect(canonicalJson({ c: 3, a: 2, b: 1 })).toBe(canonicalJson({ a: 2, b: 1, c: 3 }));
  });

  it('preserves array order and nests deterministically', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ waves: [{ n: 10, s: 20 }], id: 'field-01' })).toBe(
      '{"id":"field-01","waves":[{"n":10,"s":20}]}',
    );
  });

  it('encodes booleans, null, and integers plainly', () => {
    expect(canonicalJson({ a: true, b: false, c: null, d: 0, e: 500 })).toBe(
      '{"a":true,"b":false,"c":null,"d":0,"e":500}',
    );
  });

  it('omits undefined members (absent ≡ omitted)', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('rejects non-integer and non-finite numbers (no floats in the bundle)', () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow();
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('sha256Hex', () => {
  it('matches the NIST "abc" vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is a 64-char lowercase hex digest', () => {
    expect(sha256Hex('field-01')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});
