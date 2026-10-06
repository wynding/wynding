// swatch.test.ts — the Card tower tile (playtest round; redrawn by the visual pass, #181):
// its null-context inertness (jsdom has no real 2D context, which is why that is a contract
// worth pinning, not an accident) and the paint sequence itself, against a recording
// context — ground, then the tower's plate, then its head in its role colour, drawn by the
// board's own art and painter (`paintTowerArt`, #89) at one scale for every tower.
//
// The 2D adapter the tile draws through is the render package's (`artGraphics` over
// `canvasGraphics`), unit tested there (`canvas-graphics.test.ts`, `art-paint.test.ts`); the
// tile no longer carries a copy of its own.

import { describe, it, expect, vi } from 'vitest';
import { resolvePalette, towerArtFit, type PathFactory } from '@wynding/render';
import { paintSwatch, releaseSwatch, SWATCH_SIZE_PX } from './swatch';

/** A recording 2D context: every method call and style write lands in `ops` in order, so
 *  the assertions below can see both WHAT was drawn and with WHICH style. */
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
    'arc',
    'ellipse',
    'rect',
    'fill',
    'stroke',
    'fillRect',
    'setTransform',
    'transform',
    'save',
    'restore',
    'clip',
    'setLineDash',
  ]) {
    target[name] = method(name);
  }
  for (const prop of [
    'fillStyle',
    'strokeStyle',
    'lineWidth',
    'lineCap',
    'lineJoin',
    'globalCompositeOperation',
  ]) {
    Object.defineProperty(target, prop, {
      set: (v: unknown) => {
        ops.push(`${prop}=${String(v)}`);
      },
    });
  }
  return { ctx: target as unknown as CanvasRenderingContext2D, ops };
}

/** A `Path2D` stand-in (jsdom has none) that remembers the path string it was made from. */
const recordingPaths = (): { made: string[]; makePath: PathFactory } => {
  const made: string[] = [];
  return {
    made,
    makePath: (d) => {
      made.push(d);
      return { toString: () => `path:${d}` } as unknown as Path2D;
    },
  };
};

/** A canvas the swatch can paint: its 2D context; its box on the page, the tile's size at
 *  `at` — or, without `at`, all zeros, as before it is laid out; and its window — jsdom's
 *  (dpr 1), or one at `dpr`, with `view`'s extras (a `ResizeObserver`, say). */
const fakeCanvas = (
  ctx: CanvasRenderingContext2D,
  { dpr, at, view }: { dpr?: number; at?: { left: number; top: number }; view?: object } = {},
): HTMLCanvasElement =>
  ({
    getContext: () => ctx,
    width: 0,
    height: 0,
    getBoundingClientRect: () =>
      at === undefined
        ? { left: 0, top: 0, width: 0, height: 0 }
        : { left: at.left, top: at.top, width: SWATCH_SIZE_PX, height: SWATCH_SIZE_PX },
    // The dpr source (`canvas.ownerDocument.defaultView`).
    ownerDocument:
      dpr === undefined ? document : { defaultView: { devicePixelRatio: dpr, ...view } },
  }) as unknown as HTMLCanvasElement;

const rgba = (hex: number, alpha = 1): string =>
  `rgba(${(hex >> 16) & 0xff}, ${(hex >> 8) & 0xff}, ${hex & 0xff}, ${alpha})`;

describe('paintSwatch', () => {
  it('is inert without a 2D context (jsdom) — the Card text carries everything', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => {
      paintSwatch(canvas, 'basic', 'default');
    }).not.toThrow();
  });

  it('paints ground, then the plate, then the head in its role colour with its ink glyph — the board’s art at tile scale — into a dpr-sized store', () => {
    const { ctx, ops } = recordingCtx();
    const canvas = fakeCanvas(ctx);
    paintSwatch(canvas, 'slow', 'default', recordingPaths().makePath);
    // Backing store sized to the tile × dpr (jsdom reports dpr 1).
    expect(canvas.width).toBe(SWATCH_SIZE_PX);
    expect(canvas.height).toBe(SWATCH_SIZE_PX);
    expect(ops[0]).toBe('setTransform(1,0,0,1,0,0)');
    const pal = resolvePalette('default');
    // Ground: the DEFAULT palette's floor as a full-tile rect…
    const groundRect = ops.indexOf(`rect(0,0,${SWATCH_SIZE_PX},${SWATCH_SIZE_PX})`);
    const ground = ops.indexOf(`fillStyle=${rgba(pal.floor)}`);
    // …then the slate plate and its rim…
    const plate = ops.indexOf(`fillStyle=${rgba(pal.plate)}`);
    const rim = ops.indexOf(`strokeStyle=${rgba(pal.tower)}`);
    // …then `slow`'s head: its star in the CONTROL role colour, and the ink ring inside it.
    const head = ops.indexOf(`fillStyle=${rgba(pal.roleControl)}`);
    const ink = ops.lastIndexOf(`strokeStyle=${rgba(0x0b0e14)}`);
    expect(groundRect).toBeGreaterThan(0);
    expect(ground).toBeGreaterThan(groundRect);
    expect(plate).toBeGreaterThan(ground);
    expect(rim).toBeGreaterThan(plate);
    expect(head).toBeGreaterThan(rim);
    expect(ink).toBeGreaterThan(head);
    // No other role's colour is anywhere on the tile — the look is the slow tower's.
    for (const other of [
      pal.roleDamage,
      pal.rolePoison,
      pal.roleAir,
      pal.roleSupport,
      pal.roleBurst,
    ]) {
      expect(ops).not.toContain(`fillStyle=${rgba(other)}`);
    }
  });

  it('draws every tower at ONE scale and position — the fit for the whole tower, shadow included', () => {
    const fit = towerArtFit(SWATCH_SIZE_PX);
    const unit = fit.footprintPx / 64;
    const expected = `transform(${unit},0,0,${unit},${fit.x},${fit.y})`;
    for (const id of [
      'basic',
      'slow',
      'splash',
      'venom',
      'stun',
      'antiair',
      'beacon',
      'mine',
      'frost-splash',
    ]) {
      const { ctx, ops } = recordingCtx();
      paintSwatch(fakeCanvas(ctx), id, 'default', recordingPaths().makePath);
      const transforms = ops.filter((o) => o.startsWith('transform('));
      expect(transforms.length, id).toBeGreaterThan(0);
      for (const t of transforms) expect(t, id).toBe(expected);
    }
  });

  it('draws the mine on the bare ground — no plate under it, as on the board', () => {
    const { ctx, ops } = recordingCtx();
    paintSwatch(fakeCanvas(ctx), 'mine', 'default', recordingPaths().makePath);
    const pal = resolvePalette('default');
    expect(ops).not.toContain(`fillStyle=${rgba(pal.plate)}`);
    expect(ops).toContain(`fillStyle=${rgba(pal.roleBurst)}`);
  });

  it('hands the art’s path strings to the Path2D factory, and fills and strokes the paths it gets back', () => {
    const { ctx, ops } = recordingCtx();
    const paths = recordingPaths();
    paintSwatch(fakeCanvas(ctx), 'venom', 'default', paths.makePath);
    // The droplet is a path string; the factory made it, and the context drew it.
    expect(paths.made.some((d) => d.startsWith('M32 10C'))).toBe(true);
    const drawn = ops.filter((o) => /^(fill|stroke)\(path:/.test(o));
    expect(drawn.length).toBeGreaterThan(0);
  });

  it('draws the plate’s rim on the canvas’s own device pixels — crisp at a fractional dpr, as on the board', () => {
    const { ctx, ops } = recordingCtx();
    const canvas = fakeCanvas(ctx, { dpr: 1.5 });
    paintSwatch(canvas, 'basic', 'default', recordingPaths().makePath);
    expect(ops[0]).toBe('setTransform(1.5,0,0,1.5,0,0)');
    const fit = towerArtFit(SWATCH_SIZE_PX);
    const unit = fit.footprintPx / 64;
    // The rim's path is the one stroked in the rim colour: its first point is on the top
    // edge (design units, under the art's transform), and its width follows the colour.
    const stroke = ops.indexOf(`strokeStyle=${rgba(resolvePalette('default').tower)}`);
    expect(stroke).toBeGreaterThan(0);
    const moveTo = ops
      .slice(0, stroke)
      .reverse()
      .find((o) => o.startsWith('moveTo('))!;
    const top = Number(/^moveTo\([^,]+,([^)]+)\)$/.exec(moveTo)![1]);
    const width = Number(
      ops
        .slice(stroke)
        .find((o) => o.startsWith('lineWidth='))!
        .slice(10),
    );
    // Device px: the stroke is whole pixels wide, and starts on a whole pixel.
    const w = width * unit * 1.5;
    const start = (fit.y + top * unit) * 1.5 - w / 2;
    expect(Math.abs(w - Math.round(w))).toBeLessThan(1e-9);
    expect(Math.abs(start - Math.round(start))).toBeLessThan(1e-9);
  });

  /** The plate rim as the tile strokes it, design units: its centre line's left, top, right
   *  and bottom (from the rounded rect's path, clockwise from the top edge), and its width. */
  const rimOf = (ops: readonly string[]): { edges: number[]; width: number } => {
    const stroke = ops.indexOf(`strokeStyle=${rgba(resolvePalette('default').tower)}`);
    const path = ops.slice(ops.lastIndexOf('beginPath()', stroke), stroke);
    const nums = (o: string): number[] =>
      o
        .slice(o.indexOf('(') + 1, -1)
        .split(',')
        .map(Number);
    const top = nums(path.find((o) => o.startsWith('moveTo('))!)[1]!;
    const lines = path.filter((o) => o.startsWith('lineTo(')).map(nums);
    const width = Number(
      ops
        .slice(stroke)
        .find((o) => o.startsWith('lineWidth='))!
        .slice(10),
    );
    return { edges: [lines[3]![0]!, top, lines[1]![0]!, lines[2]![1]!], width };
  };

  // The tile's box is 36 CSS px: 45 device px at dpr 1.25 wherever it sits, but 39.6 at 1.1,
  // which the browser draws into 40 pixels or 39 by where it sits — at x 0, pixels 0 to 40;
  // at x 0.5 (0.55 device px), pixels 1 to 40.
  for (const [dpr, at, store] of [
    [1.25, { left: 0, top: 0 }, [45, 45]],
    [1.25, { left: 0.5, top: 10.3 }, [45, 45]],
    [1.1, { left: 0, top: 0 }, [40, 40]],
    [1.1, { left: 0.5, top: 0.5 }, [39, 39]],
    [1.1, { left: 0.5, top: 20 }, [39, 40]],
  ] as const) {
    it(`keeps the plate’s rim whole on a tile drawn into ${store.join('×')} pixels at dpr ${dpr}, at ${at.left}, ${at.top} — though the fitted footprint starts above and left of the canvas`, () => {
      const { ctx, ops } = recordingCtx();
      const canvas = fakeCanvas(ctx, { dpr, at });
      paintSwatch(canvas, 'basic', 'default', recordingPaths().makePath);
      // The store is the device pixels the tile is drawn into, so it is shown pixel for pixel.
      expect([canvas.width, canvas.height]).toEqual(store);
      const fit = towerArtFit(SWATCH_SIZE_PX);
      expect(fit.x).toBeLessThan(0);
      expect(fit.y).toBeLessThan(0);
      const unit = fit.footprintPx / 64;
      const {
        edges: [left, top, right, bottom],
        width,
      } = rimOf(ops);
      const w = width * unit * dpr; // device px
      expect(w).toBeCloseTo(2, 9); // its one-CSS-px floor, rounded up
      const px = (corner: number, v: number): number => (corner + v * unit) * dpr;
      // All of its width is in the store: from pixel 0 at the top and left ...
      expect(px(fit.x, left!) - w / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(px(fit.y, top!) - w / 2).toBeGreaterThanOrEqual(-1e-9);
      // ... to its last pixel at the right and bottom.
      expect(px(fit.x, right!) + w / 2).toBeLessThanOrEqual(store[0] + 1e-9);
      expect(px(fit.y, bottom!) + w / 2).toBeLessThanOrEqual(store[1] + 1e-9);
    });
  }

  it('below dpr 1 too, the store is the device pixels the tile is drawn into — not the tile’s CSS size', () => {
    // 36 CSS px at 0.9 is 32.4 device px: pixels 0 to 32 at x 0, and 0 to 33 at x 0.5.
    for (const [left, side] of [
      [0, 32],
      [0.5, 33],
    ] as const) {
      const { ctx, ops } = recordingCtx();
      const canvas = fakeCanvas(ctx, { dpr: 0.9, at: { left, top: left } });
      paintSwatch(canvas, 'basic', 'default', recordingPaths().makePath);
      expect([canvas.width, canvas.height], `x ${left}`).toEqual([side, side]);
      expect(ops[0]).toBe('setTransform(0.9,0,0,0.9,0,0)');
      // The ground covers the whole store, a little over or under the tile's 36 CSS px.
      expect(ops).toContain(`rect(0,0,${side / 0.9},${side / 0.9})`);
    }
  });

  /** A window whose `ResizeObserver` the swatch can watch the tile with: every observer it
   *  makes is kept, with what it observes and how. */
  const observingView = (
    devicePixels: boolean,
  ): {
    view: object;
    observers: { callback: ResizeObserverCallback; options: unknown }[];
    instances: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
  } => {
    const observers: { callback: ResizeObserverCallback; options: unknown }[] = [];
    const instances: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] =
      [];
    class FakeObserver {
      readonly observe = vi.fn((_target: unknown, options: unknown): void => {
        observers.push({ callback: this.callback, options });
      });
      readonly disconnect = vi.fn();
      constructor(private readonly callback: ResizeObserverCallback) {
        instances.push(this);
      }
    }
    class Entry {}
    if (devicePixels) {
      Object.defineProperty(Entry.prototype, 'devicePixelContentBoxSize', { get: () => [] });
    }
    return {
      view: { ResizeObserver: FakeObserver, ResizeObserverEntry: Entry },
      observers,
      instances,
    };
  };
  const entry = (device: [number, number] | null): ResizeObserverEntry =>
    ({
      ...(device === null
        ? {}
        : { devicePixelContentBoxSize: [{ inlineSize: device[0], blockSize: device[1] }] }),
      contentBoxSize: [{ inlineSize: SWATCH_SIZE_PX, blockSize: SWATCH_SIZE_PX }],
    }) as unknown as ResizeObserverEntry;

  it('repaints the tile into the device pixels the browser reports for it, when they change — a move too', () => {
    const { view, observers } = observingView(true);
    const { ctx, ops } = recordingCtx();
    const canvas = fakeCanvas(ctx, { dpr: 1.1, at: { left: 0, top: 0 }, view });
    paintSwatch(canvas, 'slow', 'default', recordingPaths().makePath);
    expect([canvas.width, canvas.height]).toEqual([40, 40]);
    // Watched once, on the device-pixel box — a second paint (a mode change) adds no observer.
    paintSwatch(canvas, 'slow', 'protan', recordingPaths().makePath);
    expect(observers).toHaveLength(1);
    expect(observers[0]!.options).toEqual({ box: 'device-pixel-content-box' });
    // Each paint sets the canvas's transform once (the art's own are `transform`s).
    const paints = (): number => ops.filter((o) => o.startsWith('setTransform(')).length;
    const painted = paints();
    // The browser counts what it has drawn: the same 40 × 40 — nothing to repaint ...
    observers[0]!.callback([entry([40, 40])], {} as ResizeObserver);
    expect(paints()).toBe(painted);
    // ... then, the tile moved without resizing, 39 × 40: repainted into that, in the mode
    // it was last painted in.
    observers[0]!.callback([entry([39, 40])], {} as ResizeObserver);
    expect([canvas.width, canvas.height]).toEqual([39, 40]);
    expect(paints()).toBe(painted + 1);
    expect(ops.slice(ops.lastIndexOf('setTransform(1.1,0,0,1.1,0,0)'))).toContain(
      `fillStyle=${rgba(resolvePalette('protan').roleControl)}`,
    );
  });

  it('where the browser reports no device pixels (WebKit), repaints on a new size, worked out from where the tile sits', () => {
    const { view, observers } = observingView(false);
    const { ctx } = recordingCtx();
    let at = { left: 0, top: 0, width: 0, height: 0 }; // not laid out yet
    const canvas = fakeCanvas(ctx, { dpr: 1.1, view });
    (canvas as unknown as { getBoundingClientRect: () => typeof at }).getBoundingClientRect = () =>
      at;
    paintSwatch(canvas, 'basic', 'default', recordingPaths().makePath);
    expect([canvas.width, canvas.height]).toEqual([40, 40]); // the tile's size × dpr, for now
    expect(observers[0]!.options).toEqual({}); // its CSS box
    at = { left: 0.5, top: 0.5, width: SWATCH_SIZE_PX, height: SWATCH_SIZE_PX }; // laid out
    observers[0]!.callback([entry(null)], {} as ResizeObserver);
    expect([canvas.width, canvas.height]).toEqual([39, 39]);
  });

  it("releaseSwatch disconnects the tile's observer, and a later paint observes it afresh", () => {
    const { view, instances } = observingView(true);
    const { ctx } = recordingCtx();
    const canvas = fakeCanvas(ctx, { dpr: 1.1, at: { left: 0, top: 0 }, view });
    paintSwatch(canvas, 'slow', 'default', recordingPaths().makePath);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.observe).toHaveBeenCalledWith(canvas, { box: 'device-pixel-content-box' });
    expect(instances[0]!.disconnect).not.toHaveBeenCalled();
    releaseSwatch(canvas);
    expect(instances[0]!.disconnect).toHaveBeenCalledOnce();
    // Released, so painted again it registers anew: a second observer, on the same canvas.
    paintSwatch(canvas, 'slow', 'default', recordingPaths().makePath);
    expect(instances).toHaveLength(2);
    expect(instances[1]!.observe).toHaveBeenCalledWith(canvas, { box: 'device-pixel-content-box' });
    expect(instances[1]!.disconnect).not.toHaveBeenCalled();
  });

  it('releaseSwatch is a no-op for a canvas never painted, or watched by no observer', () => {
    const { ctx } = recordingCtx();
    expect(() => releaseSwatch(fakeCanvas(ctx))).not.toThrow();
    const noObserver = fakeCanvas(ctx, { view: {} });
    paintSwatch(noObserver, 'basic', 'default', recordingPaths().makePath);
    expect(() => releaseSwatch(noObserver)).not.toThrow();
  });

  it("a mode change changes the paint — protan's role colours replace the default ones", () => {
    const { ctx, ops } = recordingCtx();
    paintSwatch(fakeCanvas(ctx), 'basic', 'protan', recordingPaths().makePath);
    const def = resolvePalette('default');
    const protan = resolvePalette('protan');
    expect(protan.roleDamage).not.toBe(def.roleDamage);
    expect(ops).not.toContain(`fillStyle=${rgba(def.roleDamage)}`);
    expect(ops).toContain(`fillStyle=${rgba(protan.roleDamage)}`);
  });
});
