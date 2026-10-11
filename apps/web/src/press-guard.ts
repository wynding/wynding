// press-guard.ts — a press never activates a control it was not aimed at (#181 H2).
//
// When content under a resting pointer moves, a second press lands on whatever moved there. On
// the results panel that happens when something below a pressed control collapses or shrinks while
// the body is scrolled (the survey form or the Run data group closing: the browser clamps the
// scroll position and carries everything above down under the pointer), when opening the survey
// brings its first question into view, and when the dialog itself arrives under a pointer that was
// pressing the board. A double-click's second press, a second tap or a quick repeat then lands on
// Play again (a new run), a survey answer or a toggle. A double Enter or Space does the same
// through focus, which moves to another control between the two presses.
//
// The guard holds a pointer press only when the layout really moved under a pointer that stayed
// put. A press is held when ALL of these hold:
//   1. It belongs to the gesture of the last press the guard let through: it comes within the
//      double-click window (500 ms) of it. Or the OS counts it as a repeat of it (`detail` above
//      1) within 2 s; that rule applies to every arrival too. The OS count follows the player's
//      own double-click speed, which people slow down for motor access.
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
// `mousedown`'s verdict, so a press stays held to its release however long it is pressed.
//
// Four behaviours carry the rest:
//   - Timed from the release. A press's effect lands at its click, so the gesture is measured
//     from there: a press held down a long time keeps the whole window after its release.
//   - The dialog's arrival. Presses are recorded across the whole document, every press
//     (`pointerdown`, since a tap's `mousedown` and `click` come only at its
//     release, and none come where the dialog arrived over the board meanwhile). On this board a
//     tap gives no `mousedown` or `click` at all, so these spots are touch's only protection.
//     `arm` notes the arrival and the spot of every press still down or let go under 2 s ago
//     (two fingers, or taps at two places, each keep their own); a press on a panel control
//     within the window of the arrival, inside the slop of ANY of those spots, is held: it
//     belongs to a gesture begun before the dialog was there. Where pointers were still down as
//     the dialog arrived, the arrival is timed from the last release among those presses
//     (`pointerup` or `pointercancel`), so a slow tap or a long touch keeps the whole window, and
//     a press let go before the arrival is stale 2 s after it was let go, however long it was
//     held. A press the OS counts as a repeat (`detail` above 1) belongs to the arrival for 2 s,
//     as in rule 1. A press on the control the last press that passed, since the arrival, landed
//     on is not held (a double-click on Run data after the arrival). A fourth tap of a burst
//     passes: Chromium caps its tap count at 3.
//   - Keys at the first focus. `holdKeys(el)` gives `el` no Enter or Space for 500 ms: Play again
//     at the dialog's first focus (a second Enter or Space on the board as the run ends), and after
//     an accepted Send.
//   - Keys after a keyboard activation. One (`detail` 0) that moves focus to another panel control
//     gives that control the same hold (Space twice on Give feedback would check the first rating;
//     Enter twice on Not now would reopen the survey). The move is checked where the click's
//     dispatch ends; the next key and the next task matter only for a click stopped short of the
//     window. The hold covers any control, a radio included, and is checked before the
//     auto-repeat rule.
//
// What always passes: a keyboard activation (its click has `detail` 0, as a script's `click()`
// does), a press on the control the last press that passed landed on (a double-click on Run data
// opens and closes it; after the dialog's arrival, the last press that passed since), and a press
// beyond the slop. A press with another button than the main one activates nothing and is no
// press's reference (its `pointerdown` still marks the arrival's spot). Every press
// that passes, a repeat included, is the one the next press is measured from; a held press
// changes nothing, so a triple-click's third press is held like its second. The click a label
// forwards to its control, for a press on the label's text, is part of that press, wherever the
// engine dispatches it from (jsdom's comes from (0, 0)); a press on a control's own content (Run
// data's text) is simply that control's press.
//
// An auto-repeated Enter or Space on a panel button activates nothing (the key's own press and
// release still do, once).

/** The double-click window: a press this soon after the last one belongs to its gesture, and a
 *  press on a panel control this soon after the dialog's arrival (timed from the pointer's
 *  release, where it was still down) belongs to the arrival's. */
export const PRESS_GUARD_WINDOW_MS = 500;

/** How long a press the OS counts as a repeat (`detail` above 1) still belongs to the gesture of
 *  the last one, or to the dialog's arrival: past the slowest double-click setting a player is
 *  likely to choose, capped. Also how long ago a press may have been let go for the arrival to
 *  count it. */
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

/** Where `el` stands now, and whether it shows. */
function placeOf(el: Element): Place {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return {
    shown: el.isConnected && el.closest('[hidden]') === null && style?.visibility !== 'hidden',
    box: el.getBoundingClientRect(),
  };
}

/** Whether an element was shown or hidden, or moved or resized by more than `MOVED_PX`. */
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
   *  stood there before it, so the arrival counts as the layout moving. It also notes the time and
   *  spot of every press still down, or let go under 2 s ago. */
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
  /** Each press anywhere in the document, by the order it came in, from its `pointerdown`: a
   *  tap's `mousedown` and `click` come only at its release, and none come where the dialog
   *  arrived over the board meanwhile. Two fingers, taps at two places, or the Rail and then the
   *  board each leave their own spot, whatever pointer ids the engine gives them. */
  const downs = new Map<
    number,
    {
      readonly x: number;
      readonly y: number;
      /** Its release (`pointerup` or `pointercancel`): null while it is still down. */
      readonly up: number | null;
    }
  >();
  /** The press each pointer is making, by pointer, until its release. */
  const pressing = new Map<number, number>();
  let pressCount = 0;
  /** When the dialog last arrived, and the spots of the presses it arrived after. Where pointers
   *  were still down as it arrived (`during`), the arrival is timed from the last of their
   *  releases instead. */
  let arrival: {
    readonly at: number;
    readonly spots: readonly { readonly x: number; readonly y: number }[];
    readonly during: ReadonlySet<number>;
  } | null = null;
  /** A held key press, whose release is held too. */
  let heldKey: string | null = null;

  /** A keyboard activation's focus-move check, still to run. It is resolved at the click's end,
   *  with the next key and a zero-delay timer as fallbacks for a click stopped short of the
   *  window. */
  let focusMove: { readonly from: Element | null } | null = null;
  function resolveFocusMove(): void {
    if (focusMove === null) return;
    const { from } = focusMove;
    focusMove = null;
    const to = doc.activeElement;
    if (to !== null && to !== from && root.contains(to)) {
      keyHold = { el: to, until: (view?.performance.now() ?? 0) + PRESS_GUARD_KEY_HOLD_MS };
    }
  }

  /** Judge a pointer press. One that passes becomes the next press's reference. */
  function judge(event: MouseEvent, type: string): boolean {
    const target = event.target as Element | null;
    if (target === null || typeof target.closest !== 'function') return false;
    const control = controlOf(target);
    const slop =
      type === 'touch' || coarse?.matches === true
        ? PRESS_GUARD_TOUCH_SLOP_PX
        : PRESS_GUARD_SLOP_PX;
    // The dialog has just arrived under a pointer that was pressing: a press at that spot this
    // soon after belongs to a gesture begun before the dialog was there.
    if (
      arrival !== null &&
      root.contains(control) &&
      !(last !== null && last.arrivals === arrivals && last.control === control)
    ) {
      const since = event.timeStamp - arrival.at;
      if (
        (since < PRESS_GUARD_WINDOW_MS || (event.detail > 1 && since < PRESS_GUARD_REPEAT_MS)) &&
        arrival.spots.some((s) => Math.hypot(event.clientX - s.x, event.clientY - s.y) <= slop)
      ) {
        return true;
      }
    }
    if (last !== null && control !== last.control && root.contains(control)) {
      const gap = event.timeStamp - last.at;
      const inGesture =
        gap < PRESS_GUARD_WINDOW_MS || (event.detail > 1 && gap < PRESS_GUARD_REPEAT_MS);
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
    const e = event as PointerEvent;
    pointerType = e.pointerType ?? '';
    // Kept bounded: a press let go 2 s ago can be no later arrival's (`arm`).
    for (const [n, down] of downs) {
      if (down.up !== null && e.timeStamp - down.up >= PRESS_GUARD_REPEAT_MS) downs.delete(n);
    }
    // A pointer going down again lost its last release: that press is over, and times nothing.
    const lost = pressing.get(e.pointerId);
    if (lost !== undefined) {
      downs.delete(lost);
      if (arrival !== null && arrival.during.has(lost)) {
        const during = new Set(arrival.during);
        during.delete(lost);
        arrival = { ...arrival, during };
      }
    }
    pressing.set(e.pointerId, ++pressCount);
    downs.set(pressCount, { x: e.clientX, y: e.clientY, up: null });
  };

  /** A pointer let go. Where the dialog arrived while it was down, the arrival is timed from
   *  here: a tap's `mousedown` and `click` come only at its release, and a slow one's never come
   *  where the dialog arrived over the board meanwhile. */
  const onPointerUp = (event: Event): void => {
    const e = event as PointerEvent;
    const n = pressing.get(e.pointerId);
    if (n === undefined) return;
    pressing.delete(e.pointerId);
    const down = downs.get(n);
    if (down !== undefined) downs.set(n, { ...down, up: e.timeStamp });
    if (arrival !== null && arrival.during.has(n)) {
      const during = new Set(arrival.during);
      during.delete(n);
      arrival = { ...arrival, at: Math.max(arrival.at, e.timeStamp), during };
    }
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
    if (event.detail === 0) {
      // But where it moves focus to another control in the panel (Not now back to Give feedback,
      // Give feedback to the first question), a second press of the same key, meant for the
      // control it was on, would land on the one focus was moved to: that control takes no Enter
      // or Space for a moment, as Play again does after an accepted Send.
      resolveFocusMove();
      focusMove = { from: doc.activeElement };
      view?.setTimeout(resolveFocusMove, 0);
      return;
    }
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
    // The gesture runs from the press's RELEASE: its click is when what it does moves the
    // layout, so a press held down a long time keeps the whole window after it.
    if (ofDown && last !== null) last = { ...last, at: event.timeStamp };
    const control = controlOf(event.target);
    if (control !== null && target !== null && control !== target && !control.contains(target)) {
      forwardTo = control;
    }
  };

  /** The end of a click's dispatch, at the window's bubble phase: every handler of a keyboard
   *  activation has run, so the focus move it made is known now, before any later task (a
   *  script's `focus()` among them) can move focus again. */
  const onClickEnd = (): void => resolveFocusMove();

  const onKeyDown = (event: KeyboardEvent): void => {
    resolveFocusMove();
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // A control focus has just been moved to, button or not (a radio takes Space).
    if (
      keyHold !== null &&
      event.target === keyHold.el &&
      (view?.performance.now() ?? 0) < keyHold.until
    ) {
      heldKey = event.key;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // A fresh press: a release lost to focus leaving mid-press is not this one's to swallow.
    if (!event.repeat) heldKey = null;
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
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (heldKey === null || event.key !== heldKey) return;
    heldKey = null;
    // Space activates a button on its release: that of a held press is held too.
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointerup', onPointerUp, true);
  doc.addEventListener('pointercancel', onPointerUp, true);
  doc.addEventListener('mousedown', onMouseDown, true);
  doc.addEventListener('click', onClick, true);
  view?.addEventListener('click', onClickEnd);
  root.addEventListener('keydown', onKeyDown, true);
  root.addEventListener('keyup', onKeyUp, true);
  return {
    arm: (): void => {
      arrivals++;
      const now = view?.performance.now() ?? 0;
      // A press still down as the dialog arrives is never stale, however long it was held; one
      // let go is stale 2 s after its release, as a gesture is timed from its release.
      const spots: { readonly x: number; readonly y: number }[] = [];
      const during = new Set<number>();
      for (const [id, down] of downs) {
        if (down.up === null) during.add(id);
        else if (now - down.up >= PRESS_GUARD_REPEAT_MS) {
          downs.delete(id);
          continue;
        }
        spots.push(down);
      }
      arrival = spots.length > 0 ? { at: now, spots, during } : null;
    },
    holdKeys: (el: Element): void => {
      keyHold = { el, until: (view?.performance.now() ?? 0) + PRESS_GUARD_KEY_HOLD_MS };
    },
    remove: (): void => {
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('pointerup', onPointerUp, true);
      doc.removeEventListener('pointercancel', onPointerUp, true);
      doc.removeEventListener('mousedown', onMouseDown, true);
      doc.removeEventListener('click', onClick, true);
      view?.removeEventListener('click', onClickEnd);
      root.removeEventListener('keydown', onKeyDown, true);
      root.removeEventListener('keyup', onKeyUp, true);
    },
  };
}
