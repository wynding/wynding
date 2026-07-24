// palette.test.ts — the permanent contrast gate (ADR 0003 §2 colourblind conformance).
// WCAG relative luminance / contrast ratio computed locally (no dependency on the scene
// or DOM); every cue the scene draws OPAQUE is gated at source colour, and `range` (the
// only cue ever drawn at partial alpha for essential information — the ghost-preview
// stroke, `scene.ts:174`; the selected-tower stroke at 0.9, `scene.ts:142`, is strictly
// stronger and so not the binding case) is gated at its weakest composited alpha. `spark`
// is exempt (transient fading FX, alpha → 0 by design, non-essential — the kill outcome
// is carried by the creep/HP-pip state, and it is reduced-motion governed). `border` is
// excluded (a quiet structural fill — now an actually-drawn blocked-border ring with a
// real consumer, `board-cells.ts`'s `boardPaintOps`/`scene.ts`'s `drawBoard` — whose
// identity is carried by geometry, not colour). Gate scope: contrast is certified AGAINST
// THE UNOBSCURED BOARD FLOOR, the defined baseline; where cues overlap other visuals in
// play, the dual SHAPE encoding (ADR 0003) is the fallback channel.

import { describe, it, expect } from 'vitest';
import { COLOUR_MODES, resolvePalette } from './palette';
import type { Palette } from './palette';

function channels(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function relativeLuminance(hex: number): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** sRGB alpha compositing of `fg` over `bg` at alpha `a`, per-channel round-half-up. */
function compositeOver(fg: number, bg: number, a: number): number {
  const [fr, fgc, fb] = channels(fg);
  const [br, bg2, bb] = channels(bg);
  const mix = (f: number, b: number): number => Math.round(a * f + (1 - a) * b);
  return (mix(fr, br) << 16) | (mix(fgc, bg2) << 8) | mix(fb, bb);
}

// The seven cues the scene draws OPAQUE against the floor (source colour, no compositing).
const OPAQUE_CUES: ReadonlyArray<keyof Palette> = [
  'entrance',
  'exit',
  'creep',
  'creepLowHp',
  'tower',
  'ghostValid',
  'ghostInvalid',
];

// `range`'s weakest essential draw: the ghost-preview stroke at alpha 0.7 (scene.ts:174).
// The selected-tower stroke at 0.9 (scene.ts:142) is strictly stronger, so 0.7 is binding.
// A future alpha change at either draw site should update this constant.
const RANGE_GHOST_PREVIEW_ALPHA = 0.7;

const MIN_CUE_CONTRAST = 3.0;

describe('contrast gate — canvas cues vs the board floor (WCAG 1.4.11 non-text, ≥ 3:1)', () => {
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": every opaque cue + composited range clears ${MIN_CUE_CONTRAST}:1, ghostValid/ghostInvalid stay distinct`, () => {
      const pal = resolvePalette(mode);
      const minima: Record<string, number> = {};

      for (const key of OPAQUE_CUES) {
        const ratio = contrast(pal[key], pal.floor);
        minima[key] = ratio;
        expect(ratio).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);
      }

      const rangeComposited = compositeOver(pal.range, pal.floor, RANGE_GHOST_PREVIEW_ALPHA);
      const rangeRatio = contrast(rangeComposited, pal.floor);
      minima['range@0.7'] = rangeRatio;
      expect(rangeRatio).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);

      // Distinctness: the valid/invalid dual encoding keeps a distinct colour channel in
      // every mode (shape also differs in the scene — this is the redundant colour cue).
      expect(pal.ghostValid).not.toBe(pal.ghostInvalid);

      // `spark` is EXEMPT: transient fading FX (alpha → 0 by design), non-essential
      // (kill outcome carried by creep/HP-pip state), reduced-motion governed — no gate.
      // `border` is EXCLUDED: a deliberate quiet structural fill, identity carried by
      // geometry (the outer ring) — not gated.

      // Always print the per-mode minimum table — dated audit evidence re-derivable by
      // running this test, without a brittle assert-the-exact-number gate.
      const overallMin = Math.min(...Object.values(minima));
      console.info(
        `[palette.test] mode=${mode} min=${overallMin.toFixed(2)} ` +
          Object.entries(minima)
            .map(([k, v]) => `${k}=${v.toFixed(2)}`)
            .join(' '),
      );
    });
  }
});
