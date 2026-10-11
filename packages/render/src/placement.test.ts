// placement.test.ts — which frame every sprite shows and where: hidden pending-sell towers,
// queued builds, a tower's plate and head (the boosted head with its glow; no plate under
// the mine), the scorches a spent mine leaves, a creep's body and shadow (its look, its
// family's size, a flyer's lift and its cues on its lifted body, flyers over the ground), a
// hit creep's flash on its body, where each creep is drawn — the point the heads aim at and
// the shots land on (C1/C2) — and positions snapped to whole device pixels with the frame's
// anchor honoured.

import { describe, it, expect } from 'vitest';
import {
  HEAD_AT_REST,
  creepAimPoints,
  type KeptAimPoint,
  creepBodyCentre,
  placeCreeps,
  placeScorches,
  placeTowers,
  type FrameAnchor,
} from './placement';
import { snapToDevicePx } from './device-px';
import {
  atlasFrameSpecs,
  creepFrameKeys,
  PAD_FRAME_KEY,
  PLATE_FRAME_KEY,
  RIM_RUNS_FRAME_KEY,
  SCORCH_FRAME_KEY,
  type FrameSpec,
} from './art-frames';
import { creepLiftPx, creepRadius } from './creep-art';
import { createProjection, type Projection } from './projection';
import { creepColour, resolvePalette } from './palette';
import { recordingArtGraphics } from './test-support/recording-graphics';
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
  id: 1,
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
  const place = (cs: readonly CreepIn[], p = projection, f = frames) => placeCreeps(cs, PAL, p, f);

  it('anchors a creep’s body and shadow at its projected point, and centres a ground creep’s cues on its body there (PR #78)', () => {
    const { shadows, bodies } = place([creep()]);
    const [body] = bodies;
    const [shadow] = shadows;
    const centre = projection.fpToPixel(5 * 256, 5 * 256);
    expect(body!.cx).toBe(centre.x);
    expect(body!.cy).toBe(centre.y);
    const anchor = frames.get(body!.frame)!;
    expect(body!.x + anchor.anchorX).toBe(body!.cx);
    expect(body!.y + anchor.anchorY).toBe(body!.cy);
    const shadowAnchor = frames.get(shadow!.frame)!;
    expect(shadow!.x + shadowAnchor.anchorX).toBe(centre.x);
    expect(shadow!.y + shadowAnchor.anchorY).toBe(centre.y);
  });

  it('centres a flyer’s cues on its LIFTED body, where its art is drawn — its shadow marks where it truly is', () => {
    const { shadows, bodies } = place([creep({ creepId: 'flying', domain: 'air' })]);
    const [body] = bodies;
    const [shadow] = shadows;
    const centre = projection.fpToPixel(5 * 256, 5 * 256);
    // Both sprites are anchored at the true position…
    const anchor = frames.get(body!.frame)!;
    expect(body!.x + anchor.anchorX).toBe(centre.x);
    expect(body!.y + anchor.anchorY).toBe(centre.y);
    const shadowAnchor = frames.get(shadow!.frame)!;
    expect(shadow!.x + shadowAnchor.anchorX).toBe(centre.x);
    expect(shadow!.y + shadowAnchor.anchorY).toBe(centre.y);
    // …and the cues are centred on the body as its frame draws it, `CREEP_LIFT` design units
    // above that anchor: the art's own origin, measured from the bake rather than restated.
    const spec = atlasFrameSpecs(projection.cellPx, projection.dpr).find(
      (s) => s.key === body!.frame,
    )!;
    const g = recordingArtGraphics();
    spec.paint(g, PAL);
    const [, , artX, artY] = g.calls.find((c) => c.method === 'art')!.args as number[];
    expect(body!.cx).toBeCloseTo(body!.x + artX!, 9);
    expect(body!.cy).toBeCloseTo(body!.y + artY!, 9);
    expect(centre.y - body!.cy).toBeCloseTo(creepLiftPx(body!.r, true), 9);
    expect(body!.r).toBe(creepRadius(projection.cellPx, 'flying'));
  });

  it('chooses the body frame from the look — shape, family, domain — and the shadow from the family and domain', () => {
    const { shadows, bodies } = place([
      creep({ creepId: 'fast' }),
      creep({ creepId: 'swarm', hpFrac: 0.2 }),
      creep({ creepId: 'boss', boss: true }),
      creep({ creepId: 'resolute', hpFrac: 0.34 }),
      creep({ creepId: 'mystery' }),
    ]);
    expect(bodies.map((p) => p.frame)).toEqual([
      'creep:diamond:fast:ground',
      'creep:square:swarm:ground',
      'creep:hexagon:boss:ground',
      'creep:pentagon:normal:ground',
      'creep:triangle:normal:ground',
    ]);
    expect(shadows.map((p) => p.frame)).toEqual([
      'creep:shadow:fast:ground',
      'creep:shadow:swarm:ground',
      'creep:shadow:boss:ground',
      'creep:shadow:normal:ground',
      'creep:shadow:normal:ground',
    ]);
    const air = place([creep({ creepId: 'armored-flyer', domain: 'air' })]);
    expect(air.bodies[0]!.frame).toBe('creep:hexagon:armored:air');
    expect(air.shadows[0]!.frame).toBe('creep:shadow:armored:air');
  });

  // Retargeted (C3): until C3 the body's frame and the pip shared the low-HP tint, and this
  // test pinned them to one threshold. A body now keeps its family's hue at any HP: the same
  // frame and the same hue either side of the threshold, the HP carried to the bar, whose
  // colour turns there (`creep-paint.test.ts`, `scene.test.ts`).
  it('keeps a body in its family’s hue at any HP — the same frame either side of the low-HP threshold', () => {
    const { bodies } = place([
      creep({ creepId: 'swarm', hpFrac: 0.33 }),
      creep({ creepId: 'swarm', hpFrac: 0.34 }),
      creep({ creepId: 'swarm', hpFrac: 0 }),
    ]);
    const [low, edge, dead] = bodies;
    expect(low!.frame).toBe(edge!.frame);
    expect(dead!.frame).toBe(edge!.frame);
    for (const b of bodies) expect(b.hue).toBe(creepColour(PAL, 'swarm'));
    expect(bodies.map((b) => b.hpFrac)).toEqual([0.33, 0.34, 0]);
    expect(PAL.creepSwarm).not.toBe(PAL.creepLowHp);
  });

  it('sizes each creep by its family’s step AFTER the 3px floor — the boss 1.5× the armored creep even at the narrowest cells', () => {
    const tiny = createProjection({ cols: 10, rows: 10, cssWidth: 50, cssHeight: 50, dpr: 1 }); // 5px cells
    const { bodies } = place(
      [
        creep(),
        creep({ creepId: 'armored' }),
        creep({ creepId: 'boss', boss: true }),
        creep({ creepId: 'swarm' }),
      ],
      tiny,
      framesFor(tiny),
    );
    const [normal, armored, boss, swarm] = bodies;
    expect(normal!.r).toBe(3); // the floor binds
    expect(armored!.r).toBeCloseTo(3 * 1.12, 12);
    expect(boss!.r / armored!.r).toBeCloseTo(1.5, 12); // ... and the boss still reads larger
    expect(boss!.r).toBe(creepRadius(5, 'boss'));
    expect(swarm!.r).toBeLessThan(normal!.r); // the swarm smallest, under the floor itself
  });

  it('carries every cue state through, with the family’s hue for the HP bar', () => {
    const { bodies } = place([
      creep({
        creepId: 'flying',
        hpFrac: 0.5,
        slowed: true,
        poisoned: true,
        stunned: true,
        warded: true,
        domain: 'air',
      }),
    ]);
    expect(bodies[0]).toMatchObject({
      hpFrac: 0.5,
      slowed: true,
      poisoned: true,
      stunned: true,
      warded: true,
      hue: PAL.creepFlying,
    });
    expect(place([creep()]).bodies[0]).toMatchObject({
      slowed: false,
      poisoned: false,
      stunned: false,
      warded: false,
      hue: PAL.creep,
    });
  });

  it('draws every creep on the ground first, then every flyer over them — each in its given order — and every shadow under them all', () => {
    const { shadows, bodies } = place([
      creep({ creepId: 'swarm', x: 300 }),
      creep({ creepId: 'flying', domain: 'air', x: 305 }),
      creep({ creepId: 'fast', x: 310 }),
      creep({ creepId: 'armored-flyer', domain: 'air', x: 315 }),
      creep({ creepId: 'normal', x: 290 }),
    ]);
    // A later creep still draws over an earlier one of its own domain, and a flyer over all
    // that walk.
    expect(bodies.map((p) => p.frame.split(':').slice(1, 3).join(':'))).toEqual([
      'square:swarm',
      'diamond:fast',
      'triangle:normal',
      'triangle:flying',
      'hexagon:armored',
    ]);
    // The shadows go in a layer of their own, under every body (`layers.ts`), in creep order.
    expect(shadows.map((p) => p.frame.split(':')[2])).toEqual([
      'swarm',
      'flying',
      'fast',
      'armored',
      'normal',
    ]);
  });

  it('snaps a creep between pixels to a whole device pixel, by half a pixel at most', () => {
    for (const dpr of [1, 2, 1.5, 1.25]) {
      const proj = projectionAt(dpr, 100, 100);
      const fr = framesFor(proj);
      const c = creep({ x: 5 * 256 + 37, y: 3 * 256 + 101 });
      const { shadows, bodies } = place([c, { ...c, creepId: 'flying', domain: 'air' }], proj, fr);
      const [p] = bodies;
      const truth = proj.fpToPixel(c.x, c.y);
      for (const [snapped, real] of [
        [p!.cx, truth.x],
        [p!.cy, truth.y],
      ] as const) {
        expect(Math.abs(snapped * dpr - Math.round(snapped * dpr))).toBeLessThan(1e-9);
        expect(Math.abs(snapped - real)).toBeLessThanOrEqual(0.5 / dpr + 1e-9);
      }
      // Every sprite's own corner is on a whole device pixel too, on BOTH axes (the anchor is
      // whole texels) — the bodies, the flyer's among them, and the shadows…
      for (const s of [...bodies, ...shadows]) {
        expect(Math.abs(s.x * dpr - Math.round(s.x * dpr)), s.frame).toBeLessThan(1e-9);
        expect(Math.abs(s.y * dpr - Math.round(s.y * dpr)), s.frame).toBeLessThan(1e-9);
      }
      // … and a ground body's corner plus its frame's anchor IS the centre its cues are drawn
      // around, so a creep's body and its bar and rings cannot come apart by the snap.
      const anchor = fr.get(p!.frame)!;
      expect(p!.x + anchor.anchorX).toBeCloseTo(p!.cx, 9);
      expect(p!.y + anchor.anchorY).toBeCloseTo(p!.cy, 9);
    }
  });

  describe('a flyer near the canvas top (Codex P2, PR #87)', () => {
    // A board whose openings sit on its top row — legal, though no shipped board has one —
    // puts a flyer's true position half a cell from the canvas top, and its lifted body
    // above it. Its wings are its airborne cue, and `flying` shares `normal`'s triangle, so a
    // body drawn off the canvas would lose the ONLY air-vs-ground channel but hue. The
    // detached cue the wings replace flipped below its creep there; the body is drawn down.
    const flyerAt = (fpY: number, dpr = 1) => {
      const proj = projectionAt(dpr, 100, 100); // 10px cells, the board at the canvas top
      expect(proj.originY).toBe(0); // the premise: the canvas top is the board's
      const fr = framesFor(proj);
      const { shadows, bodies } = place(
        [creep({ creepId: 'flying', domain: 'air', y: fpY })],
        proj,
        fr,
      );
      return {
        proj,
        fr,
        body: bodies[0]!,
        shadow: shadows[0]!,
        lift: creepLiftPx(bodies[0]!.r, true),
      };
    };

    it('draws its body down by whole device pixels until it starts on the canvas, its cues with it — its shadow stays put', () => {
      for (const dpr of [1, 2, 1.5]) {
        const { proj, fr, body, shadow, lift } = flyerAt(128, dpr); // half a cell down: row 0's centre
        const truth = { y: snapToDevicePx(proj.fpToPixel(0, 128).y, dpr) };
        const raised = truth.y - fr.get(body.frame)!.anchorY; // where its full lift would start it
        expect(raised, 'the premise: the full lift starts it above the canvas').toBeLessThan(0);
        expect(body.y).toBeGreaterThanOrEqual(0); // on the canvas…
        expect(body.y).toBeLessThan(1 / dpr); // …by no more than it takes
        expect(Math.abs(body.y * dpr - Math.round(body.y * dpr))).toBeLessThan(1e-9);
        const down = body.y - raised;
        expect(body.cy).toBeCloseTo(truth.y - lift + down, 9); // the cues come down with it
        expect(shadow.y + fr.get(shadow.frame)!.anchorY).toBe(truth.y); // the shadow does not
      }
    });

    it('is not moved when its body starts exactly on the canvas’s top edge, and is moved one device pixel when it starts one above', () => {
      const { fr, body } = flyerAt(128);
      const anchorY = fr.get(body.frame)!.anchorY; // whole px at dpr 1
      const fpForY = (y: number): number => (y / 10) * 256; // 10px cells, origin 0
      const exact = flyerAt(fpForY(anchorY));
      expect(exact.body.y).toBe(0);
      expect(exact.body.cy).toBeCloseTo(anchorY - exact.lift, 9); // its full lift
      const above = flyerAt(fpForY(anchorY - 1));
      expect(above.body.y).toBe(0); // drawn down exactly the one pixel…
      expect(above.body.cy).toBeCloseTo(anchorY - above.lift, 9); // …so its body is where `exact`'s is
    });

    it('keeps its full lift where there is room above, and a creep on the ground is never moved', () => {
      const low = flyerAt(5 * 256);
      expect(low.body.cy).toBeCloseTo(50 - low.lift, 9);
      const proj = projectionAt(1);
      const { bodies } = place([creep({ y: 0 })], proj, framesFor(proj));
      expect(bodies[0]!.cy).toBe(0); // a walking creep is drawn where it is, even at the edge
      expect(bodies[0]!.y).toBeLessThan(0);
    });
  });
});

// ---- R4 QC (#181): the per-atlas look table, and the canvas-top step at fractional dprs ----

describe('placeCreeps — each look found once per atlas, and the canvas-top step (R4 QC)', () => {
  /** A frame map that counts its lookups. */
  class CountingFrames extends Map<string, FrameAnchor> {
    gets = 0;
    override get(key: string): FrameAnchor | undefined {
      this.gets++;
      return super.get(key);
    }
  }

  it('finds a look’s frames once per atlas — every later creep of that look asks the map nothing', () => {
    const projection = projectionAt(1);
    const frames = new CountingFrames(framesFor(projection));
    const first = placeCreeps([creep({ creepId: 'cache-probe' })], PAL, projection, frames);
    const asked = frames.gets;
    expect(asked, 'the premise: the first placement looks its frames up').toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      const again = placeCreeps(
        [creep({ creepId: 'cache-probe', x: 300 + i })],
        PAL,
        projection,
        frames,
      );
      expect(again.bodies[0]!.frame).toBe(first.bodies[0]!.frame);
    }
    expect(frames.gets).toBe(asked);
  });

  it('keeps an id’s four looks apart — ground and air, with and without the boss role — whatever order they come in', () => {
    const projection = projectionAt(1);
    const frames = framesFor(projection);
    const order = [
      [false, 'air'],
      [true, 'ground'],
      [true, 'air'],
      [false, 'ground'],
      [false, 'air'],
      [true, 'ground'],
    ] as const;
    for (const [boss, domain] of order) {
      const { bodies, shadows } = placeCreeps(
        [creep({ creepId: 'slot-probe', boss, domain })],
        PAL,
        projection,
        frames,
      );
      const family = boss ? 'boss' : 'normal';
      expect(bodies[0]!.frame, `boss=${boss} ${domain}`).toBe(`creep:triangle:${family}:${domain}`);
      expect(shadows[0]!.frame, `boss=${boss} ${domain}`).toBe(`creep:shadow:${family}:${domain}`);
      expect(bodies[0]!.r).toBeCloseTo(creepRadius(projection.cellPx, family), 12);
    }
  });

  it('steps a flyer down by the fewest whole device pixels at every dpr — fractional ones included', () => {
    // At 1.25, 1.5 and 1.75 the step's arithmetic lands a float's width past a whole number of
    // device pixels hundreds of times in this sweep: that is what the epsilon is for.
    for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
      for (const css of [100, 130]) {
        const proj = projectionAt(dpr, css, css);
        expect(proj.originY).toBe(0);
        const fr = framesFor(proj);
        for (const creepId of ['flying', 'armored-flyer']) {
          for (let fpY = 0; fpY <= 256; fpY += 3) {
            const { bodies } = placeCreeps(
              [creep({ creepId, domain: 'air', y: fpY })],
              PAL,
              proj,
              fr,
            );
            const body = bodies[0]!;
            const top = snapToDevicePx(proj.fpToPixel(0, fpY).y, dpr) - fr.get(body.frame)!.anchorY;
            if (top >= 0) {
              expect(body.y).toBe(top);
              continue;
            }
            const at = `${creepId} at dpr ${dpr}, ${css}px, fpY ${fpY}`;
            expect(body.y, `${at}: on the canvas`).toBeGreaterThan(-1e-9);
            expect(body.y, `${at}: by no more than it takes`).toBeLessThan(1 / dpr - 1e-9);
            expect(Math.abs(body.y * dpr - Math.round(body.y * dpr)), at).toBeLessThan(1e-9);
          }
        }
      }
    }
  });
});

// ---- Visual pass C1/C2 (#181): a hit creep's flash, and where each creep is drawn ----

describe('placeCreeps — a hit creep’s flash, on its body to the texel (C1)', () => {
  /** Where `spec`'s art is drawn from, frame-local: its own origin, read off the bake. */
  const artOrigin = (key: string, projection: Projection): { x: number; y: number } => {
    const spec = atlasFrameSpecs(projection.cellPx, projection.dpr).find((s) => s.key === key)!;
    const g = recordingArtGraphics();
    spec.paint(g, PAL);
    const [, , x, y] = g.calls.find((c) => c.method === 'art')!.args as number[];
    return { x: x!, y: y! };
  };

  it('shows each flashing creep’s flash — its look’s white silhouette, at the flash’s opacity — ground creeps’ first, then flyers’; none for a creep not flashing', () => {
    const projection = projectionAt(1);
    const frames = framesFor(projection);
    const flashOf = (id: number): number => ({ 2: 0.5, 3: 0.85 })[id] ?? 0;
    const { bodies, flashes } = placeCreeps(
      [
        creep({ id: 3, creepId: 'flying', domain: 'air', x: 700 }),
        creep({ id: 1 }),
        creep({ id: 2, creepId: 'fast', x: 400 }),
      ],
      PAL,
      projection,
      frames,
      flashOf,
    );
    expect(flashes.map((f) => [f.frame, f.alpha])).toEqual([
      [creepFrameKeys('fast', false, false).flash, 0.5],
      [creepFrameKeys('flying', false, true).flash, 0.85],
    ]);
    // Each on its body: the flash's art and the body's are drawn from the same point.
    const byId = new Map(bodies.map((b) => [b.id, b]));
    for (const [flash, id] of [
      [flashes[0]!, 2],
      [flashes[1]!, 3],
    ] as const) {
      const body = byId.get(id)!;
      const at = artOrigin(flash.frame, projection);
      expect(flash.x + at.x, flash.frame).toBeCloseTo(body.cx, 9);
      expect(flash.y + at.y, flash.frame).toBeCloseTo(body.cy, 9);
      // On whole device pixels, as the body is: the same texel grid.
      expect(flash.x).toBe(Math.round(flash.x));
      expect(flash.y).toBe(Math.round(flash.y));
    }
    // With no flash asked for — `placeCreeps`' default — none.
    expect(placeCreeps([creep()], PAL, projection, frames).flashes).toEqual([]);
  });

  it('steps a flyer’s flash down with its body at the canvas top, at every dpr', () => {
    for (const dpr of [1, 1.5, 2]) {
      const projection = projectionAt(dpr, 100, 100); // the board at the canvas top
      expect(projection.originY).toBe(0);
      const frames = framesFor(projection);
      const { bodies, flashes } = placeCreeps(
        [creep({ creepId: 'flying', domain: 'air', y: 64 })],
        PAL,
        projection,
        frames,
        () => 1,
      );
      const at = artOrigin(flashes[0]!.frame, projection);
      expect(flashes[0]!.y + at.y, `dpr ${dpr}`).toBeCloseTo(bodies[0]!.cy, 9);
      expect(flashes[0]!.y, `dpr ${dpr}`).toBeGreaterThanOrEqual(-1 / dpr);
    }
  });
});

describe('creepBodyCentre — where a creep no longer drawn would have been (C1/C2)', () => {
  it('is exactly the centre placeCreeps gives that creep’s body — on the ground, in the air, and stepped down at the canvas top', () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const projection = projectionAt(dpr, 130, 130);
      const frames = framesFor(projection);
      for (const c of [
        creep({ x: 5 * 256 + 37, y: 3 * 256 + 101 }),
        creep({ creepId: 'flying', domain: 'air', x: 5 * 256 + 37, y: 3 * 256 + 101 }),
        creep({ creepId: 'armored-flyer', domain: 'air', y: 20 }), // at the canvas top
        creep({ creepId: 'boss', boss: true, x: 1000, y: 900 }),
      ]) {
        const [body] = placeCreeps([c], PAL, projection, frames).bodies;
        const at = creepBodyCentre(c.x, c.y, c, projection, frames);
        expect([at.x, at.y], `${c.creepId} ${c.domain} at dpr ${dpr}`).toEqual([
          body!.cx,
          body!.cy,
        ]);
      }
    }
  });
});

describe('creepAimPoints — where each creep is drawn, in sim units (C2)', () => {
  it('takes each body’s centre back through the projection: projected again, it is the centre, to float precision', () => {
    for (const dpr of [1, 1.25, 1.5]) {
      const projection = projectionAt(dpr, 130, 130);
      const frames = framesFor(projection);
      const { bodies } = placeCreeps(
        [
          creep({ id: 4, x: 5 * 256 + 37, y: 3 * 256 + 101 }),
          creep({ id: 9, creepId: 'flying', domain: 'air', x: 700, y: 900 }),
        ],
        PAL,
        projection,
        frames,
      );
      const points = creepAimPoints(bodies, projection);
      expect([...points.keys()]).toEqual([4, 9]);
      for (const body of bodies) {
        const p = points.get(body.id)!;
        const back = projection.fpToPixel(p.x, p.y);
        expect(back.x, `${body.id} at dpr ${dpr}`).toBeCloseTo(body.cx, 9);
        expect(back.y, `${body.id} at dpr ${dpr}`).toBeCloseTo(body.cy, 9);
      }
      // A flyer's point is its lifted body, above its true one: smaller y.
      expect(points.get(9)!.y).toBeLessThan(900);
    }
  });

  it('rewrites a map kept across frames in place: each body’s entry, the same object, and none for a creep no longer drawn', () => {
    const projection = projectionAt(1.5, 130, 130);
    const frames = framesFor(projection);
    const bodiesOf = (creeps: Partial<CreepVM>[]) =>
      placeCreeps(
        creeps.map((c) => creep(c)),
        PAL,
        projection,
        frames,
      ).bodies;
    const kept = new Map<number, KeptAimPoint>();
    const first = bodiesOf([
      { id: 4, x: 600, y: 700 },
      { id: 9, creepId: 'flying', domain: 'air', x: 900, y: 300 },
    ]);
    expect(creepAimPoints(first, projection, kept)).toBe(kept);
    const four = kept.get(4);
    const next = bodiesOf([
      { id: 11, x: 100, y: 100 },
      { id: 4, x: 650, y: 720 },
    ]);
    creepAimPoints(next, projection, kept);
    expect([...kept.keys()].sort((a, b) => a - b)).toEqual([4, 11]);
    expect(kept.get(4)).toBe(four);
    // Exactly the points a fresh map holds for the same bodies.
    const fresh = creepAimPoints(next, projection);
    const xy = (p: { x: number; y: number } | undefined) => p && { x: p.x, y: p.y };
    for (const id of [4, 11]) expect(xy(kept.get(id))).toEqual(xy(fresh.get(id)));
    // A body listed twice (a forged state's) keeps one entry, the later point, as a fresh map
    // does — and a creep no longer drawn still loses its own.
    const twice = bodiesOf([
      { id: 11, x: 100, y: 100 },
      { id: 11, x: 300, y: 500 },
    ]);
    creepAimPoints(twice, projection, kept);
    expect([...kept.keys()]).toEqual([11]);
    expect(xy(kept.get(11))).toEqual(xy(creepAimPoints(twice, projection).get(11)));
  });

  it('is a ground creep’s own point when that point is on a whole pixel', () => {
    const projection = projectionAt(1); // 10px cells: every 25.6 fixed-point units is a pixel
    const { bodies } = placeCreeps(
      [creep({ x: 5 * 256, y: 3 * 256 })],
      PAL,
      projection,
      framesFor(projection),
    );
    const p = creepAimPoints(bodies, projection).get(1)!;
    expect(p.x).toBeCloseTo(5 * 256, 9);
    expect(p.y).toBeCloseTo(3 * 256, 9);
  });
});
