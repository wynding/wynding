// board-frame.test.ts — one frame of the board, drawn into three recording layers and five
// recording sprite layers: what goes into WHICH live layer (the aura shells into `shells` and
// nowhere else — M2-S8's guarantee that no shell stripes a tower body, now held by the layer
// order — the selection and tracers into `effects`, every creep cue, the ghost and the sparks
// into `cues`, in that order), what each sprite layer is shown — a spent mine's scorch on the
// frame's own clock among them — where the board image sits, that a reset hides everything,
// and that an arrived tracer lands exactly on its creep.

import { describe, it, expect } from 'vitest';
import {
  createLiveLayers,
  createSpriteLayers,
  drawBoardFrame,
  forEachLayerSprite,
  resetBoardFrame,
  type BoardFrameInput,
  type BoardTargets,
} from './board-frame';
import { createSpritePool } from './sprite-pool';
import { atlasFrameSpecs, PAD_FRAME_KEY, PLATE_FRAME_KEY, SCORCH_FRAME_KEY } from './art-frames';
import { AURA_SHELL_ALPHA } from './board-draw';
import { layerDepth } from './layers';
import { resolvePalette } from './palette';
import { createProjection, type Projection } from './projection';
import type { CreepPlacement, FrameAnchor, SpritePlacement } from './placement';
import { createScorchTracker } from './scorches';
import { renderTimeOf } from './tracers';
import type { LiveSpark } from './sparks';
import { recordingLayer, type Call } from './test-support/recording-graphics';
import type { CreepVM, RenderOverlay, RenderVM, TowerVM } from './types';

/** Each drawing call of a layer as `method colour` — the fill or line colour in force. */
function drawn(layer: { calls: Call[] }): string[] {
  let fill = -1;
  let line = -1;
  const out: string[] = [];
  for (const { method, args } of layer.calls) {
    if (method === 'clear') continue;
    if (method === 'fillStyle') fill = args[0] as number;
    else if (method === 'lineStyle') line = args[1] as number;
    else {
      const stroked = method.startsWith('stroke') || method === 'lineBetween';
      out.push(`${method} ${(stroked ? line : fill).toString(16)}`);
    }
  }
  return out;
}

function recordingSprites() {
  const syncs: SpritePlacement[][] = [];
  let hidden = 0;
  return {
    syncs,
    get hidden() {
      return hidden;
    },
    sync(placements: readonly SpritePlacement[]) {
      syncs.push([...placements]);
    },
    hideAll() {
      hidden += 1;
    },
  };
}

function targets() {
  const board = { positions: [] as [number, number][], visible: [] as boolean[] };
  const t = {
    board: {
      setPosition: (x: number, y: number) => board.positions.push([x, y]),
      setVisible: (v: boolean) => board.visible.push(v),
    },
    layers: { shells: recordingLayer(), effects: recordingLayer(), cues: recordingLayer() },
    scorches: recordingSprites(),
    plates: recordingSprites(),
    heads: recordingSprites(),
    pending: recordingSprites(),
    creeps: recordingSprites(),
  };
  return { t: t satisfies BoardTargets, board };
}

const PAL = resolvePalette('default');
const hex = (n: number): string => n.toString(16);
const framesFor = (p: Projection): ReadonlyMap<string, FrameAnchor> =>
  new Map(atlasFrameSpecs(p.cellPx, p.dpr).map((f) => [f.key, f]));

// A 1072×804 board at dpr 1: 33px cells, the board's corner at (74, 6).
const PROJECTION = createProjection({ cols: 28, rows: 24, cssWidth: 1072, cssHeight: 804, dpr: 1 });

const tower = (id: number, towerId: string, col: number, opts: Partial<TowerVM> = {}): TowerVM => ({
  id,
  col,
  row: 2,
  towerId,
  support: towerId === 'beacon',
  buffed: false,
  ...opts,
});

const creep = (opts: Partial<CreepVM> = {}): CreepVM => ({
  id: 7,
  creepId: 'normal',
  domain: 'ground',
  x: 10 * 256 + 100,
  y: 6 * 256 + 50,
  hpFrac: 0.5,
  slowed: false,
  poisoned: false,
  stunned: false,
  warded: false,
  boss: false,
  ...opts,
});

const OVERLAY: RenderOverlay = {
  ghost: null,
  selection: null,
  sparks: [],
  pendingAdds: [],
  pendingSells: [],
  colourMode: 'default',
  reducedMotion: false,
  tracers: [],
};

const vm = (towers: readonly TowerVM[], creeps: readonly CreepVM[]): RenderVM => ({
  tick: 10,
  phase: 'running',
  towers,
  creeps,
});

/** A busy frame: a beacon buffing a basic tower, a selection, a queued build, a creep wearing
 *  every status cue with a tracer arriving at it, the build ghost and a spark. */
function busyFrame(projection = PROJECTION): BoardFrameInput {
  const sparks: LiveSpark[] = [{ x: 3 * 256, y: 3 * 256, radiusFp: 0, k: 0.5 }];
  return {
    prevVm: null,
    curVm: vm(
      [tower(1, 'beacon', 2), tower(2, 'basic', 4, { buffed: true })],
      [creep({ slowed: true, poisoned: true, warded: true, domain: 'air' })],
    ),
    alpha: 0,
    overlay: {
      ...OVERLAY,
      ghost: { col: 12, row: 12, valid: true, rangeFp: 512, blastRadiusFp: null },
      selection: { col: 4, row: 2, rangeFp: 768, blastRadiusFp: null, towerId: 'basic' },
      pendingAdds: [{ col: 8, row: 8, towerId: 'slow' }],
      tracers: [
        {
          kind: 'targeted',
          originX: 2 * 256,
          originY: 2 * 256,
          targetId: 7,
          launchTick: 0,
          impactTick: 4, // arrived: the frame draws at tick 10
        },
      ],
    },
    projection,
    frames: framesFor(projection),
    sparks,
    scorches: createScorchTracker(),
  };
}

describe('drawBoardFrame — which live layer each thing is drawn into', () => {
  it('clears each live layer once, first', () => {
    const { t } = targets();
    drawBoardFrame(t, busyFrame());
    for (const layer of [t.layers.shells, t.layers.effects, t.layers.cues]) {
      expect(layer.calls[0]!.method).toBe('clear');
      expect(layer.calls.filter((c) => c.method === 'clear')).toHaveLength(1);
    }
  });

  it('draws the aura shell into the shells layer — and into no other (M2-S8: never over a body)', () => {
    const { t } = targets();
    drawBoardFrame(t, busyFrame());
    // Exactly the beacon's shell, one cell out from its footprint, at the shell's alpha.
    expect(drawn(t.layers.shells)).toEqual([`strokeRoundedRect ${hex(PAL.aura)}`]);
    const style = t.layers.shells.calls.find((c) => c.method === 'lineStyle')!;
    expect(style.args).toEqual([2, PAL.aura, AURA_SHELL_ALPHA]);
    const beacon = PROJECTION.cellToPixel(2, 2);
    const cell = PROJECTION.cellPx;
    const shell = t.layers.shells.calls.find((c) => c.method === 'strokeRoundedRect')!;
    expect(shell.args).toEqual([
      beacon.x - cell + 2,
      beacon.y - cell + 2,
      cell * 4 - 4,
      cell * 4 - 4,
      6,
    ]);
    for (const layer of [t.layers.effects, t.layers.cues]) {
      expect(drawn(layer).some((d) => d.endsWith(` ${hex(PAL.aura)}`))).toBe(false);
    }
  });

  it('draws the selection ring and then the tracer into effects — and nothing else', () => {
    const { t } = targets();
    drawBoardFrame(t, busyFrame());
    expect(drawn(t.layers.effects)).toEqual([
      `strokeCircle ${hex(PAL.range)}`,
      `fillCircle ${hex(PAL.tracer)}`,
    ]);
  });

  it('draws every creep cue, then the ghost, then the sparks into cues', () => {
    const { t } = targets();
    drawBoardFrame(t, busyFrame());
    const cues = drawn(t.layers.cues);
    expect(cues[0]).toBe(`fillRect ${hex(PAL.creep)}`); // the health pip comes first
    const ghost = cues.indexOf(`strokeRoundedRect ${hex(PAL.ghostValid)}`);
    const spark = cues.indexOf(`fillCircle ${hex(PAL.spark)}`);
    expect(ghost).toBeGreaterThan(0);
    expect(spark).toBe(cues.length - 1); // sparks last
    for (const cue of [
      `strokeCircle ${hex(PAL.slowed)}`,
      `fillCircle ${hex(PAL.poisoned)}`,
      `strokeCircle ${hex(PAL.warded)}`,
      `lineBetween ${hex(PAL.airborne)}`,
    ]) {
      expect(cues.indexOf(cue), cue).toBeGreaterThan(0);
      expect(cues.lastIndexOf(cue), cue).toBeLessThan(ghost); // every creep cue before the ghost
    }
    expect(cues.indexOf(`strokeCircle ${hex(PAL.range)}`)).toBeGreaterThan(ghost); // its range ring
  });

  it('a frame with no shells, selection, tracers, ghost or sparks still clears every layer', () => {
    const { t } = targets();
    drawBoardFrame(t, {
      ...busyFrame(),
      curVm: vm([tower(2, 'basic', 4)], []),
      overlay: OVERLAY,
      sparks: [],
    });
    // Each layer was cleared — and given nothing else.
    expect([t.layers.shells, t.layers.effects, t.layers.cues].map((l) => l.calls)).toEqual([
      [{ method: 'clear', args: [] }],
      [{ method: 'clear', args: [] }],
      [{ method: 'clear', args: [] }],
    ]);
  });
});

describe('drawBoardFrame — the sprite layers and the board image', () => {
  it('shows each sprite layer its placements: plates, heads, queued builds, creeps — and no scorch with nothing gone off', () => {
    const { t } = targets();
    drawBoardFrame(t, busyFrame());
    // Each committed tower is two sprites: its plate in `plates`, its head — the buffed one
    // wearing the boost glow — in `heads`.
    expect(t.plates.syncs.map((s) => s.map((p) => p.frame))).toEqual([
      [PLATE_FRAME_KEY, PLATE_FRAME_KEY],
    ]);
    expect(t.heads.syncs.map((s) => s.map((p) => p.frame))).toEqual([
      ['tower:head:pylon:support:committed', 'tower:head:plain:damage:buffed'],
    ]);
    expect(t.scorches.syncs).toEqual([[]]);
    expect(t.pending.syncs.map((s) => s.map((p) => p.frame))).toEqual([
      ['tower:pending:ringed:control'],
    ]);
    expect(t.creeps.syncs.map((s) => s.map((p) => p.frame))).toEqual([
      ['creep:triangle:normal:standard'],
    ]);
  });

  it('places the board image at the board’s corner, snapped to a device pixel, and shows it', () => {
    const { t, board } = targets();
    drawBoardFrame(t, busyFrame());
    expect(board.positions).toEqual([[74, 6]]);
    expect(board.visible).toEqual([true]);
  });

  it('snaps the board image to a whole device pixel at a fractional dpr, where its corner falls between two', () => {
    // 1074×806 CSS px at dpr 1.5: 33px cells, the corner at (75, 7) CSS px — device (112.5, 10.5).
    const projection = createProjection({
      cols: 28,
      rows: 24,
      cssWidth: 1074,
      cssHeight: 806,
      dpr: 1.5,
    });
    expect([projection.originX * 1.5, projection.originY * 1.5]).toEqual([112.5, 10.5]);
    const { t, board } = targets();
    drawBoardFrame(t, busyFrame(projection));
    const [x, y] = board.positions[0]!;
    expect(x * 1.5).toBeCloseTo(Math.round(x * 1.5), 9);
    expect(y * 1.5).toBeCloseTo(Math.round(y * 1.5), 9);
    // … and the nearest such pixel: within half a device pixel of the true corner.
    expect(Math.abs(x - projection.originX)).toBeLessThanOrEqual(0.5 / 1.5);
    expect(Math.abs(y - projection.originY)).toBeLessThanOrEqual(0.5 / 1.5);
  });

  it('a reset clears every layer and hides the board and every sprite layer; the next frame shows them', () => {
    const { t, board } = targets();
    drawBoardFrame(t, busyFrame());
    let scorchResets = 0;
    resetBoardFrame(t, { scorches: { reset: () => (scorchResets += 1) } });
    expect(scorchResets).toBe(1);
    for (const layer of [t.layers.shells, t.layers.effects, t.layers.cues]) {
      expect(layer.calls[layer.calls.length - 1]!.method).toBe('clear');
    }
    expect(board.visible).toEqual([true, false]);
    expect([
      t.scorches.hidden,
      t.plates.hidden,
      t.heads.hidden,
      t.pending.hidden,
      t.creeps.hidden,
    ]).toEqual([1, 1, 1, 1, 1]);
    drawBoardFrame(t, busyFrame());
    expect(board.visible).toEqual([true, false, true]);
    expect(t.creeps.syncs).toHaveLength(2);
  });
});

describe('drawBoardFrame — the board image goes to the NEAREST device pixel', () => {
  it('rounds its corner — not down, not up — at dpr 1.25, where the corner is a quarter pixel off on both axes', () => {
    // 1074×802 CSS px at dpr 1.25: 33px cells, the corner at (75, 5) CSS px — device (93.75, 6.25).
    // Nearest is device (94, 6): flooring would give 93 across, ceiling 7 down.
    const projection = createProjection({
      cols: 28,
      rows: 24,
      cssWidth: 1074,
      cssHeight: 802,
      dpr: 1.25,
    });
    expect([projection.originX * 1.25, projection.originY * 1.25]).toEqual([93.75, 6.25]);
    const { t, board } = targets();
    drawBoardFrame(t, busyFrame(projection));
    const [x, y] = board.positions[0]!;
    expect(x).toBeCloseTo(94 / 1.25, 9);
    expect(y).toBeCloseTo(6 / 1.25, 9);
  });
});

describe('drawBoardFrame — the ghost, the sparks and reduced motion (drawn in `cues`)', () => {
  const cuesOf = (overlay: Partial<RenderOverlay>, sparks: LiveSpark[] = []): Call[] => {
    const { t } = targets();
    drawBoardFrame(t, {
      ...busyFrame(),
      curVm: vm([], []),
      overlay: { ...OVERLAY, ...overlay },
      sparks,
    });
    return t.layers.cues.calls.filter((c) => c.method !== 'clear');
  };

  it('an invalid ghost is a crossed-out square — shape, not colour alone', () => {
    const calls = cuesOf({
      ghost: { col: 5, row: 5, valid: false, rangeFp: 512, blastRadiusFp: null },
    });
    const p = PROJECTION.cellToPixel(5, 5);
    const size = PROJECTION.cellPx * 2;
    expect(calls).toEqual([
      { method: 'lineStyle', args: [3, PAL.ghostInvalid, 1] },
      { method: 'strokeRect', args: [p.x + 2, p.y + 2, size - 4, size - 4] },
      { method: 'lineBetween', args: [p.x + 2, p.y + 2, p.x + size - 2, p.y + size - 2] },
      { method: 'lineBetween', args: [p.x + size - 2, p.y + 2, p.x + 2, p.y + size - 2] },
    ]);
  });

  it('a valid support-tower ghost previews no range ring; a blast tower’s previews its spokes', () => {
    const beacon = cuesOf({
      ghost: { col: 5, row: 5, valid: true, rangeFp: null, blastRadiusFp: null },
    });
    expect(beacon.map((c) => c.method)).toEqual(['lineStyle', 'strokeRoundedRect']);
    const splash = cuesOf({
      ghost: { col: 5, row: 5, valid: true, rangeFp: 1024, blastRadiusFp: 384 },
    });
    expect(splash.filter((c) => c.method === 'strokeCircle')).toHaveLength(1); // the range
    expect(splash.filter((c) => c.method === 'lineBetween')).toHaveLength(4); // the spokes
    expect(splash.find((c) => c.method === 'lineStyle' && c.args[0] === 2)!.args).toEqual([
      2,
      PAL.range,
      0.9,
    ]);
  });

  it('a spark fills a shrinking dot at its fade; a blast spark strokes a ring that grows as it fades', () => {
    const dot = cuesOf({}, [{ x: 3 * 256, y: 3 * 256, radiusFp: 0, k: 0.5 }]);
    const c = PROJECTION.fpToPixel(3 * 256, 3 * 256);
    expect(dot).toEqual([
      { method: 'fillStyle', args: [PAL.spark, 0.5] },
      { method: 'fillCircle', args: [c.x, c.y, Math.max(2, PROJECTION.cellPx * 0.3 * 0.5)] },
    ]);
    const ring = cuesOf({}, [{ x: 3 * 256, y: 3 * 256, radiusFp: 512, k: 0.25 }]);
    expect(ring).toEqual([
      { method: 'lineStyle', args: [2, PAL.spark, 0.25] },
      // three quarters of the way to its full blast radius
      { method: 'strokeCircle', args: [c.x, c.y, PROJECTION.fpLenToPixel(512) * 0.75] },
    ]);
  });

  it('never draws a tracer dot, a spark or a blast ring under 2px — on a board of 10px cells, too', () => {
    // 280×240 CSS px: 10px cells, where a tracer's 0.15-cell dot would be 1.5px, a k = 0.25
    // spark's 0.3-cell × k dot 0.75px, and a blast ring at its birth (grown 0) nothing at all.
    const projection = createProjection({
      cols: 28,
      rows: 24,
      cssWidth: 280,
      cssHeight: 240,
      dpr: 1,
    });
    expect(projection.cellPx).toBe(10);
    const frame = busyFrame(projection);
    const { t } = targets();
    drawBoardFrame(t, {
      ...frame,
      curVm: vm([], [creep()]), // the tracer's target, wearing no status cue
      overlay: { ...frame.overlay, ghost: null, selection: null, pendingAdds: [] },
      sparks: [
        { x: 3 * 256, y: 3 * 256, radiusFp: 0, k: 0.25 },
        { x: 3 * 256, y: 3 * 256, radiusFp: 512, k: 1 },
      ],
    });
    const radii = (layer: { calls: Call[] }, method: string): number[] =>
      layer.calls.filter((c) => c.method === method).map((c) => c.args[2] as number);
    expect(radii(t.layers.effects, 'fillCircle')).toEqual([2]); // the tracer's dot
    expect(radii(t.layers.cues, 'fillCircle')).toEqual([2]); // the spark
    expect(radii(t.layers.cues, 'strokeCircle')).toEqual([2]); // the blast ring
  });

  it('under reduced motion a spark is half as bright, a blast ring holds its full radius, and tracers are omitted', () => {
    const ring = cuesOf({ reducedMotion: true }, [{ x: 0, y: 0, radiusFp: 512, k: 0.5 }]);
    expect(ring[0]).toEqual({ method: 'lineStyle', args: [2, PAL.spark, 0.25] });
    expect(ring[1]!.args[2]).toBe(PROJECTION.fpLenToPixel(512)); // no sweep: full radius
    const dot = cuesOf({ reducedMotion: true }, [{ x: 0, y: 0, radiusFp: 0, k: 0.5 }]);
    expect(dot[0]).toEqual({ method: 'fillStyle', args: [PAL.spark, 0.25] });
    const { t } = targets();
    const frame = busyFrame();
    drawBoardFrame(t, { ...frame, overlay: { ...frame.overlay, reducedMotion: true } });
    expect(t.layers.effects.calls.some((c) => c.method === 'fillCircle')).toBe(false);
  });
});

describe('drawBoardFrame — a tracer converges on where its creep is DRAWN', () => {
  it('an arrived tracer sits exactly on its target creep’s snapped centre at a fractional dpr', () => {
    for (const dpr of [1.25, 1.5]) {
      const projection = createProjection({
        cols: 28,
        rows: 24,
        cssWidth: 1000,
        cssHeight: 760,
        dpr,
      });
      const frame = busyFrame(projection);
      const c = creep({ x: 10 * 256 + 37, y: 6 * 256 + 101 });
      const { t } = targets();
      drawBoardFrame(t, { ...frame, curVm: vm([], [c]) });
      const placed = t.creeps.syncs[0]![0] as CreepPlacement;
      const dot = t.layers.effects.calls.find((call) => call.method === 'fillCircle')!;
      expect(dot.args.slice(0, 2)).toEqual([placed.cx, placed.cy]);
      // The creep's true point is between device pixels here, so the snap is doing the work.
      const raw = projection.fpToPixel(c.x, c.y);
      expect([raw.x, raw.y]).not.toEqual([placed.cx, placed.cy]);
    }
  });
});

/** One frame as the scene draws it: the tracker is fed first (`scene.ts`'s `draw()`), then
 *  `drawBoardFrame` reads the scorches still fading. */
function fedFrame(t: ReturnType<typeof targets>['t'], input: BoardFrameInput): void {
  input.scorches.update({
    tracers: input.overlay.tracers,
    sparks: input.overlay.sparks,
    renderTick: renderTimeOf(input.prevVm, input.curVm, input.alpha),
  });
  drawBoardFrame(t, input);
}

describe('drawBoardFrame — a spent mine’s scorch, in the scorches layer, on the frame’s own clock', () => {
  it('shows a detonated mine’s scorch at its footprint centre, fading from the render tick it went off at', () => {
    const { t } = targets();
    const scorches = createScorchTracker();
    // A mine anchored at (6, 2): its footprint centre — where its blast is anchored — is the
    // corner of cells (7, 3).
    const mine = tower(3, 'mine', 6);
    const centre = { x: 7 * 256, y: 3 * 256 };
    const frame = (
      prevTick: number,
      alpha: number,
      towers: readonly TowerVM[],
      tracers: RenderOverlay['tracers'],
    ): BoardFrameInput => ({
      prevVm: { ...vm(towers, []), tick: prevTick },
      curVm: { ...vm(towers, []), tick: prevTick + 1 },
      alpha,
      overlay: { ...OVERLAY, tracers },
      projection: PROJECTION,
      frames: framesFor(PROJECTION),
      sparks: [],
      scorches,
    });
    // The mine stands, on its pad in the plates layer, and nothing has gone off.
    fedFrame(t, frame(20, 0, [mine], []));
    expect(t.plates.syncs[0]!.map((p) => p.frame)).toEqual([PAD_FRAME_KEY]);
    expect(t.scorches.syncs[0]).toEqual([]);
    // It goes off — a blast whose origin is its destination, at its footprint centre — in a
    // frame drawn at render tick 21.25: the previous tick plus the frame's alpha.
    const blast = {
      kind: 'blast' as const,
      originX: centre.x,
      originY: centre.y,
      destX: centre.x,
      destY: centre.y,
      launchTick: 21,
      impactTick: 21,
    };
    fedFrame(t, frame(21, 0.25, [], [blast]));
    expect(t.scorches.syncs[1]).toHaveLength(1);
    const scorch = t.scorches.syncs[1]![0]!;
    expect(scorch.frame).toBe(SCORCH_FRAME_KEY);
    expect(scorch.alpha).toBe(1);
    // Its frame's anchor sits on the footprint centre, snapped to a device pixel.
    const at = PROJECTION.fpToPixel(centre.x, centre.y);
    const anchor = framesFor(PROJECTION).get(SCORCH_FRAME_KEY)!;
    expect(Math.abs(scorch.x + anchor.anchorX - at.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(scorch.y + anchor.anchorY - at.y)).toBeLessThanOrEqual(0.5);
    // 40.5 ticks later on the same clock — a frame at render tick 61.75, its previous tick
    // plus its alpha — it is just past half faded; and the tracer, still listed, is not
    // scorched again.
    fedFrame(t, frame(61, 0.75, [], [blast]));
    expect(t.scorches.syncs[2]).toHaveLength(1);
    expect(t.scorches.syncs[2]![0]!.alpha).toBeCloseTo(1 - 40.5 / 80, 9);
    // At 80 ticks it is gone.
    fedFrame(t, frame(101, 0.25, [], []));
    expect(t.scorches.syncs[3]).toEqual([]);
  });

  it('feeds the tracker the frame’s impacts: a mine seen standing, then gone with only its marked blast landing at its centre, leaves a scorch', () => {
    const { t } = targets();
    const scorches = createScorchTracker();
    const mine = tower(3, 'mine', 6); // footprint centre: the corner of cells (7, 3)
    const frame = (tick: number, towers: readonly TowerVM[], overlay: RenderOverlay) =>
      ({
        prevVm: { ...vm(towers, []), tick },
        curVm: { ...vm(towers, []), tick: tick + 1 },
        alpha: 0,
        overlay,
        projection: PROJECTION,
        frames: framesFor(PROJECTION),
        sparks: [],
        scorches,
      }) satisfies BoardFrameInput;
    fedFrame(t, frame(20, [mine], OVERLAY)); // the mine stands
    // Gone, with no tracer: only the blast's impact, at its footprint centre.
    fedFrame(
      t,
      frame(21, [], {
        ...OVERLAY,
        sparks: [{ x: 7 * 256, y: 3 * 256, radiusFp: 2.5 * 256, detonation: true }],
      }),
    );
    expect(t.scorches.syncs[1]!.map((p) => p.frame)).toEqual([SCORCH_FRAME_KEY]);
  });

  it('a reset forgets every scorch the run left: the next frame’s floor is clean', () => {
    const { t } = targets();
    const scorches = createScorchTracker();
    const centre = 7 * 256;
    const blast = {
      kind: 'blast' as const,
      originX: centre,
      originY: 3 * 256,
      destX: centre,
      destY: 3 * 256,
      launchTick: 21,
      impactTick: 21,
    };
    const frame = (tick: number, tracers: RenderOverlay['tracers']) =>
      ({
        prevVm: { ...vm([], []), tick },
        curVm: { ...vm([], []), tick: tick + 1 },
        alpha: 0,
        overlay: { ...OVERLAY, tracers },
        projection: PROJECTION,
        frames: framesFor(PROJECTION),
        sparks: [],
        scorches,
      }) satisfies BoardFrameInput;
    fedFrame(t, frame(21, [blast]));
    expect(t.scorches.syncs[0]).toHaveLength(1); // held
    resetBoardFrame(t, { scorches });
    fedFrame(t, frame(22, []));
    expect(t.scorches.syncs[1]).toEqual([]);
    expect(scorches.live(22)).toEqual([]);
  });
});

describe('createLiveLayers / createSpriteLayers — each layer made under its own name', () => {
  it('makes each live layer under its own name', () => {
    const layers = createLiveLayers((name) => Object.assign(recordingLayer(), { name }));
    expect([layers.shells.name, layers.effects.name, layers.cues.name]).toEqual([
      'shells',
      'effects',
      'cues',
    ]);
  });

  it('forEachLayerSprite visits every sprite of all five sprite layers — what a rebake repoints at its new atlas', () => {
    // As `scene.ts` makes them: a pool per layer, each sprite knowing which layer made it.
    const layers = createSpriteLayers((layer) =>
      createSpritePool((p) => ({
        layer,
        frame: p.frame,
        visible: true,
        alpha: 1,
        setPosition: () => undefined,
        setFrame: () => undefined,
        setVisible(this: { visible: boolean }, v: boolean) {
          this.visible = v;
        },
        setAlpha: () => undefined,
      })),
    );
    const names = ['scorches', 'plates', 'heads', 'pending', 'creeps'] as const;
    for (const name of names) {
      layers[name].sync([0, 1].map((i) => ({ frame: `${name}:${i}`, x: 0, y: 0 })));
    }
    layers.creeps.sync([{ frame: 'creeps:0', x: 0, y: 0 }]); // one hidden — still visited
    const seen: string[] = [];
    forEachLayerSprite(layers, (sprite, frame) => seen.push(`${sprite.layer} ${frame}`));
    expect(seen.sort()).toEqual(names.flatMap((n) => [`${n} ${n}:0`, `${n} ${n}:1`]).sort());
  });

  it('makes each sprite layer under its own name', () => {
    const layers = createSpriteLayers((name) => ({ name }));
    expect([
      layers.scorches.name,
      layers.plates.name,
      layers.heads.name,
      layers.pending.name,
      layers.creeps.name,
    ]).toEqual(['scorches', 'plates', 'heads', 'pending', 'creeps']);
  });

  it('so depths read from those names keep every shell under every plate and head (M2-S8), every scorch under every shell, and the rest in order', () => {
    // How `scene.ts` makes them: each object's depth is `layerDepth` of the name it was made under.
    const live = createLiveLayers((name) =>
      Object.assign(recordingLayer(), { depth: layerDepth(name) }),
    );
    const sprites = createSpriteLayers((name) => layerDepth(name));
    expect([
      layerDepth('board'),
      sprites.scorches,
      live.shells.depth,
      sprites.plates,
      sprites.heads,
      sprites.pending,
      live.effects.depth,
      sprites.creeps,
      live.cues.depth,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
