// palette.ts — the drawing colours the Phaser scene uses, one set per colourblind
// mode (GAG §2 / ADR 0003). Pure data + a resolver, so it is unit-tested and the scene
// stays a dumb consumer. Every semantic role also has a distinct SHAPE cue in the scene
// (creep = polygon, tower = a plate with a head of its own silhouette, valid ghost = solid
// outline, invalid = dashed cross); colour is a redundant channel, never the sole carrier of
// meaning. Palettes are
// drawn from Okabe–Ito and Paul Tol colourblind-safe sets and hold the WCAG 1.4.11
// non-text bar (≥ 3:1) against the dark board floor for every opaque-drawn cue, most
// pairs well above; enforced permanently by `palette.test.ts`. `border` is a deliberate
// quiet structural fill excluded from the gate (identity carried by geometry); `spark` is
// exempt (transient fading FX, non-essential — see `palette.test.ts`).

import type { CreepFamily } from './creep-paint';
import type { TowerRole } from './tower-paint';
import type { ColourMode } from './types';

/** The concrete colours (0xRRGGBB) the scene draws with for one colour mode. */
export interface Palette {
  /** Board floor fill and the blocked-border fill. */
  readonly floor: number;
  readonly border: number;
  /** Lane entrance / exit glyph tints. */
  readonly entrance: number;
  readonly exit: number;
  /** The creep FAMILY hues (visual pass C3, #181) — the colour a creep's body is filled in,
   *  the second channel beside its silhouette (`CreepFamily`, `creep-paint.ts`), and what its
   *  HP bar fills with while it is not low. `creep` is the NORMAL family's — `normal`,
   *  `resolute`, and any id the catalog has never heard of — and was every creep's colour
   *  until C3; each other family has its own. Gated in every mode (`palette.test.ts`): each
   *  ≥ 3:1 against the floor and the plate it can cross, the ink outline ≥ 3:1 against each,
   *  the families DISTINCT under the mode's own simulated colour-vision deficiency, and each
   *  clear of every status-cue colour. Read them through `creepColour`. */
  readonly creep: number;
  readonly creepSwarm: number;
  readonly creepFast: number;
  readonly creepArmored: number;
  readonly creepFlying: number;
  readonly creepBoss: number;
  /** The HP bar's fill below `isLowHp`'s threshold — the bar's colour turns to this while its
   *  LENGTH carries how much HP is left (dual encoding). Since C3 it is the bar's alone: a
   *  creep's body keeps its family hue at any HP. Gated distinct from every family hue under
   *  each mode's simulation, so the turn reads on every creep. */
  readonly creepLowHp: number;
  /** The tower plate's RIM (visual pass, #181) — the outline that carries a tower's 2×2
   *  footprint edge. The plate itself (`plate`) is only ~1.28:1 against the floor, so the rim
   *  is what the floor gate guards: `tower` is in `palette.test.ts`'s opaque set, ≥ 3:1
   *  against the floor in every mode, and a pending build's dashed rim draws in it too. Until
   *  the visual pass this key was the whole tower body's fill; it kept the name so the gate
   *  that held the footprint edge keeps holding it. */
  readonly tower: number;
  /** The tower plate's fill — the slate every tower but the mine stands on. Deliberately
   *  quiet against the floor (the rim carries the edge); what the gate holds is every ROLE
   *  colour ≥ 3:1 against it, since a head and its glyph-free role strokes are drawn on it. */
  readonly plate: number;
  /** The six tower ROLE colours (T2, `TowerRole` in `tower-paint.ts`) — the colour of a
   *  tower's head, the second channel beside its silhouette. Gated in every mode against the
   *  floor and the plate (≥ 3:1) and for DISTINCTNESS under each mode's own simulated
   *  colour-vision deficiency (`palette.test.ts`), so each mode re-tunes them. Read them
   *  through `roleColour`. */
  readonly roleDamage: number;
  readonly roleControl: number;
  readonly rolePoison: number;
  readonly roleAir: number;
  readonly roleSupport: number;
  readonly roleBurst: number;
  /** The dot a shot is drawn as when its tower is one the shot table does not know
   *  (`planShots`) — every shot's look until C2 gave each tower its own tracer. It drew in the
   *  tower body's colour until the visual pass gave `tower` to the plate rim, and keeps that
   *  colour. */
  readonly tracer: number;
  /** The range ring stroke. */
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
   *  ring and the DoT pips. The `flicker` still draws inside at r×0.85, on the creep's own
   *  body — since C3 a family hue, which no single colour clears in every family (the
   *  luminance sandwich `palette.test.ts` derives) — so it carries an ink under-stroke like
   *  every other cue, and what is gated is that ink against every body. */
  readonly stunned: number;
  /** Ward cue (M2-S6) — the redundant colour channel behind the always-on outer ring
   *  `wardPaintOps` draws for a creep whose catalog definition carries an immunity. Not
   *  a timed status (see CONTEXT.md's Ward term), so gated ≥ 3:1 like every other
   *  opaque cue (`palette.test.ts`) with no motion-cue caveat. */
  readonly warded: number;
  /** Airborne cue (M2-S7) — the redundant colour channel behind the always-on shape cue a
   *  creep whose catalog `domain` is `'air'` carries: since C4 (#181) the fill of the two
   *  WINGS attached to its body, each outlined in ink (`CREEP_WINGS`, `creep-art.ts`). Not a
   *  timed status (see CONTEXT.md's Domain entry), so gated ≥ 3:1 like every other opaque cue
   *  (`palette.test.ts`) with no motion-cue caveat — same posture as `warded`. A flyer flies
   *  straight at the exit over whatever towers stand in the way, so its wings lie on the
   *  floor, a plate, a rim, a role-coloured head or another creep: the light fill reads on
   *  the dark ones and the ink outline on the light ones, each pair gated. (Until C4 it was
   *  a detached chevron floating more than a cell above the creep — `creep-paint.ts`'s
   *  CUE-RADIUS ORDERING block records why it sat there and why it no longer has to.) */
  readonly airborne: number;
  /** Support-aura cue (M2-S8) — the colour channel behind the adjacency SHELL
   *  `drawAuraShells` strokes one cell out from a `beacon`'s footprint. Drawn on the board
   *  FLOOR (the shell bounds, and slightly over-approximates, the cells a recipient must
   *  occupy — see `drawAuraShells` in `board-draw.ts` for the corner-cell caveat), at
   *  `AURA_SHELL_ALPHA`, so it is gated COMPOSITED against the floor exactly like
   *  `range`'s ghost-preview stroke rather than dropped into the opaque set
   *  (`palette.test.ts`).
   *
   *  Since the visual pass it is also the colour of the BOOST GLOW — the two rings around
   *  the head of a tower a beacon boosts (`BOOST_ART`, `tower-art.ts`), which replaced the
   *  buffed-recipient ✦. The glow is drawn on the plate, where `aura` clears 3:1 with room
   *  to spare (gated composited at `BOOST_RING_ALPHA`, `palette.test.ts`) — the reason the
   *  ✦ could not wear this colour (it was drawn on the old green body, where pale lavender
   *  measured 1.89:1) no longer applies. */
  readonly aura: number;
}

// Base palette: high-contrast, colourblind-safe hues (Okabe–Ito). Valid/invalid also
// differ by shape in the scene, so these survive monochrome vision entirely.
const DEFAULT: Palette = {
  floor: 0x1b1f2a,
  border: 0x3a4358,
  entrance: 0x56b4e9, // sky blue
  exit: 0xe69f00, // orange
  // The style frame's creep families (C3, #181), nudged only where the distinctness gate
  // needed it: the frame's own swarm and flying (pale yellow, cream) sat 18.24 ΔE76 apart and
  // its normal and fast (yellow, yellow-green) 19.79, so swarm, fast and flying moved by
  // 3.4, 6.2 and 4.5 ΔE76 to clear 25 (`palette.test.ts`). Normal, armored and boss are the
  // frame's own.
  creep: 0xf0e442, // yellow — the normal family
  creepSwarm: 0xf6ef94, // pale yellow
  creepFast: 0xbce761, // yellow-green
  creepArmored: 0xe89a5c, // orange
  creepFlying: 0xfff3cc, // cream
  creepBoss: 0xff5a64, // red
  creepLowHp: 0xd55e00, // vermillion — the HP bar's fill when low (its length shrinks too)
  // The plate rim: a light slate, neutral on every colour-vision axis, so one value serves
  // every mode — 4.08:1 against the floor (and 3.19:1 against the plate it outlines).
  tower: 0x707f9c,
  plate: 0x283245, // the style frame's slate
  // The style frame's role colours. Every mode below re-tunes them for its own deficiency;
  // these are the ones normal colour vision sees.
  roleDamage: 0xf4a940, // amber
  roleControl: 0x8fd3ff, // ice blue
  rolePoison: 0xd58bd6, // orchid
  roleAir: 0x3ccfa6, // sea green
  roleSupport: 0xe8eef7, // near-white
  roleBurst: 0xff6a3d, // red-orange
  tracer: 0x009e73, // bluish green — the tower body's colour before the visual pass
  range: 0xcc79a7, // reddish purple
  ghostValid: 0x009e73,
  ghostInvalid: 0xd55e00,
  spark: 0xffffff,
  slowed: 0x56b4e9, // sky blue — the slow telegraph's redundant colour channel
  // Reddish purple (Okabe-Ito) — the DoT telegraph's redundant colour channel. NOT
  // bluish green, which the first draft used (QC round 1): that was byte-identical to
  // the tower body of the time (`tower`, now the plate rim) and is to `ghostValid`, and since
  // creeps path straight along tower footprints the pips sat on a body of exactly their own
  // colour and vanished. The pairwise gate in
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
  // It IS drawn over a tower when a warded creep paths across a footprint (the ring spans
  // ~1.54 cells). Since the visual pass that surface is mostly the plate (8.91:1); the thin
  // rim (`tower`) measures 2.79:1 and the light role-coloured heads as little as 1.12:1
  // (default control). Since C3 (#181) the ring carries an ink under-stroke, as every
  // creep cue does, and the ink is gated ≥ 3:1 against the rim and every head: the gold
  // reads on the dark surfaces, its ink edge on the light ones (`palette.test.ts`'s
  // surface gate).
  warded: 0xffd23f,
  // Pale ice-blue (M2-S7) — distinct from every other cue in this table, and gated on
  // contrast against the surfaces it is actually drawn over: the floor (14.82:1), the plate
  // (11.59:1) and its rim `tower` (3.63:1) — see `palette.test.ts`. Since C4 (#181) it fills a
  // flyer's two WINGS, attached to its body, and a flyer crosses whole towers on its straight
  // line to the exit; over the light role-coloured heads, and the light creep families, this
  // light fill cannot read and is not gated (1.05:1 over the default support white), and no
  // single colour clears both them and the dark plate. So each wing is outlined in ink
  // (`ART_INK`), which is gated ≥ 3:1 against every role colour and every creep family in
  // every mode: the light fill reads on the dark surfaces, the ink edge on the light ones
  // (docs/accessibility-checklist.md). Until C4 the same two halves made up a detached
  // chevron a cell above the creep — the light stroke and an ink outline under it.
  //
  // WHY IT IS NOT THE ELECTRIC CYAN THIS SHIPPED AS FIRST (0x33ccff): that measured
  // 1.83:1 against `tower` 0x009e73 and 2.77:1 against 0x0072b2, both under this repo's
  // own MIN_CUE_CONTRAST of 3.0 (ship-review, M2-S7). The chevron of the day sat a cell
  // above its creep, so on the shipped board — where every creep walks the row-11 lane
  // past tower footprints on rows 10 and 12 — being drawn over a tower was the NORMAL case,
  // not an incidental one (as it is for today's wings, on a flyer crossing towers).
  // `warded`'s 2.37:1 note below was the precedent invoked for accepting it; a precedent
  // for tolerating a miss is not a reason to add one when a compliant colour exists.
  // Lightening also widens the gap from `slowed`'s sky blue under tritanopia, where
  // cyan-vs-sky-blue sat on exactly the axis that palette avoids.
  //
  // TRITAN RESIDUAL, measured and deliberately ACCEPTED (not overlooked): in tritan
  // `stunned` is 0xfffff5, so airborne-vs-stunned is ~1.10:1 — perceptually one
  // near-white. There is no override that fixes it: clearing the ENFORCED ≥3:1 gate
  // against `tower` needs a very light colour, and every candidate that separates from
  // `stunned` falls under it (measured against the old green body: 0x9ad0ff → 2.09,
  // 0xb0d8ff → 2.30, 0x8fb8f0 → 1.68; against today's plate rim: 2.47, 2.71, 1.98).
  // Choosing separation here would trade an enforced gate for an unenforced one. Shape
  // carries the distinction instead, decisively and per ADR 0003's primary channel: a stun
  // jolt is a RING around the body at r×1.15; the airborne cue is two ink-outlined
  // TRIANGLES fixed to the body's sides, each reaching about two radii out — never a closed
  // curve — and both read apart by their ink edges besides (`creep-paint.ts`'s CUE-RADIUS
  // ORDERING block is the authority for the geometry, restated here only as shapes so a
  // restatement cannot become a second source of truth: #126 once moved the strokes and a
  // sentence here went stale). Same posture as `poisoned`'s own tritan note.
  airborne: 0xdcf8ff,
  // Pale lavender (M2-S8) — clearing the floor at 7.64:1 composited at
  // `AURA_SHELL_ALPHA`, and byte-distinct from every cue the shell can share a surface
  // with (nearest neighbours: DEFAULT `range` 0xcc79a7, TRITAN `range` 0x56b4e9). That
  // scoped list — not "every cue in the table" as an earlier version of this line
  // claimed — is exactly what `AURA_MUST_DIFFER_FROM` in `palette.test.ts` enforces, and
  // the comment is written to the gate rather than past it. The shell CAN also cross the
  // `entrance`/`exit` glyphs at the board edge, where it clears neither gate; that is the
  // contrast residual recorded in docs/accessibility-checklist.md, deliberately not
  // papered over by widening a byte-distinctness list that would not measure it. The floor is
  // un-overridden across all three modes, so that figure holds in every mode and this
  // key needs no per-mode override.
  aura: 0xc9b6ff,
};

// Deutan/protan (red–green) shift the green/red pair toward blue/orange separation.
// Only the keys that actually differ from DEFAULT are overridden.
const PROTAN_DEUTAN: Palette = {
  ...DEFAULT,
  // The creep families, re-tuned so the six (and the HP bar's low colour) stay apart under
  // BOTH simulated protanopia and deuteranopia (min ΔE76 26.01; the default table's fall to
  // 12.35 under protanopia, normal and fast closest, and to 12.15 under deuteranopia, armored
  // and boss closest). Separated by LIGHTNESS and the blue–yellow axis these deficiencies
  // keep: a bright yellow normal against a paler yellow-green fast, a stone-grey swarm, the
  // cream flyer, and a deeper rose boss. Armored keeps the default's orange.
  creep: 0xfff41d,
  creepSwarm: 0xbfc1b4,
  creepFast: 0xedff7a,
  creepFlying: 0xfff4c2,
  creepBoss: 0xe34a67,
  creepLowHp: 0xf28e00,
  // The role colours, re-tuned so the six stay apart under BOTH simulated protanopia and
  // deuteranopia (min ΔE76 31.79 / 31.38; the default six fall to 20.40 under protanopia,
  // ice blue and orchid closest, and to 11.23 under deuteranopia, amber and red-orange
  // closest). Same families, separated by LIGHTNESS, the axis these deficiencies keep: a
  // bright amber against a darker red-orange, a darker plum against the light ice blue, and
  // the support white at full brightness.
  roleDamage: 0xffb618,
  roleControl: 0x82cdff,
  rolePoison: 0xb8649c,
  roleAir: 0x58cb93,
  roleSupport: 0xfcffff,
  roleBurst: 0xe75933,
  tracer: 0x0072b2, // blue — the tower body's colour in this mode before the visual pass
  ghostValid: 0x0072b2,
  ghostInvalid: 0xe69f00,
};

// Tritan (blue–yellow) shifts off the blue/yellow axis toward red/green/magenta.
// Only the keys that actually differ from DEFAULT are overridden.
const TRITAN: Palette = {
  ...DEFAULT,
  // The role colours re-tuned for simulated tritanopia (min ΔE76 33.01; the default six fall
  // to 14.47 there, ice blue and sea green collapsing first): the blue-side roles move to a
  // periwinkle, a violet and a mint, and support warms to a pale blush. Amber and red-orange
  // already sit on the axis this deficiency keeps, and stay.
  roleControl: 0xa9bbff,
  rolePoison: 0xb278db,
  roleAir: 0x4ce0ae,
  roleSupport: 0xffe3e2,
  entrance: 0x009e73,
  exit: 0xd55e00,
  // The creep families re-tuned for simulated tritanopia (min ΔE76 26.02, the HP bar's low
  // colour included; the default table's fall to 6.38 there, swarm and flying all but one
  // colour). Normal moves to a yellow-green and fast to a leaf green, the swarm darkens to an
  // ochre and the flyer cools to a mint, each kept ≥ 15 ΔE76 from every status-cue colour this
  // mode draws around them (`palette.test.ts`) — this mode's cue colours sit nearer the
  // yellows than the default's do. Armored and boss keep the default's orange and red. Until
  // C3 this mode's one creep colour was the magenta 0xcc79a7, which the notes below on
  // `poisoned` and `stunned` were written against.
  creep: 0xd3eb28,
  creepSwarm: 0xbfa95a,
  creepFast: 0x80b426,
  creepFlying: 0xadf1cd,
  creepLowHp: 0xff242d,
  range: 0x56b4e9,
  // Yellow here, not DEFAULT's reddish purple: this mode gave `creep` the magenta
  // 0xcc79a7 until C3, and a telegraph byte-identical to a creep body would be no cue at all.
  // What this buys, stated precisely (QC round 2 measured it): yellow separates well
  // from the BACKGROUNDS a pip is actually drawn over — the dark `floor`, and what was
  // then this mode's bluish-green tower body (today a tower is the slate `plate`, 9.73:1,
  // its rim, 3.05:1, and its role-coloured head) — which is the collision that made the
  // first draft unusable. It does NOT separate strongly from this mode's magenta `creep` under
  // simulated tritanopia; the pips sit outside the silhouette at r*1.8 so they are not
  // drawn ON it, and the always-on SHAPE cue carries the state regardless, colour being
  // the redundant channel per the Telegraph glossary. The byte-equality gate below cannot
  // see perceptual distance; since C3 a CVD-distance gate does — every creep family and the
  // HP bar's low colour ≥ 15 ΔE76 from every status-cue colour under this mode's simulation
  // (`palette.test.ts`) — and the pips carry an ink under-stroke, which reads on any body.
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
  // byte-distinct from `spark`. (Those `creep` figures are the magenta's. Since C3 a body is
  // its family's hue and the flicker drawn on it carries an ink under-stroke, so the gate on
  // it is ink's — `palette.test.ts`.)
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

/** The colour of a tower of `role` in `pal` — the one place a role becomes a palette key. */
export function roleColour(pal: Palette, role: TowerRole): number {
  switch (role) {
    case 'damage':
      return pal.roleDamage;
    case 'control':
      return pal.roleControl;
    case 'poison':
      return pal.rolePoison;
    case 'air':
      return pal.roleAir;
    case 'support':
      return pal.roleSupport;
    case 'burst':
      return pal.roleBurst;
  }
}

/** The hue a creep of `family` wears in `pal` (C3) — its body's fill, and its HP bar's while
 *  the creep is not low. The one place a family becomes a palette key. */
export function creepColour(pal: Palette, family: CreepFamily): number {
  switch (family) {
    case 'normal':
      return pal.creep;
    case 'swarm':
      return pal.creepSwarm;
    case 'fast':
      return pal.creepFast;
    case 'armored':
      return pal.creepArmored;
    case 'flying':
      return pal.creepFlying;
    case 'boss':
      return pal.creepBoss;
  }
}
