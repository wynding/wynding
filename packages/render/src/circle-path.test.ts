// circle-path.test.ts — the live layers' circles as polygons sized to their radius: as few
// sides as keep within a quarter of a device pixel of the circle, never more than Phaser's 100,
// every corner on the circle, the path closed, and the device pixel ratio read at each call.

import { describe, it, expect } from 'vitest';
import {
  CIRCLE_MAX_SEGMENTS,
  CIRCLE_MIN_SEGMENTS,
  CIRCLE_TOLERANCE_DEVICE_PX,
  circleSegments,
  polygonCircles,
  type PathGraphics,
} from './circle-path';

/** How far inside its circle a polygon of `n` sides falls, at an edge's midpoint. */
const sag = (r: number, n: number): number => r * (1 - Math.cos(Math.PI / n));

describe('circleSegments — as few sides as keep the polygon within tolerance of its circle', () => {
  it('keeps every radius within a quarter of a device pixel, with the fewest sides that do', () => {
    for (const dpr of [0.8, 1, 1.25, 1.5, 2, 3]) {
      for (let r = 0.5; r <= 80; r += 0.25) {
        const n = circleSegments(r, dpr);
        const rd = r * dpr;
        if (n > CIRCLE_MIN_SEGMENTS && n < CIRCLE_MAX_SEGMENTS) {
          expect(sag(rd, n), `r=${r} dpr=${dpr}`).toBeLessThanOrEqual(
            CIRCLE_TOLERANCE_DEVICE_PX + 1e-12,
          );
          expect(sag(rd, n - 1), `r=${r} dpr=${dpr}: one side fewer`).toBeGreaterThan(
            CIRCLE_TOLERANCE_DEVICE_PX,
          );
        }
      }
    }
    expect(CIRCLE_TOLERANCE_DEVICE_PX).toBe(0.25);
  });

  it('draws the board’s circles with a fraction of Phaser’s 100 sides', () => {
    // A DoT pip at the narrow floor (1.5px) and a desktop one; a slow ring at a phone’s cell
    // and a desktop one; a boss’s ward at a desktop cell (2.2 × 1.68 × 0.35 × 40px).
    expect(circleSegments(1.5, 1)).toBe(CIRCLE_MIN_SEGMENTS);
    expect(circleSegments(2.5, 2)).toBe(10);
    expect(circleSegments(1.4 * 0.35 * 13, 2)).toBe(16);
    expect(circleSegments(1.4 * 0.35 * 40, 1)).toBe(20);
    expect(circleSegments(2.2 * 1.68 * 0.35 * 40, 1)).toBe(32);
    expect(circleSegments(2.2 * 1.68 * 0.35 * 40, 3)).toBe(56);
  });

  it('grows with the radius and with the device pixel ratio, between its bounds', () => {
    let last = 0;
    for (let r = 0; r <= 4000; r += 1) {
      const n = circleSegments(r, 1);
      expect(n).toBeGreaterThanOrEqual(last);
      expect(n).toBeGreaterThanOrEqual(CIRCLE_MIN_SEGMENTS);
      expect(n).toBeLessThanOrEqual(CIRCLE_MAX_SEGMENTS);
      last = n;
    }
    expect(last).toBe(CIRCLE_MAX_SEGMENTS); // a huge circle gets Phaser's own count, no more
    expect(circleSegments(20, 2)).toBeGreaterThan(circleSegments(20, 1));
  });

  it('is total: a zero, negative or non-finite radius draws the fewest sides', () => {
    for (const r of [0, -3, Number.NaN]) expect(circleSegments(r, 2)).toBe(CIRCLE_MIN_SEGMENTS);
    expect(circleSegments(Number.POSITIVE_INFINITY, 1)).toBe(CIRCLE_MAX_SEGMENTS);
  });
});

/** A recording path surface: each call, its name and arguments. */
function recorder(): PathGraphics & { calls: { op: string; args: number[] }[] } {
  const calls: { op: string; args: number[] }[] = [];
  const rec =
    (op: string) =>
    (...args: number[]): void => {
      calls.push({ op, args });
    };
  return {
    calls,
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    closePath: rec('closePath'),
    strokePath: rec('strokePath'),
    fillPath: rec('fillPath'),
    strokeCircle: rec('nativeStrokeCircle'),
    fillCircle: rec('nativeFillCircle'),
  };
}

describe('polygonCircles — a Graphics whose circles are those polygons', () => {
  it('strokes a circle as one CLOSED path of n sides, every corner on the circle, the first at its rightmost point', () => {
    const g = polygonCircles(recorder(), () => 1);
    g.strokeCircle(10, 20, 14);
    const n = circleSegments(14, 1);
    const ops = g.calls.map((c) => c.op);
    expect(ops).toEqual([
      'beginPath',
      'moveTo',
      ...Array(n - 1).fill('lineTo'),
      'closePath',
      'strokePath',
    ]);
    expect(g.calls[1]!.args).toEqual([24, 20]);
    for (const c of g.calls.filter((c) => c.op === 'moveTo' || c.op === 'lineTo')) {
      expect(Math.hypot(c.args[0]! - 10, c.args[1]! - 20)).toBeCloseTo(14, 9);
    }
    // Evenly spaced: every side is as long as the first.
    const pts = g.calls.filter((c) => c.op === 'moveTo' || c.op === 'lineTo').map((c) => c.args);
    const side = Math.hypot(pts[1]![0]! - pts[0]![0]!, pts[1]![1]! - pts[0]![1]!);
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1]!, pts[i]!];
      expect(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!)).toBeCloseTo(side, 9);
    }
    expect(ops).not.toContain('nativeStrokeCircle');
  });

  it('fills a circle through the same polygon, closed, then fillPath', () => {
    const g = polygonCircles(recorder(), () => 2);
    g.fillCircle(0, 0, 1.5);
    const ops = g.calls.map((c) => c.op);
    expect(ops[0]).toBe('beginPath');
    expect(ops.slice(-2)).toEqual(['closePath', 'fillPath']);
    expect(ops.filter((o) => o === 'moveTo' || o === 'lineTo')).toHaveLength(
      circleSegments(1.5, 2),
    );
    expect(ops).not.toContain('nativeFillCircle');
  });

  it('reads the device pixel ratio at each call, so a monitor move is followed', () => {
    let dpr = 1;
    const g = polygonCircles(recorder(), () => dpr);
    g.strokeCircle(0, 0, 30);
    const before = g.calls.filter((c) => c.op === 'lineTo').length + 1;
    g.calls.length = 0;
    dpr = 3;
    g.strokeCircle(0, 0, 30);
    const after = g.calls.filter((c) => c.op === 'lineTo').length + 1;
    expect(before).toBe(circleSegments(30, 1));
    expect(after).toBe(circleSegments(30, 3));
    expect(after).toBeGreaterThan(before);
  });

  it('returns the same Graphics, its own calls untouched, and each circle call returns it too', () => {
    const base = recorder();
    const { beginPath, strokePath } = base;
    const g = polygonCircles(base, () => 1);
    expect(g).toBe(base);
    expect(g.beginPath).toBe(beginPath);
    expect(g.strokePath).toBe(strokePath);
    expect(g.strokeCircle(1, 2, 3)).toBe(g);
    expect(g.fillCircle(1, 2, 3)).toBe(g);
  });
});
