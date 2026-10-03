// press-guard.ts — a press never activates a control it was not aimed at (#181 H2).
//
// When content under a resting pointer moves, a second press lands on whatever moved there. On
// the results panel that happens whenever something below a pressed control collapses or shrinks
// while the body is scrolled: the survey form or the Run data group closing, a shorter status
// message. The browser then clamps the body's scroll position and pulls everything above the
// collapse down under the pointer, so a double-click's second press, a second tap or a quick
// repeat lands on Play again (a new run), a survey answer or a toggle.
//
// The guard: after a POINTER press on a control inside the root, a pointer press AT THE SAME SPOT
// that lands on a DIFFERENT control within the double-click window is swallowed in the capture
// phase. `preventDefault` and `stopImmediatePropagation` stop the control's handler and any
// default action (a label forwarding its click to its input, a radio checking). What passes:
//   - a keyboard activation: its click has `detail` 0, as a script's `click()` does;
//   - a repeat on the same control: a double-click on Run data still opens and closes it;
//   - a press elsewhere: a pointer that moved further than a small target's size between the
//     presses went somewhere on purpose. Fast, deliberate sequences (open Run data, then press
//     Verify) cross the panel between presses, and the second press is the player's.
// Every press that passes, a repeat on the same control included, is the one the next press is
// measured from: its control, its time and its spot. So pressing Run data's toggle again after
// scrolling holds a quick second press to the toggle where it was pressed THIS time, not where it
// was first opened. A swallowed press changes none of the three. Nor does the click a label
// forwards to its control for a press on the label's text: that click is the press's own, and
// where it is dispatched from is the engine's choice (jsdom's comes from (0, 0)).

/** The double-click window: how long after a press a second press at the same spot is held to
 *  the same control. */
export const PRESS_GUARD_WINDOW_MS = 500;

/** How far a second press may land from the first and still be at the same spot: WCAG 2.5.8's
 *  smallest target. A double-click or double-tap stays well within it; moving from one control
 *  to another of at least that size goes further. */
export const PRESS_GUARD_SLOP_PX = 24;

/** What can be activated by a press. A label stands for the control it labels. */
const CONTROL = 'button, input, select, textarea, a[href], label, summary';

/** The control a press is aimed at, or null for a press on no control. A press on a label's text
 *  and the click the label forwards to its input are one press on one control: the input. */
function controlOf(target: EventTarget | null): Element | null {
  const el = target as Element | null;
  if (el === null || typeof el.closest !== 'function') return null;
  const hit = el.closest(CONTROL);
  if (hit === null) return null;
  return hit.tagName === 'LABEL' ? ((hit as HTMLLabelElement).control ?? hit) : hit;
}

/** Guard every press inside `root`, until the returned function removes the guard. */
export function guardPresses(root: HTMLElement): () => void {
  let last: {
    control: Element;
    at: number;
    x: number;
    y: number;
    /** The press was on a label's text, so the label forwards a click to `control` next. */
    forwards: boolean;
  } | null = null;
  const onClick = (event: MouseEvent): void => {
    // A label forwards its click to its control within the same dispatch, so the very next click
    // is the forwarded one, if any: part of the press already let through.
    if (last?.forwards === true) {
      last.forwards = false;
      if (event.target === last.control) return;
    }
    // A keyboard activation (or a script's click) is never a misplaced pointer.
    if (event.detail === 0) return;
    const control = controlOf(event.target);
    if (control === null || !root.contains(control)) return;
    if (
      last !== null &&
      control !== last.control &&
      event.timeStamp - last.at < PRESS_GUARD_WINDOW_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) <= PRESS_GUARD_SLOP_PX
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // It passes, and the next press is measured from it.
    const target = event.target as Node;
    last = {
      control,
      at: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
      forwards: control !== target && !control.contains(target),
    };
  };
  root.addEventListener('click', onClick, true);
  return () => root.removeEventListener('click', onClick, true);
}
