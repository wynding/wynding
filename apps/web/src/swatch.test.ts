// swatch.test.ts — the Card glyph tile's two seams (playtest round): the `GraphicsLike`
// → Canvas2D adapter's op mapping (against a recording context — jsdom has no real 2D
// context, which is also why `paintSwatch`'s null-context inertness is a contract worth
// pinning, not an accident), and the paint sequence itself: ground, body, then the mark
// through the board's shared dispatch (#89).

import { describe, it, expect } from 'vitest';
import { canvasGraphics, paintSwatch, SWATCH_SIZE_PX } from './swatch';

/** A recording 2D context: every method call and style write lands in `ops` in order, so
 *  the assertions below can see both WHAT was drawn and with WHICH latched style. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; ops: string[] } {
  const ops: string[] = [];
  const target: Record<string, unknown> = {};
  const method =
    (name: string) =>
    (...args: unknown[]): void => {
      ops.push(`${name}(${args.map((a) => String(a)).join(',')})`);
    };
  for (const name of [
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'arcTo',
    'arc',
    'fill',
    'stroke',
    'fillRect',
    'setTransform',
  ]) {
    target[name] = method(name);
  }
  for (const prop of ['fillStyle', 'strokeStyle', 'lineWidth']) {
    Object.defineProperty(target, prop, {
      set: (v: unknown) => {
        ops.push(`${prop}=${String(v)}`);
      },
    });
  }
  return { ctx: target as unknown as CanvasRenderingContext2D, ops };
}

describe('canvasGraphics — the GraphicsLike → 2D adapter', () => {
  it('lineBetween strokes with the LATCHED lineStyle (Phaser semantics: style persists until restated)', () => {
    const { ctx, ops } = recordingCtx();
    const g = canvasGraphics(ctx);
    g.lineStyle(2, 0xff0000, 1);
    g.lineBetween(1, 2, 3, 4);
    g.lineBetween(5, 6, 7, 8); // second stroke, NO second lineStyle call
    expect(ops).toEqual([
      'beginPath()',
      'moveTo(1,2)',
      'lineTo(3,4)',
      'strokeStyle=rgba(255, 0, 0, 1)',
      'lineWidth=2',
      'stroke()',
      'beginPath()',
      'moveTo(5,6)',
      'lineTo(7,8)',
      'strokeStyle=rgba(255, 0, 0, 1)',
      'lineWidth=2',
      'stroke()',
    ]);
  });

  it('rounded rects trace an explicit arc path — no Canvas2D roundRect dependency', () => {
    const { ctx, ops } = recordingCtx();
    const g = canvasGraphics(ctx);
    g.fillStyle(0x009e73, 1);
    g.fillRoundedRect(0, 0, 10, 10, 3);
    expect(ops[0]).toBe('beginPath()');
    expect(ops.filter((o) => o.startsWith('arcTo'))).toHaveLength(4);
    expect(ops.at(-2)).toBe('fillStyle=rgba(0, 158, 115, 1)');
    expect(ops.at(-1)).toBe('fill()');
  });

  it('strokeCircle and fillCircle map to full arcs with their own latched styles', () => {
    const { ctx, ops } = recordingCtx();
    const g = canvasGraphics(ctx);
    g.lineStyle(1, 0x000000, 0.5);
    g.strokeCircle(5, 5, 4);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(5, 5, 2);
    expect(ops.filter((o) => o.startsWith('arc('))).toHaveLength(2);
    expect(ops).toContain('strokeStyle=rgba(0, 0, 0, 0.5)');
    expect(ops).toContain('fillStyle=rgba(255, 255, 255, 1)');
  });
});

describe('canvasGraphics — adapter completeness', () => {
  it('strokeRoundedRect, fillTriangle, and fillPoints map faithfully (adapter completeness — unreachable from the mark vocabulary but part of GraphicsLike)', () => {
    const { ctx, ops } = recordingCtx();
    const g = canvasGraphics(ctx);
    g.lineStyle(2, 0x4aa3ff, 1);
    g.strokeRoundedRect(0, 0, 8, 8, 2);
    expect(ops.filter((o) => o.startsWith('arcTo'))).toHaveLength(4);
    expect(ops.at(-1)).toBe('stroke()');
    ops.length = 0;
    g.fillStyle(0xffffff, 0.5);
    g.fillTriangle(0, 0, 4, 0, 2, 4);
    expect(ops).toContain('lineTo(2,4)');
    expect(ops.at(-1)).toBe('fill()');
    ops.length = 0;
    g.fillPoints(
      [
        { x: 0, y: 0 },
        { x: 4, y: 1 },
        { x: 2, y: 3 },
      ],
      true,
    );
    expect(ops).toContain('closePath()');
    expect(ops.at(-1)).toBe('fill()');
    ops.length = 0;
    g.fillPoints([], true); // empty input: a no-op, never a throw
    expect(ops).toEqual([]);
  });
});

describe('paintSwatch', () => {
  it('is inert without a 2D context (jsdom) — the Card text carries everything', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => {
      paintSwatch(canvas, 'basic', 'default');
    }).not.toThrow();
  });

  it('paints ground, body, then the mark — the board sequence at tile scale — into a dpr-sized store', () => {
    const { ctx, ops } = recordingCtx();
    const canvas = {
      getContext: () => ctx,
      width: 0,
      height: 0,
      ownerDocument: document, // dpr source (`canvas.ownerDocument.defaultView`) — jsdom reports 1
    } as unknown as HTMLCanvasElement;
    paintSwatch(canvas, 'slow', 'default');
    // Backing store sized to the tile × dpr (jsdom reports dpr 1).
    expect(canvas.width).toBe(SWATCH_SIZE_PX);
    expect(canvas.height).toBe(SWATCH_SIZE_PX);
    expect(ops[0]).toBe('setTransform(1,0,0,1,0,0)');
    // Ground: the DEFAULT palette's floor (0x1b1f2a) as a full-tile fillRect…
    const ground = ops.findIndex((o) => o === 'fillStyle=rgba(27, 31, 42, 1)');
    const groundRect = ops.findIndex((o) => o.startsWith('fillRect(0,0,'));
    // …then the tower body (0x009e73 in DEFAULT), then `slow`'s `'ringed'` mark — a
    // stroked circle back in the floor colour, via the shared dispatch.
    const body = ops.findIndex((o) => o === 'fillStyle=rgba(0, 158, 115, 1)');
    const markStyle = ops.lastIndexOf('strokeStyle=rgba(27, 31, 42, 1)');
    const markArc = ops.findIndex((o) => o.startsWith('arc('));
    expect(ground).toBeGreaterThanOrEqual(0);
    expect(groundRect).toBeGreaterThan(ground);
    expect(body).toBeGreaterThan(ground);
    expect(markArc).toBeGreaterThan(body);
    expect(markStyle).toBeGreaterThan(body);
  });

  it("a mode change changes the paint — protan's tower blue replaces the default green", () => {
    const { ctx, ops } = recordingCtx();
    const canvas = {
      getContext: () => ctx,
      width: 0,
      height: 0,
      ownerDocument: document, // dpr source (`canvas.ownerDocument.defaultView`) — jsdom reports 1
    } as unknown as HTMLCanvasElement;
    paintSwatch(canvas, 'basic', 'protan');
    expect(ops.some((o) => o === 'fillStyle=rgba(0, 158, 115, 1)')).toBe(false);
    expect(ops.some((o) => o.startsWith('fillStyle=rgba(0, 114, 178'))).toBe(true); // 0x0072b2
  });
});
