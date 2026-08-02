// creep-paint.test.ts — the silhouette/telegraph paint-plan (M2-S3), asserted at the REAL
// supported floor (568×320 → CELL_PX_MIN_NARROW = 10px cells, Codex R1-12) rather than the
// 12px the risk-of-record originally assumed.

import { describe, it, expect } from 'vitest';
import {
  creepShapeFor,
  creepSilhouettePaintOp,
  slowTelegraphPaintOps,
  dotTelegraphPaintOps,
} from './creep-paint';
import { resolvePalette } from './palette';

// The narrow floor's cell size (apps/web/e2e/compact.spec.ts's CELL_PX_MIN_NARROW) — the
// silhouette radius the scene actually draws at that floor (`max(3, cellPx * 0.35)`).
const CELL_PX_MIN_NARROW = 10;
const R = Math.max(3, CELL_PX_MIN_NARROW * 0.35);

describe('creepShapeFor — id-keyed silhouette (total over any string)', () => {
  it('keeps the triangle for normal', () => {
    expect(creepShapeFor('normal')).toBe('triangle');
  });
  it('gives fast a visibly distinct diamond', () => {
    expect(creepShapeFor('fast')).toBe('diamond');
  });
  it('gives swarm a visibly distinct square (M2-S4a)', () => {
    expect(creepShapeFor('swarm')).toBe('square');
  });
  it('gives armored a visibly distinct hexagon (M2-S5a)', () => {
    expect(creepShapeFor('armored')).toBe('hexagon');
  });
  it('falls back to the default triangle for an unknown id — never throws', () => {
    expect(creepShapeFor('__proto__')).toBe('triangle');
    expect(creepShapeFor('')).toBe('triangle');
  });
});

describe('creepSilhouettePaintOp', () => {
  it('carries the id-keyed shape plus the passed-through geometry/colour/hpFrac', () => {
    const op = creepSilhouettePaintOp('fast', 10, 20, R, 0xf0e442, 0.5);
    expect(op).toEqual({ shape: 'diamond', x: 10, y: 20, r: R, colour: 0xf0e442, hpFrac: 0.5 });
  });
});

describe('slowTelegraphPaintOps', () => {
  it('is empty when the creep is not slowed', () => {
    expect(slowTelegraphPaintOps({ x: 0, y: 0, slowed: false }, R, false, 0x56b4e9, 0)).toEqual([]);
  });

  it('draws an OPAQUE ring (the GUARANTEED shape cue) plus a pulse when motion is not reduced', () => {
    const ops = slowTelegraphPaintOps({ x: 5, y: 6, slowed: true }, R, false, 0x56b4e9, 0);
    expect(ops.map((o) => o.kind)).toEqual(['ring', 'pulse']);
    for (const op of ops) {
      expect(op.colour).toBe(0x56b4e9);
      expect(op.x).toBe(5);
      expect(op.y).toBe(6);
    }
    // The essential cue is fully opaque — the palette contrast gate treats `slowed` as an
    // opaque cue, and this is what keeps that treatment honest (QC round 1).
    expect(ops[0]!.alpha).toBe(1);
  });

  it('the pulse genuinely MOVES: its radius differs across render times and never dips inside the ring', () => {
    const at = (t: number) =>
      slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, false, 0x56b4e9, t)[1]!;
    const r0 = at(0).r; // wave trough
    const rMid = at(450).r; // wave crest (half the 900ms period)
    const rWrap = at(900).r; // full period — back to the trough
    expect(rMid).toBeGreaterThan(r0); // it moves
    expect(rWrap).toBeCloseTo(r0, 10); // and it is periodic, not drifting
    const [ring] = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, false, 0x56b4e9, 450);
    expect(rMid).toBeGreaterThanOrEqual(ring!.r); // the aura breathes OUTWARD from the ring
  });

  it('a non-finite render time is total: the telegraph still renders, un-animated', () => {
    const ops = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, false, 0x56b4e9, NaN);
    expect(ops.map((o) => o.kind)).toEqual(['ring', 'pulse']);
    expect(ops[1]!.r).toBe(
      slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, false, 0x56b4e9, 0)[1]!.r,
    );
  });

  it('keeps the ring but drops the pulse under reduced motion (WCAG 2.3.3 / GAG §2), and the ring is time-invariant', () => {
    const opsA = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, true, 0x56b4e9, 0);
    const opsB = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, true, 0x56b4e9, 450);
    expect(opsA.map((o) => o.kind)).toEqual(['ring']);
    expect(opsB).toEqual(opsA); // the remaining cue does not move
  });

  it('at the narrow 10px-cell floor, the ring radius is legibly distinct from the silhouette radius (≥ 1px)', () => {
    const [ring] = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, true, 0x56b4e9, 0);
    expect(ring).toBeDefined();
    expect(ring!.r - R).toBeGreaterThanOrEqual(1);
  });
});

// Driven from the REAL palette (not a hand-copied literal, QC round — a hand-copied
// constant is asserted right back out and never notices a palette change; `palette.ts`
// changed `poisoned` since this file was first written and nothing here caught it).
const POISONED = resolvePalette('default').poisoned;

// Distance from the creep centre to a pip's drawn point, for asserting the essential
// cue's ring radius (`Math.hypot`, since the ops are already resolved to x/y points).
function pipDistance(
  op: { readonly x: number; readonly y: number },
  cx: number,
  cy: number,
): number {
  return Math.hypot(op.x - cx, op.y - cy);
}

describe('dotTelegraphPaintOps (M2-S5a) — the DoT ("poisoned") telegraph, mirroring slowTelegraphPaintOps', () => {
  it('is empty when the creep is not poisoned', () => {
    expect(dotTelegraphPaintOps({ x: 0, y: 0, poisoned: false }, R, false, POISONED, 0)).toEqual(
      [],
    );
  });

  it('draws three OPAQUE pips (the GUARANTEED shape cue) plus three drift ops when motion is not reduced', () => {
    const ops = dotTelegraphPaintOps({ x: 5, y: 6, poisoned: true }, R, false, POISONED, 0);
    expect(ops.map((o) => o.kind)).toEqual(['pip', 'pip', 'pip', 'drift', 'drift', 'drift']);
    for (const op of ops) expect(op.colour).toBe(POISONED);
    // The essential cue is fully opaque — mirrors the slowed ring's alpha-1 posture,
    // which is what keeps the palette contrast gate's opaque treatment of `poisoned`
    // honest.
    for (const pip of ops.slice(0, 3)) expect(pip.alpha).toBe(1);
  });

  it('places the three guaranteed pips at r×1.8 from the creep centre — OUTSIDE the slowed ring at r×1.4, so both statuses stay legible together', () => {
    const [p1, p2, p3] = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 0);
    for (const p of [p1, p2, p3]) {
      expect(pipDistance(p!, 0, 0)).toBeCloseTo(R * 1.8, 6);
    }
    const [slowRing] = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, true, 0x56b4e9, 0);
    // The REAL returned pip distance vs the REAL returned ring radius — not a literal
    // the test itself computed on both sides (QC round: `R * 1.8 > slowRing.r` degenerates
    // to "is 6.3 > 4.9", true independent of what either function actually returns).
    expect(pipDistance(p1!, 0, 0)).toBeGreaterThan(slowRing!.r);
  });

  it('the drift cue genuinely MOVES outward and fades: distance grows and alpha shrinks across render times', () => {
    const at = (t: number) =>
      dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, false, POISONED, t)[3]!;
    const d0 = at(0);
    const dMid = at(450);
    expect(pipDistance(dMid, 0, 0)).toBeGreaterThan(pipDistance(d0, 0, 0)); // it drifts outward
    expect(dMid.alpha).toBeLessThan(d0.alpha); // and it fades
  });

  it('a non-finite render time is total: the telegraph still renders, un-animated', () => {
    const ops = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, false, POISONED, NaN);
    expect(ops.map((o) => o.kind)).toEqual(['pip', 'pip', 'pip', 'drift', 'drift', 'drift']);
    expect(ops[3]).toEqual(
      dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, false, POISONED, 0)[3],
    );
  });

  it('keeps the three pips but drops the drift cue under reduced motion (WCAG 2.3.3 / GAG §2), and the pips are time-invariant', () => {
    const opsA = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 0);
    const opsB = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 450);
    expect(opsA.map((o) => o.kind)).toEqual(['pip', 'pip', 'pip']);
    expect(opsB).toEqual(opsA); // the remaining cue does not move
  });

  it('at the narrow 10px-cell floor, a poisoned+slowed creep draws BOTH telegraphs legibly distinct (pip ring outside the slow ring by ≥ 1px)', () => {
    const [slowRing] = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, true, 0x56b4e9, 0);
    const [pip] = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 0);
    expect(pipDistance(pip!, 0, 0) - slowRing!.r).toBeGreaterThanOrEqual(1);
  });

  // QC round 3 — the three assertions below pin fixes that landed in earlier rounds with
  // NO regression guard: reviewers reverted each one and the whole 116-test render suite
  // stayed green. Every pre-existing positional assertion measures DISTANCE from the
  // centre, which is rotation-invariant and so cannot see an orientation regression at
  // all; the narrow-floor test measures ring SEPARATION, never a pip's own drawn radius.

  it('puts the lone pip at the TOP (apex-up, matching the triangle silhouette and the hexagon) — not the bottom', () => {
    const pips = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 0);
    // Canvas y grows DOWNWARD, so "above the centre" is y < 0. The first draft's
    // [90, 210, 330] inverts this exactly — one pip BELOW and two above — and is
    // indistinguishable from the correct set by distance alone.
    const above = pips.filter((p) => p.y < 0);
    expect(above).toHaveLength(1);
    expect(above[0]!.x).toBeCloseTo(0, 6); // horizontally centred: straight up, not off-axis
    expect(above[0]!.y).toBeCloseTo(-R * 1.8, 6);
  });

  it('holds a pip at the DOT_PIP_MIN_PX floor at the narrow cell, where the proportional radius alone would be sub-pixel', () => {
    const [pip] = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 0);
    // R here IS the narrow floor's silhouette radius (3.5). Proportionally the pip would
    // be 3.5 × 0.18 = 0.63 → a 1.26px dot, the essential shape cue effectively invisible
    // exactly where legibility is tightest. The floor is what makes it 1.5.
    expect(R * 0.18).toBeLessThan(1.5); // the floor is genuinely load-bearing at this size
    expect(pip!.r).toBeCloseTo(1.5, 6);
  });

  it('pins the drift cue MAGNITUDE — a period stretched far past 900ms would leave it imperceptible', () => {
    const drift = (t: number) =>
      dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, false, POISONED, t)[3]!;
    // Half a period: the sawtooth is at phase 0.5, so the pip sits half-way across its
    // 0.6r outward span and is half-faded. Asserting only "moved a bit / faded a bit"
    // (the pre-existing test above) survives a 100× period, which is the exact hazard
    // scene.ts warns about for the slow pulse.
    expect(pipDistance(drift(450), 0, 0)).toBeCloseTo(R * (1.8 + 0.6 * 0.5), 6);
    expect(drift(450).alpha).toBeCloseTo(0.25, 6);
    // The drift's alpha CEILING is what the palette contrast gate relies on when it
    // treats the drift as the non-essential motion cue and `poisoned` as opaque.
    expect(drift(0).alpha).toBe(0.5);
  });
});
