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
      return { destroy: handle.destroy, reset: vi.fn(handle.reset), abort: handle.abort };
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

/** Select a Dock button by its accessible name (aria-label, else the `.wy-btn-text` span —
 *  the Dock markup contract's localized text node; the sibling `.wy-btn-icon` is
 *  `aria-hidden` glance presentation and contributes nothing to the accessible name) rather
 *  than by positional index — resilient to Dock reordering. Requires overlay.update() to
 *  have run at least once so the labels are populated. */
function dockButton(root: HTMLElement, name: string | RegExp): HTMLButtonElement {
  const btns = [...root.querySelectorAll<HTMLButtonElement>('.wy-dock .wy-btn')];
  const match = btns.find((b) => {
    const label =
      b.getAttribute('aria-label') ?? b.querySelector('.wy-btn-text')?.textContent ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (match === undefined) throw new Error(`no Dock button named ${String(name)}`);
  return match;
}

/** A Dock button's visible localized label — the `.wy-btn-text` span from the Dock markup
 *  contract, not the button's raw textContent (which also contains the aria-hidden glyph). */
function dockText(btn: HTMLButtonElement): string {
  return btn.querySelector('.wy-btn-text')?.textContent ?? '';
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

    expect(root.querySelector('.wy-wordmark')!.textContent).toBe('Wynding');
    expect(root.querySelector('.wy-board')!.getAttribute('role')).toBe('application');
    expect(fakeScene).toHaveBeenCalledOnce();

    sched.frame(16);
    sched.frame(32);
    expect(fakeHandle.draw).toHaveBeenCalled();
    expect(root.querySelector('.wy-hud')!.textContent).toContain('Lives:');
    // The frame loop copies the controller's tracers into the RenderOverlay every
    // frame (#32/P6) — present (as an array, empty here: no tower ever built) rather
    // than dropped on the way from FrameSnapshot to RenderOverlay.
    const lastOverlay = vi.mocked(fakeHandle.draw).mock.calls.at(-1)?.[3];
    expect(lastOverlay?.tracers).toEqual([]);

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
    expect(root.childElementCount).toBe(0); // no leaked shell/results/settings/rotate
    // A recreate must yield exactly one of each — not a stacked duplicate/focus target.
    const again = createApp(document, root, {
      sceneFactory: vi.fn(() => fakeHandle),
      schedule: sched.schedule,
      now: () => 0,
      seed: 2,
    });
    expect(root.querySelectorAll('.wy-wordmark')).toHaveLength(1);
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

    const board = root.querySelector<HTMLElement>('.wy-board')!;
    sched.frame((clock += 16)); // one frame so overlay.update() has run at least once
    // Select Dock buttons by accessible name (F5) — resilient to Dock reordering.
    const pauseBtn = dockButton(root, 'Pause');
    const speedBtn = dockButton(root, /^Speed:/);
    const primaryBtn = dockButton(root, 'Start');
    // Pre-start (PLAN.md P4): Pause is hidden, the primary Dock button reads Start.
    expect(pauseBtn.hidden).toBe(true);
    expect(dockText(primaryBtn)).toBe('Start');

    primaryBtn.click(); // launches the run (M1's one wave, immediately)
    // Start re-homes focus to the board (M3): overlay.update() hides the just-clicked
    // primary button, which would otherwise drop focus to document.body.
    expect(document.activeElement).toBe(board);
    sched.frame((clock += 16));
    expect(pauseBtn.hidden).toBe(false);
    expect(primaryBtn.hidden).toBe(true); // hides for the rest of the run

    pauseBtn.click();
    sched.frame((clock += 16));
    expect(dockText(pauseBtn)).toBe('Resume'); // pause routed
    pauseBtn.click(); // resume
    speedBtn.click();
    sched.frame((clock += 16));
    expect(dockText(speedBtn)).toBe('Speed: 2x');

    // Drive frames until the run terminates (results screen appears).
    const results = root.querySelector<HTMLElement>('.wy-results')!;
    for (let i = 0; i < 4000 && results.hidden; i++) sched.frame((clock += 300));
    expect(results.hidden).toBe(false);

    // The Shell (status bar + main + board + rail) is the ONLY node the modal owner ever
    // toggles inert while the results dialog is modal.
    const shellEl = root.querySelector<HTMLElement>('.wy-shell')!;
    expect(shellEl.hasAttribute('inert')).toBe(true);

    const resBtns = [...results.querySelectorAll<HTMLButtonElement>('.wy-btn')];
    const playAgain = resBtns[0]!;
    const verify = resBtns[1]!;
    verify.click();
    expect(root.querySelector('.wy-verify')!.textContent).toContain('Verified');

    playAgain.click();
    expect(results.hidden).toBe(true);
    expect(fakeHandle.reset).toHaveBeenCalled();
    expect(shellEl.hasAttribute('inert')).toBe(false); // focus-restore: no longer inert
    expect(board).toBe(document.activeElement); // Play-again returns focus to the board
    sched.frame((clock += 16));
    // Play-again returns to the pre-start state (PLAN.md P4): held again, Start required
    // again.
    expect(pauseBtn.hidden).toBe(true);
    expect(primaryBtn.hidden).toBe(false);
    expect(dockText(primaryBtn)).toBe('Start');
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

    // Build one tower at (3,3) — Pending (PLAN.md P4: pre-start planning is fully
    // available, and the shared pending projection presents it instantly regardless of
    // whether the run has been started), so there is something to sell later.
    moveTo(3, 3 - 11); // entrance row 11 → row 3
    key('Enter'); // confirm the build (Pending)
    sched.frame((clock += 16));

    const hudText = (): string => root.querySelector('.wy-hud')!.textContent ?? '';
    const pauseBtn = dockButton(root, 'Pause');
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

    sched.frame((clock += 16)); // one frame so overlay.update() populates the Dock labels
    const primaryBtn = dockButton(root, 'Start');
    primaryBtn.click(); // launches the run (M1's one wave, immediately)
    const results = root.querySelector<HTMLElement>('.wy-results')!;
    for (let i = 0; i < 4000 && results.hidden; i++) sched.frame((clock += 300));
    expect(results.hidden).toBe(false);

    const playAgain = results.querySelectorAll<HTMLButtonElement>('.wy-btn')[0]!;
    playAgain.click();
    expect(resetSpy).toHaveBeenCalledOnce();
    app.destroy();
  });
});

describe('main — fullscreen on Start (PLAN.md Story 11 P4)', () => {
  /** Install a fake Fullscreen API on the jsdom document and report the calls. */
  function stubFullscreen(): { calls: () => number; setActive: (on: boolean) => void } {
    let calls = 0;
    let active: Element | null = null;
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: () => {
        calls++;
        return Promise.resolve();
      },
    });
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => active,
    });
    return {
      calls: () => calls,
      setActive: (on) => {
        active = on ? document.documentElement : null;
      },
    };
  }

  /** A createApp harness with a controllable `(pointer: coarse)`. */
  function appWith(coarse: boolean) {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const sched = manualSchedule();
    let clock = 0;
    const app = createApp(document, root, {
      sceneFactory: () => fakeHandle,
      schedule: sched.schedule,
      now: () => clock,
      seed: 7,
      matchMedia: (query: string) => ({
        matches: query === '(pointer: coarse)' ? coarse : false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    return { root, app, frame: () => sched.frame((clock += 16)), advance: () => (clock += 300) };
  }

  it('7. requests fullscreen ONCE on the started false→true edge; repeated Start presses mid-run never re-request', () => {
    const fs = stubFullscreen();
    const { root, app, frame } = appWith(true);
    frame();
    const primaryBtn = dockButton(root, 'Start');
    primaryBtn.click();
    expect(fs.calls()).toBe(1);

    // The Dock button hides once started, but the keymapped start key stays live — pressing
    // it again mid-run must not re-request (and, in a real browser, `fullscreenElement`
    // would also already be set).
    const board = root.querySelector<HTMLElement>('.wy-board')!;
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', cancelable: true }));
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', cancelable: true }));
    expect(fs.calls()).toBe(1);
    app.destroy();
  });

  it('8. Play-again then a fresh Start requests again (the edge is re-armed, not spent)', () => {
    const fs = stubFullscreen();
    const { root, app, frame } = appWith(true);
    frame();
    dockButton(root, 'Start').click();
    expect(fs.calls()).toBe(1);

    const results = root.querySelector<HTMLElement>('.wy-results')!;
    for (let i = 0; i < 4000 && results.hidden; i++) frame();
    expect(results.hidden).toBe(false);
    results.querySelectorAll<HTMLButtonElement>('.wy-btn')[0]!.click(); // Play again
    frame();

    dockButton(root, 'Start').click();
    expect(fs.calls()).toBe(2);
    app.destroy();
  });

  it('a fine-pointer session never requests fullscreen, and Start still works', () => {
    const fs = stubFullscreen();
    const { root, app, frame } = appWith(false);
    frame();
    const primaryBtn = dockButton(root, 'Start');
    primaryBtn.click();
    frame();
    expect(fs.calls()).toBe(0);
    expect(primaryBtn.hidden).toBe(true); // the run started regardless
    app.destroy();
  });

  it('the keymapped start key routes through the SAME app-level path as the Dock button', () => {
    // Closes the bypass: `input.ts` used to call `controller.start()` directly, so the key
    // would have skipped fullscreen, the install-banner latch and the focus re-home.
    const fs = stubFullscreen();
    const { root, app, frame } = appWith(true);
    frame();
    const board = root.querySelector<HTMLElement>('.wy-board')!;
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', cancelable: true }));
    frame();
    expect(fs.calls()).toBe(1);
    expect(board.dataset.runStarted).toBe('true');
    expect(document.activeElement).toBe(board); // the same focus re-home the Dock path does
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
    // jsdom has no matchMedia; provide one that reports reduced motion. Also exercised by
    // `boot()`'s default rotate matchMedia fallback (main.ts), so it needs the same shape
    // real MediaQueryLists have — addEventListener/removeEventListener, not just `matches`.
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    });

    const handle = boot(document);
    expect(handle).not.toBeNull();
    handle!.destroy();
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    vi.unstubAllGlobals();
  });
});
