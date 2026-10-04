// circle-polygon.test.ts — a small circle drawn as a regular polygon: how many sides a radius
// gets (12 at the smallest, up to 24, no side longer than 3 CSS px below the cap), where the
// corners sit (on the circle, evenly spaced, the first straight up, going clockwise) and the
// calls that fill one and stroke one closed.

import { describe, it, expect } from 'vitest';
import {
  MAX_CIRCLE_SIDES,
  MAX_CIRCLE_SIDE_PX,
  MIN_CIRCLE_SIDES,
  circlePoints,
  circleSides,
  fillCircleAsPolygon,
  strokeCircleAsPolygon,
} from './circle-polygon';
import { recordingLayer } from './test-support/recording-graphics';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe('circleSides — enough sides that it reads as a circle, at every size', () => {
  it('gives the smallest circles 12 sides, and the largest 24', () => {
    expect([MIN_CIRCLE_SIDES, MAX_CIRCLE_SIDES, MAX_CIRCLE_SIDE_PX]).toEqual([12, 24, 3]);
    for (const r of [0, 0.5, 2, 5]) expect(circleSides(r)).toBe(12);
    for (const r of [12, 24, 75, 1000]) expect(circleSides(r)).toBe(24);
    expect(circleSides(-1)).toBe(12); // no radius at all is the smallest circle
  });

  it('adds sides as the radius grows, never removing one, so no side passes 3 CSS px below the cap', () => {
    let last = 0;
    for (let r = 0; r <= 40; r += 0.25) {
      const n = circleSides(r);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
      const side = 2 * r * Math.sin(Math.PI / n);
      if (n < MAX_CIRCLE_SIDES) expect(side).toBeLessThanOrEqual(MAX_CIRCLE_SIDE_PX);
    }
    expect(circleSides(6)).toBe(13); // a muzzle flash at 33px cells
    expect(circleSides(10)).toBe(21);
  });
});

describe('circlePoints — the polygon’s corners', () => {
  it('puts circleSides(r) corners on the circle, evenly spaced, about the centre', () => {
    for (const [x, y, r] of [
      [10, 20, 2],
      [-3.5, 40.25, 6],
      [100, 100, 24.5],
    ] as const) {
      const pts = circlePoints(x, y, r);
      const n = circleSides(r);
      expect(pts).toHaveLength(n);
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
    const pts = circlePoints(10, 20, 7.5);
    expect(pts).toHaveLength(16);
    expect(pts[0]!.x).toBeCloseTo(10, 12);
    expect(pts[0]!.y).toBeCloseTo(12.5, 12);
    expect(pts[1]!.x).toBeGreaterThan(10); // the next corner is to the right of the first
    expect(pts[4]!.x).toBeCloseTo(17.5, 12); // a quarter turn on: straight right
    expect(pts[4]!.y).toBeCloseTo(20, 12);
    expect(pts[8]!.y).toBeCloseTo(27.5, 12); // half a turn: straight down
  });

  it('hands back a list of its own each time, so a caller may keep or change it', () => {
    const a = circlePoints(0, 0, 4);
    const b = circlePoints(0, 0, 4);
    expect(b).toEqual(a);
    a[0]!.x = 99;
    expect(circlePoints(0, 0, 4)[0]!.x).toBeCloseTo(0, 12);
  });
});

describe('fillCircleAsPolygon / strokeCircleAsPolygon — one call each', () => {
  it('fills the polygon, closed, in the fill style in force', () => {
    const g = recordingLayer();
    fillCircleAsPolygon(g, 10, 20, 4.5);
    expect(g.calls).toEqual([{ method: 'fillPoints', args: [circlePoints(10, 20, 4.5), true] }]);
  });

  it('strokes the polygon as a closed path, its first corner not repeated — Phaser joins the last side to the first', () => {
    const g = recordingLayer();
    strokeCircleAsPolygon(g, 30, 40, 24);
    expect(g.calls).toEqual([
      { method: 'strokePoints', args: [circlePoints(30, 40, 24), false, true] },
    ]);
  });
});
