import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RenderHandle } from '@wynding/render';
import type { InputHandle } from './input';
import { createKeymap } from './keymap';
import { MS_PER_TICK, isTerminalPhase, type SimPhase } from '@wynding/sim';

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
      // `abort` is spied for the same reason `reset` is: it wraps the REAL implementation,
      // so every other test keeps genuine gesture behaviour, and the #139 backgrounding
      // test can still see that the captured gesture was cancelled.
      return { destroy: handle.destroy, reset: vi.fn(handle.reset), abort: vi.fn(handle.abort) };
    }),
  };
});

// The swatch painter is jsdom-inert by contract (null 2D context — vitest.setup.ts), so a
// spy is the only observable for `main.ts`'s wiring: painted at boot, repainted ONLY on a
// real colour-mode change.
vi.mock('./swatch', () => ({ paintSwatch: vi.fn() }));

import { mount as mountMock } from '@wynding/render/scene';
import { paintSwatch } from './swatch';
import { attachInput as attachInputMock } from './input';
import { createApp, boot, type Scheduler } from './main';
import { COMPACT_QUERY } from './layout';
import { createController, type Controller } from './controller';
import type { WakeLockApi } from './wakelock';
import { fakeWakeLock } from './wakelock-fakes';

// The shared fake handle the mocked scene returns (same object every mount call).
const fakeHandle = (mountMock as unknown as () => RenderHandle)();

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

/** The clock step every harness in this file advances by per frame (~60 Hz). */
const FRAME_MS = 16;
/** Frames needed to cross one sim tick. Since #70 the Start press leaves its wave-1 claim
 *  BUFFERED, and the primary control is legitimately not call-ready until a tick consumes
 *  it — so any test asserting the settled post-Start state must drive at least this many
 *  frames first, or it asserts against a transient and proves nothing. Derived from
 *  `MS_PER_TICK` rather than written as `4`, so a change to the tick period moves it. */
const FRAMES_PER_SIM_TICK = Math.ceil(MS_PER_TICK / FRAME_MS);

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
    openApps.push(app); // torn down even if an assertion throws first

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
    openApps.push(app); // torn down even if an assertion throws first
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
    openApps.push(app); // torn down even if an assertion throws first

    const board = root.querySelector<HTMLElement>('.wy-board')!;
    sched.frame((clock += 16)); // one frame so overlay.update() has run at least once
    // Select Dock buttons by accessible name (F5) — resilient to Dock reordering.
    const pauseBtn = dockButton(root, 'Pause');
    const speedBtn = dockButton(root, /^Speed:/);
    const primaryBtn = dockButton(root, 'Start');
    // Pre-start (PLAN.md P4): Pause is hidden, the primary Dock button reads Start.
    expect(pauseBtn.hidden).toBe(true);
    expect(dockText(primaryBtn)).toBe('Start');

    primaryBtn.click(); // Start CLAIMS wave 1 and then unholds the run (#70)
    // Start re-homes focus to the board (M3), independent of the primary control's own
    // fate — which stays visible and morphs rather than being removed from the DOM.
    expect(document.activeElement).toBe(board);
    sched.frame((clock += 16));
    expect(pauseBtn.hidden).toBe(false);
    // The primary control MORPHS rather than hiding: it stays visible for the rest of the
    // run (Call wave), hiding only once the run is terminal — later waves auto-launch on
    // their own countdown below without a further primary-button press.
    expect(primaryBtn.hidden).toBe(false);
    // Start's own wave-1 claim sits BUFFERED until the next sim tick consumes it, so the
    // control reads 'Launching…' across this 16 ms frame — a sim tick is 50 ms. Pinned
    // rather than skipped past: it is the visible half of the claim-first composition.
    expect(dockText(primaryBtn)).toBe('Launching…');
    sched.frame((clock += MS_PER_TICK + FRAME_MS)); // >= one sim tick: the claim is consumed
    expect(dockText(primaryBtn)).toBe('Call wave'); // now offering wave 2

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
    openApps.push(app); // torn down even if an assertion throws first

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
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' })); // arm the basic Card (M2-S3)
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
function homeLink(root: HTMLElement): HTMLElement {
  // Queried by CLASS, not by `a.wy-home`: when hosted the identical mark ships as a `span`
  // (ADR 0012, #146) and the auto-hide contract below applies to both forms. Whether it is
  // an anchor at all is asserted where that is the subject — `shell.test.ts` and the hosted
  // describe further down.
  return root.querySelector<HTMLElement>('.wy-home')!;
}
function homeState(root: HTMLElement): { live: boolean; inert: boolean } {
  const el = homeLink(root);
  return { live: el.hasAttribute('data-live'), inert: el.hasAttribute('inert') };
}
const VISIBLE = { live: false, inert: false };
const HIDDEN = { live: true, inert: true };

/** Every app `homeApp` built this test, torn down afterwards whatever happened. See the
 *  note inside `homeApp` for why a trailing `destroy()` is not enough any more. */
const openApps: { destroy: () => void }[] = [];
afterEach(() => {
  for (const a of openApps.splice(0)) a.destroy();
});
// The shared `document`'s visibility patch, restored after EVERY test whatever it did — in
// one place, beside the app registry, rather than per-describe where the order would depend
// on which block happened to register a hook. Not optional: without it a test that sets
// `hidden` leaves it hidden for the whole rest of the file, and every later wake-lock
// assertion fails on a predicate term that has nothing to do with what it is testing.
// (`restoreVisibility` is a hoisted function declaration, so registering it here is fine.)
afterEach(restoreVisibility);

interface HomeAppOptions {
  readonly navigate?: (href: string) => void;
  readonly controllerFactory?: (seed: number) => Controller;
  readonly matchMedia?: (query: string) => {
    matches: boolean;
    addEventListener: (t: 'change', l: () => void) => void;
    removeEventListener: (t: 'change', l: () => void) => void;
  };
  /** The host declaration (ADR 0012). Omitted by every pre-existing test, which is the
   *  point: absent means not hosted, so they all still describe the web build. */
  readonly hosted?: boolean;
  /** `navigator.wakeLock` (#140). `null` is "this platform has none"; omitted falls through
   *  to the real navigator, which under jsdom has none either. */
  readonly wakeLock?: WakeLockApi | null;
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
    ...(options.hosted === undefined ? {} : { hosted: options.hosted }),
    ...(options.wakeLock === undefined ? {} : { wakeLock: options.wakeLock }),
    ...(options.controllerFactory === undefined
      ? {}
      : { controllerFactory: options.controllerFactory }),
  });
  openApps.push(app); // torn down even if an assertion throws first
  const board = root.querySelector<HTMLElement>('.wy-board')!;
  // Teardown registered AT CREATION, not trailing each test body. A trailing `destroy()`
  // never runs if an assertion throws first — and this phase is what first puts
  // `visibilitychange`/`pagehide` listeners on the SHARED `document`/`window`, so a leaked
  // app then reaches a torn-down controller in every later test in this file. One genuine
  // failure would cascade into spurious ones and bury its own cause. Registering here rather
  // than at each call site covers the ~30 pre-existing ones too, and `destroy` is IDEMPOTENT
  // so their trailing calls — and the tests whose subject IS teardown — stay valid.
  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    app.destroy();
  };
  openApps.push({ destroy });
  return {
    root,
    app: { destroy },
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
    // Start's own wave-1 claim is itself a dispatch since #70 — the composition calls
    // `callWaveEarly()` before un-holding — so the counter starts at 1, not 0. The gate
    // under test does not apply to it: the `!started` branch runs ahead of the
    // `callWaveReady` check by design (a held run's control reads Start, not Call wave).
    expect(dispatches).toBe(1);
    // CONSUME the opening claim before EITHER leg presses. While it sits unconsumed in
    // the buffer the control is legitimately not call-ready, so a press would be inert
    // for a reason that has nothing to do with the injected gate — both legs would pass
    // while proving nothing. (Verified: without this drive, neutering the injected
    // `callWaveReady: false` entirely still leaves the disabled leg green.)
    for (let i = 0; i < FRAMES_PER_SIM_TICK; i++) h.frame();
    h.key('KeyC'); // the press under test: exposed-disabled, must not dispatch
    h.frame();
    expect(dispatches).toBe(1); // unchanged — the injected gate is the only suppressor
    expect(h.board.dataset.simPhase).toBe('running');
    // The enabled leg runs against the REAL state (no fiction): the same press
    // must now reach the controller — kills the closed-gate and cached-uiState
    // mutants the disabled leg alone cannot see.
    forceDisabled = false;
    h.key('KeyC');
    h.frame();
    expect(dispatches).toBe(2);
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
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' })); // arm the basic Card (M2-S3)
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
    openApps.push(app); // torn down even if an assertion throws first

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
    openApps.push(app); // torn down even if an assertion throws first
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
    openApps.push(app); // torn down even if an assertion throws first
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
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' })); // arm the basic Card (M2-S3)
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

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' })); // re-arm (M2-S3)
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
    openApps.push(app); // torn down even if an assertion throws first
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
  function appWith(
    coarse: boolean,
    controllerFactory?: (seed: number) => Controller,
    options: { readonly hosted?: boolean } = {},
  ) {
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
      ...(options.hosted === undefined ? {} : { hosted: options.hosted }),
      ...(controllerFactory === undefined ? {} : { controllerFactory }),
    });
    createdApps.push(app);
    return {
      root,
      app,
      frame: () => sched.frame((clock += FRAME_MS)),
      advance: () => (clock += 300),
    };
  }

  it('a REFUSED wave-1 claim aborts the entire Start action — no run, no fullscreen, no banner latch, no focus move (#70)', () => {
    // The claim-first ordering exists for exactly this case. `startRun()` claims wave 1
    // before it un-holds the run, so a refused claim (a legally full pre-start buffer)
    // leaves everything untouched instead of producing a live run whose first wave never
    // launched. Swapping the composition to start-first turns this test red — which is
    // the point of pinning it.
    const fs = stubFullscreen();
    // The stub refuses the claim AND reports the rejection the real controller records on
    // a full buffer, because the branch's one POSITIVE effect — refreshing so the live
    // region announces — is only witnessable if the outcome is there to announce. A stub
    // that merely returns false would let the `refreshHud()` call be deleted with every
    // assertion below still green (they are all negatives, satisfied by doing nothing).
    // The rejection is reported only AFTER the claim is actually refused — a stub that
    // announced it unconditionally would have the live region already carrying the message
    // at boot, and the assertion below would pass without the press doing anything
    // (measured: it did, twice, before this flag was added).
    let refused = false;
    const { root, frame } = appWith(true, (seed) => {
      const real = createController(seed);
      return {
        ...real,
        callWaveEarly: () => {
          refused = true;
          return false;
        },
        uiState: () =>
          refused
            ? {
                ...real.uiState(),
                lastOutcome: { kind: 'rejected', reason: 'pendingCap' } as const,
                outcomeSeq: real.uiState().outcomeSeq + 1,
              }
            : real.uiState(),
      };
    });
    frame();
    const primaryBtn = dockButton(root, 'Start');
    const board = root.querySelector<HTMLElement>('.wy-board')!;
    const live = root.querySelector<HTMLElement>('.wy-sr-only')!;
    const focusBefore = document.activeElement;

    // Not yet announced. (The region seeds with a single space so its first real write
    // registers as a text change — see `shell.ts` — so this is a not-equal, not an empty.)
    expect(live.textContent).not.toBe('Too many pending actions.');

    primaryBtn.click();
    // Asserted BEFORE any frame is driven, deliberately: the branch's refresh is
    // SYNCHRONOUS so the rejection lands on the press rather than waiting for the next
    // scheduled frame — the same reasoning the started branch's own refresh carries. Once
    // a frame runs, the loop repaints the live region regardless, and this assertion would
    // survive deleting the refresh entirely (measured — it did).
    expect(live.textContent).toBe('Too many pending actions.');

    frame();
    expect(board.dataset.started).toBe('false'); // the run never un-held
    // `requestFullscreen` is the FIRST side effect in the started branch and the install
    // banner latch is the second, so zero fullscreen calls proves neither ran.
    expect(fs.calls()).toBe(0);
    expect(document.activeElement).toBe(focusBefore); // no focus re-home
    expect(dockText(primaryBtn)).toBe('Start'); // still offering Start, not morphed
  });

  it('a duplicate Start activation claims wave 1 exactly once (#70)', () => {
    // The suppressor is the control's own readiness state, not buffer dedupe: a second
    // `callWaveEarly()` would return success (the sim treats a same-tick duplicate as an
    // idempotent no-op), so counting buffered commands would miss an extra dispatch.
    // Spying at the action layer is what actually catches it.
    let claims = 0;
    const { root, frame } = appWith(false, (seed) => {
      const real = createController(seed);
      return {
        ...real,
        callWaveEarly: () => {
          claims++;
          return real.callWaveEarly();
        },
      };
    });
    frame();
    const primaryBtn = dockButton(root, 'Start');
    const board = root.querySelector<HTMLElement>('.wy-board')!;

    primaryBtn.click(); // Start: claims wave 1
    // The keymapped start key routes to the SAME morphed control. Mid-run it takes the
    // Call-wave branch, which is gated on `callWaveReady` — false while the opening claim
    // is still unconsumed — so this press is inert rather than a second claim.
    board.dispatchEvent(new KeyboardEvent('keydown', { code: START_KEY, cancelable: true }));
    frame();

    expect(claims).toBe(1);
  });

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

  it('HOSTED: Start requests no fullscreen, and the run starts anyway (#146, ADR 0012)', () => {
    // #146 consumer 2, through the real wiring. The pointer is COARSE here — the same
    // session that legitimately requests fullscreen on the open web — so the only thing
    // stopping the request is the declared fact. A Host already owns the whole screen:
    // there are no browser toolbars to reclaim, and the request is at best a no-op.
    const fs = stubFullscreen();
    const { root, frame } = appWith(true, undefined, { hosted: true });
    frame();
    dockButton(root, 'Start').click();
    frame();
    expect(fs.calls()).toBe(0);
    // Nothing else about Start changed — the run is genuinely under way.
    expect(root.querySelector<HTMLElement>('.wy-board')!.dataset.started).toBe('true');
  });

  it('an ABSENT declaration still requests it — the web build is untouched', () => {
    // The control for the test above, and ADR 0012 constraint 3 at the app level: identical
    // in every respect except that nothing declared itself.
    const fs = stubFullscreen();
    const { root, frame } = appWith(true);
    frame();
    dockButton(root, 'Start').click();
    expect(fs.calls()).toBe(1);
  });

  it('a fine-pointer session never requests fullscreen, and Start still works', () => {
    const fs = stubFullscreen();
    const { root, frame } = appWith(false);
    frame();
    const primaryBtn = dockButton(root, 'Start');
    primaryBtn.click();
    frame();
    expect(fs.calls()).toBe(0);
    // The run started regardless — the control morphs rather than hiding. It reads
    // 'Launching…' until Start's own wave-1 claim is consumed a sim tick later (#70),
    // so drive past one 50 ms tick before pinning the settled 'Call wave'.
    expect(primaryBtn.hidden).toBe(false);
    for (let i = 0; i < FRAMES_PER_SIM_TICK; i++) frame();
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

describe('main — the wave preview home + swatch wiring (playtest round)', () => {
  // The REAL trigger token, never a restated literal: a drifted copy would leave the
  // fake matching nothing and every test here passing while asserting nothing.
  const COMPACT = COMPACT_QUERY;
  /** A matchMedia fake whose Compact MQL is settable and whose listener registry is
   *  inspectable — every other query gets the inert stub `main.ts` itself falls back to. */
  function compactMq(initial: boolean) {
    const listeners: (() => void)[] = [];
    let matching = initial;
    return {
      matchMedia: (q: string) =>
        q === COMPACT
          ? {
              get matches() {
                return matching;
              },
              addEventListener: (_t: 'change', l: () => void) => void listeners.push(l),
              removeEventListener: (_t: 'change', l: () => void) => {
                const i = listeners.indexOf(l);
                if (i >= 0) listeners.splice(i, 1);
              },
            }
          : { matches: false, addEventListener: () => {}, removeEventListener: () => {} },
      set(v: boolean) {
        matching = v;
        for (const l of [...listeners]) l();
      },
      listeners,
    };
  }

  it('boots the preview into the Stage on Standard, the hud on Compact, and follows the media change', () => {
    const mq = compactMq(false);
    const h = homeApp({ matchMedia: mq.matchMedia });
    const preview = h.root.querySelector('.wy-wave-preview')!;
    expect(preview.parentElement?.className).toBe('wy-stage');

    mq.set(true); // the viewport shrinks under the Compact trigger
    expect(preview.parentElement?.className).toBe('wy-hud');
    mq.set(false);
    expect(preview.parentElement?.className).toBe('wy-stage');
    h.app.destroy();
  });

  it('destroy() removes the compact listener — no re-homing after teardown', () => {
    const mq = compactMq(false);
    const h = homeApp({ matchMedia: mq.matchMedia });
    expect(mq.listeners.length).toBe(1);
    h.app.destroy();
    expect(mq.listeners).toHaveLength(0);
  });

  it('heavy root font does NOT re-home the float — zoom is served in place (Codex #96 P1)', () => {
    // The earlier ≥150% zoom bucket parked the preview in the content-sized status row,
    // where wave changes re-projected the board for zoomed Standard users — deleted. The
    // RO stub also pins the observer lifecycle: both boxes observed, disconnected on
    // destroy.
    // PER-INSTANCE, not a shared array: the app legitimately runs more than one observer
    // (M2-S12a's Rail affordance watches the Rail's children), and a single shared list
    // conflates them — it turns "main.ts observes exactly the preview and the stage" into a
    // total that any unrelated observer perturbs, and lets ONE disconnect satisfy a
    // teardown assertion meant for all of them. Identity + every-instance teardown is the
    // stricter claim, and it is the one this test was always making.
    const instances: { observed: Element[]; disconnected: boolean }[] = [];
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      readonly observed: Element[] = [];
      disconnected = false;
      constructor() {
        instances.push(this);
      }
      observe(el: Element): void {
        this.observed.push(el);
      }
      disconnect(): void {
        this.disconnected = true;
        this.observed.length = 0;
      }
    };
    try {
      document.documentElement.style.fontSize = '32px'; // 200%
      const h = homeApp();
      const preview = h.root.querySelector('.wy-wave-preview')!;
      const stage = h.root.querySelector('.wy-stage')!;
      expect(preview.parentElement?.className).toBe('wy-stage'); // zoom never re-homes
      // The preview's own observer watches exactly two boxes: the preview AND the stage
      // (the width bucket's input).
      const previewObserver = instances.find((i) => i.observed.includes(preview));
      expect(previewObserver, 'the preview must be observed').toBeDefined();
      expect(new Set(previewObserver!.observed)).toEqual(new Set([preview, stage]));
      // Length BESIDE the set, because `new Set` discards multiplicity: a regression that
      // re-observes the preview on every recompute leaves `[preview, stage, preview, ...]`,
      // which the set comparison still accepts. That is the very leak class this test claims
      // to be strengthening, and the `length === 2` this replaced used to catch it.
      expect(previewObserver!.observed).toHaveLength(2);
      h.app.destroy();
      // EVERY observer the app created, not just the preview's — a leaked one keeps writing
      // to a detached tree for the lifetime of the page.
      expect(instances.length).toBeGreaterThan(0);
      for (const i of instances) expect(i.disconnected).toBe(true);
    } finally {
      document.documentElement.style.fontSize = '';
      delete (window as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    }
  });

  it('a stage with no compliant dead band is a hud home (#101 — portrait phones are Standard)', () => {
    // jsdom lays nothing out (rect width 0 = "no signal", which the placement ignores), so
    // the narrow stage is driven at the prototype seam for this test only: `.wy-stage` and
    // the `.wy-board` filling it both report the 360×640-portrait geometry, everything else
    // passes through. At 259×596 the 28×24 grid projects to 9px cells and a 3px letterbox
    // margin — 5px of dead band even after borrowing the blocked border ring, far under the
    // 64px floor — so the float has nowhere compliant to sit and the hud takes it. This
    // REPLACED a hand-picked sub-400px width bucket: the same viewports still land here,
    // now by measuring the space rather than by guessing a threshold.
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains('wy-stage') || this.classList.contains('wy-board')) {
        return {
          width: 259,
          height: 596,
          top: 0,
          left: 0,
          right: 259,
          bottom: 596,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return original.call(this);
    };
    try {
      const h = homeApp();
      const preview = h.root.querySelector('.wy-wave-preview')!;
      expect(preview.parentElement?.className).toBe('wy-hud');
      // The scroll form's grants are cleared in the hud home — no stray tab stop.
      expect(preview.getAttribute('tabindex')).toBeNull();
      expect(preview.getAttribute('role')).toBeNull();
      // ...and so are the BAND grants (#101): a stale width cap from a band that no longer
      // exists would pin the in-flow form, which sizes to its column, not to dead space.
      expect((preview as HTMLElement).style.getPropertyValue('--wy-preview-max-w')).toBe('');
      expect(preview.classList.contains('wy-wave-preview--over-board')).toBe(false);
      h.app.destroy();
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('a stage with a letterbox margin keeps the float, pinned to the band and capped to it (#101)', () => {
    // The 1512×854 geometry, measured on the shipped build: a 1144×810 stage, a 28×24 grid
    // at 33px cells (924×792), leaving a 110px letterbox margin on each side. The card is
    // pinned into it and capped to it — 102px, the band less its 8px gap — so it covers no
    // grid cell at all, buildable or otherwise, and needs no reduced-weight companion form.
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains('wy-stage') || this.classList.contains('wy-board')) {
        return {
          width: 1144,
          height: 810,
          top: 0,
          left: 0,
          right: 1144,
          bottom: 810,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return original.call(this);
    };
    try {
      const h = homeApp();
      const preview = h.root.querySelector('.wy-wave-preview') as HTMLElement;
      expect(preview.parentElement?.className).toBe('wy-stage');
      expect(preview.style.getPropertyValue('--wy-preview-left')).toBe('8px');
      expect(preview.style.getPropertyValue('--wy-preview-right')).toBe('auto');
      expect(preview.style.getPropertyValue('--wy-preview-max-w')).toBe('102px');
      expect(preview.classList.contains('wy-wave-preview--over-board')).toBe(false);
      h.app.destroy();
      // The band grants are this module's to clear, like the scroll form's beside them.
      expect(preview.style.getPropertyValue('--wy-preview-max-w')).toBe('');
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('a stage whose letterbox is too narrow borrows the blocked border ring, and says so (#101)', () => {
    // The 1440×900 geometry, measured: a 1072×856 stage, 35px cells, a 46px letterbox
    // margin — 38px of usable band, under the 64px floor. Borrowing the one-cell blocked
    // ring lifts it to 81px (73px usable), which clears the floor, so the card sits over
    // board terrain no tower can ever occupy and takes the reduced-weight companion form.
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains('wy-stage') || this.classList.contains('wy-board')) {
        return {
          width: 1072,
          height: 856,
          top: 0,
          left: 0,
          right: 1072,
          bottom: 856,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return original.call(this);
    };
    try {
      const h = homeApp();
      const preview = h.root.querySelector('.wy-wave-preview') as HTMLElement;
      expect(preview.parentElement?.className).toBe('wy-stage');
      expect(preview.style.getPropertyValue('--wy-preview-max-w')).toBe('73px');
      expect(preview.classList.contains('wy-wave-preview--over-board')).toBe(true);
      h.app.destroy();
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('paints every swatch at boot and repaints ONLY on a real colour-mode change', () => {
    vi.mocked(paintSwatch).mockClear();
    const h = homeApp();
    const cardCount = h.root.querySelectorAll('.wy-card').length;
    expect(cardCount).toBeGreaterThan(0);
    expect(vi.mocked(paintSwatch)).toHaveBeenCalledTimes(cardCount); // one per Card at boot

    // A settings change that does NOT touch the mode (reduced motion) must not repaint.
    const toggle = h.root.querySelector<HTMLInputElement>('.wy-settings .wy-toggle input')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(vi.mocked(paintSwatch)).toHaveBeenCalledTimes(cardCount);

    // A real mode change repaints the full set exactly once more, at the new mode.
    const protan = h.root.querySelector<HTMLInputElement>(
      '.wy-settings input[name="wy-colour-mode"][value="protan"]',
    )!;
    protan.checked = true;
    protan.dispatchEvent(new Event('change'));
    expect(vi.mocked(paintSwatch)).toHaveBeenCalledTimes(cardCount * 2);
    expect(vi.mocked(paintSwatch).mock.calls.at(-1)?.[2]).toBe('protan');
    h.app.destroy();
  });
});

// ---------------------------------------------------------------------------------------
// Phase 1 of the mobile work: the host declaration (ADR 0012) and its three #146 consumers,
// then the two run-lifecycle gaps a phone exposes — #139 (pause on backgrounding) and #140
// (hold the screen awake while the wave is moving).
//
// Nothing here is verifiable on a device yet, by construction. Every behaviour is asserted
// by supplying `hosted` BOTH ways against the real controller and the real DOM. The existing
// Playwright suite runs desktop Chromium on the open web — the one environment in which all
// three #146 affordances are already correct — so it can never fail on them, and its
// continuing to pass is not evidence.
// ---------------------------------------------------------------------------------------

/** Drive the document between foreground and background. jsdom implements `visibilityState`
 *  as a prototype getter that never changes, so the property is overridden on the instance
 *  and the event dispatched by hand — in that order, which is the order a real backgrounding
 *  produces. `restoreVisibility` puts the prototype getter back; the document is shared by
 *  every test in this file. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  // Verified BEFORE the event is dispatched. The patch is an own accessor on the shared jsdom
  // `document`, restored by a hook — so if it ever failed to take, the tests downstream would
  // fail on a wake-lock or pause assertion whose message says nothing about visibility. This
  // makes such a failure name its own cause instead.
  expect(document.visibilityState, 'the visibilityState patch did not take effect').toBe(state);
  document.dispatchEvent(new Event('visibilitychange'));
}
function restoreVisibility(): void {
  Reflect.deleteProperty(document, 'visibilityState');
}

/** The Pause control's STATE (not its label — it reads "Resume" while paused). This is the
 *  app's own observable for `controller.isPaused()`, which is exactly what makes it the
 *  right assertion for a seam that is supposed to do nothing: if `ensurePaused` wrongly
 *  pauses, it also refreshes the HUD, so this flips. */
function pausePressed(root: HTMLElement): string | null {
  return dockButton(root, /Pause|Resume/).getAttribute('aria-pressed');
}

describe('main — hosted: the three web behaviours that are wrong inside a Host (#146)', () => {
  it('the mark still renders, but as a span with no link, no guard and no dialog', () => {
    const h = homeApp({ hosted: true });
    h.frame();
    const mark = h.root.querySelector<HTMLElement>('.wy-home')!;
    expect(mark.tagName).toBe('SPAN');
    expect(h.root.querySelector('a.wy-home')).toBeNull();

    // The leave guard is NOT REGISTERED at all — not registered-and-inert. Drive the state
    // in which the web build unconditionally intercepts (a live run, paused, so the mark is
    // reachable) and show that a plain left-click does nothing whatsoever.
    dockButton(h.root, 'Start').click();
    h.key('Space');
    h.frame();
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    mark.dispatchEvent(e);
    expect(e.defaultPrevented, 'nothing intercepted the activation').toBe(false);
    expect(h.root.querySelector<HTMLElement>('.wy-leave')!.hidden).toBe(true);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('the auto-hide contract is unchanged — the hosted mark still shows and hides', () => {
    // Deliberately identical presentation: the mark is the app's identity in the bar and
    // Compact's only branding. `overlay.ts` drives `data-live`/`inert` on the span exactly
    // as on the anchor, so nothing about the grid, the column or the fade moves.
    const h = homeApp({ hosted: true });
    h.frame();
    expect(h.state()).toEqual(VISIBLE);
    dockButton(h.root, 'Start').click();
    expect(h.state()).toEqual(HIDDEN);
    h.key('Space');
    expect(h.state()).toEqual(VISIBLE);
  });

  it('no install surface reaches the DOM — the fact really does reach install.ts', () => {
    // The end-to-end thread: `AppDeps.hosted` → `createInstall` → the overlay's own render.
    // `overlay.test.ts` pins both surfaces against a matched unhosted control; what this
    // test has to add is that the two are actually WIRED, so the assertion must be one that
    // changes when the declaration is removed.
    //
    // The BANNER is not that assertion. `homeApp` hands `createInstall` jsdom's real
    // navigator, which reports `platform: ''` and never fires `beforeinstallprompt`, so the
    // branch is 'other' and `bannerAudience` is false whether or not the app is hosted — the
    // banner is hidden either way and the test would pass with `hosted` deleted.
    //
    // The settings ROW is: it is gated on `standalone || installed || hosted`, and under
    // jsdom the first two are false, so it is visible unhosted and hidden hosted. That makes
    // it the load-bearing half — and it is also the half `bannerAudience` cannot cover, which
    // is the part of #146 that needed a second gate in the first place.
    // Scoped to the app's OWN root — `createApp` appends `overlay.settingsEl` there. Going
    // up to `document.body` would resolve correctly only because the first app is torn down
    // before the second is built; reorder the two halves and both lookups would return the
    // first app's row, so the hosted assertion would silently read the unhosted control.
    const settingsRow = (h: ReturnType<typeof homeApp>): HTMLElement =>
      h.root.querySelector<HTMLElement>('.wy-install-row')!;

    const web = homeApp();
    web.frame();
    expect(settingsRow(web).hidden, 'the control: unhosted, the row is offered').toBe(false);
    web.app.destroy();

    const hosted = homeApp({ hosted: true });
    hosted.frame();
    expect(settingsRow(hosted).hidden).toBe(true);
    expect(hosted.root.querySelector<HTMLElement>('.wy-banner')!.hidden).toBe(true);
  });

  it('with NO declaration the mark is still the site link, guard and all', () => {
    // ADR 0012 constraint 3, at the app level: absent means not hosted, so the deployed web
    // build is untouched. Every other test in this file is a second instance of this.
    const h = homeApp();
    h.frame();
    expect(h.root.querySelector('a.wy-home')).not.toBeNull();
    dockButton(h.root, 'Start').click();
    h.key('Space');
    const e = h.click();
    expect(e.defaultPrevented).toBe(true);
    expect(h.root.querySelector<HTMLElement>('.wy-leave')!.hidden).toBe(false);
  });
});

describe('main — backgrounding pauses the run, and NOTHING resumes it (#139)', () => {
  it('visibilitychange to hidden pauses a live run — synchronously, with no frame driven', () => {
    // "No frame driven" is the whole point. A backgrounded tab is exactly where frames stop
    // arriving, so a pause that waited for the frame loop's memo gate could sit undone for
    // as long as the app is away — which is the entire window this feature exists for.
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    h.frame();
    expect(pausePressed(h.root)).toBe('false');
    expect(h.state()).toEqual(HIDDEN); // live

    setVisibility('hidden');

    expect(pausePressed(h.root)).toBe('true');
    // …and the home link is back in the same synchronous write, per `ensurePaused`'s own
    // contract. This is the visible proof that the seam ran, not just the controller.
    expect(h.state()).toEqual(VISIBLE);
  });

  it('coming BACK does not resume — the player resumes deliberately from the Dock', () => {
    // The house rule, now with three instances (rotate prompt, settings dialog, this).
    // Costs one tap on return; buys the chance to read a board you left mid-wave before it
    // starts moving again, and one rule to learn instead of two.
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    setVisibility('hidden');
    expect(pausePressed(h.root)).toBe('true');

    setVisibility('visible');
    h.frame();
    expect(pausePressed(h.root)).toBe('true');
    // Nothing opened either — returning closes nothing and starts nothing.
    expect(h.root.querySelector<HTMLElement>('.wy-leave')!.hidden).toBe(true);
    expect(h.shell.hasAttribute('inert')).toBe(false);
  });

  it('pagehide pauses too — the ending visibilitychange does not always cover', () => {
    // A page frozen into the bfcache or torn down fires `pagehide`, and Android WebViews
    // have historically been the less reliable of the two on `visibilitychange`.
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    h.frame();
    expect(pausePressed(h.root)).toBe('false');
    window.dispatchEvent(new Event('pagehide'));
    expect(pausePressed(h.root)).toBe('true');
  });

  it('backgrounding a HELD run leaves the next Start able to run', () => {
    // The `!started` term of the shared guard, through this new caller. `controller.pause()`
    // is a bare flag set with no started check of its own, so pausing a held run leaves
    // `paused` invisibly true and the Start that follows never clears it: the board freezes
    // at tick 0 forever. Backgrounding before pressing Start is an ordinary phone thing to
    // do. Mutation-checked: removing `!controller.uiState().started` fails this.
    const h = homeApp();
    h.frame();
    setVisibility('hidden');
    setVisibility('visible');
    dockButton(h.root, 'Start').click();
    for (let i = 0; i < 20; i++) h.frame();
    expect(
      Number(h.board.dataset.simTick),
      'the sim never advanced — a pre-start pause left `paused` true through Start',
    ).toBeGreaterThan(0);
  });

  it('cancels a captured placement gesture BEFORE pausing, like every other caller', () => {
    // A finger held on the board when the app backgrounds keeps its press in flight. No modal
    // opens on this path, so `isModalOpen()` is false and the `pointerup` delivered on return
    // would COMMIT a placement into a run the player never meant to act on. Every other caller
    // of the seam aborts first — settings, the rotate prompt, the leave guard — and these two
    // were the only ones outside that contract.
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    const calls = (attachInputMock as unknown as { mock: { results: { value: InputHandle }[] } })
      .mock.results;
    const abortSpy = calls[calls.length - 1]!.value.abort as unknown as ReturnType<typeof vi.fn>;
    const before = abortSpy.mock.calls.length;

    setVisibility('hidden');
    expect(abortSpy.mock.calls.length, 'visibilitychange must cancel the gesture').toBe(before + 1);

    window.dispatchEvent(new Event('pagehide'));
    expect(abortSpy.mock.calls.length, 'pagehide must cancel it too').toBe(before + 2);
  });

  it('a run that RESOLVED is left alone — a real, played-out loss', () => {
    // The `isTerminal()` term, which `ensurePaused` did not have before this phase: a
    // resolved run is still `started` and normally unpaused, so a background event would
    // have paused a finished match. #139 says nothing should happen.
    //
    // The term lives in the SHARED seam rather than at this one call site because
    // `ensurePaused` documents itself as owning the guard so any caller can invoke it
    // unconditionally — guarding here would retire that contract and leave the other three
    // callers still pausing finished runs.
    //
    // Mutation-checked: dropping `|| controller.isTerminal()` makes this fail, because the
    // wrong pause also refreshes the HUD and flips `aria-pressed`.
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    const results = h.root.querySelector<HTMLElement>('.wy-results')!;
    for (let i = 0; i < 4000 && results.hidden; i++) h.frame();
    expect(results.hidden, 'the run must actually have resolved').toBe(false);
    expect(pausePressed(h.root)).toBe('false');

    setVisibility('hidden');
    h.frame();
    expect(pausePressed(h.root)).toBe('false');
  });

  it('…and the same after a WIN', () => {
    // Reaching a real win needs a maze that survives ten waves and a boss; the money cap is
    // sixteen towers and every layout tried loses, so the one terminal phase a unit test
    // cannot play its way to is supplied through `AppDeps.controllerFactory` — the seam that
    // exists for exactly this. Only the PHASE is forced: `isTerminal()` is derived from it by
    // the sim's own `isTerminalPhase`, so 'won' and 'lost' differ here the way they differ
    // in the real controller, and `pause()` underneath is the real one.
    let forced: SimPhase | null = null;
    const h = homeApp({
      controllerFactory: (seed) => {
        const real = createController(seed);
        return {
          ...real,
          hud: () => (forced === null ? real.hud() : { ...real.hud(), phase: forced }),
          isTerminal: () => (forced === null ? real.isTerminal() : isTerminalPhase(forced)),
        };
      },
    });
    h.frame();
    dockButton(h.root, 'Start').click();
    h.frame();
    expect(pausePressed(h.root)).toBe('false');

    forced = 'won';
    // The results dialog opens from `refreshHud`, which the frame loop gates on its memo
    // key — and a forced phase moves none of that key's components. Drive past a real sim
    // tick so the key changes and the app actually SEES the resolution, rather than
    // asserting against a state only the wrapper knows about.
    for (let i = 0; i < FRAMES_PER_SIM_TICK + 1; i++) h.frame();
    expect(h.root.querySelector<HTMLElement>('.wy-results')!.hidden).toBe(false);

    setVisibility('hidden');
    h.frame();
    expect(pausePressed(h.root)).toBe('false');
  });
});

describe('main — the screen wake lock (#140)', () => {
  it('is held only while started AND unpaused AND unresolved AND visible', async () => {
    const lock = fakeWakeLock();
    const h = homeApp({ wakeLock: lock.api });
    h.frame();

    // Held pre-start: the board is up, nothing is moving, and the player may be reading it
    // for as long as they like. No lock.
    await lock.settle();
    expect(lock.liveSentinels()).toBe(0);
    expect(lock.requests()).toBe(0);

    dockButton(h.root, 'Start').click();
    await lock.settle();
    expect(lock.liveSentinels(), 'the wave is moving — hold the screen awake').toBe(1);

    // PAUSED PLANNING releases it. This is the phase's most contestable decision and it is
    // deliberate: paused planning is real play in Wynding — builds and sells queue there and
    // drain on resume — so pondering a maze for longer than the device's auto-lock will dim
    // the screen. Chosen for battery: the lock is held for the shortest defensible window.
    h.key('Space');
    expect(lock.liveSentinels()).toBe(0);

    h.key('Space'); // resume
    await lock.settle();
    expect(lock.liveSentinels()).toBe(1);

    // BACKGROUNDED. #139 pauses the run here as well, but the release must not depend on
    // that: the predicate carries the visibility term itself.
    setVisibility('hidden');
    await lock.settle();
    expect(lock.liveSentinels()).toBe(0);
  });

  it('is released when the run RESOLVES, with no help from anything else', async () => {
    const lock = fakeWakeLock();
    const h = homeApp({ wakeLock: lock.api });
    h.frame();
    dockButton(h.root, 'Start').click();
    await lock.settle();
    expect(lock.liveSentinels()).toBe(1);

    const results = h.root.querySelector<HTMLElement>('.wy-results')!;
    for (let i = 0; i < 4000 && results.hidden; i++) h.frame();
    expect(results.hidden).toBe(false);
    await lock.settle();
    expect(lock.liveSentinels(), 'a finished match must not hold the screen awake').toBe(0);
  });

  it('never asks while the document is hidden — the API refuses a hidden document', async () => {
    // Visibility is IN the predicate rather than assumed. Without that term every reconcile
    // while backgrounded would be a request the platform rejects, and the rejection path
    // would be the app's steady state rather than its exception.
    const lock = fakeWakeLock();
    const h = homeApp({ wakeLock: lock.api });
    h.frame();
    setVisibility('hidden');
    dockButton(h.root, 'Start').click();
    await lock.settle();
    expect(lock.requests()).toBe(0);
  });

  it('re-evaluates on visibility restore, so #140 is not correct only when #139 is', async () => {
    // If the backgrounding event never fired, the run would still be live while the OS had
    // silently dropped the lock — and nothing would re-acquire it. So the reconcile on
    // visibility change is unconditional and in both directions, not a side effect of the
    // pause. Simulated by dispatching only the RESTORE half, which is the shape of the
    // Android WebView unreliability this guards against.
    const lock = fakeWakeLock();
    const h = homeApp({ wakeLock: lock.api });
    h.frame();
    dockButton(h.root, 'Start').click();
    await lock.settle();
    expect(lock.liveSentinels()).toBe(1);

    // The OS drops the lock when the app goes away — but the hide event NEVER ARRIVES, so
    // nothing pauses the run and nothing has re-acquired. Without the revoke this test would
    // assert `live() === 1` twice over and pass with the reconcile deleted.
    lock.revokeAll();
    expect(lock.liveSentinels()).toBe(0);

    setVisibility('visible');
    await lock.settle();
    expect(pausePressed(h.root), 'the run was never paused — no hide event fired').toBe('false');
    expect(lock.requests(), 'the restore must reconcile, not assume').toBe(2);
    expect(lock.liveSentinels()).toBe(1);
  });

  it('a REFUSING platform is asked once per wave, not once per tick', async () => {
    // The reconcile hangs off `refreshHud`, which the frame loop drives on every sim-tick
    // change — so without `wakelock.ts`'s refusal latch this is a request per tick, ~20/s at
    // speed 1, for the whole run, on precisely the battery-constrained device the feature
    // exists to serve (Chrome denies a screen lock on low battery; a WebView without the
    // `screen-wake-lock` grant refuses outright).
    const lock = fakeWakeLock({ behaviour: 'reject' });
    const h = homeApp({ wakeLock: lock.api });
    h.frame();
    dockButton(h.root, 'Start').click();
    // SETTLE FIRST. The frame loop below is entirely synchronous, so without this the
    // rejection microtask never runs during it, `requesting` stays true, and single-flight
    // alone caps the count at 1 — the assertion would then hold with the refusal latch
    // deleted, which is the one thing this test exists to pin.
    await lock.settle();
    expect(lock.requests()).toBe(1);

    for (let i = 0; i < FRAMES_PER_SIM_TICK * 6; i++) h.frame();
    await lock.settle();
    expect(lock.requests(), 'a refusal must cost one request, not one per tick').toBe(1);

    // …and the refusal is not permanent: pausing cycles the predicate, so the next wave asks
    // again in case whatever made the platform decline has passed.
    h.key('Space');
    h.key('Space');
    await lock.settle();
    expect(lock.requests()).toBe(2);
  });

  it('an absent API is a silent no-op — the run is completely unaffected', async () => {
    // iOS below 16.4 (Capacitor 8's floor is iOS 15) and an AOSP WebView without Play
    // updates simply have none. That is a quiet degradation, never an error the run notices.
    const h = homeApp({ wakeLock: null });
    h.frame();
    expect(() => dockButton(h.root, 'Start').click()).not.toThrow();
    for (let i = 0; i < 20; i++) h.frame();
    expect(Number(h.board.dataset.simTick)).toBeGreaterThan(0);
    await Promise.resolve();
  });

  it('destroy() releases a held lock', async () => {
    const lock = fakeWakeLock();
    const h = homeApp({ wakeLock: lock.api });
    h.frame();
    dockButton(h.root, 'Start').click();
    await lock.settle();
    expect(lock.liveSentinels()).toBe(1);
    h.app.destroy();
    expect(lock.liveSentinels()).toBe(0);
  });

  it('destroy() also unregisters the backgrounding listeners', () => {
    // Both #139 listeners live on the shared `document`/`window`, so a leaked one would reach
    // a torn-down app on every later test — and, in a real host remounting `createApp`, would
    // pause runs through a dead controller.
    //
    // `not.toThrow()` is NOT the assertion for that: a leaked handler runs
    // `ensurePaused` → `controller.pause()` → `refreshHud()` → `overlay.update()`, and
    // nothing on that path dereferences a torn-down field, so it completes silently. Capture
    // the Pause control BEFORE the teardown (the Shell is detached afterwards, so a lookup
    // would fail for the wrong reason) and assert its state is untouched — a leaked listener
    // flips it, because the wrongful pause refreshes the HUD into the detached nodes.
    const h = homeApp();
    h.frame();
    dockButton(h.root, 'Start').click();
    h.frame();
    const pauseBtn = dockButton(h.root, /Pause|Resume/);
    expect(pauseBtn.getAttribute('aria-pressed')).toBe('false');

    h.app.destroy();
    setVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));

    expect(
      pauseBtn.getAttribute('aria-pressed'),
      'a listener outlived destroy() and paused a torn-down run',
    ).toBe('false');
  });
});
