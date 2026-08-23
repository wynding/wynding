// modal.ts — the single authority over `inert` on `.wy-shell` and focus save/restore for
// every modal overlay (results / rotate / settings — PLAN.md P1). `.wy-shell` is the ONLY
// node this module ever toggles `inert` on; the overlay elements themselves (results,
// settings, and — from P5 — rotate) are siblings of the Shell, never inside it.
//
// Stack semantics: only the highest-priority OPEN overlay is visible and focused. Opening
// a lower-priority overlay while a higher one is open records it in the stack without
// activating it (no show/focus); closing the active overlay activates (shows) the next
// entry. `open`/`close` are idempotent by overlay IDENTITY: a duplicate `open` of the same
// overlay object never double-registers, and closing an overlay that is missing or merely
// stacked-but-inactive is a harmless no-op.
//
// Escape is consumed here FIRST, before any game-level (P2) Escape handling: whenever the
// stack is non-empty, Escape never reaches the game. Whether it also DISMISSES is per-
// overlay metadata (`dismissOnEscape`, Story 11 P3) rather than a hardcoded check on the
// `settings` priority — settings and the install instructions dialog both dismiss and both
// register at `settings` priority, so priority alone can no longer carry that meaning.
// Results and rotate are state-driven: they consume the key without dismissing.
// `isEscapeHeld` lets a caller (the settings rebind-key capture) claim Escape for itself
// first — "existing capture wins" (PLAN.md P2's Focus rules, which already applies here
// since this is the first document-scope Escape handler in the app).

/** Priority order per PLAN.md P1: results > rotate > settings (lower rank = shown first). */
export type ModalPriority = 'results' | 'rotate' | 'settings';

const PRIORITY_RANK: Record<ModalPriority, number> = {
  results: 0,
  rotate: 1,
  settings: 2,
};

/** One overlay the modal owner can show/hide. `show()`/`hide()` own the overlay's own
 *  internal presentation (un-hiding it, focusing a specific control inside it) — the
 *  modal owner only decides WHETHER it is the currently-active entry. */
export interface ModalOverlay {
  show(): void;
  hide(): void;
}

/** How an overlay is registered on the stack. */
export interface ModalOpenOptions {
  readonly priority: ModalPriority;
  /** Does Escape DISMISS this overlay, or merely get consumed by it? Per-overlay metadata
   *  (Story 11 P3) because two overlays now share `settings` priority — the settings dialog
   *  and the install instructions dialog — while results/rotate remain state-driven and are
   *  only ever closed by the state that opened them. Defaults to false: an overlay that has
   *  not thought about it does not get a dismissal path for free. */
  readonly dismissOnEscape?: boolean;
}

interface StackEntry {
  readonly overlay: ModalOverlay;
  readonly priority: ModalPriority;
  readonly dismissOnEscape: boolean;
}

/** How the active overlay answers a "go back" key — Escape, or Android's hardware Back
 *  (#138). `dismiss` closes it; `consume` swallows the press without closing, which is
 *  what a state-driven overlay does (results is over, rotate is cleared by the device
 *  turning, not by a key). */
export type ModalDismissal = 'dismiss' | 'consume';

export interface ModalOwner {
  open(overlay: ModalOverlay, options: ModalOpenOptions): void;
  close(overlay: ModalOverlay): void;
  /** How the ACTIVE (highest-priority open) overlay answers a back/dismiss key, or `null`
   *  when nothing is open.
   *
   *  Derived from the SAME `dismissOnEscape` metadata the Escape handler reads, so the
   *  hardware Back button (#138) and Escape can never disagree about an overlay — adding
   *  a new overlay classifies it once, at its `open` call, for both. */
  activeDismissal(): ModalDismissal | null;
  /** Close the active overlay if it is dismissable; a no-op otherwise. The routing
   *  decision belongs to the caller (`back.ts`'s table) — this is only the effect. */
  dismissActive(): void;
  /** Detach the document-level Escape listener. */
  destroy(): void;
}

export interface ModalOwnerOptions {
  /** Returns true while some other, more local key-capture (the settings rebind capture)
   *  is already handling Escape itself — the modal owner then no-ops entirely so that
   *  capture (registered later, dynamically) still receives the event. */
  readonly isEscapeHeld?: () => boolean;
}

/** Create the modal owner. `shell` is the ONLY node ever toggled `inert`. */
export function createModalOwner(
  doc: Document,
  shell: HTMLElement,
  options: ModalOwnerOptions = {},
): ModalOwner {
  const stack: StackEntry[] = [];
  let preModalFocus: HTMLElement | null = null;
  // The one entry currently shown/focused — tracked so a stack mutation only calls
  // show()/hide() on overlays whose visibility actually CHANGES (an overlay stacked
  // underneath the active one, never itself active, never receives either call).
  let activeOverlay: ModalOverlay | null = null;

  const activeEntry = (): StackEntry | null => {
    let best: StackEntry | null = null;
    for (const entry of stack) {
      // `<=` makes EQUAL priorities tie-break last-opened-wins: opening a second overlay at
      // the same priority (e.g. the iOS instructions dialog over settings) activates the new
      // one rather than silently no-opping behind the older entry.
      if (best === null || PRIORITY_RANK[entry.priority] <= PRIORITY_RANK[best.priority]) {
        best = entry;
      }
    }
    return best;
  };

  function applyActive(): void {
    const next = activeEntry()?.overlay ?? null;
    if (next === activeOverlay) return; // no visibility change
    activeOverlay?.hide();
    activeOverlay = next;
    activeOverlay?.show();
  }

  function open(overlay: ModalOverlay, openOptions: ModalOpenOptions): void {
    if (stack.some((e) => e.overlay === overlay)) return; // idempotent by identity
    if (stack.length === 0) {
      preModalFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
      shell.setAttribute('inert', '');
    }
    stack.push({
      overlay,
      priority: openOptions.priority,
      dismissOnEscape: openOptions.dismissOnEscape === true,
    });
    applyActive();
  }

  function close(overlay: ModalOverlay): void {
    const idx = stack.findIndex((e) => e.overlay === overlay);
    if (idx === -1) return; // missing close — no-op
    stack.splice(idx, 1);
    applyActive(); // if `overlay` was active, this hides it and activates the next entry
    if (stack.length === 0) {
      shell.removeAttribute('inert');
      preModalFocus?.focus();
      preModalFocus = null;
    }
  }

  /** Dismiss the active overlay if it is dismissable; a no-op otherwise. ONE
   *  implementation, shared by Escape below and by hardware Back (#138) — the doc on
   *  `activeDismissal` promises the two can never disagree about an overlay, and two
   *  copies of this rule is exactly how that promise would quietly stop being true. */
  function dismissActive(): void {
    const active = activeEntry();
    if (active !== null && active.dismissOnEscape) close(active.overlay);
  }

  const onKeydown = (e: KeyboardEvent): void => {
    // Prefer `e.key` — `e.code` can be '' on virtual/on-screen keyboards — keeping `code`
    // as a fallback for the physical keyboards that populate it.
    if (e.key !== 'Escape' && e.code !== 'Escape') return;
    if (options.isEscapeHeld?.() === true) return; // a local capture (rebind) wins
    const active = activeEntry();
    if (active === null) return; // no modal open — game-level Escape (P2) may handle it
    e.preventDefault();
    e.stopPropagation();
    dismissActive();
    // Otherwise (results/rotate): consumed, not dismissable — no further action.
  };
  doc.addEventListener('keydown', onKeydown, true); // capture: runs before game-level Escape

  return {
    open,
    close,
    activeDismissal(): ModalDismissal | null {
      const active = activeEntry();
      if (active === null) return null;
      return active.dismissOnEscape ? 'dismiss' : 'consume';
    },
    dismissActive,
    destroy(): void {
      doc.removeEventListener('keydown', onKeydown, true);
      // Destroying with a non-empty stack must not strand the app: tear the stack down like
      // a full close so `.wy-shell` doesn't stay inert (and unusable) and focus is restored.
      if (stack.length > 0) {
        activeOverlay?.hide();
        activeOverlay = null;
        stack.length = 0;
        shell.removeAttribute('inert');
        preModalFocus?.focus();
        preModalFocus = null;
      }
    },
  };
}
