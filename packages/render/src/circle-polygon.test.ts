// circle-polygon.test.ts — a small circle drawn as a regular polygon: how many sides a radius
// gets (the board's one rule, `circle-path.ts`'s `circleSegments`, at the dpr: within a quarter of
// a device pixel of the circle, and never no sides, NaN included), where the corners sit (on the
// circle, evenly spaced, the first straight up, going clockwise) and the calls that fill one and
// stroke one closed.

import { describe, it, expect } from 'vitest';
import {
  CIRCLE_MAX_SEGMENTS,
  CIRCLE_MIN_SEGMENTS,
  CIRCLE_TOLERANCE_DEVICE_PX,
  circleSegments,
} from './circle-path';
import { circlePoints, fillCircleAsPolygon, strokeCircleAsPolygon } from './circle-polygon';
import { artUnit } from './art-frames';
import { FIRE_PULSE_RINGS, MUZZLE_FLASH } from './tower-art';
import { recordingLayer } from './test-support/recording-graphics';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const DPRS = [0.8, 1, 1.25, 1.5, 2, 3] as const;

describe('circlePoints — the board’s one side-count rule (R5, #181)', () => {
  it('gives a circle as many corners as `circleSegments` gives it at the dpr — the rule every live circle follows', () => {
    for (const dpr of DPRS) {
      for (const r of [0.5, 2, 4.5, 6, 7.5, 12, 24, 75, 400]) {
        expect(circlePoints(0, 0, r, dpr)).toHaveLength(circleSegments(r, dpr));
      }
    }
  });

  it('draws T3’s muzzle flash and ring pulse at a 33px cell with the sides that rule gives them', () => {
    const unit = artUnit(33);
    expect(circlePoints(0, 0, MUZZLE_FLASH.r * unit, 1)).toHaveLength(12);
    expect(circlePoints(0, 0, MUZZLE_FLASH.r * unit, 2)).toHaveLength(16);
    expect(circlePoints(0, 0, FIRE_PULSE_RINGS[0].r * unit, 1)).toHaveLength(23);
  });

  it('keeps every side within a quarter of a device pixel of its circle, below the most sides there are', () => {
    for (const dpr of DPRS) {
      for (let r = 0.25; r <= 60; r += 0.25) {
        const pts = circlePoints(0, 0, r, dpr);
        const n = pts.length;
        // A side's midpoint is the polygon's nearest point to the circle's edge inside it.
        const mid = { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 };
        const gapDevicePx = (r - dist(mid, { x: 0, y: 0 })) * dpr;
        if (n < CIRCLE_MAX_SEGMENTS) {
          expect(gapDevicePx).toBeLessThanOrEqual(CIRCLE_TOLERANCE_DEVICE_PX + 1e-12);
        }
        // ... and with no more sides than that bound needs: one fewer would break it.
        if (n > CIRCLE_MIN_SEGMENTS && n < CIRCLE_MAX_SEGMENTS) {
          expect(r * (1 - Math.cos(Math.PI / (n - 1))) * dpr).toBeGreaterThan(
            CIRCLE_TOLERANCE_DEVICE_PX,
          );
        }
      }
    }
  });

  it('gives a radius that is not a positive number the fewest sides, never none — an empty list throws out of Phaser', () => {
    for (const r of [0, -1, NaN]) {
      expect(circlePoints(0, 0, r, 1)).toHaveLength(CIRCLE_MIN_SEGMENTS);
      expect(circlePoints(0, 0, r, 2)).toHaveLength(CIRCLE_MIN_SEGMENTS);
    }
  });
});

describe('circlePoints — the polygon’s corners', () => {
  it('puts its corners on the circle, evenly spaced, about the centre', () => {
    for (const [x, y, r, dpr] of [
      [10, 20, 2, 1],
      [-3.5, 40.25, 6, 2],
      [100, 100, 24.5, 1.25],
    ] as const) {
      const pts = circlePoints(x, y, r, dpr);
      const n = pts.length;
      expect(n).toBe(circleSegments(r, dpr));
      for (const p of pts) expect(dist(p, { x, y })).toBeCloseTo(r, 12);
      // Every side the same length: a regular polygon.
      for (let i = 0; i < n; i++) {
        expect(dist(pts[i]!, pts[(i + 1) % n]!)).toBeCloseTo(2 * r * Math.sin(Math.PI / n), 12);
      }
      // Its corners balance on the centre.
      const cx = pts.reduce((s, p) => s + p.x, 0) / n;
      const cy = pts.reduce((s, p) => s + p.y, 0) / n;
      expect(cx).toBeCloseTo(x, 12);
      expect(cy).toBeCloseTo(y, 12);
    }
  });

  it('starts straight up from the centre and goes clockwise (y grows downward)', () => {
    const pts = circlePoints(10, 20, 7, 1);
    expect(pts).toHaveLength(12);
    expect(pts[0]!.x).toBeCloseTo(10, 12);
    expect(pts[0]!.y).toBeCloseTo(13, 12);
    expect(pts[1]!.x).toBeGreaterThan(10); // the next corner is to the right of the first
    expect(pts[3]!.x).toBeCloseTo(17, 12); // a quarter turn on: straight right
    expect(pts[3]!.y).toBeCloseTo(20, 12);
    expect(pts[6]!.y).toBeCloseTo(27, 12); // half a turn: straight down
  });

  it('hands back a list of its own each time, so a caller may keep or change it', () => {
    const a = circlePoints(0, 0, 4, 1);
    const kept = a.map((p) => ({ ...p }));
    const b = circlePoints(5, 5, 4, 1); // another circle with as many sides
    expect(b).not.toBe(a);
    expect(a).toEqual(kept); // the second call left the first list as it was
    a[0]!.x = 99;
    expect(b[0]!.x).toBeCloseTo(5, 12); // and changing the first leaves the second alone
    expect(circlePoints(0, 0, 4, 1)[0]!.x).toBeCloseTo(0, 12);
  });
});

describe('fillCircleAsPolygon / strokeCircleAsPolygon — one call each', () => {
  it('fills the polygon, closed, in the fill style in force', () => {
    const g = recordingLayer();
    fillCircleAsPolygon(g, 10, 20, 4.5, 2);
    expect(g.calls).toEqual([{ method: 'fillPoints', args: [circlePoints(10, 20, 4.5, 2), true] }]);
  });

  it('strokes the polygon as a closed path, its first corner not repeated — Phaser joins the last side to the first', () => {
    const g = recordingLayer();
    strokeCircleAsPolygon(g, 30, 40, 24, 1.5);
    expect(g.calls).toEqual([
      { method: 'strokePoints', args: [circlePoints(30, 40, 24, 1.5), false, true] },
    ]);
  });
});
