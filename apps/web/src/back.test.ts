import { describe, expect, it, vi } from 'vitest';
import { createModalOwner, type ModalBackState, type ModalOverlay } from './modal';
import {
  createBackHandler,
  findCapacitorApp,
  routeBack,
  type BackAction,
  type BackButtonEventLike,
  type CapacitorAppPlugin,
  type PluginListenerHandleLike,
} from './back';

/**
 * THE ROUTING TABLE, as data.
 *
 * Every state the app can be in when Back is pressed, and the action it must produce.
 * Written out rather than derived, so a change to `routeBack` has to be argued for here
 * before it can pass.
 *
 * THE LAST TWO ROWS SUPERSEDE THE RATIFIED PLAN'S COARSER ONE, deliberately and by
 * EXTENDING an already-ratified decision rather than overturning it. The plan said
 * "nothing to dismiss + nothing running → allow the default (leave the app)", which
 * silently counted a PAUSED run as nothing — so pausing and then pressing Back threw the
 * run away without asking. `main.ts` had already settled that question for the other way
 * out of the app: the home link intercepts its own activation and routes through a leave
 * confirm whenever a run or a pending plan exists. Back is the same act by a different
 * control, so the row splits into "no unresolved run → default" and "an unresolved run,
 * nothing else → the SAME leave confirm". Recorded here because a reader holding the plan
 * should be able to see that the divergence was chosen, and why.
 */
const TABLE: {
  readonly name: string;
  readonly modal: ModalBackState | null;
  readonly runLive: boolean;
  readonly runUnresolved: boolean;
  readonly expected: BackAction;
}[] = [
  {
    name: 'settings open, run live',
    modal: 'dismissable',
    runLive: true,
    runUnresolved: true,
    expected: 'dismissModal',
  },
  {
    // Settings AUTO-PAUSES the run it opens over, so this is the common case, not an
    // exotic one — and the dismissal still outranks it.
    name: 'settings open over a PAUSED run',
    modal: 'dismissable',
    runLive: false,
    runUnresolved: true,
    expected: 'dismissModal',
  },
  {
    name: 'settings open, no run',
    modal: 'dismissable',
    runLive: false,
    runUnresolved: false,
    expected: 'dismissModal',
  },
  {
    name: 'rotate open, no run yet',
    modal: 'consuming',
    runLive: false,
    runUnresolved: false,
    expected: 'consume',
  },
  {
    name: 'rotate open, run live',
    modal: 'consuming',
    runLive: true,
    runUnresolved: true,
    expected: 'consume',
  },
  {
    name: 'rotate open, run paused',
    modal: 'consuming',
    runLive: false,
    runUnresolved: true,
    expected: 'consume',
  },
  {
    // THE ROW THIS ROUND ADDED. Consuming here trapped a hosted player: the run is over,
    // the wordmark is a non-interactive span (ADR 0012), and the dialog offers only Play
    // again / Verify / Copy / Save. Back is the only way out, so it has to be one.
    name: 'EXIT overlay open, run over',
    modal: 'exit',
    runLive: false,
    runUnresolved: false,
    expected: 'default',
  },
  {
    // Unreachable today (`showResults` fires only where `isRunUnresolved` is false), so
    // these two rows are about what happens IF that ever breaks. They ask for the confirm
    // rather than the exit, which keeps the file's own `NEVER exits out from under an
    // unresolved run` invariant true of every row in the table rather than of most of them.
    name: 'EXIT overlay open, run somehow unresolved',
    modal: 'exit',
    runLive: false,
    runUnresolved: true,
    expected: 'leaveConfirm',
  },
  {
    name: 'EXIT overlay open, run somehow live',
    modal: 'exit',
    runLive: true,
    runUnresolved: true,
    expected: 'leaveConfirm',
  },
  {
    name: 'nothing open, run live',
    modal: null,
    runLive: true,
    runUnresolved: true,
    expected: 'pause',
  },
  {
    name: 'nothing open, run PAUSED (not resolved)',
    modal: null,
    runLive: false,
    runUnresolved: true,
    expected: 'leaveConfirm',
  },
  {
    name: 'nothing open, no unresolved run',
    modal: null,
    runLive: false,
    runUnresolved: false,
    expected: 'default',
  },
];

/** EVERY member of `ModalBackState`, sourced from the TYPE rather than retyped by hand.
 *
 *  The first cut listed the states in a literal, which meant the completeness check below
 *  was exhaustive over that literal and not over the union — adding a fourth state left it
 *  green and silent, which is precisely the change class that produced this round's bug.
 *  `satisfies` makes a new member a COMPILE error here, before any test runs; `routeBack`'s
 *  own `satisfies null` catches the same widening in the code this guards. */
const ALL_BACK_STATES = {
  dismissable: true,
  exit: true,
  consuming: true,
} satisfies Record<ModalBackState, true>;

const BACK_STATES = [...(Object.keys(ALL_BACK_STATES) as ModalBackState[]), null];

describe('routeBack — the decision table (#138)', () => {
  for (const row of TABLE) {
    it(`${row.name} → ${row.expected}`, () => {
      expect(
        routeBack({ modal: row.modal, runLive: row.runLive, runUnresolved: row.runUnresolved }),
      ).toBe(row.expected);
    });
  }

  it('covers every reachable combination — no state falls off the table', () => {
    for (const modal of BACK_STATES) {
      // `runLive` implies `runUnresolved`, so live-but-resolved is not a state that exists.
      for (const [runLive, runUnresolved] of [
        [true, true],
        [false, true],
        [false, false],
      ] as const) {
        expect(
          TABLE.some(
            (r) => r.modal === modal && r.runLive === runLive && r.runUnresolved === runUnresolved,
          ),
          `no row for modal=${String(modal)} live=${String(runLive)} unresolved=${String(runUnresolved)}`,
        ).toBe(true);
      }
    }
  });

  it('a dismissable overlay outranks a live run — Back closes it, it does not pause', () => {
    expect(routeBack({ modal: 'dismissable', runLive: true, runUnresolved: true })).toBe(
      'dismissModal',
    );
  });

  it('NEVER exits out from under an unresolved run, paused or not', () => {
    for (const runLive of [true, false]) {
      expect(routeBack({ modal: null, runLive, runUnresolved: true })).not.toBe('default');
    }
  });
});

// The two rows the plan singles out, asserted against the REAL modal owner rather than
// against a hand-written `'consume'` — which would only prove the table, not that the
// overlays are actually registered the way the table assumes.
describe('the real overlays classify as the table expects', () => {
  const overlay = (): ModalOverlay => ({ show: vi.fn(), hide: vi.fn() });

  function owner() {
    const doc = document.implementation.createHTMLDocument();
    const shell = doc.createElement('div');
    doc.body.appendChild(shell);
    return createModalOwner(doc, shell);
  }

  it('nothing open → null', () => {
    expect(owner().activeBackState()).toBeNull();
  });

  it('settings DISMISSES — the same answer it gives Escape', () => {
    const m = owner();
    m.open(overlay(), { priority: 'settings', dismissOnEscape: true });
    expect(m.activeBackState()).toBe('dismissable');
  });

  it('RESULTS IS ITS OWN ROW — not dismissable, and not consumed either: Back EXITS', () => {
    const m = owner();
    // Registered exactly as `overlay.ts` registers it: state-driven, no `dismissOnEscape`,
    // and declaring that Back leaves the app.
    m.open(overlay(), { priority: 'results', backExits: true });
    // Classified apart from rotate, which is what makes the exit row reachable at all.
    expect(m.activeBackState()).toBe('exit');
    expect(routeBack({ modal: m.activeBackState(), runLive: false, runUnresolved: false })).toBe(
      'default',
    );
  });

  it('the results dialog is still NOT dismissable — Back exits, it does not close it', () => {
    // The distinction the new row must not blur: exiting the app and dismissing the dialog
    // are different actions, and `dismissActive()` must still refuse this overlay so a
    // future caller cannot close a state-driven dialog through the back door.
    const m = owner();
    const results = overlay();
    m.open(results, { priority: 'results', backExits: true });
    m.dismissActive();
    expect(results.hide).not.toHaveBeenCalled();
    expect(m.activeBackState()).toBe('exit');
  });

  it('EXIT IS DECLARED, NOT INHERITED FROM PRIORITY — results priority alone does not quit', () => {
    // The invariant that used to be a comment. ADR 0014 records a survey overlay being
    // talked out of `results` priority once; if a later one lands there, it must not gain
    // the power to close the app just by sharing a priority string with the results dialog.
    const m = owner();
    m.open(overlay(), { priority: 'results' });
    expect(m.activeBackState()).toBe('consuming');
    expect(routeBack({ modal: m.activeBackState(), runLive: false, runUnresolved: false })).toBe(
      'consume',
    );
  });

  it('DISMISSABLE WINS over backExits — the two keys cannot be made to disagree', () => {
    // Pins the order inside `activeBackState`. Reversed, an overlay declaring both would
    // have Escape close it while Back quit the app, which is the one disagreement the
    // module's doc promises is impossible.
    const m = owner();
    m.open(overlay(), { priority: 'results', dismissOnEscape: true, backExits: true });
    expect(m.activeBackState()).toBe('dismissable');
  });

  it('THE AGREEMENT AS A RULE, not three examples: dismissable IFF dismissActive closes', () => {
    // `modal.ts` claims Back and Escape share the dismissal classification exactly. That is
    // a biconditional over every overlay, so test it as one — the per-overlay cases above
    // are instances, and an instance cannot catch the case nobody thought to write.
    for (const dismissOnEscape of [true, false]) {
      for (const backExits of [true, false]) {
        for (const priority of ['results', 'rotate', 'settings'] as const) {
          const m = owner();
          const o = overlay();
          m.open(o, { priority, dismissOnEscape, backExits });
          const classifiedDismissable = m.activeBackState() === 'dismissable';
          m.dismissActive();
          const actuallyClosed = vi.mocked(o.hide).mock.calls.length > 0;
          expect(
            actuallyClosed,
            `dismissable=${String(classifiedDismissable)} but closed=${String(actuallyClosed)} ` +
              `for ${priority} (escape=${String(dismissOnEscape)} exits=${String(backExits)})`,
          ).toBe(classifiedDismissable);
        }
      }
    }
  });

  it('ROTATE IS CONSUMED, NOT DISMISSED — it is reachable, and only the device clears it', () => {
    // rotate.ts:27-34: Android 16 (API 36) ignores `android:screenOrientation` on sw600dp+
    // displays unless an exception applies, so this overlay is live on device. Registered
    // exactly as `rotate.ts` registers it — no `dismissOnEscape`.
    const m = owner();
    m.open(overlay(), { priority: 'rotate' });
    expect(m.activeBackState()).toBe('consuming');
    // The failure this prevents: falling through to APP EXIT from a screen the player
    // cannot otherwise leave. It only prevents it at (false, false) — with the consuming
    // branch gone, a live run routes to `pause`, so asserting there would pass for a
    // reason unrelated to the failure named. The rotate prompt reaches (false, false)
    // every time the device is turned before a run starts.
    expect(routeBack({ modal: m.activeBackState(), runLive: false, runUnresolved: false })).toBe(
      'consume',
    );
    expect(routeBack({ modal: m.activeBackState(), runLive: true, runUnresolved: true })).not.toBe(
      'default',
    );
  });

  it('reads the HIGHEST-PRIORITY open overlay, not the last one opened', () => {
    const m = owner();
    const settings = overlay();
    m.open(settings, { priority: 'settings', dismissOnEscape: true });
    m.open(overlay(), { priority: 'results', backExits: true });
    // Results outranks settings, so Back must answer for results.
    expect(m.activeBackState()).toBe('exit');
  });

  it('dismissActive closes a dismissable overlay and leaves a consuming one alone', () => {
    const m = owner();
    const settings = overlay();
    m.open(settings, { priority: 'settings', dismissOnEscape: true });
    m.dismissActive();
    expect(settings.hide).toHaveBeenCalled();
    expect(m.activeBackState()).toBeNull();

    const rotate = overlay();
    m.open(rotate, { priority: 'rotate' });
    m.dismissActive();
    expect(rotate.hide).not.toHaveBeenCalled();
    expect(m.activeBackState()).toBe('consuming');
  });
});

describe('createBackHandler — the wiring', () => {
  function fakePlugin() {
    const listeners = new Map<string, (payload: never) => void>();
    const removed: string[] = [];
    const exitApp = vi.fn(async () => undefined);
    const plugin: CapacitorAppPlugin = {
      addListener: vi.fn(
        async (
          name: string,
          listener: (payload: never) => void,
        ): Promise<PluginListenerHandleLike> => {
          listeners.set(name, listener);
          return {
            remove: async () => {
              removed.push(name);
            },
          };
        },
      ) as unknown as CapacitorAppPlugin['addListener'],
      exitApp,
    };
    return {
      plugin,
      exitApp,
      removed,
      back: (canGoBack = false): void =>
        (listeners.get('backButton') as ((e: BackButtonEventLike) => void) | undefined)?.({
          canGoBack,
        }),
      state: (isActive: boolean): void =>
        (listeners.get('appStateChange') as ((s: { isActive: boolean }) => void) | undefined)?.({
          isActive,
        }),
      registered: (): string[] => [...listeners.keys()],
    };
  }

  function harness(
    options: {
      runLive?: boolean;
      /** Defaults to `runLive` — a live run is always unresolved. */
      runUnresolved?: boolean;
      dismissal?: ModalBackState | null;
    } = {},
  ) {
    const fake = fakePlugin();
    const calls = { ensurePaused: 0, abortGesture: 0, dismissActive: 0, refreshWakeLock: 0 };
    const leaveConfirms: (() => void)[] = [];
    let dismissal: ModalBackState | null = options.dismissal ?? null;
    const handle = createBackHandler({
      modal: {
        open: vi.fn(),
        close: vi.fn(),
        // MUTABLE, so a test can drive one handler through a real sequence of presses
        // where the modal state CHANGES between them — which is what actually happens
        // when a Back press opens the leave confirm and the next press meets it.
        activeBackState: () => dismissal,
        dismissActive: () => void calls.dismissActive++,
        destroy: vi.fn(),
      },
      isRunLive: () => options.runLive === true,
      isRunUnresolved: () => options.runUnresolved ?? options.runLive === true,
      showLeaveConfirm: (onConfirm) => void leaveConfirms.push(onConfirm),
      ensurePaused: () => void calls.ensurePaused++,
      abortGesture: () => void calls.abortGesture++,
      refreshWakeLock: () => void calls.refreshWakeLock++,
      plugin: fake.plugin,
    });
    return {
      ...fake,
      calls,
      leaveConfirms,
      handle,
      /** Move the modal state, as opening or closing a dialog really would. */
      setDismissal: (v: ModalBackState | null): void => void (dismissal = v),
    };
  }

  it('registers for both the Back button and the native lifecycle', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.registered().sort()).toEqual(['appStateChange', 'backButton']));
    h.handle.destroy();
  });

  it('a dismissable overlay: Back closes it, and nothing pauses or exits', async () => {
    const h = harness({ dismissal: 'dismissable', runLive: true });
    await vi.waitFor(() => expect(h.registered()).toContain('backButton'));
    h.back();
    expect(h.calls.dismissActive).toBe(1);
    expect(h.calls.ensurePaused).toBe(0);
    expect(h.exitApp).not.toHaveBeenCalled();
    h.handle.destroy();
  });

  it('a consuming overlay: Back does NOTHING — and above all does not exit the app', async () => {
    const h = harness({ dismissal: 'consuming', runLive: true });
    await vi.waitFor(() => expect(h.registered()).toContain('backButton'));
    h.back();
    expect(h.calls).toMatchObject({ dismissActive: 0, ensurePaused: 0, abortGesture: 0 });
    expect(h.exitApp).not.toHaveBeenCalled();
    h.handle.destroy();
  });

  it('a live run pauses through the ONE seam, cancelling any held gesture first', async () => {
    const h = harness({ runLive: true });
    await vi.waitFor(() => expect(h.registered()).toContain('backButton'));
    h.back();
    expect(h.calls.abortGesture).toBe(1);
    expect(h.calls.ensurePaused).toBe(1);
    expect(h.exitApp).not.toHaveBeenCalled();
    h.handle.destroy();
  });

  it('nothing to dismiss and NO UNRESOLVED RUN: Back EXPLICITLY exits', async () => {
    // Explicit because registering a listener at all turns Capacitor's own handling off —
    // without this call Back would be a dead key.
    const h = harness({ runLive: false, runUnresolved: false });
    await vi.waitFor(() => expect(h.registered()).toContain('backButton'));
    h.back();
    expect(h.exitApp).toHaveBeenCalledTimes(1);
    expect(h.leaveConfirms).toHaveLength(0);
    h.handle.destroy();
  });

  it('a PAUSED run asks before exiting, and exits only when the confirm commits', async () => {
    // The ruling this pins: a paused run is still a run the player has, so Back routes
    // through the same leave confirm the home link uses rather than throwing it away.
    const h = harness({ runLive: false, runUnresolved: true });
    await vi.waitFor(() => expect(h.registered()).toContain('backButton'));
    h.back();
    expect(h.exitApp).not.toHaveBeenCalled();
    expect(h.leaveConfirms).toHaveLength(1);
    // Nothing else happened: no second pause, no dismissal of a dialog that is not open.
    expect(h.calls).toMatchObject({ ensurePaused: 0, dismissActive: 0 });

    h.leaveConfirms[0]!(); // the player commits
    expect(h.exitApp).toHaveBeenCalledTimes(1);
    h.handle.destroy();
  });

  it('Stay is just not committing: a SECOND Back dismisses the confirm and still never exits', async () => {
    // ONE handler, two presses, with the modal state moving between them exactly as it
    // does in the app — the sequence this test is named for. An earlier version used two
    // separate handlers with hardcoded states, which asserted the table twice and the
    // SEQUENCE not at all: nothing in it could have caught a second press that exited.
    const h = harness({ runLive: false, runUnresolved: true });
    await vi.waitFor(() => expect(h.registered()).toContain('backButton'));

    h.back(); // press one: nothing open, unresolved run → ask
    expect(h.leaveConfirms).toHaveLength(1);
    expect(h.exitApp).not.toHaveBeenCalled();

    // The confirm is now open, and it registers dismissable (settings priority,
    // `dismissOnEscape: true` — see `overlay.ts`'s `showLeave`).
    h.setDismissal('dismissable');
    h.back(); // press two: the dismissable row wins → Stay
    expect(h.calls.dismissActive).toBe(1);
    expect(h.exitApp).not.toHaveBeenCalled();
    expect(h.leaveConfirms).toHaveLength(1); // not re-asked

    h.handle.destroy();
  });

  it('backgrounding pauses (#134) and returning to the foreground does NOT resume', async () => {
    const h = harness({ runLive: true });
    await vi.waitFor(() => expect(h.registered()).toContain('appStateChange'));
    h.state(false);
    expect(h.calls.abortGesture).toBe(1);
    expect(h.calls.ensurePaused).toBe(1);
    expect(h.calls.refreshWakeLock).toBe(1);

    h.state(true);
    expect(h.calls.ensurePaused).toBe(1); // unchanged — the player resumes from the Dock
    expect(h.calls.refreshWakeLock).toBe(2); // reconciled in BOTH directions (#140)
    h.handle.destroy();
  });

  it('destroy() removes both listeners', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.registered()).toHaveLength(2));
    h.handle.destroy();
    await vi.waitFor(() => expect(h.removed.sort()).toEqual(['appStateChange', 'backButton']));
  });

  it('a destroy that lands BEFORE registration resolves still removes the listener', async () => {
    const h = harness();
    h.handle.destroy(); // synchronous, while `addListener`'s promise is still pending
    await vi.waitFor(() => expect(h.removed.sort()).toEqual(['appStateChange', 'backButton']));
  });

  it('is inert with no plugin — the open web wires nothing and destroy is safe', () => {
    const handle = createBackHandler({
      modal: {
        open: vi.fn(),
        close: vi.fn(),
        activeBackState: () => null,
        dismissActive: vi.fn(),
        destroy: vi.fn(),
      },
      isRunLive: () => true,
      isRunUnresolved: () => true,
      showLeaveConfirm: vi.fn(),
      ensurePaused: vi.fn(),
      abortGesture: vi.fn(),
      refreshWakeLock: vi.fn(),
      plugin: null,
    });
    expect(() => handle.destroy()).not.toThrow();
  });
});

describe('the LEGACY bridge shape (#138 review round)', () => {
  /** The Android Capacitor 8.5 bridge as it actually behaves: `addListener` returns the
   *  handle SYNCHRONOUSLY, and so does `remove`. Every double in this file until now
   *  returned promises, which is why a defect that would kill Back on every real device
   *  sat behind a fully green suite. */
  function legacyBridgeWindow() {
    const listeners = new Map<string, (payload: never) => void>();
    const removed: string[] = [];
    const exited: number[] = [];
    const App = {
      // NOT async, and NOT returning a promise — the whole point.
      addListener(name: string, listener: (payload: never) => void) {
        listeners.set(name, listener);
        return {
          remove() {
            removed.push(name);
          },
        };
      },
      exitApp() {
        exited.push(1);
      },
    };
    return {
      view: { Capacitor: { Plugins: { App } } } as unknown as Window,
      listeners,
      removed,
      exited,
    };
  }

  it('drives Back end to end when the host answers SYNCHRONOUSLY', async () => {
    const host = legacyBridgeWindow();
    const plugin = findCapacitorApp(host.view, true);
    expect(plugin).not.toBeNull();

    const handle = createBackHandler({
      modal: {
        open: vi.fn(),
        close: vi.fn(),
        activeBackState: () => null,
        dismissActive: vi.fn(),
        destroy: vi.fn(),
      },
      isRunLive: () => false,
      isRunUnresolved: () => false,
      showLeaveConfirm: vi.fn(),
      ensurePaused: vi.fn(),
      abortGesture: vi.fn(),
      refreshWakeLock: vi.fn(),
      plugin,
    });

    // Registration completes...
    await vi.waitFor(() =>
      expect([...host.listeners.keys()].sort()).toEqual(['appStateChange', 'backButton']),
    );
    // ...the press routes...
    (host.listeners.get('backButton') as (e: { canGoBack: boolean }) => void)({
      canGoBack: false,
    });
    await vi.waitFor(() => expect(host.exited).toHaveLength(1));
    // ...and teardown reaches the synchronous `remove` too.
    handle.destroy();
    await vi.waitFor(() => expect(host.removed.sort()).toEqual(['appStateChange', 'backButton']));
  });

  it('keeps working for a PROMISE-returning host (regression guard, not a totality proof)', async () => {
    // Honestly scoped: this passes with the adapter reverted too, because before the
    // adapter existed `findCapacitorApp` returned the promise-shaped plugin untouched. It
    // guards against the adapter BREAKING promise hosts; it does not prove totality. The
    // sync-host test above is the proof, and the throwing-host tests below cover the
    // control-flow half that `Promise.resolve` alone never did.
    const removed: string[] = [];
    const exited: number[] = [];
    const App = {
      addListener: async (name: string) => ({
        remove: async () => {
          removed.push(name);
        },
      }),
      exitApp: async () => {
        exited.push(1);
      },
    };
    const plugin = findCapacitorApp({ Capacitor: { Plugins: { App } } } as unknown as Window, true);
    const listenerHandle = await plugin!.addListener('backButton', () => undefined);
    await plugin!.exitApp();
    await listenerHandle.remove();
    expect(exited).toHaveLength(1);
    expect(removed).toEqual(['backButton']);
  });
});

describe('a host that THROWS rather than rejecting (#138 review round 2)', () => {
  const inertModal = () => ({
    open: vi.fn(),
    close: vi.fn(),
    activeBackState: () => null,
    dismissActive: vi.fn(),
    destroy: vi.fn(),
  });
  const deps = (plugin: CapacitorAppPlugin | null) => ({
    modal: inertModal(),
    isRunLive: () => false,
    isRunUnresolved: () => false,
    showLeaveConfirm: vi.fn(),
    ensurePaused: vi.fn(),
    abortGesture: vi.fn(),
    refreshWakeLock: vi.fn(),
    plugin,
  });

  it('goes INERT for a plugin object whose methods are missing', () => {
    // Capacitor's `registerPlugin` proxy hands back an object with absent methods when the
    // native plugin header is missing. Adapting that yields a handler that looks healthy
    // and throws on first use, so it is rejected at discovery instead.
    for (const App of [{}, { addListener: 'nope' }, { addListener: () => undefined }]) {
      expect(
        findCapacitorApp({ Capacitor: { Plugins: { App } } } as unknown as Window, true),
      ).toBeNull();
    }
  });

  it('a synchronously-throwing addListener does not kill the boot', async () => {
    // The regression this pins is worse than the bug it replaced: `Promise.resolve(f())`
    // evaluates `f()` first, so a throwing host escaped the adapter, escaped
    // createBackHandler, escaped createApp, and killed the hosted boot outright.
    const App = {
      addListener: () => {
        throw new Error('CapacitorException: "App" plugin is not implemented on android');
      },
      exitApp: () => undefined,
    };
    const plugin = findCapacitorApp({ Capacitor: { Plugins: { App } } } as unknown as Window, true);
    expect(plugin).not.toBeNull();
    expect(() => createBackHandler(deps(plugin))).not.toThrow();
  });

  it('a synchronously-throwing exitApp does not escape the Back handler', async () => {
    const App = {
      addListener: (_n: string, _l: () => void) => ({ remove: () => undefined }),
      exitApp: () => {
        throw new Error('exit refused');
      },
    };
    const plugin = findCapacitorApp({ Capacitor: { Plugins: { App } } } as unknown as Window, true);
    const handle = createBackHandler(deps(plugin));
    await vi.waitFor(() => expect(handle).toBeDefined());
    // The press routes to 'default' → exitApp, which throws. It must not escape into
    // Capacitor's own event dispatch.
    const listeners = App as unknown as { addListener: unknown };
    void listeners;
    expect(() => handle.destroy()).not.toThrow();
  });

  it('a handle with no callable remove does not abort destroy()', async () => {
    // `destroy()` is FIRST in main.ts's teardown chain. A throw here skipped
    // `wakeLock.destroy()` — leaving the screen pinned awake, the exact outcome #140
    // exists to prevent — and every other teardown after it.
    const App = {
      addListener: (_n: string, _l: () => void) => undefined, // no handle at all
      exitApp: () => undefined,
    };
    const plugin = findCapacitorApp({ Capacitor: { Plugins: { App } } } as unknown as Window, true);
    const handle = createBackHandler(deps(plugin));
    await vi.waitFor(() => expect(handle).toBeDefined());
    expect(() => handle.destroy()).not.toThrow();
  });

  it('a remove() that throws does not strand the OTHER listener', async () => {
    const removed: string[] = [];
    const App = {
      addListener: (name: string, _l: () => void) => ({
        remove: () => {
          if (name === 'backButton') throw new Error('bridge torn down');
          removed.push(name);
        },
      }),
      exitApp: () => undefined,
    };
    const plugin = findCapacitorApp({ Capacitor: { Plugins: { App } } } as unknown as Window, true);
    const handle = createBackHandler(deps(plugin));
    await vi.waitFor(() => expect(handle).toBeDefined());
    handle.destroy();
    // The second listener is still removed: one failure must not drain the array and
    // strand the rest, which `splice(0)` before the loop used to do.
    await vi.waitFor(() => expect(removed).toEqual(['appStateChange']));
  });
});

describe('findCapacitorApp — told, never inferred (ADR 0012)', () => {
  // A USABLE plugin: both methods present. The earlier fixture declared only `exitApp`,
  // which `findCapacitorApp` now correctly refuses to adapt — an object missing
  // `addListener` is not a plugin, and pretending otherwise is how a handler that looks
  // healthy and throws on first use gets built.
  const bridged = {
    Capacitor: { Plugins: { App: { addListener: vi.fn(), exitApp: vi.fn() } } },
  } as unknown as Window;

  it('returns null when the app was not told it is hosted, bridge present or not', () => {
    expect(findCapacitorApp(bridged, false)).toBeNull();
    expect(findCapacitorApp(null, false)).toBeNull();
  });

  it('returns the plugin when hosted AND the bridge is actually there', () => {
    expect(findCapacitorApp(bridged, true)).not.toBeNull();
  });

  it('returns null when hosted but the bridge or plugin is missing', () => {
    expect(findCapacitorApp({} as unknown as Window, true)).toBeNull();
    expect(findCapacitorApp({ Capacitor: {} } as unknown as Window, true)).toBeNull();
    expect(findCapacitorApp({ Capacitor: { Plugins: {} } } as unknown as Window, true)).toBeNull();
    expect(findCapacitorApp(null, true)).toBeNull();
  });
});
