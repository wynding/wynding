// creep-paint.test.ts — the silhouette/telegraph paint-plan (M2-S3), asserted at the REAL
// supported floor (568×320 → CELL_PX_MIN_NARROW = 10px cells, Codex R1-12) rather than the
// 12px the risk-of-record originally assumed.

import { describe, it, expect } from 'vitest';
import { creepShapeFor, creepSilhouettePaintOp, slowTelegraphPaintOps } from './creep-paint';

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
    expect(slowTelegraphPaintOps({ x: 0, y: 0, slowed: false }, R, false, 0x56b4e9)).toEqual([]);
  });

  it('draws a ring (the GUARANTEED shape cue) plus a pulse when motion is not reduced', () => {
    const ops = slowTelegraphPaintOps({ x: 5, y: 6, slowed: true }, R, false, 0x56b4e9);
    expect(ops.map((o) => o.kind)).toEqual(['ring', 'pulse']);
    for (const op of ops) {
      expect(op.colour).toBe(0x56b4e9);
      expect(op.x).toBe(5);
      expect(op.y).toBe(6);
    }
  });

  it('keeps the ring but drops the pulse under reduced motion (WCAG 2.3.3 / GAG §2)', () => {
    const ops = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, true, 0x56b4e9);
    expect(ops.map((o) => o.kind)).toEqual(['ring']);
  });

  it('at the narrow 10px-cell floor, the ring radius is legibly distinct from the silhouette radius (≥ 1px)', () => {
    const [ring] = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, true, 0x56b4e9);
    expect(ring).toBeDefined();
    expect(ring!.r - R).toBeGreaterThanOrEqual(1);
  });
});
