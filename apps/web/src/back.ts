// back.ts — Android's hardware Back button, and the native app-lifecycle events that
// arrive with it (#138, and #134's background-pause sub-item).
//
// THIS IS INPUT TRANSLATION, and it lives where the rest of it lives: in `apps/web`, not
// in `@wynding/render`. A Back press is a player intent that resolves to one of four
// outcomes, exactly as a key press does — nothing here draws anything or owns any state.
//
// NO BUILD-TIME CAPACITOR DEPENDENCY. The plugin is reached through the bridge Capacitor
// installs on `window` (`Capacitor.Plugins.App`), discovered at runtime and only when the
// app has been TOLD it is hosted (ADR 0012 — the web build never infers its environment).
// Importing `@capacitor/app` here instead would put bridge code into the open-web bundle
// that ADR 0013 keeps as a separate artifact, to serve a button no browser has. The
// native side still installs the package — that is what registers the plugin — but that
// belongs to `apps/mobile`, which is the package that builds a native project.
//
// ONCE A `backButton` LISTENER EXISTS, CAPACITOR STOPS HANDLING BACK ITSELF. So "allow
// the default" is not passivity here: leaving the app has to be an explicit `exitApp()`,
// or Back would become a dead key the moment this module is wired up.

import type { ModalOwner } from './modal';

/** The four outcomes a Back press can have. */
export type BackAction =
  /** A dismissable overlay is open (settings, the install instructions, the leave
   *  confirm) — Back closes it, matching its Escape semantics. */
  | 'dismissModal'
  /** A state-driven overlay is open — Back is swallowed WITHOUT dismissing. */
  | 'consume'
  /** Nothing is open and a run is live and unpaused — Back pauses it. */
  | 'pause'
  /** Nothing to dismiss and nothing running — leave the app. */
  | 'default';

export interface BackRouteInput {
  /** How the active overlay answers a back key, or `null` when none is open — read
   *  straight off `modal.ts`, the stack's owner, so this table can never disagree with
   *  the one Escape uses. */
  readonly modal: 'dismiss' | 'consume' | null;
  /** Started, not paused, not resolved — the same predicate `ensurePaused` guards on. */
  readonly runLive: boolean;
}

/**
 * THE ROUTING TABLE, as a pure function so every row is a test rather than a claim.
 *
 * The modal rows are decided per overlay at each overlay's own `open` call, and the two
 * that consume rather than dismiss are worth naming because both look like oversights:
 *
 *   `results` — the run is OVER. Dismissing would imply it can be resumed; Play again and
 *               the home link are the real affordances, and they are right there.
 *   `rotate`  — REACHABLE on device, despite both native projects locking landscape.
 *               `rotate.ts:27-34` documents the live case: Android 16 (API 36, which
 *               Capacitor 8 targets) IGNORES `android:screenOrientation` on `sw600dp`+
 *               displays unless an exception applies, and where the OS declines, this
 *               prompt is what the player gets. It is a state-driven, non-dismissable
 *               overlay cleared only by the device turning — so Back must be CONSUMED.
 *               Treating it as unreachable would let a press fall through to app exit
 *               from a screen the player cannot otherwise leave.
 */
export function routeBack(input: BackRouteInput): BackAction {
  if (input.modal === 'dismiss') return 'dismissModal';
  if (input.modal === 'consume') return 'consume';
  return input.runLive ? 'pause' : 'default';
}

/** What `App.addListener` hands back. */
export interface PluginListenerHandleLike {
  remove(): Promise<void>;
}

/** The `backButton` event payload. `canGoBack` is Capacitor's WebView-history flag; this
 *  app has no in-page history to walk, so the table above never consults it. */
export interface BackButtonEventLike {
  readonly canGoBack: boolean;
}

/** The slice of Capacitor's App plugin this module uses, declared structurally so no
 *  package import is needed and a test can pass a fake. */
export interface CapacitorAppPlugin {
  addListener(
    eventName: 'backButton',
    listener: (event: BackButtonEventLike) => void,
  ): Promise<PluginListenerHandleLike>;
  addListener(
    eventName: 'appStateChange',
    listener: (state: { readonly isActive: boolean }) => void,
  ): Promise<PluginListenerHandleLike>;
  exitApp(): Promise<void>;
}

interface CapacitorBridge {
  readonly Plugins?: { readonly App?: CapacitorAppPlugin };
}

/**
 * Find the App plugin on the Capacitor bridge, or `null`.
 *
 * `hosted` is passed IN rather than inferred, and it gates the lookup entirely: ADR 0012
 * exists because `install.ts` once made a confident claim about its environment from
 * inside a WebView and was wrong (#146). A probe for `window.Capacitor` would be exactly
 * that mistake in a new place — on the open web it would simply always be absent, which
 * makes it look harmless right up until something else defines the global.
 */
export function findCapacitorApp(
  view: Window | null | undefined,
  hosted: boolean,
): CapacitorAppPlugin | null {
  if (!hosted) return null;
  const bridge = (view as unknown as { Capacitor?: CapacitorBridge } | null | undefined)?.Capacitor;
  return bridge?.Plugins?.App ?? null;
}

export interface BackHandlerDeps {
  /** The stack's owner — the routing table's modal input and the dismissal effect. */
  readonly modal: ModalOwner;
  /** Started, not paused, not resolved. */
  readonly isRunLive: () => boolean;
  /** The ONE app-level pause seam. This module is a CALLER of it, never a second pause
   *  path — the same discipline the settings dialog, the rotate prompt and the
   *  backgrounding listeners already follow. */
  readonly ensurePaused: () => void;
  /** Cancel an in-flight placement gesture before backgrounding — the order every other
   *  caller of the pause seam uses. */
  readonly abortGesture: () => void;
  /** Reconcile the screen wake lock after a lifecycle change (#140). */
  readonly refreshWakeLock: () => void;
  readonly plugin: CapacitorAppPlugin | null;
}

export interface BackHandle {
  destroy(): void;
}

/**
 * Wire the hardware Back button and the native app-lifecycle event.
 *
 * `appStateChange` is #134's background-pause sub-item, and it shares this module for the
 * reason the issue blesses: both are "the native shell has a lifecycle the web never had",
 * and both route into `ensurePaused`. The web already pauses on `visibilitychange` and
 * `pagehide` (#139); this is the belt for the platform where those two have historically
 * been the least reliable — an Android WebView — and it is additive, because
 * `ensurePaused` is idempotent by contract.
 *
 * Listener registration is ASYNCHRONOUS (Capacitor's `addListener` returns a promise), so
 * `destroy()` may be called before a handle exists. Both handles are therefore removed
 * through a latch that a late-arriving registration also honours — otherwise a
 * destroy/recreate inside one session would leave the old app's listener bound.
 */
export function createBackHandler(deps: BackHandlerDeps): BackHandle {
  const { plugin } = deps;
  if (plugin === null) return { destroy: () => undefined };

  let destroyed = false;
  const handles: PluginListenerHandleLike[] = [];
  const keep = (handle: PluginListenerHandleLike): void => {
    if (destroyed) {
      void handle.remove();
      return;
    }
    handles.push(handle);
  };

  const onBack = (): void => {
    switch (routeBack({ modal: deps.modal.activeDismissal(), runLive: deps.isRunLive() })) {
      case 'dismissModal':
        deps.modal.dismissActive();
        return;
      case 'consume':
        return; // swallowed on purpose — see routeBack's note on results and rotate
      case 'pause':
        deps.abortGesture();
        deps.ensurePaused();
        return;
      case 'default':
        // Explicit, because registering a listener at all turned the OS default off.
        void plugin.exitApp();
        return;
    }
  };

  const onStateChange = (state: { readonly isActive: boolean }): void => {
    // Only the BACKGROUNDING half acts. Returning to the foreground closes nothing and
    // starts nothing — the player resumes deliberately from the Dock, the house rule the
    // rotate prompt, the settings dialog and #139's listeners all already follow. The
    // wake lock is reconciled in BOTH directions, because the platform drops it on its
    // own and #140 must not be correct only when the pause is.
    if (state.isActive) {
      deps.refreshWakeLock();
      return;
    }
    deps.abortGesture();
    deps.ensurePaused();
    deps.refreshWakeLock();
  };

  void plugin.addListener('backButton', onBack).then(keep);
  void plugin.addListener('appStateChange', onStateChange).then(keep);

  return {
    destroy(): void {
      destroyed = true;
      for (const handle of handles.splice(0)) void handle.remove();
    },
  };
}
