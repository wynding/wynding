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
// stack is non-empty, Escape never reaches the game. Settings is the only dismissable
// overlay (Escape closes it); results and rotate are state-driven and only consume the
// key. `isEscapeHeld` lets a caller (the settings rebind-key capture) claim Escape for
// itself first — "existing capture wins" (PLAN.md P2's Focus rules, which already applies
// here since this is the first document-scope Escape handler in the app).

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

interface StackEntry {
  readonly overlay: ModalOverlay;
  readonly priority: ModalPriority;
}

export interface ModalOwner {
  open(overlay: ModalOverlay, options: { readonly priority: ModalPriority }): void;
  close(overlay: ModalOverlay): void;
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
      if (best === null || PRIORITY_RANK[entry.priority] < PRIORITY_RANK[best.priority]) {
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

  function open(overlay: ModalOverlay, openOptions: { readonly priority: ModalPriority }): void {
    if (stack.some((e) => e.overlay === overlay)) return; // idempotent by identity
    if (stack.length === 0) {
      preModalFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
      shell.setAttribute('inert', '');
    }
    stack.push({ overlay, priority: openOptions.priority });
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

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.code !== 'Escape') return;
    if (options.isEscapeHeld?.() === true) return; // a local capture (rebind) wins
    const active = activeEntry();
    if (active === null) return; // no modal open — game-level Escape (P2) may handle it
    e.preventDefault();
    e.stopPropagation();
    if (active.priority === 'settings') close(active.overlay);
    // results/rotate: consumed, not dismissable — no further action.
  };
  doc.addEventListener('keydown', onKeydown, true); // capture: runs before game-level Escape

  return {
    open,
    close,
    destroy(): void {
      doc.removeEventListener('keydown', onKeydown, true);
    },
  };
}
