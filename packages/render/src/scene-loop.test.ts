// scene-loop.test.ts — `mount()`'s wiring to Phaser's own frame loop (#195), with Phaser stubbed
// (as `scene-teardown.test.ts` does) by a Game that boots as Phaser 3.90.0's does: READY's
// listeners, then `start`, which runs the `postBoot` hook and only then binds `game.step` for its
// loop, whose every frame runs the bound step and then counts it. What the guard decides is
// `loop-guard.test.ts`'s; this pins that `scene.ts` routes Phaser's step and its READY listener
// through it, and that `draw()` throws what it hands back, holding that frame's sparks.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardFrameInput } from './board-frame';
import type { BakedArt } from './bake-runner';
import { LOOP_STALL_DRAWS } from './loop-guard';

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
  interface Config {
    readonly callbacks?: { readonly postBoot?: (game: Game) => void };
  }
  const games: Game[] = [];
  class Game {
    readonly events = new Events();
    readonly canvas = {
      style: {} as Record<string, string>,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 280, height: 240 }),
    };
    /** Set to make the READY listener's first Phaser call throw. */
    graphicsError: Error | null = null;
    readonly scene = {
      scenes: [
        {
          add: {
            graphics: (): unknown => {
              if (this.graphicsError !== null) throw this.graphicsError;
              return chain();
            },
            image: chain,
          },
          cameras: { main: chain() },
        },
      ],
    };
    readonly scale = { resize: (): void => {} };
    /** What Phaser's own step does this frame: nothing, unless a test makes it throw. */
    stepBody: () => void = () => {};
    started = false;
    private frame = 0;
    private loopStep: ((time: number, delta: number) => void) | null = null;
    private readonly config: Config;
    constructor(config: Config) {
      this.config = config;
      games.push(this);
    }
    step(_time: number, _delta: number): void {
      this.stepBody();
    }
    /** `Game#texturesReady`: READY's listeners, then `start` — `postBoot`, then the bind. */
    texturesReady(): void {
      this.events.emit('ready');
      this.started = true;
      this.config.callbacks?.postBoot?.(this);
      this.loopStep = this.step.bind(this);
    }
    /** One frame of Phaser's loop (`TimeStep#step`): the bound step, then the count moves. A
     *  throw out of the step leaves the count where it was, and Phaser's loop would end. */
    tick(): void {
      if (this.loopStep === null) throw new Error('stub: the loop never started');
      this.loopStep(0, 16);
      this.frame += 1;
    }
    getFrame(): number {
      return this.frame;
    }
    getTime(): number {
      return 0;
    }
    destroy(): void {}
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

// The bake always succeeds, and the frame drawing is replaced by a recorder.
const READY_ART = { atlas: { frames: new Map() } } as unknown as BakedArt;
vi.mock('./bake-runner', () => ({
  createBakeRunner: () => ({ ensure: () => READY_ART, destroy: (): void => {} }),
}));
const frames = vi.hoisted(() => ({ inputs: [] as unknown[] }));
vi.mock('./board-frame', async (importActual) => ({
  ...(await importActual<typeof import('./board-frame')>()),
  drawBoardFrame: (_t: unknown, input: unknown): void => {
    frames.inputs.push(input);
  },
}));

import { mount } from './scene';
import type { RenderHandle, RenderOverlay, RenderVM, SparkPoint } from './types';

const GEOMETRY = { cols: 10, rows: 10, entrance: { col: 0, row: 5 }, exit: { col: 9, row: 5 } };
const board = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 280, height: 240 }) };
const vm: RenderVM = { tick: 1, phase: 'running', creeps: [], towers: [] };
const overlay = (sparks: readonly SparkPoint[] = []): RenderOverlay => ({
  ghost: null,
  selection: null,
  sparks,
  pendingAdds: [],
  pendingSells: [],
  colourMode: 'default',
  reducedMotion: false,
  tracers: [],
  kills: [],
  leaks: 0,
});
const SPARK: SparkPoint = { x: 3 * 256, y: 4 * 256, radiusFp: 256 };

type StubGame = (typeof phaser.games)[number];

/** A mounted board whose Phaser has booted: READY fired, its loop started. */
function booted(): { handle: RenderHandle; game: StubGame } {
  vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    matchMedia: () => ({ addEventListener: (): void => {}, removeEventListener: (): void => {} }),
  });
  const handle = mount(board as unknown as HTMLElement, GEOMETRY);
  const game = phaser.games[0]!;
  game.texturesReady();
  return { handle, game };
}

/** What `draw()` threw, or null. */
function drawCaught(handle: RenderHandle, sparks?: readonly SparkPoint[]): unknown {
  try {
    handle.draw(null, vm, 1, overlay(sparks));
    return null;
  } catch (error) {
    return error;
  }
}

describe('mount — Phaser’s own frame loop', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    phaser.games.length = 0;
    frames.inputs.length = 0;
  });

  it('runs Phaser’s step through the guard: a throw costs a frame, and the next draw throws it, once', () => {
    const { handle, game } = booted();
    expect(drawCaught(handle)).toBeNull();
    game.tick();
    const broke = new TypeError("Cannot read properties of null (reading 'glTexture')");
    game.stepBody = () => {
      throw broke;
    };
    expect(() => game.tick()).not.toThrow(); // Phaser's loop goes on
    expect(game.getFrame()).toBe(2);
    expect(drawCaught(handle)).toBe(broke); // the original error
    expect(frames.inputs).toHaveLength(1); // that frame drew nothing
    game.stepBody = () => {};
    game.tick();
    expect(drawCaught(handle)).toBeNull();
    expect(frames.inputs).toHaveLength(2);
  });

  it('runs the READY listener through the guard: Phaser still starts, and every draw throws', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    vi.stubGlobal('window', {
      devicePixelRatio: 1,
      matchMedia: () => ({ addEventListener: (): void => {}, removeEventListener: (): void => {} }),
    });
    const handle = mount(board as unknown as HTMLElement, GEOMETRY);
    const game = phaser.games[0]!;
    const broke = new Error('the READY listener broke');
    game.graphicsError = broke;
    expect(() => game.texturesReady()).not.toThrow();
    expect(game.started).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(drawCaught(handle)).toBe(broke);
      game.tick();
    }
    expect(frames.inputs).toHaveLength(0);
  });

  it('throws the stopped error once Phaser’s frame count stands still across the bound', () => {
    const { handle, game } = booted();
    expect(drawCaught(handle)).toBeNull();
    game.tick();
    // Phaser's loop is gone: the draws go on, its count stands still.
    for (let i = 0; i <= LOOP_STALL_DRAWS - 1; i++) expect(drawCaught(handle)).toBeNull();
    expect((drawCaught(handle) as Error).message).toMatch(/^the board's renderer has stopped: /);
  });

  it('holds a failed frame’s sparks for the next frame drawn', () => {
    const { handle, game } = booted();
    expect(drawCaught(handle)).toBeNull();
    game.stepBody = () => {
      throw new Error('the render broke');
    };
    game.tick();
    expect(drawCaught(handle, [SPARK])).toBeInstanceOf(Error);
    game.stepBody = () => {};
    game.tick();
    expect(drawCaught(handle)).toBeNull();
    const drawn = (frames.inputs.at(-1) as BoardFrameInput).sparks;
    expect(drawn.map((s) => [s.x, s.y])).toEqual([[SPARK.x, SPARK.y]]);
  });

  it('lets Phaser’s step run bare once destroyed: its next step is its teardown', () => {
    const { handle, game } = booted();
    handle.destroy();
    const teardown = new Error('the teardown broke');
    game.stepBody = () => {
      throw teardown;
    };
    expect(() => game.tick()).toThrow(teardown);
  });
});
