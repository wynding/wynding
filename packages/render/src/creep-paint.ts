// creep-paint.ts — pure creep-silhouette + slow-telegraph paint-plan geometry (M2-S3).
// Kept in a Phaser-free module (the `board-cells.ts`/`tracers.ts` precedent) so both are
// unit-testable; `scene.ts` is a thin executor of exactly these plans (coverage-excluded,
// WebGL). No sim import: keyed purely on the catalog id string the render VM already
// carries (`CreepVM.creepId`).

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
 *  precedent).
 *
 *  `flying` (M2-S7) is DELIBERATELY ABSENT from the table below, and is the first
 *  shipped creep that is. Its distinguishing axis is DOMAIN, not kind, and domain has
 *  its own always-on shape cue — `airborneCuePaintOps`' wingspan — so giving it a sixth
 *  base silhouette would encode the same fact twice and spend the shape vocabulary on
 *  it. That is the same composability argument S10 depends on: `armored-flyer` must
 *  read as armored AND airborne, which it does by keeping `'hexagon'` and gaining the
 *  wingspan. A per-domain base shape would make that combination unrepresentable.
 *  The consequence, stated because it is a real one (ship-review, M2-S7): at the
 *  silhouette itself `flying` and `normal` are identical, so the wingspan is the ONLY
 *  channel separating them — which is exactly why `airborneCuePaintOps` mirrors the cue
 *  below the creep rather than letting it leave the viewport (Codex P2, PR #87). It
 *  draws a cell away from the creep, above by default and below at the top edge.
 *
 *  `armored-flyer` and `boss` (M2-S10) are the composability proof this file's header
 *  argues for, exercised rather than merely asserted: both reuse `'hexagon'` — no third
 *  role/domain-driven shape value — and gain distinctness from OTHER independent axes
 *  instead. `armored-flyer` reads as armored (the hexagon) AND airborne (the wingspan,
 *  `airborneCuePaintOps`), the exact combination this header already names. `boss` reads
 *  as armored (the hexagon) AND larger (`BOSS_SCALE` in `board-draw.ts`) AND warded (it
 *  is stun-immune, `wardPaintOps`) — role stays a pure axis, so a future boss VARIANT
 *  would compose the same way rather than needing a SIXTH silhouette. (Counted against
 *  the union below, which has five members. Two docstrings in this file said "fourth"
 *  and one said "sixth"; the S7 accessibility audit copied the wrong one — #126.) */
export type CreepShape = 'triangle' | 'diamond' | 'square' | 'hexagon' | 'pentagon';

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

/** One creep silhouette + HP-pip paint step, keyed on `creepId`'s shape. `r` is the
 *  silhouette's half-size (the scene's existing `max(3, cellPx * 0.35)` radius); `hpFrac`
 *  drives the pip's length (dual cue with `colour`, unchanged from pre-M2-S3). */
export interface CreepSilhouettePaintOp {
  readonly shape: CreepShape;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly colour: number;
  readonly hpFrac: number;
}

export function creepSilhouettePaintOp(
  creepId: string,
  x: number,
  y: number,
  r: number,
  colour: number,
  hpFrac: number,
): CreepSilhouettePaintOp {
  return { shape: creepShapeFor(creepId), x, y, r, colour, hpFrac };
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

// Three pips evenly spaced around the silhouette (apex up), each a filled circle.
// The pip RING sits at r*1.8 — deliberately OUTSIDE the slowed ring's
// r*1.4 (`slowTelegraphPaintOps` above), so a creep carrying BOTH statuses reads as two
// concentric cues rather than a muddled composite (PLAN.md step 31). Their DRAWN extents
// separate at ordinary cell sizes but touch at the narrow floor, where `DOT_PIP_MIN_PX`
// holds the pips at 1.5px while the ring stays proportional (QC round 2) — a deliberate
// trade: a visible pip that grazes the ring beats a sub-pixel pip that is not there.
// Canvas y grows DOWNWARD, so apex-up is sin < 0 — 270°, not 90° (QC round 1: the
// first draft's [90, 210, 330] put the lone pip at the BOTTOM, making this the one cue
// pointing opposite the triangle silhouette and `scene.ts`'s hexagon, which both offset
// by -90° for exactly this reason).
const DOT_PIP_ANGLES_DEG = [270, 30, 150] as const;
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
 * `hpFrac` 0.34 that fill is `palette.creepLowHp`, against which `stunned` measures
 * 1.10:1 — and no colour can fix it (the luminance sandwich derived in
 * `palette.test.ts`), so a stunned creep near death carried no perceivable cue at all.
 * Outside the silhouette the partner is the board floor, exactly like the slow ring
 * (r×1.4) and the DoT pips (r×1.8), and the existing colour clears 3.87:1 there. An
 * essential cue must not depend on the health of the thing it is drawn on.
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
 * moves the slowed ring's 1.4 or the stroke weights, which is exactly the cue-radius
 * layout pass `wardPaintOps`' own note already defers. It is the lesser of the
 * two defects: the low-HP invisibility this replaced applied to EVERY stunned creep below
 * 34% HP at every cell size, and stun towers deal damage, so their targets trend that way.
 *
 * The motion cue (`'flicker'`) stays INSIDE at r×0.85 and is additionally present
 * only when `reducedMotion` is false, its alpha a triangle-wave function of
 * `renderTimeMs` (the SAME `PULSE_PERIOD_MS`/double-mod-guard `slowTelegraphPaintOps`
 * uses). A non-finite `renderTimeMs` is treated as 0 (total; still renders,
 * un-animated for that frame) — same posture as `slowTelegraphPaintOps`.
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

/** The airborne cue's only op kind — a wing chevron. See {@link airborneCuePaintOps}. */
export type AirborneOpKind = 'wingspan';

export interface AirborneCuePaintOp {
  readonly kind: AirborneOpKind;
  readonly apexX: number;
  readonly apexY: number;
  readonly leftX: number;
  readonly leftY: number;
  readonly rightX: number;
  readonly rightY: number;
  readonly colour: number;
  readonly alpha: number;
}

// THE CUE-RADIUS ORDERING (read before changing any number here). Every other cue in
// this file is a circle centred on the creep, so a cue's radius BAND is what decides
// whether it collides, regardless of which angular sector it occupies:
//   jolt (stun)    r×1.15            timed
//   ring (slow)    r×1.40            timed
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
//   airborne       r×3.22+           CATALOG-derived — outside the drift, for the same
//                                    reason it is outside the ward
//
// THE DoT CUES ARE PART OF THIS LIST (#126). An earlier version of this block enumerated
// only the five ring-shaped cues and read as exhaustive; it was not, and the omission was
// load-bearing rather than cosmetic — the M2-S7 accessibility audit transcribed "the
// airborne cue sits well outside every timed ring" from it, and the drift is a timed cue
// that reaches further than every ring here. Its extent is a RATIO PLUS A PIXEL FLOOR
// (`DOT_PIP_MIN_PX`), so it grows relative to `r` as cells shrink, which is exactly where
// the airborne cue's own clearance was tightest.
//
// THE CO-OCCURRENCE IS A VM CONTRACT, NOT A CONTENT FACT — and the distinction is the
// whole point (#126 ship-review). `poisoned` and `airborne` are independent booleans on the
// render VM, so this module must draw both together on demand; it is keyed on the VM, never
// on a catalog. In TODAY'S shipped rulesets that pairing is UNREACHABLE: every `dot` effect
// belongs to a GROUND-domain tower (`venom` in `wynding-core.json` and `catalog-40x40.json`,
// `stress-venom` in `stress-40x40.json` — one DoT source each, all `"domain": "ground"`),
// and `combat.ts` rejects any impact whose domain does not cover the target's, so no shipped
// tower can poison a flyer. `slow` is the both-domain effect since S7 — the ordering note
// below says so correctly, and an earlier draft of THIS paragraph misattributed that
// property to `venom`.
//
// So the clearance below is DEFENSIVE, and deliberately so. The alternative — asserting the
// pair is safe because shipped DoT sources happen to be ground-only — would pin content
// domain assignments inside a render test, which is precisely the cross-layer rot this
// comment block exists to correct. A ruleset that ever ships an air-capable DoT would then
// silently reintroduce a dual-encoding defect the renderer had "proved" impossible. The
// overlap the geometry produces is real regardless of who can currently trigger it.
//
// An earlier draft placed the apex at r×1.10 and the wingtips at (±1.3r, −0.5r), i.e.
// radius r×1.393 — sitting ON the slow ring (1.4) and crossing the jolt ring (1.15),
// the exact annulus this file's stun note derives a clearance rule for (ship-review,
// M2-S7). That is reachable on this story's own headline path: S7 widened `slow` to
// both-domain SO slow can land on flyers, and `story-flying-wave.test.ts` asserts a
// slowed flyer — which would have drawn cyan wingtips tangent to a sky-blue slow ring,
// the two nearest hues in the palette.
//
// `wardPaintOps` set the precedent: a catalog-derived, non-timed cue sits OUTSIDE the
// timed band so it can never be misread as an active status. The airborne cue is the
// same class, so it goes outside the ward — and outside the drift, which reaches further
// than the ward does — in turn. Every point below is at radius ≥ r×3.22 (the wingtips,
// the apex is r×3.4), clearing the drift's drawn extent at every supported cell size.
//
// THE APEX MOVED OUT FROM r×2.9 TO r×3.4 (#126), because at r×2.9 it did not clear the
// drift. That is the whole derivation, and it is MEASURED rather than reasoned about, by
// `creep-paint.test.ts`'s "clears the DoT drift" case, which walks the sawtooth and prints
// the worst gap between a drift pip's filled disc and the chevron's 2px-wide strokes:
//
//     r = 3.5 (CELL_PX_MIN_NARROW = 10, the supported floor)   was −0.838px → now +0.823px
//     r = 3   (the defensive `max(3, …)` clamp)                was −1.075px → now +0.348px
//
// Those are the values the test PRINTS, so re-running it reproduces this table exactly. The
// test samples the 900ms sawtooth at 1ms steps, so its worst sample is phase 899/900 rather
// than the analytic crest at phase → 1; the crest bound is fractionally tighter (−0.840 →
// +0.820 at r = 3.5, −1.077 → +0.346 at r = 3) and is what the sign of the result rests on.
// Both are quoted because a reader checking this block against the console must not find a
// third set of numbers.
//
// The glyph's SHAPE is untouched — half-span 0.9r, tips 0.3r below the apex, both exactly
// as before. Only its standoff from the creep centre changed, so every argument this block
// makes about shape distinctness survives verbatim; the drift, not a reshape, is what moved
// it. The alternative lever (pulling the drift in) needed `DOT_DRIFT_RADIUS_MUL_SPAN` cut
// from 0.6 to 0.2 to clear the same floor — 0.6px of travel at r = 3, which is not a
// motion cue any more.
//
// TWO RESIDUALS, stated rather than hidden — both belong to the deferred cue-radius
// layout pass the stun note names, not to a fourth cue inventing its own scheme:
//
// (1) The clearances are RATIOS while `r` floors at 3px and the stroke/pip widths do not,
//     so the tightest pair is whichever one the pixel floors bite hardest — and #126 MOVED
//     which pair that is. It used to be airborne-vs-ward, ~1.2px at the clamp; with the tips
//     now at r×3.23 that gap is ≈3.1px and no longer the constraint. The tight pair is now
//     airborne-vs-drift at +0.348px (r = 3) / +0.823px (r = 3.5) — the numbers the test
//     above prints, and the reason it prints them rather than merely asserting a sign. No
//     size-independent radius fixes this class of tightness; only the layout pass can.
// (2) THIS ANALYSIS COVERS SAME-CREEP COLLISIONS ONLY. With `r = cellPx × 0.35`
//     (`board-draw.ts`), an apex at r×3.4 sits ≈1.19 × cellPx above the creep centre —
//     i.e. the chevron renders in the cell to the NORTH, where ANOTHER creep's
//     silhouette, HP pip or telegraph rings may already be. On the shipped board every
//     creep walks the row-11 lane, so a flyer's cue lands across row 10. That is a real
//     trade, not an oversight: the drift already reaches r×2.83 at the narrow floor, so no
//     radius both clears every same-creep cue AND stays inside the cell. The #126 move
//     from r×2.9 to r×3.4 deepens this residual without changing its CHARACTER — 1.19
//     cellPx still lands in the row-10 cell (leaving it would take 1.5), so it is the same
//     one cell, further into it. SHAPE still carries the load there,
//     not colour: the cell it lands in is usually a tower footprint, so no footprint mark
//     may be this glyph — `antiair` (the tower that co-occurs with flyers by definition)
//     therefore draws the `'arrow'` mark, a shafted arrow, rather than the bare "^" it
//     first shipped as (see `drawArrow` in `board-draw.ts`). The airborne colour is
//     additionally contrast-gated against `tower` as well as the floor
//     (`palette.test.ts`) so the two remain separable once overlaid.
//     The same offset puts the chevron OFF-BOARD for a flyer on row 0, on a board whose
//     opening sits on the top border — legal in principle, unreachable on the shipped
//     board (every creep walks the row-11 lane), and called out here because an earlier
//     draft of this block claimed to have enumerated the adjacent-cell cases and had
//     only enumerated the interior ones.
const AIRBORNE_APEX_R_MUL = 3.4; // straight above centre — beyond every cue, timed or not
const AIRBORNE_WING_Y_MUL = 3.1; // tips sit 0.3r lower than the apex, so the chevron reads as wings
// Half-span. NARROWER than the silhouette's own half-width of r, so the tips clear the
// silhouette VERTICALLY, never laterally. The tip radius √(0.9² + 3.1²) ≈ r×3.23 is the
// glyph's MINIMUM radius, not its maximum: the apex at r×3.4 is its furthest point, and
// with the apex this far out the nearest point of either stroke to the creep centre is
// the tip itself (at r×2.9 it was an interior point of the stroke, at r×2.751).
const AIRBORNE_WING_SPAN_MUL = 0.9;

/**
 * The airborne cue's paint plan (M2-S7): a wing chevron — two strokes fanning DOWN and
 * out from an apex above the silhouette's top vertex to tips that are NARROWER than the
 * silhouette, not beyond its sides (`AIRBORNE_WING_SPAN_MUL` puts them at `x ± 0.9r`
 * against a half-width of `r`, so the glyph clears the silhouette VERTICALLY and never
 * laterally — #126; the earlier "tips beyond its sides" is what the S7 accessibility
 * audit transcribed). Layered OVER
 * whichever base silhouette `creepShapeFor` already draws (`creepId` is untouched by
 * this module; the airborne cue is a wholly independent paint plan, composed alongside
 * it, never a SIXTH mutually-exclusive `CreepShape`). That independence is exactly why
 * it composes: `armored-flyer` (S10) draws the hexagon from `creepSilhouettePaintOp`
 * AND this wingspan, so it reads as armored *and* airborne at once, which a single
 * id-keyed shape could never express.
 *
 * Like `wardPaintOps`, this is a CATALOG-derived cue (`CreepVM.domain === 'air'`), NOT a
 * timed status (see CONTEXT.md's Domain entry) — so it takes no `renderTimeMs`, has no
 * reduced-motion branch, and carries no motion cue at all. It floats clear ABOVE the
 * creep, every point at radius ≥ `r×3.22` — outside the silhouette, outside all three
 * timed telegraph rings, outside the ward, and outside the DoT drift's drawn extent at
 * every supported cell size (#126 moved the apex out from `r×2.9` for that last one; the
 * measurement is `creep-paint.test.ts`'s "clears the DoT drift" case). See the cue-radius
 * ordering derived at the constants ABOVE (this docstring follows them, and said "below"
 * until #126); that clearance is the load-bearing part, not the glyph. It keeps
 * the same posture `wardPaintOps`' own note explains (an essential cue must not depend
 * on the health of the thing it is drawn on) and adds the one this file's stun note
 * shows matters just as much: it must not be drawn through another cue either. A
 * genuinely different SHAPE from every ring/pip telegraph above (line strokes, not a
 * circle) AND from every tower footprint mark it can land on top of (`tower-paint.ts` —
 * `antiair` owns `'arrow'`, a shafted arrow, precisely so this bare "^" stays unique),
 * never colour alone (ADR 0003).
 *
 * Units as every other builder above: `creep.x`/`y` are PIXELS (the projected centre),
 * never fixed-point.
 */
export function airborneCuePaintOps(
  creep: { readonly x: number; readonly y: number; readonly airborne: boolean },
  r: number,
  airborneColour: number,
  minY = Number.NEGATIVE_INFINITY,
): readonly AirborneCuePaintOp[] {
  if (!creep.airborne) return [];
  // FLIP BELOW WHEN THE CUE WOULD LEAVE THE VIEWPORT (Codex P2, PR #87). The offsets
  // here are upward, and a board may legally put BOTH openings on row 0 — entrance
  // (x,0) → exit (y,0) is equal-row, so P1's axis-alignment gate admits it — which puts
  // a flyer's centre half a cell below the top edge and the whole wingspan off-canvas
  // for its entire route. Not cosmetic: `flying` deliberately shares `normal`'s base
  // silhouette (see `CreepShape` above), so this cue is the ONLY channel telling air
  // from ground, and ADR 0003 requires the shape cue to be PRESENT, not merely
  // specified. Mirroring preserves every radius — and so every clearance derived in the
  // CUE-RADIUS ORDERING block — because only the sign changes.
  const flip = creep.y - r * AIRBORNE_APEX_R_MUL < minY;
  const sign = flip ? 1 : -1;
  const apexY = creep.y + sign * r * AIRBORNE_APEX_R_MUL;
  const wingY = creep.y + sign * r * AIRBORNE_WING_Y_MUL;
  return [
    {
      kind: 'wingspan',
      apexX: creep.x,
      apexY,
      leftX: creep.x - r * AIRBORNE_WING_SPAN_MUL,
      leftY: wingY,
      rightX: creep.x + r * AIRBORNE_WING_SPAN_MUL,
      rightY: wingY,
      colour: airborneColour,
      alpha: 1,
    },
  ];
}
