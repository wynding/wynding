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

/** The five outcomes a Back press can have. */
export type BackAction =
  /** A dismissable overlay is open (settings, the install instructions, the leave
   *  confirm) — Back closes it, matching its Escape semantics. */
  | 'dismissModal'
  /** A state-driven overlay is open — Back is swallowed WITHOUT dismissing. */
  | 'consume'
  /** Nothing is open and a run is live and unpaused — Back pauses it. */
  | 'pause'
  /** Nothing is open, and a run is under way but already paused — Back offers the leave
   *  confirm rather than exiting out from under it. */
  | 'leaveConfirm'
  /** Nothing to dismiss and no run to lose — leave the app. */
  | 'default';

export interface BackRouteInput {
  /** How the active overlay answers a back key, or `null` when none is open — read
   *  straight off `modal.ts`, the stack's owner, so this table can never disagree with
   *  the one Escape uses. */
  readonly modal: 'dismiss' | 'consume' | null;
  /** Started, not paused, not resolved — the same predicate `ensurePaused` guards on. */
  readonly runLive: boolean;
  /** Started and not resolved — TRUE FOR A PAUSED RUN TOO, which is the whole difference
   *  between this and `runLive`. A paused run is a run the player still has. */
  readonly runUnresolved: boolean;
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
 *
 * THE LAST TWO ROWS SPLIT WHAT "NOTHING RUNNING" USED TO COVER, and the split is a
 * ruling rather than a refinement. "A live run pauses, anything else exits" quietly
 * treated a PAUSED run as nothing to lose — so a player who paused, then pressed Back,
 * lost the run without being asked. `main.ts` already decided this question for the
 * other way out of the app: the home link intercepts its own activation and routes
 * through a leave confirm whenever there is a run or a pending plan. The hardware path
 * is the same act by a different control, so it gets the same doctrine. Back exits
 * immediately only when there is genuinely no unresolved run; otherwise it asks, and the
 * confirm's own Back press dismisses it (it registers dismissable) — which reads as
 * "Stay", the safe default landing exactly where a second press lands.
 */
export function routeBack(input: BackRouteInput): BackAction {
  if (input.modal === 'dismiss') return 'dismissModal';
  if (input.modal === 'consume') return 'consume';
  if (input.runLive) return 'pause';
  return input.runUnresolved ? 'leaveConfirm' : 'default';
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

/**
 * The App plugin AS THE BRIDGE ACTUALLY HANDS IT OVER — which is not the typed shape
 * above.
 *
 * Capacitor's legacy bridge (the one Android 8.5 installs on `window`) generates
 * `addListener` to return the listener handle **synchronously**, not a promise, and the
 * handle's `remove` likewise. Modern/other hosts return promises. Both are legitimate, and
 * code downstream of this file should not have to know which it got — so nothing here
 * assumes either. The return types are `unknown` on purpose: they are whatever the host
 * decided, and the adapter below is what makes them uniform.
 */
interface RawCapacitorAppPlugin {
  addListener(eventName: string, listener: (payload: never) => void): unknown;
  exitApp(): unknown;
}

interface CapacitorBridge {
  readonly Plugins?: { readonly App?: RawCapacitorAppPlugin };
}

/** A listener handle as the host gave it — `remove` may or may not return a promise. */
interface RawListenerHandle {
  remove(): unknown;
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
  const raw = bridge?.Plugins?.App;
  if (raw === undefined || raw === null) return null;
  // An object that is not a usable plugin goes INERT rather than being adapted. Capacitor's
  // `registerPlugin` proxy hands back an object whose methods are absent when the native
  // plugin header is missing, and adapting that produces a handler that looks healthy and
  // throws on first use.
  if (typeof raw.addListener !== 'function' || typeof raw.exitApp !== 'function') return null;

  // NORMALIZE AT THE BOUNDARY. Everything downstream treats these as promises, and on the
  // legacy bridge they are not — `addListener` returns the handle synchronously, so a
  // `.then` on that return threw a TypeError on every hosted boot with the plugin
  // installed. Back was dead on the actual device while every test passed, because the
  // doubles all returned promises.
  //
  // ASYNC, NOT `Promise.resolve(raw.f())`. An earlier revision used the latter and claimed
  // it "cannot be wrong for any host shape" — which was false, and the falseness is the
  // whole lesson: `Promise.resolve` is total over VALUES, not over CONTROL FLOW. It
  // normalizes what a call returns, and does nothing about a call that throws instead of
  // returning. That gap is not theoretical on this bridge: a synchronous method reports
  // failure by throwing, and Capacitor's own proxy throws `CapacitorException(…,
  // Unimplemented)`. So the legacy success path was normalized and the legacy FAILURE path
  // was left to escape — out of `createBackHandler`, out of `createApp`, killing the
  // hosted boot outright, which is strictly worse than the dead Back it replaced.
  //
  // An `async` function converts a synchronous throw into a rejection, so the boundary is
  // now total over both. Downstream `bridge()` absorbs the rejection, which is what it was
  // built for.
  return {
    addListener: async (eventName: string, listener: (payload: never) => void) => {
      const handle = (await raw.addListener(eventName, listener)) as RawListenerHandle | undefined;
      return {
        remove: async (): Promise<void> => {
          // A host may answer with no handle at all, or a bare id — neither has a callable
          // `remove`, and invoking one anyway threw synchronously out of `destroy()`,
          // taking the rest of the app's teardown chain with it.
          const remove = handle?.remove;
          if (typeof remove !== 'function') return;
          await remove.call(handle);
        },
      } satisfies PluginListenerHandleLike;
    },
    exitApp: async (): Promise<void> => {
      await raw.exitApp();
    },
  } as CapacitorAppPlugin;
}

export interface BackHandlerDeps {
  /** The stack's owner — the routing table's modal input and the dismissal effect. */
  readonly modal: ModalOwner;
  /** Started, not paused, not resolved. */
  readonly isRunLive: () => boolean;
  /** Started and not resolved — a paused run included. */
  readonly isRunUnresolved: () => boolean;
  /** Open the leave-this-run confirm, calling back on commit. The SAME dialog the home
   *  link's interceptor uses (`main.ts`), not a second one: one way to be asked whether
   *  you meant to abandon a run, whichever control started the asking. */
  readonly showLeaveConfirm: (onConfirm: () => void) => void;
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

  /**
   * ONE policy for every call this module makes into the bridge.
   *
   * TAKES A THUNK, NOT A PROMISE. Given a promise, the call that produced it has already
   * run in the caller's frame, so anything it threw on the way to returning is somewhere
   * this helper can never reach — and on the legacy bridge, where these methods are
   * synchronous, throwing is exactly how they report failure. `findCapacitorApp`'s adapter
   * closes that at the boundary; the thunk closes it here too, so neither layer is the
   * only thing standing between a native exception and a dead page.
   *
   * SWALLOWED, BUT NOT SILENT. There is no recovery any of these could drive — Back not
   * exiting is a nuisance, a crashed page is not — so the rejection stops here. Discarding
   * the error VALUE as well is a different thing and is not justified: a failed
   * `addListener` is permanent for the session and fails OPEN (with no listener registered
   * Capacitor handles Back itself, so Back exits the app and bypasses the leave confirm
   * this module exists to provide), and a failed `remove` leaks a native listener. Neither
   * is recoverable and both are worth being able to see, so DEV gets a diagnosis and
   * production gets no console noise — the same posture `main.ts` takes for its
   * fail-closed persistence and `controller.ts` for its dropped-DoT tripwire.
   */
  const report = (what: string, error: unknown): void => {
    if (import.meta.env.DEV) console.warn(`capacitor bridge ${what} failed:`, error);
  };
  const bridge = <R>(
    what: string,
    make: () => Promise<R>,
    onResolve?: (value: R) => void,
  ): void => {
    try {
      make()
        .then(
          (value) => onResolve?.(value),
          (error: unknown) => report(what, error),
        )
        .catch((error: unknown) => report(what, error));
    } catch (error) {
      // Belt to the adapter's braces: a host that throws synchronously past both would
      // otherwise take the page with it.
      report(what, error);
    }
  };

  let destroyed = false;
  const handles: PluginListenerHandleLike[] = [];
  const keep = (handle: PluginListenerHandleLike): void => {
    if (destroyed) {
      bridge('listener remove', () => handle.remove());
      return;
    }
    handles.push(handle);
  };

  const onBack = (): void => {
    const action = routeBack({
      modal: deps.modal.activeDismissal(),
      runLive: deps.isRunLive(),
      runUnresolved: deps.isRunUnresolved(),
    });
    switch (action) {
      case 'dismissModal':
        deps.modal.dismissActive();
        return;
      case 'consume':
        return; // swallowed on purpose — see routeBack's note on results and rotate
      case 'pause':
        deps.abortGesture();
        deps.ensurePaused();
        return;
      case 'leaveConfirm':
        // The run is already paused (that is what distinguishes this row from `pause`),
        // so the dialog opens over a still board. `showLeaveConfirm` owns the modal-open
        // lifecycle, gesture abort included, exactly as the home link's route does.
        deps.showLeaveConfirm(() => bridge('exitApp', () => plugin.exitApp()));
        return;
      case 'default':
        // Explicit, because registering a listener at all turned the OS default off.
        bridge('exitApp', () => plugin.exitApp());
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

  bridge('addListener(backButton)', () => plugin.addListener('backButton', onBack), keep);
  bridge(
    'addListener(appStateChange)',
    () => plugin.addListener('appStateChange', onStateChange),
    keep,
  );

  return {
    destroy(): void {
      destroyed = true;
      // A LOCAL COPY, and one bridge call per handle. `splice(0)` drained the array
      // before the loop, so a throw from the first `remove` both aborted the loop and
      // destroyed the reference to the second listener — unremovable forever. It also
      // propagated into `main.ts`'s teardown chain, skipping `wakeLock.destroy()` and
      // leaving the screen pinned awake, which is the exact outcome #140 exists to
      // prevent. Each removal is now independent and contained.
      for (const handle of handles.splice(0)) bridge('listener remove', () => handle.remove());
    },
  };
}
