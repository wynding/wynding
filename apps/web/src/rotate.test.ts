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

/** A minimal fake of the `Controller` slice `createRotate` reads — a mutable `started`/
 *  `paused` pair plus a `pause` spy, avoiding the need to stand up a real Controller. */
function fakeController(started: boolean): {
  uiState: () => { started: boolean };
  isPaused: () => boolean;
  pause: ReturnType<typeof vi.fn>;
  setPaused(v: boolean): void;
} {
  let paused = false;
  const pause = vi.fn(() => {
    paused = true;
  });
  return {
    uiState: () => ({ started }),
    isPaused: () => paused,
    pause,
    setPaused(v: boolean): void {
      paused = v;
    },
  };
}

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
    const controller = fakeController(false);
    const abort = vi.fn();

    const handle = createRotate(
      document,
      rotateEl,
      modal,
      controller,
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

  it('auto-pauses an active, unpaused run on entering portrait+coarse', () => {
    const rotateEl = document.createElement('div');
    const shell = document.createElement('div');
    document.body.append(rotateEl, shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const portrait = fakeQuery(false);
    const coarse = fakeQuery(false);
    const controller = fakeController(true); // a run is active

    const handle = createRotate(
      document,
      rotateEl,
      modal,
      controller,
      { abort: vi.fn() },
      fakeMatchMedia(portrait, coarse),
    );

    expect(controller.pause).not.toHaveBeenCalled();
    portrait.set(true);
    coarse.set(true);
    expect(controller.pause).toHaveBeenCalledTimes(1);

    // Redundant re-evaluation (e.g. a further `change` while already shown) must not
    // pause again once the run is already paused.
    coarse.set(false);
    coarse.set(true);
    expect(controller.pause).toHaveBeenCalledTimes(1);

    handle.destroy();
  });

  it('does not auto-pause pre-start (nothing to pause)', () => {
    const rotateEl = document.createElement('div');
    const shell = document.createElement('div');
    document.body.append(rotateEl, shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const portrait = fakeQuery(false);
    const coarse = fakeQuery(false);
    const controller = fakeController(false); // not started

    const handle = createRotate(
      document,
      rotateEl,
      modal,
      controller,
      { abort: vi.fn() },
      fakeMatchMedia(portrait, coarse),
    );

    portrait.set(true);
    coarse.set(true);
    expect(controller.pause).not.toHaveBeenCalled();

    handle.destroy();
  });

  it('stays paused on returning to landscape — nothing here ever resumes', () => {
    const rotateEl = document.createElement('div');
    const shell = document.createElement('div');
    document.body.append(rotateEl, shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const portrait = fakeQuery(false);
    const coarse = fakeQuery(false);
    const controller = fakeController(true);

    const handle = createRotate(
      document,
      rotateEl,
      modal,
      controller,
      { abort: vi.fn() },
      fakeMatchMedia(portrait, coarse),
    );

    portrait.set(true);
    coarse.set(true);
    expect(rotateEl.hidden).toBe(false);
    expect(controller.isPaused()).toBe(true);

    portrait.set(false); // back to landscape
    expect(rotateEl.hidden).toBe(true); // overlay closes
    expect(controller.isPaused()).toBe(true); // run stays paused — no auto-resume exists
    // (the fake Controller's Pick surface has no `resume` at all — a resume call would
    // be a compile error here, so this is enforced structurally, not just by assertion.)

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
    const controller = fakeController(true);
    const abort = vi.fn();

    const handle = createRotate(
      document,
      rotateEl,
      modal,
      controller,
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
    const controller = fakeController(false);

    const handle = createRotate(
      document,
      rotateEl,
      modal,
      controller,
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
