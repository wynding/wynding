// bake-runner.test.ts — running a bake against a recording host: what an attempt does and in
// what order, and what a failed one leaves behind. Never an exception. A report first — naming
// the failure, passing its error on, saying what the board shows meanwhile — then every step of
// the attempt undone; a retry only once the backoff is out or the inputs change; and one line
// when the failing streak closes, after which the next streak is reported and counted afresh.

import { describe, it, expect } from 'vitest';
import {
  BAKE_RETRY_FRAMES,
  createBakeRunner,
  type BakeHost,
  type BakedArt,
  type TextureFrameRect,
} from './bake-runner';
import { layoutAtlas, layoutBoard, type BakeInputs } from './bake';
import type { Canvas2DLike } from './canvas-graphics';
import { resolvePalette } from './palette';
import type { ColourMode } from './types';

const GEOMETRY = { cols: 28, rows: 24, entrance: { col: 0, row: 11 }, exit: { col: 27, row: 11 } };
const MAX_TEX = 8192;
const at = (cellPx: number, dpr = 1, mode: ColourMode = 'default'): BakeInputs => ({
  cellPx,
  dpr,
  mode,
});

/** How a report names inputs, what it says the board shows meanwhile, and how it ends. */
const named = (i: BakeInputs): string => `cellPx ${i.cellPx}, dpr ${i.dpr}, colour mode ${i.mode}`;
const BLANK = 'the board is blank until a bake succeeds';
const showing = (i: BakeInputs): string =>
  `the board shows the art baked for ${named(i)} until a bake succeeds`;
const RETRYING =
  'Retrying in about a second, or as soon as the cell size, dpr or colour mode changes.';
const size = (l: { readonly width: number; readonly height: number }): string =>
  `${l.width}×${l.height}`;

/** The start of the CSS colour the canvas adapter writes for `colour`, whatever its alpha. */
const rgbaOf = (colour: number): string =>
  `rgba(${(colour >> 16) & 0xff}, ${(colour >> 8) & 0xff}, ${colour & 0xff},`;

interface FakeCanvas {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  /** Every `fillStyle` its context was given, in order. */
  readonly fills: string[];
  released: boolean;
}

/** A 2D context that keeps the `fillStyle`s it is given and, when `throws` is set, throws it
 *  from its first drawing call. Its `arc` rejects a negative radius as a real context does. */
function fakeContext(fills: string[], throws: Error | null): Canvas2DLike {
  const op =
    (name: string) =>
    (...args: unknown[]) => {
      if (throws !== null) throw throws;
      if (name === 'arc' && (args[2] as number) < 0) throw new RangeError('IndexSizeError');
    };
  let fillStyle: Canvas2DLike['fillStyle'] = '';
  return {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value) {
      fills.push(String(value));
      fillStyle = value;
    },
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    beginPath: op('beginPath'),
    closePath: op('closePath'),
    moveTo: op('moveTo'),
    lineTo: op('lineTo'),
    arc: op('arc'),
    rect: op('rect'),
    fill: op('fill'),
    stroke: op('stroke'),
    fillRect: op('fillRect'),
    save: op('save'),
    restore: op('restore'),
    setTransform: op('setTransform'),
    clip: op('clip'),
  };
}

interface LogLine {
  readonly level: 'warn' | 'error' | 'info';
  readonly message: string;
  readonly error?: unknown;
}

/**
 * A recording host. Each `createCanvas` takes the next entry of `state.canvases` (default 'ok'):
 * 'refuse' returns null, 'throw' hands back a context whose painting throws `paintError`. Each
 * `show` takes the next entry of `state.shows` ('throw' throws `showError`). Host calls and log
 * lines go into one `events` stream, so a report's place against its cleanup is visible.
 */
function fakeHost() {
  const events: string[] = [];
  const canvases: FakeCanvas[] = [];
  const textures = new Map<string, readonly TextureFrameRect[]>();
  const logs: LogLine[] = [];
  const state = {
    canvases: [] as ('ok' | 'refuse' | 'throw')[],
    shows: [] as ('ok' | 'throw')[],
    paintError: new Error('paint failed'),
    showError: new Error('repoint failed'),
    /** What `addTexture`, `removeTexture` or `releaseCanvas` throws for a key or canvas id —
     *  null to succeed. A host may throw anything, not only an `Error`. */
    addThrows: (_key: string): unknown => null,
    removeThrows: (_key: string): Error | null => null,
    releaseThrows: (_id: number): Error | null => null,
    logThrows: false,
  };
  const log =
    (level: LogLine['level']) =>
    (message: string, error?: unknown): void => {
      events.push(`log:${level}`);
      if (state.logThrows) throw new Error('the console is gone');
      logs.push(level === 'error' ? { level, message, error } : { level, message });
    };
  const host: BakeHost<FakeCanvas> = {
    createCanvas(width, height) {
      const step = state.canvases.shift() ?? 'ok';
      if (step === 'refuse') {
        events.push(`refuse ${width}×${height}`);
        return null;
      }
      const canvas: FakeCanvas = {
        id: canvases.length + 1,
        width,
        height,
        fills: [],
        released: false,
      };
      canvases.push(canvas);
      events.push(`canvas#${canvas.id}`);
      return { canvas, ctx: fakeContext(canvas.fills, step === 'throw' ? state.paintError : null) };
    },
    releaseCanvas(canvas) {
      events.push(`release#${canvas.id}`);
      const error = state.releaseThrows(canvas.id);
      if (error !== null) throw error;
      canvas.released = true;
    },
    addTexture(key, _canvas, frames) {
      events.push(`add ${key}`);
      const error = state.addThrows(key);
      if (error !== null) throw error;
      textures.set(key, frames);
    },
    removeTexture(key) {
      events.push(`remove ${key}`);
      const error = state.removeThrows(key);
      if (error !== null) throw error;
      textures.delete(key);
    },
    show(art: BakedArt) {
      events.push(`show ${art.boardKey} ${art.atlasKey}`);
      if ((state.shows.shift() ?? 'ok') === 'throw') throw state.showError;
    },
    log: { warn: log('warn'), error: log('error'), info: log('info') },
  };
  const of = (level: LogLine['level']): LogLine[] => logs.filter((l) => l.level === level);
  return {
    host,
    state,
    events,
    canvases,
    textures,
    logs,
    warns: (): string[] => of('warn').map((l) => l.message),
    errors: (): LogLine[] => of('error'),
    infos: (): string[] => of('info').map((l) => l.message),
  };
}

/** A runner over a fresh recording host. */
function setup() {
  const h = fakeHost();
  return { h, runner: createBakeRunner(GEOMETRY, h.host) };
}

/** `ensure`, asserting that it does not throw. */
function ensureSafely(
  runner: ReturnType<typeof createBakeRunner>,
  inputs: BakeInputs,
): BakedArt | null {
  let art: BakedArt | null = null;
  expect(() => {
    art = runner.ensure(inputs, MAX_TEX);
  }).not.toThrow();
  return art;
}

describe('createBakeRunner — an attempt', () => {
  it('bakes on the first frame at the inputs’ dpr: both canvases, both textures (the atlas with every frame), shown', () => {
    const { h, runner } = setup();
    const art = runner.ensure(at(10, 2), MAX_TEX);
    expect(art).toMatchObject({ boardKey: 'wy-board-1', atlasKey: 'wy-atlas-1' });
    expect(h.events).toEqual([
      'canvas#1',
      'canvas#2',
      'add wy-board-1',
      'add wy-atlas-1',
      'show wy-board-1 wy-atlas-1',
    ]);
    // Sized for dpr 2: the board's texture is twice as wide as the same board's at dpr 1.
    const board = layoutBoard(GEOMETRY, 10, 2, MAX_TEX);
    const atlas = layoutAtlas(10, 2, MAX_TEX);
    expect(board.width).toBe(2 * layoutBoard(GEOMETRY, 10, 1, MAX_TEX).width);
    expect([h.canvases[0]!.width, h.canvases[0]!.height]).toEqual([board.width, board.height]);
    expect([h.canvases[1]!.width, h.canvases[1]!.height]).toEqual([atlas.width, atlas.height]);
    expect(h.textures.get('wy-board-1')).toEqual([]);
    expect(h.textures.get('wy-atlas-1')).toHaveLength(atlas.frames.size);
    expect(h.textures.get('wy-atlas-1')!.find((f) => f.key === 'tower:plain:pending')).toEqual(
      (({ key, x, y, width, height }) => ({ key, x, y, width, height }))(
        atlas.frames.get('tower:plain:pending')!,
      ),
    );
    expect(h.logs).toEqual([]);
    // Then nothing more for the same inputs: no canvas, no texture, the same art.
    h.events.length = 0;
    expect(runner.ensure(at(10, 2), MAX_TEX)).toBe(art);
    expect(h.events).toEqual([]);
  });

  it('paints the colour mode’s palette: a protan bake’s towers are protan blue, never the default green', () => {
    const atlasFills = (mode: ColourMode): string[] => {
      const { h, runner } = setup();
      runner.ensure(at(10, 1, mode), MAX_TEX);
      return h.canvases[1]!.fills;
    };
    const protan = resolvePalette('protan').tower;
    const standard = resolvePalette('default').tower;
    expect(protan).not.toBe(standard);
    const fills = atlasFills('protan');
    expect(fills.some((f) => f.startsWith(rgbaOf(protan)))).toBe(true);
    expect(fills.some((f) => f.startsWith(rgbaOf(standard)))).toBe(false);
    // The control: a default bake does paint the default green, so the check can see it.
    expect(atlasFills('default').some((f) => f.startsWith(rgbaOf(standard)))).toBe(true);
  });

  it('shows a rebake’s textures BEFORE it destroys the old ones, then frees the old canvases', () => {
    const { h, runner } = setup();
    runner.ensure(at(10), MAX_TEX);
    h.events.length = 0;
    const art = runner.ensure(at(12), MAX_TEX);
    expect(art).toMatchObject({ boardKey: 'wy-board-2', atlasKey: 'wy-atlas-2' });
    expect(h.events).toEqual([
      'canvas#3',
      'canvas#4',
      'add wy-board-2',
      'add wy-atlas-2',
      'show wy-board-2 wy-atlas-2',
      'remove wy-board-1',
      'remove wy-atlas-1',
      'release#1',
      'release#2',
    ]);
    expect(h.canvases.map((c) => c.released)).toEqual([true, true, false, false]);
  });

  it('bakes at the 1px-cell fallback (a hidden or tiny board) with no failure', () => {
    // The pending outline's rounded rect is −2 × −2 at 1px cells; this host's context, like a
    // browser's, throws on the negative arc radius that once produced.
    const { h, runner } = setup();
    expect(runner.ensure(at(1, 1), MAX_TEX)).not.toBeNull();
    expect(runner.ensure(at(1, 2), MAX_TEX)).not.toBeNull();
    expect(runner.ensure(at(2, 2), MAX_TEX)).not.toBeNull();
    expect(h.logs).toEqual([]);
  });
});

describe('createBakeRunner — a failed attempt is reported first, then undone', () => {
  it('a refused board canvas: warned, naming the canvas and the art the board still shows', () => {
    const { h, runner } = setup();
    const first = runner.ensure(at(10), MAX_TEX);
    h.state.canvases = ['refuse'];
    h.events.length = 0;
    expect(ensureSafely(runner, at(12))).toBe(first);
    const board = layoutBoard(GEOMETRY, 12, 1, MAX_TEX);
    expect(h.events).toEqual([`refuse ${size(board)}`, 'log:warn']);
    expect(h.warns()).toEqual([
      `board art: the browser refused a 2D context for the board canvas (${size(board)}) while ` +
        `baking for ${named(at(12))}; ${showing(at(10))}. ${RETRYING}`,
    ]);
  });

  it('a refused ATLAS canvas: warned, then the board canvas already made is freed', () => {
    const { h, runner } = setup();
    h.state.canvases = ['ok', 'refuse'];
    expect(ensureSafely(runner, at(10))).toBeNull();
    const atlas = layoutAtlas(10, 1, MAX_TEX);
    expect(h.events).toEqual(['canvas#1', `refuse ${size(atlas)}`, 'log:warn', 'release#1']);
    expect(h.warns()).toEqual([
      `board art: the browser refused a 2D context for the atlas canvas (${size(atlas)}) while ` +
        `baking for ${named(at(10))}; ${BLANK}. ${RETRYING}`,
    ]);
  });

  it('a paint that throws: its error passed on, then both canvases freed — and nothing uploaded, as both paint before either uploads', () => {
    const { h, runner } = setup();
    const first = runner.ensure(at(10), MAX_TEX);
    h.events.length = 0;
    h.state.canvases = ['ok', 'throw']; // the atlas's context throws
    expect(ensureSafely(runner, at(12))).toBe(first);
    expect(h.events).toEqual(['canvas#3', 'canvas#4', 'log:error', 'release#3', 'release#4']);
    const atlas = layoutAtlas(12, 1, MAX_TEX);
    expect(h.errors().map((e) => e.message)).toEqual([
      `board art: painting the atlas canvas (${size(atlas)}) failed while baking for ` +
        `${named(at(12))}; ${showing(at(10))}. ${RETRYING}`,
    ]);
    expect(h.errors()[0]!.error).toBe(h.state.paintError);
    // The art on screen was never touched.
    expect([...h.textures.keys()]).toEqual(['wy-board-1', 'wy-atlas-1']);
    expect(h.canvases.slice(0, 2).map((c) => c.released)).toEqual([false, false]);
  });

  it('a board paint that throws names the board, and says the board is blank while no art exists', () => {
    const { h, runner } = setup();
    h.state.canvases = ['throw', 'ok'];
    expect(ensureSafely(runner, at(10))).toBeNull();
    const board = layoutBoard(GEOMETRY, 10, 1, MAX_TEX);
    expect(h.events).toEqual(['canvas#1', 'canvas#2', 'log:error', 'release#1', 'release#2']);
    expect(h.errors().map((e) => e.message)).toEqual([
      `board art: painting the board canvas (${size(board)}) failed while baking for ` +
        `${named(at(10))}; ${BLANK}. ${RETRYING}`,
    ]);
    expect(h.errors()[0]!.error).toBe(h.state.paintError);
  });

  it('an upload that throws partway: reported, then both keys removed and both canvases freed', () => {
    const { h, runner } = setup();
    const uploadError = new Error('upload failed');
    h.state.addThrows = (key) => (key.startsWith('wy-atlas') ? uploadError : null);
    expect(ensureSafely(runner, at(10))).toBeNull();
    expect(h.events).toEqual([
      'canvas#1',
      'canvas#2',
      'add wy-board-1',
      'add wy-atlas-1',
      'log:error',
      'remove wy-board-1',
      'remove wy-atlas-1',
      'release#1',
      'release#2',
    ]);
    const atlas = layoutAtlas(10, 1, MAX_TEX);
    expect(h.errors().map((e) => e.message)).toEqual([
      `board art: uploading the atlas canvas as a texture (${size(atlas)}) failed while baking ` +
        `for ${named(at(10))}; ${BLANK}. ${RETRYING}`,
    ]);
    expect(h.errors()[0]!.error).toBe(uploadError);
    expect(h.textures.size).toBe(0);
  });

  it('a thrown value that is not an Error is reported as its text, and passed on as thrown', () => {
    const { h, runner } = setup();
    const thrown = { code: 'CONTEXT_LOST' };
    h.state.addThrows = (key) => (key.startsWith('wy-board') ? thrown : null);
    expect(ensureSafely(runner, at(10))).toBeNull();
    const board = layoutBoard(GEOMETRY, 10, 1, MAX_TEX);
    expect(h.errors().map((e) => e.message)).toEqual([
      `board art: uploading the board canvas as a texture (${size(board)}) failed while baking ` +
        `for ${named(at(10))}; ${BLANK}. ${RETRYING}`,
    ]);
    expect(h.errors()[0]!.error).toBe(thrown);
    // Keyed by its text: the same value thrown again, after the backoff, is not reported twice.
    for (let i = 0; i < BAKE_RETRY_FRAMES; i++) runner.ensure(at(10), MAX_TEX);
    expect(h.events.filter((e) => e === 'add wy-board-2')).toEqual(['add wy-board-2']);
    expect(h.errors()).toHaveLength(1);
  });

  it('a show that throws is undone: pointed back at the previous art, its textures removed, its canvases freed, nothing recorded or kept', () => {
    const { h, runner } = setup();
    const first = runner.ensure(at(10), MAX_TEX);
    h.state.shows = ['throw']; // pointing back at the previous art then succeeds
    h.events.length = 0;
    expect(ensureSafely(runner, at(12))).toBe(first);
    expect(h.events).toEqual([
      'canvas#3',
      'canvas#4',
      'add wy-board-2',
      'add wy-atlas-2',
      'show wy-board-2 wy-atlas-2',
      'log:error',
      'show wy-board-1 wy-atlas-1',
      'remove wy-board-2',
      'remove wy-atlas-2',
      'release#3',
      'release#4',
    ]);
    const board = layoutBoard(GEOMETRY, 12, 1, MAX_TEX);
    const atlas = layoutAtlas(12, 1, MAX_TEX);
    expect(h.errors().map((e) => e.message)).toEqual([
      `board art: pointing the board and its sprites at the new textures (board ${size(board)}, ` +
        `atlas ${size(atlas)}) failed while baking for ${named(at(12))}; ${showing(at(10))}. ` +
        RETRYING,
    ]);
    expect(h.errors()[0]!.error).toBe(h.state.showError);
    expect([...h.textures.keys()]).toEqual(['wy-board-1', 'wy-atlas-1']);
    // Nothing was recorded: once the backoff is out, the same inputs bake.
    for (let i = 1; i < BAKE_RETRY_FRAMES; i++) runner.ensure(at(12), MAX_TEX);
    expect(runner.ensure(at(12), MAX_TEX)).toMatchObject({ boardKey: 'wy-board-3' });
    // And nothing was kept: unmounting frees the live bake's canvases, and then every one is free.
    runner.destroy();
    expect(h.canvases.map((c) => c.released)).toEqual([true, true, true, true, true, true]);
  });

  it('a show that throws before any art exists: nothing to point back at; its textures removed, its canvases freed', () => {
    const { h, runner } = setup();
    h.state.shows = ['throw'];
    expect(ensureSafely(runner, at(10))).toBeNull();
    expect(h.events).toEqual([
      'canvas#1',
      'canvas#2',
      'add wy-board-1',
      'add wy-atlas-1',
      'show wy-board-1 wy-atlas-1',
      'log:error',
      'remove wy-board-1',
      'remove wy-atlas-1',
      'release#1',
      'release#2',
    ]);
    expect(h.errors()[0]!.message).toContain(`; ${BLANK}.`);
  });
});

describe('createBakeRunner — cleanup can neither hide a failure nor throw', () => {
  it('a cleanup step that throws is logged after the failure it cleans up, and the next step still runs', () => {
    const { h, runner } = setup();
    const first = runner.ensure(at(10), MAX_TEX);
    const releaseError = new Error('release failed');
    h.state.canvases = ['ok', 'throw'];
    h.state.releaseThrows = (id) => (id === 3 ? releaseError : null);
    h.events.length = 0;
    expect(ensureSafely(runner, at(12))).toBe(first);
    expect(h.events).toEqual([
      'canvas#3',
      'canvas#4',
      'log:error',
      'release#3',
      'log:error',
      'release#4',
    ]);
    const [failure, cleanup] = h.errors();
    expect(failure!.error).toBe(h.state.paintError); // the original failure, reported first
    expect(cleanup).toEqual({
      level: 'error',
      message: 'board art: freeing a canvas failed',
      error: releaseError,
    });
    expect(h.canvases[3]!.released).toBe(true);
  });

  it('a texture removal that throws while undoing a show is logged, and the rest of the undo runs', () => {
    const { h, runner } = setup();
    runner.ensure(at(10), MAX_TEX);
    const removeError = new Error('remove failed');
    h.state.shows = ['throw'];
    h.state.removeThrows = (key) => (key === 'wy-board-2' ? removeError : null);
    h.events.length = 0;
    ensureSafely(runner, at(12));
    expect(h.events).toEqual([
      'canvas#3',
      'canvas#4',
      'add wy-board-2',
      'add wy-atlas-2',
      'show wy-board-2 wy-atlas-2',
      'log:error',
      'show wy-board-1 wy-atlas-1',
      'remove wy-board-2',
      'log:error',
      'remove wy-atlas-2',
      'release#3',
      'release#4',
    ]);
    expect(h.errors()[1]).toEqual({
      level: 'error',
      message: 'board art: removing the texture wy-board-2 failed',
      error: removeError,
    });
  });

  it('pointing back at the previous art that throws too is logged, and the undo still removes and frees', () => {
    const { h, runner } = setup();
    runner.ensure(at(10), MAX_TEX);
    h.state.shows = ['throw', 'throw'];
    h.events.length = 0;
    ensureSafely(runner, at(12));
    expect(h.events).toEqual([
      'canvas#3',
      'canvas#4',
      'add wy-board-2',
      'add wy-atlas-2',
      'show wy-board-2 wy-atlas-2',
      'log:error',
      'show wy-board-1 wy-atlas-1',
      'log:error',
      'remove wy-board-2',
      'remove wy-atlas-2',
      'release#3',
      'release#4',
    ]);
    expect(h.errors()[1]).toEqual({
      level: 'error',
      message: 'board art: pointing the board and its sprites back at the previous art failed',
      error: h.state.showError,
    });
  });

  it('retiring the replaced bake that throws is logged, and the new art is still returned', () => {
    const { h, runner } = setup();
    runner.ensure(at(10), MAX_TEX);
    const removeError = new Error('remove failed');
    h.state.removeThrows = (key) => (key === 'wy-board-1' ? removeError : null);
    h.events.length = 0;
    expect(ensureSafely(runner, at(12))).toMatchObject({ boardKey: 'wy-board-2' });
    expect(h.events).toEqual([
      'canvas#3',
      'canvas#4',
      'add wy-board-2',
      'add wy-atlas-2',
      'show wy-board-2 wy-atlas-2',
      'remove wy-board-1',
      'log:error',
      'remove wy-atlas-1',
      'release#1',
      'release#2',
    ]);
    expect(h.errors()).toEqual([
      {
        level: 'error',
        message: 'board art: removing the texture wy-board-1 failed',
        error: removeError,
      },
    ]);
  });

  it('a log that throws does not escape ensure — a warning, an error or a recovery line', () => {
    const { h, runner } = setup();
    const first = runner.ensure(at(10), MAX_TEX);
    h.state.logThrows = true;
    h.state.canvases = ['refuse'];
    expect(ensureSafely(runner, at(12))).toBe(first); // its warning throws
    h.state.canvases = ['ok', 'throw'];
    expect(ensureSafely(runner, at(14))).toBe(first); // its error throws
    expect(ensureSafely(runner, at(16))).toMatchObject({ boardKey: 'wy-board-4' }); // its recovery line throws
    expect(h.events.filter((e) => e.startsWith('log:'))).toEqual([
      'log:warn',
      'log:error',
      'log:info',
    ]);
  });
});

describe('createBakeRunner — a retry waits out the backoff, unless the inputs change', () => {
  it(`tries the same inputs again only ${BAKE_RETRY_FRAMES} frames later, and does not report the same failure twice`, () => {
    const { h, runner } = setup();
    const first = runner.ensure(at(10), MAX_TEX);
    h.state.canvases = ['refuse', 'refuse'];
    runner.ensure(at(12), MAX_TEX); // refused, and warned
    h.events.length = 0;
    for (let i = 1; i < BAKE_RETRY_FRAMES; i++) {
      expect(runner.ensure(at(12), MAX_TEX)).toBe(first);
    }
    expect(h.events).toEqual([]); // no attempt while the backoff runs
    expect(runner.ensure(at(12), MAX_TEX)).toBe(first); // the backoff is out: tried, refused again
    const board = layoutBoard(GEOMETRY, 12, 1, MAX_TEX);
    expect(h.events).toEqual([`refuse ${size(board)}`]); // the same failure: not reported again
    expect(h.warns()).toHaveLength(1);
  });

  it('tries new inputs at once, without waiting out the backoff', () => {
    const { h, runner } = setup();
    runner.ensure(at(10), MAX_TEX);
    h.state.canvases = ['refuse'];
    runner.ensure(at(12), MAX_TEX);
    h.events.length = 0;
    expect(runner.ensure(at(14), MAX_TEX)).toMatchObject({ boardKey: 'wy-board-3' });
    expect(h.events).toEqual([
      'canvas#3',
      'canvas#4',
      'add wy-board-3',
      'add wy-atlas-3',
      'show wy-board-3 wy-atlas-3',
      'remove wy-board-1',
      'remove wy-atlas-1',
      'release#1',
      'release#2',
      'log:info',
    ]);
  });
});

describe('createBakeRunner — a failing streak closes once, and the next starts afresh', () => {
  it('a bake that succeeds after failures says so once, counting them', () => {
    const { h, runner } = setup();
    h.state.canvases = ['refuse', 'refuse'];
    expect(runner.ensure(at(10), MAX_TEX)).toBeNull();
    expect(h.warns()[0]).toContain(`; ${BLANK}.`);
    for (let frame = 0; frame < 2 * BAKE_RETRY_FRAMES - 1; frame++) {
      expect(runner.ensure(at(10), MAX_TEX)).toBeNull();
    }
    expect(runner.ensure(at(10), MAX_TEX)).not.toBeNull();
    expect(h.infos()).toEqual([`board art: baked for ${named(at(10))} after 2 failed attempts`]);
    runner.ensure(at(10), MAX_TEX);
    expect(h.infos()).toHaveLength(1);
  });

  it('inputs back to those the visible art was baked for close the streak: said once, nothing attempted', () => {
    const { h, runner } = setup();
    const first = runner.ensure(at(10), MAX_TEX);
    h.state.canvases = ['refuse'];
    runner.ensure(at(12), MAX_TEX);
    h.events.length = 0;
    expect(runner.ensure(at(10), MAX_TEX)).toBe(first);
    expect(runner.ensure(at(10), MAX_TEX)).toBe(first);
    expect(h.events).toEqual(['log:info']);
    expect(h.infos()).toEqual([
      `board art: back to the inputs the visible art was baked for (${named(at(10))}) after ` +
        '1 failed attempt at other inputs',
    ]);
  });

  it('after a streak closes, the next rebake logs nothing, and the same failure again is reported and counted from one', () => {
    const { h, runner } = setup();
    runner.ensure(at(10), MAX_TEX);
    h.state.canvases = ['refuse'];
    runner.ensure(at(12), MAX_TEX); // streak 1: refused
    runner.ensure(at(13), MAX_TEX); // new inputs, tried at once: baked, and the streak closes
    expect(h.infos()).toEqual([`board art: baked for ${named(at(13))} after 1 failed attempt`]);
    const logged = h.logs.length;
    runner.ensure(at(14), MAX_TEX); // a plain rebake
    expect(h.logs).toHaveLength(logged); // nothing: the count of failed attempts was reset
    h.state.canvases = ['refuse'];
    runner.ensure(at(12), MAX_TEX); // streak 2: the very failure streak 1 reported
    expect(h.warns()).toHaveLength(2); // reported again: the reports were reset
    runner.ensure(at(15), MAX_TEX);
    expect(h.infos()).toEqual([
      `board art: baked for ${named(at(13))} after 1 failed attempt`,
      `board art: baked for ${named(at(15))} after 1 failed attempt`,
    ]);
  });

  it('distinct failures are each reported once, each with its own error', () => {
    const { h, runner } = setup();
    runner.ensure(at(10), MAX_TEX);
    const uploadError = new Error('upload failed');
    h.state.canvases = ['ok', 'throw'];
    runner.ensure(at(12), MAX_TEX); // the atlas's paint throws
    h.state.addThrows = (key) => (key.startsWith('wy-atlas') ? uploadError : null);
    runner.ensure(at(14), MAX_TEX); // the atlas's upload throws
    h.state.addThrows = () => null;
    h.state.canvases = ['ok', 'throw'];
    runner.ensure(at(12), MAX_TEX); // the first failure again: not reported again
    const errors = h.errors();
    expect(errors).toHaveLength(2);
    expect(errors[0]!.message).toContain('painting the atlas canvas');
    expect(errors[0]!.error).toBe(h.state.paintError);
    expect(errors[1]!.message).toContain('uploading the atlas canvas as a texture');
    expect(errors[1]!.error).toBe(uploadError);
  });
});

describe('createBakeRunner — a failure is distinct by its stage, its error and its canvas size', () => {
  it('a different error at the same step and size is reported too', () => {
    const { h, runner } = setup();
    runner.ensure(at(10), MAX_TEX);
    const first = new Error('upload failed');
    const second = new Error('out of memory');
    let thrown: Error = first;
    h.state.addThrows = (key) => (key.startsWith('wy-atlas') ? thrown : null);
    runner.ensure(at(12), MAX_TEX);
    thrown = second;
    for (let i = 0; i < BAKE_RETRY_FRAMES; i++) runner.ensure(at(12), MAX_TEX);
    expect(h.errors().map((e) => e.error)).toEqual([first, second]);
  });

  it('the same error at a different canvas size is reported too', () => {
    const { h, runner } = setup();
    runner.ensure(at(10), MAX_TEX);
    h.state.canvases = ['ok', 'throw', 'ok', 'throw'];
    runner.ensure(at(12), MAX_TEX);
    runner.ensure(at(14), MAX_TEX); // new inputs, tried at once: a bigger atlas, the same throw
    const sizes = [12, 14].map((cell) => size(layoutAtlas(cell, 1, MAX_TEX)));
    expect(sizes[0]).not.toBe(sizes[1]);
    expect(h.errors().map((e) => e.message)).toEqual(
      sizes.map(
        (s, i) =>
          `board art: painting the atlas canvas (${s}) failed while baking for ` +
          `${named(at(i === 0 ? 12 : 14))}; ${showing(at(10))}. ${RETRYING}`,
      ),
    );
  });
});

describe('createBakeRunner — destroy', () => {
  it('frees the live canvases, once; afterwards nothing is baked and nothing returned', () => {
    const { h, runner } = setup();
    runner.ensure(at(10), MAX_TEX);
    runner.ensure(at(12), MAX_TEX); // the first bake's canvases are freed here
    h.events.length = 0;
    runner.destroy();
    expect(h.events).toEqual(['release#3', 'release#4']);
    expect(h.canvases.every((c) => c.released)).toBe(true);
    h.events.length = 0;
    runner.destroy();
    expect(runner.ensure(at(12), MAX_TEX)).toBeNull();
    expect(runner.ensure(at(20), MAX_TEX)).toBeNull(); // new inputs too: no canvas, no texture
    expect(h.events).toEqual([]);
  });

  it('before any bake, frees nothing', () => {
    const { h, runner } = setup();
    runner.destroy();
    expect(h.events).toEqual([]);
  });
});
