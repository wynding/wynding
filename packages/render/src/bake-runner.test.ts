// bake-runner.test.ts — running a bake against a recording host: what an attempt does and in
// what order, and what a failed one leaves behind — never an exception, always the previous
// art, a retry on the next frame, one report per failing streak, and a note on recovery.

import { describe, it, expect } from 'vitest';
import {
  createBakeRunner,
  type BakeHost,
  type BakedArt,
  type TextureFrameRect,
} from './bake-runner';
import { layoutAtlas, layoutBoard, type BakeInputs } from './bake';
import type { Canvas2DLike } from './canvas-graphics';

const GEOMETRY = { cols: 28, rows: 24, entrance: { col: 0, row: 11 }, exit: { col: 27, row: 11 } };
const MAX_TEX = 8192;
const at = (cellPx: number, dpr = 1): BakeInputs => ({ cellPx, dpr, mode: 'default' });

interface FakeCanvas {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  released: boolean;
}

/** A 2D context that records nothing and, when `throws`, throws from its first call. Its
 *  `arc` rejects a negative radius as a real context does. */
function fakeContext(throws: boolean): Canvas2DLike {
  const op =
    (name: string) =>
    (...args: unknown[]) => {
      if (throws) throw new Error(`paint failed at ${name}`);
      if (name === 'arc' && (args[2] as number) < 0) throw new RangeError('IndexSizeError');
    };
  return {
    fillStyle: '',
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

/** A recording host. Each `createCanvas` call takes the next entry of `plan` (default 'ok'):
 *  'refuse' returns null, 'throw' hands back a context whose painting throws. */
function fakeHost() {
  const events: string[] = [];
  const canvases: FakeCanvas[] = [];
  const textures = new Map<string, readonly TextureFrameRect[]>();
  const warns: string[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const shown: BakedArt[] = [];
  const state = {
    plan: [] as ('ok' | 'refuse' | 'throw')[],
    addThrows: (_key: string): boolean => false,
    showThrows: false,
  };
  const host: BakeHost<FakeCanvas> = {
    createCanvas(width, height) {
      const step = state.plan.shift() ?? 'ok';
      if (step === 'refuse') {
        events.push(`refuse ${width}×${height}`);
        return null;
      }
      const canvas: FakeCanvas = { id: canvases.length + 1, width, height, released: false };
      canvases.push(canvas);
      events.push(`canvas#${canvas.id}`);
      return { canvas, ctx: fakeContext(step === 'throw') };
    },
    releaseCanvas(canvas) {
      canvas.released = true;
      events.push(`release#${canvas.id}`);
    },
    addTexture(key, _canvas, frames) {
      events.push(`add ${key}`);
      if (state.addThrows(key)) throw new Error(`upload of ${key} failed`);
      textures.set(key, frames);
    },
    removeTexture(key) {
      events.push(`remove ${key}`);
      textures.delete(key);
    },
    show(art) {
      events.push(`show ${art.boardKey} ${art.atlasKey}`);
      if (state.showThrows) throw new Error('repoint failed');
      shown.push(art);
    },
    log: {
      warn: (m) => warns.push(m),
      error: (m) => errors.push(m),
      info: (m) => infos.push(m),
    },
  };
  return { host, state, events, canvases, textures, warns, errors, infos, shown };
}

describe('createBakeRunner — an attempt', () => {
  it('bakes on the first frame: both canvases, both textures (the atlas with every frame), shown', () => {
    const h = fakeHost();
    const runner = createBakeRunner(GEOMETRY, h.host);
    const art = runner.ensure(at(10), MAX_TEX);
    expect(art).not.toBeNull();
    expect(art).toMatchObject({ boardKey: 'wy-board-1', atlasKey: 'wy-atlas-1' });
    expect(h.events).toEqual([
      'canvas#1',
      'canvas#2',
      'add wy-board-1',
      'add wy-atlas-1',
      'show wy-board-1 wy-atlas-1',
    ]);
    const board = layoutBoard(GEOMETRY, 10, 1, MAX_TEX);
    const atlas = layoutAtlas(10, 1, MAX_TEX);
    expect([h.canvases[0]!.width, h.canvases[0]!.height]).toEqual([board.width, board.height]);
    expect([h.canvases[1]!.width, h.canvases[1]!.height]).toEqual([atlas.width, atlas.height]);
    expect(h.textures.get('wy-board-1')).toEqual([]);
    expect(h.textures.get('wy-atlas-1')).toHaveLength(atlas.frames.size);
    expect(h.textures.get('wy-atlas-1')!.find((f) => f.key === 'tower:plain:pending')).toEqual(
      (({ key, x, y, width, height }) => ({ key, x, y, width, height }))(
        atlas.frames.get('tower:plain:pending')!,
      ),
    );
    // Then nothing more for the same inputs: no canvas, no texture, the same art.
    h.events.length = 0;
    expect(runner.ensure(at(10), MAX_TEX)).toBe(art);
    expect(h.events).toEqual([]);
  });

  it('shows a rebake’s textures BEFORE it destroys the old ones, then frees the old canvases', () => {
    const h = fakeHost();
    const runner = createBakeRunner(GEOMETRY, h.host);
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
    const h = fakeHost();
    const runner = createBakeRunner(GEOMETRY, h.host);
    expect(runner.ensure(at(1, 1), MAX_TEX)).not.toBeNull();
    expect(runner.ensure(at(1, 2), MAX_TEX)).not.toBeNull();
    expect(runner.ensure(at(2, 2), MAX_TEX)).not.toBeNull();
    expect([h.errors, h.warns]).toEqual([[], []]);
  });
});

describe('createBakeRunner — a failed attempt never escapes, and is retried', () => {
  it('a refused canvas: the previous art stays, the next frame retries, one warning per streak, recovery noted', () => {
    const h = fakeHost();
    const runner = createBakeRunner(GEOMETRY, h.host);
    const first = runner.ensure(at(10), MAX_TEX);
    h.state.plan = ['refuse', 'refuse', 'refuse'];
    h.events.length = 0;
    for (let frame = 0; frame < 3; frame++) {
      expect(runner.ensure(at(12), MAX_TEX)).toBe(first); // the previous art, each frame
    }
    const board = layoutBoard(GEOMETRY, 12, 1, MAX_TEX);
    // Three attempts, three refusals, nothing painted or uploaded — and nothing to undo.
    expect(h.events).toEqual([
      `refuse ${board.width}×${board.height}`,
      `refuse ${board.width}×${board.height}`,
      `refuse ${board.width}×${board.height}`,
    ]);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toContain(`board canvas (${board.width}×${board.height})`);
    // The fourth frame's canvas is granted: it bakes, and says it recovered.
    const art = runner.ensure(at(12), MAX_TEX);
    expect(art).not.toBe(first);
    expect(art).toMatchObject({ boardKey: 'wy-board-5', atlasKey: 'wy-atlas-5' }); // fresh keys
    expect(h.infos).toEqual(['board art: baked after 3 failed attempts']);
    // A new streak warns again.
    h.state.plan = ['refuse'];
    runner.ensure(at(14), MAX_TEX);
    expect(h.warns).toHaveLength(2);
  });

  it('no bake has ever succeeded: null until one does', () => {
    const h = fakeHost();
    const runner = createBakeRunner(GEOMETRY, h.host);
    h.state.plan = ['refuse'];
    expect(runner.ensure(at(10), MAX_TEX)).toBeNull();
    expect(runner.ensure(at(10), MAX_TEX)).not.toBeNull();
    expect(h.infos).toEqual(['board art: baked after 1 failed attempt']);
  });

  it('a refused ATLAS canvas frees the board canvas already made, and names the atlas', () => {
    const h = fakeHost();
    const runner = createBakeRunner(GEOMETRY, h.host);
    h.state.plan = ['ok', 'refuse'];
    expect(runner.ensure(at(10), MAX_TEX)).toBeNull();
    const atlas = layoutAtlas(10, 1, MAX_TEX);
    expect(h.events).toEqual(['canvas#1', `refuse ${atlas.width}×${atlas.height}`, 'release#1']);
    expect(h.warns[0]).toContain(`atlas canvas (${atlas.width}×${atlas.height})`);
  });

  it('a paint that throws: this attempt’s textures removed, both canvases freed, the error reported once naming the canvas', () => {
    const h = fakeHost();
    const runner = createBakeRunner(GEOMETRY, h.host);
    const first = runner.ensure(at(10), MAX_TEX);
    h.events.length = 0;
    h.state.plan = ['ok', 'throw', 'ok', 'throw'];
    expect(() => runner.ensure(at(12), MAX_TEX)).not.toThrow();
    expect(runner.ensure(at(12), MAX_TEX)).toBe(first); // retried, failed again, still the old art
    expect(h.events).toEqual([
      'canvas#3',
      'canvas#4',
      'add wy-board-2', // the board painted and uploaded; the atlas's paint threw
      'remove wy-board-2',
      'release#3',
      'release#4',
      'canvas#5',
      'canvas#6',
      'add wy-board-3',
      'remove wy-board-3',
      'release#5',
      'release#6',
    ]);
    const atlas = layoutAtlas(12, 1, MAX_TEX);
    expect(h.errors).toEqual([
      `board art: baking the atlas canvas (${atlas.width}×${atlas.height}) failed; keeping the previous art and retrying next frame`,
    ]);
    // The old art was never touched.
    expect(h.textures.has('wy-board-1') && h.textures.has('wy-atlas-1')).toBe(true);
    expect(h.canvases.slice(0, 2).map((c) => c.released)).toEqual([false, false]);
  });

  it('a board paint that throws names the board', () => {
    const h = fakeHost();
    const runner = createBakeRunner(GEOMETRY, h.host);
    h.state.plan = ['throw', 'ok'];
    expect(runner.ensure(at(10), MAX_TEX)).toBeNull();
    const board = layoutBoard(GEOMETRY, 10, 1, MAX_TEX);
    expect(h.errors[0]).toContain(`board canvas (${board.width}×${board.height})`);
    expect(h.events).toEqual(['canvas#1', 'canvas#2', 'release#1', 'release#2']);
  });

  it('an upload that throws partway removes that key too', () => {
    const h = fakeHost();
    const runner = createBakeRunner(GEOMETRY, h.host);
    h.state.addThrows = (key) => key.startsWith('wy-atlas');
    expect(runner.ensure(at(10), MAX_TEX)).toBeNull();
    expect(h.events).toEqual([
      'canvas#1',
      'canvas#2',
      'add wy-board-1',
      'add wy-atlas-1',
      'remove wy-board-1',
      'remove wy-atlas-1',
      'release#1',
      'release#2',
    ]);
  });

  it('a show that throws keeps the new art (recorded, not retried) and keeps the old textures alive for destroy', () => {
    const h = fakeHost();
    const runner = createBakeRunner(GEOMETRY, h.host);
    runner.ensure(at(10), MAX_TEX);
    h.state.showThrows = true;
    h.events.length = 0;
    const art = runner.ensure(at(12), MAX_TEX);
    expect(art).toMatchObject({ boardKey: 'wy-board-2' });
    // Some sprite may still draw from the old textures: they are not destroyed…
    expect(h.events.some((e) => e.startsWith('remove'))).toBe(false);
    expect(h.errors).toHaveLength(1);
    // … and the new art is not retried.
    h.state.showThrows = false;
    h.events.length = 0;
    expect(runner.ensure(at(12), MAX_TEX)).toBe(art);
    expect(h.events).toEqual([]);
    // Unmounting frees every canvas: the live bake's and the kept one's.
    runner.destroy();
    expect(h.canvases.map((c) => c.released)).toEqual([true, true, true, true]);
  });
});

describe('createBakeRunner — destroy', () => {
  it('frees the live canvases', () => {
    const h = fakeHost();
    const runner = createBakeRunner(GEOMETRY, h.host);
    runner.ensure(at(10), MAX_TEX);
    runner.ensure(at(12), MAX_TEX); // the first bake's canvases are freed here
    h.events.length = 0;
    runner.destroy();
    expect(h.events).toEqual(['release#3', 'release#4']);
    expect(h.canvases.every((c) => c.released)).toBe(true);
    // Nothing left to free twice, and nothing left to draw with.
    h.events.length = 0;
    runner.destroy();
    expect(h.events).toEqual([]);
    expect(runner.ensure(at(12), MAX_TEX)).toBeNull();
  });
});
