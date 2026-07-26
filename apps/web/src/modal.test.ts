import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createModalOwner, type ModalOverlay } from './modal';

function fakeOverlay(): ModalOverlay & {
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
} {
  return { show: vi.fn(), hide: vi.fn() };
}

// Every test attaches a document-level Escape listener (`createModalOwner`); `document`
// itself is shared across tests in this file (only `body.innerHTML` is reset), so each
// test destroys its own owner in `afterEach` — otherwise a stale listener from an earlier
// test (especially one that leaves results/rotate "open" — Escape consumed, not closed)
// would keep firing and contaminate a later test's Escape assertions.
let activeModal: { destroy(): void } | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  activeModal = null;
});

afterEach(() => {
  activeModal?.destroy();
});

describe('modal owner — inert + stack semantics (PLAN.md P1)', () => {
  it('inerts the shell on first open and un-inerts it once the stack empties', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const a = fakeOverlay();
    modal.open(a, { priority: 'settings' });
    expect(shell.hasAttribute('inert')).toBe(true);
    expect(a.show).toHaveBeenCalledOnce();

    modal.close(a);
    expect(shell.hasAttribute('inert')).toBe(false);
    expect(a.hide).toHaveBeenCalledOnce();
  });

  it('restores focus to the pre-modal element only when the stack empties', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const focusSpy = vi.spyOn(trigger, 'focus');
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const settings = fakeOverlay();
    const results = fakeOverlay();

    modal.open(settings, { priority: 'settings' });
    modal.open(results, { priority: 'results' }); // higher priority stacks on top
    expect(focusSpy).not.toHaveBeenCalled(); // stack still non-empty

    modal.close(results);
    expect(focusSpy).not.toHaveBeenCalled(); // settings still open underneath

    modal.close(settings);
    expect(focusSpy).toHaveBeenCalledOnce(); // stack empty — restored
  });

  it('only the highest-priority (results > rotate > settings) open overlay is shown/focused', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const settings = fakeOverlay();
    const rotate = fakeOverlay();
    const results = fakeOverlay();

    modal.open(settings, { priority: 'settings' });
    expect(settings.show).toHaveBeenCalledTimes(1);

    // rotate outranks settings — it becomes active; settings hides.
    modal.open(rotate, { priority: 'rotate' });
    expect(rotate.show).toHaveBeenCalledTimes(1);
    expect(settings.hide).toHaveBeenCalledTimes(1);

    // results outranks rotate — it becomes active; rotate hides. Settings (stacked two
    // levels down) is never touched again — it was already hidden, and stays that way.
    modal.open(results, { priority: 'results' });
    expect(results.show).toHaveBeenCalledTimes(1);
    expect(rotate.hide).toHaveBeenCalledTimes(1);
    expect(settings.hide).toHaveBeenCalledTimes(1); // unchanged — still hidden, not re-hidden

    // Closing the top (results) activates the next entry (rotate).
    modal.close(results);
    expect(rotate.show).toHaveBeenCalledTimes(2);
    expect(settings.show).toHaveBeenCalledTimes(1); // unchanged — still not active

    // Closing rotate activates the last entry (settings).
    modal.close(rotate);
    expect(settings.show).toHaveBeenCalledTimes(2);

    modal.close(settings);
    expect(shell.hasAttribute('inert')).toBe(false);
  });

  it('duplicate open of the same overlay identity does not double-register', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const rotate = fakeOverlay();
    modal.open(rotate, { priority: 'rotate' });
    modal.open(rotate, { priority: 'rotate' }); // duplicate — must not re-push/re-show
    expect(rotate.show).toHaveBeenCalledTimes(1);
    modal.close(rotate);
    expect(shell.hasAttribute('inert')).toBe(false); // one close fully removed it
  });

  it('a missing close (never opened) is a harmless no-op', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const neverOpened = fakeOverlay();
    expect(() => modal.close(neverOpened)).not.toThrow();
    expect(neverOpened.hide).not.toHaveBeenCalled();
    expect(shell.hasAttribute('inert')).toBe(false);
  });

  it('closing an inactive (stacked-but-not-shown) overlay just removes it, no flicker', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const results = fakeOverlay();
    const settings = fakeOverlay();
    modal.open(results, { priority: 'results' });
    modal.open(settings, { priority: 'settings' }); // stacked underneath, never shown

    modal.close(settings); // inactive-close
    expect(settings.hide).not.toHaveBeenCalled(); // it was never shown — no hide() needed
    expect(results.hide).not.toHaveBeenCalled(); // the active entry is untouched
    expect(shell.hasAttribute('inert')).toBe(true); // results is still open

    modal.close(results);
    expect(shell.hasAttribute('inert')).toBe(false);
  });
});

describe('modal owner — Escape handling', () => {
  it('Escape closes an overlay that declares dismissOnEscape (settings, install instructions)', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const settings = fakeOverlay();
    modal.open(settings, { priority: 'settings', dismissOnEscape: true });
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    expect(settings.hide).toHaveBeenCalledOnce();
    expect(shell.hasAttribute('inert')).toBe(false);
  });

  // Dismissability is per-overlay METADATA, not a property of the priority (Story 11 P3):
  // the install instructions dialog shares `settings` priority, so an overlay that does not
  // declare it must still only CONSUME the key.
  it('Escape is consumed but does NOT close a settings-priority overlay that omits dismissOnEscape', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const overlay = fakeOverlay();
    modal.open(overlay, { priority: 'settings' });
    const evt = new KeyboardEvent('keydown', { code: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(evt);
    expect(overlay.hide).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(true);
    expect(shell.hasAttribute('inert')).toBe(true);
  });

  // Two overlays share `settings` priority (the settings dialog and the iOS instructions
  // dialog), so the equal-priority tie-break has to be pinned: last-opened-wins, and closing
  // the newer one restores the older rather than blanking the still-inert Shell.
  it('two equal-priority overlays stack last-opened-wins, and closing the newer restores the older', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const settings = fakeOverlay();
    const instructions = fakeOverlay();

    modal.open(settings, { priority: 'settings', dismissOnEscape: true });
    expect(settings.show).toHaveBeenCalledOnce();

    modal.open(instructions, { priority: 'settings', dismissOnEscape: true });
    expect(settings.hide).toHaveBeenCalledOnce(); // the older yields...
    expect(instructions.show).toHaveBeenCalledOnce(); // ...to the newer

    modal.close(instructions);
    expect(instructions.hide).toHaveBeenCalledOnce();
    expect(settings.show).toHaveBeenCalledTimes(2); // the older is re-shown, not left blank
    expect(shell.hasAttribute('inert')).toBe(true); // one is still open

    modal.close(settings);
    expect(shell.hasAttribute('inert')).toBe(false);
  });

  it('Escape is consumed but does NOT close results or rotate (state-driven, not dismissable)', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const results = fakeOverlay();
    modal.open(results, { priority: 'results' });
    const evt = new KeyboardEvent('keydown', { code: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(evt);
    expect(results.hide).not.toHaveBeenCalled();
    expect(shell.hasAttribute('inert')).toBe(true); // still open
    expect(evt.defaultPrevented).toBe(true); // consumed — never reaches game-level Escape
  });

  it('Escape no-ops (does not preventDefault) when the stack is empty', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    activeModal = createModalOwner(document, shell);
    const evt = new KeyboardEvent('keydown', { code: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false); // left for game-level Escape (P2) to handle
  });

  it('isEscapeHeld lets a local capture (e.g. settings rebind) claim Escape first', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    let held = false;
    const modal = createModalOwner(document, shell, { isEscapeHeld: () => held });
    activeModal = modal;
    const settings = fakeOverlay();
    modal.open(settings, { priority: 'settings', dismissOnEscape: true });

    held = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    expect(settings.hide).not.toHaveBeenCalled(); // the local capture "won"

    held = false;
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    expect(settings.hide).toHaveBeenCalledOnce();
  });

  it('destroy() with an open overlay closes out the stack — un-inerts the shell and restores focus', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const focusSpy = vi.spyOn(trigger, 'focus');
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const settings = fakeOverlay();
    modal.open(settings, { priority: 'settings' });
    expect(shell.hasAttribute('inert')).toBe(true);

    modal.destroy();
    expect(shell.hasAttribute('inert')).toBe(false); // no longer inert/unusable
    expect(settings.hide).toHaveBeenCalledOnce(); // active overlay hidden
    expect(focusSpy).toHaveBeenCalledOnce(); // pre-modal focus restored
  });

  it('destroy() detaches the Escape listener', () => {
    const shell = document.createElement('div');
    document.body.appendChild(shell);
    const modal = createModalOwner(document, shell);
    activeModal = modal;
    const settings = fakeOverlay();
    modal.open(settings, { priority: 'settings', dismissOnEscape: true });
    modal.destroy();
    // destroy() closes out the still-open stack (hides once, F7) — clear that so this test
    // isolates the LISTENER-detached property: an Escape AFTER destroy must trigger no
    // further close.
    settings.hide.mockClear();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    expect(settings.hide).not.toHaveBeenCalled(); // listener gone — no close happened
  });
});
