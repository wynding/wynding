// tower-paint.test.ts — the tower footprint-mark paint-plan (M2-S3): `basic`/`slow`
// share `palette.tower`'s colour; shape carries the distinction.

import { describe, it, expect } from 'vitest';
import { towerFootprintMarkFor } from './tower-paint';

describe('towerFootprintMarkFor — id-keyed footprint mark (total over any string)', () => {
  it('draws basic plain (no extra mark)', () => {
    expect(towerFootprintMarkFor('basic')).toBe('plain');
  });
  it('draws slow with a distinct ringed mark', () => {
    expect(towerFootprintMarkFor('slow')).toBe('ringed');
  });
  it('draws splash with a distinct crosshair mark (M2-S4a) — never reuses ringed', () => {
    // QC round-1 #11: the exact `toBe('crosshair')` above already implies
    // `not.toBe('ringed')` (`slow`'s mark, pinned above) — the extra `not.toBe`
    // comparison added no independent assertion.
    expect(towerFootprintMarkFor('splash')).toBe('crosshair');
  });
  it('draws venom with a distinct droplet mark (M2-S5a) — never reuses plain/ringed/crosshair', () => {
    expect(towerFootprintMarkFor('venom')).toBe('droplet');
  });
  it('falls back to plain for an unknown id — never throws', () => {
    expect(towerFootprintMarkFor('__proto__')).toBe('plain');
    expect(towerFootprintMarkFor('')).toBe('plain');
  });
});
