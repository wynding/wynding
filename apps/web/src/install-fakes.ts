// install-fakes.ts — shared test fakes for the install module (PLAN.md Story 11 P3).
//
// A real `beforeinstallprompt` cannot be synthesised by the browser on demand, and jsdom has
// no meaningful `matchMedia`/storage, so both `install.test.ts` and `overlay.test.ts` drive
// `createInstall` against injected fakes. These lived (copy-pasted, and drifted) in each
// suite; they are the ONE source of truth now. Test-only: imported solely by `*.test.ts`, so
// it is coverage-excluded (see `vitest.config.ts`) rather than held to the 90% branch bar.

import { vi } from 'vitest';
import {
  createInstall,
  type BeforeInstallPromptEvent,
  type InstallDeps,
  type InstallEventTarget,
  type InstallHandle,
  type InstallMediaQueryList,
  type StorageAdapter,
} from './install';

export const COARSE = '(pointer: coarse)';
export const STANDALONE = '(display-mode: standalone)';

/** A controllable `matchMedia`: every listed query matches, and `set` flips a registered
 *  query and notifies its listeners. `set` THROWS on an unregistered query — a test that
 *  flips a query the module never subscribed to is asserting against a no-op, which is the
 *  bug this shared fake exists to prevent. */
export function fakeMatchMedia(matching: readonly string[] = []) {
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

/** An in-memory storage adapter, so a test can prove dismissal persists across a recreate
 *  without depending on jsdom's `localStorage`. */
export function fakeStorage(): StorageAdapter {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

/** A minimal `InstallEventTarget` a test can dispatch into. */
export function fakeTarget() {
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

/** A synthetic `beforeinstallprompt`, with a controllable `userChoice`. */
export function fakePromptEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const prompt = vi.fn(() => Promise.resolve());
  const event = Object.assign(new Event('beforeinstallprompt'), {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  }) as unknown as BeforeInstallPromptEvent;
  return { event, prompt };
}

/** The default `InstallDeps`: fresh fakes and a non-iOS, non-touch navigator. Pass overrides
 *  to swap any single dependency. */
export function deps(overrides: Partial<InstallDeps> = {}): InstallDeps {
  return {
    storage: fakeStorage(),
    matchMedia: fakeMatchMedia().fn,
    target: fakeTarget().target,
    navigator: { platform: 'Linux x86_64', maxTouchPoints: 0 },
    ...overrides,
  };
}

/** `createInstall` over `deps(overrides)` — the default install handle a test needs when it
 *  does not drive the event target itself. */
export function defaultInstall(overrides: Partial<InstallDeps> = {}): InstallHandle {
  return createInstall(deps(overrides));
}
