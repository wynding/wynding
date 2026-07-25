// install.ts — the install path's detection + lifecycle state (PLAN.md Story 11 P3).
//
// Wynding is far more playable installed: an installed PWA gets the whole screen, with no
// browser toolbars eating the top of an already-short landscape viewport. This module owns
// the FACTS about that — which install affordance (if any) this session can offer, whether
// the player has already dismissed the suggestion, and whether the app is already
// installed/standalone. It renders nothing: `overlay.ts` reads `state()` and draws the
// banner, the settings row, and the iOS instructions dialog.
//
// Three branches:
//   promptable — the browser delivered `beforeinstallprompt` this session. That is a
//                CHROMIUM signal, not an Android identifier: it fires on desktop Chromium
//                too, which is why the banner (a phone-oriented affordance) additionally
//                requires a coarse pointer while the settings row does not.
//   ios        — Safari never fires that event and has no programmatic install, so the only
//                honest affordance is instructions for Add to Home Screen.
//   other      — no signal and no known manual flow to describe precisely; the settings row
//                explains where to look rather than pretending there is a button.
//
// Dismissal persists through an injected storage adapter owned by the app entry, NOT
// `settings.ts`: this is a one-bit UI acknowledgement ("I've seen the suggestion"), not a
// player setting, so it is deliberately outside ADR 0008's future async `StorageDriver`
// seam. This plan is the recorded classification.

/** The subset of `MediaQueryList` this module needs — injectable for tests, and the same
 *  shape `rotate.ts` already uses. */
export interface InstallMediaQueryList {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export type InstallMatchMediaFn = (query: string) => InstallMediaQueryList;

/** A one-key string store. `localStorage` when it is writable, an in-memory map otherwise
 *  (Safari private browsing, storage-partitioned iframes, a blocked-cookies profile) — the
 *  dismissal then simply lasts the session rather than throwing on write. */
export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Build the app's storage adapter. Created ONCE at module scope by `main.ts` and threaded
 *  through `createApp`'s deps, so a `destroy()`/recreate inside one session (the host
 *  remounting the app) keeps the same store and therefore the same dismissal — with
 *  `localStorage` unavailable, a per-`createApp` in-memory map would silently resurrect a
 *  dismissed banner. */
export function createStorageAdapter(win?: Window | null): StorageAdapter {
  const memory = new Map<string, string>();
  const backing = ((): Storage | null => {
    try {
      const ls = win?.localStorage;
      if (ls === undefined || ls === null) return null;
      // Presence is not writability — Safari's private mode exposes `localStorage` and
      // throws on `setItem`. Probe it once, here, rather than at every write.
      const probe = '__wy_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    } catch {
      return null;
    }
  })();

  return {
    get(key: string): string | null {
      // The in-memory map is a write-through MIRROR, consulted first: anything written this
      // session is answered from it even if the backing store rejected the write or has
      // since revoked access. A cross-reload read finds an empty mirror and falls through to
      // the backing store, which is exactly where a previous session's value lives.
      const mirrored = memory.get(key);
      if (mirrored !== undefined) return mirrored;
      if (backing === null) return null;
      try {
        return backing.getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      memory.set(key, value);
      if (backing === null) return;
      try {
        backing.setItem(key, value);
      } catch {
        /* quota/permission revoked mid-session — the in-memory copy above still holds */
      }
    },
  };
}

/** The persisted acknowledgement key. */
export const DISMISSED_KEY = 'wy.install.dismissed';

export type InstallBranch = 'promptable' | 'ios' | 'other';

/** The `beforeinstallprompt` event, which no lib.dom typing covers. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallState {
  readonly branch: InstallBranch;
  /** Already running as an installed app — nothing to suggest. */
  readonly standalone: boolean;
  /** Installed during THIS session. `appinstalled` (and an accepted prompt) fire while the
   *  page is still in a browser tab, where the display-mode query does NOT flip — so this is
   *  checked everywhere `standalone` is. */
  readonly installed: boolean;
  readonly dismissed: boolean;
  /** A held `beforeinstallprompt` is available to fire right now (single-use: it is cleared
   *  once used, and the action hides until the browser delivers a fresh one). */
  readonly canPrompt: boolean;
  /** The browser's own install prompt was fired this session and did not install: the player
   *  declined it, or the browser refused to show it (a rejected `prompt()`). The held event is
   *  single-use, so the offer disappears afterwards — this distinguishes "this browser never
   *  offered one" from "one was just fired", which need different copy. */
  readonly promptDeclined: boolean;
  /** Is this session in the BANNER's audience? Coarse pointer AND a branch with something
   *  to offer — the banner is phone-oriented, so a promptable DESKTOP session gets the
   *  settings-row Install action only. */
  readonly bannerAudience: boolean;
}

export type PromptResult = 'accepted' | 'dismissed' | 'unavailable';

export interface InstallHandle {
  state(): InstallState;
  /** Subscribe to state changes (a captured prompt, a dismissal, an install). Returns an
   *  unsubscribe function. `main.ts` folds a revision counter into the HUD memo key on this,
   *  so a `beforeinstallprompt` arriving while the run is held pre-start updates the banner
   *  immediately instead of waiting for a tick that may never come. */
  onChange(cb: () => void): () => void;
  /** Record the player's dismissal (persisted). */
  dismiss(): void;
  /** Fire the held prompt. SINGLE-USE: the held event is cleared in `finally`, so a second
   *  activation before the browser delivers a fresh one cannot re-call it (the spec forbids
   *  re-prompting a consumed event, and Chromium throws). */
  prompt(): Promise<PromptResult>;
  /** The banner never resurrects after the session's first successful Start — including
   *  across Play-again, which returns to a pre-start state. */
  endBannerForSession(): void;
  bannerEndedForSession(): boolean;
  destroy(): void;
}

/** The window-ish event target this module listens on. */
export interface InstallEventTarget {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

/** The navigator facts the branch decision reads. `standalone` is Safari's non-standard
 *  installed-app flag. */
export interface InstallNavigator {
  readonly platform: string;
  readonly maxTouchPoints: number;
  readonly standalone?: boolean;
}

export interface InstallDeps {
  readonly storage: StorageAdapter;
  readonly matchMedia: InstallMatchMediaFn;
  readonly target: InstallEventTarget;
  readonly navigator: InstallNavigator;
}

/** iOS Safari's Add-to-Home-Screen audience. `navigator.platform` is deprecated but remains
 *  the only reliable iOS discriminator; modern iPadOS reports `MacIntel`, so a touch-capable
 *  "Mac" is an iPad (a real Mac reports `maxTouchPoints === 0`). */
function isIos(nav: InstallNavigator): boolean {
  if (/iPhone|iPad|iPod/.test(nav.platform)) return true;
  return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1;
}

export function createInstall(deps: InstallDeps): InstallHandle {
  const { storage, matchMedia, target, navigator: nav } = deps;

  const standaloneQuery = matchMedia('(display-mode: standalone)');
  const coarseQuery = matchMedia('(pointer: coarse)');

  let held: BeforeInstallPromptEvent | null = null;
  let installed = false;
  let dismissed = storage.get(DISMISSED_KEY) === '1';
  let bannerEnded = false;
  let promptDeclined = false;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const cb of [...listeners]) cb();
  };

  /** Already an installed app? Display-mode covers Chromium/Android; `navigator.standalone`
   *  is Safari's own flag for a home-screen launch. */
  const isStandalone = (): boolean => standaloneQuery.matches || nav.standalone === true;

  const branch = (): InstallBranch => {
    if (held !== null) return 'promptable';
    if (isIos(nav)) return 'ios';
    return 'other';
  };

  const onBeforeInstallPrompt = (e: Event): void => {
    // Suppress Chromium's own mini-infobar and hold the event: the app offers install at a
    // moment it chooses (the pre-start banner / the settings row), not mid-gesture.
    e.preventDefault();
    held = e as BeforeInstallPromptEvent;
    emit();
  };

  const onAppInstalled = (): void => {
    // The page is still in a browser TAB here — `(display-mode: standalone)` does not flip
    // — so record it explicitly and hide every install affordance from now on.
    installed = true;
    held = null;
    dismissed = true;
    storage.set(DISMISSED_KEY, '1');
    emit();
  };

  target.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  target.addEventListener('appinstalled', onAppInstalled);
  // A display-mode/pointer change (launching into standalone, docking a tablet to a mouse)
  // changes what should be offered, and neither is a game tick — re-render on both.
  standaloneQuery.addEventListener('change', emit);
  coarseQuery.addEventListener('change', emit);

  return {
    state(): InstallState {
      const b = branch();
      return {
        branch: b,
        standalone: isStandalone(),
        installed,
        dismissed,
        canPrompt: held !== null,
        promptDeclined,
        bannerAudience: coarseQuery.matches && (b === 'promptable' || b === 'ios'),
      };
    },
    onChange(cb: () => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dismiss(): void {
      if (dismissed) return;
      dismissed = true;
      storage.set(DISMISSED_KEY, '1');
      emit();
    },
    async prompt(): Promise<PromptResult> {
      const event = held;
      if (event === null) return 'unavailable';
      // Consume the event NOW, not in `finally`: the `finally` only runs after both awaits
      // below, so a second activation while the first is still in flight would otherwise see
      // a non-null `held` and re-call `prompt()` on an already-consumed event (which Chromium
      // rejects). This module owns its own single-use contract rather than relying on the
      // caller's in-flight guard.
      held = null;
      try {
        await event.prompt();
        const choice = await event.userChoice;
        if (choice.outcome === 'accepted') {
          installed = true;
          dismissed = true;
          storage.set(DISMISSED_KEY, '1');
        } else {
          // Not a `dismiss()`: the suggestion stays available (the settings row remains, and
          // a fresh `beforeinstallprompt` re-arms the button). It only changes the copy the
          // row shows while there is no held event to fire.
          promptDeclined = true;
        }
        return choice.outcome;
      } catch (err) {
        // `prompt()` itself can reject (Chromium throws when user activation has expired, and
        // an embedder/permissions-policy refusal rejects too). The held event is consumed in
        // `finally` either way, so without this the row would fall back to "your browser
        // doesn't offer an install prompt" for a session that just fired one. Same copy as a
        // decline: the offer is gone for now, and the browser menu is the way in.
        promptDeclined = true;
        throw err;
      } finally {
        // The event was already consumed above; this just publishes the resulting state (the
        // action hides until the browser delivers a fresh event).
        emit();
      }
    },
    endBannerForSession(): void {
      if (bannerEnded) return;
      bannerEnded = true;
      emit();
    },
    bannerEndedForSession(): boolean {
      return bannerEnded;
    },
    destroy(): void {
      target.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      target.removeEventListener('appinstalled', onAppInstalled);
      standaloneQuery.removeEventListener('change', emit);
      coarseQuery.removeEventListener('change', emit);
      listeners.clear();
      held = null;
    },
  };
}
