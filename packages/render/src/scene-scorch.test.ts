// scene-scorch.test.ts — `mount()`'s `draw()` feeds the scorch tracker on EVERY call, with
// Phaser stubbed (as `scene-teardown.test.ts` does) and the bake and the frame drawing
// replaced by recorders. A mine's marked landing arrives drained from the controller and the
// spark store keeps no `detonation` mark, so a landing seen only by a `draw()` that returned
// early — before READY, or while the first bake is failing — would never scorch (PR #184).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardFrameInput } from './board-frame';
import type { BakedArt } from './bake-runner';

type Handler = () => void;
const phaser = vi.hoisted(() => {
  class Events {
    private readonly handlers = new Map<string, Handler[]>();
    once(name: string, fn: Handler): void {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
    }
    emit(name: string): void {
      const fns = this.handlers.get(name) ?? [];
      this.handlers.delete(name);
      for (const fn of fns) fn();
    }
  }
  const chain = (): Record<string, () => unknown> => {
    const o: Record<string, () => unknown> = {};
    const self = (): unknown => o;
    for (const m of ['setDepth', 'setOrigin', 'setVisible', 'setZoom', 'setScroll']) o[m] = self;
    return o;
  };
  const games: Game[] = [];
  class Game {
    readonly events = new Events();
    readonly canvas = {
      style: {} as Record<string, string>,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 280, height: 240 }),
    };
    readonly scene = {
      scenes: [{ add: { graphics: chain, image: chain }, cameras: { main: chain() } }],
    };
    readonly scale = { resize: (): void => {} };
    constructor() {
      games.push(this);
    }
    destroy(): void {}
    getTime(): number {
      return 0;
    }
  }
  return {
    games,
    module: {
      default: {
        Game,
        AUTO: 0,
        Scale: { NONE: 0 },
        Core: { Events: { READY: 'ready', DESTROY: 'destroy' } },
        Renderer: { WebGL: { WebGLRenderer: class {} } },
      },
    },
  };
});
vi.mock('phaser', () => phaser.module);

// The bake: whether it has succeeded yet is the test's to say.
const bake = vi.hoisted(() => ({ art: null as unknown }));
vi.mock('./bake-runner', () => ({
  createBakeRunner: () => ({ ensure: () => bake.art, destroy: (): void => {} }),
}));

// The frame: what `drawBoardFrame` was handed, so the tracker can be read as it would be.
const frames = vi.hoisted(() => ({ inputs: [] as unknown[] }));
vi.mock('./board-frame', async (importActual) => ({
  ...(await importActual<typeof import('./board-frame')>()),
  drawBoardFrame: (_t: unknown, input: unknown): void => {
    frames.inputs.push(input);
  },
}));

import { mount } from './scene';
import type { RenderOverlay, RenderVM } from './types';

const GEOMETRY = { cols: 10, rows: 10, entrance: { col: 0, row: 5 }, exit: { col: 9, row: 5 } };
const board = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 280, height: 240 }) };

const vm = (tick: number): RenderVM => ({ tick, phase: 'running', creeps: [], towers: [] });
const overlay = (sparks: RenderOverlay['sparks']): RenderOverlay => ({
  ghost: null,
  selection: null,
  sparks,
  pendingAdds: [],
  pendingSells: [],
  colourMode: 'default',
  reducedMotion: false,
  tracers: [],
});
// A mine going off with no tracer drawn: only its marked landing, at its footprint centre.
const LANDING = [{ x: 7 * 256, y: 3 * 256, radiusFp: 2.5 * 256, detonation: true }] as const;

const READY_ART = { atlas: { frames: new Map() } } as unknown as BakedArt;

function stubWindow(): void {
  vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    matchMedia: () => ({ addEventListener: (): void => {}, removeEventListener: (): void => {} }),
  });
}

describe('mount — draw() feeds the scorch tracker before its early returns', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    phaser.games.length = 0;
    frames.inputs.length = 0;
    bake.art = null;
  });

  it('scorches a mine that went off before READY, from the render tick of the draw that saw it', () => {
    stubWindow();
    const handle = mount(board as unknown as HTMLElement, GEOMETRY);
    handle.draw(vm(20), vm(21), 0.25, overlay(LANDING)); // Phaser not READY: targets === null
    expect(frames.inputs).toHaveLength(0);
    phaser.games[0]!.events.emit('ready');
    bake.art = READY_ART;
    handle.draw(vm(60), vm(61), 0.5, overlay([]));
    const { scorches } = frames.inputs[0] as BoardFrameInput;
    // Born at the first draw's render tick (20.25), not the later one's (60.5).
    expect(scorches.live(20.25).map((s) => s.alpha)).toEqual([1]);
    expect(scorches.live(60.25)).toHaveLength(1);
  });

  it('scorches a mine that went off while the first bake is failing', () => {
    stubWindow();
    const handle = mount(board as unknown as HTMLElement, GEOMETRY);
    phaser.games[0]!.events.emit('ready');
    handle.draw(vm(20), vm(21), 0.25, overlay(LANDING)); // READY, but no art: art === null
    expect(frames.inputs).toHaveLength(0);
    bake.art = READY_ART;
    handle.draw(vm(60), vm(61), 0.5, overlay([]));
    const { scorches } = frames.inputs[0] as BoardFrameInput;
    expect(scorches.live(20.25).map((s) => s.alpha)).toEqual([1]);
    expect(scorches.live(60.25)).toHaveLength(1);
  });

  it('forgets those scorches on reset(), before READY too', () => {
    stubWindow();
    const handle = mount(board as unknown as HTMLElement, GEOMETRY);
    handle.draw(vm(20), vm(21), 0.25, overlay(LANDING));
    handle.reset();
    phaser.games[0]!.events.emit('ready');
    bake.art = READY_ART;
    handle.draw(vm(22), vm(23), 0, overlay([]));
    expect((frames.inputs[0] as BoardFrameInput).scorches.live(22)).toEqual([]);
  });
});
