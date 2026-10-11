// layers.test.ts — the board canvas's draw order, pinned. Since V2 (#181) static art is
// sprites and only moving/transient things are drawn live, so the order is the scene
// graph's depth order rather than the order calls were recorded in — and this is the test
// that used to be "every aura shell is drawn before any tower body", made structural. The
// visual pass split a tower into a plate and a head (so a head can turn on its own), added
// the scorch a spent mine leaves, on the floor, gave every creep a shadow, under every
// creep's body, and gave combat its own layers (C1, C2): shots between the effects and the
// creeps, a hit's flash over the bodies, and a kill's bounty pop over everything.

import { describe, it, expect } from 'vitest';
import { BOARD_LAYERS, layerDepth } from './layers';

describe('BOARD_LAYERS — the board draw order', () => {
  it('is exactly: board, scorches, shells, plates, heads, rims, pending, creepShadows, effects, shots, creeps, flashes, cues, pops', () => {
    expect(BOARD_LAYERS).toEqual([
      'board',
      'scorches',
      'shells',
      'plates',
      'heads',
      'rims',
      'pending',
      'creepShadows',
      'effects',
      'shots',
      'creeps',
      'flashes',
      'cues',
      'pops',
    ]);
  });

  it('gives each layer its index as its depth, so depths strictly increase', () => {
    BOARD_LAYERS.forEach((layer, i) => expect(layerDepth(layer)).toBe(i));
  });

  it('keeps every aura shell under every tower — plate, head and pending build (M2-S8: the shell must never stripe one)', () => {
    expect(layerDepth('shells')).toBeLessThan(layerDepth('plates'));
    expect(layerDepth('shells')).toBeLessThan(layerDepth('heads'));
    expect(layerDepth('shells')).toBeLessThan(layerDepth('pending'));
    expect(layerDepth('board')).toBeLessThan(layerDepth('shells'));
  });

  it('puts a scorch on the floor: over the board, under everything a tower or creep draws', () => {
    expect(layerDepth('board')).toBeLessThan(layerDepth('scorches'));
    for (const layer of BOARD_LAYERS.filter((l) => l !== 'board' && l !== 'scorches')) {
      expect(layerDepth('scorches'), layer).toBeLessThan(layerDepth(layer));
    }
  });

  it('draws every head over every plate, so no neighbour’s plate covers a head', () => {
    expect(layerDepth('plates')).toBeLessThan(layerDepth('heads'));
  });

  it('paints a posed head’s plate rim over every head — and under a shot’s flash and pulse (T3)', () => {
    // A turned head is resampled, and nothing it draws may darken the footprint's edge; the
    // shot's muzzle flash and ring pulse, lighter than the rim, still show over it.
    expect(layerDepth('heads')).toBeLessThan(layerDepth('rims'));
    expect(layerDepth('rims')).toBeLessThan(layerDepth('effects'));
  });

  it('draws a creep cue over EVERY creep body, so a neighbour can never hide it (the V2 reorder)', () => {
    expect(layerDepth('creeps')).toBeLessThan(layerDepth('cues'));
  });

  it('lays every creep shadow over every tower surface a flyer can cross, and under every creep body, cue and effect (B3)', () => {
    // Over the towers, a posed head's repainted rim included — a flyer's shadow falls on
    // what it crosses…
    for (const layer of ['plates', 'heads', 'rims', 'pending'] as const) {
      expect(layerDepth(layer), layer).toBeLessThan(layerDepth('creepShadows'));
    }
    // …under every body, so one creep's shadow never darkens a neighbour, and under the
    // selection cue, the shots, every creep cue and every hit's feedback, so none is dimmed
    // by one.
    for (const layer of ['effects', 'shots', 'creeps', 'flashes', 'cues', 'pops'] as const) {
      expect(layerDepth('creepShadows'), layer).toBeLessThan(layerDepth(layer));
    }
  });

  it('keeps the rest of the old recording order: pending over towers, selection and tracers under creeps', () => {
    expect(layerDepth('heads')).toBeLessThan(layerDepth('pending'));
    expect(layerDepth('pending')).toBeLessThan(layerDepth('effects'));
    expect(layerDepth('effects')).toBeLessThan(layerDepth('creeps'));
  });

  it('flies each shot over its tower’s muzzle flash and under the creeps it reaches (C2)', () => {
    // A shot leaves the flash behind it as it goes, and a creep it reaches covers it, as
    // the style frame draws its shots.
    expect(layerDepth('effects')).toBeLessThan(layerDepth('shots'));
    expect(layerDepth('shots')).toBeLessThan(layerDepth('creeps'));
  });

  it('whitens a hit creep over every body, under every creep cue (C1)', () => {
    // The flash IS its body, whitened — and a creep's HP bar and status stay readable
    // through it.
    expect(layerDepth('creeps')).toBeLessThan(layerDepth('flashes'));
    expect(layerDepth('flashes')).toBeLessThan(layerDepth('cues'));
  });

  it('draws a kill’s bounty pop over everything (C1)', () => {
    expect(BOARD_LAYERS.at(-1)).toBe('pops');
  });
});
