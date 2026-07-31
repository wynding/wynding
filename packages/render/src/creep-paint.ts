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
 *  point, the diamond's pinch, and the square's blockiness at cell scale. An id this
 *  build's catalog doesn't recognize draws `'triangle'` too (TOTAL — never throw; a
 *  forged/future content id must still render something, per the `tower.unknown.name`
 *  precedent). */
export type CreepShape = 'triangle' | 'diamond' | 'square' | 'hexagon';

const CREEP_SHAPES: Readonly<Partial<Record<string, CreepShape>>> = {
  normal: 'triangle',
  fast: 'diamond',
  swarm: 'square',
  armored: 'hexagon',
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
