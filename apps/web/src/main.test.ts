import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RenderHandle } from '@wynding/render';
import type { InputHandle } from './input';

// The Phaser scene is WebGL — mock the subpath so it never loads under jsdom. This is the
// one module excluded from coverage; here we only need a fake handle. The factory is
// hoisted above imports, so the fake handle + spy live inside it and are read back via
// the mocked module.
vi.mock('@wynding/render/scene', () => {
  const handle: RenderHandle = { draw: vi.fn(), reset: vi.fn(), destroy: vi.fn() };
  return { mount: vi.fn(() => handle) };
});

// Wraps the REAL `attachInput` (every other test in this file needs its actual gesture
// behavior — keyboard routing, etc.) but spies on the returned handle's `reset()`, so the
// #40 lifecycle test below can assert `main.ts` calls it on Play-again without faking
// away real behavior for the rest of the suite.
vi.mock('./input', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./input')>();
  return {
    ...actual,
    attachInput: vi.fn((...args: Parameters<typeof actual.attachInput>): InputHandle => {
      const handle = actual.attachInput(...args);
      return { destroy: handle.destroy, reset: vi.fn(handle.reset) };
    }),
  };
});

import { mount as mountMock } from '@wynding/render/scene';
import { attachInput as attachInputMock } from './input';
import { createApp, boot, type Scheduler } from './main';

// The shared fake handle the mocked scene returns (same object every mount call).
const fakeHandle = (mountMock as unknown as () => RenderHandle)();

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

/** A manual scheduler: captures the frame callback so the test drives frames by hand. */
function manualSchedule(): {
  schedule: Scheduler;
  frame: (now: number) => void;
  cancel: () => void;
} {
  let cb: ((now: number) => void) | null = null;
  const cancel = vi.fn();
  return {
    schedule: (onFrame) => {
      cb = onFrame;
      return cancel;
    },
    frame: (now) => cb?.(now),
    cancel,
  };
}

describe('main — createApp wiring & frame loop', () => {
  it('builds the DOM, mounts the scene, and draws/updates each frame', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const sched = manualSchedule();
    const fakeScene = vi.fn(() => fakeHandle);

    const app = createApp(document, root, {
      sceneFactory: fakeScene,
      schedule: sched.schedule,
      now: () => 0,
      seed: 1,
    });

    expect(root.querySelector('.wy-title')!.textContent).toBe('Wynding');
    expect(root.querySelector('.wy-board')!.getAttribute('role')).toBe('application');
    expect(fakeScene).toHaveBeenCalledOnce();

    sched.frame(16);
    sched.frame(32);
    expect(fakeHandle.draw).toHaveBeenCalled();
    expect(root.querySelector('.wy-hud')!.textContent).toContain('Lives:');

    app.destroy();
    expect(sched.cancel).toHaveBeenCalledOnce();
    expect(fakeHandle.destroy).toHaveBeenCalledOnce();
  });

  it('destroy() removes every app-owned node so a host can recreate in the same root', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const sched = manualSchedule();
    const app = createApp(document, root, {
      sceneFactory: vi.fn(() => fakeHandle),
      schedule: sched.schedule,
      now: () => 0,
      seed: 1,
    });
    app.destroy();
    expect(root.childElementCount).toBe(0); // no leaked title/board/overlay (or stale inert)
    // A recreate must yield exactly one of each — not a stacked duplicate/focus target.
    const again = createApp(document, root, {
      sceneFactory: vi.fn(() => fakeHandle),
      schedule: sched.schedule,
      now: () => 0,
      seed: 2,
    });
    expect(root.querySelectorAll('.wy-title')).toHaveLength(1);
    expect(root.querySelectorAll('.wy-board')).toHaveLength(1);
    again.destroy();
  });

  it('routes control buttons and reaches a results screen, verify, and play-again', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const sched = manualSchedule();
    let clock = 0;
    const app = createApp(document, root, {
      sceneFactory: () => fakeHandle,
      schedule: sched.schedule,
      now: () => clock,
      seed: 7,
    });

    const controls = [...root.querySelectorAll<HTMLButtonElement>('.wy-controls .wy-btn')];
    const pauseBtn = controls[0]!;
    const speedBtn = controls[1]!;
    const callBtn = controls[2]!;
    pauseBtn.click();
    sched.frame((clock += 16));
    expect(pauseBtn.textContent).toBe('Resume'); // pause routed
    pauseBtn.click(); // resume
    speedBtn.click();
    sched.frame((clock += 16));
    expect(speedBtn.textContent).toBe('Speed: 2x');

    callBtn.click(); // launch the wave

    // Drive frames until the run terminates (results screen appears).
    const results = root.querySelector<HTMLElement>('.wy-results')!;
    for (let i = 0; i < 4000 && results.hidden; i++) sched.frame((clock += 300));
    expect(results.hidden).toBe(false);

    // Both the title and the board are inert while the results dialog is modal — closing
    // the title-inert gap left the h1 AT-navigable (heading navigation) behind the dialog.
    const title = root.querySelector<HTMLElement>('.wy-title')!;
    const board = root.querySelector<HTMLElement>('.wy-board')!;
    expect(title.hasAttribute('inert')).toBe(true);
    expect(board.hasAttribute('inert')).toBe(true);

    const resBtns = [...results.querySelectorAll<HTMLButtonElement>('.wy-btn')];
    const playAgain = resBtns[0]!;
    const verify = resBtns[1]!;
    verify.click();
    expect(root.querySelector('.wy-verify')!.textContent).toContain('Verified');

    playAgain.click();
    expect(results.hidden).toBe(true);
    expect(fakeHandle.reset).toHaveBeenCalled();
    expect(title.hasAttribute('inert')).toBe(false); // focus-restore: neither stays inert
    expect(board.hasAttribute('inert')).toBe(false);
    app.destroy();
  });
});

describe('main — pending-aware HUD refresh while paused (#37+#27)', () => {
  it('two same-tick pending economy changes while paused produce two HUD updates', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const sched = manualSchedule();
    let clock = 0;
    const app = createApp(document, root, {
      sceneFactory: () => fakeHandle,
      schedule: sched.schedule,
      now: () => clock,
      seed: 1,
    });
    const board = root.querySelector<HTMLElement>('.wy-board')!;
    const key = (code: string): void => {
      board.dispatchEvent(new KeyboardEvent('keydown', { code, cancelable: true }));
    };
    const moveTo = (dCol: number, dRow: number): void => {
      const colKey = dCol < 0 ? 'ArrowLeft' : 'ArrowRight';
      for (let i = 0; i < Math.abs(dCol); i++) key(colKey);
      const rowKey = dRow < 0 ? 'ArrowUp' : 'ArrowDown';
      for (let i = 0; i < Math.abs(dRow); i++) key(rowKey);
    };

    // Build one tower at (3,3) while running, so there is something to sell later.
    moveTo(3, 3 - 11); // entrance row 11 → row 3
    key('Enter'); // confirm the build
    sched.frame((clock += 16)); // flush the committed tick

    const hudText = (): string => root.querySelector('.wy-hud')!.textContent ?? '';
    const pauseBtn = [...root.querySelectorAll<HTMLButtonElement>('.wy-controls .wy-btn')][0]!;
    pauseBtn.click(); // pause
    sched.frame((clock += 16));

    key('Enter'); // select the tower at (3,3)
    key('KeyX'); // sell it — one pending economy change
    sched.frame((clock += 16));
    const afterFirstSell = hudText();

    moveTo(7, 0); // (3,3) → (10,3), the other well-known buildable cell in this fixture
    key('Enter'); // build again — a second, distinct pending economy change, SAME sim tick
    sched.frame((clock += 16));
    const afterSecondBuild = hudText();

    // Both pending changes produced a real HUD refresh (bounty text differs both times) —
    // proof that `hudKey` changed on each, not just on the first (the sim tick itself never
    // advanced across any of this — the match is paused throughout).
    expect(afterSecondBuild).not.toBe(afterFirstSell);
    app.destroy();
  });
});

describe('main — input.reset() across Play-again (#40)', () => {
  it('playAgain calls input.reset() — no armed gesture from the previous run carries over', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const sched = manualSchedule();
    let clock = 0;
    const app = createApp(document, root, {
      sceneFactory: () => fakeHandle,
      schedule: sched.schedule,
      now: () => clock,
      seed: 7,
    });
    const calls = (attachInputMock as unknown as { mock: { results: { value: InputHandle }[] } })
      .mock.results;
    const inputHandle = calls[calls.length - 1]!.value;
    const resetSpy = inputHandle.reset as unknown as ReturnType<typeof vi.fn>;
    expect(resetSpy).not.toHaveBeenCalled();

    const callBtn = [...root.querySelectorAll<HTMLButtonElement>('.wy-controls .wy-btn')][2]!;
    callBtn.click(); // launch the wave
    const results = root.querySelector<HTMLElement>('.wy-results')!;
    for (let i = 0; i < 4000 && results.hidden; i++) sched.frame((clock += 300));
    expect(results.hidden).toBe(false);

    const playAgain = results.querySelectorAll<HTMLButtonElement>('.wy-btn')[0]!;
    playAgain.click();
    expect(resetSpy).toHaveBeenCalledOnce();
    app.destroy();
  });
});

describe('main — boot()', () => {
  it('returns null when there is no #app root', () => {
    expect(boot(document)).toBeNull();
  });

  it('boots against real browser globals (rAF + scene) when #app exists', () => {
    document.body.innerHTML = '<div id="app"></div>';
    let called = false;
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      if (!called) {
        called = true;
        fn(0); // run exactly one frame, then stop (avoid infinite recursion)
      }
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const handle = boot(document);
    expect(handle).not.toBeNull();
    expect(mountMock).toHaveBeenCalledOnce();
    handle!.destroy();
    vi.unstubAllGlobals();
  });

  it('honours prefers-reduced-motion at boot', () => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    // jsdom has no matchMedia; provide one that reports reduced motion.
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true });

    const handle = boot(document);
    expect(handle).not.toBeNull();
    handle!.destroy();
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    vi.unstubAllGlobals();
  });
});
