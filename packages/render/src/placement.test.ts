// placement.test.ts — which frame every sprite shows and where: hidden pending-sell towers,
// queued builds, a tower's plate and head (the boosted head with its glow; no plate under
// the mine), the scorches a spent mine leaves, the creep frame choice (shape, low-health
// tint, boss size), and positions snapped to whole device pixels with the frame's anchor
// honoured.

import { describe, it, expect } from 'vitest';
import {
  placeCreeps,
  placeScorches,
  placeTowers,
  snapToDevicePx,
  type FrameAnchor,
} from './placement';
import { atlasFrameSpecs, PLATE_FRAME_KEY, SCORCH_FRAME_KEY } from './art-frames';
import { creepRadius } from './board-draw';
import { createProjection, type Projection } from './projection';
import { resolvePalette } from './palette';
import type { CreepVM, RenderOverlay, RenderVM, TowerVM } from './types';

const PAL = resolvePalette('default');

const projectionAt = (dpr: number, cssWidth = 100, cssHeight = 100): Projection =>
  createProjection({ cols: 10, rows: 10, cssWidth, cssHeight, dpr });

const framesFor = (projection: Projection): ReadonlyMap<string, FrameAnchor> =>
  new Map(atlasFrameSpecs(projection.cellPx, projection.dpr).map((f) => [f.key, f]));

const NO_OVERLAY: Pick<RenderOverlay, 'pendingAdds' | 'pendingSells'> = {
  pendingAdds: [],
  pendingSells: [],
};

const vmWith = (towers: readonly TowerVM[]): RenderVM => ({
  tick: 0,
  phase: 'running',
  creeps: [],
  towers,
});

const tower = (
  towerId: string,
  col: number,
  row: number,
  opts: Partial<TowerVM> = {},
): TowerVM => ({
  id: col * 100 + row,
  col,
  row,
  towerId,
  support: false,
  buffed: false,
  ...opts,
});

type CreepIn = Parameters<typeof placeCreeps>[0][number];
const creep = (opts: Partial<CreepVM> = {}): CreepIn => ({
  x: 5 * 256,
  y: 5 * 256,
  hpFrac: 1,
  creepId: 'normal',
  domain: 'ground',
  slowed: false,
  poisoned: false,
  stunned: false,
  warded: false,
  boss: false,
  ...opts,
});

describe('snapToDevicePx', () => {
  it('moves a CSS-px coordinate to the nearest whole device pixel', () => {
    expect(snapToDevicePx(10.3, 1)).toBe(10);
    expect(snapToDevicePx(10.3, 2)).toBe(10.5); // device 20.6 → 21
    expect(snapToDevicePx(10, 1.5)).toBe(10); // device 15 — already whole
    expect(snapToDevicePx(11, 1.5)).toBeCloseTo(11.333333, 5); // device 16.5 → 17
    expect(snapToDevicePx(7, 2)).toBe(7);
  });
});

describe('placeTowers', () => {
  const projection = projectionAt(1);
  const frames = framesFor(projection);

  it('anchors a committed tower’s plate and head at its footprint corner — the same pixels', () => {
    const placed = placeTowers(vmWith([tower('slow', 2, 3)]), NO_OVERLAY, projection, frames);
    expect(placed.plates.map((p) => p.frame)).toEqual([PLATE_FRAME_KEY]);
    expect(placed.heads.map((p) => p.frame)).toEqual(['tower:head:ringed:control:committed']);
    const corner = projection.cellToPixel(2, 3);
    for (const p of [placed.plates[0]!, placed.heads[0]!]) {
      const anchor = frames.get(p.frame)!;
      expect(p.x + anchor.anchorX).toBe(corner.x);
      expect(p.y + anchor.anchorY).toBe(corner.y);
      expect(p.alpha ?? 1).toBe(1);
    }
    expect(placed.pending).toEqual([]);
  });

  it('shows the boosted head — the glow — only on a tower a beacon boosts; the plate is the same', () => {
    const placed = placeTowers(
      vmWith([tower('basic', 2, 2, { buffed: true }), tower('basic', 5, 2)]),
      NO_OVERLAY,
      projection,
      frames,
    );
    expect(placed.heads.map((p) => p.frame)).toEqual([
      'tower:head:plain:damage:buffed',
      'tower:head:plain:damage:committed',
    ]);
    expect(placed.plates.map((p) => p.frame)).toEqual([PLATE_FRAME_KEY, PLATE_FRAME_KEY]);
  });

  it('stands every committed tower on a plate but the mine', () => {
    const placed = placeTowers(
      vmWith([tower('mine', 2, 2), tower('beacon', 5, 2), tower('no-such-tower', 2, 5)]),
      NO_OVERLAY,
      projection,
      frames,
    );
    expect(placed.heads.map((p) => p.frame)).toEqual([
      'tower:head:charge:burst:committed',
      'tower:head:pylon:support:committed',
      'tower:head:plain:damage:committed', // an unknown id looks like basic
    ]);
    const plateCorners = placed.plates.map((p) => [p.x, p.y]);
    const at = (col: number, row: number): number[] => {
      const c = projection.cellToPixel(col, row);
      const a = frames.get(PLATE_FRAME_KEY)!;
      return [c.x - a.anchorX, c.y - a.anchorY];
    };
    expect(plateCorners).toEqual([at(5, 2), at(2, 5)]);
  });

  it('hides a committed tower whose sell is pending — plate and head alike — and only that one', () => {
    const placed = placeTowers(
      vmWith([tower('basic', 2, 2), tower('venom', 5, 2)]),
      { pendingAdds: [], pendingSells: [{ col: 2, row: 2 }] },
      projection,
      frames,
    );
    expect(placed.heads.map((p) => p.frame)).toEqual(['tower:head:droplet:poison:committed']);
    expect(placed.plates).toHaveLength(1);
    const corner = projection.cellToPixel(5, 2);
    expect(placed.plates[0]!.x + frames.get(PLATE_FRAME_KEY)!.anchorX).toBe(corner.x);
  });

  it('shows each queued build as the pending picture of ITS OWN look (Codex R1-7)', () => {
    const placed = placeTowers(
      vmWith([]),
      {
        pendingSells: [],
        pendingAdds: [
          { col: 2, row: 2, towerId: 'slow' },
          { col: 6, row: 6, towerId: 'mine' },
        ],
      },
      projection,
      frames,
    );
    expect(placed.plates).toEqual([]);
    expect(placed.heads).toEqual([]);
    expect(placed.pending.map((p) => p.frame)).toEqual([
      'tower:pending:ringed:control',
      'tower:pending:charge:burst',
    ]);
    const corner = projection.cellToPixel(6, 6);
    const p = placed.pending[1]!;
    expect(p.x + frames.get(p.frame)!.anchorX).toBe(corner.x);
    expect(p.y + frames.get(p.frame)!.anchorY).toBe(corner.y);
  });

  it('keeps committed towers in view-model order', () => {
    const placed = placeTowers(
      vmWith([tower('stun', 6, 6), tower('slow', 2, 2), tower('antiair', 4, 6)]),
      NO_OVERLAY,
      projection,
      frames,
    );
    expect(placed.heads.map((p) => p.frame)).toEqual([
      'tower:head:bolt:control:committed',
      'tower:head:ringed:control:committed',
      'tower:head:arrow:air:committed',
    ]);
    expect(placed.plates.map((p) => p.x)).toEqual(placed.heads.map((p) => p.x));
  });

  it('puts plate and head on a whole device pixel at a fractional dpr', () => {
    // 1.5 × the 2×2-cell offset of an odd corner lands mid-pixel unsnapped.
    const p15 = projectionAt(1.5, 110, 110);
    const f15 = framesFor(p15);
    const placed = placeTowers(vmWith([tower('basic', 1, 1)]), NO_OVERLAY, p15, f15);
    for (const s of [placed.plates[0]!, placed.heads[0]!]) {
      const deviceX = s.x * 1.5;
      const deviceY = s.y * 1.5;
      expect(Math.abs(deviceX - Math.round(deviceX))).toBeLessThan(1e-9);
      expect(Math.abs(deviceY - Math.round(deviceY))).toBeLessThan(1e-9);
      // ... within half a device pixel of where the footprint really is.
      const corner = p15.cellToPixel(1, 1);
      expect(Math.abs(s.x + f15.get(s.frame)!.anchorX - corner.x)).toBeLessThanOrEqual(
        0.5 / 1.5 + 1e-9,
      );
    }
  });

  it('refuses to point a sprite at a frame the atlas does not have', () => {
    expect(() =>
      placeTowers(vmWith([tower('basic', 2, 2)]), NO_OVERLAY, projection, new Map()),
    ).toThrow(/no frame 'tower:plate'/);
    expect(() =>
      placeTowers(
        vmWith([tower('basic', 2, 2)]),
        NO_OVERLAY,
        projection,
        new Map([[PLATE_FRAME_KEY, { anchorX: 0, anchorY: 0 }]]),
      ),
    ).toThrow(/no frame 'tower:head:plain:damage:committed'/);
  });
});

describe('placeScorches', () => {
  it('centres each scorch on its point, carrying its fade', () => {
    const projection = projectionAt(1);
    const frames = framesFor(projection);
    const placed = placeScorches(
      [
        { x: 5 * 256, y: 4 * 256, alpha: 1 },
        { x: 2 * 256, y: 7 * 256, alpha: 0.25 },
      ],
      projection,
      frames,
    );
    expect(placed.map((p) => [p.frame, p.alpha])).toEqual([
      [SCORCH_FRAME_KEY, 1],
      [SCORCH_FRAME_KEY, 0.25],
    ]);
    const anchor = frames.get(SCORCH_FRAME_KEY)!;
    const centre = projection.fpToPixel(2 * 256, 7 * 256);
    expect(placed[1]!.x + anchor.anchorX).toBe(centre.x);
    expect(placed[1]!.y + anchor.anchorY).toBe(centre.y);
  });

  it('puts a scorch on a whole device pixel at a fractional dpr, within half a pixel', () => {
    const p15 = projectionAt(1.5, 110, 110);
    const f15 = framesFor(p15);
    const [s] = placeScorches([{ x: 3 * 256, y: 3 * 256, alpha: 0.5 }], p15, f15);
    expect(Math.abs(s!.x * 1.5 - Math.round(s!.x * 1.5))).toBeLessThan(1e-9);
    const centre = p15.fpToPixel(3 * 256, 3 * 256);
    expect(Math.abs(s!.x + f15.get(SCORCH_FRAME_KEY)!.anchorX - centre.x)).toBeLessThanOrEqual(
      0.5 / 1.5 + 1e-9,
    );
  });

  it('places nothing when no scorch is showing', () => {
    const projection = projectionAt(1);
    expect(placeScorches([], projection, framesFor(projection))).toEqual([]);
  });
});

describe('placeCreeps', () => {
  const projection = projectionAt(1);
  const frames = framesFor(projection);

  it('centres the silhouette sprite on the projected point, and the cues on the same centre', () => {
    const [p] = placeCreeps([creep()], PAL, projection, frames);
    const centre = projection.fpToPixel(5 * 256, 5 * 256);
    expect(p!.cx).toBe(centre.x);
    expect(p!.cy).toBe(centre.y);
    const anchor = frames.get(p!.frame)!;
    expect(p!.x + anchor.anchorX).toBe(p!.cx);
    expect(p!.y + anchor.anchorY).toBe(p!.cy);
  });

  it('chooses the frame from the shape, the low-health tint and the boss size', () => {
    const placed = placeCreeps(
      [
        creep({ creepId: 'fast' }),
        creep({ creepId: 'swarm', hpFrac: 0.2 }),
        creep({ creepId: 'boss', boss: true }),
        creep({ creepId: 'resolute', hpFrac: 0.34 }),
        creep({ creepId: 'mystery' }),
      ],
      PAL,
      projection,
      frames,
    );
    expect(placed.map((p) => p.frame)).toEqual([
      'creep:diamond:normal:standard',
      'creep:square:low:standard',
      'creep:hexagon:normal:boss',
      'creep:pentagon:normal:standard',
      'creep:triangle:normal:standard',
    ]);
  });

  it('tints the pip the way the frame is tinted — the low-health threshold is one test', () => {
    const [low, edge] = placeCreeps(
      [creep({ hpFrac: 0.33 }), creep({ hpFrac: 0.34 })],
      PAL,
      projection,
      frames,
    );
    expect(low!.frame).toContain(':low:');
    expect(low!.colour).toBe(PAL.creepLowHp);
    expect(edge!.frame).toContain(':normal:');
    expect(edge!.colour).toBe(PAL.creep);
  });

  it('sizes the boss 1.5× AFTER the 3px floor, so it stays larger even at the narrowest cells', () => {
    const tiny = createProjection({ cols: 10, rows: 10, cssWidth: 50, cssHeight: 50, dpr: 1 }); // 5px cells
    const tinyFrames = framesFor(tiny);
    const [standard, boss] = placeCreeps(
      [creep(), creep({ creepId: 'boss', boss: true })],
      PAL,
      tiny,
      tinyFrames,
    );
    expect(standard!.r).toBe(3); // the floor binds
    expect(boss!.r).toBe(4.5); // ... and the boss still reads larger
    expect(boss!.r).toBe(creepRadius(5, true));
  });

  it('carries every cue state through, and maps the air domain to the airborne cue', () => {
    const [c] = placeCreeps(
      [
        creep({
          hpFrac: 0.5,
          slowed: true,
          poisoned: true,
          stunned: true,
          warded: true,
          domain: 'air',
        }),
      ],
      PAL,
      projection,
      frames,
    );
    expect(c).toMatchObject({
      hpFrac: 0.5,
      slowed: true,
      poisoned: true,
      stunned: true,
      warded: true,
      airborne: true,
    });
    expect(placeCreeps([creep()], PAL, projection, frames)[0]!.airborne).toBe(false);
  });

  it('keeps creeps in their given order, so a later creep still draws over an earlier one', () => {
    const placed = placeCreeps(
      [
        creep({ creepId: 'swarm', x: 300 }),
        creep({ creepId: 'fast', x: 310 }),
        creep({ creepId: 'normal', x: 290 }),
      ],
      PAL,
      projection,
      frames,
    );
    expect(placed.map((p) => p.frame.split(':')[1])).toEqual(['square', 'diamond', 'triangle']);
  });

  it('snaps a creep between pixels to a whole device pixel, by half a pixel at most', () => {
    for (const dpr of [1, 2, 1.5, 1.25]) {
      const proj = projectionAt(dpr, 100, 100);
      const fr = framesFor(proj);
      const c = creep({ x: 5 * 256 + 37, y: 3 * 256 + 101 });
      const [p] = placeCreeps([c], PAL, proj, fr);
      const truth = proj.fpToPixel(c.x, c.y);
      for (const [snapped, real] of [
        [p!.cx, truth.x],
        [p!.cy, truth.y],
      ] as const) {
        expect(Math.abs(snapped * dpr - Math.round(snapped * dpr))).toBeLessThan(1e-9);
        expect(Math.abs(snapped - real)).toBeLessThanOrEqual(0.5 / dpr + 1e-9);
      }
      // The sprite's own corner is on a whole device pixel too (the anchor is whole texels).
      expect(Math.abs(p!.x * dpr - Math.round(p!.x * dpr))).toBeLessThan(1e-9);
    }
  });
});
