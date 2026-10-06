// layers.test.ts — the board canvas's draw order, pinned. Since V2 (#181) static art is
// sprites and only moving/transient things are drawn live, so the order is the scene
// graph's depth order rather than the order calls were recorded in — and this is the test
// that used to be "every aura shell is drawn before any tower body", made structural. The
// visual pass split a tower into a plate and a head (so a head can turn on its own) and
// added the scorch a spent mine leaves, on the floor.

import { describe, it, expect } from 'vitest';
import { BOARD_LAYERS, layerDepth } from './layers';

describe('BOARD_LAYERS — the board draw order', () => {
  it('is exactly: board, scorches, shells, plates, heads, pending, effects, creeps, cues', () => {
    expect(BOARD_LAYERS).toEqual([
      'board',
      'scorches',
      'shells',
      'plates',
      'heads',
      'pending',
      'effects',
      'creeps',
      'cues',
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

  it('draws a creep cue over EVERY creep body, so a neighbour can never hide it (the V2 reorder)', () => {
    expect(layerDepth('creeps')).toBeLessThan(layerDepth('cues'));
  });

  it('keeps the rest of the old recording order: pending over towers, selection and tracers under creeps', () => {
    expect(layerDepth('heads')).toBeLessThan(layerDepth('pending'));
    expect(layerDepth('pending')).toBeLessThan(layerDepth('effects'));
    expect(layerDepth('effects')).toBeLessThan(layerDepth('creeps'));
  });
});
