// dpr-tracker.ts — live device-pixel-ratio change tracking (monitor move, browser
// zoom, OS scaling change), extracted as a small pure module so it is independently
// unit-testable: `scene.ts` (Phaser) is coverage-excluded, and this is the one piece
// of P5's HiDPI logic with real branching worth pinning under a mock `matchMedia`.
//
// A CSS `resolution` media query only fires when the CURRENT value is LEFT — it never
// reports the new value directly — so tracking a change means RE-CREATING the query
// for the NEW dpr after every transition: a query built once for dpr=1 goes silent
// forever after the display moves to dpr=2 (it already left the value it was watching
// and has nothing left to leave). Exactly one listener is kept armed at a time.

/** The subset of `window.matchMedia` this module needs — injectable so tests can pass
 *  a mock instead of a real `MediaQueryList`. */
export interface MatchMediaLike {
  (query: string): {
    addEventListener(type: 'change', listener: () => void): void;
    removeEventListener(type: 'change', listener: () => void): void;
  };
}

export interface DprTracker {
  /** (Re-)arm the tracker to watch for the display leaving `dpr`, detaching any
   *  previously-armed query first. Call again with the new raw dpr after a change (the
   *  scene does this from inside `onChange`) — an un-rearmed query only ever fires once. */
  rearm(dpr: number): void;
  /** Detach the currently-armed listener, if any. Idempotent; safe to call unarmed. */
  destroy(): void;
}

/** Build a DPR-change tracker: `onChange` fires whenever the display actually leaves
 *  whatever raw dpr the tracker was last `rearm`ed for. */
export function createDprTracker(onChange: () => void, matchMediaFn: MatchMediaLike): DprTracker {
  let activeQuery: ReturnType<MatchMediaLike> | null = null;
  let activeListener: (() => void) | null = null;

  const detach = (): void => {
    if (activeQuery !== null && activeListener !== null) {
      activeQuery.removeEventListener('change', activeListener);
    }
    activeQuery = null;
    activeListener = null;
  };

  return {
    rearm(dpr: number): void {
      detach();
      const query = matchMediaFn(`(resolution: ${dpr}dppx)`);
      const listener = (): void => onChange();
      query.addEventListener('change', listener);
      activeQuery = query;
      activeListener = listener;
    },
    destroy(): void {
      detach();
    },
  };
}

/** Clamp a raw device pixel ratio to the effective value the renderer actually draws
 *  at (ADR 0005: fill cost scales dpr², so a 3× display still renders at 2×). Treats
 *  non-positive/garbage input as 1 rather than propagating a broken scale. */
export function clampDpr(raw: number): number {
  return Math.min(2, raw > 0 ? raw : 1);
}
