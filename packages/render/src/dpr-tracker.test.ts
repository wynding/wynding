// dpr-tracker.test.ts — the matchMedia re-arm helper under a mock (#28/P5).

import { describe, it, expect } from 'vitest';
import { createDprTracker, clampDpr, type MatchMediaLike } from './dpr-tracker';

/** A mock `matchMedia`: tracks listeners per exact query string and lets the test
 *  fire a "change" event for a given query (simulating the display leaving that dpr). */
function mockMatchMedia(): {
  matchMediaFn: MatchMediaLike;
  fire(query: string): void;
  totalListeners(): number;
} {
  const listenersByQuery = new Map<string, Set<() => void>>();
  const matchMediaFn: MatchMediaLike = (query: string) => {
    if (!listenersByQuery.has(query)) listenersByQuery.set(query, new Set());
    return {
      addEventListener: (_type: 'change', listener: () => void) => {
        listenersByQuery.get(query)?.add(listener);
      },
      removeEventListener: (_type: 'change', listener: () => void) => {
        listenersByQuery.get(query)?.delete(listener);
      },
    };
  };
  const fire = (query: string): void => {
    for (const l of listenersByQuery.get(query) ?? []) l();
  };
  const totalListeners = (): number => {
    let n = 0;
    for (const s of listenersByQuery.values()) n += s.size;
    return n;
  };
  return { matchMediaFn, fire, totalListeners };
}

describe('createDprTracker', () => {
  it('re-fires across a 1→2→3→1 transition sequence, keeping exactly one listener armed', () => {
    const { matchMediaFn, fire, totalListeners } = mockMatchMedia();
    let changes = 0;
    const tracker = createDprTracker(() => {
      changes++;
    }, matchMediaFn);

    tracker.rearm(1);
    expect(totalListeners()).toBe(1);
    fire('(resolution: 1dppx)'); // leaving dpr=1
    expect(changes).toBe(1);

    tracker.rearm(2);
    expect(totalListeners()).toBe(1); // old listener detached, exactly one new one armed
    fire('(resolution: 1dppx)'); // the STALE query — must be inert, proving it was detached
    expect(changes).toBe(1);
    fire('(resolution: 2dppx)');
    expect(changes).toBe(2);

    tracker.rearm(3);
    fire('(resolution: 3dppx)');
    expect(changes).toBe(3);

    tracker.rearm(1);
    fire('(resolution: 1dppx)');
    expect(changes).toBe(4);
    expect(totalListeners()).toBe(1);
  });

  it('destroy() removes the active listener; further fires on that query are inert', () => {
    const { matchMediaFn, fire, totalListeners } = mockMatchMedia();
    let changes = 0;
    const tracker = createDprTracker(() => {
      changes++;
    }, matchMediaFn);
    tracker.rearm(1);
    tracker.destroy();
    expect(totalListeners()).toBe(0);
    fire('(resolution: 1dppx)');
    expect(changes).toBe(0);
  });

  it('destroy() is idempotent, including when never armed', () => {
    const { matchMediaFn } = mockMatchMedia();
    const tracker = createDprTracker(() => {}, matchMediaFn);
    expect(() => tracker.destroy()).not.toThrow();
    expect(() => tracker.destroy()).not.toThrow();
    tracker.rearm(1);
    tracker.destroy();
    expect(() => tracker.destroy()).not.toThrow();
  });
});

describe('clampDpr', () => {
  it('clamps a 3× display down to the 2× effective ceiling', () => {
    expect(clampDpr(3)).toBe(2);
  });

  it('passes 1× and 2× through unchanged', () => {
    expect(clampDpr(1)).toBe(1);
    expect(clampDpr(2)).toBe(2);
  });

  it('treats non-positive/garbage input as 1', () => {
    expect(clampDpr(0)).toBe(1);
    expect(clampDpr(-5)).toBe(1);
    expect(clampDpr(Number.NaN)).toBe(1);
  });
});
