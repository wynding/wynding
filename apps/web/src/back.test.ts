import { describe, expect, it, vi } from 'vitest';
import { createModalOwner, type ModalOverlay } from './modal';
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
 */
const TABLE: {
  readonly name: string;
  readonly modal: 'dismiss' | 'consume' | null;
  readonly runLive: boolean;
  readonly expected: BackAction;
}[] = [
  { name: 'settings open, run live', modal: 'dismiss', runLive: true, expected: 'dismissModal' },
  { name: 'settings open, no run', modal: 'dismiss', runLive: false, expected: 'dismissModal' },
  { name: 'results open, run over', modal: 'consume', runLive: false, expected: 'consume' },
  { name: 'rotate open, run live', modal: 'consume', runLive: true, expected: 'consume' },
  { name: 'rotate open, run paused', modal: 'consume', runLive: false, expected: 'consume' },
  { name: 'nothing open, run live', modal: null, runLive: true, expected: 'pause' },
  { name: 'nothing open, nothing running', modal: null, runLive: false, expected: 'default' },
];

describe('routeBack — the decision table (#138)', () => {
  for (const row of TABLE) {
    it(`${row.name} → ${row.expected}`, () => {
      expect(routeBack({ modal: row.modal, runLive: row.runLive })).toBe(row.expected);
    });
  }

  it('covers every reachable combination — no state falls off the table', () => {
    for (const modal of ['dismiss', 'consume', null] as const) {
      for (const runLive of [true, false]) {
        expect(TABLE.some((r) => r.modal === modal && r.runLive === runLive)).toBe(true);
      }
    }
  });

  it('a dismissable overlay outranks a live run — Back closes it, it does not pause', () => {
    expect(routeBack({ modal: 'dismiss', runLive: true })).toBe('dismissModal');
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
    expect(owner().activeDismissal()).toBeNull();
  });

  it('settings DISMISSES — the same answer it gives Escape', () => {
    const m = owner();
    m.open(overlay(), { priority: 'settings', dismissOnEscape: true });
    expect(m.activeDismissal()).toBe('dismiss');
  });

  it('RESULTS IS NOT DISMISSABLE — the run is over, so Back is consumed', () => {
    const m = owner();
    // Registered exactly as `overlay.ts` registers it: state-driven, no `dismissOnEscape`.
    m.open(overlay(), { priority: 'results' });
    expect(m.activeDismissal()).toBe('consume');
    expect(routeBack({ modal: m.activeDismissal(), runLive: false })).toBe('consume');
  });

  it('ROTATE IS CONSUMED, NOT DISMISSED — it is reachable, and only the device clears it', () => {
    // rotate.ts:27-34: Android 16 (API 36) ignores `android:screenOrientation` on sw600dp+
    // displays unless an exception applies, so this overlay is live on device. Registered
    // exactly as `rotate.ts` registers it — no `dismissOnEscape`.
    const m = owner();
    m.open(overlay(), { priority: 'rotate' });
    expect(m.activeDismissal()).toBe('consume');
    // The failure this prevents: falling through to app exit from a screen the player
    // cannot otherwise leave.
    expect(routeBack({ modal: m.activeDismissal(), runLive: true })).not.toBe('default');
  });

  it('reads the HIGHEST-PRIORITY open overlay, not the last one opened', () => {
    const m = owner();
    const settings = overlay();
    m.open(settings, { priority: 'settings', dismissOnEscape: true });
    m.open(overlay(), { priority: 'results' });
    // Results outranks settings, so Back must answer for results.
    expect(m.activeDismissal()).toBe('consume');
  });

  it('dismissActive closes a dismissable overlay and leaves a consuming one alone', () => {
    const m = owner();
    const settings = overlay();
    m.open(settings, { priority: 'settings', dismissOnEscape: true });
    m.dismissActive();
    expect(settings.hide).toHaveBeenCalled();
    expect(m.activeDismissal()).toBeNull();

    const results = overlay();
    m.open(results, { priority: 'results' });
    m.dismissActive();
    expect(results.hide).not.toHaveBeenCalled();
    expect(m.activeDismissal()).toBe('consume');
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

  function harness(options: { runLive?: boolean; dismissal?: 'dismiss' | 'consume' | null } = {}) {
    const fake = fakePlugin();
    const calls = { ensurePaused: 0, abortGesture: 0, dismissActive: 0, refreshWakeLock: 0 };
    const handle = createBackHandler({
      modal: {
        open: vi.fn(),
        close: vi.fn(),
        activeDismissal: () => options.dismissal ?? null,
        dismissActive: () => void calls.dismissActive++,
        destroy: vi.fn(),
      },
      isRunLive: () => options.runLive === true,
      ensurePaused: () => void calls.ensurePaused++,
      abortGesture: () => void calls.abortGesture++,
      refreshWakeLock: () => void calls.refreshWakeLock++,
      plugin: fake.plugin,
    });
    return { ...fake, calls, handle };
  }

  it('registers for both the Back button and the native lifecycle', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.registered().sort()).toEqual(['appStateChange', 'backButton']));
    h.handle.destroy();
  });

  it('a dismissable overlay: Back closes it, and nothing pauses or exits', async () => {
    const h = harness({ dismissal: 'dismiss', runLive: true });
    await vi.waitFor(() => expect(h.registered()).toContain('backButton'));
    h.back();
    expect(h.calls.dismissActive).toBe(1);
    expect(h.calls.ensurePaused).toBe(0);
    expect(h.exitApp).not.toHaveBeenCalled();
    h.handle.destroy();
  });

  it('a consuming overlay: Back does NOTHING — and above all does not exit the app', async () => {
    const h = harness({ dismissal: 'consume', runLive: true });
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

  it('nothing to dismiss and nothing running: Back EXPLICITLY exits', async () => {
    // Explicit because registering a listener at all turns Capacitor's own handling off —
    // without this call Back would be a dead key.
    const h = harness({ runLive: false });
    await vi.waitFor(() => expect(h.registered()).toContain('backButton'));
    h.back();
    expect(h.exitApp).toHaveBeenCalledTimes(1);
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
        activeDismissal: () => null,
        dismissActive: vi.fn(),
        destroy: vi.fn(),
      },
      isRunLive: () => true,
      ensurePaused: vi.fn(),
      abortGesture: vi.fn(),
      refreshWakeLock: vi.fn(),
      plugin: null,
    });
    expect(() => handle.destroy()).not.toThrow();
  });
});

describe('findCapacitorApp — told, never inferred (ADR 0012)', () => {
  const bridged = { Capacitor: { Plugins: { App: { exitApp: vi.fn() } } } } as unknown as Window;

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
