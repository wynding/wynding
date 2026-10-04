// press-guard.ts — a press never activates a control it was not aimed at (#181 H2).
//
// When content under a resting pointer moves, a second press lands on whatever moved there. On
// the results panel that happens when something below a pressed control collapses or shrinks while
// the body is scrolled (the survey form or the Run data group closing: the browser clamps the
// scroll position and carries everything above down under the pointer), when opening the survey
// brings its first question into view, and when the dialog itself arrives under a pointer that was
// pressing the board. A double-click's second press, a second tap or a quick repeat then lands on
// Play again (a new run), a survey answer or a toggle.
//
// The guard holds a pointer press only when the layout really moved under a pointer that stayed
// put. A press is held when ALL of these hold:
//   1. It belongs to the gesture of the last press the guard let through: it comes within the
//      double-click window (500 ms) of it, or the OS counts it as a repeat of it (`detail` above 1)
//      within 2 s. The OS count follows the player's own double-click speed, which people slow
//      down for motor access.
//   2. It lands within the slop of that press: 24px for a mouse or a pen, 48px for touch (a press
//      whose `pointerdown` says `touch`, or any press where the primary pointer is coarse: WebKit's
//      tap clicks report `mouse`).
//   3. It lands on a different control inside the panel, AND the layout moved since that press:
//      the element that press landed on moved, resized, hid or left the document, or the dialog
//      arrived after it (`arm`). Where nothing moved, the pointer moved on purpose, and the press
//      passes: a quick correction from one rating to its neighbour, 23px away, is the player's.
// A held press is held at `mousedown`, so it never moves focus, and its click is swallowed in the
// capture phase (`preventDefault` and `stopImmediatePropagation`): no handler runs and no default
// action, so a label forwards nothing to its radio and a radio does not check. The click takes its
// `mousedown`'s verdict, so a press stays held to its release however long it is pressed. Presses
// are recorded across the whole document, so a press on the board just before the dialog opens is
// the one the dialog's arrival is measured against.
//
// What always passes: a keyboard activation (its click has `detail` 0, as a script's `click()`
// does), a repeat on the same control (a double-click on Run data opens and closes it), and a
// press beyond the slop. A press with another button than the main one is ignored. Every press
// that passes, a repeat included, is the one the next press is measured from; a held press
// changes nothing, so a triple-click's third press is held like its second. The click a label
// forwards to its control, for a press on the label's text, is part of that press, wherever the
// engine dispatches it from (jsdom's comes from (0, 0)); a press on a control's own content (Run
// data's text) is simply that control's press.
//
// The keyboard: an auto-repeated Enter or Space on a panel button activates nothing (the key's own
// press and release still do, once), and a control that focus has just been moved to takes no
// Enter or Space for 500 ms (`holdKeys`: Play again after an accepted Send, where a second Enter
// meant for Send would otherwise start a new run).

/** The double-click window: a press this soon after the last one belongs to its gesture. */
export const PRESS_GUARD_WINDOW_MS = 500;

/** How long a press the OS counts as a repeat (`detail` above 1) still belongs to the gesture of
 *  the last one: past the slowest double-click setting a player is likely to choose, capped. */
export const PRESS_GUARD_REPEAT_MS = 2000;

/** How far a press may land from the last one and still be at the same spot, for a mouse or a
 *  pen: WCAG 2.5.8's smallest target. */
export const PRESS_GUARD_SLOP_PX = 24;

/** The same for touch: a finger's second tap drifts further than a resting mouse. */
export const PRESS_GUARD_TOUCH_SLOP_PX = 48;

/** How long a control that focus has just been moved to takes no Enter or Space. */
export const PRESS_GUARD_KEY_HOLD_MS = 500;

/** What can be activated by a press. A label stands for the control it labels. */
const CONTROL = 'button, input, select, textarea, a[href], label, summary';

/** How far an element may shift, or grow, before the layout counts as moved under it. */
const MOVED_PX = 0.5;

/** The control a press is aimed at, or null for a press on no control. A press on a label's text
 *  and the click the label forwards to its input are one press on one control: the input. */
function controlOf(target: EventTarget | null): Element | null {
  const el = target as Element | null;
  if (el === null || typeof el.closest !== 'function') return null;
  const hit = el.closest(CONTROL);
  if (hit === null) return null;
  return hit.tagName === 'LABEL' ? ((hit as HTMLLabelElement).control ?? hit) : hit;
}

/** Where an element stands and whether it shows: what "the layout moved" is measured by. An
 *  element under `display: none` has an empty box at the origin, so its box says that. */
interface Place {
  /** In the document, under no `hidden` element, and not `visibility: hidden`. */
  readonly shown: boolean;
  readonly box: DOMRect;
}

function placeOf(el: Element): Place {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return {
    shown: el.isConnected && el.closest('[hidden]') === null && style?.visibility !== 'hidden',
    box: el.getBoundingClientRect(),
  };
}

function movedFrom(was: Place, now: Place): boolean {
  return (
    was.shown !== now.shown ||
    Math.abs(was.box.x - now.box.x) > MOVED_PX ||
    Math.abs(was.box.y - now.box.y) > MOVED_PX ||
    Math.abs(was.box.width - now.box.width) > MOVED_PX ||
    Math.abs(was.box.height - now.box.height) > MOVED_PX
  );
}

/** A press the guard let through: the one the next press is measured from. */
interface Press {
  readonly control: Element | null;
  /** What the press landed on: its control, or else the element itself. */
  readonly el: Element;
  readonly at: number;
  readonly x: number;
  readonly y: number;
  /** Where `el` stood when it was pressed. */
  readonly place: Place;
  /** How many times the dialog had arrived (`arm`) before this press. */
  readonly arrivals: number;
}

export interface PressGuard {
  /** The dialog has just arrived, or arrived again: a press made before now landed on whatever
   *  stood there before it, so the arrival counts as the layout moving. */
  arm(): void;
  /** Focus has just been moved to `el` for the player: `el` takes no Enter or Space for
   *  `PRESS_GUARD_KEY_HOLD_MS`. */
  holdKeys(el: Element): void;
  /** Stop listening. */
  remove(): void;
}

/** Guard every press that lands on a control inside `root`, until `remove`. Presses are recorded
 *  across `root`'s whole document. */
export function guardPresses(root: HTMLElement): PressGuard {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const coarse = view?.matchMedia?.('(pointer: coarse)');
  let arrivals = 0;
  let last: Press | null = null;
  /** The pointer type of the press under way, from its `pointerdown`. */
  let pointerType = '';
  /** A `mousedown`'s verdict, for the click of the same press. */
  let pending: { readonly target: EventTarget | null; readonly held: boolean } | null = null;
  /** A label press that passed: its label forwards a click to this control next. */
  let forwardTo: Element | null = null;
  let keyHold: { readonly el: Element; readonly until: number } | null = null;
  /** A held key press, whose release is held too. */
  let heldKey: string | null = null;

  /** Judge a pointer press. One that passes becomes the next press's reference. */
  function judge(event: MouseEvent, type: string): boolean {
    const target = event.target as Element | null;
    if (target === null || typeof target.closest !== 'function') return false;
    const control = controlOf(target);
    if (last !== null && control !== last.control && root.contains(control)) {
      const gap = event.timeStamp - last.at;
      const inGesture =
        gap < PRESS_GUARD_WINDOW_MS || (event.detail > 1 && gap < PRESS_GUARD_REPEAT_MS);
      const slop =
        type === 'touch' || coarse?.matches === true
          ? PRESS_GUARD_TOUCH_SLOP_PX
          : PRESS_GUARD_SLOP_PX;
      const near = Math.hypot(event.clientX - last.x, event.clientY - last.y) <= slop;
      if (
        inGesture &&
        near &&
        (last.arrivals !== arrivals || movedFrom(last.place, placeOf(last.el)))
      ) {
        return true;
      }
    }
    const el = control ?? target;
    last = {
      control,
      el,
      at: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
      place: placeOf(el),
      arrivals,
    };
    return false;
  }

  const onPointerDown = (event: Event): void => {
    pointerType = (event as PointerEvent).pointerType ?? '';
  };

  const onMouseDown = (event: MouseEvent): void => {
    const type = pointerType;
    pointerType = '';
    // A context-menu or middle press activates nothing, and is no one's reference.
    if (event.button !== 0) return;
    const held = judge(event, type);
    pending = { target: event.target, held };
    // Held here, focus stays where it was: Chromium focuses a pressed button on `mousedown`.
    if (held) event.preventDefault();
  };

  const onClick = (event: MouseEvent): void => {
    if (forwardTo !== null) {
      const to = forwardTo;
      forwardTo = null;
      // A label forwards its click to its control within the same dispatch: part of the press
      // already let through.
      if (event.target === to) return;
    }
    // A keyboard activation (or a script's click) is never a misplaced pointer.
    if (event.detail === 0) return;
    const down = pending;
    pending = null;
    // The click of a press whose `mousedown` was judged takes its verdict. Its target is that
    // press's, or an ancestor where the pointer was released elsewhere. A click with no
    // `mousedown` of its own is judged here.
    const target = event.target as Node | null;
    const ofDown =
      down !== null &&
      target !== null &&
      (target === down.target ||
        (typeof target.contains === 'function' && target.contains(down.target as Node)));
    const held = ofDown
      ? down.held
      : judge(event, (event as Partial<PointerEvent>).pointerType ?? '');
    if (held) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const control = controlOf(event.target);
    if (control !== null && target !== null && control !== target && !control.contains(target)) {
      forwardTo = control;
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const button = (event.target as Element | null)?.closest?.('button') ?? null;
    // Listening on `root`, this hears only keys pressed inside the panel.
    if (button === null) return;
    if (event.repeat) {
      // An auto-repeat: the key's own press did whatever it does (and Space's release still
      // will, once).
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const now = view?.performance.now() ?? 0;
    if (keyHold !== null && keyHold.el === button && now < keyHold.until) {
      heldKey = event.key;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (heldKey === null || event.key !== heldKey) return;
    heldKey = null;
    // Space activates a button on its release: that of a held press is held too.
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('mousedown', onMouseDown, true);
  doc.addEventListener('click', onClick, true);
  root.addEventListener('keydown', onKeyDown, true);
  root.addEventListener('keyup', onKeyUp, true);
  return {
    arm: (): void => void arrivals++,
    holdKeys: (el: Element): void => {
      keyHold = { el, until: (view?.performance.now() ?? 0) + PRESS_GUARD_KEY_HOLD_MS };
    },
    remove: (): void => {
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('mousedown', onMouseDown, true);
      doc.removeEventListener('click', onClick, true);
      root.removeEventListener('keydown', onKeyDown, true);
      root.removeEventListener('keyup', onKeyUp, true);
    },
  };
}
