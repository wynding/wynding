// wakelock.test.ts — the screen wake lock's lifecycle (#140). jsdom implements none of the
// Screen Wake Lock API, and the API's hard parts are all about TIMING — a request that
// resolves after the state which asked for it is gone, a second reconcile arriving while one
// is in flight, the platform revoking a lock without being asked. So the API is a dependency
// and every one of those orderings is driven deterministically here.
//
// The predicate itself (started ∧ unpaused ∧ unresolved ∧ visible) is not this module's; it
// is asserted against the real controller and the real app in `main.test.ts`.

import { describe, it, expect, vi } from 'vitest';
import { createWakeLock, type WakeLockApi, type WakeLockSentinelLike } from './wakelock';

/** A controllable `navigator.wakeLock`. Every sentinel it hands out is tracked, so a leaked
 *  one — acquired for a state that has since gone, and never released — is VISIBLE as a
 *  still-held sentinel rather than merely as a missing call. */
function fakeApi(behaviour: 'resolve' | 'reject' | 'throw' = 'resolve') {
  let requests = 0;
  /** Pending resolvers, so a test can decide WHEN a request completes. */
  const pending: Array<() => void> = [];
  const sentinels: { released: boolean; listeners: Set<() => void> }[] = [];

  const makeSentinel = (): WakeLockSentinelLike => {
    const s = { released: false, listeners: new Set<() => void>() };
    sentinels.push(s);
    return {
      release: () => {
        s.released = true;
        return Promise.resolve();
      },
      addEventListener: (_t: 'release', l: () => void) => void s.listeners.add(l),
      removeEventListener: (_t: 'release', l: () => void) => void s.listeners.delete(l),
    };
  };

  const api: WakeLockApi = {
    request: (type: 'screen') => {
      expect(type).toBe('screen');
      requests++;
      if (behaviour === 'throw') throw new Error('synchronous refusal');
      if (behaviour === 'reject') return Promise.reject(new Error('refused'));
      return new Promise<WakeLockSentinelLike>((resolve) => {
        pending.push(() => resolve(makeSentinel()));
      });
    },
  };

  return {
    api,
    requests: () => requests,
    /** Let every outstanding request resolve, then drain the microtask queue. */
    settle: async (): Promise<void> => {
      for (const r of pending.splice(0)) r();
      await Promise.resolve();
      await Promise.resolve();
    },
    /** How many sentinels this API handed out that have not been released. */
    liveSentinels: () => sentinels.filter((s) => !s.released).length,
    /** Simulate the PLATFORM revoking the lock (what happens when the document hides). */
    revokeAll: (): void => {
      for (const s of sentinels) {
        if (s.released) continue;
        s.released = true;
        for (const l of [...s.listeners]) l();
      }
    },
  };
}

describe('wakelock — an absent API is a silent no-op, never an error', () => {
  it('does nothing at all when navigator.wakeLock is missing (iOS below 16.4)', async () => {
    // Capacitor 8's floor is iOS 15 and an AOSP WebView without Play updates can lack it
    // too. Those devices simply keep today's behaviour; nothing throws, nothing is logged,
    // and the run never learns the difference.
    const lock = createWakeLock({ api: undefined, shouldHold: () => true });
    expect(() => lock.refresh()).not.toThrow();
    await Promise.resolve();
    expect(lock.held()).toBe(false);
    expect(() => lock.destroy()).not.toThrow();
  });

  it('treats an explicit null the same as an absent one', () => {
    const lock = createWakeLock({ api: null, shouldHold: () => true });
    lock.refresh();
    expect(lock.held()).toBe(false);
    lock.destroy();
  });
});

describe('wakelock — acquire and release track the predicate', () => {
  it('acquires while the predicate holds and releases the moment it stops', async () => {
    const api = fakeApi();
    let want = true;
    const lock = createWakeLock({ api: api.api, shouldHold: () => want });

    lock.refresh();
    await api.settle();
    expect(lock.held()).toBe(true);
    expect(api.liveSentinels()).toBe(1);

    want = false;
    lock.refresh();
    expect(lock.held()).toBe(false);
    expect(api.liveSentinels()).toBe(0);
  });

  it('never requests while the predicate is false — including the very first reconcile', async () => {
    const api = fakeApi();
    const lock = createWakeLock({ api: api.api, shouldHold: () => false });
    lock.refresh();
    lock.refresh();
    await api.settle();
    expect(api.requests()).toBe(0);
    lock.destroy();
  });

  it('is idempotent while held — a steady state re-asks for nothing', async () => {
    const api = fakeApi();
    const lock = createWakeLock({ api: api.api, shouldHold: () => true });
    lock.refresh();
    await api.settle();
    for (let i = 0; i < 5; i++) lock.refresh();
    await api.settle();
    expect(api.requests()).toBe(1);
    lock.destroy();
  });

  it('releasing when nothing is held is a no-op, not a throw', () => {
    const api = fakeApi();
    const lock = createWakeLock({ api: api.api, shouldHold: () => false });
    expect(() => lock.refresh()).not.toThrow();
    expect(lock.held()).toBe(false);
    lock.destroy();
  });
});

describe('wakelock — the asynchronous races (#140 properties 1 and 2)', () => {
  it('a predicate that goes false MID-REQUEST releases the arriving sentinel', async () => {
    // Property 1, and the whole reason the predicate is re-read at resolution: a pause
    // landing while a request is in flight would otherwise leave a live sentinel with
    // nothing to release it — the screen held awake through paused planning, which is
    // exactly the drain the #140 decision exists to avoid.
    const api = fakeApi();
    let want = true;
    const lock = createWakeLock({ api: api.api, shouldHold: () => want });

    lock.refresh(); // asks while the wave is moving...
    want = false; // ...and the player pauses before the sentinel arrives
    lock.refresh(); // the reconcile that CANNOT help: there is nothing held yet
    await api.settle();

    expect(lock.held()).toBe(false);
    expect(api.liveSentinels(), 'the sentinel arrived into a paused run and must be let go').toBe(
      0,
    );
  });

  it('a predicate that goes false and back TRUE mid-request keeps the lock', async () => {
    // The mirror case, so the reconcile above cannot be "always release on arrival": a
    // player who pauses and resumes inside one request round-trip must end up holding it.
    const api = fakeApi();
    let want = true;
    const lock = createWakeLock({ api: api.api, shouldHold: () => want });
    lock.refresh();
    want = false;
    lock.refresh();
    want = true;
    await api.settle();
    expect(lock.held()).toBe(true);
    expect(api.liveSentinels()).toBe(1);
    lock.destroy();
  });

  it('requests are SINGLE-FLIGHT — a second reconcile mid-request orphans nothing', async () => {
    // Property 2. Two concurrent requests would hand out two sentinels, only one of which
    // this module can remember — and the forgotten one is unreleasable and invisible.
    const api = fakeApi();
    const lock = createWakeLock({ api: api.api, shouldHold: () => true });
    lock.refresh();
    lock.refresh();
    lock.refresh();
    expect(api.requests()).toBe(1);
    await api.settle();
    expect(api.liveSentinels()).toBe(1);
    lock.destroy();
    expect(api.liveSentinels()).toBe(0);
  });

  it('a refusal is silent, LATCHED, and retried only once the predicate cycles', async () => {
    // Property 4, and the reason it exists: `refresh()` is driven from the app's HUD refresh,
    // which runs on every sim tick while a wave is moving. Without the latch a platform that
    // exposes the API and declines — Chrome on low battery, a WebView without the
    // `screen-wake-lock` grant — is asked 20 times a second for the whole run, on exactly
    // the battery-constrained device this feature exists to serve.
    const api = fakeApi('reject');
    let want = true;
    const lock = createWakeLock({ api: api.api, shouldHold: () => want });
    expect(() => lock.refresh()).not.toThrow();
    await api.settle();
    expect(lock.held()).toBe(false);

    for (let i = 0; i < 50; i++) lock.refresh(); // a wave's worth of ticks
    await api.settle();
    expect(api.requests(), 'a refusal must cost ONE request, not one per tick').toBe(1);

    // The predicate going false is a real state edge (paused, resolved, backgrounded), and
    // whatever made the platform decline may not hold for the next wave.
    want = false;
    lock.refresh();
    want = true;
    lock.refresh();
    expect(api.requests()).toBe(2);
    lock.destroy();
  });

  it('a refusal that lands AFTER the predicate cycles does not latch the next live window', async () => {
    // The latch is about THIS state having been declined, not about a request having failed.
    // A rejection routinely arrives late on the hide path — the API refuses a document that
    // is no longer visible — and latching then would suppress the request the player is
    // entitled to on resume, leaving the screen free to sleep for that whole live window.
    // Symmetric with property 1, which re-reads the predicate before adopting a sentinel.
    const api = fakeApi('reject');
    let want = true;
    const lock = createWakeLock({ api: api.api, shouldHold: () => want });

    lock.refresh(); // asks while the wave is moving
    want = false; // …the player pauses (or the app backgrounds) before the answer lands
    lock.refresh();
    await api.settle(); // the rejection arrives HERE, against the paused state
    expect(api.requests()).toBe(1);

    want = true; // resume: a new live window, entitled to its own request
    lock.refresh();
    expect(api.requests(), 'the stale rejection latched against a state that had gone').toBe(2);
    lock.destroy();
  });

  it('a SYNCHRONOUSLY throwing request is absorbed and latched the same way', async () => {
    const api = fakeApi('throw');
    let want = true;
    const lock = createWakeLock({ api: api.api, shouldHold: () => want });
    expect(() => lock.refresh()).not.toThrow();
    await api.settle();
    expect(lock.held()).toBe(false);
    for (let i = 0; i < 50; i++) lock.refresh();
    expect(api.requests()).toBe(1);
    want = false;
    lock.refresh();
    want = true;
    lock.refresh();
    expect(api.requests()).toBe(2);
    lock.destroy();
  });
});

describe('wakelock — the platform can take the lock back (#140 property 3)', () => {
  it('observes a platform release rather than remembering it is held', async () => {
    // The document hiding releases the lock without asking, so held-ness has to be observed.
    // A module that remembered "I hold one" would then never re-acquire on return.
    const api = fakeApi();
    let want = true;
    const lock = createWakeLock({ api: api.api, shouldHold: () => want });
    lock.refresh();
    await api.settle();
    expect(lock.held()).toBe(true);

    api.revokeAll(); // the platform drops it — the app was never asked
    expect(lock.held()).toBe(false);
    // Deliberately NOT re-requested from inside the release handler: that would be a request
    // loop against a platform that refuses-then-releases. The next state edge does it.
    expect(api.requests()).toBe(1);

    want = true;
    lock.refresh();
    await api.settle();
    expect(lock.held()).toBe(true);
    expect(api.requests()).toBe(2);
    lock.destroy();
  });

  it('a revoke is NOT latched — re-acquisition does not wait for the predicate to cycle', async () => {
    // The opposite choice to a refusal, and deliberate. The usual cause of a revoke is the
    // document hiding, and `main.ts` reconciles on visibility RESTORE precisely so that a run
    // whose hide event never fired (historically an Android WebView risk) gets its lock back
    // — #140 must not be correct only when #139 is. Latching here would defeat that.
    //
    // It cannot become a per-tick loop even so: the re-request is either granted (held, so
    // every later reconcile returns early) or refused (property 4 latches it), and while one
    // request is outstanding no second can start.
    const api = fakeApi();
    const lock = createWakeLock({ api: api.api, shouldHold: () => true });
    lock.refresh();
    await api.settle();
    api.revokeAll(); // the platform takes it back, with the predicate still true throughout
    lock.refresh();
    await api.settle();
    expect(lock.held()).toBe(true);
    expect(api.requests()).toBe(2);
    lock.destroy();
  });

  it('a release that THROWS synchronously is swallowed too', async () => {
    // `release()` runs inside `refresh()`, which runs inside the app's HUD refresh — so an
    // escaping throw would surface out of the frame loop, `ensurePaused`, `togglePause` and
    // `startRun`. Same stance as the request path, which absorbs both failure shapes.
    const throwing: WakeLockApi = {
      request: () =>
        Promise.resolve({
          release: (): Promise<void> => {
            throw new Error('non-conforming engine');
          },
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
    };
    let want = true;
    const lock = createWakeLock({ api: throwing, shouldHold: () => want });
    lock.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(lock.held()).toBe(true);
    want = false;
    expect(() => lock.refresh()).not.toThrow();
    expect(lock.held()).toBe(false);
  });

  it('a release that rejects is swallowed — the platform may have dropped it already', async () => {
    const rejecting: WakeLockApi = {
      request: () =>
        Promise.resolve({
          release: () => Promise.reject(new Error('already released')),
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
    };
    let want = true;
    const lock = createWakeLock({ api: rejecting, shouldHold: () => want });
    lock.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(lock.held()).toBe(true);
    want = false;
    expect(() => lock.refresh()).not.toThrow();
    expect(lock.held()).toBe(false);
    // No unhandled rejection escapes into the run.
    await Promise.resolve();
  });
});

describe('wakelock — destroy() covers BOTH a held lock and one in flight', () => {
  it('releases a lock that is already held', async () => {
    const api = fakeApi();
    const lock = createWakeLock({ api: api.api, shouldHold: () => true });
    lock.refresh();
    await api.settle();
    expect(api.liveSentinels()).toBe(1);
    lock.destroy();
    expect(api.liveSentinels()).toBe(0);
    expect(lock.held()).toBe(false);
  });

  it('disowns a request still in flight, so a late sentinel cannot pin the screen awake', async () => {
    // Tearing the app down mid-request is ordinary (a host remounting `createApp`), and the
    // sentinel arriving afterwards has no owner left. Without this it would be held for the
    // lifetime of the page with nothing able to release it.
    const api = fakeApi();
    const lock = createWakeLock({ api: api.api, shouldHold: () => true });
    lock.refresh();
    expect(api.requests()).toBe(1);
    lock.destroy(); // the request has NOT resolved yet
    await api.settle();
    expect(lock.held()).toBe(false);
    expect(api.liveSentinels()).toBe(0);
  });

  it('is inert afterwards — a stray refresh never asks again', async () => {
    const api = fakeApi();
    const lock = createWakeLock({ api: api.api, shouldHold: () => true });
    lock.destroy();
    lock.refresh();
    await api.settle();
    expect(api.requests()).toBe(0);
    expect(lock.held()).toBe(false);
  });

  it('is safe to call twice', async () => {
    const api = fakeApi();
    const lock = createWakeLock({ api: api.api, shouldHold: () => true });
    lock.refresh();
    await api.settle();
    lock.destroy();
    expect(() => lock.destroy()).not.toThrow();
    expect(api.liveSentinels()).toBe(0);
  });
});

describe('wakelock — the predicate is a live read, never captured', () => {
  it('calls shouldHold on every reconcile', async () => {
    const api = fakeApi();
    const shouldHold = vi.fn(() => false);
    const lock = createWakeLock({ api: api.api, shouldHold });
    lock.refresh();
    lock.refresh();
    expect(shouldHold).toHaveBeenCalledTimes(2);
    lock.destroy();
  });
});
