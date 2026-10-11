// board-frame.test.ts — one frame of the board, drawn into three recording layers and ten
// recording sprite layers: what goes into WHICH live layer (the aura shells into `shells` and
// nowhere else — M2-S8's guarantee that no shell stripes a tower body, now held by the layer
// order — the selection, the fire feedback and the shots' live parts into `effects`, every creep
// cue, the ghost, the sparks and combat feedback into `cues`, in that order), what each sprite
// layer is shown — a spent mine's scorch on the frame's own clock, each tower's own shot, a hit
// creep's flash and a kill's bounty pop among them — where the board image sits, that a reset
// hides everything, that an arrived shot lands exactly on the body it struck, a flyer's lifted
// one included (C2), and how the heads aim and each shot shows (T3): turned toward where the
// target is drawn, onto a shot's bearing the moment it is seen, knocked back, flashed or pulsed,
// on render time, and still under Reduce motion.

import { describe, it, expect } from 'vitest';
import {
  createLiveLayers,
  createPolygonLiveLayers,
  createSpriteLayers,
  drawBoardFrame,
  drawFeedbackStrokes,
  drawFireFeedback,
  drawShots,
  forEachLayerSprite,
  resetBoardFrame,
  type BoardFrameInput,
  type BoardTargets,
} from './board-frame';
import { CIRCLE_MIN_SEGMENTS, circleSegments, type PathGraphics } from './circle-path';
import { createSpritePool } from './sprite-pool';
import {
  artUnit,
  atlasFrameSpecs,
  creepFrameKeys,
  GEM_FRAME_KEY,
  glyphFrameKey,
  PAD_FRAME_KEY,
  PLATE_FRAME_KEY,
  RIM_RUNS_FRAME_KEY,
  SCORCH_FRAME_KEY,
  shotFrameKeys,
  type FrameSpec,
} from './art-frames';
import { AURA_SHELL_ALPHA } from './board-draw';
import { snapToDevicePx } from './device-px';
import { layerDepth } from './layers';
import { resolvePalette } from './palette';
import { createProjection, type Projection } from './projection';
import {
  creepBodyCentre,
  placeTowers,
  type CreepPlacement,
  type SpritePlacement,
} from './placement';
import { createScorchTracker } from './scorches';
import { renderTimeOf } from './tracers';
import type { LiveSpark } from './sparks';
import { ART_FLASH, ART_INK, FIRE_PULSE_RINGS, MUZZLE_FLASH, RECOIL_DEPTH } from './tower-art';
import { circlePoints } from './circle-polygon';
import { AIM_TURN_PER_TICK, aimAngle, createAimTracker } from './tower-aim';
import { createFireTracker, flashAt } from './tower-fire';
import {
  BOUNTY_POP_MS,
  createFeedbackTracker,
  HIT_FLASH_ALPHA,
  HIT_FLASH_MS,
  KILL_BURST_MS,
} from './combat-feedback';
import { ART_HIT_FLASH, ART_LIVES } from './art-ink';
import { fxUnit, KILL_BURST, LEAK_RINGS } from './effect-art';
import { creepColour } from './palette';
import { recordingLayer, type Call } from './test-support/recording-graphics';
import type { CreepVM, KillVM, RenderOverlay, RenderVM, TowerVM, TracerVM } from './types';

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
    rims: recordingSprites(),
    pending: recordingSprites(),
    creepShadows: recordingSprites(),
    shots: recordingSprites(),
    creeps: recordingSprites(),
    flashes: recordingSprites(),
    pops: recordingSprites(),
  };
  return { t: t satisfies BoardTargets, board };
}

/** The board's exit cell in these frames: the east wall's opening. */
const EXIT = { col: 27, row: 11 } as const;

const PAL = resolvePalette('default');
const hex = (n: number): string => n.toString(16);
const framesFor = (p: Projection): ReadonlyMap<string, FrameSpec> =>
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
  targetId: 0,
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
  kills: [],
  leaks: 0,
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
    exit: EXIT,
    nowMs: 0,
    sparks,
    scorches: createScorchTracker(),
    aim: createAimTracker(),
    fire: createFireTracker(),
    feedback: createFeedbackTracker(),
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
    // The rings' ink under-strokes come first (`drawCreepCues`' first pass).
    expect(cues[0]).toBe(`strokeCircle ${hex(ART_INK)}`);
    const ghost = cues.indexOf(`strokeRoundedRect ${hex(PAL.ghostValid)}`);
    const spark = cues.indexOf(`fillCircle ${hex(PAL.spark)}`);
    expect(ghost).toBeGreaterThan(0);
    expect(spark).toBe(cues.length - 1); // sparks last
    for (const cue of [
      `strokeCircle ${hex(PAL.slowed)}`,
      `fillCircle ${hex(PAL.poisoned)}`,
      `strokeCircle ${hex(PAL.warded)}`,
      `fillRect ${hex(PAL.creep)}`, // the HP bar's fill, in the creep's family hue
    ]) {
      expect(cues.indexOf(cue), cue).toBeGreaterThan(0);
      expect(cues.lastIndexOf(cue), cue).toBeLessThan(ghost); // every creep cue before the ghost
    }
    // The airborne cue is no live cue since C4: a flyer's wings are baked into its body's frame
    // (the creeps sprite layer, below), so nothing here is drawn in the airborne colour.
    expect(cues.some((c) => c.endsWith(` ${hex(PAL.airborne)}`))).toBe(false);
    expect(t.creeps.syncs[0]!.map((p) => p.frame)).toEqual(['creep:triangle:normal:air']);
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
  it('shows each sprite layer its placements: plates, heads, queued builds, creeps and their shadows — and no scorch with nothing gone off', () => {
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
    expect(t.rims.syncs).toEqual([[]]); // no head posed: no rim painted again over one
    expect(t.scorches.syncs).toEqual([[]]);
    expect(t.pending.syncs.map((s) => s.map((p) => p.frame))).toEqual([
      ['tower:pending:ringed:control'],
    ]);
    // The busy frame's creep flies: its body — wings and all — in `creeps`, and its shadow, at
    // its true position, in `creepShadows`.
    expect(t.creeps.syncs.map((s) => s.map((p) => p.frame))).toEqual([
      ['creep:triangle:normal:air'],
    ]);
    expect(t.creepShadows.syncs.map((s) => s.map((p) => p.frame))).toEqual([
      ['creep:shadow:normal:air'],
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

  it('a reset forgets every tracker, clears every layer and hides the board and every sprite layer; the next frame shows them', () => {
    const { t, board } = targets();
    drawBoardFrame(t, busyFrame());
    const resets: string[] = [];
    resetBoardFrame(t, {
      scorches: { reset: () => resets.push('scorches') },
      aim: { reset: () => resets.push('aim') },
      fire: { reset: () => resets.push('fire') },
      feedback: { reset: () => resets.push('feedback') },
    });
    expect(resets.sort()).toEqual(['aim', 'feedback', 'fire', 'scorches']); // each one, once
    for (const layer of [t.layers.shells, t.layers.effects, t.layers.cues]) {
      expect(layer.calls[layer.calls.length - 1]!.method).toBe('clear');
    }
    expect(board.visible).toEqual([true, false]);
    expect([
      t.scorches.hidden,
      t.plates.hidden,
      t.heads.hidden,
      t.rims.hidden,
      t.pending.hidden,
      t.creepShadows.hidden,
      t.shots.hidden,
      t.creeps.hidden,
      t.flashes.hidden,
      t.pops.hidden,
    ]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    drawBoardFrame(t, busyFrame());
    expect(board.visible).toEqual([true, false, true]);
    for (const layer of [t.creeps, t.creepShadows, t.shots, t.flashes, t.pops]) {
      expect(layer.syncs).toHaveLength(2);
    }
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

describe('drawBoardFrame — combat feedback: a hit’s flash, a kill’s burst and pop, a leak’s pulse (C1)', () => {
  /** Frames drawn on one set of trackers, as the scene draws them, each at a wall-clock time. */
  function feed() {
    const { t } = targets();
    const trackers = {
      scorches: createScorchTracker(),
      aim: createAimTracker(),
      fire: createFireTracker(),
      feedback: createFeedbackTracker(),
    };
    const draw = (
      nowMs: number,
      renderTick: number,
      creeps: readonly CreepVM[],
      over: Partial<RenderOverlay> = {},
      sparks: LiveSpark[] = [],
    ): void =>
      fedFrame(t, {
        prevVm: { ...vm([], creeps), tick: Math.floor(renderTick) },
        curVm: { ...vm([], creeps), tick: Math.floor(renderTick) + 1 },
        alpha: renderTick - Math.floor(renderTick),
        overlay: { ...OVERLAY, ...over },
        projection: PROJECTION,
        frames: framesFor(PROJECTION),
        exit: EXIT,
        nowMs,
        sparks,
        ...trackers,
      });
    return { t, draw };
  }

  const KILL: KillVM = {
    id: 9,
    x: 10 * 256,
    y: 6 * 256,
    creepId: 'fast',
    domain: 'ground',
    boss: false,
    bounty: 4,
  };

  it('a shot reaching a creep still drawn flashes it: its look’s silhouette in the flashes layer, over its body, fading on the wall clock', () => {
    const { t, draw } = feed();
    const target = creep({ creepId: 'swarm' });
    // From no tower: the shot's look does not matter here, only where and when it lands.
    const arriving: TracerVM = {
      kind: 'targeted',
      originX: 2 * 256,
      originY: 2 * 256,
      targetId: 7,
      launchTick: 10,
      impactTick: 11,
    };
    draw(1000, 10.5, [target], { tracers: [arriving] });
    expect(t.flashes.syncs.at(-1)).toEqual([]); // in flight
    draw(1025, 11, [target], { tracers: [arriving] }); // lands
    const [flash] = t.flashes.syncs.at(-1)!;
    expect(flash!.frame).toBe(creepFrameKeys('swarm', false, false).flash);
    expect(flash!.alpha).toBe(HIT_FLASH_ALPHA);
    draw(1025 + HIT_FLASH_MS / 2, 11.5, [target]);
    expect(t.flashes.syncs.at(-1)![0]!.alpha).toBeCloseTo(HIT_FLASH_ALPHA / 2, 12);
    draw(1025 + HIT_FLASH_MS, 12, [target]);
    expect(t.flashes.syncs.at(-1)).toEqual([]); // over
  });

  it('a kill bursts in the cues — after the sparks — about its body’s centre, and pops its bounty in the pops layer', () => {
    const { t, draw } = feed();
    draw(500, 10, [], { kills: [KILL] }, [{ x: 3 * 256, y: 3 * 256, radiusFp: 0, k: 1 }]);
    const cues = t.layers.cues.calls.filter((c) => c.method !== 'clear');
    const spark = cues.findIndex((c) => c.method === 'fillCircle');
    const at = creepBodyCentre(KILL.x, KILL.y, KILL, PROJECTION, framesFor(PROJECTION));
    const u = fxUnit(PROJECTION.cellPx) * 0.95; // the fast family's size step
    // The ring, white, then the seven shards in the family's hue — all after the spark.
    const ring = cues.findIndex((c) => c.method === 'strokeCircle');
    expect(ring).toBeGreaterThan(spark);
    expect(cues[ring - 1]).toEqual({
      method: 'lineStyle',
      args: [KILL_BURST.ring.width * u, ART_HIT_FLASH, KILL_BURST.ring.alpha],
    });
    expect(cues[ring]!.args).toEqual([at.x, at.y, KILL_BURST.ring.r * u]);
    const shards = cues.filter((c) => c.method === 'lineBetween');
    expect(shards).toHaveLength(KILL_BURST.shards.count);
    expect(
      cues.filter((c) => c.method === 'lineStyle' && c.args[1] === creepColour(PAL, 'fast')),
    ).toHaveLength(KILL_BURST.shards.count);
    // The pop: the gem, a plus and the bounty, over everything.
    expect(t.pops.syncs.at(-1)!.map((p) => p.frame)).toEqual([
      GEM_FRAME_KEY,
      glyphFrameKey('+'),
      glyphFrameKey('4'),
    ]);
  });

  it('plays a kill out on the wall clock, whatever the frames after it carry: the burst first, then the pop', () => {
    const { t, draw } = feed();
    draw(500, 10, [], { kills: [KILL] });
    draw(500 + KILL_BURST_MS, 10, []); // paused: render time holds, the clock does not
    const cues = t.layers.cues.calls;
    expect(cues.slice(cues.map((c) => c.method).lastIndexOf('clear') + 1)).toEqual([]);
    expect(t.pops.syncs.at(-1)).toHaveLength(3);
    draw(500 + BOUNTY_POP_MS, 10, []);
    expect(t.pops.syncs.at(-1)).toEqual([]);
  });

  it('a leak pulses the exit: the frame’s two rings in the lives colour, about the exit cell’s centre', () => {
    const { t, draw } = feed();
    draw(0, 10, [], { leaks: 1 });
    const exit = PROJECTION.cellToPixel(EXIT.col, EXIT.row);
    const half = PROJECTION.cellPx / 2;
    const u = fxUnit(PROJECTION.cellPx);
    expect(t.layers.cues.calls.filter((c) => c.method !== 'clear')).toEqual(
      LEAK_RINGS.flatMap((r) => [
        { method: 'lineStyle', args: [r.width * u, ART_LIVES, r.alpha] },
        { method: 'strokeCircle', args: [exit.x + half, exit.y + half, r.r * u] },
      ]),
    );
  });

  it('under Reduce motion a kill’s burst is its ring alone, and the exit’s pulse holds its rings’ size', () => {
    const { t, draw } = feed();
    draw(0, 10, [], { kills: [KILL], leaks: 1, reducedMotion: true });
    draw(100, 10, [], { reducedMotion: true });
    const cues = t.layers.cues.calls.slice(
      t.layers.cues.calls.map((c) => c.method).lastIndexOf('clear'),
    );
    expect(cues.some((c) => c.method === 'lineBetween')).toBe(false); // no shard flies
    const u = fxUnit(PROJECTION.cellPx);
    expect(cues.filter((c) => c.method === 'strokeCircle').map((c) => c.args[2])).toEqual([
      KILL_BURST.ring.r * (u * 0.95), // the ring, at its own size (the fast family's step)
      ...LEAK_RINGS.map((r) => r.r * u), // the exit's rings, at theirs
    ]);
    expect(t.pops.syncs.at(-1)).toHaveLength(3); // the pop still shows, fading in place
  });

  it('draws a flyer’s spark on its lifted body — where a flyer at that point is drawn — and every other spark at its point', () => {
    const { t, draw } = feed();
    const flyer = creep({ id: 3, creepId: 'flying', domain: 'air' });
    draw(0, 10, [flyer], {}, [
      { x: flyer.x, y: flyer.y, radiusFp: 0, k: 1, flyer: { creepId: 'flying', boss: false } },
      { x: flyer.x, y: flyer.y, radiusFp: 0, k: 1 },
    ]);
    const body = t.creeps.syncs.at(-1)![0] as CreepPlacement;
    const dots = t.layers.cues.calls.filter((c) => c.method === 'fillCircle');
    expect(dots.map((c) => c.args.slice(0, 2))).toEqual([
      [body.cx, body.cy],
      [PROJECTION.fpToPixel(flyer.x, flyer.y).x, PROJECTION.fpToPixel(flyer.x, flyer.y).y],
    ]);
  });
});

describe('drawShots / drawFeedbackStrokes — thin executors of their plans', () => {
  it('drawShots strokes a solid line through its points, a dashed one as every other segment, then fills each dot', () => {
    const g = recordingLayer();
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 0 },
      { x: 3, y: 1 },
      { x: 4, y: 0 },
    ];
    drawShots(g, {
      strokes: [
        { points: pts, dashed: false, width: 2, colour: 0x123456, alpha: 0.5 },
        { points: pts, dashed: true, width: 1, colour: 0x654321, alpha: 1 },
      ],
      dots: [{ x: 9, y: 8, r: 2, colour: 0xabcdef }],
    });
    expect(g.calls).toEqual([
      { method: 'lineStyle', args: [2, 0x123456, 0.5] },
      { method: 'strokePoints', args: [pts, false, false] },
      { method: 'lineStyle', args: [1, 0x654321, 1] },
      { method: 'lineBetween', args: [0, 0, 1, 1] },
      { method: 'lineBetween', args: [2, 0, 3, 1] },
      { method: 'fillStyle', args: [0xabcdef, 1] },
      { method: 'fillCircle', args: [9, 8, 2] },
    ]);
  });

  it('drawFeedbackStrokes strokes a ring as a circle and a shard as a line, each in its own style', () => {
    const g = recordingLayer();
    drawFeedbackStrokes(g, [
      { kind: 'ring', x: 1, y: 2, r: 3, width: 1.5, colour: 0x111111, alpha: 0.6 },
      { kind: 'shard', x1: 4, y1: 5, x2: 6, y2: 7, width: 2, colour: 0x222222, alpha: 1 },
    ]);
    expect(g.calls).toEqual([
      { method: 'lineStyle', args: [1.5, 0x111111, 0.6] },
      { method: 'strokeCircle', args: [1, 2, 3] },
      { method: 'lineStyle', args: [2, 0x222222, 1] },
      { method: 'lineBetween', args: [4, 5, 6, 7] },
    ]);
  });
});

describe('drawBoardFrame — a shot converges on where its creep is DRAWN', () => {
  // The busy frame's shot leaves from a point no tower stands on, so it is drawn as the dot a
  // shot of an unknown tower keeps (C2): a point to read the shot's position off.
  it('an arrived shot sits on its target creep’s snapped centre at a fractional dpr', () => {
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
      // To float precision: the shot's point is where the body is drawn, taken through the
      // projection and back (`creepAimPoints`).
      expect(dot.args[0]).toBeCloseTo(placed.cx, 9);
      expect(dot.args[1]).toBeCloseTo(placed.cy, 9);
      // The creep's true point is between device pixels here, so the snap is doing the work.
      const raw = projection.fpToPixel(c.x, c.y);
      expect([raw.x, raw.y]).not.toEqual([placed.cx, placed.cy]);
    }
  });

  it('at a flyer, it arrives at the flyer’s DRAWN body — lifted above where its shadow lies (C2)', () => {
    // Visual pass C2 (#181) decided what R4 left pinned as "recorded, not endorsed": a shot at a
    // flyer meets the body the player sees, not the sim's point under it, where its shadow is.
    const frame = busyFrame();
    const c = creep({ domain: 'air' });
    const { t } = targets();
    drawBoardFrame(t, { ...frame, curVm: vm([], [c]) });
    const body = t.creeps.syncs[0]![0] as CreepPlacement;
    const dot = t.layers.effects.calls.find((call) => call.method === 'fillCircle')!;
    expect(dot.args[0]).toBeCloseTo(body.cx, 9);
    expect(dot.args[1]).toBeCloseTo(body.cy, 9);
    const [shadow] = t.creepShadows.syncs[0]!;
    const shadowAnchor = frame.frames.get(shadow!.frame)!;
    expect(body.cy).toBeLessThan(shadow!.y + shadowAnchor.anchorY); // lifted: the shadow below
  });
});

/** One frame as the scene draws it: the scorch tracker is fed first (`scene.ts`'s `draw()`),
 *  then `drawBoardFrame` reads the scorches still fading — and feeds the aim and fire trackers
 *  itself. */
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
    const aim = createAimTracker();
    const fire = createFireTracker();
    const feedback = createFeedbackTracker();
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
      exit: EXIT,
      nowMs: 0,
      sparks: [],
      feedback,
      scorches,
      aim,
      fire,
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
    const aim = createAimTracker();
    const fire = createFireTracker();
    const feedback = createFeedbackTracker();
    const mine = tower(3, 'mine', 6); // footprint centre: the corner of cells (7, 3)
    const frame = (tick: number, towers: readonly TowerVM[], overlay: RenderOverlay) =>
      ({
        prevVm: { ...vm(towers, []), tick },
        curVm: { ...vm(towers, []), tick: tick + 1 },
        alpha: 0,
        overlay,
        projection: PROJECTION,
        frames: framesFor(PROJECTION),
        exit: EXIT,
        nowMs: 0,
        sparks: [],
        scorches,
        aim,
        fire,
        feedback,
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
    const aim = createAimTracker();
    const fire = createFireTracker();
    const feedback = createFeedbackTracker();
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
        exit: EXIT,
        nowMs: 0,
        sparks: [],
        scorches,
        aim,
        fire,
        feedback,
      }) satisfies BoardFrameInput;
    fedFrame(t, frame(21, [blast]));
    expect(t.scorches.syncs[0]).toHaveLength(1); // held
    resetBoardFrame(t, { scorches, aim, fire, feedback });
    fedFrame(t, frame(22, []));
    expect(t.scorches.syncs[1]).toEqual([]);
    expect(scorches.live(22)).toEqual([]);
  });
});

describe('drawBoardFrame — towers that aim and fire (visual pass T3)', () => {
  // A tower anchored at (4, 2): its footprint centre is the corner of cells (5, 3).
  const CX = 5 * 256;
  const CY = 3 * 256;
  const corner = PROJECTION.cellToPixel(4, 2);
  const unit = artUnit(PROJECTION.cellPx);

  /** Frames drawn on one set of trackers, as the scene draws them. */
  function run() {
    const { t } = targets();
    const trackers = {
      scorches: createScorchTracker(),
      aim: createAimTracker(),
      fire: createFireTracker(),
      feedback: createFeedbackTracker(),
    };
    /** A frame drawn at render tick `prevTick + alpha`: each creep moves from `prev` to
     *  `cur`, and the overlay carries `over`. */
    const draw = (
      prevTick: number,
      alpha: number,
      towers: readonly TowerVM[],
      creeps: { prev: readonly CreepVM[]; cur: readonly CreepVM[] },
      over: Partial<RenderOverlay> = {},
    ): void =>
      fedFrame(t, {
        prevVm: { ...vm(towers, creeps.prev), tick: prevTick },
        curVm: { ...vm(towers, creeps.cur), tick: prevTick + 1 },
        alpha,
        overlay: { ...OVERLAY, ...over },
        projection: PROJECTION,
        frames: framesFor(PROJECTION),
        exit: EXIT,
        nowMs: 0,
        sparks: [],
        ...trackers,
      });
    return { t, draw, trackers };
  }

  /** The tracer of a shot `t` fired at `launchTick`, at creep 7. */
  const shotFrom = (t: TowerVM, launchTick: number): TracerVM => ({
    kind: 'targeted',
    originX: (t.col + 1) * 256,
    originY: (t.row + 1) * 256,
    targetId: 7,
    launchTick,
    impactTick: launchTick + 4,
  });

  /** Where an unposed head of `t` is placed: the picture before towers aimed. */
  const atRest = (t: TowerVM): SpritePlacement =>
    placeTowers(vm([t], []), OVERLAY, PROJECTION, framesFor(PROJECTION)).heads[0]!;

  /** The calls a layer recorded in its LAST frame — after its last clear. */
  const lastFrame = (layer: { calls: Call[] }): { calls: Call[] } => ({
    calls: layer.calls.slice(layer.calls.map((c) => c.method).lastIndexOf('clear')),
  });

  /** The circle a flash's or a ring's polygon (`circle-polygon.ts`) was drawn for: the centre
   *  its corners balance on, and their distance from it — the same for every corner. */
  const circleOf = (call: Call): { x: number; y: number; r: number } => {
    const pts = call.args[0] as { x: number; y: number }[];
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const r = Math.hypot(pts[0]!.x - x, pts[0]!.y - y);
    for (const p of pts) expect(Math.hypot(p.x - x, p.y - y)).toBeCloseTo(r, 9);
    return { x, y, r };
  };

  it('turns an aiming head toward where its target is DRAWN this frame — the interpolated point', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    // The creep moves from 2 cells right of the centre to 2 right and 2 down; at alpha 0.5
    // it is drawn 2 right and 1 down — neither end of its step.
    const creeps = {
      prev: [creep({ x: CX + 512, y: CY })],
      cur: [creep({ x: CX + 512, y: CY + 512 })],
    };
    for (let tick = 10; tick <= 30; tick++) draw(tick, 0.5, [basic], creeps);
    const head = t.heads.syncs.at(-1)![0]!;
    const drawnAt = aimAngle(CX, CY, CX + 512, CY + 256)!;
    expect(head.rotation).toBeCloseTo(drawnAt, 9);
    expect(drawnAt).not.toBeCloseTo(aimAngle(CX, CY, CX + 512, CY + 512)!, 2); // not cur's
    expect(drawnAt).not.toBeCloseTo(aimAngle(CX, CY, CX + 512, CY)!, 2); // not prev's
    // Turned about its footprint centre: on the snapped corner plus a cell, by its pivot.
    const spec = framesFor(PROJECTION).get(head.frame)!;
    expect([head.x, head.y]).toEqual([corner.x + PROJECTION.cellPx, corner.y + PROJECTION.cellPx]);
    expect([head.originX, head.originY]).toEqual([spec.pivotX, spec.pivotY]);
    // ... while the plate under it never moves.
    expect(t.plates.syncs.at(-1)).toEqual(t.plates.syncs[0]);
  });

  it('at a flyer, turns toward its DRAWN body — lifted above where its shadow lies — as its shots land there (C2)', () => {
    // Visual pass C2 (#181) decided what R4 left pinned as "recorded, not endorsed": a head
    // faces the body the player sees, and its shots land on it, not on the sim's point under it.
    const { t, draw } = run();
    const antiair = tower(2, 'antiair', 4, { targetId: 7 });
    // Two cells right of the footprint centre, level with it: just short of a quarter turn,
    // since the body is drawn its lift above that point.
    const right = [creep({ creepId: 'flying', domain: 'air', x: CX + 512, y: CY })];
    const arrived = { ...shotFrom(antiair, 0), impactTick: 4 };
    for (let tick = 10; tick <= 20; tick++) {
      draw(tick, 0, [antiair], { prev: right, cur: right }, { tracers: [arrived] });
    }
    const head = t.heads.syncs.at(-1)![0]!;
    const centre = { x: corner.x + PROJECTION.cellPx, y: corner.y + PROJECTION.cellPx };
    const body = t.creeps.syncs.at(-1)![0] as CreepPlacement;
    expect(head.rotation).toBeCloseTo(aimAngle(centre.x, centre.y, body.cx, body.cy)!, 9);
    // The shot, Anti-air's streak, has arrived on the body's centre.
    const [streak] = t.shots.syncs.at(-1)!;
    expect(streak!.frame).toBe(shotFrameKeys('antiair').tracer);
    expect(streak!.x).toBeCloseTo(body.cx, 9);
    expect(streak!.y).toBeCloseTo(body.cy, 9);
    // The sim's point, where the shadow lies, is its lift below: the head does not face it.
    const [shadow] = t.creepShadows.syncs.at(-1)!;
    const shadowAnchor = framesFor(PROJECTION).get(shadow!.frame)!;
    const truePoint = { x: shadow!.x + shadowAnchor.anchorX, y: shadow!.y + shadowAnchor.anchorY };
    expect(body.cy).toBeLessThan(truePoint.y);
    expect(head.rotation).not.toBeCloseTo(
      aimAngle(centre.x, centre.y, truePoint.x, truePoint.y)!,
      2,
    );
  });

  it('between ticks, a creep is PLACED where its head aims and its shot lands — one interpolated point, a flyer’s lifted', () => {
    for (const domain of ['ground', 'air'] as const) {
      const { t, draw } = run();
      const basic = tower(2, domain === 'air' ? 'antiair' : 'basic', 4, { targetId: 7 });
      const creepId = domain === 'air' ? 'flying' : 'normal';
      const creeps = {
        prev: [creep({ creepId, domain, x: CX + 512, y: CY })],
        cur: [creep({ creepId, domain, x: CX + 512, y: CY + 512 })],
      };
      const arrived = { ...shotFrom(basic, 0), impactTick: 4 };
      for (let tick = 10; tick <= 30; tick++)
        draw(tick, 0.5, [basic], creeps, { tracers: [arrived] });
      // The shadow lies on the interpolated point, snapped — neither end of the creep's step.
      const mid = PROJECTION.fpToPixel(CX + 512, CY + 256);
      const at = [snapToDevicePx(mid.x, PROJECTION.dpr), snapToDevicePx(mid.y, PROJECTION.dpr)];
      const [shadow] = t.creepShadows.syncs.at(-1)!;
      const sa = framesFor(PROJECTION).get(shadow!.frame)!;
      expect([shadow!.x + sa.anchorX, shadow!.y + sa.anchorY]).toEqual(at);
      // The body is centred there — a flyer's lifted straight up from it.
      const body = t.creeps.syncs.at(-1)![0] as CreepPlacement;
      expect(body.cx).toBe(at[0]);
      if (domain === 'ground') expect(body.cy).toBe(at[1]);
      else expect(body.cy).toBeLessThan(at[1]!);
      // Its shot lands on the body's centre, and its head faces it.
      const [shot] = t.shots.syncs.at(-1)!;
      expect(shot!.x, domain).toBeCloseTo(body.cx, 9);
      expect(shot!.y, domain).toBeCloseTo(body.cy, 9);
      const centre = { x: corner.x + PROJECTION.cellPx, y: corner.y + PROJECTION.cellPx };
      expect(t.heads.syncs.at(-1)![0]!.rotation, domain).toBeCloseTo(
        aimAngle(centre.x, centre.y, body.cx, body.cy)!,
        9,
      );
    }
  });

  it('sweeps rather than snaps: the first frames turn it a bounded step at a time', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    const below = [creep({ x: CX, y: CY + 512 })]; // straight down: a half turn
    draw(10, 0, [basic], { prev: below, cur: below });
    expect(t.heads.syncs[0]![0]).toEqual(atRest(basic)); // a new tower points up
    draw(11, 0, [basic], { prev: below, cur: below });
    expect(t.heads.syncs[1]![0]!.rotation).toBeCloseTo(AIM_TURN_PER_TICK, 12);
  });

  it('paints the plate rim again over a head it turns or knocks back — never over one at rest, or one that does not aim', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    const slow = tower(3, 'slow', 10, { targetId: 7 });
    const below = [creep({ x: CX, y: CY + 512 })];
    const above = [creep({ x: CX, y: CY - 600 })];
    // A new tower points up: nothing painted over it.
    draw(10, 0, [basic, slow], { prev: below, cur: below });
    expect(t.rims.syncs[0]).toEqual([]);
    // Turning toward the creep below: the rim's runs over the basic's head, on its plate's
    // corner — and still none over the slow tower's, which never turns.
    draw(11, 0, [basic, slow], { prev: below, cur: below });
    const plate = t.plates.syncs[1]![0]!;
    expect(t.rims.syncs[1]).toEqual([{ frame: RIM_RUNS_FRAME_KEY, x: plate.x, y: plate.y }]);
    // Knocked back while unturned, a shot at a creep straight up: painted again too.
    const { t: t2, draw: draw2 } = run();
    draw2(10, 0, [basic], { prev: above, cur: above });
    draw2(11, 0, [basic], { prev: above, cur: above }, { tracers: [shotFrom(basic, 11)] });
    expect(t2.heads.syncs[1]![0]!.rotation).toBeUndefined();
    expect(t2.rims.syncs.map((s) => s.length)).toEqual([0, 1]);
    // Under Reduce motion every head is at rest: nothing painted over any.
    draw(12, 0, [basic, slow], { prev: below, cur: below }, { reducedMotion: true });
    expect(t.rims.syncs[2]).toEqual([]);
  });

  it('a shot: the aiming head recoils and flashes at its muzzle — in effects after the selection, under its bolt in the shots layer', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    const above = [creep({ x: CX, y: CY - 600 })]; // straight up: the head stays unturned
    const selection = { col: 4, row: 2, rangeFp: 1024, blastRadiusFp: null, towerId: 'basic' };
    draw(10, 0, [basic], { prev: above, cur: above }, { selection });
    expect(drawn(lastFrame(t.layers.effects))).toEqual([`strokeCircle ${hex(PAL.range)}`]);
    expect(t.shots.syncs.at(-1)).toEqual([]);
    draw(
      11,
      0,
      [basic],
      { prev: above, cur: above },
      { selection, tracers: [shotFrom(basic, 11)] },
    );
    expect(drawn(lastFrame(t.layers.effects))).toEqual([
      `strokeCircle ${hex(PAL.range)}`, // the selection
      `fillPoints ${hex(ART_FLASH)}`, // the muzzle flash, a polygon
    ]);
    // The shot itself is Basic's bolt (C2), a sprite in the shots layer — over the effects, so
    // over the flash — leaving the footprint centre, headed straight up at its creep.
    const [bolt] = t.shots.syncs.at(-1)!;
    expect(bolt!.frame).toBe(shotFrameKeys('basic').tracer);
    expect(bolt!.x).toBeCloseTo(corner.x + PROJECTION.cellPx, 9);
    expect(bolt!.y).toBeCloseTo(corner.y + PROJECTION.cellPx, 9);
    expect(bolt!.rotation).toBeCloseTo(-Math.PI / 2, 12);
    const flash = circleOf(
      lastFrame(t.layers.effects).calls.find((c) => c.method === 'fillPoints')!,
    );
    expect(flash.x).toBeCloseTo(corner.x + PROJECTION.cellPx, 9);
    expect(flash.y).toBeCloseTo(corner.y + PROJECTION.cellPx - MUZZLE_FLASH.reach * unit, 9);
    expect(flash.r).toBeCloseTo(MUZZLE_FLASH.r * unit, 9);
    expect(lastFrame(t.layers.effects).calls.find((c) => c.method === 'fillStyle')!.args).toEqual([
      ART_FLASH,
      MUZZLE_FLASH.alpha,
    ]);
    // Knocked straight down — it faces up — by its whole recoil, still unturned and crisp.
    const head = t.heads.syncs[1]![0]!;
    const rest = atRest(basic);
    expect(head.x).toBe(rest.x);
    expect(head.y).toBeCloseTo(rest.y + snapToDevicePx(RECOIL_DEPTH * unit, 1), 9);
    expect(head.rotation).toBeUndefined();
    // It settles: once the recoil is over, the head is back where it was, the flash is gone, and
    // the bolt flies on.
    draw(15, 0, [basic], { prev: above, cur: above }, { tracers: [shotFrom(basic, 11)] });
    expect(t.heads.syncs[2]![0]).toEqual(rest);
    expect(drawn(lastFrame(t.layers.effects))).toEqual([]);
    expect(t.shots.syncs.at(-1)!.map((s) => s.frame)).toEqual([shotFrameKeys('basic').tracer]);
  });

  it('a tower that does not aim pulses two rings in its role colour, under its shot — and its head never moves', () => {
    const { t, draw } = run();
    const slow = tower(2, 'slow', 4, { targetId: 7 });
    const right = [creep({ x: CX + 600, y: CY })];
    draw(10, 0, [slow], { prev: right, cur: right });
    draw(11, 0, [slow], { prev: right, cur: right }, { tracers: [shotFrom(slow, 11)] });
    expect(drawn(lastFrame(t.layers.effects))).toEqual([
      `strokePoints ${hex(PAL.roleControl)}`, // the two rings, polygons
      `strokePoints ${hex(PAL.roleControl)}`,
    ]);
    // The shot is Slow's ice shard (C2), in the shots layer over the rings, headed right.
    const [shard] = t.shots.syncs.at(-1)!;
    expect(shard!.frame).toBe(shotFrameKeys('slow').tracer);
    expect(shard!.rotation).toBeCloseTo(0, 12);
    // Both about the footprint centre — the snapped corner plus a cell — at their radii.
    const rings = lastFrame(t.layers.effects)
      .calls.filter((c) => c.method === 'strokePoints')
      .map(circleOf);
    for (const ring of rings) {
      expect(ring.x).toBeCloseTo(corner.x + PROJECTION.cellPx, 9);
      expect(ring.y).toBeCloseTo(corner.y + PROJECTION.cellPx, 9);
    }
    expect(rings.map((ring) => ring.r)).toEqual(
      FIRE_PULSE_RINGS.map((ring) => expect.closeTo(ring.r * unit, 9)),
    );
    expect(
      lastFrame(t.layers.effects)
        .calls.filter((c) => c.method === 'lineStyle')
        .map((c) => c.args),
    ).toEqual(
      FIRE_PULSE_RINGS.map((ring) => [Math.max(1, ring.width * unit), PAL.roleControl, ring.alpha]),
    );
    expect(t.heads.syncs.map((s) => s[0])).toEqual([atRest(slow), atRest(slow)]);
  });

  it('under Reduce motion every head stays as drawn — no turn, no recoil — and no flash or pulse is drawn', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    const slow = tower(3, 'slow', 8, { targetId: 7 });
    const right = [creep({ x: CX + 600, y: CY })];
    const tracers = [shotFrom(basic, 12), shotFrom(slow, 12)];
    for (let tick = 10; tick <= 20; tick++) {
      draw(
        tick,
        0.5,
        [basic, slow],
        { prev: right, cur: right },
        {
          reducedMotion: true,
          tracers: tick >= 12 ? tracers : [],
        },
      );
    }
    for (const heads of t.heads.syncs) expect(heads).toEqual([atRest(basic), atRest(slow)]);
    expect(t.layers.effects.calls.filter((c) => c.method !== 'clear')).toEqual([]);
    for (const shots of t.shots.syncs) expect(shots).toEqual([]); // nor any shot (C2)
  });

  it('shows no shot for a tower whose sell is pending — it is drawn as already gone', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    const above = [creep({ x: CX, y: CY - 600 })];
    draw(
      11,
      0,
      [basic],
      { prev: above, cur: above },
      {
        tracers: [shotFrom(basic, 11)],
        pendingSells: [{ col: 4, row: 2 }],
      },
    );
    expect(t.heads.syncs[0]).toEqual([]);
    // No flash — its shot only, still in its tower's style: the tower stands until its sell
    // commits.
    expect(drawn(lastFrame(t.layers.effects))).toEqual([]);
    expect(t.shots.syncs[0]!.map((s) => s.frame)).toEqual([shotFrameKeys('basic').tracer]);
  });

  it('holds still while render time does: a paused frame draws the same head and the same flash', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    const right = [creep({ x: CX + 600, y: CY })];
    draw(10, 0, [basic], { prev: right, cur: right });
    draw(11, 0.25, [basic], { prev: right, cur: right }, { tracers: [shotFrom(basic, 11)] });
    const before = { head: t.heads.syncs[1]![0], effects: lastFrame(t.layers.effects).calls };
    expect(drawn({ calls: before.effects })).toContain(`fillPoints ${hex(ART_FLASH)}`);
    for (let i = 0; i < 5; i++) {
      draw(11, 0.25, [basic], { prev: right, cur: right }, { tracers: [shotFrom(basic, 11)] });
    }
    expect(t.heads.syncs.at(-1)![0]).toEqual(before.head);
    expect(lastFrame(t.layers.effects).calls).toEqual(before.effects);
  });

  it('a pause that catches a shot part-way holds its flash and recoil there', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    const right = [creep({ x: CX + 600, y: CY })];
    const shot = { tracers: [shotFrom(basic, 11)] };
    draw(10, 0, [basic], { prev: right, cur: right });
    draw(11, 0, [basic], { prev: right, cur: right }, shot); // first seen
    draw(11, 0.25, [basic], { prev: right, cur: right }, shot); // a quarter tick on
    const before = { head: t.heads.syncs.at(-1)![0], effects: lastFrame(t.layers.effects).calls };
    expect(drawn({ calls: before.effects })).toContain(`fillPoints ${hex(ART_FLASH)}`);
    for (let i = 0; i < 5; i++) draw(11, 0.25, [basic], { prev: right, cur: right }, shot); // paused
    expect(t.heads.syncs.at(-1)![0]).toEqual(before.head);
    expect(lastFrame(t.layers.effects).calls).toEqual(before.effects);
  });

  it('a shot taken in under Reduce motion shows nothing when it is released: no stale flash or recoil', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    const right = [creep({ x: CX + 600, y: CY })];
    const shot = { tracers: [shotFrom(basic, 11)] };
    draw(10, 0, [basic], { prev: right, cur: right });
    draw(11, 0, [basic], { prev: right, cur: right }, { ...shot, reducedMotion: true });
    draw(11, 0.5, [basic], { prev: right, cur: right }, shot); // released inside the feedback
    expect(drawn(lastFrame(t.layers.effects))).toEqual([]); // no flash...
    // ... and its shot, taken in under Reduce motion, is drawn as its tower's once released.
    expect(t.shots.syncs.at(-1)!.map((s) => s.frame)).toEqual([shotFrameKeys('basic').tracer]);
    // The head sweeps from facing up, half a tick's turn, with no knock-back.
    const head = t.heads.syncs.at(-1)![0]!;
    expect(head.rotation).toBeCloseTo(AIM_TURN_PER_TICK / 2, 12);
    expect([head.x, head.y]).toEqual([corner.x + PROJECTION.cellPx, corner.y + PROJECTION.cellPx]);
  });

  it('an aiming head’s shot at a creep no longer drawn shows nothing, though another creep still is — the frame hands the fire tracker where creeps are drawn', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    const target = creep({ x: CX - 600, y: CY }); // creep 7, the shot's
    const other = creep({ id: 8, x: CX + 600, y: CY }); // still drawn
    draw(10, 0, [basic], { prev: [target, other], cur: [target, other] });
    // Creep 7 is gone by the frame its shot is first seen (one that caught up on two ticks).
    draw(
      11,
      0,
      [basic],
      { prev: [target, other], cur: [other] },
      { tracers: [shotFrom(basic, 10)] },
    );
    expect(drawn(lastFrame(t.layers.effects))).toEqual([]); // no flash, and no tracer to draw
    expect(t.heads.syncs.at(-1)![0]).toEqual(atRest(basic)); // no recoil, no turn
  });

  it('a shot turns its head onto the shot’s bearing on the frame it is seen: barrel, flash, recoil and tracer agree', () => {
    const { t, draw } = run();
    const left = [creep({ x: CX - 600, y: CY })]; // straight left of the footprint centre
    // No lock yet: the head faces up, as drawn.
    draw(10, 0, [tower(2, 'basic', 4)], { prev: left, cur: left });
    expect(t.heads.syncs[0]![0]).toEqual(atRest(tower(2, 'basic', 4)));
    // The sim fires on the tick a tower locks on. The head is turned onto the shot's
    // bearing at once — not the one bounded step tracking alone would give it.
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    draw(11, 0, [basic], { prev: left, cur: left }, { tracers: [shotFrom(basic, 11)] });
    const bearing = aimAngle(CX, CY, CX - 600, CY)!;
    expect(bearing).toBeCloseTo(-Math.PI / 2, 12);
    expect(Math.abs(bearing)).toBeGreaterThan(AIM_TURN_PER_TICK); // a step falls short of it
    const head = t.heads.syncs[1]![0]!;
    expect(head.rotation).toBeCloseTo(bearing, 12);
    // The flash sits along it, `reach` straight left of the footprint centre ...
    const flash = circleOf(
      lastFrame(t.layers.effects).calls.find((c) => c.method === 'fillPoints')!,
    );
    expect(flash.x).toBeCloseTo(corner.x + PROJECTION.cellPx - MUZZLE_FLASH.reach * unit, 9);
    expect(flash.y).toBeCloseTo(corner.y + PROJECTION.cellPx, 9);
    // ... and the head is knocked back along it, to the right.
    const back = snapToDevicePx(RECOIL_DEPTH * unit, PROJECTION.dpr);
    expect(head.x).toBeCloseTo(corner.x + PROJECTION.cellPx + back, 9);
    expect(head.y).toBeCloseTo(corner.y + PROJECTION.cellPx, 9);
    // Then tracking resumes at the bounded rate: its target is below now, and the head turns
    // one tick's step toward it, the shorter way.
    const below = [creep({ x: CX, y: CY + 600 })];
    draw(12, 0, [basic], { prev: below, cur: below }, { tracers: [shotFrom(basic, 11)] });
    expect(t.heads.syncs[2]![0]!.rotation).toBeCloseTo(bearing - AIM_TURN_PER_TICK, 12);
  });

  it('draws each planned op as planned: a flash at its alpha and radius, a ring at its width, alpha and radius — each a polygon with the sides the board’s one rule gives it at the dpr', () => {
    for (const dpr of [1, 2]) {
      const g = recordingLayer();
      drawFireFeedback(
        g,
        [
          { kind: 'flash', x: 10, y: 20, r: 4.5, colour: ART_FLASH, alpha: 0.5 },
          { kind: 'ring', x: 30, y: 40, r: 24, width: 2.6, colour: PAL.roleControl, alpha: 0.25 },
        ],
        dpr,
      );
      expect(g.calls).toEqual([
        { method: 'fillStyle', args: [ART_FLASH, 0.5] },
        { method: 'fillPoints', args: [circlePoints(10, 20, 4.5, dpr), true] },
        { method: 'lineStyle', args: [2.6, PAL.roleControl, 0.25] },
        { method: 'strokePoints', args: [circlePoints(30, 40, 24, dpr), false, true] },
      ]);
      // The polygons are the ops' circles: centred where planned, at the radius planned, with
      // as many sides as every other live circle of their size gets at that dpr.
      const flash = circleOf(g.calls[1]!);
      const ring = circleOf(g.calls[3]!);
      expect([flash.x, flash.y, flash.r].map((v) => +v.toFixed(9))).toEqual([10, 20, 4.5]);
      expect([ring.x, ring.y, ring.r].map((v) => +v.toFixed(9))).toEqual([30, 40, 24]);
      expect((g.calls[1]!.args[0] as unknown[]).length).toBe(circleSegments(4.5, dpr));
      expect((g.calls[3]!.args[0] as unknown[]).length).toBe(circleSegments(24, dpr));
    }
  });

  it('draws a flash or a ring whose radius is not a number without throwing — never an empty polygon, which Phaser cannot draw', () => {
    // Phaser 3.90's `fillPoints` and `strokePoints` begin at the first point: a stand-in that
    // does the same throws on an empty list, as a live layer would, out of the frame.
    const sides: number[] = [];
    const phaserLike = {
      fillStyle: () => undefined,
      lineStyle: () => undefined,
      fillPoints: (pts: readonly { x: number; y: number }[]) => sides.push(pts.length, pts[0]!.x),
      strokePoints: (pts: readonly { x: number; y: number }[]) => sides.push(pts.length, pts[0]!.x),
    };
    expect(() =>
      drawFireFeedback(
        phaserLike,
        [
          { kind: 'flash', x: 10, y: 20, r: NaN, colour: ART_FLASH, alpha: 0.5 },
          { kind: 'ring', x: 30, y: 40, r: NaN, width: 2.6, colour: PAL.roleControl, alpha: 0.25 },
        ],
        1,
      ),
    ).not.toThrow();
    // The smallest polygon, each, though placed nowhere.
    expect(sides).toEqual([CIRCLE_MIN_SEGMENTS, NaN, CIRCLE_MIN_SEGMENTS, NaN]);
  });

  it('a head released from Reduce motion sweeps from facing up — the frame hands the aim tracker Reduce motion', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    const right = [creep({ x: CX + 600, y: CY })];
    for (let tick = 10; tick <= 30; tick++) {
      draw(tick, 0, [basic], { prev: right, cur: right }, { reducedMotion: true });
    }
    for (const heads of t.heads.syncs) expect(heads[0]).toEqual(atRest(basic));
    draw(31, 0, [basic], { prev: right, cur: right });
    expect(t.heads.syncs.at(-1)![0]!.rotation).toBeCloseTo(AIM_TURN_PER_TICK, 12);
  });

  it('turns a head on render time within a tick: half a tick on, half a tick’s turn', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    const below = [creep({ x: CX, y: CY + 512 })];
    draw(10, 0, [basic], { prev: below, cur: below });
    draw(10, 0.5, [basic], { prev: below, cur: below });
    expect(t.heads.syncs[1]![0]!.rotation).toBeCloseTo(AIM_TURN_PER_TICK / 2, 12);
  });

  it('plays a shot on render time within a tick: half a tick on, its flash has faded and shrunk', () => {
    const { t, draw } = run();
    const basic = tower(2, 'basic', 4, { targetId: 7 });
    const above = [creep({ x: CX, y: CY - 600 })];
    const shot = { tracers: [shotFrom(basic, 11)] };
    draw(11, 0, [basic], { prev: above, cur: above }, shot);
    draw(11, 0.5, [basic], { prev: above, cur: above }, shot);
    const calls = lastFrame(t.layers.effects).calls;
    const k = flashAt(0.5);
    expect(calls.find((c) => c.method === 'fillStyle')!.args).toEqual([
      ART_FLASH,
      MUZZLE_FLASH.alpha * k,
    ]);
    expect(circleOf(calls.find((c) => c.method === 'fillPoints')!).r).toBeCloseTo(
      (MUZZLE_FLASH.fadeR + (MUZZLE_FLASH.r - MUZZLE_FLASH.fadeR) * k) * unit,
      9,
    );
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

  it('forEachLayerSprite visits every sprite of all ten sprite layers — what a rebake repoints at its new atlas', () => {
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
        setOrigin: () => undefined,
        setRotation: () => undefined,
      })),
    );
    const names = [
      'scorches',
      'plates',
      'heads',
      'rims',
      'pending',
      'creepShadows',
      'shots',
      'creeps',
      'flashes',
      'pops',
    ] as const;
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
      layers.rims.name,
      layers.pending.name,
      layers.creepShadows.name,
      layers.shots.name,
      layers.creeps.name,
      layers.flashes.name,
      layers.pops.name,
    ]).toEqual([
      'scorches',
      'plates',
      'heads',
      'rims',
      'pending',
      'creepShadows',
      'shots',
      'creeps',
      'flashes',
      'pops',
    ]);
  });

  it('so depths read from those names keep every shell under every plate and head (M2-S8), every scorch under every shell, every creep shadow under every creep, every shot under every creep and every flash over one, and the rest in order', () => {
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
      sprites.rims,
      sprites.pending,
      sprites.creepShadows,
      live.effects.depth,
      sprites.shots,
      sprites.creeps,
      sprites.flashes,
      live.cues.depth,
      sprites.pops,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });
});

// ---- R4 QC (#181): every live layer's circles are polygons ----

describe('createPolygonLiveLayers — every live layer draws its circles as polygons (R4 QC)', () => {
  /** A recording live layer that can also trace paths, as a Phaser `Graphics` can. */
  const pathLayer = (): ReturnType<typeof recordingLayer> & PathGraphics => {
    const g = recordingLayer();
    const record =
      (method: string) =>
      (...args: unknown[]): void => {
        g.calls.push({ method, args });
      };
    return Object.assign(g, {
      beginPath: record('beginPath'),
      moveTo: record('moveTo'),
      lineTo: record('lineTo'),
      closePath: record('closePath'),
      strokePath: record('strokePath'),
      fillPath: record('fillPath'),
    });
  };

  it('wraps the shells, the effects and the cues, at the dpr read at each call — never Phaser’s 100-sided arc', () => {
    let dpr = 1;
    const live = createPolygonLiveLayers(
      (layer) => Object.assign(pathLayer(), { layer }),
      () => dpr,
    );
    for (const name of ['shells', 'effects', 'cues'] as const) {
      const g = live[name];
      expect(g.layer, `${name}: made under its own name, which sets its depth`).toBe(name);
      dpr = 1;
      g.strokeCircle(0, 0, 30);
      dpr = 2;
      g.fillCircle(0, 0, 30);
      const methods = g.calls.map((c) => c.method);
      expect(methods, name).not.toContain('strokeCircle');
      expect(methods, name).not.toContain('fillCircle');
      expect(
        methods.filter((m) => m === 'lineTo'),
        name,
      ).toHaveLength(circleSegments(30, 1) - 1 + circleSegments(30, 2) - 1);
    }
  });
});
