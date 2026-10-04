// focus-in-place.ts — move focus right after a render, without moving content under a resting
// pointer (#181 H2).
//
// The results panel moves focus for the player as it changes: the survey's first question when it
// opens, Give feedback after Not now, Play again after an accepted Send. After a POINTER press
// that focus moves without the browser's own scroll, which would carry content out from under the
// pointer that pressed. Two engine quirks shape it:
//   - WebKit, asked to focus without scrolling while layout is dirty (as a render that shows or
//     hides part of the panel leaves it), scrolls the element into view anyway at its next
//     rendering update. So layout is read first.
//   - A focus ring the player is meant to see must be on screen (WCAG 2.4.11, 2.4.7). Where the
//     player has switched to the keyboard meanwhile (a Tab while a pointer-pressed Send is in
//     flight), the newly focused control matches `:focus-visible`, and it is brought into view by
//     the least scroll. A pointer that is still in use leaves no ring, and nothing moves.

/** Focus `el` right after a render: without the browser's scroll where `preventScroll`, and with
 *  it otherwise. Layout is read first either way. */
export function focusAfterRender(el: HTMLElement | undefined, preventScroll: boolean): void {
  if (el === undefined) return;
  void el.offsetHeight;
  el.focus(preventScroll ? { preventScroll: true } : undefined);
  if (preventScroll && ringed(el) && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'nearest' });
  }
}

/** Whether `el` shows its focus ring. jsdom's selector engine may not know `:focus-visible`. */
function ringed(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}
