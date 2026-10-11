import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  guardPresses,
  PRESS_GUARD_KEY_HOLD_MS,
  PRESS_GUARD_REPEAT_MS,
  PRESS_GUARD_SLOP_PX,
  PRESS_GUARD_TOUCH_SLOP_PX,
  PRESS_GUARD_WINDOW_MS,
} from './press-guard';

// press-guard.test.ts — the rules of `press-guard.ts` (#181 H2): a pointer press is held only
// where the layout moved under a pointer that stayed put — in the gesture of the last press that
// passed (its window, or an OS-counted repeat), within the slop of its spot, on a different
// control, after that press's element moved or the dialog arrived. One test per condition, plus
// the keyboard's. jsdom has no layout: an element "moves" here by a stubbed box, an attribute or
// a style. The results panel's wiring is `overlay.test.ts`'s; the panel under a real pointer is
// `results-pointer.spec.ts`'s.

const teardown: (() => void)[] = [];
afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
  vi.restoreAllMocks();
});

/** A guarded root (buttons A and B, a label-wrapped radio, a paragraph) with a control and a
 *  board outside it: returns them, the clicks that land, and helpers that press, click, shift
 *  and key them. */
function fixture() {
  const root = document.createElement('div');
  const a = document.createElement('button');
  a.textContent = 'A';
  const b = document.createElement('button');
  b.textContent = 'B';
  // A radio wrapped in its label, as the survey builds its options.
  const label = document.createElement('label');
  const radio = document.createElement('input');
  radio.type = 'radio';
  const text = document.createElement('span');
  text.textContent = '1';
  label.append(radio, text);
  const plain = document.createElement('p');
  root.append(a, b, label, plain);
  // Outside the guarded root, as the board and the Dock are: a control and a plain surface.
  const outside = document.createElement('button');
  const board = document.createElement('div');
  document.body.append(root, outside, board);
  const pressed: string[] = [];
  a.addEventListener('click', () => pressed.push('A'));
  b.addEventListener('click', () => pressed.push('B'));
  outside.addEventListener('click', () => pressed.push('outside'));
  const guard = guardPresses(root);
  teardown.push(() => {
    guard.remove();
    root.remove();
    outside.remove();
    board.remove();
  });
  const stamped = <E extends Event>(event: E, at: number): E => {
    Object.defineProperty(event, 'timeStamp', { value: at });
    return event;
  };
  /** A pointer press as the browser delivers it — `pointerdown`, `mousedown`, `click` — at one
   *  time and spot. `detail` is the OS's click count. */
  const press = (
    el: Element,
    at: number,
    spot: { x?: number; y?: number } = {},
    detail = 1,
    pointerType = 'mouse',
  ) => {
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: spot.x ?? 100,
      clientY: spot.y ?? 100,
    };
    const pointer = stamped(new MouseEvent('pointerdown', { ...init, detail: 0 }), at);
    Object.defineProperty(pointer, 'pointerType', { value: pointerType });
    el.dispatchEvent(pointer);
    const down = stamped(new MouseEvent('mousedown', { ...init, detail }), at);
    el.dispatchEvent(down);
    el.dispatchEvent(stamped(new MouseEvent('pointerup', { ...init, detail: 0 }), at));
    const click = stamped(new MouseEvent('click', { ...init, detail }), at);
    el.dispatchEvent(click);
    return { down, click };
  };
  /** A click with no `mousedown` of its own: a keyboard activation (`detail` 0, as a script's
   *  `click()`), or an assistive technology's pointer-like one (`detail` 1). */
  const clickOnly = (
    el: Element,
    at: number,
    spot: { x?: number; y?: number } = {},
    detail = 0,
  ) => {
    const click = stamped(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        detail,
        clientX: spot.x ?? 100,
        clientY: spot.y ?? 100,
      }),
      at,
    );
    el.dispatchEvent(click);
    return click;
  };
  /** The layout moves under the pointer: `el` now stands `dy` px lower. */
  const shift = (el: Element, dy = 40): void => {
    const box = el.getBoundingClientRect();
    el.getBoundingClientRect = () => new DOMRect(box.x, box.y + dy, box.width, box.height);
  };
  /** Enter or Space pressed and released on `el`. */
  const key = (el: Element, k: 'Enter' | ' ' | 'a', repeat = false) => {
    const down = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, repeat });
    el.dispatchEvent(down);
    const up = new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(up);
    return { down, up };
  };
  return {
    ...{ root, a, b, label, radio, text, plain, outside, board },
    ...{ pressed, guard, press, clickOnly, shift, key },
  };
}

describe('press guard (#181 H2)', () => {
  it('holds a press only where the layout moved: at A’s spot right after A, B passes where nothing moved and is held where A moved', () => {
    const still = fixture();
    still.press(still.a, 1000);
    still.press(still.b, 1100);
    expect(still.pressed, 'nothing moved: the pointer moved on purpose').toEqual(['A', 'B']);
    const moved = fixture();
    moved.press(moved.a, 1000);
    moved.shift(moved.a);
    const second = moved.press(moved.b, 1100);
    expect(moved.pressed, 'A moved: B at its spot is swallowed').toEqual(['A']);
    expect(second.down.defaultPrevented, 'held at mousedown, so focus stays').toBe(true);
    expect(second.click.defaultPrevented, 'its click is swallowed').toBe(true);
  });

  it('the gesture’s window is 500 ms', () => {
    expect(PRESS_GUARD_WINDOW_MS).toBe(500);
    const h = fixture();
    h.press(h.a, 1000);
    h.shift(h.a);
    h.press(h.b, 1499);
    expect(h.pressed, '499 ms after A: held').toEqual(['A']);
    h.press(h.b, 1500);
    expect(h.pressed, 'at 500 ms the window has closed').toEqual(['A', 'B']);
  });

  it('a press the OS counts as a repeat (detail above 1) belongs to the gesture for 2 s: a slowed double-click', () => {
    expect(PRESS_GUARD_REPEAT_MS).toBe(2000);
    const slow = fixture();
    slow.press(slow.a, 0);
    slow.shift(slow.a);
    slow.press(slow.b, 750, {}, 2);
    expect(slow.pressed, 'the OS-counted second press at 750 ms: held').toEqual(['A']);
    slow.press(slow.b, 1999, {}, 2);
    expect(slow.pressed, 'and at 1999 ms').toEqual(['A']);
    slow.press(slow.b, 2000, {}, 2);
    expect(slow.pressed, 'the cap: at 2 s it passes').toEqual(['A', 'B']);
    const single = fixture();
    single.press(single.a, 0);
    single.shift(single.a);
    single.press(single.b, 750, {}, 1);
    expect(single.pressed, 'a fresh single press at 750 ms passes').toEqual(['A', 'B']);
  });

  it('a double-click’s second click (detail 2) is judged like any other press', () => {
    const h = fixture();
    h.press(h.a, 0, {}, 1);
    h.shift(h.a);
    const second = h.press(h.b, 120, {}, 2);
    expect(h.pressed, 'the second click of a double-click, landing on B, is swallowed').toEqual([
      'A',
    ]);
    expect(second.click.defaultPrevented).toBe(true);
  });

  it('the spot, for a mouse or a pen: within 24px, measured as a circle', () => {
    expect(PRESS_GUARD_SLOP_PX).toBe(24);
    const at = (dx: number, dy: number, pointerType = 'mouse'): string[] => {
      const h = fixture();
      h.press(h.a, 0, { x: 100, y: 100 }, 1, pointerType);
      h.shift(h.a);
      h.press(h.b, 50, { x: 100 + dx, y: 100 + dy }, 1, pointerType);
      return h.pressed;
    };
    expect(at(24, 0), 'within 24px: the same spot').toEqual(['A']);
    expect(at(24.5, 0), 'beyond it: a deliberate press').toEqual(['A', 'B']);
    expect(at(18, 18), '25.5px away on a diagonal is somewhere else').toEqual(['A', 'B']);
    expect(at(30, 0, 'pen'), 'a pen is held to the mouse’s spot').toEqual(['A', 'B']);
  });

  it('the spot for touch: within 48px, keyed on the pointerdown’s type or a coarse primary pointer', () => {
    expect(PRESS_GUARD_TOUCH_SLOP_PX).toBe(48);
    const at = (dx: number, dy: number, pointerType: string): string[] => {
      const h = fixture();
      h.press(h.a, 0, { x: 100, y: 100 }, 1, pointerType);
      h.shift(h.a);
      h.press(h.b, 50, { x: 100 + dx, y: 100 + dy }, 1, pointerType);
      return h.pressed;
    };
    expect(at(48, 0, 'touch'), 'a tap 48px off: the same spot').toEqual(['A']);
    expect(at(48.5, 0, 'touch'), 'beyond it').toEqual(['A', 'B']);
    expect(at(18, 18, 'touch'), 'a diagonal 25.5px drift is a finger’s').toEqual(['A']);
    // WebKit's tap clicks report `mouse`: a coarse primary pointer says touch.
    const view = document.defaultView!;
    const query = vi.fn((q: string) => ({ matches: q === '(pointer: coarse)' }));
    Object.defineProperty(view, 'matchMedia', { configurable: true, value: query });
    teardown.push(() => void Reflect.deleteProperty(view, 'matchMedia'));
    expect(at(30, 0, 'mouse'), 'on a coarse pointer, 30px is the same spot').toEqual(['A']);
    expect(query).toHaveBeenCalledWith('(pointer: coarse)');
  });

  it('what counts as the layout moving: the earlier press’s element shifted or resized beyond half a pixel, hidden, made invisible, or taken out', () => {
    const after = (move: (h: ReturnType<typeof fixture>) => void): string[] => {
      const h = fixture();
      h.press(h.a, 0);
      move(h);
      h.press(h.b, 100);
      return h.pressed;
    };
    expect(
      after((h) => h.shift(h.a, 0.4)),
      'a 0.4px shift: nothing moved',
    ).toEqual(['A', 'B']);
    expect(
      after((h) => h.shift(h.a, 0.6)),
      'a 0.6px shift',
    ).toEqual(['A']);
    expect(
      after((h) => (h.a.getBoundingClientRect = () => new DOMRect(0, 0, 0, 30))),
      'resized',
    ).toEqual(['A']);
    expect(
      after((h) => (h.a.getBoundingClientRect = () => new DOMRect(0, 0, 30, 0))),
      'resized across',
    ).toEqual(['A']);
    expect(
      after((h) => (h.a.getBoundingClientRect = () => new DOMRect(20, 0, 0, 0))),
      'moved across',
    ).toEqual(['A']);
    expect(
      after((h) => (h.a.hidden = true)),
      'hidden',
    ).toEqual(['A']);
    expect(
      after((h) => (h.a.style.visibility = 'hidden')),
      'made invisible',
    ).toEqual(['A']);
    expect(
      after((h) => h.a.remove()),
      'taken out of the document',
    ).toEqual(['A']);
  });

  it('the dialog’s arrival counts as the layout moving: a press on the board before it, then one on a control here, is held', () => {
    const h = fixture();
    h.press(h.board, 1000);
    h.guard.arm();
    h.press(h.a, 1100, {}, 2);
    expect(h.pressed, 'the second click of a board double-click lands on the new dialog').toEqual(
      [],
    );
    const still = fixture();
    still.press(still.board, 1000);
    still.press(still.a, 1100, {}, 2);
    expect(still.pressed, 'without the arrival nothing moved, and the press passes').toEqual(['A']);
  });

  it('a press is held only where it lands on a control inside the guarded root', () => {
    const h = fixture();
    h.press(h.a, 0);
    h.shift(h.a);
    h.press(h.outside, 100);
    expect(h.pressed, 'a control outside: the board’s and the Dock’s are not the panel’s').toEqual([
      'A',
      'outside',
    ]);
    const plain = fixture();
    plain.press(plain.a, 0);
    plain.shift(plain.a);
    const onNothing = plain.press(plain.plain, 100);
    expect(onNothing.down.defaultPrevented, 'no control here: nothing to hold').toBe(false);
  });

  it('an event aimed at no element (a script’s, at the document) is ignored, and moves no reference', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = fixture();
    h.press(h.a, 0);
    h.shift(h.a);
    document.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: 400 }),
    );
    h.press(h.b, 100);
    expect(h.pressed, 'B at A’s spot is still measured from A’s press').toEqual(['A']);
    expect(error, 'and nothing went wrong judging it').not.toHaveBeenCalled();
  });

  it('a held press stays held to its release, however long the button is held down', () => {
    const h = fixture();
    h.press(h.a, 0);
    h.shift(h.a);
    const init = { bubbles: true, cancelable: true, detail: 1, clientX: 100, clientY: 100 };
    const down = new MouseEvent('mousedown', init);
    Object.defineProperty(down, 'timeStamp', { value: 100 });
    h.b.dispatchEvent(down);
    expect(down.defaultPrevented, 'held as it is pressed').toBe(true);
    // Released 700 ms later: past the window, and a single click by the system's count.
    const click = new MouseEvent('click', init);
    Object.defineProperty(click, 'timeStamp', { value: 700 });
    h.b.dispatchEvent(click);
    expect(click.defaultPrevented, 'and its click is still swallowed').toBe(true);
    expect(h.pressed).toEqual(['A']);
  });

  it('a held press released elsewhere: its click, on the element both share, keeps the held verdict and moves no reference', () => {
    const h = fixture();
    h.press(h.a, 0);
    h.shift(h.a);
    const init = { bubbles: true, cancelable: true, detail: 1, clientX: 100, clientY: 100 };
    const down = new MouseEvent('mousedown', init);
    Object.defineProperty(down, 'timeStamp', { value: 100 });
    h.b.dispatchEvent(down);
    expect(down.defaultPrevented, 'B, at A’s spot after A moved, is held').toBe(true);
    // Released over the panel's background: the browser fires the click on the element that
    // holds both the press and the release.
    const click = new MouseEvent('click', { ...init, clientX: 400 });
    Object.defineProperty(click, 'timeStamp', { value: 150 });
    h.root.dispatchEvent(click);
    expect(click.defaultPrevented, 'its click goes with it').toBe(true);
    h.press(h.b, 200);
    expect(h.pressed, 'B at A’s spot is still measured from A’s press').toEqual(['A']);
  });

  it('a triple-click’s third press is held like its second: a held press is never the reference', () => {
    const h = fixture();
    h.press(h.a, 0, {}, 1);
    h.shift(h.a);
    h.press(h.b, 120, {}, 2);
    h.press(h.b, 240, {}, 3);
    expect(h.pressed, 'both later presses land on B, which moved under the pointer').toEqual(['A']);
  });

  it('a repeat on the same control passes, and is the next press’s reference', () => {
    const h = fixture();
    h.press(h.a, 0);
    h.press(h.a, 300);
    expect(h.pressed, 'a double-click on one control is that control’s').toEqual(['A', 'A']);
    h.shift(h.a);
    h.press(h.b, 700);
    expect(h.pressed, '400 ms after the repeat, B at its spot is held').toEqual(['A', 'A']);
    h.press(h.a, 750);
    expect(h.pressed, 'and A, though it moved, is still the control under the pointer').toEqual([
      'A',
      'A',
      'A',
    ]);
  });

  it('a press with another button activates nothing here and is no one’s reference', () => {
    const h = fixture();
    const rightPress = (el: Element, at: number, x: number) => {
      const init = { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: 100 };
      const pointer = new MouseEvent('pointerdown', init);
      Object.defineProperty(pointer, 'timeStamp', { value: at });
      el.dispatchEvent(pointer);
      const down = new MouseEvent('mousedown', { ...init, detail: 1 });
      Object.defineProperty(down, 'timeStamp', { value: at });
      el.dispatchEvent(down);
      return down;
    };
    h.press(h.a, 0, { x: 100 });
    h.shift(h.a);
    expect(rightPress(h.b, 50, 100).defaultPrevented, 'a context press is never held').toBe(false);
    rightPress(h.b, 60, 300);
    h.press(h.b, 100, { x: 100 });
    expect(h.pressed, 'B at A’s spot is still measured from A’s press').toEqual(['A']);
  });

  it('every press that passes is the one the next is measured from, a repeat included', () => {
    // Run data's toggle opened at one spot, then, after a scroll, pressed again lower down: a
    // quick press after that one is held to the toggle where it was pressed this time.
    const later = fixture();
    later.press(later.a, 0, { x: 100, y: 100 });
    later.press(later.a, 1000, { x: 100, y: 300 });
    later.shift(later.a);
    later.press(later.b, 1100, { x: 100, y: 300 });
    expect(later.pressed, 'B at the repeat’s spot, 100 ms after it, is held').toEqual(['A', 'A']);
    const quick = fixture();
    quick.press(quick.a, 0, { x: 100, y: 100 });
    quick.press(quick.a, 100, { x: 100, y: 300 });
    quick.shift(quick.a);
    quick.press(quick.b, 200, { x: 100, y: 300 });
    expect(quick.pressed, 'measured from the repeat’s spot, not the first press’s').toEqual([
      'A',
      'A',
    ]);
    quick.press(quick.b, 250, { x: 100, y: 100 });
    expect(quick.pressed, 'the first press’s spot no longer holds anything').toEqual([
      'A',
      'A',
      'B',
    ]);
  });

  it('a held press changes nothing: it neither restarts the window nor moves the spot', () => {
    const h = fixture();
    h.press(h.a, 0);
    h.shift(h.a);
    h.press(h.b, 300); // held
    h.press(h.b, 499); // still measured from A's press: held again
    expect(h.pressed).toEqual(['A']);
    h.press(h.b, 500);
    expect(h.pressed).toEqual(['A', 'B']);
  });

  it('a keyboard activation is never held, and is never a reference', () => {
    const h = fixture();
    h.press(h.a, 0);
    h.shift(h.a);
    h.clickOnly(h.b, 100, {}, 0);
    expect(h.pressed, 'Enter or Space on B, right after a pointer press on A').toEqual(['A', 'B']);
    const k = fixture();
    k.clickOnly(k.a, 0, {}, 0);
    k.shift(k.a);
    k.press(k.b, 100);
    expect(k.pressed, 'a pointer press right after a keyboard activation').toEqual(['A', 'B']);
  });

  it('a click with no mousedown of its own (an assistive technology’s) is judged at the click', () => {
    const h = fixture();
    h.press(h.a, 0);
    h.shift(h.a);
    const click = h.clickOnly(h.b, 100, {}, 1);
    expect(h.pressed).toEqual(['A']);
    expect(click.defaultPrevented).toBe(true);
  });

  it('a held press runs no default action: no label forwards, no radio checks', () => {
    const h = fixture();
    h.press(h.a, 0);
    h.shift(h.a);
    h.press(h.text, 100); // the option's text, inside its label
    expect(h.radio.checked, 'the label forwarded nothing').toBe(false);
    h.press(h.radio, 150);
    expect(h.radio.checked, 'the radio did not check').toBe(false);
  });

  it('a press on a label and the click it forwards are one press on the labelled control', () => {
    const h = fixture();
    h.press(h.text, 0);
    expect(h.radio.checked, 'the label forwarded its press').toBe(true);
    h.radio.checked = false;
    h.press(h.radio, 100); // the same control: passes
    expect(h.radio.checked).toBe(true);
    h.shift(h.radio);
    h.press(h.a, 200);
    expect(h.pressed, 'A at the same spot, after the radio moved').toEqual([]);
  });

  it('the click a label forwards is part of its press, and never moves the spot', () => {
    // jsdom forwards a label's click from (0, 0) with `detail` 1, as a browser might.
    const h = fixture();
    h.press(h.text, 0, { x: 100, y: 100 }); // an option's text: its label forwards to the radio
    expect(h.radio.checked, 'the label forwarded its press').toBe(true);
    h.shift(h.radio);
    h.press(h.a, 100, { x: 100, y: 100 });
    expect(h.pressed, 'A at the option’s spot, 100 ms later, is held').toEqual([]);
  });

  it('a press on a control’s own content is that control’s press: the next press on the control itself is judged, and measured from', () => {
    // Run data's toggle holds its text in a span. Opened by a press on the text, then pressed on
    // its edge after a scroll: a quick press after THAT one is held to the toggle. Were the text
    // press taken for a label's, the edge press would pass unjudged as its "forward" and leave
    // the reference behind: the presses here are clicks with no `mousedown` of their own, judged
    // at the click, as an assistive technology delivers them.
    const h = fixture();
    const content = document.createElement('span');
    content.textContent = 'A';
    h.a.append(content);
    h.clickOnly(content, 0, { x: 100, y: 100 }, 1);
    h.clickOnly(h.a, 1000, { x: 100, y: 300 }, 1);
    h.shift(h.a);
    h.clickOnly(h.b, 1100, { x: 100, y: 300 }, 1);
    expect(h.pressed, 'B at the edge press’s spot, 100 ms after it, is held').toEqual(['A', 'A']);
  });

  it('removes itself', () => {
    const h = fixture();
    h.guard.remove();
    h.press(h.a, 0);
    h.shift(h.a);
    h.press(h.b, 100);
    expect(h.pressed).toEqual(['A', 'B']);
    expect(h.key(h.a, 'Enter', true).down.defaultPrevented).toBe(false);
  });
});

describe('press guard — the keyboard (#181 H2)', () => {
  it('an auto-repeated Enter or Space on a panel button activates nothing; its first press does', () => {
    const h = fixture();
    expect(h.key(h.a, 'Enter').down.defaultPrevented, 'a press').toBe(false);
    expect(h.key(h.a, 'Enter', true).down.defaultPrevented, 'an auto-repeat').toBe(true);
    const space = h.key(h.a, ' ', true);
    expect(space.down.defaultPrevented, 'Space, repeated').toBe(true);
    expect(space.up.defaultPrevented, 'and its own release still activates, once').toBe(false);
    expect(h.key(h.a, 'a', true).down.defaultPrevented, 'another key').toBe(false);
    expect(h.key(h.radio, ' ', true).down.defaultPrevented, 'not a button').toBe(false);
    expect(h.key(h.outside, 'Enter', true).down.defaultPrevented, 'not the panel’s').toBe(false);
  });

  it('a control that focus has just been moved to takes no Enter or Space for 500 ms', () => {
    expect(PRESS_GUARD_KEY_HOLD_MS).toBe(500);
    const h = fixture();
    const now = vi.spyOn(document.defaultView!.performance, 'now').mockReturnValue(1000);
    h.guard.holdKeys(h.a);
    now.mockReturnValue(1499);
    const enter = h.key(h.a, 'Enter');
    expect(enter.down.defaultPrevented, 'Enter, 499 ms after focus moved').toBe(true);
    expect(enter.up.defaultPrevented).toBe(true);
    const space = h.key(h.a, ' ');
    expect(space.down.defaultPrevented, 'Space').toBe(true);
    expect(space.up.defaultPrevented, 'and its release, which a button activates on').toBe(true);
    expect(h.key(h.b, 'Enter').down.defaultPrevented, 'another control').toBe(false);
    now.mockReturnValue(1500);
    expect(h.key(h.a, 'Enter').down.defaultPrevented, 'at 500 ms').toBe(false);
  });
});

describe('press guard — QC round 4 (#181 H2)', () => {
  const stamped = <E extends Event>(event: E, at: number): E => {
    Object.defineProperty(event, 'timeStamp', { value: at });
    return event;
  };
  /** The three events of a press, each at its own time: a held press's click comes at its release,
   *  and a tap's `mousedown` and `click` both do. */
  const raw = (
    el: Element,
    at: { pointer: number; down: number; click: number },
    detail = 1,
    pointerType = 'mouse',
  ) => {
    const init = { bubbles: true, cancelable: true, clientX: 100, clientY: 100 };
    const pointer = stamped(new MouseEvent('pointerdown', { ...init, detail: 0 }), at.pointer);
    Object.defineProperty(pointer, 'pointerType', { value: pointerType });
    el.dispatchEvent(pointer);
    el.dispatchEvent(stamped(new MouseEvent('mousedown', { ...init, detail }), at.down));
    el.dispatchEvent(stamped(new MouseEvent('pointerup', { ...init, detail: 0 }), at.click));
    el.dispatchEvent(stamped(new MouseEvent('click', { ...init, detail }), at.click));
  };
  const nowIs = (ms: number) =>
    vi.spyOn(document.defaultView!.performance, 'now').mockReturnValue(ms);

  it('A: the gesture is timed from a press’s release, so a press held 450–550 ms keeps the whole window', () => {
    for (const heldFor of [450, 500, 550]) {
      const h = fixture();
      raw(h.a, { pointer: 0, down: 0, click: heldFor });
      h.shift(h.a);
      h.press(h.b, heldFor + 150);
      expect(h.pressed, `held ${heldFor} ms, then a press 150 ms after its release`).toEqual(['A']);
    }
    const h = fixture();
    raw(h.a, { pointer: 0, down: 0, click: 550 });
    h.shift(h.a);
    h.press(h.b, 550 + PRESS_GUARD_WINDOW_MS);
    expect(h.pressed, 'the window closes 500 ms after the release').toEqual(['A', 'B']);
  });

  it('A: a held press does not restart the window', () => {
    const h = fixture();
    raw(h.a, { pointer: 0, down: 0, click: 100 });
    h.shift(h.a);
    h.press(h.b, 200);
    h.press(h.b, 600);
    expect(
      h.pressed,
      'the held press at 200 ms restarts nothing: 600 ms is past A’s window',
    ).toEqual(['A', 'B']);
  });

  it('B: a tap on the board as the dialog arrives, then a second tap on a panel control, is held', () => {
    const h = fixture();
    nowIs(20);
    const tap = stamped(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }),
      0,
    );
    Object.defineProperty(tap, 'pointerType', { value: 'touch' });
    h.board.dispatchEvent(tap); // no mousedown or click: the dialog arrived over it
    h.guard.arm();
    raw(h.b, { pointer: 180, down: 260, click: 260 }, 2, 'touch');
    expect(h.pressed).toEqual([]);
  });

  it('B: two single clicks at one spot, the dialog arriving 80 ms before the second, hold the second', () => {
    const h = fixture();
    raw(h.board, { pointer: 0, down: 0, click: 90 });
    nowIs(570);
    h.guard.arm();
    raw(h.b, { pointer: 650, down: 650, click: 650 });
    expect(h.pressed).toEqual([]);
  });

  it('B: a deliberate press 600 ms after the arrival, a press far from the spot, and one after a stale press all pass', () => {
    const late = fixture();
    raw(late.board, { pointer: 0, down: 0, click: 90 });
    nowIs(100);
    late.guard.arm();
    raw(late.b, { pointer: 700, down: 700, click: 700 });
    expect(late.pressed, '600 ms after the arrival').toEqual(['B']);
    const far = fixture();
    raw(far.board, { pointer: 0, down: 0, click: 90 });
    nowIs(100);
    far.guard.arm();
    far.press(far.b, 200, { x: 160, y: 100 });
    expect(far.pressed, '60px from the spot').toEqual(['B']);
    const stale = fixture();
    raw(stale.board, { pointer: 0, down: 0, click: 90 });
    nowIs(PRESS_GUARD_REPEAT_MS + 100);
    stale.guard.arm();
    stale.press(stale.b, PRESS_GUARD_REPEAT_MS + 150);
    expect(stale.pressed, 'a press over 2 s old is no one’s').toEqual(['B']);
  });

  /** A touch's own `pointerdown` or `pointerup` on `el`, with no mouse events: a tap the dialog
   *  arrived during, whose `mousedown` and `click` never come. */
  const touchAt = (el: Element, type: 'pointerdown' | 'pointerup', at: number): void => {
    const e = stamped(new MouseEvent(type, { bubbles: true, clientX: 100, clientY: 100 }), at);
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    Object.defineProperty(e, 'pointerId', { value: 7 });
    el.dispatchEvent(e);
  };

  it('B (QC round 5): a tap the dialog arrived during, held 550 ms: the arrival is timed from its release', () => {
    const h = fixture();
    touchAt(h.board, 'pointerdown', 0);
    nowIs(20);
    h.guard.arm();
    touchAt(h.board, 'pointerup', 550);
    raw(h.b, { pointer: 685, down: 775, click: 775 }, 1, 'touch');
    expect(h.pressed, 'a second tap 135 ms after the release').toEqual([]);
    raw(h.b, { pointer: 1100, down: 1190, click: 1190 }, 1, 'touch');
    expect(h.pressed, '640 ms after the release, a single tap passes').toEqual(['B']);
  });

  it('B (QC round 5): taps the system counts as repeats belong to the arrival for 2 s', () => {
    const h = fixture();
    touchAt(h.board, 'pointerdown', 0);
    nowIs(70);
    h.guard.arm();
    touchAt(h.board, 'pointerup', 90);
    raw(h.b, { pointer: 380, down: 530, click: 530 }, 2, 'touch');
    raw(h.b, { pointer: 740, down: 870, click: 870 }, 3, 'touch');
    expect(h.pressed, 'a third tap 780 ms after the release').toEqual([]);
    raw(h.b, { pointer: 2000, down: 2090, click: 2090 }, 4, 'touch');
    expect(h.pressed, 'past 2 s it passes').toEqual(['B']);
  });

  it('B (QC round 5): a touch still down as the dialog arrives is never stale', () => {
    const h = fixture();
    touchAt(h.board, 'pointerdown', 0);
    nowIs(2100);
    h.guard.arm();
    touchAt(h.board, 'pointerup', 2300);
    raw(h.b, { pointer: 2435, down: 2525, click: 2525 }, 1, 'touch');
    expect(h.pressed).toEqual([]);
  });

  it('D: a keyboard activation that moves focus to another panel control gives it a 500 ms key hold', async () => {
    const h = fixture();
    const now = nowIs(1000);
    h.a.addEventListener('click', () => h.b.focus());
    h.a.focus();
    h.clickOnly(h.a, 1000); // Enter on A: focus moves to B
    await new Promise((resolve) => setTimeout(resolve, 0));
    now.mockReturnValue(1499);
    const enter = h.key(h.b, 'Enter');
    expect(enter.down.defaultPrevented, 'Enter on B, 499 ms on').toBe(true);
    expect(enter.up.defaultPrevented).toBe(true);
    now.mockReturnValue(1500);
    expect(h.key(h.b, 'Enter').down.defaultPrevented, 'at 500 ms').toBe(false);
  });

  it('D: the hold covers a radio, which takes Space, and not a keyboard activation that moves focus nowhere', async () => {
    const h = fixture();
    const now = nowIs(1000);
    h.a.addEventListener('click', () => h.radio.focus());
    h.a.focus();
    h.clickOnly(h.a, 1000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    now.mockReturnValue(1100);
    expect(h.key(h.radio, ' ').down.defaultPrevented, 'Space on the radio').toBe(true);
    const still = fixture();
    nowIs(2000);
    still.b.focus();
    still.clickOnly(still.b, 2000); // focus stays on B
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(still.key(still.b, 'Enter').down.defaultPrevented, 'focus stayed: no hold').toBe(false);
  });
});

describe('press guard — QC round 5 (#181 H2)', () => {
  const nowIs = (ms: number) =>
    vi.spyOn(document.defaultView!.performance, 'now').mockReturnValue(ms);

  /** A press on the board at 0 (released at 0), the dialog arriving at `arriveAt`, then a press on
   *  B at `pressAt`, `dx` px right of the board press: what was activated. The second press is
   *  past the board press's own window (a single click), so only the arrival can hold it. */
  function afterArrival(
    arriveAt: number,
    pressAt: number,
    dx = 0,
    pointerType = 'mouse',
  ): string[] {
    const h = fixture();
    h.press(h.board, 0, {}, 1, pointerType);
    nowIs(arriveAt);
    h.guard.arm();
    h.press(h.b, pressAt, { x: 100 + dx }, 1, pointerType);
    return h.pressed;
  }

  it('the arrival window is 500 ms from the arrival: held at 499, passes at 500', () => {
    expect(afterArrival(1000, 1499), '499 ms after the arrival').toEqual([]);
    expect(afterArrival(1000, 1500), 'at 500 ms').toEqual(['B']);
  });

  it('a press 2 s old as the dialog arrives is stale', () => {
    expect(
      afterArrival(PRESS_GUARD_REPEAT_MS - 1, PRESS_GUARD_REPEAT_MS + 50),
      '1999 ms old',
    ).toEqual([]);
    expect(afterArrival(PRESS_GUARD_REPEAT_MS, PRESS_GUARD_REPEAT_MS + 50), '2000 ms old').toEqual([
      'B',
    ]);
  });

  it('the arrival’s spot is the pointer’s slop: 24px for a mouse, 48px for touch', () => {
    expect(afterArrival(1000, 1100, PRESS_GUARD_SLOP_PX), 'a mouse, 24px off').toEqual([]);
    expect(afterArrival(1000, 1100, 30), 'a mouse, 30px off: somewhere else').toEqual(['B']);
    expect(afterArrival(1000, 1100, PRESS_GUARD_TOUCH_SLOP_PX, 'touch'), 'touch, 48px off').toEqual(
      [],
    );
    expect(afterArrival(1000, 1100, 48.5, 'touch'), 'touch, 48.5px off').toEqual(['B']);
  });

  it('the arrival holds only a press on a control in the panel', () => {
    const h = fixture();
    h.press(h.board, 0);
    nowIs(1000);
    h.guard.arm();
    h.press(h.outside, 1100);
    expect(h.pressed, 'a control outside the panel').toEqual(['outside']);
    expect(h.press(h.board, 1150).down.defaultPrevented, 'no control at all').toBe(false);
  });

  it('a keyboard activation that moves focus out of the panel leaves a hold inside it alone', async () => {
    const h = fixture();
    const now = nowIs(1000);
    h.guard.holdKeys(h.a);
    h.b.addEventListener('click', () => h.outside.focus());
    h.b.focus();
    h.clickOnly(h.b, 1000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement, 'focus left the panel').toBe(h.outside);
    now.mockReturnValue(1200);
    expect(h.key(h.a, 'Enter').down.defaultPrevented, 'A keeps its hold').toBe(true);
  });

  it('a second key before the focus-move check has run is held: input can beat the timer', () => {
    vi.useFakeTimers();
    try {
      const h = fixture();
      const now = nowIs(1000);
      h.a.addEventListener('click', () => h.b.focus());
      h.a.focus();
      h.clickOnly(h.a, 1000); // Enter on A: focus moves to B; the zero-delay check is still queued
      now.mockReturnValue(1060);
      expect(h.key(h.b, ' ').down.defaultPrevented, 'Space on B, before the timer').toBe(true);
      vi.runAllTimers();
      now.mockReturnValue(1100);
      expect(h.key(h.b, 'Enter').down.defaultPrevented, 'and after it').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a held key whose release was lost does not swallow the next Space release', () => {
    const h = fixture();
    const now = nowIs(1000);
    h.guard.holdKeys(h.a);
    // Space pressed on A is held; its keyup never comes (focus left the window mid-press).
    h.a.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    now.mockReturnValue(1600);
    const space = h.key(h.b, ' ');
    expect(space.down.defaultPrevented, 'a fresh Space on B').toBe(false);
    expect(space.up.defaultPrevented, 'its release activates').toBe(false);
  });
});

describe('press guard — QC round 6 (#181 H2)', () => {
  const stamped = <E extends Event>(event: E, at: number): E => {
    Object.defineProperty(event, 'timeStamp', { value: at });
    return event;
  };
  const nowIs = (ms: number) =>
    vi.spyOn(document.defaultView!.performance, 'now').mockReturnValue(ms);
  /** A pointer event of a touch (`id`) on `el`, with no mouse events. */
  const touchAt = (
    el: Element,
    type: 'pointerdown' | 'pointerup' | 'pointercancel',
    at: number,
    id = 7,
    x = 100,
  ): void => {
    const e = stamped(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 100 }), at);
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    Object.defineProperty(e, 'pointerId', { value: id });
    el.dispatchEvent(e);
  };
  /** A tap's mouse events, at its release. */
  const tap = (el: Element, at: number, detail = 1): void => {
    const init = { bubbles: true, cancelable: true, clientX: 100, clientY: 100, detail };
    el.dispatchEvent(stamped(new MouseEvent('mousedown', init), at));
    el.dispatchEvent(stamped(new MouseEvent('click', init), at));
  };

  // Kill tests for round 5's untested lines.
  it('K1: a touch the dialog arrived during, CANCELLED: the arrival is timed from the cancel', () => {
    const h = fixture();
    touchAt(h.board, 'pointerdown', 0);
    nowIs(20);
    h.guard.arm();
    touchAt(h.board, 'pointercancel', 550);
    touchAt(h.b, 'pointerdown', 685, 8);
    tap(h.b, 775);
    expect(h.pressed, 'a tap 225 ms after the cancel').toEqual([]);
  });

  it('K2: a double-tap whose second tap is slow (detail 2, 600 ms after the first’s release) belongs to the arrival', () => {
    const h = fixture();
    touchAt(h.board, 'pointerdown', 0);
    nowIs(20);
    h.guard.arm();
    touchAt(h.board, 'pointerup', 90);
    touchAt(h.b, 'pointerdown', 380, 8);
    tap(h.b, 690, 2);
    expect(h.pressed).toEqual([]);
  });

  it('K3: another finger’s release does not time the arrival: the held touch’s own release does', () => {
    const h = fixture();
    touchAt(h.board, 'pointerdown', 0, 7);
    nowIs(20);
    h.guard.arm();
    touchAt(h.board, 'pointerdown', 150, 8, 300); // a second finger, elsewhere
    touchAt(h.board, 'pointerup', 200, 8, 300);
    touchAt(h.board, 'pointerup', 900, 7);
    touchAt(h.b, 'pointerdown', 1035, 9);
    tap(h.b, 1125);
    expect(h.pressed, '225 ms after the held touch’s release').toEqual([]);
  });

  it('K4: another finger’s release does not mark the last one released: still down at the arrival, it is never stale', () => {
    const h = fixture();
    touchAt(h.board, 'pointerdown', 0, 7, 300);
    touchAt(h.board, 'pointerdown', 100, 8);
    touchAt(h.board, 'pointerup', 200, 7, 300);
    nowIs(2300); // finger 8 still down, 2.2 s on
    h.guard.arm();
    touchAt(h.board, 'pointerup', 2400, 8);
    touchAt(h.b, 'pointerdown', 2535, 9);
    tap(h.b, 2625);
    expect(h.pressed).toEqual([]);
  });

  // Reproductions (fail on bc4158a).
  it('R-H6: a long touch let go 600 ms before the arrival still marks the spot: staleness runs from the release', () => {
    const h = fixture();
    touchAt(h.board, 'pointerdown', 0);
    touchAt(h.board, 'pointerup', 1500);
    nowIs(2100);
    h.guard.arm();
    touchAt(h.b, 'pointerdown', 2150, 8);
    tap(h.b, 2235);
    expect(h.pressed, 'a tap 135 ms after the arrival').toEqual([]);
  });

  it('R-H5: a repeat on the same control of a press let through after the arrival passes: a double-click on Run data opens and closes it', () => {
    const h = fixture();
    h.press(h.board, 0);
    nowIs(20);
    h.guard.arm();
    h.press(h.b, 650);
    h.press(h.b, 800, {}, 2);
    expect(h.pressed).toEqual(['B', 'B']);
  });

  it('R-FLAKE: a scripted focus after a keyboard activation, before its check has run, is not taken for the activation’s move', () => {
    vi.useFakeTimers();
    try {
      const h = fixture();
      nowIs(1000);
      h.a.focus();
      h.clickOnly(h.a, 1000); // Enter on A: its handlers move focus nowhere
      h.b.focus(); // a script moves focus, before the zero-delay check has run
      expect(h.key(h.b, 'Enter').down.defaultPrevented, 'Enter on B').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('R-H2a: two fingers down across the arrival each keep their own spot', () => {
    const h = fixture();
    touchAt(h.board, 'pointerdown', 0, 7); // A, on the spot
    touchAt(h.board, 'pointerdown', 120, 8, 300); // B, 200px away
    nowIs(273);
    h.guard.arm();
    touchAt(h.board, 'pointerup', 538, 7);
    touchAt(h.board, 'pointerup', 662, 8, 300);
    touchAt(h.b, 'pointerdown', 822, 9);
    tap(h.b, 936);
    expect(h.pressed, 'a tap at A 274 ms after the last release').toEqual([]);
  });

  it('R-H2b: alternating taps at two spots each keep their own spot', () => {
    const h = fixture();
    touchAt(h.board, 'pointerdown', 0, 7);
    touchAt(h.board, 'pointerup', 117, 7);
    touchAt(h.board, 'pointerdown', 302, 8, 300);
    nowIs(379);
    h.guard.arm();
    touchAt(h.board, 'pointerup', 417, 8, 300);
    touchAt(h.b, 'pointerdown', 605, 9);
    tap(h.b, 715);
    expect(h.pressed, 'a tap back at the first spot').toEqual([]);
  });
});

// Helpers of the round 7 describes below: pointer events alone, and whole mouse presses.
/** `event`, with its `timeStamp` set to `at`. */
const stampedAt = <E extends Event>(event: E, at: number): E => {
  Object.defineProperty(event, 'timeStamp', { value: at });
  return event;
};
/** Pins `performance.now()` at `ms`. */
const setNow = (ms: number) =>
  vi.spyOn(document.defaultView!.performance, 'now').mockReturnValue(ms);
/** A pointer event alone (no mouse events), of `type` pointer `id`, at x (y 100). */
const ptr = (
  el: Element,
  type: 'pointerdown' | 'pointerup' | 'pointercancel',
  at: number,
  id: number,
  x = 100,
  ptype = 'touch',
): void => {
  const e = stampedAt(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 100 }), at);
  Object.defineProperty(e, 'pointerType', { value: ptype });
  Object.defineProperty(e, 'pointerId', { value: id });
  el.dispatchEvent(e);
};
/** A tap's mouse events, at its release. */
const mouseTap = (el: Element, at: number, x = 100, detail = 1): void => {
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: 100, detail };
  el.dispatchEvent(stampedAt(new MouseEvent('mousedown', init), at));
  el.dispatchEvent(stampedAt(new MouseEvent('click', init), at));
};
/** A whole mouse press (pointer `id`), down and released at `at`. */
const mouseClick = (el: Element, at: number, x = 100, id = 1, detail = 1): void => {
  ptr(el, 'pointerdown', at, id, x, 'mouse');
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: 100, detail };
  el.dispatchEvent(stampedAt(new MouseEvent('mousedown', init), at));
  ptr(el, 'pointerup', at, id, x, 'mouse');
  el.dispatchEvent(stampedAt(new MouseEvent('click', init), at));
};

describe('press guard — one pointer pressing at two spots (#181 H2)', () => {
  it('AB1: a mouse clicks the board at A, then at B 200px away; the dialog arrives; a re-click at A is held ("every press let go under 2 s ago")', () => {
    const h = fixture();
    mouseClick(h.board, 0, 100); // A, where B (the button) will stand
    mouseClick(h.board, 250, 300); // B, elsewhere: the same pointer, so its entry replaces A's
    setNow(350);
    h.guard.arm();
    mouseClick(h.b, 520, 100); // back at A, 170 ms after the arrival
    expect(h.pressed).toEqual([]);
  });

  it('AB2: the same with touches that share one pointerId (every WebKit tap here is pointerId 0)', () => {
    const h = fixture();
    ptr(h.board, 'pointerdown', 0, 0);
    ptr(h.board, 'pointerup', 60, 0);
    ptr(h.board, 'pointerdown', 160, 0, 300);
    ptr(h.board, 'pointerup', 220, 0, 300);
    setNow(350);
    h.guard.arm();
    ptr(h.b, 'pointerdown', 500, 0);
    mouseTap(h.b, 560);
    expect(h.pressed).toEqual([]);
  });
});

describe('press guard — a mouse release that never came heals at the next press (#181 H2)', () => {
  it('S2: a mouse release that never came: the next mouse release, 5 s after the arrival, re-opens the window at the old spot', () => {
    const h = fixture();
    ptr(h.board, 'pointerdown', 0, 1, 100, 'mouse'); // its pointerup is lost
    setNow(1000);
    h.guard.arm();
    mouseClick(h.a, 6000, 400); // Run data, 5 s on, far from the old spot: passes
    mouseClick(h.b, 6250); // a deliberate press 250 ms later, at the old spot
    expect(h.pressed, 'a deliberate press 5.25 s after the arrival').toEqual(['A', 'B']);
  });
});

describe('press guard — QC round 7 (#181 H2)', () => {
  it('KT-MAX: a release stamped before the arrival (dispatched after it) leaves the arrival where it was', () => {
    const h = fixture();
    ptr(h.board, 'pointerdown', 0, 7);
    setNow(500);
    h.guard.arm();
    ptr(h.board, 'pointerup', 400, 7); // stamped by the device before the arrival's frame
    ptr(h.b, 'pointerdown', 860, 8);
    mouseTap(h.b, 950); // 450 ms after the arrival
    expect(h.pressed).toEqual([]);
  });

  it('KT-LASTREL: the window runs from the LAST release among the pointers down at the arrival', () => {
    const h = fixture();
    ptr(h.board, 'pointerdown', 0, 7); // A, on the spot
    ptr(h.board, 'pointerdown', 50, 8, 300); // B, elsewhere
    setNow(100);
    h.guard.arm();
    ptr(h.board, 'pointerup', 300, 7);
    ptr(h.board, 'pointerup', 1000, 8, 300);
    ptr(h.b, 'pointerdown', 1110, 9);
    mouseTap(h.b, 1200); // at A, 200 ms after B's release, 900 ms after A's
    expect(h.pressed).toEqual([]);
  });

  it('KT-SPOT2: a press at the SECOND of two spots is held too', () => {
    const h = fixture();
    ptr(h.board, 'pointerdown', 0, 7, 300); // first spot, elsewhere
    ptr(h.board, 'pointerdown', 50, 8); // second spot, where B will stand
    setNow(100);
    h.guard.arm();
    ptr(h.board, 'pointerup', 200, 7, 300);
    ptr(h.board, 'pointerup', 250, 8);
    ptr(h.b, 'pointerdown', 400, 9);
    mouseTap(h.b, 480);
    expect(h.pressed).toEqual([]);
  });

  it('KT-EXEMPT-ARRIVALS: the last press that passed was on B before the arrival (a touch-only run since): a tap on B at the spot is held', () => {
    const h = fixture();
    mouseClick(h.b, 0); // Play again, tapped to start this run: the last press with mouse events
    ptr(h.board, 'pointerdown', 60_000, 7); // the run, by touch only; a tap as it ends
    ptr(h.board, 'pointerup', 60_090, 7);
    setNow(60_100);
    h.guard.arm();
    ptr(h.b, 'pointerdown', 60_150, 8);
    mouseTap(h.b, 60_240);
    expect(h.pressed).toEqual(['B']);
  });

  it('KT-EXEMPT-CONTROL: a press that passed on A since the arrival exempts no press on B', () => {
    const h = fixture();
    mouseClick(h.board, 0);
    setNow(20);
    h.guard.arm();
    mouseClick(h.a, 100, 400, 2); // another pointer, far from the spot: passes
    mouseClick(h.b, 200, 100, 3); // at the spot, 180 ms after the arrival
    expect(h.pressed).toEqual(['A']);
  });

  it('KT-DURING-ONCE: a pointer down at the arrival re-times it once: its next press’s release does not', () => {
    const h = fixture();
    ptr(h.board, 'pointerdown', 0, 1, 100, 'mouse');
    setNow(20);
    h.guard.arm();
    ptr(h.board, 'pointerup', 300, 1, 100, 'mouse');
    mouseClick(h.a, 900, 400); // the same mouse, elsewhere
    mouseClick(h.b, 1100); // back at the spot: 800 ms after the release the arrival waited for
    expect(h.pressed).toEqual(['A', 'B']);
  });

  it('KT-FALLBACK-KEY: a keyboard activation whose dispatch is stopped before the window: the next key still runs the check', () => {
    // Synchronous: the guard's zero-delay timer cannot have run before the key.
    const h = fixture();
    setNow(1000);
    h.a.addEventListener('click', (e) => {
      h.b.focus();
      e.stopPropagation();
    });
    h.a.focus();
    h.a.dispatchEvent(
      stampedAt(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }), 1000),
    );
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    h.b.dispatchEvent(space);
    expect(space.defaultPrevented, 'Space on B before the timer: held').toBe(true);
  });

  it('KT-FALLBACK-TIMER: the same, with a task between: the timer ran the check, so a later scripted focus is not the activation’s', async () => {
    const h = fixture();
    setNow(1000);
    h.a.addEventListener('click', (e) => {
      h.b.focus();
      e.stopPropagation();
    });
    h.a.focus();
    h.a.dispatchEvent(
      stampedAt(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }), 1000),
    );
    await new Promise((resolve) => setTimeout(resolve, 0)); // queued after the guard's
    h.radio.focus(); // a script moves focus after the check ran
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    h.radio.dispatchEvent(space);
    expect(space.defaultPrevented, 'Space on the radio').toBe(false);
  });
});

describe('press guard — a pinned trade-off, a thumb resting across the arrival (#181 H2)', () => {
  it('RT1 (pinned trade-off): a thumb resting elsewhere across the arrival re-opens the window for every spot when it lifts, 5 s on', () => {
    const h = fixture();
    ptr(h.board, 'pointerdown', -500, 8, 300); // a thumb resting on the board, elsewhere
    ptr(h.board, 'pointerdown', 0, 7); // a tap where Play again will stand, as the run ends
    ptr(h.board, 'pointerup', 90, 7);
    setNow(100);
    h.guard.arm();
    ptr(h.board, 'pointerup', 5000, 8, 300); // the thumb lifts, 5 s on
    ptr(h.b, 'pointerdown', 5210, 9);
    mouseTap(h.b, 5300); // a deliberate tap on Play again, 300 ms after the lift
    expect(
      h.pressed,
      'held: the window runs from the last release of a pointer down at the arrival',
    ).toEqual([]);
    ptr(h.b, 'pointerdown', 5520, 10);
    mouseTap(h.b, 5600); // the retry, 600 ms after the lift
    expect(h.pressed, 'the retry passes').toEqual(['B']);
  });
});
