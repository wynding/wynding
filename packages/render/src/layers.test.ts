// layers.test.ts — the board canvas's draw order, pinned. Since V2 (#181) static art is
// sprites and only moving/transient things are drawn live, so the order is the scene
// graph's depth order rather than the order calls were recorded in — and this is the test
// that used to be "every aura shell is drawn before any tower body", made structural.

import { describe, it, expect } from 'vitest';
import { BOARD_LAYERS, layerDepth } from './layers';

describe('BOARD_LAYERS — the board draw order', () => {
  it('is exactly: board, shells, towers, pending, effects, creeps, cues', () => {
    expect(BOARD_LAYERS).toEqual([
      'board',
      'shells',
      'towers',
      'pending',
      'effects',
      'creeps',
      'cues',
    ]);
  });

  it('gives each layer its index as its depth, so depths strictly increase', () => {
    BOARD_LAYERS.forEach((layer, i) => expect(layerDepth(layer)).toBe(i));
  });

  it('keeps every aura shell under every tower body (M2-S8: the shell must never stripe a body)', () => {
    expect(layerDepth('shells')).toBeLessThan(layerDepth('towers'));
    expect(layerDepth('shells')).toBeLessThan(layerDepth('pending'));
    expect(layerDepth('board')).toBeLessThan(layerDepth('shells'));
  });

  it('draws a creep cue over EVERY creep body, so a neighbour can never hide it (the V2 reorder)', () => {
    expect(layerDepth('creeps')).toBeLessThan(layerDepth('cues'));
  });

  it('keeps the rest of the old recording order: pending over towers, selection and tracers under creeps', () => {
    expect(layerDepth('towers')).toBeLessThan(layerDepth('pending'));
    expect(layerDepth('pending')).toBeLessThan(layerDepth('effects'));
    expect(layerDepth('effects')).toBeLessThan(layerDepth('creeps'));
  });
});
