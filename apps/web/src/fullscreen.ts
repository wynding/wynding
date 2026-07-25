// fullscreen.ts — one-shot fullscreen on Start (PLAN.md Story 11 P4).
//
// On a phone in landscape the browser's own toolbars eat the top of an already-short
// viewport, on top of everything the Compact layout just reclaimed. Fullscreen gives that
// back — but only where it is both possible and wanted, and only ONCE, on the transition
// into a run (a fullscreen request is only honoured inside a user gesture anyway).
//
// The gate is entirely CAPABILITY-based — never UA sniffing. `(pointer: coarse)` is the
// honest expression of the intent ("Android phones"): it also catches touch Windows and
// ChromeOS, which have exactly the same cramped-browser-chrome problem, and correctly
// excludes a desktop browser where taking over the whole screen would be presumptuous.
//
// Deliberately NOT wired to `fullscreenchange`: leaving fullscreen (the system back gesture,
// Escape, a notification shade) is the player's business and must never touch game state.
// The rotate overlay keeps working inside fullscreen because it is a DOM sibling, not a
// browser affordance.

/** The document surface this module needs — injectable so every branch is unit-reachable
 *  (jsdom implements none of the Fullscreen API). */
export interface FullscreenDocument {
  readonly fullscreenElement?: Element | null;
  readonly documentElement: {
    requestFullscreen?: (options?: { navigationUI?: 'auto' | 'hide' | 'show' }) => Promise<void>;
  };
}

export interface FullscreenDeps {
  readonly doc: FullscreenDocument;
  /** `(pointer: coarse)` — matched at REQUEST time, not at construction: a tablet can gain
   *  or lose a pointer between load and Start. */
  readonly matchesCoarsePointer: () => boolean;
  /** Already running as an installed/standalone app — it already owns the screen. */
  readonly isStandalone: () => boolean;
}

/**
 * Request fullscreen if — and only if — every gate passes:
 *
 *   - `requestFullscreen` exists (Safari on iPhone has no element fullscreen at all);
 *   - the pointer is coarse (the capability standing in for "cramped mobile chrome");
 *   - the app is not already standalone (an installed PWA already has the screen);
 *   - the document is not already fullscreen (never re-request mid-run).
 *
 * Returns whether a request was actually made. A rejection is swallowed: the browser
 * refusing (no user activation, a permissions policy, a user preference) must never break
 * or delay Start — the run begins either way.
 */
export function requestFullscreen(deps: FullscreenDeps): boolean {
  const request = deps.doc.documentElement.requestFullscreen;
  if (typeof request !== 'function') return false;
  if (!deps.matchesCoarsePointer()) return false;
  if (deps.isStandalone()) return false;
  if (deps.doc.fullscreenElement != null) return false;
  // `navigationUI: 'hide'` asks for the maximally immersive form where supported; browsers
  // that do not understand it simply ignore the hint.
  void Promise.resolve(request.call(deps.doc.documentElement, { navigationUI: 'hide' })).catch(
    () => {},
  );
  return true;
}
