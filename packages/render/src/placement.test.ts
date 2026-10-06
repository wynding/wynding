// placement.test.ts — which frame every sprite shows and where: hidden pending-sell towers,
// queued builds, a tower's plate and head (the boosted head with its glow; no plate under
// the mine), the scorches a spent mine leaves, a creep's body and shadow (its look, its
// family's size, a flyer's lift and its cues on its lifted body, flyers over the ground),
// and positions snapped to whole device pixels with the frame's anchor honoured.

import { describe, it, expect } from 'vitest';
import { placeCreeps, placeScorches, placeTowers, type FrameAnchor } from './placement';
import { snapToDevicePx } from './device-px';
import { atlasFrameSpecs, PAD_FRAME_KEY, PLATE_FRAME_KEY, SCORCH_FRAME_KEY } from './art-frames';
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
