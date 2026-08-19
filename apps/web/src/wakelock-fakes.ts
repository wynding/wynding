// wakelock-fakes.ts — the shared test double for the Screen Wake Lock API (#140).
//
// jsdom implements none of the API, so both `wakelock.test.ts` (the module's own lifecycle)
// and `main.test.ts` (the app-level predicate) drive it against a fake. This is the ONE
// source of truth for how a sentinel behaves, for the same reason `install-fakes.ts` exists:
// that module records that its fakes "lived (copy-pasted, and drifted) in each suite" before
// being extracted, and two copies modelling one platform contract drift SILENTLY — each suite
// keeps passing against its own private notion of the thing it is supposed to be pinning.
//
// Test-only: imported solely by `*.test.ts`, so it is coverage-excluded in
// `vitest.config.ts` rather than held to the 90% branch bar, exactly as `install-fakes.ts` is.

import type { WakeLockApi, WakeLockSentinelLike } from './wakelock';

export interface WakeLockFakeOptions {
  /** How this platform answers a request. `reject` is the one that matters most — a device
   *  that HAS the API and declines is the case the refusal latch exists for, and it is not
   *  the same as an absent API. `throw` covers a non-conforming engine that raises instead. */
  readonly behaviour?: 'resolve' | 'reject' | 'throw';
  /** Model an engine whose `release` EVENT arrives late rather than with the call — the
   *  `release()` promise settles, but the sentinel does not notify until a test says so via
   *  `sentinelAt(i).fireRelease()`. That is the ordering the per-sentinel identity guard
   *  exists for: an event from a sentinel already let go, arriving after the NEXT one was
   *  adopted. Default false, i.e. the spec-conforming behaviour where releasing notifies at
   *  once and `sentinel` is still null when it does. */
  readonly lateRelease?: boolean;
  /** Hold each successful request OPEN until `settle()` is called, so a test can decide
   *  exactly when the sentinel arrives and drive the asynchronous races against it. Default
   *  false: the request resolves on its own microtask, which is all an app-level test needs.
   *  Only affects the `resolve` path — a rejection is delivered on its own microtask either
   *  way, since the latch tests care about ordering rather than about holding it open. */
  readonly deferred?: boolean;
}

/** A controllable `navigator.wakeLock`. Every sentinel it hands out is TRACKED, so a leaked
 *  one — acquired for a state that has since gone, and never released — shows up as a
 *  still-live sentinel rather than merely as a missing call. */
export function fakeWakeLock({
  behaviour = 'resolve',
  deferred = false,
  lateRelease = false,
}: WakeLockFakeOptions = {}) {
  let requests = 0;
  let answer = behaviour;
  /** Every lock type asked for, in order. RECORDED rather than asserted in here: `request` is
   *  called synchronously from `refresh()`, inside the module's own `try`/`catch` for engines
   *  that throw instead of rejecting — so an `expect` here never reaches Vitest at all. It is
   *  swallowed and presents as a platform refusal, which is the exact opposite of pinning
   *  anything. Assert it from the test body, where a failure is attributable. */
  const types: string[] = [];
  /** Resolvers held back while `deferred`, so a test can choose when a request completes. */
  const pending: (() => void)[] = [];
  const sentinels: { released: boolean; listeners: Set<() => void> }[] = [];

  const makeSentinel = (): WakeLockSentinelLike => {
    const s = { released: false, listeners: new Set<() => void>() };
    sentinels.push(s);
    return {
      release: () => {
        // Fires the event as well as marking it. Per the spec, `WakeLockSentinel.release()`
        // runs the release algorithm, which DISPATCHES `release` at the sentinel — so a real
        // engine always delivers that event on the ordinary pause path
        // (`releaseHeld()` → `drop()` → `release()`). Marking without notifying made this
        // module's three release paths model one platform contract three different ways,
        // which is the silent drift it was extracted to prevent.
        s.released = true;
        if (!lateRelease) for (const l of [...s.listeners]) l();
        return Promise.resolve();
      },
      addEventListener: (_t: 'release', l: () => void) => void s.listeners.add(l),
      removeEventListener: (_t: 'release', l: () => void) => void s.listeners.delete(l),
    };
  };

  const api: WakeLockApi = {
    request: (type: 'screen') => {
      types.push(type);
      requests++;
      if (answer === 'throw') throw new Error('synchronous refusal');
      if (answer === 'reject') return Promise.reject(new Error('refused'));
      if (!deferred) return Promise.resolve(makeSentinel());
      return new Promise<WakeLockSentinelLike>((resolve) => {
        pending.push(() => resolve(makeSentinel()));
      });
    },
  };

  return {
    api,
    requests: () => requests,
    /** The lock types asked for, in order. The app must only ever ask for `'screen'`. */
    requestedTypes: (): readonly string[] => types,
    /** Change how the platform answers MID-TEST — "grant, then refuse" is a real sequence (a
     *  device that revokes and then declines the follow-up) and the only reason a suite would
     *  otherwise hand-roll a second sentinel model, which is what this module exists to stop. */
    setBehaviour: (next: 'resolve' | 'reject' | 'throw'): void => {
      answer = next;
    },
    /** How many sentinels this API handed out that have NOT been released. */
    liveSentinels: () => sentinels.filter((s) => !s.released).length,
    /** Release anything held back, then drain the microtask queue — every assertion about
     *  held-ness has to come after the request's own `.then` has run. */
    settle: async (): Promise<void> => {
      for (const r of pending.splice(0)) r();
      await Promise.resolve();
      await Promise.resolve();
    },
    /** One sentinel by handout order, so a test can drive a SINGLE one — the stale/duplicated
     *  `release` that a non-conforming engine can emit from a sentinel already let go. */
    sentinelAt: (i: number) => {
      const s = sentinels[i];
      if (s === undefined) throw new Error(`no sentinel at index ${i}`);
      return {
        fireRelease: (): void => {
          // Marks it released, exactly as `release()` and `revokeAll()` do. This module bills
          // itself as the ONE source of truth for how a sentinel behaves, so its three release
          // paths must not model that contract three different ways — a `fireRelease` that
          // left `released` false would over-count `liveSentinels()` for the next test that
          // uses it to simulate a single-sentinel revoke.
          s.released = true;
          for (const l of [...s.listeners]) l();
        },
      };
    },
    /** The PLATFORM taking the lock back, unannounced — what really happens when the document
     *  hides, and the state a visibility-restore test has to start from. */
    revokeAll: (): void => {
      for (const s of sentinels) {
        if (s.released) continue;
        s.released = true;
        for (const l of [...s.listeners]) l();
      }
    },
  };
}
