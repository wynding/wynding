// wakelock.ts — hold the screen awake exactly while the wave is moving (#140).
//
// A phone's auto-lock does not care that a wave is in flight: on a default Android or iOS
// timeout the screen dims and locks mid-run, on a game that is played by watching. The
// Screen Wake Lock API is the fix, and this module owns the whole of it — the predicate is
// supplied, everything else about acquiring, releasing and NOT leaking a sentinel is here.
//
// BEST-EFFORT BY CONSTRUCTION, and that is a decision, not a gap. `navigator.wakeLock` is
// absent below iOS 16.4 (Capacitor 8's floor is iOS 15) and on an AOSP WebView without Play
// updates, and it can refuse even where it exists. Every one of those is a quiet no-op the
// run never notices — never a thrown error, never a message. A device that will not hold a
// lock simply behaves as it does today.
//
// Three properties are easy to miss and expensive to debug, so each is stated where it is
// implemented below:
//
//   1. Acquisition is ASYNCHRONOUS, so the state that asked for a lock may be gone before
//      the sentinel arrives. A pause landing mid-request would otherwise yield a live
//      sentinel with nothing left to release it — the held-while-paused battery drain the
//      #140 decision exists to avoid. Hence the predicate is re-read at RESOLUTION time,
//      not only at request time.
//   2. Requests are SINGLE-FLIGHT. A second reconcile while one is outstanding must not
//      start another: the first sentinel would be orphaned, unreleasable and un-observable.
//   3. The platform releases the lock ON ITS OWN when the document hides, so held-ness is
//      OBSERVED (the sentinel's `release` event) rather than remembered.
//   4. A REFUSAL IS LATCHED. `refresh()` is called from the app's HUD refresh, which runs on
//      every sim tick while a wave is moving — 20/s at speed 1, 60/s at 3× — so a platform
//      that exposes the API and declines (Chrome denies a screen lock on low battery; a
//      WebView without the `screen-wake-lock` grant refuses outright) would otherwise be
//      asked again on every one of those, for the whole run, on the battery-constrained
//      device this feature exists to serve. The latch clears the moment the predicate reads
//      false, which is this module's only observable for "a real state edge happened".
//      `refresh()` is therefore idempotent under repetition, and the caller does not have to
//      enumerate the edges — an enumeration it would be one refactor away from getting
//      wrong in the direction of a lock stuck on.

/** The sentinel `WakeLock.request()` resolves to. Structurally typed rather than taken from
 *  lib.dom so the module builds against TypeScript versions whose DOM lib predates the API,
 *  and so a test can supply one without a jsdom implementation (jsdom has none). */
export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}

/** `navigator.wakeLock`. */
export interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface WakeLockDeps {
  /** `navigator.wakeLock` where the platform has it; `null`/absent where it does not. The
   *  feature detection is the CALLER's, done once, so this module has one code path. */
  readonly api?: WakeLockApi | null;
  /** Should a lock be held right now? Read on every `refresh()` AND again when a request
   *  resolves — never cached. `main.ts` supplies the run's full predicate: started, unpaused,
   *  unresolved, and the document visible. */
  readonly shouldHold: () => boolean;
}

export interface WakeLockHandle {
  /** Reconcile the lock against `shouldHold()`. Idempotent under repetition (property 4),
   *  so it is safe to call at any frequency — the caller reconciles from one place instead
   *  of enumerating the state edges. */
  refresh(): void;
  /** Is a sentinel held right now? Exposed for tests and diagnostics — the app itself never
   *  branches on this, because the platform can drop a lock without asking. */
  held(): boolean;
  /** Release a held lock AND disown one still in flight. After this, a request that resolves
   *  late releases immediately instead of leaking a sentinel past the app's own lifetime. */
  destroy(): void;
}

export function createWakeLock(deps: WakeLockDeps): WakeLockHandle {
  const api = deps.api ?? null;
  let sentinel: WakeLockSentinelLike | null = null;
  let requesting = false;
  /** Property 4: this platform said no. Cleared when the predicate next reads false. */
  let refused = false;
  let destroyed = false;

  /** Property 3: the platform drops the lock itself when the document hides (and may for its
   *  own reasons — a low battery). Forget the sentinel; deliberately do NOT re-request here.
   *  Re-acquisition belongs to the next state edge, which is what keeps a platform that
   *  refuses-then-releases from becoming a request loop. */
  const onRelease = (): void => {
    sentinel = null;
    // Deliberately NOT latched, unlike a refusal. The common cause is the document hiding,
    // where the predicate's visibility term takes over and re-acquisition on return is
    // exactly what is wanted — and where the hide event never fired, re-acquiring is the
    // whole point of reconciling on visibility restore. The revoke-then-decline case costs
    // ONE request, because that request is refused and property 4 latches it; and while a
    // request is outstanding no other can start, so this can never become a per-tick loop.
  };

  /** Let go of a sentinel without caring whether the release succeeds — by the time this
   *  runs the platform may already have dropped it, which rejects on some engines.
   *
   *  BOTH failure shapes are absorbed, matching the request path below and `fullscreen.ts`:
   *  a rejected promise AND a synchronous throw. The asymmetry mattered — this runs inside
   *  `refresh()`, which runs inside `refreshHud()`, so an escaping throw would surface out of
   *  the frame-loop callback, `ensurePaused`, `togglePause` and `startRun` alike, and from the
   *  request-resolution handler it would become an unhandled rejection instead. */
  const drop = (s: WakeLockSentinelLike): void => {
    s.removeEventListener('release', onRelease);
    try {
      void Promise.resolve(s.release()).catch(() => {});
    } catch {
      /* a non-conforming engine that raises instead of rejecting — nothing left to do */
    }
  };

  const releaseHeld = (): void => {
    const held = sentinel;
    if (held === null) return;
    sentinel = null;
    drop(held);
  };

  const refresh = (): void => {
    if (destroyed || api === null) return;
    if (!deps.shouldHold()) {
      // The predicate cycling is the state edge, seen from in here: the run paused, resolved,
      // or went to the background. Whatever made the platform decline last time may not hold
      // for the next wave, so the latch is dropped and the next acquisition is free to ask.
      refused = false;
      releaseHeld();
      return;
    }
    if (sentinel !== null) return; // already held — nothing to do
    if (requesting) return; // property 2: single-flight
    if (refused) return; // property 4: asked and declined; wait for the predicate to cycle
    requesting = true;
    try {
      void Promise.resolve(api.request('screen')).then(
        (s: WakeLockSentinelLike) => {
          requesting = false;
          // Property 1: re-read the predicate NOW. The run may have paused, resolved or gone
          // to the background while this was in flight, and this is the only moment at which
          // a sentinel acquired for a state that no longer exists can still be let go.
          if (destroyed || !deps.shouldHold()) {
            drop(s);
            return;
          }
          sentinel = s;
          s.addEventListener('release', onRelease);
        },
        () => {
          // Refused: no user gesture, a permissions policy, a hidden document, a platform
          // that exposes the API and declines to honour it. Silent — the run is unaffected —
          // and LATCHED, so the refusal costs one request rather than one per tick.
          requesting = false;
          // Re-read the predicate first, exactly as the success path does (property 1). A
          // rejection can land AFTER the state that asked for it is gone — the hide path
          // makes that ordinary, since the API refuses a document that is no longer visible
          // — and latching then would be latching against a state that no longer exists.
          // The player resuming would find `refused` already set and never ask again, so the
          // screen would stay free to sleep for the whole of that next live window. The
          // latch is about THIS state having been declined, not about the request having
          // failed.
          if (deps.shouldHold()) refused = true;
        },
      );
    } catch {
      // Some engines throw synchronously rather than rejecting. Same outcome, same silence,
      // same latch — and no predicate re-read is needed here, unlike the async rejection
      // above: this runs inside the same `refresh()` call whose guard just read it as true,
      // so nothing can have cycled in between.
      requesting = false;
      refused = true;
    }
  };

  return {
    refresh,
    held: (): boolean => sentinel !== null,
    destroy(): void {
      destroyed = true;
      releaseHeld();
      // A request still in flight is handled by the `destroyed` check in its own resolution
      // handler above — it drops the sentinel the moment it arrives, so tearing the app down
      // mid-request cannot leave the screen pinned awake.
    },
  };
}
