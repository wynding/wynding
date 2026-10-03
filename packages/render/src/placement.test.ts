// placement.test.ts — which frame every sprite shows and where: hidden pending-sell towers,
// queued builds, the buffed variant, the creep frame choice (shape, low-health tint, boss
// size), and positions snapped to whole device pixels with the frame's anchor honoured.

import { describe, it, expect } from 'vitest';
import { placeCreeps, placeTowers, snapToDevicePx, type FrameAnchor } from './placement';
import { atlasFrameSpecs } from './art-frames';
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

  it('anchors each committed tower frame at its footprint corner', () => {
    const placed = placeTowers(vmWith([tower('slow', 2, 3)]), NO_OVERLAY, projection, frames);
    expect(placed.committed).toHaveLength(1);
    const p = placed.committed[0]!;
    expect(p.frame).toBe('tower:ringed:committed');
    const corner = projection.cellToPixel(2, 3);
    const anchor = frames.get(p.frame)!;
    expect(p.x + anchor.anchorX).toBe(corner.x);
    expect(p.y + anchor.anchorY).toBe(corner.y);
    expect(placed.pending).toEqual([]);
  });

  it('shows the buffed variant — the ✦ — only on a tower a support aura reaches', () => {
    const placed = placeTowers(
      vmWith([tower('basic', 2, 2, { buffed: true }), tower('basic', 5, 2)]),
      NO_OVERLAY,
      projection,
      frames,
    );
    expect(placed.committed.map((p) => p.frame)).toEqual([
      'tower:plain:buffed',
      'tower:plain:committed',
    ]);
  });

  it('hides a committed tower whose sell is pending, and only that one', () => {
    const placed = placeTowers(
      vmWith([tower('basic', 2, 2), tower('venom', 5, 2)]),
      { pendingAdds: [], pendingSells: [{ col: 2, row: 2 }] },
      projection,
      frames,
    );
    expect(placed.committed.map((p) => p.frame)).toEqual(['tower:droplet:committed']);
  });

  it('shows each queued build as the pending variant of ITS OWN mark (Codex R1-7)', () => {
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
    expect(placed.committed).toEqual([]);
    expect(placed.pending.map((p) => p.frame)).toEqual([
      'tower:ringed:pending',
      'tower:charge:pending',
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
    expect(placed.committed.map((p) => p.frame)).toEqual([
      'tower:bolt:committed',
      'tower:ringed:committed',
      'tower:arrow:committed',
    ]);
  });

  it('puts a frame on a whole device pixel at a fractional dpr', () => {
    // 1.5 × the 2×2-cell offset of an odd corner lands mid-pixel unsnapped.
    const p15 = projectionAt(1.5, 110, 110);
    const f15 = framesFor(p15);
    const placed = placeTowers(vmWith([tower('basic', 1, 1)]), NO_OVERLAY, p15, f15);
    const s = placed.committed[0]!;
    const deviceX = s.x * 1.5;
    const deviceY = s.y * 1.5;
    expect(Math.abs(deviceX - Math.round(deviceX))).toBeLessThan(1e-9);
    expect(Math.abs(deviceY - Math.round(deviceY))).toBeLessThan(1e-9);
    // ... within half a device pixel of where the footprint really is.
    const corner = p15.cellToPixel(1, 1);
    expect(Math.abs(s.x + f15.get(s.frame)!.anchorX - corner.x)).toBeLessThanOrEqual(
      0.5 / 1.5 + 1e-9,
    );
  });

  it('refuses to point a sprite at a frame the atlas does not have', () => {
    expect(() =>
      placeTowers(vmWith([tower('basic', 2, 2)]), NO_OVERLAY, projection, new Map()),
    ).toThrow(/no frame 'tower:plain:committed'/);
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
