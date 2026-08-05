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
  /** Slow-status telegraph cue (M2-S3) — the redundant colour channel behind the
   *  shape/ring the telegraph ALWAYS draws (`creep-paint.ts`); gated ≥ 3:1 like every
   *  other opaque cue (`palette.test.ts`). */
  readonly slowed: number;
  /** DoT ("poisoned") telegraph cue (M2-S5a) — the redundant colour channel behind the
   *  three-pip shape cue the telegraph ALWAYS draws (`creep-paint.ts`); an essential cue
   *  (PLAN.md step 32, same posture as `slowed`), gated ≥ 3:1 like every other opaque
   *  cue (`palette.test.ts`). */
  readonly poisoned: number;
  /** Stun telegraph cue (M2-S6) — the redundant colour channel behind the `'jolt'`
   *  shape cue the telegraph ALWAYS draws (`creep-paint.ts`); an essential cue, gated
   *  ≥ 3:1 like every other opaque cue (`palette.test.ts`). The jolt ring draws OUTSIDE
   *  the silhouette (r×1.15), so its contrast partner is the board FLOOR, like the slow
   *  ring and the DoT pips. The additional gate against `creep` is belt-and-braces for
   *  the `flicker`, which does still draw inside at r×0.85. */
  readonly stunned: number;
  /** Ward cue (M2-S6) — the redundant colour channel behind the always-on outer ring
   *  `wardPaintOps` draws for a creep whose catalog definition carries an immunity. Not
   *  a timed status (see CONTEXT.md's Ward term), so gated ≥ 3:1 like every other
   *  opaque cue (`palette.test.ts`) with no motion-cue caveat. */
  readonly warded: number;
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
  slowed: 0x56b4e9, // sky blue — the slow telegraph's redundant colour channel
  // Reddish purple (Okabe-Ito) — the DoT telegraph's redundant colour channel. NOT
  // bluish green, which the first draft used (QC round 1): that is byte-identical to
  // `tower`/`ghostValid`, and since creeps path straight along tower footprints the
  // pips sat on a body of exactly their own colour and vanished. The pairwise gate in
  // `palette.test.ts` now pins this against every cue a pip can be drawn over. Sharing
  // a value with `range` is deliberate and safe — that is a thin selection ring drawn
  // only while a tower is selected, never a filled body under a creep.
  poisoned: 0xcc79a7,
  // Electric violet (M2-S6) — distinct from every other cue in this table and clears the
  // ≥3:1 floor gate at 3.87. The floor is the right partner: the GUARANTEED `jolt` ring
  // draws OUTSIDE the silhouette (r×1.15), like the slow ring and the DoT pips. An earlier
  // draft drew it inside at r×0.55, which made the creep fill the partner and left the cue
  // at 1.10 against `creepLowHp` — unfixable by any colour IN THIS TABLE AND IN
  // PROTAN/DEUTAN (a luminance sandwich; see `STUNNED_MUST_CONTRAST` in palette.test.ts),
  // so the geometry moved instead. Tritan escapes the sandwich (its `creep` is dark) but
  // takes the same geometry — one cue layout, not a per-mode one.
  stunned: 0x8a5cf6,
  // Warm gold (M2-S6) — reads as "protected". Gated against the floor and by pairwise
  // distinctness (`palette.test.ts`), not by contrast against the creep fill: the ward
  // ring draws OUTSIDE the silhouette at r×2.2 and so is never over the creep body.
  // It IS drawn over `tower` at 2.37:1 when a warded creep paths across a footprint (the
  // ring spans ~1.54 cells). That is the same posture every sibling cue already has —
  // `poisoned`'s pips at r×1.8 overlap footprints too, and are gated against `tower` by
  // byte-DISTINCTNESS, not contrast — so it is consistent rather than a new hole, but the
  // cue-radius layout as a whole is owed a pass.
  warded: 0xffd23f,
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
  // Yellow here, not DEFAULT's reddish purple: this mode gives `creep` the magenta
  // 0xcc79a7, and a telegraph byte-identical to a creep body would be no cue at all.
  // What this buys, stated precisely (QC round 2 measured it): yellow separates well
  // from the BACKGROUNDS a pip is actually drawn over — this mode's bluish-green
  // `tower` and the dark `floor` — which is the collision that made the first draft
  // unusable. It does NOT separate strongly from this mode's magenta `creep` under
  // simulated tritanopia; the pips sit outside the silhouette at r*1.8 so they are not
  // drawn ON it, and the always-on SHAPE cue carries the state regardless, colour being
  // the redundant channel per the Telegraph glossary. The gate below is byte-equality,
  // so it cannot see perceptual distance — a real CVD-distance gate is worth having and
  // is not in this story.
  poisoned: 0xf0e442,
  // DEFAULT's electric-violet `stunned` fails this mode's `creep` (magenta 0xcc79a7 sits
  // at a very different luminance than DEFAULT's yellow), so this mode overrides it.
  // Near-white is the only band clearing both floor and `creep` here — ≈[0.9795, 1.0],
  // verified by exhaustive scan, not eyeballed. NOTE this mode is the one that does NOT
  // need the carve-out: its `creep` is a dark magenta, so the luminance sandwich opens and
  // `0xfffff5` clears `creepLowHp` too, at 3.84. The geometry move is driven by the
  // default and protan/deutan tables; tritan simply inherits it.
  // NOT pure white 0xffffff — that is byte-identical to `spark` (the impact-spark FX
  // colour, DEFAULT and unoverridden here), and a single-target impact draws a
  // shrinking white disc straight through the jolt ring's radius, so the guaranteed
  // stun cue vanished on exactly the tick the stun lands. 0xfffff5 sits inside the
  // verified near-white band (clears `creep` at 3.04 and `floor` at 16.36) and is
  // byte-distinct from `spark`.
  stunned: 0xfffff5,
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
