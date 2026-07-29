// creep-paint.ts — pure creep-silhouette + slow-telegraph paint-plan geometry (M2-S3).
// Kept in a Phaser-free module (the `board-cells.ts`/`tracers.ts` precedent) so both are
// unit-testable; `scene.ts` is a thin executor of exactly these plans (coverage-excluded,
// WebGL). No sim import: keyed purely on the catalog id string the render VM already
// carries (`CreepVM.creepId`).

/** The silhouette shapes the scene can draw. `'triangle'` is the pre-M2-S3 creep shape;
 *  `'diamond'` is `fast`'s visibly-distinct-at-cell-scale shape. An id this build's
 *  catalog doesn't recognize draws `'triangle'` too (TOTAL — never throw; a forged/future
 *  content id must still render something, per the `tower.unknown.name` precedent). */
export type CreepShape = 'triangle' | 'diamond';

const CREEP_SHAPES: Readonly<Partial<Record<string, CreepShape>>> = {
  normal: 'triangle',
  fast: 'diamond',
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
