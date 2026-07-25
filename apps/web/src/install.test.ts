// install.test.ts — the install detection + lifecycle branches (PLAN.md Story 11 P3).
// Everything here runs against injected fakes: a real `beforeinstallprompt` cannot be
// synthesised by the browser on demand, so the module takes its event target, media
// queries, navigator facts and storage as dependencies precisely so each branch is
// reachable deterministically.

import { describe, it, expect, vi } from 'vitest';
import {
  createInstall,
  createStorageAdapter,
  DISMISSED_KEY,
  type BeforeInstallPromptEvent,
  type InstallDeps,
  type InstallEventTarget,
  type InstallMediaQueryList,
  type StorageAdapter,
} from './install';

const COARSE = '(pointer: coarse)';
const STANDALONE = '(display-mode: standalone)';

function fakeMatchMedia(matching: readonly string[] = []) {
  const lists = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
  const fn = (query: string): InstallMediaQueryList => {
    let entry = lists.get(query);
    if (entry === undefined) {
      entry = { matches: matching.includes(query), listeners: new Set() };
      lists.set(query, entry);
    }
    const e = entry;
    return {
      get matches() {
        return e.matches;
      },
      addEventListener: (_t: 'change', l: () => void) => e.listeners.add(l),
      removeEventListener: (_t: 'change', l: () => void) => e.listeners.delete(l),
    };
  };
  return {
    fn,
    set(query: string, matches: boolean): void {
      const entry = lists.get(query);
      if (entry === undefined) throw new Error(`query never registered: ${query}`);
      entry.matches = matches;
      for (const l of [...entry.listeners]) l();
    },
    listenerCount(query: string): number {
      return lists.get(query)?.listeners.size ?? 0;
    },
  };
}

function fakeStorage(): StorageAdapter {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

function fakeTarget() {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const target: InstallEventTarget = {
    addEventListener(type, l) {
      const set = listeners.get(type) ?? new Set();
      set.add(l);
      listeners.set(type, set);
    },
    removeEventListener(type, l) {
      listeners.get(type)?.delete(l);
    },
  };
  return {
    target,
    dispatch(e: Event): void {
      for (const l of [...(listeners.get(e.type) ?? [])]) l(e);
    },
    count(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function promptEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const prompt = vi.fn(() => Promise.resolve());
  const event = Object.assign(new Event('beforeinstallprompt'), {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  }) as unknown as BeforeInstallPromptEvent;
  return { event, prompt };
}

function deps(overrides: Partial<InstallDeps> = {}): InstallDeps {
  return {
    storage: fakeStorage(),
    matchMedia: fakeMatchMedia().fn,
    target: fakeTarget().target,
    navigator: { platform: 'Linux x86_64', maxTouchPoints: 0 },
    ...overrides,
  };
}

describe('install — branch detection (PLAN.md P3)', () => {
  it('is `other` with no captured prompt and a non-iOS platform: no banner, no action', () => {
    const handle = createInstall(deps({ matchMedia: fakeMatchMedia([COARSE]).fn }));
    const state = handle.state();
    expect(state.branch).toBe('other');
    expect(state.canPrompt).toBe(false);
    // Coarse pointer alone is not enough — there has to be something to offer.
    expect(state.bannerAudience).toBe(false);
    handle.destroy();
  });

  it('becomes `promptable` when the browser delivers beforeinstallprompt, and suppresses the mini-infobar', () => {
    const target = fakeTarget();
    const handle = createInstall(
      deps({ target: target.target, matchMedia: fakeMatchMedia([COARSE]).fn }),
    );
    expect(handle.state().branch).toBe('other');

    const { event } = promptEvent();
    const prevented = vi.spyOn(event, 'preventDefault');
    target.dispatch(event);

    expect(prevented).toHaveBeenCalledOnce();
    expect(handle.state().branch).toBe('promptable');
    expect(handle.state().canPrompt).toBe(true);
    expect(handle.state().bannerAudience).toBe(true);
    handle.destroy();
  });

  it('a promptable DESKTOP session is NOT in the banner audience (settings row only)', () => {
    // `beforeinstallprompt` is a CHROMIUM signal, not an Android identifier — it fires on
    // desktop too. The banner is phone-oriented, so it additionally requires a coarse
    // pointer; the permanent settings row does not.
    const target = fakeTarget();
    const handle = createInstall(
      deps({ target: target.target, matchMedia: fakeMatchMedia([]).fn }),
    );
    target.dispatch(promptEvent().event);
    expect(handle.state().branch).toBe('promptable');
    expect(handle.state().canPrompt).toBe(true);
    expect(handle.state().bannerAudience).toBe(false);
    handle.destroy();
  });

  it('detects iOS by platform, and iPadOS by its MacIntel-with-touch disguise', () => {
    for (const nav of [
      { platform: 'iPhone', maxTouchPoints: 5 },
      { platform: 'iPad', maxTouchPoints: 5 },
      { platform: 'iPod', maxTouchPoints: 5 },
      { platform: 'MacIntel', maxTouchPoints: 5 }, // modern iPadOS
    ]) {
      const handle = createInstall(
        deps({ navigator: nav, matchMedia: fakeMatchMedia([COARSE]).fn }),
      );
      expect(handle.state().branch, JSON.stringify(nav)).toBe('ios');
      expect(handle.state().bannerAudience).toBe(true);
      handle.destroy();
    }
    // A REAL Mac reports no touch points — desktop Safari is `other`, not `ios`.
    const mac = createInstall(deps({ navigator: { platform: 'MacIntel', maxTouchPoints: 0 } }));
    expect(mac.state().branch).toBe('other');
    mac.destroy();
  });

  it('reports standalone from the display-mode query OR Safari navigator.standalone', () => {
    const viaQuery = createInstall(deps({ matchMedia: fakeMatchMedia([STANDALONE]).fn }));
    expect(viaQuery.state().standalone).toBe(true);
    viaQuery.destroy();

    const viaSafari = createInstall(
      deps({ navigator: { platform: 'iPhone', maxTouchPoints: 5, standalone: true } }),
    );
    expect(viaSafari.state().standalone).toBe(true);
    viaSafari.destroy();
  });
});

describe('install — dismissal + session lifecycle (PLAN.md P3)', () => {
  it('persists the dismissal and reports it back on a fresh handle over the SAME adapter', () => {
    const storage = fakeStorage();
    const first = createInstall(deps({ storage }));
    expect(first.state().dismissed).toBe(false);
    first.dismiss();
    expect(first.state().dismissed).toBe(true);
    expect(storage.get(DISMISSED_KEY)).toBe('1');
    first.destroy();

    // A `createApp` destroy/recreate inside one session must NOT resurrect the banner. The
    // adapter is app-entry-owned precisely so this holds even in the in-memory fallback path.
    const second = createInstall(deps({ storage }));
    expect(second.state().dismissed).toBe(true);
    second.destroy();
  });

  it('notifies subscribers on capture, dismissal and install; unsubscribe stops it', () => {
    const target = fakeTarget();
    const handle = createInstall(deps({ target: target.target }));
    const cb = vi.fn();
    const off = handle.onChange(cb);

    target.dispatch(promptEvent().event);
    expect(cb).toHaveBeenCalledTimes(1); // a prompt arriving mid-hold must re-render now
    handle.dismiss();
    expect(cb).toHaveBeenCalledTimes(2);
    handle.dismiss(); // idempotent — no state change, no notification
    expect(cb).toHaveBeenCalledTimes(2);

    off();
    target.dispatch(new Event('appinstalled'));
    expect(cb).toHaveBeenCalledTimes(2);
    handle.destroy();
  });

  it('a media-query change (docking to a mouse, launching standalone) re-renders', () => {
    const mm = fakeMatchMedia([COARSE]);
    const handle = createInstall(deps({ matchMedia: mm.fn }));
    const cb = vi.fn();
    handle.onChange(cb);
    mm.set(COARSE, false);
    expect(cb).toHaveBeenCalledTimes(1);
    mm.set(STANDALONE, true);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(handle.state().standalone).toBe(true);
    handle.destroy();
  });

  it('bannerEndedForSession latches on the first Start and survives Play-again', () => {
    const handle = createInstall(deps());
    expect(handle.bannerEndedForSession()).toBe(false);
    handle.endBannerForSession();
    expect(handle.bannerEndedForSession()).toBe(true);
    // Play-again returns the run to a pre-start state; the latch does not reset with it.
    expect(handle.bannerEndedForSession()).toBe(true);
    handle.destroy();
  });
});

describe('install — the prompt is SINGLE-USE (PLAN.md P3)', () => {
  it('accepted: records installed + dismissed, and cannot be re-fired without a fresh event', async () => {
    const target = fakeTarget();
    const storage = fakeStorage();
    const handle = createInstall(deps({ target: target.target, storage }));
    const { event, prompt } = promptEvent('accepted');
    target.dispatch(event);

    expect(await handle.prompt()).toBe('accepted');
    expect(prompt).toHaveBeenCalledOnce();
    expect(handle.state().installed).toBe(true);
    expect(handle.state().dismissed).toBe(true);
    expect(storage.get(DISMISSED_KEY)).toBe('1');
    // The held event was consumed in `finally` — a second activation cannot re-call it (the
    // spec forbids re-prompting a used event, and Chromium throws).
    expect(handle.state().canPrompt).toBe(false);
    expect(await handle.prompt()).toBe('unavailable');
    expect(prompt).toHaveBeenCalledOnce();
    handle.destroy();
  });

  it('dismissed: the action hides until a fresh event, but the app is NOT marked installed', async () => {
    const target = fakeTarget();
    const handle = createInstall(deps({ target: target.target }));
    target.dispatch(promptEvent('dismissed').event);

    expect(await handle.prompt()).toBe('dismissed');
    expect(handle.state().installed).toBe(false);
    expect(handle.state().dismissed).toBe(false); // normal banner rules still apply
    expect(handle.state().canPrompt).toBe(false);

    // A fresh event from the browser re-arms it.
    target.dispatch(promptEvent('accepted').event);
    expect(handle.state().canPrompt).toBe(true);
    handle.destroy();
  });

  it('a rejection from prompt() itself still consumes the held event (cleared in finally)', async () => {
    const target = fakeTarget();
    const handle = createInstall(deps({ target: target.target }));
    const event = Object.assign(new Event('beforeinstallprompt'), {
      prompt: () => Promise.reject(new Error('already used')),
      userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
    }) as unknown as BeforeInstallPromptEvent;
    target.dispatch(event);

    await expect(handle.prompt()).rejects.toThrow('already used');
    expect(handle.state().canPrompt).toBe(false);
    // ...and the row must not then claim the browser never offered a prompt.
    expect(handle.state().promptDeclined).toBe(true);
    handle.destroy();
  });

  it('is re-entrancy safe: a second activation WHILE one is in flight cannot re-call it', async () => {
    // The single-use guarantee has to hold for concurrent calls too, not just sequential
    // ones — otherwise it depends entirely on the caller's own in-flight guard.
    const target = fakeTarget();
    const handle = createInstall(deps({ target: target.target }));
    let settle: (v: { outcome: 'accepted' | 'dismissed' }) => void = () => {};
    const prompt = vi.fn(() => Promise.resolve());
    const event = Object.assign(new Event('beforeinstallprompt'), {
      prompt,
      userChoice: new Promise<{ outcome: 'accepted' | 'dismissed' }>((resolve) => {
        settle = resolve;
      }),
    }) as unknown as BeforeInstallPromptEvent;
    target.dispatch(event);

    const first = handle.prompt();
    const second = handle.prompt(); // concurrent, before the first resolves
    expect(await second).toBe('unavailable');
    expect(prompt).toHaveBeenCalledOnce();

    settle({ outcome: 'accepted' });
    expect(await first).toBe('accepted');
    expect(prompt).toHaveBeenCalledOnce();
    handle.destroy();
  });

  it('prompt() with nothing held is `unavailable`, not a crash', async () => {
    const handle = createInstall(deps());
    expect(await handle.prompt()).toBe('unavailable');
    handle.destroy();
  });

  it('appinstalled marks the session installed and hides every affordance (display-mode does NOT flip in-tab)', () => {
    const target = fakeTarget();
    const storage = fakeStorage();
    const handle = createInstall(deps({ target: target.target, storage }));
    target.dispatch(promptEvent().event);

    target.dispatch(new Event('appinstalled'));
    expect(handle.state().installed).toBe(true);
    expect(handle.state().dismissed).toBe(true);
    expect(handle.state().canPrompt).toBe(false);
    expect(storage.get(DISMISSED_KEY)).toBe('1');
    // The page is still a browser tab, so `standalone` is legitimately false — which is
    // exactly why `installed` has to be checked everywhere `standalone` is.
    expect(handle.state().standalone).toBe(false);
    handle.destroy();
  });
});

describe('install — destroy() (PLAN.md P3)', () => {
  it('removes every listener and clears the held event, so a recreate fires exactly once', () => {
    const target = fakeTarget();
    const mm = fakeMatchMedia([COARSE]);
    const first = createInstall(deps({ target: target.target, matchMedia: mm.fn }));
    target.dispatch(promptEvent().event);
    expect(first.state().canPrompt).toBe(true);

    first.destroy();
    expect(target.count('beforeinstallprompt')).toBe(0);
    expect(target.count('appinstalled')).toBe(0);
    expect(mm.listenerCount(COARSE)).toBe(0);
    expect(mm.listenerCount(STANDALONE)).toBe(0);
    expect(first.state().canPrompt).toBe(false); // the held event is gone

    // Recreate on the SAME target: exactly one handler responds to the next event.
    const second = createInstall(deps({ target: target.target, matchMedia: mm.fn }));
    const cb = vi.fn();
    second.onChange(cb);
    target.dispatch(promptEvent().event);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(second.state().canPrompt).toBe(true);
    second.destroy();
  });
});

describe('install — the storage adapter', () => {
  it('uses localStorage when it is writable', () => {
    const store = new Map<string, string>();
    const win = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    } as unknown as Window;
    const adapter = createStorageAdapter(win);
    adapter.set('k', 'v');
    expect(store.get('k')).toBe('v');
    expect(adapter.get('k')).toBe('v');
    // The write probe cleaned up after itself.
    expect([...store.keys()]).toEqual(['k']);
  });

  it('falls back to memory when localStorage THROWS on write (Safari private mode)', () => {
    const win = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => {},
      },
    } as unknown as Window;
    const adapter = createStorageAdapter(win);
    adapter.set('k', 'v');
    // Presence is not writability — the probe caught it, and the dismissal still lasts the
    // session rather than throwing at the call site.
    expect(adapter.get('k')).toBe('v');
  });

  it('falls back to memory when there is no window/localStorage at all', () => {
    const adapter = createStorageAdapter(null);
    expect(adapter.get('k')).toBeNull();
    adapter.set('k', 'v');
    expect(adapter.get('k')).toBe('v');
  });

  it('survives localStorage revoking access mid-session on READ', () => {
    let broken = false;
    const store = new Map<string, string>();
    const win = {
      localStorage: {
        getItem: (k: string) => {
          if (broken) throw new Error('access denied');
          return store.get(k) ?? null;
        },
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    } as unknown as Window;
    const adapter = createStorageAdapter(win);
    adapter.set('k', 'v');
    broken = true;
    expect(adapter.get('k')).toBe('v'); // the mirrored in-memory copy answers
  });

  it('survives localStorage revoking access mid-session on WRITE', () => {
    let broken = false;
    const store = new Map<string, string>();
    const win = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          if (broken) throw new Error('access denied');
          store.set(k, v);
        },
        removeItem: (k: string) => void store.delete(k),
      },
    } as unknown as Window;
    const adapter = createStorageAdapter(win);
    broken = true;
    adapter.set('k', 'v'); // must not throw at the call site
    expect(adapter.get('k')).toBe('v');
  });
});
