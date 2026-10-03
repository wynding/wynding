// board-frame.test.ts — one frame of the board, drawn into three recording layers and three
// recording sprite layers: what goes into WHICH live layer (the aura shells into `shells` and
// nowhere else — M2-S8's guarantee that no shell stripes a tower body, now held by the layer
// order — the selection and tracers into `effects`, every creep cue, the ghost and the sparks
// into `cues`, in that order), what each sprite layer is shown, where the board image sits,
// that a reset hides everything, and that an arrived tracer lands exactly on its creep.

import { describe, it, expect } from 'vitest';
import {
  drawBoardFrame,
  resetBoardFrame,
  type BoardFrameInput,
  type BoardTargets,
  type LayerGraphics,
} from './board-frame';
import { atlasFrameSpecs } from './art-frames';
import { AURA_SHELL_ALPHA } from './board-draw';
import { resolvePalette } from './palette';
import { createProjection, type Projection } from './projection';
import type { CreepPlacement, FrameAnchor, SpritePlacement } from './placement';
import type { LiveSpark } from './sparks';
import type { CreepVM, RenderOverlay, RenderVM, TowerVM } from './types';

type Call = { method: string; args: unknown[] };

/** A recording live layer: every call in order. */
function recordingLayer(): LayerGraphics & { calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  return {
    calls,
    clear: record('clear'),
    fillStyle: record('fillStyle'),
    lineStyle: record('lineStyle'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillRoundedRect: record('fillRoundedRect'),
    strokeRoundedRect: record('strokeRoundedRect'),
    fillTriangle: record('fillTriangle'),
    fillCircle: record('fillCircle'),
    strokeCircle: record('strokeCircle'),
    fillPoints: record('fillPoints'),
    lineBetween: record('lineBetween'),
  };
}

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
    towers: recordingSprites(),
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
      `fillCircle ${hex(PAL.tower)}`,
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
    expect([t.layers.shells, t.layers.effects, t.layers.cues].map((l) => drawn(l))).toEqual([
      [],
      [],
      [],
    ]);
  });
});

describe('drawBoardFrame — the sprite layers and the board image', () => {
  it('shows each sprite layer its placements: committed towers, queued builds, creeps', () => {
    const { t } = targets();
    drawBoardFrame(t, busyFrame());
    expect(t.towers.syncs.map((s) => s.map((p) => p.frame))).toEqual([
      ['tower:pylon:committed', 'tower:plain:buffed'],
    ]);
    expect(t.pending.syncs.map((s) => s.map((p) => p.frame))).toEqual([['tower:ringed:pending']]);
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

  it('a reset clears every layer and hides the board and every sprite layer; the next frame shows them', () => {
    const { t, board } = targets();
    drawBoardFrame(t, busyFrame());
    resetBoardFrame(t);
    for (const layer of [t.layers.shells, t.layers.effects, t.layers.cues]) {
      expect(layer.calls[layer.calls.length - 1]!.method).toBe('clear');
    }
    expect(board.visible).toEqual([true, false]);
    expect([t.towers.hidden, t.pending.hidden, t.creeps.hidden]).toEqual([1, 1, 1]);
    drawBoardFrame(t, busyFrame());
    expect(board.visible).toEqual([true, false, true]);
    expect(t.creeps.syncs).toHaveLength(2);
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
