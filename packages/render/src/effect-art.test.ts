// effect-art.test.ts — the art of shots and combat feedback (visual pass C1/C2, #181): the
// design unit and its floor, the colour every effect token resolves to in every colour-vision
// mode, each tower's shot look, a creep's hit-flash silhouette, and the bounty pop's numerals and
// gem — each drawn inside its own box, and the gem the HUD's own.

import { describe, it, expect } from 'vitest';
import { artBounds } from './art-geometry';
import { ART_GEM, ART_GLYPH, ART_HIT_FLASH, ART_INK } from './art-ink';
import type { ArtShape } from './art-ir';
import { CREEP_BODY } from './creep-art';
import { CREEP_SHAPE_VALUES } from './creep-paint';
import {
  effectArtColour,
  fxUnit,
  FX_CELL,
  FX_MIN_UNIT_PX,
  GEM_ART,
  GEM_HALF_W,
  GLYPH_ADVANCE,
  GLYPH_BOX,
  GLYPH_BOX_CELLS,
  GLYPH_CHARS,
  GLYPH_MIN_PX,
  glyphArt,
  glyphUnit,
  hitFlashArt,
  HIT_FLASH_SCALE,
  mixColour,
  scaledSilhouette,
  SHOT_CORE_MIX,
  shotLookFor,
  SHOT_LOOKS_BAKED,
} from './effect-art';
import { COLOUR_MODES, resolvePalette, roleColour } from './palette';
import { ART_SHADOW } from './tower-art';
import { TOWER_ROLES } from './tower-paint';

describe('fxUnit — shots and feedback in the style frame’s pixels', () => {
  it('is one at the frame’s cell, scales with the board’s, and stops shrinking at its floor', () => {
    expect(fxUnit(FX_CELL)).toBe(1);
    expect(fxUnit(2 * FX_CELL)).toBe(2);
    expect(fxUnit(10)).toBe(FX_MIN_UNIT_PX);
    expect(fxUnit(FX_CELL * FX_MIN_UNIT_PX)).toBe(FX_MIN_UNIT_PX);
  });
});

describe('effectArtColour — every token effect art paints with', () => {
  it('draws a shot in its tower’s role colour, its core mixed toward white, in every colour-vision mode', () => {
    expect(COLOUR_MODES.length).toBeGreaterThan(1);
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      for (const role of TOWER_ROLES) {
        expect(effectArtColour('role', pal, role), `${mode} ${role}`).toBe(roleColour(pal, role));
        expect(effectArtColour('core', pal, role), `${mode} ${role}`).toBe(
          mixColour(roleColour(pal, role), 0xffffff, SHOT_CORE_MIX),
        );
      }
    }
  });

  it('draws the fixed inks as themselves, whatever the mode', () => {
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      expect(effectArtColour('ink', pal, 'damage')).toBe(ART_INK);
      expect(effectArtColour('shadow', pal, 'damage')).toBe(ART_SHADOW);
      expect(effectArtColour('flash', pal, 'damage')).toBe(ART_HIT_FLASH);
      expect(effectArtColour('glyph', pal, 'damage')).toBe(ART_GLYPH);
      expect(effectArtColour('gem', pal, 'damage')).toBe(ART_GEM);
    }
  });

  it('refuses a token effect art does not paint with, rather than drawing it in some colour', () => {
    expect(() => effectArtColour('plate', resolvePalette('default'), 'damage')).toThrow(
      /no 'plate'/,
    );
  });

  it('mixColour: channel by channel, from one colour to the other', () => {
    expect(mixColour(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(mixColour(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(mixColour(0x204060, 0xffffff, 0.5)).toBe(0x90a0b0);
    expect(mixColour(0xff0000, 0x0000ff, 0.5)).toBe(0x800080);
  });
});

describe('shotLookFor — each tower’s shot', () => {
  it('draws a shot in its tower’s role, and keeps each id’s look', () => {
    expect(shotLookFor('stun')).toEqual({ style: 'arc', role: 'control' });
    expect(shotLookFor('antiair')).toEqual({ style: 'streak', role: 'air' });
    expect(shotLookFor('venom')).toEqual({ style: 'glob', role: 'poison' });
    expect(shotLookFor('venom')).toBe(shotLookFor('venom'));
    // An unknown tower, or one not known at all: the dot, in Basic's role — the dot's colour is
    // the palette's own tracer colour, whatever its role.
    expect(shotLookFor('no-such-tower').style).toBe('dot');
    expect(shotLookFor(undefined)).toBe(shotLookFor(''));
    expect(shotLookFor('toString').style).toBe('dot');
  });

  it('bakes one look per style and role a known tower fires — each once, the stun arc among them', () => {
    expect(SHOT_LOOKS_BAKED.map((l) => `${l.style}:${l.role}`)).toEqual([
      'bolt:damage',
      'lob:damage',
      'lob:control',
      'glob:poison',
      'arc:control',
      'shard:control',
      'streak:air',
    ]);
  });
});

describe('hitFlashArt — a creep’s body, whitened', () => {
  it('is each shape’s body silhouette, scaled just past its outline, filled white, with no outline', () => {
    expect([...CREEP_SHAPE_VALUES].length).toBeGreaterThan(0);
    for (const shape of CREEP_SHAPE_VALUES) {
      const [flash, ...rest] = hitFlashArt(shape);
      expect(rest, shape).toEqual([]);
      expect(flash!.fill, shape).toBe('flash');
      expect(flash!.stroke, shape).toBeUndefined();
      const body = artBounds([{ ...CREEP_BODY[shape], stroke: undefined } as ArtShape], 1);
      const lit = artBounds([flash!], 1);
      for (const k of ['minX', 'minY', 'maxX', 'maxY'] as const) {
        expect(lit[k], `${shape} ${k}`).toBeCloseTo(body[k] * HIT_FLASH_SCALE, 9);
      }
    }
    expect(hitFlashArt('square')).toBe(hitFlashArt('square')); // built once
  });

  it('scaledSilhouette refuses a body that is neither a polygon nor a rect', () => {
    expect(() =>
      scaledSilhouette({ kind: 'circle', cx: 0, cy: 0, r: 4, fill: 'family' }, 1.02),
    ).toThrow(/polygon or a rect/);
  });
});

describe('the bounty pop’s numerals and gem', () => {
  it('draws a plus and the ten digits, each inside its box', () => {
    expect(GLYPH_CHARS).toEqual(['+', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    for (const c of GLYPH_CHARS) {
      // The white stroke's path, unstroked: inside the box, so the advance never overlaps two.
      const [, core] = glyphArt(c);
      const b = artBounds([{ ...core!, width: 0 } as ArtShape], 1);
      expect(b.minX, c).toBeGreaterThanOrEqual(0);
      expect(b.minY, c).toBeGreaterThanOrEqual(0);
      expect(b.maxX, c).toBeLessThanOrEqual(GLYPH_BOX.w);
      expect(b.maxY, c).toBeLessThanOrEqual(GLYPH_BOX.h);
    }
    expect(GLYPH_ADVANCE).toBeGreaterThan(GLYPH_BOX.w);
  });

  it('edges each numeral in ink under its white stroke, both round, along one path', () => {
    for (const c of GLYPH_CHARS) {
      const [edge, core] = glyphArt(c);
      expect(edge).toMatchObject({ kind: 'path', stroke: 'ink', cap: 'round', join: 'round' });
      expect(core).toMatchObject({ kind: 'path', stroke: 'glyph', cap: 'round', join: 'round' });
      if (edge!.kind !== 'path' || core!.kind !== 'path') throw new Error('paths');
      expect(edge!.d).toBe(core!.d);
      expect(edge!.width).toBeGreaterThan(core!.width!);
    }
  });

  it('sizes the numerals to a third of a cell, and keeps them readable at a phone’s', () => {
    expect(glyphUnit(30) * GLYPH_BOX.h).toBeCloseTo(30 * GLYPH_BOX_CELLS, 9);
    expect(glyphUnit(10) * GLYPH_BOX.h).toBeCloseTo(GLYPH_MIN_PX, 9);
  });

  it('draws the HUD’s bounty gem: its half-width is the art’s', () => {
    const b = artBounds(
      GEM_ART.map((s) => ({ ...s, width: 0 }) as ArtShape),
      1,
    );
    expect(b.maxX).toBe(GEM_HALF_W);
    expect(b.minX).toBe(-GEM_HALF_W);
    expect(GEM_ART[0]).toMatchObject({ fill: 'gem', stroke: 'ink' });
  });
});
