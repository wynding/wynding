// creep-paint.ts — what a creep LOOKS like, keyed on its catalog id, and the pure paint plans
// of the live cues drawn around it (M2-S3 onward; the visual pass's C3/C4, #181). Kept in a
// Phaser-free module (the `board-cells.ts`/`tracers.ts` precedent) so all of it is
// unit-testable; `board-draw.ts` is a thin executor of exactly these plans. No sim import:
// keyed purely on what the render VM already carries (`CreepVM.creepId`, `.boss`, `.domain`).
//
// A creep's LOOK has three axes, each its own channel: its SHAPE (the silhouette, the primary
// cue, ADR 0003), its FAMILY (the hue its body wears and the size step it is drawn at, C3),
// and whether it is AIRBORNE (the wings, C4). Its art — `creep-art.ts` — is drawn from the
// look; the cues here are drawn live around it every frame.

/** The silhouette shapes the scene can draw. `'triangle'` is the pre-M2-S3 creep shape;
 *  `'diamond'` is `fast`'s visibly-distinct-at-cell-scale shape; `'square'` is `swarm`'s
 *  (M2-S4a) — a small, blocky silhouette that reads as fragile/numerous rather than fast,
 *  visibly distinct from both at cell scale. `'hexagon'` is `armored`'s (M2-S5a) — a
 *  six-sided plated outline that reads as armoured/tanky, distinct from the triangle's
 *  point, the diamond's pinch, and the square's blockiness at cell scale. `'pentagon'`
 *  is `resolute`'s (M2-S6) — a regular five-sided outline, generated the way
 *  `'hexagon'` already is, distinct from all four at cell scale. An id this build's
 *  catalog doesn't recognize draws `'triangle'` too (TOTAL — never throw; a
 *  forged/future content id must still render something, per the `tower.unknown.name`
 *  precedent). Since the visual pass each shape is drawn to the style frame's geometry,
 *  outlined in ink (`CREEP_BODY`, `creep-art.ts`), and `creep-art.test.ts` holds the five
 *  apart by outline.
 *
 *  `flying` (M2-S7) is DELIBERATELY ABSENT from the table below, and is the first
 *  shipped creep that is. Its distinguishing axis is DOMAIN, not kind, and domain has
 *  its own always-on shape cue — since C4, the WINGS attached to its body
 *  (`CREEP_WINGS`, `creep-art.ts`) — so giving it a sixth base silhouette would encode
 *  the same fact twice and spend the shape vocabulary on it. That is the same
 *  composability argument S10 depends on: `armored-flyer` must read as armored AND
 *  airborne, which it does by keeping `'hexagon'` and gaining the wings. A per-domain base
 *  shape would make that combination unrepresentable. The consequence, stated because it
 *  is a real one (ship-review, M2-S7): at the silhouette itself `flying` and `normal` are
 *  identical, so the wings — and, since C3, the flyer's own family hue — are what separate
 *  them.
 *
 *  `armored-flyer` and `boss` (M2-S10) are the composability proof this file's header
 *  argues for, exercised rather than merely asserted: both reuse `'hexagon'` — no third
 *  role/domain-driven shape value — and gain distinctness from OTHER independent axes
 *  instead. `armored-flyer` reads as armored (the hexagon) AND airborne (the wings), the
 *  exact combination this header already names. `boss` reads as armored (the hexagon) AND
 *  larger (its family's size step, 1.5× the armored creep's — `CREEP_SIZE`, `creep-art.ts`)
 *  AND warded (it is stun-immune, `wardPaintOps`) — and, since C3, in a hue of its own. Role
 *  stays a pure axis, so a future boss VARIANT would compose the same way rather than
 *  needing a SIXTH silhouette. (Counted against the union below, which has five members.
 *  Two docstrings in this file said "fourth" and one said "sixth"; the S7 accessibility
 *  audit copied the wrong one — #126.) */
export type CreepShape = 'triangle' | 'diamond' | 'square' | 'hexagon' | 'pentagon';

/** Every `CreepShape`, as a value. Keyed on the union, so a sixth shape that is not listed
 *  here fails to compile rather than going without art (`CREEP_BODY`, `creep-art.ts`). */
const ALL_SHAPES: Readonly<Record<CreepShape, true>> = {
  triangle: true,
  diamond: true,
  square: true,
  hexagon: true,
  pentagon: true,
};
export const CREEP_SHAPE_VALUES: readonly CreepShape[] = Object.keys(ALL_SHAPES) as CreepShape[];

const CREEP_SHAPES: Readonly<Partial<Record<string, CreepShape>>> = {
  normal: 'triangle',
  fast: 'diamond',
  swarm: 'square',
  armored: 'hexagon',
  resolute: 'pentagon',
  'armored-flyer': 'hexagon',
  boss: 'hexagon',
};

/** The shape to draw for `creepId` — total over any string, including a JSON id like
 *  `'__proto__'` (`hasOwnProperty` guarded so it can't escape via the prototype chain
 *  and resolve to `Object.prototype` instead of falling back). */
export function creepShapeFor(creepId: string): CreepShape {
  return Object.prototype.hasOwnProperty.call(CREEP_SHAPES, creepId)
    ? (CREEP_SHAPES[creepId] as CreepShape)
    : 'triangle';
}

/** A creep's FAMILY (visual pass C3, #181): the hue its body is filled in — the second
 *  channel beside its silhouette, one palette key per family per colour-vision mode
 *  (`creepColour`, `palette.ts`) — and the SIZE STEP it is drawn at (`CREEP_SIZE`,
 *  `creep-art.ts`), from the small swarm to the large boss. The style frame's: ids it gives
 *  one hue share a family — `resolute` the normal creep's, `armored-flyer` the armored
 *  creep's — and their shapes tell them apart. */
export type CreepFamily = 'swarm' | 'normal' | 'fast' | 'armored' | 'flying' | 'boss';

/** Every `CreepFamily`, as a value — keyed on the union, so a seventh family that is not
 *  listed here fails to compile (the palette needs a hue per family, `creepColour`). */
const ALL_FAMILIES: Readonly<Record<CreepFamily, true>> = {
  swarm: true,
  normal: true,
  fast: true,
  armored: true,
  flying: true,
  boss: true,
};
export const CREEP_FAMILIES: readonly CreepFamily[] = Object.keys(ALL_FAMILIES) as CreepFamily[];

const CREEP_FAMILY_BY_ID: Readonly<Partial<Record<string, CreepFamily>>> = {
  normal: 'normal',
  fast: 'fast',
  swarm: 'swarm',
  armored: 'armored',
  resolute: 'normal',
  flying: 'flying',
  'armored-flyer': 'armored',
};

/** The family of a creep of `creepId` — `boss` when it carries the boss ROLE (`CreepVM.boss`,
 *  a catalog join), whatever its id, since the boss's size step was always keyed on the role
 *  and its hue now goes with it; otherwise its id's, and the normal family for an id the
 *  table does not list. The `boss` id is not listed: without the role it is no boss, and
 *  wears neither the boss's size nor its hue. Total over any string, guarded like
 *  `creepShapeFor`. */
export function creepFamilyFor(creepId: string, boss: boolean): CreepFamily {
  if (boss) return 'boss';
  return Object.prototype.hasOwnProperty.call(CREEP_FAMILY_BY_ID, creepId)
    ? (CREEP_FAMILY_BY_ID[creepId] as CreepFamily)
    : 'normal';
}

/** What a creep looks like: its silhouette, its family (hue and size step), and whether it
 *  flies (wings, a lifted body, and a ground shadow under it). */
export interface CreepLook {
  readonly shape: CreepShape;
  readonly family: CreepFamily;
  readonly airborne: boolean;
}

/** The look of a creep of `creepId` with the boss role or not, in the air or not — total
 *  over any string, like each of its axes. Domain and role are the VM's own fields, joined
 *  from the catalog, never inferred from the id: an id the catalog has never heard of may
 *  still fly, and its look still carries wings. */
export function creepLookFor(creepId: string, boss: boolean, airborne: boolean): CreepLook {
  return { shape: creepShapeFor(creepId), family: creepFamilyFor(creepId, boss), airborne };
}

/** A look's stable name, `<shape>:<family>:<air|ground>` — what the board atlas keys a
 *  creep's body by. */
export function creepLookKey(look: CreepLook): string {
  return `${look.shape}:${look.family}:${look.airborne ? 'air' : 'ground'}`;
}

/** Every look `creepLookFor` can return for ANY id, role and domain: one per id either table
 *  knows, plus the fallback an unknown id gets, each with and without the boss role and in
 *  either domain — deduplicated, in table order. The board atlas bakes one body per look
 *  (`art-frames.ts`), so every look placement can ask for is baked by construction. */
export const CREEP_LOOKS: readonly CreepLook[] = (() => {
  const ids = [...new Set([...Object.keys(CREEP_SHAPES), ...Object.keys(CREEP_FAMILY_BY_ID)])];
  // `''` is never a catalog id (`ruleset-schema.ts` requires `^[a-z][a-z0-9-]{0,31}$`), so
  // it stands in for "an id neither table knows" — the fallback look.
  const seen = new Set<string>();
  const looks: CreepLook[] = [];
  for (const id of [...ids, '']) {
    for (const boss of [false, true]) {
      for (const airborne of [false, true]) {
        const look = creepLookFor(id, boss, airborne);
        const key = creepLookKey(look);
        if (seen.has(key)) continue;
        seen.add(key);
        looks.push(look);
      }
    }
  }
  return looks;
})();

/** Below this remaining-HP fraction a creep's HP bar turns to the warning colour
 *  (`pal.creepLowHp`). The bar's LENGTH carries HP too, so the colour is the redundant
 *  channel of a dual cue, never the only one. Until C3 the silhouette turned too; since C3
 *  a body keeps its family's hue at any HP, and the bar carries the turn alone. */
export const CREEP_LOW_HP_FRAC = 0.34;

/** Whether a creep at `hpFrac` shows the low-HP colour — the ONE threshold test. */
export function isLowHp(hpFrac: number): boolean {
  return hpFrac < CREEP_LOW_HP_FRAC;
}

/** The HP bar's geometry, the style frame's, in the creep's radius `r`: `HP_BAR_WIDTH` radii
 *  wide, `HP_BAR_HEIGHT` radii tall (never under `HP_BAR_MIN_HEIGHT_PX`), its top
 *  `HP_BAR_RISE` radii above the body's centre, on a backing `HP_BAR_BACKING_PX` larger on
 *  every side. */
export const HP_BAR_WIDTH = 2.1;
export const HP_BAR_HEIGHT = 0.32;
export const HP_BAR_MIN_HEIGHT_PX = 3;
export const HP_BAR_RISE = 1.75;
export const HP_BAR_BACKING_PX = 1;

/** One rectangle of the HP bar, CSS px, and its colour. */
export interface HpBarRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly colour: number;
}

/** The HP bar's paint plan: its backing, then its fill. */
export interface HpBarPaintOp {
  readonly backing: HpBarRect;
  readonly fill: HpBarRect;
}

/**
 * A creep's HP bar (C3, #181) — the style frame's, replacing the bare pip: an opaque
 * `backing` the bar's full length, and over it a FILL whose LENGTH is the creep's remaining
 * HP and whose colour is its family's `hue`, turning to `lowColour` below `isLowHp`'s
 * threshold — two channels for one fact, length and colour. The frame drew the backing in
 * ink at 0.85; it is opaque here, so its colour is exactly what the palette gate measures
 * the fill and the surfaces against. `centre` is the body's drawn centre — PIXELS, like every
 * plan in this file; `hpFrac` is already clamped to [0, 1] by the VM.
 */
export function hpBarPaintOp(
  centre: { readonly x: number; readonly y: number },
  r: number,
  hpFrac: number,
  hue: number,
  lowColour: number,
  backing: number,
): HpBarPaintOp {
  const w = r * HP_BAR_WIDTH;
  const h = Math.max(HP_BAR_MIN_HEIGHT_PX, r * HP_BAR_HEIGHT);
  const x = centre.x - w / 2;
  const y = centre.y - r * HP_BAR_RISE;
  const b = HP_BAR_BACKING_PX;
  return {
    backing: { x: x - b, y: y - b, w: w + 2 * b, h: h + 2 * b, colour: backing },
    fill: { x, y, w: w * hpFrac, h, colour: isLowHp(hpFrac) ? lowColour : hue },
  };
}

/** One step of the slowed telegraph's paint plan. `'ring'` is the GUARANTEED shape cue
 *  (drawn regardless of `reducedMotion` — Telegraph glossary: a shape cue always) at FULL
 *  opacity (it is the essential cue, and the palette contrast gate treats `slowed` as an
 *  opaque cue — QC round 1); `'pulse'` is the motion cue — a ring whose radius genuinely
 *  OSCILLATES with render time — omitted entirely under reduced motion (WCAG 2.3.3 /
 *  GAG §2, the same posture `tracerPaintOps`/the impact spark already take). */
export type SlowTelegraphOpKind = 'ring' | 'pulse';

export interface SlowTelegraphPaintOp {
  readonly kind: SlowTelegraphOpKind;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly colour: number;
  readonly alpha: number;
}

/** The pulse's oscillation period (MILLISECONDS of render time — the caller owns the
 *  conversion from `renderTimeOf`'s fractional-TICK domain via `MS_PER_TICK`; QC round
 *  2 caught the unconverted-ticks variant, whose real period was 45 s) and radius band.
 *  One full out-and-back every `PULSE_PERIOD_MS`; the radius sweeps `[1.4r, 2.0r]` —
 *  never inside the guaranteed ring, so the motion reads as an aura breathing outward. */
const PULSE_PERIOD_MS = 900;
const PULSE_R_MIN = 1.4;
const PULSE_R_SPAN = 0.6;

/**
 * The slowed telegraph's paint plan for one creep this frame: empty when `slowed` is
 * false (the common case — no allocation-worthy work). A shape cue (`'ring'`, an overlay
 * band around the silhouette in `palette.slowed`, alpha 1) ALWAYS accompanies a live
 * slow; the motion cue (`'pulse'`) is additionally present only when `reducedMotion` is
 * false, its radius a triangle-wave function of `renderTimeMs` (the tracers'
 * `renderTimeOf` seam) so the aura genuinely moves — a static second ring is not a
 * motion cue (QC round 1). A non-finite `renderTimeMs` is treated as 0 (total; the
 * telegraph still renders, merely un-animated for that frame).
 */
/** NOTE the units: `creep.x`/`y` here are PIXELS (the projected centre), NOT the
 *  fixed-point sim units `CreepVM` carries — unlike `tracerPaintOps`, which takes and
 *  emits fixed-point and is converted by its executor. Both signatures are bare
 *  `{x, y}`, and passing the raw `CreepVM` drew this cue off-canvas for two milestones
 *  (Codex, PR #78). */
export function slowTelegraphPaintOps(
  creep: { readonly x: number; readonly y: number; readonly slowed: boolean },
  r: number,
  reducedMotion: boolean,
  slowedColour: number,
  renderTimeMs: number,
): readonly SlowTelegraphPaintOp[] {
  if (!creep.slowed) return [];
  const ops: SlowTelegraphPaintOp[] = [
    { kind: 'ring', x: creep.x, y: creep.y, r: r * 1.4, colour: slowedColour, alpha: 1 },
  ];
  if (!reducedMotion) {
    const t = Number.isFinite(renderTimeMs) ? renderTimeMs : 0;
    // Triangle wave in [0, 1]: 0 → 1 over the first half-period, back over the second.
    const phase = (((t % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
    const wave = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    ops.push({
      kind: 'pulse',
      x: creep.x,
      y: creep.y,
      r: r * (PULSE_R_MIN + PULSE_R_SPAN * wave),
      colour: slowedColour,
      alpha: 0.4,
    });
  }
  return ops;
}

/** One step of the DoT ("poisoned") telegraph's paint plan (M2-S5a). Mirrors the slowed
 *  telegraph's structure exactly, per PLAN.md step 32: HP pips show damage already
 *  TAKEN, but a live DoT record is armor-bypassing damage already SCHEDULED, which no
 *  other surface reveals — so this is the ESSENTIAL cue's posture, not a decorative one.
 *  `'pip'` is the GUARANTEED shape cue (drawn regardless of `reducedMotion`, alpha 1);
 *  `'drift'` is the motion cue — the pips drift outward and fade — omitted entirely
 *  under reduced motion (WCAG 2.3.3 / GAG §2), the same posture `slowTelegraphPaintOps`
 *  already takes.
 *
 *  There is deliberately NO per-tick live-region announcement for a DoT application —
 *  the same "combat chatter would flood AT" rationale the slowed telegraph's Story 3
 *  audit already records, sharpened here: a DoT record can tick every few frames for its
 *  whole duration, so announcing each tick would flood a screen reader with noise that
 *  carries no new decision for the player. The *state* (a creep is currently poisoned)
 *  is what matters, and that state is exactly what this always-on shape cue carries —
 *  not the individual tick. */
export type DotTelegraphOpKind = 'pip' | 'drift';

export interface DotTelegraphPaintOp {
  readonly kind: DotTelegraphOpKind;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly colour: number;
  readonly alpha: number;
}

// Three pips evenly spaced around the silhouette (apex DOWN), each a filled circle.
// The pip RING sits at r*1.8 — deliberately OUTSIDE the slowed ring's
// r*1.4 (`slowTelegraphPaintOps` above), so a creep carrying BOTH statuses reads as two
// concentric cues rather than a muddled composite (PLAN.md step 31). Their DRAWN extents
// separate at ordinary cell sizes but touch at the narrow floor, where `DOT_PIP_MIN_PX`
// holds the pips at 1.5px while the ring stays proportional (QC round 2) — a deliberate
// trade: a visible pip that grazes the ring beats a sub-pixel pip that is not there.
// Canvas y grows DOWNWARD, so apex-down is sin > 0 — the lone pip at 90°, the pair at 210°
// and 330°, up and out to either side. Until the visual pass the triangle pointed UP, to
// match the triangle silhouette (QC round 1 of M2-S5a turned the first draft's apex-down
// set over for that). C3 (#181) moved it back: the HP bar now runs across the top of the
// creep (`hpBarPaintOp`, as the style frame draws it), and a lone pip straight up sat on the
// bar's middle — over the end of its fill, whose LENGTH carries HP, for every HP from about
// a third to two thirds. Apex-down, the pair sits beside the bar and below it, and the lone
// pip under the creep.
const DOT_PIP_ANGLES_DEG = [90, 210, 330] as const;
const DOT_PIP_RADIUS_MUL = 1.8;
const DOT_PIP_SIZE_MUL = 0.18;
/** Floor on a pip's drawn radius, in px. The pips are the GUARANTEED shape cue, so they
 *  may not thin to nothing at the smallest supported cell: at `CELL_PX_MIN_NARROW` (10)
 *  the silhouette radius is 3.5, and `3.5 × 0.18 = 0.63` px would draw a 1.26 px dot —
 *  an essential cue effectively invisible exactly where legibility is tightest (QC
 *  round 1). Mirrors the silhouette's own `Math.max(3, cellPx * 0.35)` clamp. */
const DOT_PIP_MIN_PX = 1.5;

// The drift cue's period and outward travel — its own constants (distinct from the
// pulse's), following the same idiom: a render-time-driven phase in [0, 1), converted to
// geometry, with a `Number.isFinite` guard so a non-finite render time still renders
// (un-animated) rather than throwing. Unlike the pulse's out-and-back triangle wave, the
// drift is a one-way sawtooth — the pips visibly drift OUTWARD from the guaranteed ring
// and fade, then restart from it, which is what "drift outward and fade" (PLAN.md step
// 31) describes; a triangle wave would instead breathe in and out in place.
const DOT_DRIFT_PERIOD_MS = 900;
const DOT_DRIFT_RADIUS_MUL_SPAN = 0.6;

function dotPipPoint(
  cx: number,
  cy: number,
  angleDeg: number,
  radius: number,
): { readonly x: number; readonly y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

/**
 * The DoT telegraph's paint plan for one creep this frame: empty when `poisoned` is
 * false (the common case). Three pips (`'pip'`, filled circles at `r*1.8`, alpha 1)
 * ALWAYS accompany a live DoT record; three drifting-and-fading counterparts (`'drift'`)
 * are additionally present only when `reducedMotion` is false. A non-finite
 * `renderTimeMs` is treated as 0 (total; the telegraph still renders, merely
 * un-animated for that frame) — same posture as `slowTelegraphPaintOps`.
 */
/** Units as `slowTelegraphPaintOps` above: `creep.x`/`y` are PIXELS, not fixed-point. */
export function dotTelegraphPaintOps(
  creep: { readonly x: number; readonly y: number; readonly poisoned: boolean },
  r: number,
  reducedMotion: boolean,
  poisonedColour: number,
  renderTimeMs: number,
): readonly DotTelegraphPaintOp[] {
  if (!creep.poisoned) return [];
  const ops: DotTelegraphPaintOp[] = [];
  for (const angleDeg of DOT_PIP_ANGLES_DEG) {
    const p = dotPipPoint(creep.x, creep.y, angleDeg, r * DOT_PIP_RADIUS_MUL);
    ops.push({
      kind: 'pip',
      x: p.x,
      y: p.y,
      r: Math.max(DOT_PIP_MIN_PX, r * DOT_PIP_SIZE_MUL),
      colour: poisonedColour,
      alpha: 1,
    });
  }
  if (!reducedMotion) {
    const t = Number.isFinite(renderTimeMs) ? renderTimeMs : 0;
    // Sawtooth in [0, 1): 0 (at the guaranteed ring) growing outward to 1 (fully
    // drifted + faded), then snapping back — never negative (the `%` double-mod guard
    // mirrors the pulse's).
    const phase =
      (((t % DOT_DRIFT_PERIOD_MS) + DOT_DRIFT_PERIOD_MS) % DOT_DRIFT_PERIOD_MS) /
      DOT_DRIFT_PERIOD_MS;
    for (const angleDeg of DOT_PIP_ANGLES_DEG) {
      const driftRadius = r * (DOT_PIP_RADIUS_MUL + DOT_DRIFT_RADIUS_MUL_SPAN * phase);
      const p = dotPipPoint(creep.x, creep.y, angleDeg, driftRadius);
      ops.push({
        kind: 'drift',
        x: p.x,
        y: p.y,
        r: Math.max(DOT_PIP_MIN_PX, r * DOT_PIP_SIZE_MUL),
        colour: poisonedColour,
        alpha: 0.5 * (1 - phase), // fades out as it drifts outward
      });
    }
  }
  return ops;
}

/** One step of the stun telegraph's paint plan (M2-S6). `'jolt'` is the GUARANTEED
 *  shape cue: a thick ring at `r×1.15` — drawn regardless of `reducedMotion`, alpha 1
 *  — sitting OUTSIDE the silhouette so the board floor is its contrast partner (see
 *  the builder below for why that is load-bearing, not cosmetic), and reading as
 *  distinct from the slowed ring at r×1.4 by both radius and weight (4 vs 2).
 *  `'flicker'` is the motion cue — a SMALLER ring at `r×0.85`, inside the silhouette,
 *  weight 2, its alpha driven by `renderTimeMs` on the same
 *  triangle wave `slowTelegraphPaintOps` already uses — omitted entirely under reduced
 *  motion (WCAG 2.3.3 / GAG §2), same posture as every other telegraph here. The two
 *  radii MUST differ: an alpha-animated ring at the same radius/colour/width as an
 *  opaque one beneath it is invisible — the animation has nothing to modulate. */
export type StunTelegraphOpKind = 'jolt' | 'flicker';

export interface StunTelegraphPaintOp {
  readonly kind: StunTelegraphOpKind;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly colour: number;
  readonly alpha: number;
}

/**
 * The stun telegraph's paint plan for one creep this frame: empty when `stunned` is
 * false. A shape cue (`'jolt'`, a thick ring in `palette.stunned`, alpha 1) ALWAYS
 * accompanies a live stun.
 *
 * The jolt sits at r×1.15 — OUTSIDE the silhouette, deliberately, and this is the one
 * geometric decision in this builder that is load-bearing rather than aesthetic. It was
 * first drawn INSIDE at r×0.55, which made its contrast partner the creep fill; below
 * `hpFrac` 0.34 that fill was then `palette.creepLowHp`, against which `stunned` measures
 * 1.10:1 — and no colour can fix it (the luminance sandwich derived in
 * `palette.test.ts`), so a stunned creep near death carried no perceivable cue at all.
 * Outside the silhouette the partner is the board floor, exactly like the slow ring
 * (r×1.4) and the DoT pips (r×1.8), and the existing colour clears 3.87:1 there. An
 * essential cue must not depend on the health of the thing it is drawn on. (Since C3 a body
 * keeps its family's hue at any HP, and the jolt's ink edge reads on any body besides.)
 *
 * The cost of sitting outside, recorded rather than left to be discovered: r×1.15 is close
 * to the slowed ring at r×1.4, and at small cell sizes the two merge. At cellPx ~= 29 (a
 * 1000x700 viewport on `field-01`, r ~= 10.2) the jolt's outer edge lands past the slow
 * ring's inner edge, so a slowed+stunned creep reads as one band rather than two rings —
 * and that pair co-occurs constantly, since a slowed creep is the commonest thing for a
 * stun to land on.
 *
 * NO SIZE-INDEPENDENT RADIUS FIXES THIS. Strokes are centred, so clearance needs
 * `jolt_r * r + 4/2 < 1.4 * r - 2/2`, i.e. `jolt_r < 1.4 - 3/r`. That bound TIGHTENS as
 * cells shrink, and `r = max(3, cellPx * 0.35)` floors at 3 — where it is `1.4 - 1 = 0.4`,
 * below the 1.0 an outside ring must exceed by definition, so the band is empty there. (At
 * r ~= 10.2 the bound is 1.104, so r×1.10 would technically clear — by 0.045px, which is
 * sub-pixel and still reads as merged. A coincidence at one size, not a fix.) A real fix
 * moves the slowed ring's 1.4 or the stroke weights — a cue-radius layout pass across every
 * telegraph family, still owed (the CUE-RADIUS ORDERING block below). It is the lesser of the
 * two defects: the low-HP invisibility this replaced applied to EVERY stunned creep below
 * 34% HP at every cell size, and stun towers deal damage, so their targets trend that way.
 *
 * The motion cue (`'flicker'`) stays INSIDE at r×0.85 and is additionally present
 * only when `reducedMotion` is false, its alpha a triangle-wave function of
 * `renderTimeMs` (the SAME `PULSE_PERIOD_MS`/double-mod-guard `slowTelegraphPaintOps`
 * uses). A non-finite `renderTimeMs` is treated as 0 (total; still renders,
 * un-animated for that frame) — same posture as `slowTelegraphPaintOps`. It lies on the
 * creep's own body, which since C3 wears its family's hue — and no one colour clears every
 * family and the floor (the luminance sandwich `palette.test.ts` derives) — so it carries an
 * ink under-stroke like the guaranteed cues (`drawCreepCues`), and the gate on it is ink's.
 */
/** Units as `slowTelegraphPaintOps`/`dotTelegraphPaintOps` above: `creep.x`/`y` are
 *  PIXELS, not fixed-point — the same mistake `board-draw.ts`'s comment records as
 *  having silently broken two milestones' worth of cues. */
export function stunTelegraphPaintOps(
  creep: { readonly x: number; readonly y: number; readonly stunned: boolean },
  r: number,
  reducedMotion: boolean,
  stunnedColour: number,
  renderTimeMs: number,
): readonly StunTelegraphPaintOp[] {
  if (!creep.stunned) return [];
  const ops: StunTelegraphPaintOp[] = [
    { kind: 'jolt', x: creep.x, y: creep.y, r: r * 1.15, colour: stunnedColour, alpha: 1 },
  ];
  if (!reducedMotion) {
    const t = Number.isFinite(renderTimeMs) ? renderTimeMs : 0;
    // Triangle wave in [0, 1], identical shape to the slow pulse's own.
    const phase = (((t % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
    const wave = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    ops.push({
      kind: 'flicker',
      x: creep.x,
      y: creep.y,
      r: r * 0.85,
      colour: stunnedColour,
      alpha: 0.15 + 0.7 * wave,
    });
  }
  return ops;
}

/** One step of the ward cue's paint plan (M2-S6): a single opaque stroked ring at
 *  `r×2.2`, deliberately OUTSIDE the slow pulse's r×2.0 ceiling so a warded creep's
 *  cue never gets mistaken for an active slow. A ward is NOT a timed status (see
 *  CONTEXT.md's Ward term) — it is a catalog-derived, always-on fact about the creep
 *  (`CreepVM.warded`), so unlike every other telegraph here it carries no motion cue,
 *  takes no `renderTimeMs`, and has no reduced-motion branch. Drawn opaque
 *  deliberately: `palette.test.ts`'s contrast gate checks the SOURCE colour, which
 *  proves the rendered ratio only when nothing composites it. */
export type WardOpKind = 'ward';

export interface WardPaintOp {
  readonly kind: WardOpKind;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly colour: number;
  readonly alpha: number;
}

/** Units as every other builder above: `creep.x`/`y` are PIXELS (the projected
 *  centre), never fixed-point. */
export function wardPaintOps(
  creep: { readonly x: number; readonly y: number; readonly warded: boolean },
  r: number,
  wardedColour: number,
): readonly WardPaintOp[] {
  if (!creep.warded) return [];
  return [{ kind: 'ward', x: creep.x, y: creep.y, r: r * 2.2, colour: wardedColour, alpha: 1 }];
}

// THE CUE-RADIUS ORDERING (read before changing any number here). Every cue in this file is
// centred on the creep's BODY — a flyer's lifted body (C4, #181) — and every one but the HP
// bar is a circle, so a cue's radius BAND is what decides whether it collides, regardless of
// which angular sector it occupies. `r` is the creep's own radius, its family's size step
// included (`creepRadius`, `creep-art.ts`), so every band scales with the body it surrounds:
//   flicker (stun) r×0.85            timed, motion — the one cue inside the silhouette,
//                                    drawn on the creep's own body
//   jolt (stun)    r×1.15            timed — GUARANTEED
//   ring (slow)    r×1.40            timed — GUARANTEED
//   pip (DoT)      r×1.80            timed — GUARANTEED, a FILLED disc of radius
//                                    max(1.5px, 0.18r), so its drawn extent is r×1.98
//                                    ordinarily and r×2.23 at the narrow floor
//   pulse (slow)   r×2.00            timed, motion
//   ward           r×2.20            CATALOG-derived — deliberately outside the timed band
//   drift (DoT)    r×1.80 → r×2.40   timed, motion — the outermost TIMED cue, and the
//                                    only one that SWEEPS: its pips travel outward from
//                                    the guaranteed ring, crossing the pulse and the
//                                    ward on the way, and fade to alpha 0 as they go.
//                                    Same disc radius as the pip above, so the drawn
//                                    extent at the crest is r×2.58 ordinarily and
//                                    r×2.83 at the narrow floor (r = 3.5), r×2.90 at
//                                    the defensive `max(3, …)` clamp.
//   HP bar         r×1.43 → r×1.75   above the centre, `HP_BAR_WIDTH` radii wide — not a
//                                    ring: see below.
//
// THE DoT CUES ARE PART OF THIS LIST (#126). An earlier version of this block enumerated
// only the ring-shaped cues and read as exhaustive; it was not, and the omission was
// load-bearing — the M2-S7 accessibility audit transcribed "the airborne cue sits well
// outside every timed ring" from it, and the drift is a timed cue that reaches further than
// every ring here. Its extent is a RATIO PLUS A PIXEL FLOOR (`DOT_PIP_MIN_PX`), so it grows
// relative to `r` as cells shrink; the same is true of every stroke width and the ink edge
// below, which is why the stun note above finds the jolt and the slow ring merging at small
// cells. No size-independent radius fixes that class of tightness.
//
// THE INK EDGE (C3, #181). Each guaranteed cue — the jolt, the slow ring, the pips and the
// ward — and the flicker carry an ink under-stroke `CUE_INK_PX` wider on each side
// (`drawCreepCues`, `board-draw.ts`), so every band above DRAWS a pixel wider each way than
// its stroke. It is what makes a cue read on every surface it lands on: its colour against
// the dark floor and plate, its ink edge against a light tower head, a rim or another creep's
// body (`palette.test.ts` gates both halves). Every ring's ink is drawn before any ring's
// colour, so no ring's ink edge covers another ring's colour — a slowed and stunned creep at a
// small cell keeps its slow ring where the jolt's wider ink would otherwise have buried it.
// The HP bars' opaque backings and the pips' ink discs are drawn after the rings and lie over
// them, a neighbour's included, by design; the pips' inks go down before every pip, so none
// covers a pip. The motion cues — the pulse and the drift — carry none: they fade by design
// and are gated as non-essential.
//
// THE HP BAR (C3) sits across the top of the band, as the style frame draws it, its fill
// from r×1.75 above the centre down to `HP_BAR_HEIGHT` radii (or `HP_BAR_MIN_HEIGHT_PX`)
// below that, `HP_BAR_WIDTH` radii wide, its backing a pixel past it all round. It is drawn
// OVER the rings, so the arc of a ring under it is hidden and the ring reads around the rest,
// and UNDER the pips, so the three guaranteed pips are whole wherever they land. That is
// why the pips point DOWN (`DOT_PIP_ANGLES_DEG`): the pair at 210° and 330° sits beyond the
// bar's ends and below it, the lone pip under the creep, and from a 14px cell none touches
// the fill whose length carries HP (from 20px, the swarm's neither). Below that, where the
// pips' 1.5px floor and the bar's 3px height are largest against `r`, the pair's ink discs
// reach over the bar's lower corners and into its two ends — at the narrow floor up to a
// tenth of its length from each end for a normal creep and a fifth for the swarm, never its
// middle three fifths (`creep-paint.test.ts` measures it). The pips stay whole: they are the
// one channel a poison has, where the bar's colour turn backs up its length.
//
// THE WINGS (C4) are not a cue in this file at all. Until C4 the airborne cue was a chevron
// drawn here, DETACHED from its creep, and it had to clear every ring: its apex sat r×3.4
// above the centre — outside even the drift (#126) — which put it in the cell to the NORTH,
// on whatever tower stood there, and mirrored it below a creep near the canvas top. The
// wings are part of a flyer's BODY art now (`CREEP_WINGS`, `creep-art.ts`), baked with it
// and drawn in the creeps' paint layer, under every cue: they reach r×2.05 out to each side
// and r×0.75 above the body's centre, the rings cross them, and each ring's ink edge
// separates it from the light wing under it. They differ from every ring in SHAPE — two
// straight-edged triangles fixed to the body's sides, never a closed curve. The wings no longer
// float a cell away, but a flyer's cues centre on its lifted body, so its HP bar rides about a
// cell above its true position, over the cell to its north; its opaque backing reads on
// whatever is there.
//
// THE CO-OCCURRENCE IS A VM CONTRACT, NOT A CONTENT FACT (#126 ship-review). `poisoned`,
// `stunned`, `slowed` and `airborne` are independent booleans on the render VM, so this
// module draws any of them together on demand; it is keyed on the VM, never on a catalog.
// In TODAY'S shipped rulesets some pairings are UNREACHABLE — every `dot` effect belongs to a
// GROUND-domain tower, and `combat.ts` rejects an impact whose domain does not cover the
// target's, so no shipped tower can poison a flyer — but asserting a pairing safe because
// content happens not to reach it would pin content domain assignments inside the renderer.
// The geometry is real either way.
