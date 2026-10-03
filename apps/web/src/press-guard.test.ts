import { afterEach, describe, expect, it } from 'vitest';
import { guardPresses, PRESS_GUARD_SLOP_PX, PRESS_GUARD_WINDOW_MS } from './press-guard';

// press-guard.test.ts — the rules of `press-guard.ts` (#181 H2): after a pointer press on a
// control, a pointer press at the same spot on a DIFFERENT control inside the window is
// swallowed. The results panel's wiring is `overlay.test.ts`'s; the panel under a real pointer
// is `results-pointer.spec.ts`'s.

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

function fixture() {
  const root = document.createElement('div');
  const a = document.createElement('button');
  const b = document.createElement('button');
  // A radio wrapped in its label, as the survey builds its options.
  const label = document.createElement('label');
  const radio = document.createElement('input');
  radio.type = 'radio';
  const text = document.createElement('span');
  text.textContent = '1';
  label.append(radio, text);
  const plain = document.createElement('p');
  root.append(a, b, label, plain);
  document.body.append(root);
  mounted.push(root);
  const pressed: string[] = [];
  a.addEventListener('click', () => pressed.push('A'));
  b.addEventListener('click', () => pressed.push('B'));
  const unguard = guardPresses(root);
  /** A press as the browser delivers it: a click whose `detail` counts pointer clicks (0 for a
   *  keyboard activation), at a time and a spot. */
  const press = (el: Element, at: number, spot: { x?: number; y?: number } = {}, detail = 1) => {
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail,
      clientX: spot.x ?? 100,
      clientY: spot.y ?? 100,
    });
    Object.defineProperty(event, 'timeStamp', { value: at });
    el.dispatchEvent(event);
    return event;
  };
  return { a, b, label, radio, text, plain, pressed, press, unguard };
}

describe('press guard (#181 H2)', () => {
  it('holds a second press at the same spot to the first control for 500 ms, then lets it through', () => {
    expect(PRESS_GUARD_WINDOW_MS).toBe(500);
    const h = fixture();
    h.press(h.a, 1000);
    const early = h.press(h.b, 1499);
    expect(h.pressed, 'B pressed 499 ms after A, at the same spot, is swallowed').toEqual(['A']);
    expect(early.defaultPrevented).toBe(true);
    h.press(h.b, 1500);
    expect(h.pressed, 'at 500 ms the window has closed').toEqual(['A', 'B']);
  });

  it('a press more than 24px from the first went somewhere on purpose, and passes', () => {
    expect(PRESS_GUARD_SLOP_PX).toBe(24);
    const near = fixture();
    near.press(near.a, 0, { x: 100, y: 100 });
    near.press(near.b, 50, { x: 100 + 24, y: 100 });
    expect(near.pressed, 'within 24px: the same spot').toEqual(['A']);
    const far = fixture();
    far.press(far.a, 0, { x: 100, y: 100 });
    far.press(far.b, 50, { x: 100 + 24.5, y: 100 });
    expect(far.pressed, 'beyond it: a deliberate press').toEqual(['A', 'B']);
  });

  it('a repeat on the same control passes, and keeps the window open', () => {
    const h = fixture();
    h.press(h.a, 0);
    h.press(h.a, 300);
    expect(h.pressed, 'a double-click on one control is that control’s').toEqual(['A', 'A']);
    h.press(h.b, 700);
    expect(h.pressed, '400 ms after the repeat, B at the same spot is swallowed').toEqual([
      'A',
      'A',
    ]);
  });

  it('every press that passes is the one the next is measured from, a repeat included', () => {
    // Run data's toggle opened at one spot, then, after a scroll, pressed again lower down: a
    // quick second press is held to the toggle where it was pressed this time.
    const later = fixture();
    later.press(later.a, 0, { x: 100, y: 100 });
    later.press(later.a, 1000, { x: 100, y: 300 }); // the first press's window has closed
    later.press(later.b, 1100, { x: 100, y: 300 });
    expect(later.pressed, 'B at the repeat’s spot, 100 ms after it, is swallowed').toEqual([
      'A',
      'A',
    ]);
    const quick = fixture();
    quick.press(quick.a, 0, { x: 100, y: 100 });
    quick.press(quick.a, 100, { x: 100, y: 300 }); // inside the window, at another spot
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

  it('a swallowed press neither restarts the window nor moves its spot', () => {
    const h = fixture();
    h.press(h.a, 0);
    h.press(h.b, 300); // swallowed
    h.press(h.b, 499); // still measured from A's press: swallowed again
    expect(h.pressed).toEqual(['A']);
    h.press(h.b, 500);
    expect(h.pressed).toEqual(['A', 'B']);
  });

  it('a keyboard activation is never guarded, and never arms the guard', () => {
    const h = fixture();
    h.press(h.a, 0);
    h.press(h.b, 100, {}, 0);
    expect(h.pressed, 'Enter or Space on B, right after a pointer press on A').toEqual(['A', 'B']);
    const k = fixture();
    k.press(k.a, 0, {}, 0);
    k.press(k.b, 100);
    expect(k.pressed, 'a pointer press right after a keyboard activation').toEqual(['A', 'B']);
  });

  it('a swallowed press runs no default action: no label forwards, no radio checks', () => {
    const h = fixture();
    h.press(h.a, 0);
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
    h.press(h.a, 200);
    expect(h.pressed, 'A at the same spot, inside the window the radio keeps open').toEqual([]);
  });

  it('the click a label forwards is part of its press, and never moves the spot', () => {
    // jsdom forwards a label's click from (0, 0) with `detail` 1, as a browser might.
    const h = fixture();
    h.press(h.text, 0, { x: 100, y: 100 }); // an option's text: its label forwards to the radio
    expect(h.radio.checked, 'the label forwarded its press').toBe(true);
    h.press(h.a, 100, { x: 100, y: 100 });
    expect(h.pressed, 'A at the option’s spot, 100 ms later, is swallowed').toEqual([]);
  });

  it('a press on no control is ignored: it neither passes judgement nor arms the guard', () => {
    const h = fixture();
    h.press(h.plain, 0);
    h.press(h.a, 100);
    expect(h.pressed).toEqual(['A']);
  });

  it('removes itself', () => {
    const h = fixture();
    h.unguard();
    h.press(h.a, 0);
    h.press(h.b, 100);
    expect(h.pressed).toEqual(['A', 'B']);
  });
});
