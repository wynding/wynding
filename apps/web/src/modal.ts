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
  /** Does hardware Back EXIT THE APP from this overlay? True for exactly one overlay today,
   *  the results dialog: the run is over and inside a Host there is no other way out.
   *
   *  DECLARED HERE RATHER THAN INFERRED FROM `priority`, which is what the first cut did.
   *  Inferring meant "anything at `results` priority quits the app", an invariant held up by
   *  a comment — and ADR 0014 records a survey overlay already being talked out of that same
   *  priority once. Registering there is a design question; silently gaining the power to
   *  close the app should not be its answer.
   *
   *  Defaults to false, and `dismissOnEscape` WINS if both are set: an overlay Escape can
   *  close is `dismissable` to Back too, which is the whole of the agreement below. */
  readonly backExits?: boolean;
}

interface StackEntry {
  readonly overlay: ModalOverlay;
  readonly priority: ModalPriority;
  readonly dismissOnEscape: boolean;
  readonly backExits: boolean;
}

/** What the active overlay means to the hardware Back button (#138).
 *
 *  `dismissable` closes, `consuming` swallows the press. `exit` is split out of `consuming`
 *  because the results dialog is the one overlay whose
 *  correct Back behaviour is neither: the run is OVER, and inside a Host there is nothing
 *  else to leave through — the wordmark is a non-interactive `span` (ADR 0012) and the
 *  dialog offers only Play again, Verify, Copy and Save. Consuming Back there traps a
 *  player who simply does not want another run. */
export type ModalBackState = 'dismissable' | 'exit' | 'consuming';

export interface ModalOwner {
  open(overlay: ModalOverlay, options: ModalOpenOptions): void;
  close(overlay: ModalOverlay): void;
  /** Which routing row the ACTIVE (highest-priority open) overlay selects for hardware
   *  Back, or `null` when nothing is open.
   *
   *  Derived from the SAME `dismissOnEscape` metadata the Escape handler reads, plus the
   *  priority this module already owns — so an overlay is still classified once, at its
   *  `open` call, and a new one cannot be forgotten by one key and remembered by the other.
   *
   *  BACK AND ESCAPE AGREE ON DISMISSAL AND DIVERGE ON EXIT, which is not a wrinkle to
   *  tidy away. They share this classification exactly; what differs is that Back has an
   *  exit row and Escape has no analogue for it — a keyboard cannot quit an app, and a
   *  desktop player pressing Escape on the results dialog must not lose the page. The
   *  `results` row exists for the platform where Back IS the way out. */
  activeBackState(): ModalBackState | null;
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
      backExits: openOptions.backExits === true,
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
   *  implementation, shared by Escape below and by hardware Back (#138) — `activeBackState`
   *  above promises the two keys agree about DISMISSAL (they diverge only on exit, which
   *  Escape has no analogue for), and two copies of this rule is exactly how that promise
   *  would quietly stop being true. */
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
    activeBackState(): ModalBackState | null {
      const active = activeEntry();
      if (active === null) return null;
      // ORDER IS LOAD-BEARING, and a test pins it: `dismissOnEscape` is checked FIRST so
      // that anything Escape closes is `dismissable` to Back as well. Reversed, an overlay
      // declaring both would have Escape close it while Back quit the app — exactly the
      // disagreement the doc above says cannot happen.
      if (active.dismissOnEscape) return 'dismissable';
      return active.backExits ? 'exit' : 'consuming';
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
