// palette.ts — the drawing colours the Phaser scene uses, one set per colourblind
// mode (GAG §2 / ADR 0003). Pure data + a resolver, so it is unit-tested and the scene
// stays a dumb consumer. Every semantic role also has a distinct SHAPE cue in the scene
// (creep = polygon, tower = rounded square, valid ghost = solid outline, invalid = dashed
// cross); colour is a redundant channel, never the sole carrier of meaning. Palettes are
// drawn from Okabe–Ito and Paul Tol colourblind-safe sets and hold the WCAG 1.4.11
// non-text bar (≥ 3:1) against the dark board floor for every opaque-drawn cue, most
// pairs well above; enforced permanently by `palette.test.ts`. `border` is a deliberate
// quiet structural fill excluded from the gate (identity carried by geometry); `spark` is
// exempt (transient fading FX, non-essential — see `palette.test.ts`).

import type { ColourMode } from './types';

/** The concrete colours (0xRRGGBB) the scene draws with for one colour mode. */
export interface Palette {
  /** Board floor fill and the blocked-border fill. */
  readonly floor: number;
  readonly border: number;
  /** Lane entrance / exit glyph tints. */
  readonly entrance: number;
  readonly exit: number;
  /** Creep silhouette + its health pip. */
  readonly creep: number;
  readonly creepLowHp: number;
  /** Tower footprint fill and its range ring stroke. */
  readonly tower: number;
  readonly range: number;
  /** Build-ghost valid / invalid cues (paired with distinct shapes in the scene). */
  readonly ghostValid: number;
  readonly ghostInvalid: number;
  /** Impact-spark FX colour. */
  readonly spark: number;
}

// Base palette: high-contrast, colourblind-safe hues (Okabe–Ito). Valid/invalid also
// differ by shape in the scene, so these survive monochrome vision entirely.
const DEFAULT: Palette = {
  floor: 0x1b1f2a,
  border: 0x3a4358,
  entrance: 0x56b4e9, // sky blue
  exit: 0xe69f00, // orange
  creep: 0xf0e442, // yellow
  creepLowHp: 0xd55e00, // vermillion (low-HP tint; pip length also shrinks)
  tower: 0x009e73, // bluish green
  range: 0xcc79a7, // reddish purple
  ghostValid: 0x009e73,
  ghostInvalid: 0xd55e00,
  spark: 0xffffff,
};

// Deutan/protan (red–green) shift the green/red pair toward blue/orange separation.
// Only the keys that actually differ from DEFAULT are overridden.
const PROTAN_DEUTAN: Palette = {
  ...DEFAULT,
  creepLowHp: 0xe69f00,
  tower: 0x0072b2, // blue (avoids the red–green axis)
  ghostValid: 0x0072b2,
  ghostInvalid: 0xe69f00,
};

// Tritan (blue–yellow) shifts off the blue/yellow axis toward red/green/magenta.
// Only the keys that actually differ from DEFAULT are overridden.
const TRITAN: Palette = {
  ...DEFAULT,
  entrance: 0x009e73,
  exit: 0xd55e00,
  creep: 0xcc79a7, // magenta
  range: 0x56b4e9,
};

const PALETTES: Record<ColourMode, Palette> = {
  default: DEFAULT,
  protan: PROTAN_DEUTAN,
  deutan: PROTAN_DEUTAN,
  tritan: TRITAN,
};

/** The selectable colour-vision modes, in display order — the single source of truth the
 *  settings store and the settings UI both consume. Derived from PALETTES (a
 *  `Record<ColourMode, Palette>`, already exhaustive), so a new mode added to the union +
 *  palettes is automatically listed here, with no separate list to keep in sync. */
export const COLOUR_MODES = Object.keys(PALETTES) as ColourMode[];

/** The palette for a colour mode (falls back to the base palette for an unknown mode). */
export function resolvePalette(mode: ColourMode): Palette {
  return PALETTES[mode] ?? DEFAULT;
}
