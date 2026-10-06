// placement.test.ts — which frame every sprite shows and where: hidden pending-sell towers,
// queued builds, a tower's plate and head (the boosted head with its glow; no plate under
// the mine), the scorches a spent mine leaves, the creep frame choice (shape, low-health
// tint, boss size), and positions snapped to whole device pixels with the frame's anchor
// honoured.

import { describe, it, expect } from 'vitest';
import {
  HEAD_AT_REST,
  placeCreeps,
  placeScorches,
  placeTowers,
  type FrameAnchor,
} from './placement';
import { snapToDevicePx } from './device-px';
import {
  atlasFrameSpecs,
  PAD_FRAME_KEY,
  PLATE_FRAME_KEY,
  RIM_RUNS_FRAME_KEY,
  SCORCH_FRAME_KEY,
  type FrameSpec,
} from './art-frames';
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
  targetId: 0,
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

  it('stands every committed tower on a plate but the mine, which stands on its floor-coloured pad', () => {
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
    // One ground sprite per head, in the same order, each at its own footprint corner: the
    // mine's is the pad, so nothing — a neighbouring beacon's shell above all — shows
    // through a footprint its studded head leaves bare.
    expect(placed.plates.map((p) => p.frame)).toEqual([
      PAD_FRAME_KEY,
      PLATE_FRAME_KEY,
      PLATE_FRAME_KEY,
    ]);
    const at = (key: string, col: number, row: number): number[] => {
      const c = projection.cellToPixel(col, row);
      const a = frames.get(key)!;
      return [c.x - a.anchorX, c.y - a.anchorY];
    };
    expect(placed.plates.map((p) => [p.x, p.y])).toEqual([
      at(PAD_FRAME_KEY, 2, 2),
      at(PLATE_FRAME_KEY, 5, 2),
      at(PLATE_FRAME_KEY, 2, 5),
    ]);
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
        new Map([[PLATE_FRAME_KEY, { anchorX: 0, anchorY: 0, pivotX: 0, pivotY: 0 }]]),
      ),
    ).toThrow(/no frame 'tower:head:plain:damage:committed'/);
  });
});

describe('placeTowers — each head posed to aim and recoil (visual pass T3)', () => {
  // dpr 1, and 1.25 and 1.5, where a footprint corner can fall between device pixels.
  const LAYOUTS = [
    projectionAt(1),
    createProjection({ cols: 28, rows: 24, cssWidth: 1074, cssHeight: 802, dpr: 1.25 }),
    projectionAt(1.5, 110, 110),
  ];
  const specsFor = (p: Projection): ReadonlyMap<string, FrameSpec> =>
    new Map(atlasFrameSpecs(p.cellPx, p.dpr).map((f) => [f.key, f]));
  const TOWERS = [tower('basic', 1, 1), tower('venom', 3, 5), tower('slow', 6, 2)];

  it('places a head at rest exactly as an unposed head — the same numbers, to the bit', () => {
    for (const p of LAYOUTS) {
      const frames = specsFor(p);
      const unposed = placeTowers(vmWith(TOWERS), NO_OVERLAY, p, frames);
      for (const pose of [HEAD_AT_REST, { angle: 0, recoilPx: 0 }]) {
        const posed = placeTowers(vmWith(TOWERS), NO_OVERLAY, p, frames, () => pose);
        expect(posed).toEqual(unposed);
        // No origin and no turn: the pool leaves the sprite at its top-left, unturned.
        for (const h of posed.heads)
          expect([h.originX, h.originY, h.rotation]).toEqual([undefined, undefined, undefined]);
      }
    }
  });

  it('places a TURNED head by its footprint centre: its origin the frame’s pivot, on the snapped corner plus a cell', () => {
    for (const p of LAYOUTS) {
      const frames = specsFor(p);
      const t = tower('basic', 3, 5);
      const placed = placeTowers(vmWith([t]), NO_OVERLAY, p, frames, () => ({
        angle: 0.6,
        recoilPx: 0,
      }));
      const head = placed.heads[0]!;
      const spec = frames.get(head.frame)!;
      const corner = p.cellToPixel(3, 5);
      expect(head).toEqual({
        frame: 'tower:head:plain:damage:committed',
        x: snapToDevicePx(corner.x, p.dpr) + p.cellPx,
        y: snapToDevicePx(corner.y, p.dpr) + p.cellPx,
        originX: spec.pivotX,
        originY: spec.pivotY,
        rotation: 0.6,
      });
      // The frame's top-left, before the turn, is where the unturned head's would be: the
      // pivot is the very point that head's footprint centre was drawn at. (A sprite's origin
      // is its frame's size in CSS px — texels over the bake scale — times the fraction.)
      const rest = placeTowers(vmWith([t]), NO_OVERLAY, p, frames).heads[0]!;
      expect(head.x - head.originX! * (spec.width / p.dpr)).toBeCloseTo(rest.x, 9);
      expect(head.y - head.originY! * (spec.height / p.dpr)).toBeCloseTo(rest.y, 9);
      // ... and the plate under it does not move.
      expect(placed.plates).toEqual(placeTowers(vmWith([t]), NO_OVERLAY, p, frames).plates);
    }
  });

  it('turns each head by its own pose, the boosted one too', () => {
    const p = LAYOUTS[0]!;
    const frames = specsFor(p);
    const towers = [tower('basic', 2, 2, { buffed: true }), tower('antiair', 6, 2)];
    const placed = placeTowers(vmWith(towers), NO_OVERLAY, p, frames, (t) => ({
      angle: t.towerId === 'basic' ? 1 : -2,
      recoilPx: 0,
    }));
    expect(placed.heads.map((h) => [h.frame, h.rotation])).toEqual([
      ['tower:head:plain:damage:buffed', 1],
      ['tower:head:arrow:air:committed', -2],
    ]);
  });

  it('paints the plate rim again over each POSED head, on its plate’s corner — over none at rest, and none that never aims', () => {
    for (const p of LAYOUTS) {
      const frames = specsFor(p);
      const runs = frames.get(RIM_RUNS_FRAME_KEY)!;
      const at = (t: TowerVM) => {
        const corner = p.cellToPixel(t.col, t.row);
        return {
          frame: RIM_RUNS_FRAME_KEY,
          x: snapToDevicePx(corner.x, p.dpr) - runs.anchorX,
          y: snapToDevicePx(corner.y, p.dpr) - runs.anchorY,
        };
      };
      const [basic, venom, slow] = TOWERS as [TowerVM, TowerVM, TowerVM];
      expect(placeTowers(vmWith(TOWERS), NO_OVERLAY, p, frames).rims).toEqual([]);
      // Turned, or knocked back unturned: posed. A head that does not aim is never posed
      // (`headPose`), so the slow tower stands at rest here.
      for (const pose of [
        { angle: 0.6, recoilPx: 0 },
        { angle: 0, recoilPx: 1.5 },
      ]) {
        const placed = placeTowers(vmWith(TOWERS), NO_OVERLAY, p, frames, (t) =>
          t === slow ? HEAD_AT_REST : pose,
        );
        expect(placed.rims).toEqual([at(basic), at(venom)]);
      }
      // A tower whose sell is pending is presented as gone: no rim over its head either. (Each
      // head here is handed a turn, the slow tower's too.)
      const selling = placeTowers(
        vmWith(TOWERS),
        { pendingAdds: [], pendingSells: [{ col: basic.col, row: basic.row }] },
        p,
        frames,
        () => ({ angle: 0.6, recoilPx: 0 }),
      );
      expect(selling.rims).toEqual([at(venom), at(slow)]);
    }
  });

  it('knocks a head back along its facing by whole device pixels: down facing up, left facing right', () => {
    for (const p of LAYOUTS) {
      const frames = specsFor(p);
      const t = tower('stun', 3, 5);
      const rest = placeTowers(vmWith([t]), NO_OVERLAY, p, frames).heads[0]!;
      // Facing up (unturned), a 2.3px knock moves it straight down, to a whole device pixel.
      const up = placeTowers(vmWith([t]), NO_OVERLAY, p, frames, () => ({
        angle: 0,
        recoilPx: 2.3,
      })).heads[0]!;
      expect(up.x).toBe(rest.x);
      expect(up.y).toBeCloseTo(rest.y + snapToDevicePx(2.3, p.dpr), 9);
      expect(Math.abs(up.y * p.dpr - Math.round(up.y * p.dpr))).toBeLessThan(1e-9);
      expect(up.rotation).toBeUndefined(); // still at its top-left: crisp as it recoils
      // Facing right, it moves left of where the turned head stands.
      const turned = (recoilPx: number) =>
        placeTowers(vmWith([t]), NO_OVERLAY, p, frames, () => ({ angle: Math.PI / 2, recoilPx }))
          .heads[0]!;
      const knocked = turned(2.3);
      expect(knocked.x).toBeCloseTo(turned(0).x - snapToDevicePx(2.3, p.dpr), 9);
      expect(knocked.y).toBeCloseTo(turned(0).y, 9);
    }
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
      // The sprite's own corner is on a whole device pixel too, on BOTH axes (the anchor is
      // whole texels)…
      expect(Math.abs(p!.x * dpr - Math.round(p!.x * dpr))).toBeLessThan(1e-9);
      expect(Math.abs(p!.y * dpr - Math.round(p!.y * dpr))).toBeLessThan(1e-9);
      // … and its corner plus its frame's anchor IS the centre the cues are drawn around, so
      // a creep's body and its pip and rings cannot come apart by the snap.
      const anchor = fr.get(p!.frame)!;
      expect(p!.x + anchor.anchorX).toBeCloseTo(p!.cx, 9);
      expect(p!.y + anchor.anchorY).toBeCloseTo(p!.cy, 9);
    }
  });
});
