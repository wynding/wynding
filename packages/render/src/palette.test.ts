// palette.test.ts — the permanent contrast gate (ADR 0003 §2 colourblind conformance).
// WCAG relative luminance / contrast ratio computed locally (no dependency on the scene
// or DOM); every cue the scene draws OPAQUE is gated at source colour, and `range` (the
// only cue ever drawn at partial alpha for essential information — the 0.7 ghost-preview
// stroke in `scene.ts`'s ghost branch; the two 0.9 draws, `board-draw.ts`'s
// selected-tower stroke and `scene.ts`'s ghost blast crosshair, are strictly stronger
// and so not the binding case) and `aura` (M2-S8's adjacency shell, at
// `AURA_SHELL_ALPHA`) are gated at their composited alpha. `spark`
// is exempt (transient fading FX, alpha → 0 by design, non-essential — the kill outcome
// is carried by the creep/HP-pip state, and it is reduced-motion governed). `border` is
// excluded (a quiet structural fill — now an actually-drawn blocked-border ring with a
// real consumer, `board-cells.ts`'s `boardPaintOps` and its `drawBoard` executor — whose
// identity is carried by geometry, not colour). Gate scope: contrast is certified AGAINST
// THE UNOBSCURED BOARD FLOOR, the defined baseline; where cues overlap other visuals in
// play, the dual SHAPE encoding (ADR 0003) is the fallback channel.
//
// TOWERS (the visual pass, T1/T2/T4, #181) are a slate PLATE with a RIM and a head in its
// ROLE colour. The plate is deliberately quiet against the floor (`plate` is not a cue);
// the rim — `tower`, still in the opaque set — carries the footprint's edge. What else is
// drawn ON a tower is gated against the surface it is drawn on: every role colour against
// the floor (the plateless mine) and the plate, the ink outline against every role, the
// boost glow and the selection cue composited over the plate. The six role colours must
// also stay apart from one another under each mode's own SIMULATED colour-vision
// deficiency — a distinctness gate in CIELAB, since contrast cannot say whether two
// colours look alike.

import { describe, it, expect } from 'vitest';
import { COLOUR_MODES, resolvePalette, roleColour } from './palette';
import { AURA_SHELL_ALPHA, SELECTION_ALPHA } from './board-draw';
import { ART_INK, BOOST_RING_ALPHA, PENDING_ALPHA, PENDING_PLATE_ALPHA } from './tower-art';
import { TOWER_ROLES, type TowerRole } from './tower-paint';
import type { Palette } from './palette';
import type { ColourMode } from './types';

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

// The cues the scene draws OPAQUE against the floor (source colour, no compositing) —
// `slowed`'s essential ring is drawn at alpha 1 (the pulse, alpha 0.4, is the non-essential
// motion cue), so gating it as opaque is exact, not an approximation. `poisoned` (M2-S5a)
// is the same essential-cue category: its three guaranteed pips are also alpha 1 (the
// drift cue, alpha ≤ 0.5, is the non-essential motion cue) — PLAN.md step 32. `tower` is
// the plate RIM since the visual pass — what carries a tower's footprint edge against the
// floor, solid on a built tower and dashed (at full opacity) on a pending one.
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
  'airborne',
];

// `range`'s weakest essential draw: the ghost-preview range stroke at alpha 0.7
// (`scene.ts`'s ghost branch). The 0.9 draws — the selected-tower stroke
// (`board-draw.ts`'s selection block) and the ghost blast crosshair (`scene.ts`) — are
// strictly stronger, so 0.7 is binding. A future alpha change at any of the three draw
// sites should update this constant.
const RANGE_GHOST_PREVIEW_ALPHA = 0.7;

// `aura`'s only essential draw: the support-adjacency shell, stroked over the board FLOOR
// one cell out from a `beacon`'s footprint. Imported from the draw site rather than
// re-declared, so the gate below can never drift from the alpha actually drawn (the
// `RANGE_GHOST_PREVIEW_ALPHA` literal above is the older, hand-synced form of the same
// idea). Composited rather than added to OPAQUE_CUES because the stroke is not alpha 1.

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

      const auraComposited = compositeOver(pal.aura, pal.floor, AURA_SHELL_ALPHA);
      const auraRatio = contrast(auraComposited, pal.floor);
      minima[`aura@${AURA_SHELL_ALPHA}`] = auraRatio;
      expect(auraRatio).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);

      // Distinctness: the valid/invalid dual encoding keeps a distinct colour channel in
      // every mode (shape also differs in the scene — this is the redundant colour cue).
      expect(pal.ghostValid).not.toBe(pal.ghostInvalid);

      // `airborne` is gated against a tower's surfaces as well as the floor (M2-S7,
      // ship-review). Unlike every other cue here, the wingspan is drawn a full cell ABOVE
      // its creep, and on the shipped board creeps walk the row-11 lane between tower
      // footprints on rows 10 and 12 — so a tower is a surface it lands on as the ordinary
      // case, not an incidental one. The first colour tried (electric cyan 0x33ccff)
      // measured 1.83:1 against the tower body of the day and passed every gate that existed
      // at the time, which is why this one exists. Since the visual pass a tower is mostly
      // its slate PLATE, edged by the RIM (`tower`) — both gated here. Its light role-coloured
      // HEAD is not, and cannot be (no colour clears both it and the dark plate); that
      // residual is carried by shape and recorded in docs/accessibility-checklist.md.
      const airborneOverTower = contrast(pal.airborne, pal.tower);
      minima['airborne@tower'] = airborneOverTower;
      expect(airborneOverTower).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);
      const airborneOverPlate = contrast(pal.airborne, pal.plate);
      minima['airborne@plate'] = airborneOverPlate;
      expect(airborneOverPlate).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);

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
//
// "The tower" a cue is drawn over is, since the visual pass, every surface a tower paints:
// its rim (`tower`), its plate, and its head in any of the six role colours.
const TOWER_SURFACES: ReadonlyArray<keyof Palette> = [
  'tower',
  'plate',
  'roleDamage',
  'roleControl',
  'rolePoison',
  'roleAir',
  'roleSupport',
  'roleBurst',
];

const POISONED_MUST_DIFFER_FROM: ReadonlyArray<keyof Palette> = [
  ...TOWER_SURFACES,
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
// motion cue. `warded`'s ring can be drawn over a tower: since the visual pass that is mostly
// the plate (8.91:1), but the thin rim measures 2.79:1 and the light role-coloured heads as
// little as 1.12:1 (default; protan/deutan 1.20, tritan 1.16) — gated by byte-distinctness
// instead (the tower surfaces below), the same posture `poisoned`'s pips carry. (Against the
// green tower body before the visual pass it was 2.37:1 in the default and tritan tables.)
// The ward ring is opaque and drawn well outside the silhouette at r×2.2, but a tower
// footprint under it is the same kind of "cue drawn over a body this gate doesn't reach" as
// this one.
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

// `aura`'s shell is stroked on the board FLOOR, one cell out from a beacon's footprint —
// so the cues it can share a surface with are the ones also drawn on or across floor cells:
// the floor itself, the `range` ring (a selected neighbour's ring crosses the shell), the
// `ghostValid`/`ghostInvalid` outlines (a ghost aimed at a shell cell sits on top of it),
// and the status/ward/airborne cues a creep pathing through a shell cell carries. NOT a
// tower surface: the board's layer order (`layers.ts` — every shell under every plate and
// head sprite) guarantees no tower is ever painted under a shell, which is why those
// pairings need no gate here (`aura` against the rim measures 2.23:1, and it would not clear
// the light heads either). The boost GLOW, which is drawn on a tower in `aura`, is gated
// against the plate it lies on, below. Scoped deliberately, on
// `POISONED_MUST_DIFFER_FROM`'s precedent ("do not widen this gate"), rather than blanket.
//
// This exists because `palette.ts`'s comment on `aura` CLAIMS byte-distinctness from every
// other cue in all three tables. An unasserted claim in a comment is how a future palette
// edit silently makes it false.
const AURA_MUST_DIFFER_FROM: ReadonlyArray<keyof Palette> = [
  'floor',
  'range',
  'ghostValid',
  'ghostInvalid',
  'slowed',
  'poisoned',
  'stunned',
  'warded',
  'airborne',
  'creep',
  'creepLowHp',
];

describe('aura — pairwise distinctness from every cue its shell can share a surface with (M2-S8)', () => {
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": aura differs from every cue drawn on or across a floor cell`, () => {
      const pal = resolvePalette(mode);
      for (const key of AURA_MUST_DIFFER_FROM) {
        expect(pal.aura).not.toBe(pal[key]);
      }
    });
  }
});

describe('poisoned — pairwise distinctness from every cue a pip can be drawn over (M2-S5a)', () => {
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": poisoned differs from every tower surface/ghostValid/creep/creepLowHp/floor`, () => {
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
// `slowed`/`poisoned` are in ALL THREE lists (M2-S7, ship-review). They were added to
// `airborne`'s first, with a co-occurrence rationale that applies verbatim here: a stunned
// creep under a `slow` tower, and a `resolute` warded creep under `venom`, are exactly as
// reachable — and the stun jolt at r×1.15 sits immediately inside the slow ring at r×1.40.
// No collision exists today in any mode; this closes the regression net, and leaving two
// of three lists narrower than the third would have been an asymmetry with no argument
// behind it.
const STUNNED_MUST_DIFFER_FROM: ReadonlyArray<keyof Palette> = [
  'spark',
  'creep',
  'creepLowHp',
  ...TOWER_SURFACES,
  'floor',
  'warded',
  'airborne',
  'slowed',
  'poisoned',
];

const WARDED_MUST_DIFFER_FROM: ReadonlyArray<keyof Palette> = [
  'spark',
  'creep',
  'creepLowHp',
  ...TOWER_SURFACES,
  'floor',
  'stunned',
  'airborne',
  'slowed',
  'poisoned',
];

// `airborne` (M2-S7) draws entirely outside the silhouette, over the same backgrounds a
// creep can path across or be built under — the same scope `stunned`/`warded` are
// gated against, plus those two cues themselves (a warded or stunned flyer is a
// perfectly reachable state).
const AIRBORNE_MUST_DIFFER_FROM: ReadonlyArray<keyof Palette> = [
  'spark',
  'creep',
  'creepLowHp',
  ...TOWER_SURFACES,
  'floor',
  'stunned',
  'warded',
  // `slowed` and `poisoned` were missing (ship-review, M2-S7) — and `slowed` is the one
  // this cue co-occurs with MOST, not least: S7 widened `slow` to both-domain precisely
  // so it can land on flyers, and `story-flying-wave.test.ts` pins a slowed flyer. A
  // both-domain `slow` plus a `venom` in range makes all three concurrent on one creep.
  'slowed',
  'poisoned',
];

describe('stunned — pairwise distinctness from every cue it can be drawn over or beside (M2-S6)', () => {
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": stunned differs from spark/creep/creepLowHp/every tower surface/floor/warded`, () => {
      const pal = resolvePalette(mode);
      for (const key of STUNNED_MUST_DIFFER_FROM) {
        expect(pal.stunned).not.toBe(pal[key]);
      }
    });
  }
});

describe('warded — pairwise distinctness from every cue it can be drawn over or beside (M2-S6)', () => {
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": warded differs from spark/creep/creepLowHp/every tower surface/floor/stunned/airborne`, () => {
      const pal = resolvePalette(mode);
      for (const key of WARDED_MUST_DIFFER_FROM) {
        expect(pal.warded).not.toBe(pal[key]);
      }
    });
  }
});

describe('airborne — pairwise distinctness from every cue it can be drawn over or beside (M2-S7)', () => {
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": airborne differs from spark/creep/creepLowHp/every tower surface/floor/stunned/warded/slowed/poisoned`, () => {
      const pal = resolvePalette(mode);
      for (const key of AIRBORNE_MUST_DIFFER_FROM) {
        expect(pal.airborne).not.toBe(pal[key]);
      }
    });
  }
});

// ---- Towers (the visual pass, T2/T4, #181) ----

describe('tower role colours — contrast against what a head is drawn on and outlined with (T2)', () => {
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": every role clears ${MIN_CUE_CONTRAST}:1 against the floor AND the plate, and the ink outline against every role`, () => {
      const pal = resolvePalette(mode);
      const minima: Record<string, number> = {};
      for (const role of TOWER_ROLES) {
        const c = roleColour(pal, role);
        // The floor: the mine has no plate, so its head lies on the floor.
        minima[`${role}@floor`] = contrast(c, pal.floor);
        // The plate: every other head, and a head's role-coloured strokes (the beacon's
        // broadcast arcs), lie on it.
        minima[`${role}@plate`] = contrast(c, pal.plate);
        // The ink outline and glyph, drawn on the role fill.
        minima[`ink@${role}`] = contrast(ART_INK, c);
      }
      for (const [k, v] of Object.entries(minima)) {
        expect(v, k).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);
      }
      console.info(
        `[palette.test] mode=${mode} roles min=${Math.min(...Object.values(minima)).toFixed(2)} ` +
          Object.entries(minima)
            .map(([k, v]) => `${k}=${v.toFixed(2)}`)
            .join(' '),
      );
    });
  }

  it('gives every role its own colour in every mode — six roles, six colours', () => {
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      expect(new Set(TOWER_ROLES.map((r) => roleColour(pal, r))).size, mode).toBe(6);
    }
  });
});

// ---- Simulated colour-vision deficiency (Machado, Oliveira & Fernandes 2009) ----
//
// The matrices at severity 1.0 (full dichromacy), applied to LINEAR RGB as the paper
// specifies; the result is clamped to the gamut and compared in CIELAB (D65) by ΔE76.

const MACHADO_2009: Readonly<Record<'protan' | 'deutan' | 'tritan', readonly number[][]>> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** The deficiency each colour mode is FOR — `null` for normal colour vision. */
const SIMULATED: Readonly<Record<ColourMode, keyof typeof MACHADO_2009 | null>> = {
  default: null,
  protan: 'protan',
  deutan: 'deutan',
  tritan: 'tritan',
};

const toLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** `hex` as CIELAB (D65), as seen with `deficiency` (or normal colour vision). */
function labAs(
  hex: number,
  deficiency: keyof typeof MACHADO_2009 | null,
): [number, number, number] {
  let rgb = channels(hex).map(toLinear);
  if (deficiency !== null) {
    rgb = MACHADO_2009[deficiency].map((row) =>
      Math.min(1, Math.max(0, row[0]! * rgb[0]! + row[1]! * rgb[1]! + row[2]! * rgb[2]!)),
    );
  }
  const [r, g, b] = rgb as [number, number, number];
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t: number): number =>
    t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29;
  const fx = f(x / 0.95047);
  const fy = f(y);
  const fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** The closest two role colours of `pal` come to each other, ΔE76, as seen with
 *  `deficiency` — and which two they are. */
function closestRoles(
  pal: Palette,
  deficiency: keyof typeof MACHADO_2009 | null,
): { deltaE: number; pair: string } {
  let best = { deltaE: Infinity, pair: '' };
  const roles: readonly TowerRole[] = TOWER_ROLES;
  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      const a = labAs(roleColour(pal, roles[i]!), deficiency);
      const b = labAs(roleColour(pal, roles[j]!), deficiency);
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < best.deltaE) best = { deltaE: d, pair: `${roles[i]}/${roles[j]}` };
    }
  }
  return best;
}

/** How far apart (ΔE76) the six role colours must stay, pairwise, under each mode's own
 *  simulated deficiency. The tuned tables clear it with room — protan 31.79, deutan 31.38,
 *  tritan 33.01, default (normal vision) 27.99 — while the style frame's own six, which the
 *  default table keeps, fall to 20.40, 11.23 and 14.47 under the three simulations. */
const MIN_ROLE_DELTA_E = 25;

describe('tower role colours — distinguishable under each mode’s own simulated deficiency (T2)', () => {
  it('the simulation is sound: greys stay grey, red–green dichromacy flattens colour to a plane, and saturated colours move', () => {
    const det = (m: readonly number[][]): number =>
      m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
      m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
      m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
    const moved = (hex: number, d: keyof typeof MACHADO_2009): number => {
      const a = labAs(hex, null);
      const b = labAs(hex, d);
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    };
    for (const deficiency of ['protan', 'deutan', 'tritan'] as const) {
      // Each row sums to 1, so white stays white and every grey stays itself — a typo in
      // any one entry breaks its row.
      for (const row of MACHADO_2009[deficiency]) {
        expect(row.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 5);
      }
      expect(labAs(0xffffff, deficiency)[0]).toBeCloseTo(100, 3);
      expect(labAs(0x808080, deficiency)).toEqual(
        labAs(0x808080, null).map((v) => expect.closeTo(v, 3)),
      );
    }
    // A protanope or deuteranope has two cone types, not three: the matrix maps colour onto
    // a plane, so it is singular.
    expect(Math.abs(det(MACHADO_2009.protan))).toBeLessThan(1e-3);
    expect(Math.abs(det(MACHADO_2009.deutan))).toBeLessThan(1e-3);
    // And each one changes the colours its deficiency is about — it is not the identity.
    expect(moved(0xff0000, 'protan')).toBeGreaterThan(20);
    expect(moved(0x00c000, 'deutan')).toBeGreaterThan(20);
    expect(moved(0x0000ff, 'tritan')).toBeGreaterThan(20);
  });

  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": the six role colours stay ≥ ${MIN_ROLE_DELTA_E} ΔE76 apart, pairwise`, () => {
      const deficiency = SIMULATED[mode];
      const closest = closestRoles(resolvePalette(mode), deficiency);
      console.info(
        `[palette.test] mode=${mode} roles under ${deficiency ?? 'normal vision'}: ` +
          `min ΔE76=${closest.deltaE.toFixed(2)} (${closest.pair})`,
      );
      expect(closest.deltaE, closest.pair).toBeGreaterThanOrEqual(MIN_ROLE_DELTA_E);
    });
  }

  it('can fail: the default table’s role colours, seen with each deficiency, are too close', () => {
    const pal = resolvePalette('default');
    for (const deficiency of ['protan', 'deutan', 'tritan'] as const) {
      expect(closestRoles(pal, deficiency).deltaE, deficiency).toBeLessThan(MIN_ROLE_DELTA_E);
    }
  });
});

describe('airborne — readable on every tower surface it lands on (QC round 1, #181)', () => {
  // The flyer cue sits ~1.2 cells above its creep, so a flyer one row under a tower puts it
  // on that tower as the ordinary case — and since the visual pass a tower's top is a LIGHT
  // role-coloured head, over which the light stroke alone measures as little as 1.05:1. So
  // the cue carries an ink outline (`airborneCuePaintOps`' `outlineColour`): the light core
  // reads on the dark surfaces, the ink edge on the light ones. Both halves gated here.
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": the light stroke clears ${MIN_CUE_CONTRAST}:1 on the floor, plate and rim; its ink outline on every role colour and the rim`, () => {
      const pal = resolvePalette(mode);
      for (const surface of ['floor', 'plate', 'tower'] as const) {
        expect(contrast(pal.airborne, pal[surface]), surface).toBeGreaterThanOrEqual(
          MIN_CUE_CONTRAST,
        );
      }
      let inkMin = Infinity;
      for (const role of TOWER_ROLES) {
        const c = contrast(ART_INK, roleColour(pal, role));
        inkMin = Math.min(inkMin, c);
        expect(c, role).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);
      }
      expect(contrast(ART_INK, pal.tower)).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);
      // ... and the two halves of the cue read apart from each other.
      expect(contrast(ART_INK, pal.airborne)).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);
      console.info(
        `[palette.test] mode=${mode} airborne ink outline vs heads min=${inkMin.toFixed(2)} ` +
          `vs rim=${contrast(ART_INK, pal.tower).toFixed(2)}`,
      );
    });
  }
});

describe('what a tower’s states draw on it — composited over the plate they lie on (T4)', () => {
  for (const mode of COLOUR_MODES) {
    it(`mode "${mode}": the boost glow and the selection cue clear ${MIN_CUE_CONTRAST}:1 over the plate, and a pending head over its faded plate`, () => {
      const pal = resolvePalette(mode);
      // The boost glow's inner ring — the cue — lies wholly on the plate (`tower-art.test.ts`
      // holds it inside the rim), at `BOOST_RING_ALPHA`; on the plateless mine, on the floor.
      const glow = contrast(compositeOver(pal.aura, pal.plate, BOOST_RING_ALPHA), pal.plate);
      expect(glow).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);
      const glowOnFloor = contrast(compositeOver(pal.aura, pal.floor, BOOST_RING_ALPHA), pal.floor);
      expect(glowOnFloor).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);
      // The selection cue's blast spokes and its attackless outline's inner edge lie on the
      // plate, at `SELECTION_ALPHA`.
      const selection = contrast(compositeOver(pal.range, pal.plate, SELECTION_ALPHA), pal.plate);
      expect(selection).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);
      // A PENDING build's identity — its head's role colour — against its own faded plate,
      // both composited over the floor at the opacities its frame bakes them at
      // (`PENDING_ALPHA`, `PENDING_PLATE_ALPHA`; QC round 1). The plate fades further than
      // the head precisely so this holds for the darkest role colours too.
      const fadedPlate = compositeOver(pal.plate, pal.floor, PENDING_PLATE_ALPHA);
      let pendingMin = Infinity;
      for (const role of TOWER_ROLES) {
        const head = compositeOver(roleColour(pal, role), pal.floor, PENDING_ALPHA);
        const c = contrast(head, fadedPlate);
        pendingMin = Math.min(pendingMin, c);
        expect(c, role).toBeGreaterThanOrEqual(MIN_CUE_CONTRAST);
      }
      console.info(
        `[palette.test] mode=${mode} pending head vs faded plate min=${pendingMin.toFixed(2)}`,
      );
      console.info(
        `[palette.test] mode=${mode} aura@${BOOST_RING_ALPHA}@plate=${glow.toFixed(2)} ` +
          `aura@${BOOST_RING_ALPHA}@floor=${glowOnFloor.toFixed(2)} ` +
          `range@${SELECTION_ALPHA}@plate=${selection.toFixed(2)} ` +
          `tower(rim)@plate=${contrast(pal.tower, pal.plate).toFixed(2)} ` +
          `plate@floor=${contrast(pal.plate, pal.floor).toFixed(2)}`,
      );
    });
  }
});
