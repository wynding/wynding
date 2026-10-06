// scene-teardown.test.ts — `mount()`'s teardown, with Phaser stubbed: `scene.ts` imports Phaser
// at module scope, which cannot load under a plain Vitest run, so the module is replaced by a
// Game whose READY fires only when the test says. Phaser's own `destroy()` only marks its game
// for destruction and READY still fires after it, so a mount destroyed before READY must make
// no observer and arm no dpr listener when it does (QC round 5).

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  // A Phaser object whose setters chain.
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
      scenes: [
        {
          add: { graphics: chain, image: chain },
          cameras: { main: chain() },
        },
      ],
    };
    readonly scale = { resize: (): void => {} };
    destroyed = false;
    constructor() {
      games.push(this);
    }
    destroy(): void {
      this.destroyed = true; // Phaser's own: marked, torn down at its next step
    }
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

import { mount } from './scene';

const GEOMETRY = { cols: 10, rows: 10, entrance: { col: 0, row: 5 }, exit: { col: 9, row: 5 } };

/** A window whose ResizeObservers and dpr listeners are counted, each observer's callback
 *  kept so a test can deliver a notification the browser had already gathered. */
function stubWindow(): {
  observing: () => number;
  listening: () => number;
  deliver: () => void;
} {
  const observers: { targets: number; callback: (entries: unknown[]) => void }[] = [];
  class Recording {
    private readonly rec: { targets: number; callback: (entries: unknown[]) => void };
    constructor(callback: (entries: unknown[]) => void) {
      this.rec = { targets: 0, callback };
      observers.push(this.rec);
    }
    observe(): void {
      this.rec.targets++;
    }
    disconnect(): void {
      this.rec.targets = 0;
    }
  }
  let listeners = 0;
  vi.stubGlobal('ResizeObserver', Recording);
  vi.stubGlobal('window', {
    devicePixelRatio: 1.25,
    matchMedia: () => ({
      addEventListener: () => {
        listeners++;
      },
      removeEventListener: () => {
        listeners--;
      },
    }),
    // A browser that reports the device-pixel box, so READY makes both observers.
    ResizeObserverEntry: { prototype: { devicePixelContentBoxSize: [] } },
  });
  const entry = {
    devicePixelContentBoxSize: [{ inlineSize: 350, blockSize: 300 }],
    contentBoxSize: [{ inlineSize: 280, blockSize: 240 }],
  };
  return {
    observing: () => observers.reduce((n, o) => n + o.targets, 0),
    listening: () => listeners,
    deliver: () => {
      for (const o of observers) o.callback([entry]);
    },
  };
}

const board = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 280, height: 240 }) };

describe('mount — teardown', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    phaser.games.length = 0;
  });

  it('makes both observers and arms the dpr listener at READY, and destroy() undoes all three', () => {
    const w = stubWindow();
    const handle = mount(board as unknown as HTMLElement, GEOMETRY);
    phaser.games[0]!.events.emit('ready');
    expect(w.observing(), 'the board and the canvas’s device pixels').toBe(2);
    expect(w.listening(), 'the dpr listener').toBe(1);
    handle.destroy();
    expect([w.observing(), w.listening()]).toEqual([0, 0]);
    expect(phaser.games[0]!.destroyed).toBe(true);
  });

  it('makes no observer and arms no dpr listener when READY fires after destroy()', () => {
    const w = stubWindow();
    const handle = mount(board as unknown as HTMLElement, GEOMETRY);
    handle.destroy();
    phaser.games[0]!.events.emit('ready');
    expect([w.observing(), w.listening()]).toEqual([0, 0]);
    expect(phaser.games[0]!.destroyed).toBe(true);
  });

  it('re-arms nothing when a notification gathered before destroy() is delivered after it', () => {
    const w = stubWindow();
    const handle = mount(board as unknown as HTMLElement, GEOMETRY);
    phaser.games[0]!.events.emit('ready');
    w.deliver(); // live: each sync re-arms the one dpr listener
    expect(w.listening()).toBe(1);
    handle.destroy();
    w.deliver();
    expect(w.listening()).toBe(0);
  });
});
