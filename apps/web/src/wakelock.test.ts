// wakelock.test.ts — the screen wake lock's lifecycle (#140). jsdom implements none of the
// Screen Wake Lock API, and the API's hard parts are all about TIMING — a request that
// resolves after the state which asked for it is gone, a second reconcile arriving while one
// is in flight, the platform revoking a lock without being asked. So the API is a dependency
// and every one of those orderings is driven deterministically here.
//
// The predicate itself (started ∧ unpaused ∧ unresolved ∧ visible) is not this module's; it
// is asserted against the real controller and the real app in `main.test.ts`.

import { describe, it, expect, vi } from 'vitest';
import { createWakeLock, type WakeLockApi } from './wakelock';
import { fakeWakeLock } from './wakelock-fakes';

/** This suite drives the module's own asynchronous races, so it holds every successful
 *  request OPEN until `settle()` — `deferred` is what makes "the sentinel arrives HERE"
 *  literal rather than a matter of microtask ordering. */
const fakeApi = (behaviour: 'resolve' | 'reject' | 'throw' = 'resolve') =>
  fakeWakeLock({ behaviour, deferred: true });

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

  it('a run whose hide event never fires keeps re-acquiring — the budget is not per RUN', async () => {
    // The restore-only path, and the one this module has to get right: `main.ts` reconciles
    // on visibility change in BOTH directions because the hide half is historically
    // unreliable in an Android WebView, so that #140 is not correct only when #139 is. Where
    // it never arrives, nothing pauses the run and the predicate reads true throughout —
    // started, unpaused, unresolved, and visible again by the time anything asks — so the
    // predicate cycling can never be what clears the revoke budget.
    //
    // Every bound tried here broke exactly this: a count latched the lock off after the THIRD
    // app switch (a phone call, the app switcher, the home gesture) for the rest of a ~10-wave
    // run — the screen free to auto-lock mid-wave, which is the defect #140 exists to fix.
    // Not bounding it is what keeps this working, and this test is what holds that line.
    const api = fakeApi();
    const lock = createWakeLock({ api: api.api, shouldHold: () => true });
    lock.refresh();
    await api.settle();
    expect(lock.held()).toBe(true);

    for (let i = 1; i <= 20; i++) {
      api.revokeAll(); // the OS takes the lock back — and no hide event fires
      lock.refresh(); // the restore half, the only one this platform delivers
      await api.settle();
      expect(lock.held(), `the lock was not re-acquired after app switch ${i}`).toBe(true);
    }
    expect(api.requests(), 'one request per app switch, and none refused').toBe(21);
    lock.destroy();
  });

  it('a revoke costs ONE request, and a revoke-then-decline settles on the latch', async () => {
    // What the module actually guarantees, now that no bound is attempted. A revoke is not
    // latched — re-acquiring on visibility restore is the whole point of #140 not being
    // correct only when #139 is — so each revoke costs exactly one request: no second one can
    // start while the first is outstanding, and a granted lock makes later reconciles return
    // early. The rate is the PLATFORM's, never the sim tick's.
    const api = fakeApi();
    const lock = createWakeLock({ api: api.api, shouldHold: () => true });
    lock.refresh();
    await api.settle();
    expect(api.requests()).toBe(1);

    api.revokeAll();
    for (let i = 0; i < 40; i++) lock.refresh(); // two waves' worth of reconciles
    await api.settle();
    expect(api.requests(), 'a single revoke must cost a single request').toBe(2);
    expect(lock.held()).toBe(true);
    lock.destroy();
  });

  it('a revoking platform that then DECLINES stops being asked — the latch catches it', async () => {
    // The case that makes the unbounded revoke path safe in practice: the platform that takes
    // the lock back is overwhelmingly the one that will also refuse the follow-up (a hidden
    // document, a low battery), and property 4 latches that after one request.
    let answer: 'grant' | 'refuse' = 'grant';
    let requests = 0;
    const listeners = new Set<() => void>();
    const api = {
      request: () => {
        requests += 1;
        if (answer === 'refuse') return Promise.reject(new Error('refused'));
        return Promise.resolve({
          release: () => Promise.resolve(),
          addEventListener: (_t: 'release', l: () => void) => void listeners.add(l),
          removeEventListener: (_t: 'release', l: () => void) => void listeners.delete(l),
        });
      },
    };
    const lock = createWakeLock({ api, shouldHold: () => true });
    lock.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(lock.held()).toBe(true);

    answer = 'refuse';
    for (const l of [...listeners]) l(); // the platform takes it back…
    for (let i = 0; i < 40; i++) lock.refresh(); // …and declines every follow-up
    await Promise.resolve();
    await Promise.resolve();
    for (let i = 0; i < 40; i++) lock.refresh();
    expect(requests, 'the refusal latch must stop the retries after one').toBe(2);
    lock.destroy();
  });

  it('a release event from a sentinel we already dropped cannot disown the live one', async () => {
    // The reachable orphan, and why the listener is identity-checked. `releaseHeld()` — the
    // ordinary pause path — hands the sentinel to `drop()`, which releases it but does NOT
    // detach its listener (the listener detaches itself when it fires). A real sentinel emits
    // `release` when it is released, so that event arrives on a sentinel we have already let
    // go, quite possibly after the next one has been adopted.
    //
    // Without the identity check that event nulls the CURRENT sentinel: the module then
    // reports nothing held, has no reference left to release what it is actually holding, and
    // the screen stays awake for the life of the page — the exact leak `destroy()` and
    // property 1 exist to prevent.
    const api = fakeApi();
    let want = true;
    const lock = createWakeLock({ api: api.api, shouldHold: () => want });
    lock.refresh();
    await api.settle();
    const dropped = api.sentinelAt(0);

    want = false; // the player pauses — `releaseHeld()` drops sentinel A
    lock.refresh();
    want = true; // …and resumes, so sentinel B is adopted
    lock.refresh();
    await api.settle();
    expect(lock.held()).toBe(true);

    dropped.fireRelease(); // A's own release event finally arrives
    expect(lock.held(), 'a dropped sentinel must not be able to disown a live one').toBe(true);
    lock.destroy();
    expect(api.liveSentinels()).toBe(0);
  });

  it('a rejection landing after destroy() never consults the app predicate', async () => {
    // The predicate `main.ts` supplies reads the controller and the document on an app whose
    // overlay, input and Shell are already gone. The success path has always guarded on
    // `destroyed`; the rejection path did not, and a throw from there would escape as an
    // unhandled rejection.
    const api = fakeApi('reject');
    let asked = 0;
    const lock = createWakeLock({
      api: api.api,
      shouldHold: () => {
        asked += 1;
        return true;
      },
    });
    lock.refresh();
    const askedBeforeTeardown = asked;
    lock.destroy();
    await api.settle();
    expect(asked, 'the predicate was consulted on a torn-down handle').toBe(askedBeforeTeardown);
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
