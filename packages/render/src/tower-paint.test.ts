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
  it('draws stun with a distinct bolt mark (M2-S6) — never reuses plain/ringed/crosshair/droplet', () => {
    expect(towerFootprintMarkFor('stun')).toBe('bolt');
  });
  it('draws antiair with a distinct arrow mark (M2-S7) — never reuses plain/ringed/crosshair/droplet/bolt, so it is never conflated with basic', () => {
    expect(towerFootprintMarkFor('antiair')).toBe('arrow');
  });
  it('draws beacon with a distinct pylon mark (M2-S8) — never reuses any prior mark', () => {
    expect(towerFootprintMarkFor('beacon')).toBe('pylon');
  });
  it('assigns every shipped tower a DISTINCT mark — no two towers ever share one', () => {
    // The per-story `not.toBe` chains above only ever compare against the marks that
    // existed at the time; this asserts the invariant itself, so a future story that
    // reuses an existing mark fails here rather than in a reader's eye.
    const ids = ['basic', 'slow', 'splash', 'venom', 'stun', 'antiair', 'beacon'];
    const marks = ids.map(towerFootprintMarkFor);
    expect(new Set(marks).size).toBe(ids.length);
  });
  it('falls back to plain for an unknown id — never throws', () => {
    expect(towerFootprintMarkFor('__proto__')).toBe('plain');
    expect(towerFootprintMarkFor('')).toBe('plain');
  });
});
