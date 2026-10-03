// art-geometry.test.ts — the art kit's geometry: SVG path parsing (every command, relative
// and absolute, with S/T reflection and implicit repeats), flattening (arcs to their exact
// endpoints and true centres), shape outlines, and the bounds frame sizing relies on.

import { describe, it, expect } from 'vitest';
import { artBounds, flattenPath, parsePath, shapeOutline, type Point } from './art-geometry';
import type { ArtShape } from './art-ir';

const close = (a: Point, b: readonly [number, number], digits = 9): void => {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
};

describe('parsePath', () => {
  it('reads absolute commands, with H and V as lines', () => {
    expect(parsePath('M13 5.6H51V8L1,2Z')).toEqual([
      { c: 'M', x: 13, y: 5.6 },
      { c: 'L', x: 51, y: 5.6 },
      { c: 'L', x: 51, y: 8 },
      { c: 'L', x: 1, y: 2 },
      { c: 'Z' },
    ]);
  });

  it('makes relative commands absolute, from the current point', () => {
    expect(parsePath('M10 10l5 0h2v-3m1 1')).toEqual([
      { c: 'M', x: 10, y: 10 },
      { c: 'L', x: 15, y: 10 },
      { c: 'L', x: 17, y: 10 },
      { c: 'L', x: 17, y: 7 },
      { c: 'M', x: 18, y: 8 },
    ]);
  });

  it('treats numbers after a moveto as linetos (absolute and relative)', () => {
    expect(parsePath('M0 0 4 0 4 4')).toEqual([
      { c: 'M', x: 0, y: 0 },
      { c: 'L', x: 4, y: 0 },
      { c: 'L', x: 4, y: 4 },
    ]);
    expect(parsePath('m1 1 2 2')).toEqual([
      { c: 'M', x: 1, y: 1 },
      { c: 'L', x: 3, y: 3 },
    ]);
  });

  it('reads curves, reflecting the previous control point for S and T', () => {
    expect(parsePath('M0 0C1 2 3 4 5 6S9 10 11 12')).toEqual([
      { c: 'M', x: 0, y: 0 },
      { c: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 },
      { c: 'C', x1: 7, y1: 8, x2: 9, y2: 10, x: 11, y: 12 },
    ]);
    expect(parsePath('M0 0Q2 4 4 0T8 0')).toEqual([
      { c: 'M', x: 0, y: 0 },
      { c: 'Q', x1: 2, y1: 4, x: 4, y: 0 },
      { c: 'Q', x1: 6, y1: -4, x: 8, y: 0 },
    ]);
    // With no curve before it, S and T take the current point as their first control.
    expect(parsePath('M2 2S4 4 6 2T10 2')).toEqual([
      { c: 'M', x: 2, y: 2 },
      { c: 'C', x1: 2, y1: 2, x2: 4, y2: 4, x: 6, y: 2 },
      { c: 'Q', x1: 6, y1: 2, x: 10, y: 2 },
    ]);
    expect(parsePath('M0 0c1 1 2 2 3 3q1 0 2 2')).toEqual([
      { c: 'M', x: 0, y: 0 },
      { c: 'C', x1: 1, y1: 1, x2: 2, y2: 2, x: 3, y: 3 },
      { c: 'Q', x1: 4, y1: 3, x: 5, y: 5 },
    ]);
  });

  it('reads arcs with their flags, absolute and relative', () => {
    expect(parsePath('M22 15A12 12 0 0 1 42 15a2 3 45 1 0 -2 -2')).toEqual([
      { c: 'M', x: 22, y: 15 },
      { c: 'A', rx: 12, ry: 12, rotation: 0, large: false, sweep: true, x: 42, y: 15 },
      { c: 'A', rx: 2, ry: 3, rotation: 45, large: true, sweep: false, x: 40, y: 13 },
    ]);
  });

  it('returns to the sub-path start on Z, so a relative command after it starts there', () => {
    expect(parsePath('M10 10L20 10Zl0 5')).toEqual([
      { c: 'M', x: 10, y: 10 },
      { c: 'L', x: 20, y: 10 },
      { c: 'Z' },
      { c: 'L', x: 10, y: 15 },
    ]);
  });

  it('reads decimals, signs and exponents', () => {
    expect(parsePath('M.5-1.5L1e1 2E-1')).toEqual([
      { c: 'M', x: 0.5, y: -1.5 },
      { c: 'L', x: 10, y: 0.2 },
    ]);
  });

  it('throws on anything it cannot read — a malformed path is a bug, never a shape to skip', () => {
    expect(() => parsePath('M0 0 X 3')).toThrow(/unreadable/);
    // Numbers with no command at all fail the opening-moveto rule below first.
    expect(() => parsePath('3 4')).toThrow(/moveto/);
    expect(() => parsePath('M0 0Z 4 4')).toThrow(/without a command/);
    expect(() => parsePath('M0')).toThrow(/ends early/);
    expect(() => parsePath('M0 0L4')).toThrow(/ends early/);
  });

  it('is never more lenient than Path2D: path data a browser paints as NOTHING throws', () => {
    // Chromium and WebKit drop path data from its first error on, so each of these paints
    // no pixel at all — measuring them as shapes would let frame sizes and the tests reason
    // about art the board never shows.
    expect(() => parsePath('L50 50')).toThrow(/moveto/);
    expect(() => parsePath('h40')).toThrow(/moveto/);
    expect(() => parsePath('')).toThrow(/moveto/);
    expect(() => parsePath('M10,,10L50 50')).toThrow(/comma/);
    expect(() => parsePath(',M10 10L50 50')).toThrow(/comma/);
    // A comma separates two NUMBERS: never after a command letter, before one, or at the end.
    expect(() => parsePath('M,10 10L50 50')).toThrow(/comma/);
    expect(() => parsePath('M10 10,L50 50')).toThrow(/comma/);
    expect(() => parsePath('M10 10L50 50,')).toThrow(/comma/);
    // ... while every separator the grammar allows still reads.
    expect(parsePath(' m10,10 L 50 , 50\n')).toEqual([
      { c: 'M', x: 10, y: 10 },
      { c: 'L', x: 50, y: 50 },
    ]);
  });
});

describe('flattenPath', () => {
  it('splits sub-paths at each moveto, open unless closed with Z', () => {
    const lines = flattenPath('M0 0L4 0M10 10L14 10L14 14Z');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      points: [
        [0, 0],
        [4, 0],
      ],
      closed: false,
    });
    expect(lines[1]!.closed).toBe(true);
    expect(lines[1]!.points).toEqual([
      [10, 10],
      [14, 10],
      [14, 14],
    ]);
  });

  it('drops a lone moveto — a point is not a sub-path', () => {
    expect(flattenPath('M5 5')).toEqual([]);
    expect(flattenPath('M5 5M0 0L1 1')).toHaveLength(1);
  });

  it('starts a new sub-path at the closed one’s start when drawing goes on after Z', () => {
    const lines = flattenPath('M0 0L4 0L4 4ZL0 8');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      points: [
        [0, 0],
        [0, 8],
      ],
      closed: false,
    });
  });

  it('flattens Béziers through their true endpoints and midpoints', () => {
    const [cubic] = flattenPath('M0 0C0 10 10 10 10 0');
    const pts = cubic!.points;
    close(pts[0]!, [0, 0]);
    close(pts[pts.length - 1]!, [10, 0]);
    // B(0.5) of this cubic is (5, 7.5).
    close(pts[Math.floor(pts.length / 2)]!, [5, 7.5]);
    const [quad] = flattenPath('M0 0Q5 10 10 0');
    // B(0.5) of this quadratic is (5, 5).
    close(quad!.points[Math.floor(quad!.points.length / 2)]!, [5, 5]);
  });

  it('flattens an arc onto its true circle and lands exactly on its endpoint', () => {
    // The beacon's inner wave: a 12-radius arc from (22, 15) to (42, 15), sweeping over the
    // top. Its centre is (32, 15 + √44) and every flattened point sits on the circle.
    const [arc] = flattenPath('M22 15A12 12 0 0 1 42 15');
    const pts = arc!.points;
    expect(pts[pts.length - 1]).toEqual([42, 15]);
    const cy = 15 + Math.sqrt(144 - 100);
    for (const [x, y] of pts) expect(Math.hypot(x - 32, y - cy)).toBeCloseTo(12, 9);
    // Sweep flag 1 takes the short way over the top: every point is at or above y = 15.
    for (const [, y] of pts) expect(y).toBeLessThanOrEqual(15 + 1e-9);
  });

  it('takes the large arc and the other sweep when the flags say so', () => {
    const [large] = flattenPath('M0 0A10 10 0 1 1 10 0');
    const [small] = flattenPath('M0 0A10 10 0 0 1 10 0');
    const extent = (pts: readonly Point[]): number => Math.max(...pts.map(([, y]) => Math.abs(y)));
    expect(extent(large!.points)).toBeGreaterThan(10); // over most of the circle
    expect(extent(small!.points)).toBeLessThan(2); // a shallow cap
    const [down] = flattenPath('M0 0A10 10 0 0 0 10 0');
    expect(Math.max(...down!.points.map(([, y]) => y))).toBeGreaterThan(0); // below the chord
  });

  it('grows radii too small to reach the endpoint (SVG F.6.6), and rotates the ellipse', () => {
    // A 1-radius "circle" cannot span 10 units; SVG scales it up to a half circle.
    const [arc] = flattenPath('M0 0A1 1 0 0 1 10 0');
    for (const [x, y] of arc!.points) expect(Math.hypot(x - 5, y)).toBeCloseTo(5, 9);
    const [rotated] = flattenPath('M0 0A10 5 90 0 1 0 10');
    expect(rotated!.points[rotated!.points.length - 1]).toEqual([0, 10]);
  });

  it('draws an arc with no length or no radius as a straight line to its end', () => {
    expect(flattenPath('M3 3A5 5 0 0 1 3 3')[0]!.points).toEqual([
      [3, 3],
      [3, 3],
    ]);
    expect(flattenPath('M0 0A0 5 0 0 1 4 4')[0]!.points).toEqual([
      [0, 0],
      [4, 4],
    ]);
  });
});

describe('shapeOutline', () => {
  it('traces a circle and an ellipse as closed rings on their curve', () => {
    const [ring] = shapeOutline({ kind: 'circle', cx: 32, cy: 32, r: 12.5 });
    expect(ring!.closed).toBe(true);
    for (const [x, y] of ring!.points) expect(Math.hypot(x - 32, y - 32)).toBeCloseTo(12.5, 9);
    const [oval] = shapeOutline({ kind: 'ellipse', cx: 34, cy: 36, rx: 19, ry: 15 });
    for (const [x, y] of oval!.points) {
      expect(((x - 34) / 19) ** 2 + ((y - 36) / 15) ** 2).toBeCloseTo(1, 9);
    }
  });

  it('traces a polygon through its points, closed', () => {
    const points: (readonly [number, number])[] = [
      [32, 10],
      [46.5, 32],
      [32, 54],
    ];
    expect(shapeOutline({ kind: 'polygon', points })).toEqual([{ points, closed: true }]);
  });

  it('traces a rounded rect inside its box, its corners on their quarter circles', () => {
    const [outline] = shapeOutline({ kind: 'rect', x: 3, y: 3, w: 58, h: 58, rx: 9 });
    const xs = outline!.points.map(([x]) => x);
    const ys = outline!.points.map(([, y]) => y);
    expect(Math.min(...xs)).toBeCloseTo(3, 9);
    expect(Math.max(...xs)).toBeCloseTo(61, 9);
    expect(Math.min(...ys)).toBeCloseTo(3, 9);
    expect(Math.max(...ys)).toBeCloseTo(61, 9);
    // No point pokes into the cut-off corner: the top-left corner point is 9 from (12, 12).
    const corner = outline!.points.reduce((best, p) =>
      p[0] + p[1] < best[0] + best[1] ? p : best,
    );
    expect(Math.hypot(corner[0] - 12, corner[1] - 12)).toBeCloseTo(9, 9);
  });

  it('traces a path string through its flattened sub-paths', () => {
    expect(shapeOutline({ kind: 'path', d: 'M0 0L1 1' })).toEqual(flattenPath('M0 0L1 1'));
  });
});

describe('artBounds', () => {
  it('is the outline box for fills, and grows by half the stroke where a shape strokes', () => {
    const filled: ArtShape = { kind: 'rect', x: 3, y: 3, w: 58, h: 58, rx: 0, fill: 'plate' };
    expect(artBounds([filled], 1)).toEqual({ minX: 3, minY: 3, maxX: 61, maxY: 61 });
    const stroked: ArtShape = { ...filled, stroke: 'rim', width: 2 };
    expect(artBounds([stroked], 1)).toEqual({ minX: 2, minY: 2, maxX: 62, maxY: 62 });
  });

  it('grows by the stroke width the floor makes it at that scale', () => {
    const rim: ArtShape = {
      kind: 'rect',
      x: 3,
      y: 3,
      w: 58,
      h: 58,
      rx: 0,
      stroke: 'rim',
      width: 2,
      minWidthPx: 1,
    };
    // 0.25 px/unit: the 1px floor makes the stroke 4 units, half of it 2.
    expect(artBounds([rim], 0.25).minX).toBeCloseTo(1, 12);
    expect(artBounds([rim], 1).minX).toBeCloseTo(2, 12);
  });

  it('unions every shape, and is empty for none', () => {
    const b = artBounds(
      [
        { kind: 'circle', cx: 0, cy: 0, r: 1, fill: 'ink' },
        { kind: 'circle', cx: 10, cy: 20, r: 1, fill: 'ink' },
      ],
      1,
    );
    expect(b.minX).toBeCloseTo(-1, 9);
    expect(b.maxY).toBeCloseTo(21, 9);
    const empty = artBounds([], 1);
    expect(empty.minX).toBeGreaterThan(empty.maxX);
  });
});
