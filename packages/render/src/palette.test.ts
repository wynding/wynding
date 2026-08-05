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

// The eleven cues the scene draws OPAQUE against the floor (source colour, no compositing) —
// `slowed`'s essential ring is drawn at alpha 1 (the pulse, alpha 0.4, is the non-essential
// motion cue), so gating it as opaque is exact, not an approximation. `poisoned` (M2-S5a)
// is the same essential-cue category: its three guaranteed pips are also alpha 1 (the
// drift cue, alpha ≤ 0.5, is the non-essential motion cue) — PLAN.md step 32.
const OPAQUE_CUES: ReadonlyArray<keyof Palette> = [
  'entrance',
  'exit',
  'creep',
  'creepLowHp',
  'tower',
  'ghostValid',
  'ghostInvalid',
  'slowed',
  'poisoned',
  'stunned',
  'warded',
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

// `poisoned`'s pips are drawn OVER the scene's other cues (a poisoned creep can be
// pathing across a tower footprint, sitting under the ghost-valid outline, etc.) — a
// value byte-identical to one of them makes the pip vanish into the body it's drawn on,
// exactly the defect the first `poisoned` draft had (`0x009e73`, identical to
// `tower`/`ghostValid` — see `palette.ts`'s own comment). Scoped deliberately to the
// cues a pip is actually drawn OVER: `tower`, `ghostValid`, `creep`, `creepLowHp`,
// `floor`. NOT `range` (a thin selection ring, never a filled body under a creep) and
// NOT `slowed` (that pair already shares a value with `entrance`, pre-existing and out
// of scope here — do not widen this gate to something not yet fixed).
const POISONED_MUST_DIFFER_FROM: ReadonlyArray<keyof Palette> = [
  'tower',
  'ghostValid',
  'creep',
  'creepLowHp',
  'floor',
];

// `stunned` is gated against `creep` as well as the floor, and the history is worth keeping
// because it is why the GEOMETRY is what it is.
//
// The guaranteed `jolt` ring was first drawn INSIDE the silhouette at r×0.55, which made its
// contrast partner the creep fill rather than the board floor. That fill takes two values:
// `creep`, and `creepLowHp` below `hpFrac` 0.34 (`board-draw.ts`'s `hpColour`) — and no
// colour clears both plus the floor. WCAG contrast is a pure function of relative luminance,
// so clearing ≥3:1 against the floor (L≈0.014) forces L ≥ 0.141 and clearing `creep` forces
// L ≤ 0.215, while `creepLowHp` demands L ≤ 0.041 or L ≥ 0.766. Those ranges are disjoint; an
// exhaustive scan confirms NO colour satisfies all three in the DEFAULT or PROTAN/DEUTAN
// tables. A luminance sandwich, not a bad swatch — so a stunned creep near death carried no
// perceivable cue at all, in either channel, since the flicker draws inside too.
//
// SCOPE, corrected: this does NOT hold in tritan, whose `creep` is a dark magenta rather
// than yellow. There the band is open — ~210 of 10,001 sampled luminances qualify, and the
// shipped `0xfffff5` is one of them, clearing `creepLowHp` at 3.84. An earlier draft
// claimed the sandwich for all three tables on the strength of a scan that had been handed
// protan/deutan's `creepLowHp` for tritan. The geometry move is driven by the two tables
// where the sandwich is real; tritan inherits it so there is ONE cue layout rather than a
// per-mode one.
//
// The fix was geometric: the jolt now draws OUTSIDE the silhouette at r×1.15, partnered
// against the floor at 3.87:1, exactly like the slow ring (r×1.4) and the DoT pips (r×1.8).
// An essential cue must not depend on the health of the thing it is drawn on. The gate below
// stays as belt-and-braces for the `flicker`, which is still inside but is the non-essential
// motion cue. `warded`'s ring is drawn over `tower` at 2.37:1 in the default and tritan
// tables (protan/deutan clears it at 3.59, since that mode's `tower` is a darker blue) —
// gated by byte-distinctness instead, the same posture `poisoned`'s pips carry. The ward
// ring is opaque and drawn well outside the silhouette at r×2.2, but a tower footprint
// under it is the same kind of "cue drawn over a body this gate doesn't reach" as this
// one.
const STUNNED_MUST_CONTRAST: ReadonlyArray<keyof Palette> = ['creep'];

describe('stunned — the jolt ring vs the creep fill it is drawn over (M2-S6)', () => {
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": stunned clears ${MIN_CUE_CONTRAST}:1 against creep`, () => {
      const pal = resolvePalette(mode);
      for (const key of STUNNED_MUST_CONTRAST) {
        expect(contrast(pal.stunned, pal[key])).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);
      }
    });
  }
});

describe('poisoned — pairwise distinctness from every cue a pip can be drawn over (M2-S5a)', () => {
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": poisoned differs from tower/ghostValid/creep/creepLowHp/floor`, () => {
      const pal = resolvePalette(mode);
      for (const key of POISONED_MUST_DIFFER_FROM) {
        expect(pal.poisoned).not.toBe(pal[key]);
      }
    });
  }
});

// PAIRWISE DISTINCTNESS, not just contrast — the lesson `poisoned` already paid for above:
// `poisoned` once shipped byte-identical to `tower`/`ghostValid` and its pips vanished into
// the body they were drawn over, even though nothing checked CONTRAST failed (byte-identical
// colours are maximally "in contrast" with themselves — a contrast gate cannot catch this
// class of bug at all, only a distinctness gate can). `stunned` and `warded` shipped in this
// same story with only a contrast gate (`STUNNED_MUST_CONTRAST` above) and no distinctness
// gate — which is exactly how the tritan `stunned === spark` collision (both `0xffffff`)
// passed green: a cue can clear ≥3:1 against its own reflection. Scoped to the cues each is
// actually drawn over or beside: the flicker ring draws inside the silhouette and the jolt
// just outside it at r×1.15, over the same backgrounds a creep can path across (`spark`,
// `creep`, `creepLowHp`) and can appear on a build over a tower footprint or floor (`tower`,
// `floor`); the ward ring draws outside the silhouette at r×2.2, over the same set of
// backgrounds a creep can path across. Each is also checked against the OTHER new cue, since a
// `resolute` under stun and a warded creep are both reachable states.
const STUNNED_MUST_DIFFER_FROM: ReadonlyArray<keyof Palette> = [
  'spark',
  'creep',
  'creepLowHp',
  'tower',
  'floor',
  'warded',
];

const WARDED_MUST_DIFFER_FROM: ReadonlyArray<keyof Palette> = [
  'spark',
  'creep',
  'creepLowHp',
  'tower',
  'floor',
  'stunned',
];

describe('stunned — pairwise distinctness from every cue it can be drawn over or beside (M2-S6)', () => {
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": stunned differs from spark/creep/creepLowHp/tower/floor/warded`, () => {
      const pal = resolvePalette(mode);
      for (const key of STUNNED_MUST_DIFFER_FROM) {
        expect(pal.stunned).not.toBe(pal[key]);
      }
    });
  }
});

describe('warded — pairwise distinctness from every cue it can be drawn over or beside (M2-S6)', () => {
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": warded differs from spark/creep/creepLowHp/tower/floor/stunned`, () => {
      const pal = resolvePalette(mode);
      for (const key of WARDED_MUST_DIFFER_FROM) {
        expect(pal.warded).not.toBe(pal[key]);
      }
    });
  }
});
