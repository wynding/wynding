// swatch.test.ts — the Card tower tile (playtest round; redrawn by the visual pass, #181):
// its null-context inertness (jsdom has no real 2D context, which is why that is a contract
// worth pinning, not an accident) and the paint sequence itself, against a recording
// context — ground, then the tower's plate, then its head in its role colour, drawn by the
// board's own art and painter (`paintTowerArt`, #89) at one scale for every tower.
//
// The 2D adapter the tile draws through is the render package's (`artGraphics` over
// `canvasGraphics`), unit tested there (`canvas-graphics.test.ts`, `art-paint.test.ts`); the
// tile no longer carries a copy of its own.

import { describe, it, expect } from 'vitest';
import { resolvePalette, towerArtFit, type PathFactory } from '@wynding/render';
import { paintSwatch, SWATCH_SIZE_PX } from './swatch';

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

const fakeCanvas = (ctx: CanvasRenderingContext2D): HTMLCanvasElement =>
  ({
    getContext: () => ctx,
    width: 0,
    height: 0,
    ownerDocument: document, // dpr source (`canvas.ownerDocument.defaultView`) — jsdom reports 1
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
