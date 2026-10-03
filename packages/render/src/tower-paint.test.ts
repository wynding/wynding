// tower-paint.test.ts — what a tower looks like, keyed on its id: the footprint mark (M2-S3;
// since the visual pass, which head silhouette and glyph it draws) and the role (T2, #181:
// which colour that head wears). Shape carries the distinction; the role colour is the
// second channel.

import { describe, it, expect } from 'vitest';
import { getBundledRuleset } from '@wynding/content';
import {
  TOWER_LOOKS,
  TOWER_ROLES,
  towerFootprintMarkFor,
  towerLookFor,
  towerLookKey,
  towerRoleFor,
} from './tower-paint';

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
  it('draws mine with a distinct charge mark (M2-S9) — never reuses any prior mark', () => {
    expect(towerFootprintMarkFor('mine')).toBe('charge');
  });
  it('draws frost-splash with a distinct ringed-crosshair mark (M2-S10) — never reuses any prior mark', () => {
    expect(towerFootprintMarkFor('frost-splash')).toBe('ringed-crosshair');
  });
  it('assigns every shipped tower a DISTINCT mark — no two towers ever share one', () => {
    // The per-story `not.toBe` chains above only ever compare against the marks that
    // existed at the time; this asserts the invariant itself, so a future story that
    // reuses an existing mark fails here rather than in a reader's eye. Read straight
    // off the bundled catalog (not a hand-listed literal) so a future catalog addition
    // is automatically covered.
    const ids = getBundledRuleset().towerCatalog.map((t) => t.id);
    const marks = ids.map(towerFootprintMarkFor);
    expect(new Set(marks).size).toBe(ids.length);
  });
  it('falls back to plain for an unknown id — never throws', () => {
    expect(towerFootprintMarkFor('__proto__')).toBe('plain');
    expect(towerFootprintMarkFor('')).toBe('plain');
  });
});

describe('towerRoleFor — id-keyed role (total over any string, T2 #181)', () => {
  it('pins every shipped tower to its role', () => {
    expect(
      Object.fromEntries(
        [
          'basic',
          'slow',
          'splash',
          'venom',
          'stun',
          'antiair',
          'beacon',
          'mine',
          'frost-splash',
        ].map((id) => [id, towerRoleFor(id)]),
      ),
    ).toEqual({
      basic: 'damage',
      slow: 'control',
      splash: 'damage',
      venom: 'poison',
      stun: 'control',
      antiair: 'air',
      beacon: 'support',
      mine: 'burst',
      'frost-splash': 'control',
    });
  });

  it('covers every catalog tower, and every role is some tower’s', () => {
    // Read off the bundled catalog, so a new tower without a role falls back loudly here
    // rather than silently wearing `basic`'s colour.
    const ids = getBundledRuleset().towerCatalog.map((t) => t.id);
    const known = new Set([
      'basic',
      'slow',
      'splash',
      'venom',
      'stun',
      'antiair',
      'beacon',
      'mine',
      'frost-splash',
    ]);
    for (const id of ids) expect(known.has(id), id).toBe(true);
    expect(new Set(ids.map(towerRoleFor))).toEqual(new Set(TOWER_ROLES));
  });

  it('falls back like the mark does — an unknown id is `basic` on both axes', () => {
    for (const id of ['__proto__', 'constructor', '', 'no-such-tower']) {
      expect(towerRoleFor(id)).toBe(towerRoleFor('basic'));
      expect(towerLookFor(id)).toEqual(towerLookFor('basic'));
    }
  });
});

describe('TOWER_LOOKS — every look placement can ask for', () => {
  it('is one look per shipped tower, each distinct, and nothing else', () => {
    const ids = getBundledRuleset().towerCatalog.map((t) => t.id);
    expect(TOWER_LOOKS).toHaveLength(ids.length);
    expect(new Set(TOWER_LOOKS.map(towerLookKey)).size).toBe(ids.length);
  });

  it('contains the look of any id at all — known, unknown or hostile', () => {
    const keys = new Set(TOWER_LOOKS.map(towerLookKey));
    const ids = [...getBundledRuleset().towerCatalog.map((t) => t.id), '', '__proto__', 'x-9'];
    for (const id of ids) expect(keys.has(towerLookKey(towerLookFor(id))), id).toBe(true);
  });

  it('names a look by its mark and role', () => {
    expect(towerLookKey(towerLookFor('frost-splash'))).toBe('ringed-crosshair:control');
    expect(towerLookKey(towerLookFor('mine'))).toBe('charge:burst');
  });
});
