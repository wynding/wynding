import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createModalOwner, type ModalOverlay } from './modal';
import { createRotate, type RotateMediaQueryList, type MatchMediaFn } from './rotate';

/** A controllable fake `MediaQueryList` — `.set()` flips `matches` and fires every
 *  registered `change` listener, mirroring how a real one behaves on an OS/viewport
 *  change (PLAN.md P5: fixed queries, never re-created). */
function fakeQuery(initial: boolean): RotateMediaQueryList & { set(v: boolean): void } {
  let matches = initial;
  const listeners = new Set<() => void>();
  return {
    get matches() {
      return matches;
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    set(v: boolean): void {
      matches = v;
      for (const l of listeners) l();
    },
  };
}

function fakeMatchMedia(
  portrait: RotateMediaQueryList,
  coarse: RotateMediaQueryList,
): MatchMediaFn {
  return (query: string): RotateMediaQueryList => {
    if (query.includes('orientation')) return portrait;
    if (query.includes('pointer')) return coarse;
    throw new Error(`rotate.test: unexpected matchMedia query ${query}`);
  };
}

/** A spy for the app-level pause seam this module now calls instead of touching a
 *  Controller. The started/already-paused guard moved into `main.ts`'s `ensurePaused` (so
 *  every pause caller shares ONE guard and one synchronous home-link refresh) and is covered
 *  there — `main.test.ts`'s "the app-level pause seam" block owns the "pre-start is a no-op"
 *  and "already-paused is a no-op" cases that used to be asserted here against a fake. What
 *  rotate.ts is responsible for, and all this file can still prove, is WHEN it asks. */
const fakeEnsurePaused = (): ReturnType<typeof vi.fn> => vi.fn();

let activeModal: { destroy(): void } | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  activeModal = null;
});

afterEach(() => {
  activeModal?.destroy();
});

describe('rotate — the portrait/coarse-pointer prompt (PLAN.md P5)', () => {
  it('shows only when BOTH orientation:portrait and pointer:coarse match, hides otherwise', () => {
    const rotateEl = document.createElement('div');
    const shell = document.createElement('div');
    document.body.append(rotateEl, shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const portrait = fakeQuery(false);
    const coarse = fakeQuery(false);
    const ensurePaused = fakeEnsurePaused();
    const abort = vi.fn();

    const handle = createRotate(
      document,
      rotateEl,
      modal,
      ensurePaused,
      { abort },
      fakeMatchMedia(portrait, coarse),
    );

    expect(rotateEl.hidden).toBe(true); // neither matches at construction

    portrait.set(true); // portrait only — pointer still fine (mouse) — stays hidden
    expect(rotateEl.hidden).toBe(true);

    coarse.set(true); // now both match
    expect(rotateEl.hidden).toBe(false);
    expect(rotateEl.getAttribute('role')).toBe('dialog');

    portrait.set(false); // back to landscape
    expect(rotateEl.hidden).toBe(true);

    handle.destroy();
  });

  it('asks the app-level pause seam to pause on ENTERING portrait+coarse', () => {
    const rotateEl = document.createElement('div');
    const shell = document.createElement('div');
    document.body.append(rotateEl, shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const portrait = fakeQuery(false);
    const coarse = fakeQuery(false);
    const ensurePaused = fakeEnsurePaused();

    const handle = createRotate(
      document,
      rotateEl,
      modal,
      ensurePaused,
      { abort: vi.fn() },
      fakeMatchMedia(portrait, coarse),
    );

    expect(ensurePaused).not.toHaveBeenCalled();
    portrait.set(true);
    coarse.set(true);
    expect(ensurePaused).toHaveBeenCalledTimes(1);

    // Re-ENTERING asks again. That is not a double-pause: the seam owns the
    // already-paused guard (and the pre-start one), so a second ask on an already-paused run
    // is a no-op there — asserted in `main.test.ts`'s "the app-level pause seam" block rather
    // than re-implemented against a fake here, which would only test the fake.
    coarse.set(false);
    coarse.set(true);
    expect(ensurePaused).toHaveBeenCalledTimes(2);

    handle.destroy();
  });

  it('never resumes on returning to landscape — the run stays paused', () => {
    const rotateEl = document.createElement('div');
    const shell = document.createElement('div');
    document.body.append(rotateEl, shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const portrait = fakeQuery(false);
    const coarse = fakeQuery(false);
    const ensurePaused = fakeEnsurePaused();

    const handle = createRotate(
      document,
      rotateEl,
      modal,
      ensurePaused,
      { abort: vi.fn() },
      fakeMatchMedia(portrait, coarse),
    );

    portrait.set(true);
    coarse.set(true);
    expect(rotateEl.hidden).toBe(false);
    expect(ensurePaused).toHaveBeenCalledTimes(1);

    portrait.set(false); // back to landscape
    expect(rotateEl.hidden).toBe(true); // overlay closes
    // The run stays paused because NOTHING here resumes it: leaving portrait asks for no
    // further pause state at all. This module's whole controller surface is now a single
    // `ensurePaused` callback — it has no `resume` to call even by mistake, so the
    // never-auto-resume property is enforced structurally, not just by this assertion.
    expect(ensurePaused).toHaveBeenCalledTimes(1);

    handle.destroy();
  });

  it('aborts an in-flight placement gesture on entering portrait+coarse', () => {
    const rotateEl = document.createElement('div');
    const shell = document.createElement('div');
    document.body.append(rotateEl, shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const portrait = fakeQuery(false);
    const coarse = fakeQuery(false);
    const ensurePaused = fakeEnsurePaused();
    const abort = vi.fn();

    const handle = createRotate(
      document,
      rotateEl,
      modal,
      ensurePaused,
      { abort },
      fakeMatchMedia(portrait, coarse),
    );

    expect(abort).not.toHaveBeenCalled();
    portrait.set(true);
    coarse.set(true);
    expect(abort).toHaveBeenCalled();

    // Leaving portrait must never call abort again — only entering does.
    const callsBeforeLeaving = abort.mock.calls.length;
    portrait.set(false);
    expect(abort.mock.calls.length).toBe(callsBeforeLeaving);

    handle.destroy();
  });

  it('never steals focus from an open results dialog (modal priority: results > rotate)', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const results: ModalOverlay = { show: vi.fn(), hide: vi.fn() };
    modal.open(results, { priority: 'results' });

    const rotateEl = document.createElement('div');
    document.body.appendChild(rotateEl);
    const portrait = fakeQuery(false);
    const coarse = fakeQuery(false);
    const ensurePaused = fakeEnsurePaused();

    const handle = createRotate(
      document,
      rotateEl,
      modal,
      ensurePaused,
      { abort: vi.fn() },
      fakeMatchMedia(portrait, coarse),
    );

    portrait.set(true);
    coarse.set(true);
    // rotate is registered (its `open` call didn't throw) but results outranks it — the
    // rotate element is never shown/focused, and the already-open results overlay is left
    // untouched (its `show`/`hide` only ever reflect ITS OWN open call above).
    expect(rotateEl.hidden).toBe(true);
    expect(document.activeElement).not.toBe(rotateEl);
    expect(results.show).toHaveBeenCalledTimes(1);
    expect(results.hide).not.toHaveBeenCalled();

    handle.destroy();
    modal.close(results);
  });
});
