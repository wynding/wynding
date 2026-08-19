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
//      every sim tick while a wave is moving — 20/s at speed 1 and 40/s at 2×, the fastest
//      the game offers (`Speed = 1 | 2`, `MS_PER_TICK = 50`) — so a platform
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
  /** Which live window we are in. Bumped every time the predicate reads false, so a request
   *  can tell whether the state that asked for it still exists when its answer arrives.
   *  `shouldHold()` alone cannot: the predicate going false and TRUE again — a player pausing
   *  and resuming inside one request round-trip — reads identical to never having moved. */
  let windowId = 0;
  let destroyed = false;

  /** Adopt a freshly-granted sentinel, listening for the platform taking it back.
   *
   *  The listener is PER SENTINEL and checks identity before acting, which is what makes a
   *  late or duplicated `release` from a sentinel we already let go HARMLESS: without it,
   *  that event nulled whichever sentinel happened to be live at the time, leaving the module
   *  with no reference to release it and the screen pinned awake for the life of the page.
   *
   *  It does NOT make such a sentinel detach. The identity guard returns before
   *  `removeEventListener`, so a sentinel dropped by `releaseHeld()` keeps its listener until
   *  it is collected — which is fine, because the sentinel, its listener set and this closure
   *  form a cycle with no live references once we drop ours. Stated because the honest reason
   *  `drop()` does not detach is "the stale event is harmless", not "the listener detaches
   *  itself" — and the second is what a reader would otherwise rely on. */
  const adopt = (s: WakeLockSentinelLike): void => {
    const onRelease = (): void => {
      if (sentinel !== s) return; // a stale or duplicated event from a sentinel we let go
      s.removeEventListener('release', onRelease);
      sentinel = null;
      // Property 3: the platform drops the lock itself when the document hides (and may for
      // its own reasons — a low battery). Deliberately NOT latched the way a refusal is: the
      // common cause is hiding, where the predicate's visibility term takes over and
      // re-acquisition on return is exactly what is wanted — and where the hide event never
      // fired, re-acquiring is the whole point of reconciling on visibility restore.
      //
      // WHAT IS AND IS NOT GUARANTEED, stated exactly, because an earlier version of this
      // comment overclaimed. A refusal costs one request per predicate-true window (property
      // 4). A revoke costs one request per revoke — no more, because while a request is
      // outstanding no second one can start, and a granted lock makes every later reconcile
      // return early. The request rate is therefore bounded by the PLATFORM's revoke rate,
      // not by our tick rate. What is NOT bounded is a platform that grants and immediately
      // revokes in a tight cycle; that would cost one request per cycle.
      //
      // No defence against that is attempted, and the omission is deliberate. No known engine
      // behaves that way, and both bounds tried here were worse than the thing they guarded:
      // a per-window count latched the screen free to sleep after the third ordinary app
      // switch, and adding a held-long-enough clock to forgive those moved the same failure
      // onto a player who fumbles the app switcher three times. Each traded a real, common
      // regression for a hypothetical one. If a device is ever seen doing this, bound it
      // then, against a measurement.
    };
    s.addEventListener('release', onRelease);
    sentinel = s;
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
      windowId += 1;
      releaseHeld();
      return;
    }
    if (sentinel !== null) return; // already held — nothing to do
    // Property 2: single-flight. NOT timed out, deliberately. A request that never settles
    // would wedge this latch for the session — but no known engine leaves a wake-lock request
    // pending forever, and the consequence is the SAME graceful degradation an absent API
    // gives: no lock, no error, a run that never notices. Adding a timer, a duration and a
    // retry path to recover a hypothetical would repeat the mistake the revoke bound made
    // above — trading a real regression for an imagined one. Bound it against a measurement
    // if a device is ever seen doing it.
    if (requesting) return;
    if (refused) return; // property 4: asked and declined; wait for the predicate to cycle
    requesting = true;
    const askedIn = windowId;
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
          try {
            adopt(s);
          } catch {
            // The one failure shape this module's own discipline still missed. `drop()`
            // absorbs a rejected release and a synchronous throw, and the request path
            // absorbs a synchronous throw from `request()` — but the RESOLUTION handler
            // absorbed neither, and it runs inside a promise that is deliberately `void`ed.
            // So a non-conforming sentinel (no `addEventListener`, or `request()` resolving
            // with something that is not a sentinel at all) both escaped as an unhandled
            // rejection and left the granted lock unrecorded — held by the platform, with
            // nothing in here able to release it, not `refresh()` and not `destroy()`. That
            // is the screen pinned awake for the life of the page.
            drop(s);
          }
        },
        () => {
          // Refused: no user gesture, a permissions policy, a hidden document, a platform
          // that exposes the API and declines to honour it. Silent — the run is unaffected —
          // and LATCHED, so the refusal costs one request rather than one per tick.
          requesting = false;
          // Symmetric with the success path: a dead handle's predicate is never consulted.
          // `main.ts` supplies one that reads the controller and the document, on an app
          // whose overlay, input and Shell have already been torn down — inert today only by
          // accident, and an escaping throw here would be an unhandled rejection.
          if (destroyed) return;
          // The latch is about THIS window having been declined, not about a request having
          // failed — so a rejection that outlives the window that asked for it must not set
          // it. Two ways that happens, and the predicate alone only catches the first:
          //
          //   • the window is still open  — `shouldHold()` reads false, so no latch;
          //   • the window ENDED AND A NEW ONE BEGAN — a player pausing and resuming inside
          //     one request round-trip. `shouldHold()` reads true again and is indistinguish-
          //     able from never having moved, so the stale refusal would latch against a live
          //     wave that never got a request of its own, and the screen would be free to
          //     sleep for the rest of it. That is what `windowId` is for.
          if (windowId !== askedIn) return;
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
