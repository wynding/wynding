import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RenderHandle } from '@wynding/render';
import type { InputHandle } from './input';
import { createKeymap } from './keymap';

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
import { createController, type Controller } from './controller';

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

    primaryBtn.click(); // unholds the run — Start no longer claims wave 1 (PLAN.md P3 step 15)
    // Start re-homes focus to the board (M3), independent of the primary control's own
    // fate — which stays visible and morphs rather than being removed from the DOM.
    expect(document.activeElement).toBe(board);
    sched.frame((clock += 16));
    expect(pauseBtn.hidden).toBe(false);
    // The primary control MORPHS rather than hiding: it stays visible for the rest of the
    // run (Call wave), hiding only once the run is terminal — later waves auto-launch on
    // their own countdown below without a further primary-button press.
    expect(primaryBtn.hidden).toBe(false);
    expect(dockText(primaryBtn)).toBe('Call wave');

    pauseBtn.click();
    sched.frame((clock += 16));
    expect(dockText(pauseBtn)).toBe('Resume'); // pause routed
    pauseBtn.click(); // resume
    speedBtn.click();
    sched.frame((clock += 16));
    expect(dockText(speedBtn)).toBe('Speed: 2x');

    // Drive frames until the run terminates (results screen appears) — later waves
    // auto-launch on their own countdown even without further primary-button presses.
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

describe('main — Score chip across a run and Play-again (#53)', () => {
  /** The Score chip's displayed number, read off the chip's full ICU message node (the
   *  accessible text) rather than the chip's raw textContent, which also carries the
   *  aria-hidden glance glyph. */
  function scoreChip(root: HTMLElement): number {
    const text = root.querySelector('[data-wy-chip="score"] .wy-chip-full')?.textContent ?? '';
    const digits = /-?\d+/.exec(text);
    if (digits === null) throw new Error(`no number in Score chip text: ${JSON.stringify(text)}`);
    return Number(digits[0]);
  }

  it('reads 0 before Start, shows the terminal score at resolution, and is back to 0 the instant Play-again is clicked', () => {
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
    sched.frame((clock += 16)); // one frame so the HUD has been painted at least once

    // The defect in the screenshot: on first load, before anything is started, the chip
    // rendered the terminal formula's survival term (startingLives × survivalMul = 250).
    expect(scoreChip(root)).toBe(0);

    // Build one tower beside the entrance lane so this run actually SCORES — the plain
    // undefended fixture used elsewhere in this file ends at 0, which would make the
    // Play-again assertion below pass with or without the fix.
    for (let i = 0; i < 3; i++) key('ArrowRight');
    for (let i = 0; i < 2; i++) key('ArrowUp'); // entrance row 11 → row 9
    key('Enter'); // confirm the build
    sched.frame((clock += 16));

    dockButton(root, 'Start').click();
    const results = root.querySelector<HTMLElement>('.wy-results')!;
    for (let i = 0; i < 4000 && results.hidden; i++) sched.frame((clock += 300));
    expect(results.hidden).toBe(false);

    // At resolution the chip carries the authoritative total, survival term included.
    const terminalScore = scoreChip(root);
    expect(terminalScore).toBeGreaterThan(0);

    // The seam this test exists for: the repaint must be synchronous with the click, not
    // deferred to the next scheduled frame — no frame is driven between these two lines,
    // and in a throttled background tab there might not be one for a long while.
    results.querySelectorAll<HTMLButtonElement>('.wy-btn')[0]!.click(); // Play again
    expect(scoreChip(root)).toBe(0);

    app.destroy();
  });
});

// ---------------------------------------------------------------------------------------
// The home affordance: its visibility contract, the app-level pause seam every pause caller
// now routes through, and the live-run exit guard `main.ts` owns.
//
// The visibility rule is: VISIBLE while held pre-start, while paused, and once the run
// resolves; HIDDEN for any started-and-unpaused moment (including the started countdown).
// Every assertion below that says "with NO frame driven" is the point of the whole design:
// the frame memo is not the trigger, so a throttled or missing rAF can never leave the link
// interactable in a stale state.
// ---------------------------------------------------------------------------------------

/** The home link, and the two attributes `overlay.ts` drives together. `data-live` is the
 *  CSS hook (opacity/pointer-events); `inert` is what actually removes the tab stop and every
 *  activation path, which is why both are asserted every time rather than just the visible one. */
function homeLink(root: HTMLElement): HTMLAnchorElement {
  return root.querySelector<HTMLAnchorElement>('a.wy-home')!;
}
function homeState(root: HTMLElement): { live: boolean; inert: boolean } {
  const el = homeLink(root);
  return { live: el.hasAttribute('data-live'), inert: el.hasAttribute('inert') };
}
const VISIBLE = { live: false, inert: false };
const HIDDEN = { live: true, inert: true };

interface HomeAppOptions {
  readonly navigate?: (href: string) => void;
  readonly controllerFactory?: (seed: number) => Controller;
  readonly matchMedia?: (query: string) => {
    matches: boolean;
    addEventListener: (t: 'change', l: () => void) => void;
    removeEventListener: (t: 'change', l: () => void) => void;
  };
}

/** An app wired for the home-link tests: manual scheduler (so "no frame driven" is literal),
 *  an injected `navigate` (jsdom cannot navigate, and a real one would take the runner with
 *  it), plus the board-key helper the guard tests drive Start/pause through. */
function homeApp(options: HomeAppOptions = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const sched = manualSchedule();
  let clock = 0;
  const navigate = vi.fn(options.navigate ?? (() => {}));
  const app = createApp(document, root, {
    sceneFactory: () => fakeHandle,
    schedule: sched.schedule,
    now: () => clock,
    seed: 1,
    navigate,
    ...(options.matchMedia === undefined ? {} : { matchMedia: options.matchMedia }),
    ...(options.controllerFactory === undefined
      ? {}
      : { controllerFactory: options.controllerFactory }),
  });
  const board = root.querySelector<HTMLElement>('.wy-board')!;
  return {
    root,
    app,
    navigate,
    board,
    home: homeLink(root),
    shell: root.querySelector<HTMLElement>('.wy-shell')!,
    frame: (): void => sched.frame((clock += 16)),
    /** A board-scoped keydown — the keymapped route (pause is Space, start is KeyC). */
    key: (code: string): void => {
      board.dispatchEvent(new KeyboardEvent('keydown', { code, cancelable: true }));
    },
    /** A plain left-click, the only activation the guard is allowed to intercept. */
    click: (init: MouseEventInit = {}): MouseEvent => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
      homeLink(root).dispatchEvent(e);
      return e;
    },
    state: (): { live: boolean; inert: boolean } => homeState(root),
  };
}

describe('main — keymap/button activation parity for the morphed primary control', () => {
  it('the keymapped call never reaches the controller while the control is exposed as disabled', () => {
    // The Dock button's click guard suppresses activation on `aria-disabled`;
    // `primaryAction`'s `callWaveReady` gate must give the keymapped route the
    // SAME semantics — otherwise a full-buffer press through the keyboard
    // announces a `pendingCap` rejection for a control the UI presents as
    // disabled. Constructing a genuinely full buffer through the DOM is
    // prohibitively slow, so the injected wrapper forces the disabled UI state
    // directly and counts what reaches the controller: while disabled, zero
    // dispatches; re-enabled, the SAME press dispatches — both directions pinned,
    // so a permanently-closed gate or one reading a boot-time-cached uiState
    // (the exact stale-read regression class) fails here too.
    let dispatches = 0;
    let forceDisabled = true;
    const h = homeApp({
      controllerFactory: (seed) => {
        const real = createController(seed);
        const wrapped: Controller = {
          ...real,
          uiState: () =>
            forceDisabled ? { ...real.uiState(), callWaveReady: false } : real.uiState(),
          callWaveEarly: () => {
            dispatches++;
            return real.callWaveEarly();
          },
        };
        return wrapped;
      },
    });
    h.frame();
    h.key('KeyC'); // Start — the `!started` branch, unaffected by the gate
    h.frame();
    expect(h.board.dataset.started).toBe('true');
    h.key('KeyC'); // the press under test: exposed-disabled, must not dispatch
    h.frame();
    expect(dispatches).toBe(0);
    expect(h.board.dataset.simPhase).toBe('running');
    // The enabled leg runs against the REAL state (no fiction): the same press
    // must now reach the controller — kills the closed-gate and cached-uiState
    // mutants the disabled leg alone cannot see.
    forceDisabled = false;
    h.key('KeyC');
    h.frame();
    expect(dispatches).toBe(1);
    h.app.destroy();
  });
});

describe('main — home link visibility (hidden only while the run is live)', () => {
  it('is visible and interactive while the run is HELD pre-start', () => {
    const h = homeApp();
    h.frame();
    expect(h.state()).toEqual(VISIBLE);
    h.app.destroy();
  });

  it('hides on Start with NO frame driven — including through the started countdown', () => {
    const h = homeApp();
    h.frame();
    expect(h.state()).toEqual(VISIBLE);

    dockButton(h.root, 'Start').click();
    // The seam: no frame between the click and this assertion. The run is now started but
    // still counting down toward wave 1 — the sim's own phase is unchanged (`running`
    // either way), which is exactly why the rule reads `ui.started` rather than the phase.
    expect(h.state()).toEqual(HIDDEN);
    expect(h.board.dataset.simPhase).toBe('running');
    // Hiding must not strand focus inside the link (see the RESUME case below): Start re-homes
    // focus to the board, so nothing is left pointing at a node that just left the tab order.
    expect(h.home.contains(document.activeElement)).toBe(false);
    h.app.destroy();
  });

  // ONE no-frame assertion PER pause caller. A generic "pause makes it visible" test would
  // pass while three of these five paths still called the controller directly and left the
  // link hidden until some later frame happened to land.
  it('pause caller 1/5 — the KEYMAPPED pause key flips it visible with NO frame driven', () => {
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    expect(h.state()).toEqual(HIDDEN);
    h.key('Space');
    expect(h.state()).toEqual(VISIBLE);
    h.app.destroy();
  });

  it('pause caller 2/5 — the DOCK pause button flips it visible with NO frame driven', () => {
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    h.frame(); // let the Dock relabel; the assertion below still drives no frame
    expect(h.state()).toEqual(HIDDEN);
    dockButton(h.root, 'Pause').click();
    expect(h.state()).toEqual(VISIBLE);
    h.app.destroy();
  });

  it('pause caller 3/5 — the SETTINGS auto-pause flips it visible with NO frame driven', () => {
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    expect(h.state()).toEqual(HIDDEN);
    dockButton(h.root, 'Settings').click();
    expect(h.state()).toEqual(VISIBLE);
    h.app.destroy();
  });

  it('pause caller 4/5 — the ROTATE auto-pause flips it visible with NO frame driven', () => {
    // Both gates start non-matching so the app boots in landscape, then flip to
    // portrait+coarse — the real entry path, driven through main.ts's injected matchMedia.
    const listeners: (() => void)[] = [];
    let matching = false;
    const h = homeApp({
      matchMedia: () => ({
        get matches() {
          return matching;
        },
        addEventListener: (_t, l) => void listeners.push(l),
        removeEventListener: () => {},
      }),
    });
    h.frame();
    dockButton(h.root, 'Start').click();
    expect(h.state()).toEqual(HIDDEN);

    matching = true; // portrait AND coarse now match
    for (const l of [...listeners]) l();
    expect(h.state()).toEqual(VISIBLE);
    h.app.destroy();
  });

  it('pause caller 5/5 — the LEAVE GUARD defensive pause flips it visible with NO frame driven', () => {
    // The guard must not depend on the visibility rule having already hidden the link: it
    // pauses for itself. Invoke it on a started, UNPAUSED run — the state the rule says
    // should be unreachable — and the run must be paused before the dialog opens.
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    expect(h.state()).toEqual(HIDDEN);

    h.click();
    expect(h.state()).toEqual(VISIBLE);
    expect(h.root.querySelector<HTMLElement>('.wy-leave')!.hidden).toBe(false);
    h.app.destroy();
  });

  it('hides again on RESUME, with no frame driven', () => {
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    h.key('Space'); // pause
    expect(h.state()).toEqual(VISIBLE);
    h.key('Space'); // resume
    expect(h.state()).toEqual(HIDDEN);
    // …and hiding never STRANDS focus. `visibility: hidden` drops the tab stop, so if focus
    // were inside the link at that moment it would fall to `document.body` and a keyboard
    // player would lose their place. Safe today only because every resume route puts focus
    // elsewhere first — which is a property worth asserting rather than assuming, since a
    // future document-scoped pause binding would break it with every other test still green.
    expect(document.activeElement).not.toBe(h.home);
    expect(h.home.contains(document.activeElement)).toBe(false);
    h.app.destroy();
  });

  it('is visible once the run RESOLVES — orientation-only behind the results dialog', () => {
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    const results = h.root.querySelector<HTMLElement>('.wy-results')!;
    for (let i = 0; i < 4000 && results.hidden; i++) h.frame();
    expect(results.hidden).toBe(false);

    // Visible, and NOT self-inert — but unreachable all the same, because the modal owner
    // inerts the whole Shell while the (deliberately non-dismissible) results dialog is up.
    // That is the ratified "terminal is orientation-only" contract: branding, not a control.
    expect(h.state()).toEqual(VISIBLE);
    expect(h.shell.hasAttribute('inert')).toBe(true);
    expect(h.shell.contains(h.home)).toBe(true);
    h.app.destroy();
  });

  it('is visible AND actionable again after Play-again, with no frame driven', () => {
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    const results = h.root.querySelector<HTMLElement>('.wy-results')!;
    for (let i = 0; i < 4000 && results.hidden; i++) h.frame();

    results.querySelectorAll<HTMLButtonElement>('.wy-btn')[0]!.click(); // Play again
    // No frame driven: the fresh run is held and un-ticking, so waiting for one could mean
    // waiting forever in a throttled tab.
    expect(h.state()).toEqual(VISIBLE);
    expect(h.shell.hasAttribute('inert')).toBe(false); // results closed → shell interactive
    // Actionable: a held pre-start run navigates natively — no guard, no dialog.
    const e = h.click();
    expect(e.defaultPrevented).toBe(false);
    expect(h.root.querySelector<HTMLElement>('.wy-leave')!.hidden).toBe(true);
    h.app.destroy();
  });
});

describe('main — the app-level pause seam (ensurePaused)', () => {
  // The guard that used to be inlined in overlay.ts and rotate.ts lives here now, so this is
  // where it is proven — against the REAL controller, not a fake that re-states it.
  it('is a no-op pre-start: a settings round-trip while HELD leaves the next Start able to run', () => {
    // The `!started` half of the guard is LOAD-BEARING, not defensive. `controller.pause()`
    // is a bare `paused = true` with no started check of its own, and `advance()` returns
    // early while `paused` — so pausing a held run leaves `paused` invisibly true, and the
    // Start that follows sets `started` without ever clearing it: the board freezes at tick 0
    // forever with the Dock reading "Resume" and nothing explaining why. A phone user rotating
    // to portrait before pressing Start reaches this the same way.
    //
    // So the assertion has to be that the run ACTUALLY RUNS afterwards. An earlier version of
    // this test checked only pre-start conditions (the link still VISIBLE, `runStarted` still
    // false) — all of which stay true whether or not the held run got paused, so it passed
    // with the guard deleted. Mutation-checked: removing `!controller.uiState().started` from
    // `ensurePaused` now fails this test.
    const h = homeApp();
    h.frame();
    // Pre-start the Pause control is HIDDEN (present in the DOM, but not an affordance) —
    // there is nothing to pause yet.
    expect(dockButton(h.root, /Pause|Resume/).hidden).toBe(true);

    dockButton(h.root, 'Settings').click(); // asks the seam on a HELD run
    h.root.parentElement!.querySelector<HTMLButtonElement>('.wy-settings-close')!.click();

    dockButton(h.root, 'Start').click();
    for (let i = 0; i < 20; i++) h.frame();
    expect(
      Number(h.board.dataset.simTick),
      'the sim never advanced — a pre-start pause left `paused` true through Start',
    ).toBeGreaterThan(0);
    expect(dockButton(h.root, /Pause|Resume/).getAttribute('aria-pressed')).toBe('false');
    h.app.destroy();
  });

  it('never resumes a run that was already paused — a second ask leaves it paused', () => {
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    h.key('Space'); // paused
    h.frame();
    // The button reads "Resume" while paused — `aria-pressed` is the state, not the label.
    expect(dockButton(h.root, /Pause|Resume/).getAttribute('aria-pressed')).toBe('true');

    dockButton(h.root, 'Settings').click(); // asks again, on an already-paused run
    h.frame();
    // This pins the OUTCOME a player can observe — the run stays paused, settings never
    // resumes it — and deliberately does NOT claim to pin the guard's `isPaused()` early
    // return. That branch is unobservable by construction: `controller.pause()` is idempotent,
    // so skipping it and running it produce the identical state, and the only difference is
    // one redundant `refreshHud()`. Asserting it would need a spy on a module-private seam;
    // saying so is better than a test whose name implies coverage it cannot have.
    expect(dockButton(h.root, /Pause|Resume/).getAttribute('aria-pressed')).toBe('true');
    expect(h.state()).toEqual(VISIBLE);
    h.app.destroy();
  });
});

describe('main — the live-run exit guard (owned by main.ts)', () => {
  function openLeave(h: ReturnType<typeof homeApp>): HTMLElement {
    h.frame();
    dockButton(h.root, 'Start').click();
    h.key('Space'); // pause — the state the link is actually reachable in
    h.click();
    return h.root.querySelector<HTMLElement>('.wy-leave')!;
  }

  it('a plain click on a live run opens the leave dialog, focuses Stay, and does not navigate', () => {
    const h = homeApp();
    const leave = openLeave(h);
    expect(leave.hidden).toBe(false);
    expect(h.navigate).not.toHaveBeenCalled();
    // Initial focus on the SAFE action.
    expect(document.activeElement).toBe(leave.querySelector('.wy-leave-stay'));
    // Registered on the modal owner like every other dialog — the Shell is inert while it is up.
    expect(h.shell.hasAttribute('inert')).toBe(true);
    h.app.destroy();
  });

  it('Stay closes it, navigates nowhere, and restores focus to the link', () => {
    const h = homeApp();
    const leave = openLeave(h);
    leave.querySelector<HTMLButtonElement>('.wy-leave-stay')!.click();
    expect(leave.hidden).toBe(true);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.shell.hasAttribute('inert')).toBe(false);
    // The guard focuses the link itself before opening, precisely so this is deterministic:
    // browsers disagree about whether clicking an anchor focuses it (Safari does not), and
    // jsdom's synthetic click does not either — so relying on the click would make the
    // restore target vary by engine.
    expect(document.activeElement).toBe(h.home);
    h.app.destroy();
  });

  it('Escape means Stay — consumed as a dismissal, still no navigation', () => {
    const h = homeApp();
    const leave = openLeave(h);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
    expect(leave.hidden).toBe(true);
    expect(h.navigate).not.toHaveBeenCalled();
    h.app.destroy();
  });

  it('Confirm navigates to the site root — the same href the anchor itself carries', () => {
    const h = homeApp();
    const leave = openLeave(h);
    leave.querySelector<HTMLButtonElement>('.wy-leave-confirm')!.click();
    expect(h.navigate).toHaveBeenCalledWith('/');
    expect(h.home.getAttribute('href')).toBe('/');
    expect(leave.hidden).toBe(true);
    h.app.destroy();
  });

  it('MODIFIED activations are never intercepted — real-link semantics survive', () => {
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    h.key('Space'); // paused mid-run: the guard WOULD fire on a plain click here
    const leave = h.root.querySelector<HTMLElement>('.wy-leave')!;

    // Each of these must reach the browser untouched (cmd/ctrl-click = new tab, shift = new
    // window, alt = download//save), so `preventDefault()` must NOT have been called.
    //
    // Middle-click is deliberately NOT in this list: browsers dispatch `auxclick`, never
    // `click`, for a non-primary button, so a synthetic `click` with `button: 1` is an event
    // no browser produces and asserting on it would prove nothing. The guard's `e.button !== 0`
    // check is kept as cheap defence-in-depth against a future synthetic dispatcher, not
    // because a real middle-click reaches it.
    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      const e = h.click(init);
      expect(e.defaultPrevented, `modified click ${JSON.stringify(init)} was intercepted`).toBe(
        false,
      );
      expect(leave.hidden).toBe(true);
    }
    expect(h.navigate).not.toHaveBeenCalled();
    h.app.destroy();
  });

  /** Queue a tower into the pre-start buffer via the keyboard cursor, WITHOUT starting the
   *  run — the planning path `effectiveCap()` reserves a slot for. Returns the resulting
   *  pending count so a caller can assert the plan survived something. */
  function planTowerWhileHeld(h: ReturnType<typeof homeApp>): number {
    for (let i = 0; i < 3; i++) h.key('ArrowRight');
    for (let i = 0; i < 2; i++) h.key('ArrowUp'); // entrance row 11 → row 9
    h.key('Enter'); // confirm the build — buffered, not committed (the run is held)
    h.frame();
    const pending = Number(h.board.dataset.pendingAdds);
    expect(pending, 'fixture failed to queue a pre-start tower').toBeGreaterThan(0);
    expect(h.board.dataset.started).toBe('false'); // still HELD — that is the point
    return pending;
  }

  it('a HELD and EMPTY click navigates natively — there really is nothing to lose', () => {
    const h = homeApp();
    h.frame();
    expect(h.board.dataset.pendingAdds).toBe('0');
    const e = h.click();
    expect(e.defaultPrevented).toBe(false);
    expect(h.root.querySelector<HTMLElement>('.wy-leave')!.hidden).toBe(true);
    expect(h.navigate).not.toHaveBeenCalled(); // the browser does it, not us
    h.app.destroy();
  });

  it('a HELD click WITH a buffered plan is intercepted — and Stay keeps the plan', () => {
    // The original guard tested `started` alone, on the stated premise that a held run has
    // nothing in progress to lose. It does: pre-start builds are buffered, so tapping the mark
    // silently discarded a layout that the identical click one keypress later would have
    // protected (PLAN.md Amendment 1).
    const h = homeApp();
    h.frame();
    const planned = planTowerWhileHeld(h);

    const e = h.click();
    expect(e.defaultPrevented, 'a queued plan must be guarded like a live run').toBe(true);
    const leave = h.root.querySelector<HTMLElement>('.wy-leave')!;
    expect(leave.hidden).toBe(false);
    expect(h.navigate).not.toHaveBeenCalled();

    // The assertion that matters most: the dialog must not eat the thing it is protecting.
    // `showLeave` aborts in-flight POINTER gestures, which is a different buffer entirely —
    // this pins that they stay different.
    leave.querySelector<HTMLButtonElement>('.wy-leave-stay')!.click();
    h.frame();
    expect(Number(h.board.dataset.pendingAdds), 'Stay discarded the buffered plan').toBe(planned);
    expect(h.board.dataset.started).toBe('false'); // still held, still planning
    h.app.destroy();
  });

  it('Confirm from a held-with-plan state navigates, exactly like the live-run path', () => {
    const h = homeApp();
    h.frame();
    planTowerWhileHeld(h);
    h.click();
    h.root
      .querySelector<HTMLElement>('.wy-leave')!
      .querySelector<HTMLButtonElement>('.wy-leave-confirm')!
      .click();
    expect(h.navigate).toHaveBeenCalledWith('/');
    h.app.destroy();
  });

  it('a TERMINAL click navigates natively — the run is already over', () => {
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    const results = h.root.querySelector<HTMLElement>('.wy-results')!;
    for (let i = 0; i < 4000 && results.hidden; i++) h.frame();
    // The results dialog is left OPEN on purpose — closing it is not what this test is about,
    // and Play-again would restart the run and destroy the terminal state being tested. The
    // guard reads `isTerminal()`, which is true here regardless of what is on screen, so
    // dispatching the click straight at the link exercises exactly the branch in question.
    // (A real player reaches this state via Play-again, covered by the Play-again test above.)
    const e = h.click();
    expect(e.defaultPrevented).toBe(false);
    expect(h.root.querySelector<HTMLElement>('.wy-leave')!.hidden).toBe(true);
    h.app.destroy();
  });

  it('reads the run state at CLICK TIME, never cached at wiring time', () => {
    const h = homeApp();
    h.frame();
    const leave = h.root.querySelector<HTMLElement>('.wy-leave')!;

    h.click(); // held → native, no dialog
    expect(leave.hidden).toBe(true);

    dockButton(h.root, 'Start').click();
    h.key('Space');
    h.click(); // the SAME listener, now on a live run → intercepted
    expect(leave.hidden).toBe(false);
    h.app.destroy();
  });
});

describe('main — the DEFAULT navigate dep (the real, irreversible exit)', () => {
  it('drives the view’s own location.assign, not just an injected stub', () => {
    // Every other test in this file injects `deps.navigate`, so the production path —
    // `doc.defaultView?.location.assign(href)` — was executed by nothing at all. That is the
    // ONE irreversible action this feature adds, and a typo in it (wrong view, `replace`
    // instead of `assign`, a dropped `?.`) would have shipped green behind a passing stub.
    //
    // `window.location` cannot be reassigned under jsdom, so the seam is the `doc` argument
    // itself: a proxy that serves a fake `defaultView` and forwards everything else to the
    // real document. `createApp` genuinely builds its DOM through this proxy, so the code
    // under test is the real wiring, not a re-implementation of it.
    const assign = vi.fn();
    const realView = window;
    const fakeView = new Proxy(realView, {
      get: (t, p) => (p === 'location' ? { assign } : Reflect.get(t, p, t)),
    });
    const docProxy = new Proxy(document, {
      get: (t, p) => {
        if (p === 'defaultView') return fakeView;
        const v = Reflect.get(t, p, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as Document;

    const root = document.createElement('div');
    document.body.appendChild(root);
    const sched = manualSchedule();
    let clock = 0;
    const app = createApp(docProxy, root, {
      sceneFactory: () => fakeHandle,
      schedule: sched.schedule,
      now: () => clock,
      seed: 1,
      // deliberately NO `navigate` — this test exists to exercise the default
    });

    const board = root.querySelector<HTMLElement>('.wy-board')!;
    sched.frame((clock += 16));
    dockButton(root, 'Start').click();
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', cancelable: true })); // pause

    homeLink(root).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    );
    const leave = root.parentElement!.querySelector<HTMLElement>('.wy-leave')!;
    expect(leave.hidden).toBe(false);
    expect(assign).not.toHaveBeenCalled(); // opening the dialog must never navigate

    leave.querySelector<HTMLButtonElement>('.wy-leave-confirm')!.click();
    expect(assign).toHaveBeenCalledWith('/');
    expect(assign).toHaveBeenCalledTimes(1);

    app.destroy();
  });
});

describe('main — in-app reduced motion is reflected onto the Shell', () => {
  const ATTR = 'data-wy-reduced-motion';

  it('initializes from the first settings snapshot and follows the toggle', () => {
    const h = homeApp();
    expect(h.shell.hasAttribute(ATTR)).toBe(false);

    const toggle = h.root.parentElement!.querySelector<HTMLInputElement>(
      '.wy-settings .wy-toggle input',
    )!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(h.shell.hasAttribute(ATTR)).toBe(true);

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(h.shell.hasAttribute(ATTR)).toBe(false);
    h.app.destroy();
  });

  it('starts set when the OS query already prefers reduced motion', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const sched = manualSchedule();
    const app = createApp(document, root, {
      sceneFactory: () => fakeHandle,
      schedule: sched.schedule,
      now: () => 0,
      seed: 1,
      prefersReducedMotion: true,
    });
    expect(root.querySelector('.wy-shell')!.hasAttribute(ATTR)).toBe(true);
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

  // The default binding of the start action — bound from the keymap rather than hardcoded, so
  // a rebind of the default never silently strands these keydowns on a stale 'KeyC'.
  const START_KEY = createKeymap().codeFor('start')!;

  // Each test creates an app via `appWith`; tear them all down here rather than trailing an
  // `app.destroy()` on every test.
  const createdApps: ReturnType<typeof createApp>[] = [];
  afterEach(() => {
    for (const app of createdApps.splice(0)) app.destroy();
  });

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
    createdApps.push(app);
    return { root, app, frame: () => sched.frame((clock += 16)), advance: () => (clock += 300) };
  }

  it('requests fullscreen ONCE on the started false→true edge; repeated Start presses mid-run never re-request', () => {
    const fs = stubFullscreen();
    const { root, frame } = appWith(true);
    frame();
    const primaryBtn = dockButton(root, 'Start');
    primaryBtn.click();
    expect(fs.calls()).toBe(1);

    // The Dock button hides once started, but the keymapped start key stays live — pressing
    // it again mid-run must not re-request (and, in a real browser, `fullscreenElement`
    // would also already be set).
    const board = root.querySelector<HTMLElement>('.wy-board')!;
    board.dispatchEvent(new KeyboardEvent('keydown', { code: START_KEY, cancelable: true }));
    board.dispatchEvent(new KeyboardEvent('keydown', { code: START_KEY, cancelable: true }));
    expect(fs.calls()).toBe(1);
  });

  it('Play-again then a fresh Start requests again (the edge is re-armed, not spent)', () => {
    const fs = stubFullscreen();
    const { root, frame } = appWith(true);
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
  });

  it('a fine-pointer session never requests fullscreen, and Start still works', () => {
    const fs = stubFullscreen();
    const { root, frame } = appWith(false);
    frame();
    const primaryBtn = dockButton(root, 'Start');
    primaryBtn.click();
    frame();
    expect(fs.calls()).toBe(0);
    // The run started regardless — the control morphs to "Call wave" rather than hiding.
    expect(primaryBtn.hidden).toBe(false);
    expect(dockText(primaryBtn)).toBe('Call wave');
  });

  it('the keymapped start key routes through the SAME app-level path as the Dock button', () => {
    // Closes the bypass: `input.ts` used to call `controller.start()` directly, so the key
    // would have skipped fullscreen, the install-banner latch and the focus re-home.
    const fs = stubFullscreen();
    const { root, frame } = appWith(true);
    frame();
    const board = root.querySelector<HTMLElement>('.wy-board')!;
    board.dispatchEvent(new KeyboardEvent('keydown', { code: START_KEY, cancelable: true }));
    frame();
    expect(fs.calls()).toBe(1);
    expect(board.dataset.started).toBe('true');
    expect(document.activeElement).toBe(board); // the same focus re-home the Dock path does
  });

  it('pressing the start key MID-RUN does not steal focus (the re-home is edge-gated too)', () => {
    // `controller.start()` is a no-op once started, so yanking focus to the board would cost
    // a keyboard player their place on the Card or the chips scrollport for nothing.
    stubFullscreen();
    const { root, frame } = appWith(true);
    frame();
    dockButton(root, 'Start').click();
    frame();

    const card = root.querySelector<HTMLElement>('.wy-card')!;
    card.focus();
    expect(document.activeElement).toBe(card);
    root
      .querySelector<HTMLElement>('.wy-board')!
      .dispatchEvent(new KeyboardEvent('keydown', { code: START_KEY, cancelable: true }));
    expect(document.activeElement).toBe(card);
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
