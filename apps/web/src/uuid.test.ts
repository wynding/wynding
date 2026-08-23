import { describe, expect, it } from 'vitest';
import { ambientCrypto, mintUuid } from './uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('mintUuid', () => {
  it('uses the host crypto when it has randomUUID', () => {
    expect(mintUuid({ randomUUID: () => 'from-host' })).toBe('from-host');
  });

  it('falls back to a correctly-shaped v4 without one (non-secure context, old WebView)', () => {
    for (const source of [null, undefined, {}]) {
      expect(mintUuid(source)).toMatch(V4);
    }
  });

  it('mints distinct ids', () => {
    expect(mintUuid(null)).not.toBe(mintUuid(null));
  });
});

describe('ambientCrypto', () => {
  it('returns the host crypto, or null where there is none', () => {
    const crypto = { randomUUID: () => 'x' };
    expect(ambientCrypto({ crypto } as unknown as Window)).toBe(crypto);
    expect(ambientCrypto({} as unknown as Window)).toBeNull();
    expect(ambientCrypto(null)).toBeNull();
    expect(ambientCrypto(undefined)).toBeNull();
  });
});
