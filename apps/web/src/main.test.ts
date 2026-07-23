import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RenderHandle } from '@wynding/render';

// The Phaser scene is WebGL — mock the subpath so it never loads under jsdom. This is the
// one module excluded from coverage; here we only need a fake handle. The factory is
// hoisted above imports, so the fake handle + spy live inside it and are read back via
// the mocked module.
vi.mock('@wynding/render/scene', () => {
  const handle: RenderHandle = { draw: vi.fn(), reset: vi.fn(), destroy: vi.fn() };
  return { mount: vi.fn(() => handle) };
});

import { mount as mountMock } from '@wynding/render/scene';
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

    const resBtns = [...results.querySelectorAll<HTMLButtonElement>('.wy-btn')];
    const playAgain = resBtns[0]!;
    const verify = resBtns[1]!;
    verify.click();
    expect(root.querySelector('.wy-verify')!.textContent).toContain('Verified');

    playAgain.click();
    expect(results.hidden).toBe(true);
    expect(fakeHandle.reset).toHaveBeenCalled();
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
