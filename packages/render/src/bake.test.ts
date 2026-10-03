// bake.test.ts — painting static art into textures: the scale fit (degrade, never fail),
// the atlas and board layouts, the paint passes against a recording context, and the
// rebake trigger keyed on cell size, effective dpr and colour mode.

import { describe, it, expect } from 'vitest';
import {
  bakedTextureKey,
  createBakeTracker,
  fitScale,
  sameInputs,
  layoutAtlas,
  layoutBoard,
  paintAtlas,
  paintBoard,
  ATLAS_GUTTER_TEXELS,
  ATLAS_MAX_WIDTH,
  MIN_BAKE_SCALE,
  type BakeInputs,
} from './bake';
import type { ColourMode } from './types';
import { atlasFrameSpecs, PLATE_FRAME_KEY } from './art-frames';
import type { ArtCanvas2DLike } from './art-paint';
import { boardPaintOps } from './board-cells';
import { resolvePalette } from './palette';
import { HEAD_ART } from './tower-art';
import type { TowerFootprintMark } from './tower-paint';

type Op = { op: string; args: unknown[]; composite?: GlobalCompositeOperation };

/** A recording 2D context — the slice the art painter draws through, which includes the
 *  board bake's. Every fill and stroke records the composite operation it ran under, and
 *  `save`/`restore` stack that operation as a real context does. Its `arc` and `ellipse`
 *  reject a negative radius as a real 2D context does (the HTML spec's `IndexSizeError`) —
 *  so a bake that would throw in a browser throws here too. */
function fakeContext(): ArtCanvas2DLike & { ops: Op[] } {
  const ops: Op[] = [];
  let composite: GlobalCompositeOperation = 'source-over';
  const saved: GlobalCompositeOperation[] = [];
  const call =
    (op: string) =>
    (...args: unknown[]): void => {
      const radii = op === 'arc' ? args.slice(2, 3) : op === 'ellipse' ? args.slice(2, 4) : [];
      if (radii.some((r) => (r as number) < 0)) {
        throw new RangeError(`IndexSizeError: ${op} radius ${radii.join(', ')} is negative`);
      }
      ops.push({ op, args });
    };
  const draw =
    (op: string) =>
    (...args: unknown[]): void => {
      ops.push({ op, args, composite });
    };
  const ctx = {
    ops,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
    get globalCompositeOperation(): GlobalCompositeOperation {
      return composite;
    },
    set globalCompositeOperation(v: GlobalCompositeOperation) {
      composite = v;
    },
    beginPath: call('beginPath'),
    closePath: call('closePath'),
    moveTo: call('moveTo'),
    lineTo: call('lineTo'),
    arc: call('arc'),
    ellipse: call('ellipse'),
    rect: call('rect'),
    fill: draw('fill'),
    stroke: draw('stroke'),
    fillRect: draw('fillRect'),
    setLineDash: call('setLineDash'),
    transform: call('transform'),
    save: (...args: unknown[]): void => {
      saved.push(composite);
      ops.push({ op: 'save', args });
    },
    restore: (...args: unknown[]): void => {
      composite = saved.pop() ?? composite;
      ops.push({ op: 'restore', args });
    },
    setTransform: call('setTransform'),
    clip: call('clip'),
  };
  return ctx;
}

/** A stand-in `Path2D` factory: the "path" carries the string it was made from. */
const makePath = (d: string): Path2D => ({ d }) as unknown as Path2D;

/** Each frame's ops, split where the context's save/restore nesting returns to the top —
 *  the bake opens one save per frame and every art call nests its own inside it. */
function frameSegments(ops: readonly Op[]): Op[][] {
  const segments: Op[][] = [];
  let depth = 0;
  let current: Op[] = [];
  for (const o of ops) {
    current.push(o);
    if (o.op === 'save') depth++;
    if (o.op === 'restore') {
      depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
      if (depth === 0) {
        segments.push(current);
        current = [];
      }
    }
  }
  expect(depth).toBe(0);
  expect(current).toEqual([]);
  return segments;
}

const PAL = resolvePalette('default');
const GEOMETRY = { cols: 28, rows: 24, entrance: { col: 0, row: 11 }, exit: { col: 27, row: 11 } };

describe('fitScale — degrade, never fail', () => {
  it('keeps the dpr when it fits', () => {
    expect(fitScale(2, () => true)).toBe(2);
    expect(fitScale(1.5, () => true)).toBe(1.5);
    // A dpr below 1 (a zoomed-out browser) comes through `clampDpr` unchanged: kept as is,
    // never rounded up to 1.
    expect(fitScale(0.9, () => true)).toBe(0.9);
  });

  it('steps down until the art fits', () => {
    const tried: number[] = [];
    const scale = fitScale(2, (s) => {
      tried.push(s);
      return s <= 1.3;
    });
    expect(scale).toBeCloseTo(1.28, 9); // 2 → 1.6 → 1.28
    expect(tried).toHaveLength(3);
  });

  it('stops at the floor even when nothing fits', () => {
    expect(fitScale(2, () => false)).toBe(MIN_BAKE_SCALE);
  });

  it('treats a nonsense dpr as 1', () => {
    expect(fitScale(0, () => true)).toBe(1);
    expect(fitScale(-3, () => true)).toBe(1);
  });
});

describe('layoutAtlas', () => {
  it('places every frame at the dpr, inside the texture, without overlap', () => {
    const layout = layoutAtlas(24, 2, 8192);
    expect(layout.scale).toBe(2);
    const specs = atlasFrameSpecs(24, 2);
    expect(layout.frames.size).toBe(specs.length);
    expect(layout.width).toBeLessThanOrEqual(ATLAS_MAX_WIDTH);
    const frames = [...layout.frames.values()];
    for (const f of frames) {
      expect(f.x).toBeGreaterThanOrEqual(ATLAS_GUTTER_TEXELS);
      expect(f.y).toBeGreaterThanOrEqual(ATLAS_GUTTER_TEXELS);
      expect(f.x + f.width).toBeLessThanOrEqual(layout.width);
      expect(f.y + f.height).toBeLessThanOrEqual(layout.height);
    }
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        const a = frames[i]!;
        const b = frames[j]!;
        const apart =
          a.x + a.width + ATLAS_GUTTER_TEXELS <= b.x ||
          b.x + b.width + ATLAS_GUTTER_TEXELS <= a.x ||
          a.y + a.height + ATLAS_GUTTER_TEXELS <= b.y ||
          b.y + b.height + ATLAS_GUTTER_TEXELS <= a.y;
        expect(apart).toBe(true);
      }
    }
    // Each laid-out frame keeps its spec's size, anchor and painter.
    for (const spec of specs) {
      const f = layout.frames.get(spec.key)!;
      expect([f.width, f.height, f.anchorX, f.anchorY]).toEqual([
        spec.width,
        spec.height,
        spec.anchorX,
        spec.anchorY,
      ]);
      expect(typeof f.paint).toBe('function');
    }
  });

  it('lowers the scale rather than exceed the renderer’s maximum texture size', () => {
    const roomy = layoutAtlas(60, 2, 8192);
    expect(roomy.scale).toBe(2);
    const cramped = layoutAtlas(60, 2, 512);
    expect(cramped.scale).toBeLessThan(2);
    expect(cramped.width).toBeLessThanOrEqual(512);
    expect(cramped.height).toBeLessThanOrEqual(512);
    // The frames are sized for the scale actually used: the plate frame spans its footprint
    // (its offset shadow reaches the footprint's right edge, no further) plus the pad.
    expect(cramped.frames.size).toBe(roomy.frames.size);
    const frame = cramped.frames.get(PLATE_FRAME_KEY)!;
    expect(frame.width).toBe(Math.ceil(60 * 2 * cramped.scale) + 4);
  });
});

describe('paintAtlas', () => {
  it('paints each frame clipped to its own rectangle, in frame-local CSS px scaled to texels', () => {
    const layout = layoutAtlas(10, 2, 4096);
    const ctx = fakeContext();
    paintAtlas(ctx, layout, PAL, makePath);
    const frames = [...layout.frames.values()];
    // One top-level save/restore per frame, every nested save inside it restored too — so
    // no frame's clip, transform or composite operation leaks into the next.
    const segments = frameSegments(ctx.ops);
    expect(segments).toHaveLength(frames.length);
    segments.forEach((ops, i) => {
      const f = frames[i]!;
      const clip = ops.findIndex((o) => o.op === 'clip');
      expect(ops[clip - 1]).toEqual({ op: 'rect', args: [f.x, f.y, f.width, f.height] });
      // The clip is set in texels; then the transform scales CSS px to texels at the
      // frame's corner.
      const transforms = ops.filter((o) => o.op === 'setTransform').map((o) => o.args);
      expect(transforms.slice(0, 2)).toEqual([
        [1, 0, 0, 1, 0, 0],
        [2, 0, 0, 2, f.x, f.y],
      ]);
      expect(ops.findIndex((o) => o.op === 'setTransform')).toBeLessThan(clip);
    });
  });

  it('paints every frame’s art — a batched rect included — before its clip is restored', () => {
    const layout = layoutAtlas(10, 1, 4096);
    const ctx = fakeContext();
    paintAtlas(ctx, layout, PAL, makePath);
    // The square silhouette is a single opaque fillRect, held in the adapter's batch: it
    // must be flushed inside its own frame, before that frame's restore.
    const keys = [...layout.frames.keys()];
    const inFrame = frameSegments(ctx.ops)[keys.indexOf('creep:square:normal:standard')]!;
    // The square's OWN rect — not the clip's, which is also a `rect` in this slice: at 10px
    // cells r = 3.5, so the frame is 2 × (⌈3.5⌉ + 2) = 12 texels with its centre at 6, and the
    // square spans 6 ± 3.5 in frame-local px.
    const square = inFrame.findIndex(
      (o) => o.op === 'rect' && JSON.stringify(o.args) === JSON.stringify([2.5, 2.5, 7, 7]),
    );
    expect(square).toBeGreaterThanOrEqual(0);
    expect(inFrame.slice(square + 1).some((o) => o.op === 'fill')).toBe(true);
  });

  it('hands every art path string to the Path2D factory, and draws the path it gets back', () => {
    const layout = layoutAtlas(10, 1, 4096);
    const ctx = fakeContext();
    const made: string[] = [];
    paintAtlas(ctx, layout, PAL, (d) => {
      made.push(d);
      return makePath(d);
    });
    expect(made.length).toBeGreaterThan(0);
    const drawn = ctx.ops
      .filter((o) => (o.op === 'fill' || o.op === 'stroke') && o.args.length > 0)
      .map((o) => (o.args[0] as { d: string }).d);
    expect(new Set(drawn)).toEqual(new Set(made));
  });

  it('fades a pending build inside its own frame, and draws its dashed rim after at full strength', () => {
    const layout = layoutAtlas(10, 1, 4096);
    const ctx = fakeContext();
    paintAtlas(ctx, layout, PAL, makePath);
    const keys = [...layout.frames.keys()];
    const segments = frameSegments(ctx.ops);
    keys.forEach((key, i) => {
      const ops = segments[i]!;
      const drawn = ops.filter((o) => o.composite !== undefined);
      const fades = drawn.filter((o) => o.composite === 'destination-in');
      // Only a pending build fades: its plate on its own first (every look but the
      // plateless mine), then plate and head together — each fade ONE fillRect, after its
      // frame's clip is set...
      if (!key.startsWith('tower:pending:')) {
        expect(fades, key).toEqual([]);
        return;
      }
      const mark = key.split(':')[2] as TowerFootprintMark;
      expect(fades, key).toHaveLength(HEAD_ART[mark].plate ? 2 : 1);
      const clip = ops.findIndex((o) => o.op === 'clip');
      for (const fade of fades) {
        expect(fade.op).toBe('fillRect');
        expect(ops.indexOf(fade)).toBeGreaterThan(clip);
      }
      // ...the head is painted BETWEEN the two fades, over the faded plate...
      if (fades.length === 2) {
        const between = drawn.slice(drawn.indexOf(fades[0]!) + 1, drawn.indexOf(fades[1]!));
        expect(
          between.some((o) => o.op === 'fill'),
          key,
        ).toBe(true);
        for (const o of between) expect(o.composite, key).toBe('source-over');
      }
      // ...and everything drawn after the last — the dashed rim — composites normally again,
      // so the rim is painted over the faded picture rather than cutting into it.
      const after = drawn.slice(drawn.indexOf(fades[fades.length - 1]!) + 1);
      expect(
        after.some((o) => o.op === 'stroke'),
        key,
      ).toBe(true);
      for (const o of after) expect(o.composite, key).toBe('source-over');
    });
  });
});

describe('paintAtlas at the 1px-cell fallback (a hidden or tiny board)', () => {
  it('bakes every frame at 1px and 2px cells without a throw — the pending builds included', () => {
    // At 1px cells a 2×2 footprint is 2px, and a unit of the tower art's 64-unit box is a
    // few hundredths of a pixel, so a radius worked out by taking an inset or a stroke off a
    // size can come out negative: a real context's arc() and ellipse() reject that (so do
    // this fake's). One once threw out of the renderer's draw() and froze the whole game.
    for (const [cellPx, dpr] of [
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
    ] as const) {
      const layout = layoutAtlas(cellPx, dpr, 4096);
      const ctx = fakeContext();
      expect(
        () => paintAtlas(ctx, layout, PAL, makePath),
        `cellPx ${cellPx}, dpr ${dpr}`,
      ).not.toThrow();
      expect(ctx.ops.filter((o) => o.op === 'clip')).toHaveLength(layout.frames.size);
      const pending = [...layout.frames.keys()].filter((k) => k.startsWith('tower:pending:'));
      expect(pending.length).toBeGreaterThan(0);
      expect(ctx.ops.filter((o) => o.op === 'stroke').length).toBeGreaterThan(0);
    }
  });
});

describe('layoutBoard / paintBoard', () => {
  it('sizes the board texture to the board in device pixels', () => {
    expect(layoutBoard(GEOMETRY, 32, 1, 8192)).toEqual({
      scale: 1,
      width: 28 * 32,
      height: 24 * 32,
    });
    expect(layoutBoard(GEOMETRY, 32, 2, 8192)).toEqual({
      scale: 2,
      width: 28 * 64,
      height: 24 * 64,
    });
    // A fractional dpr rounds the texture UP, so the board's last texels are never cut:
    // 28 × 13 × 1.1 = 400.4 texels needs 401 (rounding or flooring would give 400), and
    // 24 × 13 × 1.1 = 343.2 needs 344.
    expect(layoutBoard(GEOMETRY, 13, 1.1, 8192)).toEqual({ scale: 1.1, width: 401, height: 344 });
  });

  it('lowers the scale rather than exceed the maximum texture size', () => {
    const bake = layoutBoard(GEOMETRY, 80, 2, 4096); // 28 × 80 × 2 = 4480 > 4096
    expect(bake.scale).toBeLessThan(2);
    expect(bake.width).toBeLessThanOrEqual(4096);
    expect(bake.height).toBeLessThanOrEqual(4096);
    // ... and a board too TALL for the limit, though narrow enough, is lowered just the same:
    // 100 rows × 30 × 2 = 6000 texels high, only 600 wide.
    const tall = layoutBoard({ cols: 10, rows: 100 }, 30, 2, 4096);
    expect(tall.scale).toBeLessThan(2);
    expect(tall.height).toBeLessThanOrEqual(4096);
  });

  it('paints the board at the 1px-cell fallback and at 2px cells without a throw (a hidden or tiny board)', () => {
    // A board under ~56×48 CSS px — hidden boards measure 0×0 — projects 1px cells. Its plan
    // is only rects and a triangle, but it must bake there all the same.
    for (const [cellPx, dpr] of [
      [1, 1],
      [2, 2],
    ] as const) {
      const ctx = fakeContext();
      const bake = layoutBoard(GEOMETRY, cellPx, dpr, 8192);
      expect(() =>
        paintBoard(ctx, boardPaintOps(GEOMETRY, PAL), GEOMETRY, cellPx, bake),
      ).not.toThrow();
      expect(ctx.ops.filter((o) => o.op === 'fill').length).toBeGreaterThan(0);
    }
  });

  it('never sizes a texture below one texel', () => {
    expect(layoutBoard({ cols: 0, rows: 0 }, 1, 1, 4096)).toEqual({
      scale: 1,
      width: 1,
      height: 1,
    });
  });

  it('paints the board plan board-locally at the bake scale, the border ring as one path', () => {
    const ctx = fakeContext();
    const bake = layoutBoard(GEOMETRY, 10, 2, 8192);
    paintBoard(ctx, boardPaintOps(GEOMETRY, PAL), GEOMETRY, 10, bake);
    expect(ctx.ops[0]).toEqual({ op: 'setTransform', args: [2, 0, 0, 2, 0, 0] });
    // Floor (one rect), then the 98 border cells in ONE fill, then entrance and exit.
    const fills = ctx.ops.filter((o) => o.op === 'fill');
    expect(fills).toHaveLength(4); // floor, the whole border ring, the entrance, the exit
    const rects = ctx.ops.filter((o) => o.op === 'rect');
    expect(rects).toHaveLength(1 + 98 + 1);
    expect(rects[0]!.args).toEqual([0, 0, 280, 240]);
    // The exit square closes the board — and is flushed, not left in the batch.
    expect(rects[rects.length - 1]!.args).toEqual([27 * 10 + 2.5, 11 * 10 + 2.5, 5, 5]);
    expect(ctx.ops[ctx.ops.length - 1]!.op).toBe('fill');
  });
});

describe('createBakeTracker — rebake only when the art’s inputs change', () => {
  const at = (cellPx: number, dpr = 2, mode: ColourMode = 'default'): BakeInputs => ({
    cellPx,
    dpr,
    mode,
  });

  it('bakes on the first frame, then not again for the same inputs once that bake succeeded', () => {
    const t = createBakeTracker();
    expect(t.needsBake(at(30))).toBe(true);
    t.recordBaked(at(30));
    for (let i = 0; i < 5; i++) expect(t.needsBake(at(30))).toBe(false);
  });

  it('records nothing by being asked: until a bake succeeds, every ask says one is due', () => {
    // The ordering that made a failed bake permanent: asking used to RECORD the inputs, so a
    // bake that then failed was not retried until the next resize.
    const t = createBakeTracker();
    for (let i = 0; i < 3; i++) expect(t.needsBake(at(30))).toBe(true);
    t.recordBaked(at(30));
    expect(t.needsBake(at(30))).toBe(false);
    // A rebake that fails leaves the LAST SUCCESS standing: the new inputs are still due…
    expect(t.needsBake(at(24))).toBe(true);
    expect(t.needsBake(at(24))).toBe(true);
    // … and going back to the baked ones needs nothing.
    expect(t.needsBake(at(30))).toBe(false);
  });

  it('rebakes when the cell size changes (a resize)', () => {
    const t = createBakeTracker();
    t.recordBaked(at(30));
    expect(t.needsBake(at(24))).toBe(true);
  });

  it('rebakes when the effective dpr changes (a monitor move or a zoom)', () => {
    const t = createBakeTracker();
    t.recordBaked(at(30, 2));
    expect(t.needsBake(at(30, 1.5))).toBe(true);
  });

  it('rebakes when the colour mode changes', () => {
    const t = createBakeTracker();
    t.recordBaked(at(30, 2, 'default'));
    expect(t.needsBake(at(30, 2, 'tritan'))).toBe(true);
    t.recordBaked(at(30, 2, 'tritan'));
    expect(t.needsBake(at(30, 2, 'tritan'))).toBe(false);
    expect(t.needsBake(at(30, 2, 'protan'))).toBe(true);
  });

  it('a change back is still a change', () => {
    const t = createBakeTracker();
    t.recordBaked(at(30));
    t.recordBaked(at(31));
    expect(t.needsBake(at(30))).toBe(true);
  });

  it('knows what the art on screen was baked for: nothing until a bake succeeds, then the last success', () => {
    const t = createBakeTracker();
    expect(t.baked()).toBeNull();
    t.needsBake(at(30)); // asking records nothing
    expect(t.baked()).toBeNull();
    t.recordBaked(at(30, 2, 'protan'));
    expect(t.baked()).toEqual(at(30, 2, 'protan'));
    t.recordBaked(at(24, 1.5));
    expect(t.baked()).toEqual(at(24, 1.5));
  });

  it('counts two sets of inputs the same only when the cell size, dpr and colour mode all match', () => {
    expect(sameInputs(at(30, 2, 'default'), at(30, 2, 'default'))).toBe(true);
    expect(sameInputs(at(30, 2, 'default'), at(31, 2, 'default'))).toBe(false);
    expect(sameInputs(at(30, 2, 'default'), at(30, 1.5, 'default'))).toBe(false);
    expect(sameInputs(at(30, 2, 'default'), at(30, 2, 'tritan'))).toBe(false);
  });

  it('gives every attempt its own version, failed or not, so no two attempts share a texture key', () => {
    const t = createBakeTracker();
    expect([t.nextVersion(), t.nextVersion(), t.nextVersion()]).toEqual([1, 2, 3]);
    t.recordBaked(at(30));
    expect(t.nextVersion()).toBe(4);
  });

  it('names each bake’s textures with its version, so the old ones can outlive the new ones’ creation', () => {
    expect(bakedTextureKey('wy-atlas', 3)).toBe('wy-atlas-3');
    expect(bakedTextureKey('wy-board', 1)).not.toBe(bakedTextureKey('wy-board', 2));
  });
});
