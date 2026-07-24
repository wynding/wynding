// rotate.ts — the portrait-rotate prompt (PLAN.md P5): phones/tablets only, gated on
// `(orientation: portrait)` AND `(pointer: coarse)` both matching — a narrow desktop
// window merely squeezes (its pointer stays fine), it never prompts. Registered with the
// P1 modal owner (`modal.ts`) at `rotate` priority (results > rotate > settings) — the
// modal owner alone decides whether this overlay is ever shown/focused, so opening it
// while results is already open is a stack push with no visible effect (results keeps
// focus, PLAN.md P1's stack semantics).
//
// Lifecycle on entering portrait+coarse (PLAN.md P5): abort any in-flight placement
// gesture via the input manager's `abort()` (P3's exact cancellation contract — ghost
// cleared always, a board-origin gesture stays armed, a Card-drag disarms), then open the
// overlay, then auto-pause an ACTIVE, unpaused run. A settings rebind capture open
// underneath is already cancelled for free: the modal owner hides the settings overlay the
// moment rotate outranks it, and `overlay.ts`'s settingsOverlay.hide() already cancels the
// capture on hide — no new API needed here. Returning to landscape just closes the
// overlay; the run STAYS paused (the player resumes deliberately from the Dock) — nothing
// here ever calls `resume()`.
//
// Two STABLE MediaQueryLists, registered once and never re-created — deliberately NOT
// `dpr-tracker.ts`'s rearm-per-change pattern, which exists only because a CSS
// `resolution` query is value-specific and goes silent once its watched value is left.
// `(orientation: portrait)`/`(pointer: coarse)` are fixed booleans that keep firing
// `change` forever, so one listener each suffices for the module's lifetime; the
// conjunction is simply recomputed on every `change` from either.

import { t } from './i18n/t';
import type { ModalOwner, ModalOverlay } from './modal';

/** The subset of `window.matchMedia`'s return value this module needs — injectable so
 *  tests can pass a controllable fake instead of a real `MediaQueryList`. */
export interface RotateMediaQueryList {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export type MatchMediaFn = (query: string) => RotateMediaQueryList;

export interface RotateHandle {
  /** Detach both media-query listeners and close the overlay if it's open. */
  destroy(): void;
}

/** The exact `Controller` slice this module reads — a structural subset (NOT `Pick`,
 *  whose function-property signatures would still demand the full `UiState` return
 *  shape) so both the real `Controller` and a minimal test fake satisfy it. */
export interface RotateController {
  uiState(): { readonly started: boolean };
  isPaused(): boolean;
  pause(): void;
}

/** The exact `InputHandle` slice this module calls. */
export interface RotateInput {
  abort(): void;
}

/** Build the rotate prompt into `rotateEl` (the sibling-of-Shell placeholder `main.ts`
 *  creates) and wire its show/hide + abort/pause lifecycle. `controller`/`input` are
 *  narrowed to exactly what this module reads/calls, so a test fake needs neither the
 *  full `Controller` nor `InputHandle` surface. */
export function createRotate(
  doc: Document,
  rotateEl: HTMLElement,
  modal: ModalOwner,
  controller: RotateController,
  input: RotateInput,
  matchMedia: MatchMediaFn,
): RotateHandle {
  rotateEl.hidden = true;
  rotateEl.setAttribute('role', 'dialog');
  rotateEl.setAttribute('aria-modal', 'true');
  rotateEl.setAttribute('aria-label', t('rotate.title'));
  rotateEl.tabIndex = -1;

  // Inline SVG icon — no external assets (the repo itself sets no CSP; the production
  // host's own CDN config injects one, so nothing here may assume an external origin is
  // reachable). Purely decorative: the dialog's own aria-label + message carry the meaning.
  const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'wy-rotate-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  const phone = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
  phone.setAttribute('x', '7');
  phone.setAttribute('y', '2');
  phone.setAttribute('width', '10');
  phone.setAttribute('height', '16');
  phone.setAttribute('rx', '1.5');
  phone.setAttribute('fill', 'none');
  phone.setAttribute('stroke', 'currentColor');
  phone.setAttribute('stroke-width', '1.5');
  icon.appendChild(phone);

  const message = doc.createElement('p');
  message.textContent = t('rotate.message');

  rotateEl.append(icon, message);

  const overlay: ModalOverlay = {
    show(): void {
      rotateEl.hidden = false;
      rotateEl.focus();
    },
    hide(): void {
      rotateEl.hidden = true;
    },
  };

  const portraitQuery = matchMedia('(orientation: portrait)');
  const coarseQuery = matchMedia('(pointer: coarse)');

  const evaluate = (): void => {
    if (portraitQuery.matches && coarseQuery.matches) {
      input.abort();
      modal.open(overlay, { priority: 'rotate' });
      if (controller.uiState().started && !controller.isPaused()) {
        controller.pause();
      }
    } else {
      modal.close(overlay);
    }
  };

  portraitQuery.addEventListener('change', evaluate);
  coarseQuery.addEventListener('change', evaluate);
  evaluate(); // reflect the viewport's state at construction, not just later changes

  return {
    destroy(): void {
      portraitQuery.removeEventListener('change', evaluate);
      coarseQuery.removeEventListener('change', evaluate);
      modal.close(overlay); // never leaves the shell inert if destroyed while showing
    },
  };
}
