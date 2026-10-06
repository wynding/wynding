// canvas-graphics.test.ts — the bake's `GraphicsLike` over a Canvas2D context, against a
// recording fake context: every Phaser-semantics rule the adapter claims (latched styles,
// per-primitive compositing, Phaser's own rounded-rect paths) and its one departure (opaque
// same-colour rects fill as one path, so the bake leaves no seams between them).

import { describe, it, expect } from 'vitest';
import { canvasGraphics, cssColour } from './canvas-graphics';
import {
  fakeContext as sharedContext,
  stylesAtDraws,
  type CtxOp as Op,
} from './test-support/fake-context';

/** A recording context: every method call AND every style write, in order. Style writes are
 *  recorded as `set:<prop>` so a test can see which style a fill or stroke ran under. Its
 *  `arc` rejects a negative radius the way a real 2D context does (the HTML spec's
 *  `IndexSizeError`), so a path that would throw in a browser throws here too. */
const fakeContext = (): ReturnType<typeof sharedContext> => sharedContext({ recordStyles: true });

const names = (ops: readonly Op[]): string[] => ops.map((o) => o.op);
const HALF_PI = Math.PI / 2;

describe('cssColour', () => {
  it('spells 0xRRGGBB plus alpha as rgba()', () => {
    expect(cssColour(0x1b1f2a, 1)).toBe('rgba(27, 31, 42, 1)');
    expect(cssColour(0x009e73, 0.6)).toBe('rgba(0, 158, 115, 0.6)');
  });
});

describe('canvasGraphics — Phaser Graphics semantics over a 2D context', () => {
  it('squares off every stroke end, the way a Phaser line quad ends', () => {
    const ctx = fakeContext();
    canvasGraphics(ctx);
    expect(ctx.lineCap).toBe('butt');
    expect(ctx.lineJoin).toBe('miter');
    // Written, not left to the defaults: a context handed over mid-use may hold others.
    expect(ctx.ops).toEqual([
      { op: 'set:lineCap', args: ['butt'] },
      { op: 'set:lineJoin', args: ['miter'] },
    ]);
  });

  it('runs every fill and stroke under the style it was given — written before the draw', () => {
    // Each draw is given a style no draw before it had, so a style written after its draw,
    // or never, would leave it under the previous one.
    const ctx = fakeContext();
    const g = canvasGraphics(ctx);
    g.fillStyle(0x112233);
    g.fillRect(0, 0, 2, 2); // an opaque batch: one fill, when flushed ...
    g.fillRect(2, 0, 2, 2);
    g.fillStyle(0x445566, 0.5);
    g.fillRect(0, 4, 2, 2); // ... which a translucent rect does before its own fillRect
    g.fillStyle(0x778899);
    g.fillCircle(5, 5, 2);
    g.lineStyle(3, 0xaabbcc, 0.75);
    g.lineBetween(0, 0, 9, 9);
    g.flush();
    expect(stylesAtDraws(ctx.ops)).toEqual([
      { op: 'fill', fillStyle: 'rgba(17, 34, 51, 1)' },
      { op: 'fillRect', fillStyle: 'rgba(68, 85, 102, 0.5)' },
      { op: 'fill', fillStyle: 'rgba(119, 136, 153, 1)' },
      { op: 'stroke', strokeStyle: 'rgba(170, 187, 204, 0.75)', lineWidth: 3 },
    ]);
  });

  it('LATCHES styles: one lineStyle applies to every later stroke, alpha defaulting to 1', () => {
    const ctx = fakeContext();
    const g = canvasGraphics(ctx);
    g.lineStyle(3, 0x009e73);
    g.lineBetween(0, 0, 10, 0);
    g.lineBetween(0, 5, 10, 5);
    const strokes = ctx.ops.filter((o) => o.op === 'stroke');
    expect(strokes).toHaveLength(2);
    // Each stroke re-applies the latched style right before it runs.
    const styleWrites = ctx.ops.filter((o) => o.op === 'set:strokeStyle').map((o) => o.args[0]);
    expect(styleWrites).toEqual(['rgba(0, 158, 115, 1)', 'rgba(0, 158, 115, 1)']);
    expect(ctx.ops.filter((o) => o.op === 'set:lineWidth').map((o) => o.args[0])).toEqual([3, 3]);
  });

  it('LATCHES fills too: a fillStyle with no alpha fills opaque, and holds until restated', () => {
    const ctx = fakeContext();
    const g = canvasGraphics(ctx);
    g.fillStyle(0xf0e442);
    g.fillCircle(0, 0, 4);
    g.fillTriangle(0, 0, 4, 0, 0, 4);
    const fills = ctx.ops.filter((o) => o.op === 'set:fillStyle').map((o) => o.args[0]);
    expect(fills).toEqual(['rgba(240, 228, 66, 1)', 'rgba(240, 228, 66, 1)']);
    // ... and an opaque fill is what a rect batches under: no alpha means alpha 1.
    g.fillRect(0, 0, 2, 2);
    g.flush();
    expect(ctx.ops.filter((o) => o.op === 'rect')).toHaveLength(1);
  });

  it('composites every primitive ON ITS OWN — two translucent strokes are two stroke() calls', () => {
    // Overlapping primitives at alpha 0.6 compound where they cross, exactly as two Phaser
    // primitives blended in turn do. One path stroked once would not.
    const ctx = fakeContext();
    const g = canvasGraphics(ctx);
    g.lineStyle(1, 0x009e73, 0.6);
    g.lineBetween(0, 0, 10, 10);
    g.lineBetween(10, 0, 0, 10);
    expect(names(ctx.ops).filter((n) => n === 'stroke')).toHaveLength(2);
    expect(names(ctx.ops).filter((n) => n === 'beginPath')).toHaveLength(2);
  });

  it('lineBetween is one open sub-path from the first point to the second', () => {
    const ctx = fakeContext();
    canvasGraphics(ctx).lineBetween(1, 2, 3, 4);
    expect(ctx.ops.filter((o) => !o.op.startsWith('set:'))).toEqual([
      { op: 'beginPath', args: [] },
      { op: 'moveTo', args: [1, 2] },
      { op: 'lineTo', args: [3, 4] },
      { op: 'stroke', args: [] },
    ]);
  });

  it('fillTriangle closes and fills the three points under the latched fill', () => {
    const ctx = fakeContext();
    const g = canvasGraphics(ctx);
    g.fillStyle(0xf0e442, 1);
    g.fillTriangle(0, 0, 4, 0, 0, 4);
    expect(ctx.ops.filter((o) => !o.op.startsWith('set:'))).toEqual([
      { op: 'beginPath', args: [] },
      { op: 'moveTo', args: [0, 0] },
      { op: 'lineTo', args: [4, 0] },
      { op: 'lineTo', args: [0, 4] },
      { op: 'closePath', args: [] },
      { op: 'fill', args: [] },
    ]);
    expect(ctx.ops.find((o) => o.op === 'set:fillStyle')!.args[0]).toBe('rgba(240, 228, 66, 1)');
  });

  it('fillCircle and strokeCircle trace one full turn', () => {
    const ctx = fakeContext();
    const g = canvasGraphics(ctx);
    g.fillCircle(5, 6, 7);
    g.strokeCircle(8, 9, 10);
    const arcs = ctx.ops.filter((o) => o.op === 'arc').map((o) => o.args);
    expect(arcs).toEqual([
      [5, 6, 7, 0, Math.PI * 2],
      [8, 9, 10, 0, Math.PI * 2],
    ]);
    expect(names(ctx.ops).filter((n) => n === 'fill' || n === 'stroke')).toEqual([
      'fill',
      'stroke',
    ]);
  });

  it('fillPoints fills the polygon, returning to the first point when asked to close the shape', () => {
    const ctx = fakeContext();
    const g = canvasGraphics(ctx);
    const pts = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 3 },
    ];
    g.fillPoints(pts, true);
    expect(ctx.ops.filter((o) => o.op === 'moveTo' || o.op === 'lineTo')).toEqual([
      { op: 'moveTo', args: [0, 0] },
      { op: 'lineTo', args: [4, 0] },
      { op: 'lineTo', args: [2, 3] },
      { op: 'lineTo', args: [0, 0] },
    ]);
    const open = fakeContext();
    canvasGraphics(open).fillPoints(pts);
    expect(open.ops.filter((o) => o.op === 'lineTo')).toHaveLength(2);
    expect(names(open.ops)).toContain('fill');
  });

  it('fillPoints with no points draws nothing at all', () => {
    const ctx = fakeContext();
    canvasGraphics(ctx).fillPoints([], true);
    expect(ctx.ops.filter((o) => !o.op.startsWith('set:'))).toEqual([]);
  });

  it("fillRoundedRect traces Phaser's own continuous path, corner arcs clockwise", () => {
    const ctx = fakeContext();
    canvasGraphics(ctx).fillRoundedRect(2, 2, 16, 16, 6);
    expect(ctx.ops.filter((o) => !o.op.startsWith('set:'))).toEqual([
      { op: 'beginPath', args: [] },
      { op: 'moveTo', args: [8, 2] },
      { op: 'lineTo', args: [12, 2] },
      { op: 'arc', args: [12, 8, 6, -HALF_PI, 0] },
      { op: 'lineTo', args: [18, 12] },
      { op: 'arc', args: [12, 12, 6, 0, HALF_PI] },
      { op: 'lineTo', args: [8, 18] },
      { op: 'arc', args: [8, 12, 6, HALF_PI, Math.PI] },
      { op: 'lineTo', args: [2, 8] },
      { op: 'arc', args: [8, 8, 6, -Math.PI, -HALF_PI] },
      { op: 'fill', args: [] },
    ]);
  });

  it("strokeRoundedRect moves between its edges and corners (Phaser's separate sub-paths) and clamps the radius to half the shorter side", () => {
    const ctx = fakeContext();
    canvasGraphics(ctx).strokeRoundedRect(0, 0, 10, 4, 6); // radius 6 clamps to 2
    const path = ctx.ops.filter((o) => !o.op.startsWith('set:'));
    expect(path).toEqual([
      { op: 'beginPath', args: [] },
      { op: 'moveTo', args: [2, 0] },
      { op: 'lineTo', args: [8, 0] },
      { op: 'moveTo', args: [8, 0] },
      { op: 'arc', args: [8, 2, 2, -HALF_PI, 0] },
      { op: 'lineTo', args: [10, 2] },
      { op: 'moveTo', args: [10, 2] },
      { op: 'arc', args: [8, 2, 2, 0, HALF_PI] },
      { op: 'lineTo', args: [2, 4] },
      { op: 'moveTo', args: [2, 4] },
      { op: 'arc', args: [2, 2, 2, HALF_PI, Math.PI] },
      { op: 'lineTo', args: [0, 2] },
      { op: 'moveTo', args: [0, 2] },
      { op: 'arc', args: [2, 2, 2, -Math.PI, -HALF_PI] },
      { op: 'stroke', args: [] },
    ]);
  });

  it('never hands arc() a negative radius — a rect smaller than its 2px inset strokes at radius 0', () => {
    // The adapter stands in for Phaser's `Graphics`, which strokes a degenerate rounded
    // rect without complaint, so it must too: a real context throws on a negative radius.
    // Nothing baked strokes one today — the call that could, a Pending build's inset
    // outline (`strokeRoundedRect(x + 2, y + 2, size - 4, size - 4, 6)`, −2 × −2 on the
    // 1px-cell fallback's 2px footprint, half its shorter side −1), became tower art in the
    // visual pass — but any painter handed this surface may.
    const ctx = fakeContext();
    expect(() => canvasGraphics(ctx).strokeRoundedRect(3, 3, -2, -2, 6)).not.toThrow();
    const radii = ctx.ops.filter((o) => o.op === 'arc').map((o) => o.args[2]);
    expect(radii).toEqual([0, 0, 0, 0]);
  });

  it('fills a rounded rect at its radius’s magnitude, as Phaser does, and clamps a circle’s at 0', () => {
    const fill = fakeContext();
    canvasGraphics(fill).fillRoundedRect(0, 0, 40, 40, -6);
    expect(fill.ops.filter((o) => o.op === 'arc').map((o) => o.args[2])).toEqual([6, 6, 6, 6]);
    const circles = fakeContext();
    const g = canvasGraphics(circles);
    expect(() => g.fillCircle(5, 5, -1)).not.toThrow();
    expect(() => g.strokeCircle(5, 5, -3)).not.toThrow();
    expect(circles.ops.filter((o) => o.op === 'arc').map((o) => o.args[2])).toEqual([0, 0]);
  });

  it("a rounded rect with no radius takes Phaser's 20px default", () => {
    const fill = fakeContext();
    canvasGraphics(fill).fillRoundedRect(0, 0, 100, 100);
    expect(fill.ops.find((o) => o.op === 'moveTo')!.args).toEqual([20, 0]);
    const stroke = fakeContext();
    canvasGraphics(stroke).strokeRoundedRect(0, 0, 100, 100);
    expect(stroke.ops.find((o) => o.op === 'moveTo')!.args).toEqual([20, 0]);
  });
});

describe('canvasGraphics — opaque same-colour rects fill as ONE path (no seams)', () => {
  it('batches consecutive opaque rects of one colour into a single fill, drawn on flush', () => {
    const ctx = fakeContext();
    const g = canvasGraphics(ctx);
    g.fillStyle(0x3a4358, 1);
    g.fillRect(0, 0, 10, 10);
    g.fillRect(10, 0, 10, 10);
    g.fillRect(20, 0, 10, 10);
    // Nothing is painted until something ends the batch.
    expect(names(ctx.ops)).not.toContain('fill');
    g.flush();
    expect(ctx.ops.filter((o) => !o.op.startsWith('set:'))).toEqual([
      { op: 'beginPath', args: [] },
      { op: 'rect', args: [0, 0, 10, 10] },
      { op: 'rect', args: [10, 0, 10, 10] },
      { op: 'rect', args: [20, 0, 10, 10] },
      { op: 'fill', args: [] },
    ]);
    expect(ctx.ops.find((o) => o.op === 'set:fillStyle')!.args[0]).toBe('rgba(58, 67, 88, 1)');
    // A second flush has nothing left to paint.
    const before = ctx.ops.length;
    g.flush();
    expect(ctx.ops.length).toBe(before);
  });

  it('a colour change ends the batch, so each colour paints in its own turn and in order', () => {
    const ctx = fakeContext();
    const g = canvasGraphics(ctx);
    g.fillStyle(0x1b1f2a, 1);
    g.fillRect(0, 0, 100, 100); // floor
    g.fillStyle(0x3a4358, 1);
    g.fillRect(0, 0, 10, 10); // border cells
    g.fillRect(10, 0, 10, 10);
    g.flush();
    const fills = ctx.ops.filter((o) => o.op === 'fill');
    expect(fills).toHaveLength(2);
    const styles = ctx.ops.filter((o) => o.op === 'set:fillStyle').map((o) => o.args[0]);
    expect(styles).toEqual(['rgba(27, 31, 42, 1)', 'rgba(58, 67, 88, 1)']);
    // The floor's single rect is painted BEFORE the border's two.
    const rects = ctx.ops.filter((o) => o.op === 'rect').map((o) => o.args);
    expect(rects).toEqual([
      [0, 0, 100, 100],
      [0, 0, 10, 10],
      [10, 0, 10, 10],
    ]);
  });

  it('any other primitive paints the batch first, so draw order survives', () => {
    const ctx = fakeContext();
    const g = canvasGraphics(ctx);
    g.fillStyle(0x3a4358, 1);
    g.fillRect(0, 0, 10, 10);
    g.fillStyle(0x56b4e9, 1);
    g.fillTriangle(0, 0, 10, 5, 0, 10); // the entrance glyph, over the border
    const order = names(ctx.ops).filter((n) => n === 'rect' || n === 'moveTo');
    expect(order).toEqual(['rect', 'moveTo']);
    for (const draw of [
      (h: ReturnType<typeof canvasGraphics>) => h.fillRoundedRect(0, 0, 10, 10, 2),
      (h: ReturnType<typeof canvasGraphics>) => h.strokeRoundedRect(0, 0, 10, 10, 2),
      (h: ReturnType<typeof canvasGraphics>) => h.fillCircle(0, 0, 2),
      (h: ReturnType<typeof canvasGraphics>) => h.strokeCircle(0, 0, 2),
      (h: ReturnType<typeof canvasGraphics>) => h.fillPoints([{ x: 0, y: 0 }]),
      (h: ReturnType<typeof canvasGraphics>) => h.lineBetween(0, 0, 1, 1),
    ]) {
      const c = fakeContext();
      const h = canvasGraphics(c);
      h.fillStyle(0x3a4358, 1);
      h.fillRect(0, 0, 10, 10);
      draw(h);
      expect(names(c.ops).indexOf('rect')).toBeGreaterThanOrEqual(0);
      expect(names(c.ops).indexOf('rect')).toBeLessThan(names(c.ops).lastIndexOf('beginPath'));
    }
  });

  it('never merges TRANSLUCENT rects — each fills on its own, so their overlaps still compound', () => {
    const ctx = fakeContext();
    const g = canvasGraphics(ctx);
    g.fillStyle(0x009e73, 0.6);
    g.fillRect(0, 0, 10, 10);
    g.fillRect(5, 0, 10, 10);
    expect(ctx.ops.filter((o) => o.op === 'fillRect').map((o) => o.args)).toEqual([
      [0, 0, 10, 10],
      [5, 0, 10, 10],
    ]);
    expect(names(ctx.ops)).not.toContain('rect');
  });

  it('a translucent rect after an opaque batch paints the batch first', () => {
    const ctx = fakeContext();
    const g = canvasGraphics(ctx);
    g.fillStyle(0x3a4358, 1);
    g.fillRect(0, 0, 10, 10);
    g.fillStyle(0x3a4358, 0.5);
    g.fillRect(0, 0, 10, 10);
    expect(names(ctx.ops).filter((n) => n === 'fill' || n === 'fillRect')).toEqual([
      'fill',
      'fillRect',
    ]);
  });
});
