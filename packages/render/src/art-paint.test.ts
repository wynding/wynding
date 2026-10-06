// art-paint.test.ts — the art kit's Canvas2D painter, against a recording fake context:
// every shape kind's path, fill before stroke, alpha carried in the colour, the stroke state
// restated in full (width with its floor, join, cap, dash), path strings through the Path2D
// factory; and `artGraphics`' two operations — `art` under its own transform, restored
// after, and `fade` as clip-scoped group opacity.

import { describe, it, expect } from 'vitest';
import { artGraphics, paintArtShapes } from './art-paint';
import type { ArtColour, ArtShape } from './art-ir';
import {
  fakeContext as sharedContext,
  fakePath,
  stylesAtDraws,
  type CtxOp as Op,
} from './test-support/fake-context';

/** A recording context: every method call AND every state write, in order. Writes are
 *  recorded as `set:<prop>`; `arc`/`ellipse` throw on a negative radius, exactly as a
 *  real context's IndexSizeError would. */
const fakeContext = (): ReturnType<typeof sharedContext> => sharedContext({ recordStyles: true });

const COLOURS: Readonly<Record<string, number>> = { role: 0xf4a940, ink: 0x0b0e14, aura: 0xc9b6ff };
const colour = (token: ArtColour): number => {
  const c = COLOURS[token];
  if (c === undefined) throw new Error(`unexpected token ${token}`);
  return c;
};

const paint = (shapes: readonly ArtShape[], unit = 1): Op[] => {
  const ctx = fakeContext();
  paintArtShapes(ctx, shapes, colour, fakePath, unit);
  return ctx.ops;
};
const pathOps = (ops: readonly Op[]): Op[] => ops.filter((o) => !o.op.startsWith('set:'));

describe('paintArtShapes — each shape kind traces its own path', () => {
  it('a circle is one full arc, closed', () => {
    expect(pathOps(paint([{ kind: 'circle', cx: 32, cy: 32, r: 12.5, fill: 'role' }]))).toEqual([
      { op: 'beginPath', args: [] },
      { op: 'arc', args: [32, 32, 12.5, 0, Math.PI * 2] },
      { op: 'closePath', args: [] },
      { op: 'fill', args: [] },
    ]);
  });

  it('an ellipse is one full ellipse, unrotated', () => {
    expect(
      pathOps(paint([{ kind: 'ellipse', cx: 34, cy: 36, rx: 19, ry: 15, fill: 'role' }])),
    ).toEqual([
      { op: 'beginPath', args: [] },
      { op: 'ellipse', args: [34, 36, 19, 15, 0, 0, Math.PI * 2] },
      { op: 'closePath', args: [] },
      { op: 'fill', args: [] },
    ]);
  });

  it('a polygon moves to its first point and lines through the rest, closed', () => {
    const points: [number, number][] = [
      [32, 10],
      [46.5, 32],
      [32, 54],
      [17.5, 32],
    ];
    expect(pathOps(paint([{ kind: 'polygon', points, fill: 'role' }]))).toEqual([
      { op: 'beginPath', args: [] },
      { op: 'moveTo', args: [32, 10] },
      { op: 'lineTo', args: [46.5, 32] },
      { op: 'lineTo', args: [32, 54] },
      { op: 'lineTo', args: [17.5, 32] },
      { op: 'closePath', args: [] },
      { op: 'fill', args: [] },
    ]);
  });

  it('a rect is SVG’s rounded rect, clockwise from the top edge, its radius clamped', () => {
    const H = Math.PI / 2;
    // rx 9 on a 7-wide rect clamps to 3.5.
    expect(
      pathOps(paint([{ kind: 'rect', x: 28.5, y: 7, w: 7, h: 21, rx: 9, fill: 'role' }])),
    ).toEqual([
      { op: 'beginPath', args: [] },
      { op: 'moveTo', args: [32, 7] },
      { op: 'lineTo', args: [32, 7] },
      { op: 'arc', args: [32, 10.5, 3.5, -H, 0] },
      { op: 'lineTo', args: [35.5, 24.5] },
      { op: 'arc', args: [32, 24.5, 3.5, 0, H] },
      { op: 'lineTo', args: [32, 28] },
      { op: 'arc', args: [32, 24.5, 3.5, H, Math.PI] },
      { op: 'lineTo', args: [28.5, 10.5] },
      { op: 'arc', args: [32, 10.5, 3.5, Math.PI, Math.PI * 1.5] },
      { op: 'closePath', args: [] },
      { op: 'fill', args: [] },
    ]);
  });

  it('a path string goes through the Path2D factory and is filled and stroked AS that path', () => {
    const ops = pathOps(
      paint([{ kind: 'path', d: 'M32 9L47.5 44L32 51Z', fill: 'role', stroke: 'ink', width: 2 }]),
    );
    expect(ops).toEqual([
      { op: 'fill', args: [{ d: 'M32 9L47.5 44L32 51Z' }] },
      { op: 'setLineDash', args: [[]] },
      { op: 'stroke', args: [{ d: 'M32 9L47.5 44L32 51Z' }] },
    ]);
  });

  it('refuses to paint a path string with no Path2D factory, rather than skip it', () => {
    expect(() =>
      paintArtShapes(
        fakeContext(),
        [{ kind: 'path', d: 'M0 0L1 1', stroke: 'ink' }],
        colour,
        undefined,
        1,
      ),
    ).toThrow(/Path2D factory/);
    // Shapes that are not path strings need no factory.
    expect(() =>
      paintArtShapes(
        fakeContext(),
        [{ kind: 'circle', cx: 0, cy: 0, r: 1, fill: 'ink' }],
        colour,
        undefined,
        1,
      ),
    ).not.toThrow();
  });

  it('clamps a negative radius at zero, so no shape can make the context throw', () => {
    expect(() =>
      paint([
        { kind: 'circle', cx: 0, cy: 0, r: -1, fill: 'role' },
        { kind: 'ellipse', cx: 0, cy: 0, rx: -1, ry: -2, fill: 'role' },
        { kind: 'rect', x: 0, y: 0, w: -4, h: 2, rx: 3, fill: 'role' },
      ]),
    ).not.toThrow();
  });
});

describe('paintArtShapes — paint', () => {
  it('fills before it strokes, as SVG does, with alpha carried in each colour', () => {
    const ops = paint([
      {
        kind: 'circle',
        cx: 32,
        cy: 32,
        r: 22,
        fill: 'role',
        stroke: 'aura',
        width: 2.4,
        alpha: 0.5,
      },
    ]);
    const fillAt = ops.findIndex((o) => o.op === 'fill');
    const strokeAt = ops.findIndex((o) => o.op === 'stroke');
    expect(fillAt).toBeGreaterThan(-1);
    expect(strokeAt).toBeGreaterThan(fillAt);
    expect(ops.find((o) => o.op === 'set:fillStyle')!.args[0]).toBe('rgba(244, 169, 64, 0.5)');
    expect(ops.find((o) => o.op === 'set:strokeStyle')!.args[0]).toBe('rgba(201, 182, 255, 0.5)');
  });

  it('runs every fill and stroke under its own shape’s style — written before the draw', () => {
    // Each draw is given a style no draw before it had, so a style written after its draw,
    // or never, would leave it under the previous one.
    const ops = paint([
      { kind: 'circle', cx: 10, cy: 10, r: 5, fill: 'role', stroke: 'ink', width: 2 },
      {
        kind: 'rect',
        x: 0,
        y: 0,
        w: 8,
        h: 8,
        rx: 1,
        fill: 'aura',
        stroke: 'role',
        width: 3,
        alpha: 0.5,
      },
    ]);
    expect(stylesAtDraws(ops)).toEqual([
      { op: 'fill', fillStyle: 'rgba(244, 169, 64, 1)' },
      { op: 'stroke', strokeStyle: 'rgba(11, 14, 20, 1)', lineWidth: 2 },
      { op: 'fill', fillStyle: 'rgba(201, 182, 255, 0.5)' },
      { op: 'stroke', strokeStyle: 'rgba(244, 169, 64, 0.5)', lineWidth: 3 },
    ]);
  });

  it('a shape with no fill paints no fill, and one with no stroke no stroke', () => {
    expect(
      paint([{ kind: 'circle', cx: 0, cy: 0, r: 1, stroke: 'ink' }]).map((o) => o.op),
    ).not.toContain('fill');
    expect(
      paint([{ kind: 'circle', cx: 0, cy: 0, r: 1, fill: 'ink' }]).map((o) => o.op),
    ).not.toContain('stroke');
  });

  it('restates the whole stroke state for every stroke: width, join, cap, dash', () => {
    const ops = paint(
      [
        {
          kind: 'circle',
          cx: 0,
          cy: 0,
          r: 1,
          stroke: 'ink',
          width: 2.2,
          join: 'round',
          cap: 'round',
          dash: [5, 4],
        },
        { kind: 'circle', cx: 0, cy: 0, r: 1, stroke: 'ink' },
      ],
      1,
    );
    const writes = (prop: string): unknown[] =>
      ops.filter((o) => o.op === `set:${prop}`).map((o) => o.args[0]);
    expect(writes('lineWidth')).toEqual([2.2, 1]);
    // The second stroke states SVG's defaults rather than inheriting the first's.
    expect(writes('lineJoin')).toEqual(['round', 'miter']);
    expect(writes('lineCap')).toEqual(['round', 'butt']);
    expect(ops.filter((o) => o.op === 'setLineDash').map((o) => o.args[0])).toEqual([[5, 4], []]);
  });

  it('applies the CSS-px floors at the scale it is told: stroke width and dash', () => {
    const ops = paint(
      [
        {
          kind: 'circle',
          cx: 0,
          cy: 0,
          r: 1,
          stroke: 'ink',
          width: 2,
          minWidthPx: 1,
          dash: [5, 4],
          dashMinPx: 2,
        },
      ],
      0.25,
    );
    expect(ops.find((o) => o.op === 'set:lineWidth')!.args[0]).toBe(4);
    expect(ops.find((o) => o.op === 'setLineDash')!.args[0]).toEqual([10, 8]);
  });

  it('paints the shapes in the order given — later shapes over earlier ones', () => {
    const ops = paint([
      { kind: 'circle', cx: 1, cy: 1, r: 1, fill: 'aura' },
      { kind: 'circle', cx: 2, cy: 2, r: 1, fill: 'role' },
    ]);
    expect(ops.filter((o) => o.op === 'set:fillStyle').map((o) => o.args[0])).toEqual([
      'rgba(201, 182, 255, 1)',
      'rgba(244, 169, 64, 1)',
    ]);
  });
});

describe('artGraphics', () => {
  it('art() paints under its own transform and restores the context after', () => {
    const ctx = fakeContext();
    const g = artGraphics(ctx, fakePath);
    g.art([{ kind: 'circle', cx: 32, cy: 32, r: 3.6, fill: 'ink' }], colour, 10, 20, 0.5);
    const ops = pathOps(ctx.ops);
    expect(ops[0]).toEqual({ op: 'save', args: [] });
    expect(ops[1]).toEqual({ op: 'transform', args: [0.5, 0, 0, 0.5, 10, 20] });
    expect(ops[ops.length - 1]).toEqual({ op: 'restore', args: [] });
    expect(ops.map((o) => o.op)).toContain('arc');
  });

  it('art() paints the GraphicsLike batch first, so draw order holds across the two', () => {
    const ctx = fakeContext();
    const g = artGraphics(ctx, fakePath);
    g.fillStyle(0x1b1f2a, 1);
    g.fillRect(0, 0, 36, 36); // batched by the adapter until something else draws
    g.art([{ kind: 'circle', cx: 32, cy: 32, r: 3.6, fill: 'ink' }], colour, 0, 0, 1);
    const ops = pathOps(ctx.ops).map((o) => o.op);
    expect(ops.indexOf('rect')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('rect')).toBeLessThan(ops.indexOf('save'));
  });

  it('fade() multiplies what is already painted by its alpha — destination-in, under the clip', () => {
    const ctx = fakeContext();
    const g = artGraphics(ctx, fakePath);
    g.fade(0.5);
    expect(ctx.ops).toEqual([
      { op: 'set:lineCap', args: ['butt'] },
      { op: 'set:lineJoin', args: ['miter'] },
      { op: 'save', args: [] },
      { op: 'set:globalCompositeOperation', args: ['destination-in'] },
      { op: 'set:fillStyle', args: ['rgba(0, 0, 0, 0.5)'] },
      { op: 'fillRect', args: [-1e6, -1e6, 2e6, 2e6] },
      { op: 'restore', args: [] },
    ]);
  });

  it('fade() paints the GraphicsLike batch first, so it fades what was drawn before it', () => {
    const ctx = fakeContext();
    const g = artGraphics(ctx, fakePath);
    g.fillStyle(0x1b1f2a, 1);
    g.fillRect(0, 0, 36, 36); // batched by the adapter until something else draws
    g.fade(0.5);
    g.flush();
    const ops = pathOps(ctx.ops).map((o) => o.op);
    expect(ops.indexOf('rect')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('rect')).toBeLessThan(ops.indexOf('fillRect'));
  });

  it('fade() clamps its alpha to [0, 1]', () => {
    for (const [given, used] of [
      [-1, 0],
      [2, 1],
    ] as const) {
      const ctx = fakeContext();
      artGraphics(ctx).fade(given);
      expect(ctx.ops.find((o) => o.op === 'set:fillStyle')!.args[0]).toBe(`rgba(0, 0, 0, ${used})`);
    }
  });

  it('still draws everything a GraphicsLike draws', () => {
    const ctx = fakeContext();
    const g = artGraphics(ctx);
    g.lineStyle(2, 0xffffff, 1);
    g.lineBetween(0, 0, 4, 4);
    expect(pathOps(ctx.ops).map((o) => o.op)).toEqual(['beginPath', 'moveTo', 'lineTo', 'stroke']);
  });
});
