// shots.test.ts — every shot in flight drawn as its tower's own tracer (visual pass C2,
// #181): which sprite or live stroke each tower's shot is, where it goes (the shot's point from
// `positionTracers`, unsnapped), how it is turned and coloured, a lob's arc, shadow and landing
// ring, the stun arc's fixed zigzag, the dot an unknown tower's shot keeps, a mine's detonation
// left out, and nothing at all under Reduce motion.

import { describe, it, expect } from 'vitest';
import { atlasFrameSpecs, LOB_SHADOW_FRAME_KEY, shotFrameKeys } from './art-frames';
import {
  effectArtColour,
  fxUnit,
  LOB_MAX_RISE_CELLS,
  LOB_RISE,
  LOB_TRAIL,
  SHOT_DOT,
  STUN_ARC,
} from './effect-art';
import { COLOUR_MODES, resolvePalette, roleColour } from './palette';
import { createProjection } from './projection';
import { lobRise, planShots, stunArcPoints } from './shots';
import type { PositionedTracer } from './tracers';
import type { TracerVM } from './types';

// A 1072×804 board at dpr 1: 33px cells, the board's corner at (74, 6).
const PROJECTION = createProjection({ cols: 28, rows: 24, cssWidth: 1072, cssHeight: 804, dpr: 1 });
const FRAMES = new Map(atlasFrameSpecs(PROJECTION.cellPx, 1).map((f) => [f.key, f]));
const PAL = resolvePalette('default');
const UNIT = fxUnit(PROJECTION.cellPx);

/** A shot from `from` toward `to` (fixed-point), `frac` of the way there — exactly at `to` once
 *  it has arrived, as `positionTracers` places it. */
function positioned(
  from: { x: number; y: number },
  to: { x: number; y: number },
  frac: number,
  tracer: Partial<TracerVM> = {},
): PositionedTracer {
  return {
    x: frac === 1 ? to.x : from.x + (to.x - from.x) * frac,
    y: frac === 1 ? to.y : from.y + (to.y - from.y) * frac,
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    frac,
    tracer: {
      kind: 'targeted',
      originX: from.x,
      originY: from.y,
      targetId: 7,
      launchTick: 10,
      impactTick: 14,
      ...tracer,
    } as TracerVM,
  };
}

const FROM = { x: 5 * 256, y: 3 * 256 };
const RIGHT = { x: 9 * 256, y: 3 * 256 }; // four cells right
const plan = (
  shots: readonly PositionedTracer[],
  towerId: string | undefined,
  reducedMotion = false,
) => planShots(shots, () => towerId, reducedMotion, PAL, PROJECTION, FRAMES);

describe('planShots — each tower’s own shot', () => {
  it('flies a turned tracer for a bolt, a glob, a shard and a streak: at the shot’s point, pivoting on its head, along its heading', () => {
    const shot = positioned(FROM, { x: 9 * 256, y: 7 * 256 }, 0.25); // down and right, 45°
    for (const id of ['basic', 'venom', 'slow', 'antiair']) {
      const p = plan([shot], id);
      expect(p.strokes, id).toEqual([]);
      expect(p.dots, id).toEqual([]);
      const at = PROJECTION.fpToPixel(shot.x, shot.y);
      const frame = FRAMES.get(shotFrameKeys(id).tracer!)!;
      expect(p.sprites, id).toEqual([
        {
          frame: shotFrameKeys(id).tracer,
          x: at.x,
          y: at.y,
          originX: frame.pivotX,
          originY: frame.pivotY,
          rotation: Math.PI / 4,
        },
      ]);
    }
  });

  it('places a shot exactly — unsnapped — so one that has arrived is centred on the point it struck', () => {
    const to = { x: 9 * 256 + 37.3, y: 3 * 256 + 101.9 }; // between device pixels
    const [bolt] = plan([positioned(FROM, to, 1)], 'basic').sprites;
    const at = PROJECTION.fpToPixel(to.x, to.y);
    expect([bolt!.x, bolt!.y]).toEqual([at.x, at.y]);
  });

  it('lobs a ball up its arc over the shot’s ground point, its shadow on that point, a ring where it lands and a dashed path — ground first', () => {
    const shot = positioned(FROM, RIGHT, 0.5, {
      kind: 'blast',
      destX: RIGHT.x,
      destY: RIGHT.y,
    } as Partial<TracerVM>);
    for (const [id, role] of [
      ['splash', 'damage'],
      ['frost-splash', 'control'],
    ] as const) {
      const p = plan([shot], id);
      const ground = PROJECTION.fpToPixel(shot.x, shot.y);
      const lands = PROJECTION.fpToPixel(RIGHT.x, RIGHT.y);
      const from = PROJECTION.fpToPixel(FROM.x, FROM.y);
      const length = lands.x - from.x;
      const keys = shotFrameKeys(id);
      const centred = (key: string, x: number, y: number) => ({
        frame: key,
        x: x - FRAMES.get(key)!.anchorX,
        y: y - FRAMES.get(key)!.anchorY,
      });
      expect(p.sprites, id).toEqual([
        centred(keys.landing!, lands.x, lands.y),
        centred(LOB_SHADOW_FRAME_KEY, ground.x, ground.y),
        centred(keys.tracer!, ground.x, ground.y - lobRise(0.5, length, PROJECTION.cellPx)),
      ]);
      // The path: from the tower to where it lands, over the same arc, every other segment drawn.
      const [path] = p.strokes;
      expect(p.strokes, id).toHaveLength(1);
      expect(path!.dashed).toBe(true);
      expect(path!.points).toHaveLength(LOB_TRAIL.dashes * 2 + 1);
      expect(path!.points[0]).toEqual({ x: from.x, y: from.y });
      expect(path!.points.at(-1)!.x).toBeCloseTo(lands.x, 9);
      expect(path!.points.at(-1)!.y).toBeCloseTo(lands.y, 9);
      const mid = path!.points[LOB_TRAIL.dashes]!;
      expect(mid.y).toBeCloseTo(from.y - lobRise(0.5, length, PROJECTION.cellPx), 9);
      expect(path!.colour).toBe(roleColour(PAL, role));
      expect(path!.width).toBe(LOB_TRAIL.width * UNIT);
      expect(path!.alpha).toBe(LOB_TRAIL.alpha);
    }
  });

  it('zigzags a stun arc from the tower to the shot — a faint glow, then its bright core, the same points — fixed by its ends, so it never flickers', () => {
    const shot = positioned(FROM, RIGHT, 0.75);
    const p = plan([shot], 'stun');
    expect(p.sprites).toEqual([]);
    expect(p.dots).toEqual([]);
    const from = PROJECTION.fpToPixel(FROM.x, FROM.y);
    const at = PROJECTION.fpToPixel(shot.x, shot.y);
    const points = stunArcPoints(from, at, UNIT)!;
    expect(p.strokes).toEqual([
      {
        points,
        dashed: false,
        width: STUN_ARC.glowWidth * UNIT,
        colour: roleColour(PAL, 'control'),
        alpha: STUN_ARC.glowAlpha,
      },
      {
        points,
        dashed: false,
        width: STUN_ARC.coreWidth * UNIT,
        colour: effectArtColour('core', PAL, 'control'),
        alpha: 1,
      },
    ]);
    expect(plan([shot], 'stun')).toEqual(p); // the same arc, frame after frame
    // An arc with no length yet — on its launch tick, at its tower — draws nothing.
    expect(plan([positioned(FROM, RIGHT, 0)], 'stun').strokes).toEqual([]);
  });

  it('keeps the dot every shot was before C2 for a tower it does not know — and for a shot whose tower is not known', () => {
    const shot = positioned(FROM, RIGHT, 0.5);
    const at = PROJECTION.fpToPixel(shot.x, shot.y);
    for (const id of ['no-such-tower', '__proto__', undefined]) {
      const p = plan([shot], id);
      expect(p.sprites).toEqual([]);
      expect(p.strokes).toEqual([]);
      expect(p.dots).toEqual([
        {
          x: at.x,
          y: at.y,
          r: Math.max(SHOT_DOT.minPx, PROJECTION.cellPx * SHOT_DOT.cells),
          colour: PAL.tracer,
        },
      ]);
    }
  });

  it('shows no shot for a mine going off — its scorch and its blast’s ring show it', () => {
    const detonation = positioned(FROM, FROM, 1, {
      kind: 'blast',
      destX: FROM.x,
      destY: FROM.y,
      launchTick: 12,
      impactTick: 12,
    } as Partial<TracerVM>);
    for (const id of ['mine', undefined]) {
      expect(plan([detonation], id)).toEqual({ sprites: [], strokes: [], dots: [] });
    }
  });

  it('draws every shot in its tower’s role colour in each colour-vision mode, its core mixed toward white', () => {
    expect(COLOUR_MODES.length).toBeGreaterThan(1);
    const shot = positioned(FROM, RIGHT, 0.5);
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      const [glow, core] = planShots([shot], () => 'stun', false, pal, PROJECTION, FRAMES).strokes;
      expect(glow!.colour, mode).toBe(roleColour(pal, 'control'));
      expect(core!.colour, mode).toBe(effectArtColour('core', pal, 'control'));
      expect(core!.colour, mode).not.toBe(glow!.colour);
    }
  });

  it('puts every lob’s ring and shadow under every tracer, whatever order the shots come in', () => {
    const lob = positioned(FROM, RIGHT, 0.5, {
      kind: 'blast',
      destX: RIGHT.x,
      destY: RIGHT.y,
    } as Partial<TracerVM>);
    const bolt = positioned(FROM, RIGHT, 0.5);
    const p = planShots(
      [bolt, lob],
      (t) => (t.kind === 'blast' ? 'splash' : 'basic'),
      false,
      PAL,
      PROJECTION,
      FRAMES,
    );
    expect(p.sprites.map((s) => s.frame)).toEqual([
      shotFrameKeys('splash').landing,
      LOB_SHADOW_FRAME_KEY,
      shotFrameKeys('basic').tracer,
      shotFrameKeys('splash').tracer,
    ]);
  });

  it('under Reduce motion plans nothing — the shot is decoration, and the spark and the HP bar carry what it did', () => {
    const shots = [positioned(FROM, RIGHT, 0.5)];
    for (const id of ['basic', 'splash', 'stun', 'no-such-tower']) {
      expect(plan(shots, id, true)).toEqual({ sprites: [], strokes: [], dots: [] });
    }
  });

  it('throws on a frame the atlas does not have, rather than drawing nothing silently', () => {
    expect(() =>
      planShots([positioned(FROM, RIGHT, 0.5)], () => 'basic', false, PAL, PROJECTION, new Map()),
    ).toThrow(/no frame/);
    // A lob's ring, shadow and ball too.
    const lob = positioned(FROM, RIGHT, 0.5, {
      kind: 'blast',
      destX: RIGHT.x,
      destY: RIGHT.y,
    } as Partial<TracerVM>);
    expect(() => planShots([lob], () => 'splash', false, PAL, PROJECTION, new Map())).toThrow(
      /no frame/,
    );
  });
});

describe('lobRise — a lob’s arc', () => {
  it('is nothing at either end and highest at the middle', () => {
    expect(lobRise(0, 100, 33)).toBe(0);
    expect(lobRise(1, 100, 33)).toBe(0);
    expect(lobRise(0.5, 100, 33)).toBeCloseTo(LOB_RISE * 100, 9);
    expect(lobRise(0.25, 100, 33)).toBeCloseTo(0.75 * LOB_RISE * 100, 9);
  });

  it('climbs no higher than its cap over a long lob', () => {
    expect(lobRise(0.5, 10_000, 33)).toBeCloseTo(LOB_MAX_RISE_CELLS * 33, 9);
  });
});

describe('stunArcPoints — the stun arc’s zigzag', () => {
  it('runs from its tower to its shot in equal steps, every corner off the line by the same distance, to alternating sides — the first to the left', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 60, y: 0 }; // heading right: left is up (y grows downward)
    const pts = stunArcPoints(from, to, 2)!;
    expect(pts).toHaveLength(STUN_ARC.segments + 1);
    expect(pts[0]).toEqual(from);
    expect(pts.at(-1)).toEqual(to);
    for (let i = 1; i < STUN_ARC.segments; i++) {
      expect(pts[i]!.x).toBeCloseTo((60 * i) / STUN_ARC.segments, 9);
      expect(pts[i]!.y).toBeCloseTo((i % 2 === 1 ? -1 : 1) * STUN_ARC.offset * 2, 9);
    }
  });

  it('has no arc for no length', () => {
    expect(stunArcPoints({ x: 3, y: 4 }, { x: 3, y: 4 }, 1)).toBeNull();
    expect(stunArcPoints({ x: 3, y: 4 }, { x: NaN, y: 4 }, 1)).toBeNull();
  });
});
