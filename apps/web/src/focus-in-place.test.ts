import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusAfterRender } from './focus-in-place';

// focus-in-place.test.ts — `focusAfterRender` (#181 H2): layout read, then focus, with the
// browser's scroll or without it; and, without it, a focus ring the player is meant to see brought
// into view by the least scroll. jsdom has no layout and no `scrollIntoView`, and its selector
// engine matches `:focus-visible` on any focused element, so what a browser decides is stubbed
// here. That a browser rings a control focused after a Tab, and not one focused after a pointer
// press, is `results-pointer.spec.ts`'s.

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** A button whose layout read, focus and scroll are recorded in order. `ring` is what the engine
 *  answers for `:focus-visible` (or `throws`, as an engine that does not know it). */
function control(ring: boolean | 'throws', scrolls = true) {
  const el = document.createElement('button');
  document.body.append(el);
  const order: string[] = [];
  Object.defineProperty(el, 'offsetHeight', {
    configurable: true,
    get: () => {
      order.push('layout');
      return 0;
    },
  });
  const focus = vi.spyOn(el, 'focus').mockImplementation(() => void order.push('focus'));
  vi.spyOn(el, 'matches').mockImplementation((selector: string) => {
    expect(selector).toBe(':focus-visible');
    if (ring === 'throws') throw new SyntaxError('unknown pseudo-class');
    return ring;
  });
  const scroll = vi.fn(() => void order.push('scroll'));
  if (scrolls) el.scrollIntoView = scroll;
  return { el, order, focus, scroll };
}

describe('focusAfterRender (#181 H2)', () => {
  it('reads layout, then focuses: without the browser’s scroll where asked, and with it otherwise', () => {
    const c = control(false);
    focusAfterRender(c.el, true);
    focusAfterRender(c.el, false);
    expect(c.focus.mock.calls).toEqual([[{ preventScroll: true }], [undefined]]);
    expect(c.order, 'WebKit scrolls a preventScroll focus made over dirty layout').toEqual([
      'layout',
      'focus',
      'layout',
      'focus',
    ]);
  });

  it('after a focus without the browser’s scroll, a ringed control is brought into view by the least scroll', () => {
    const c = control(true);
    focusAfterRender(c.el, true);
    expect(c.scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' });
    expect(c.order).toEqual(['layout', 'focus', 'scroll']);
  });

  it('an unringed control stays where it is: the pointer that pressed is still in use', () => {
    const c = control(false);
    focusAfterRender(c.el, true);
    expect(c.scroll).not.toHaveBeenCalled();
  });

  it('a focus WITH the browser’s scroll needs no second one, ringed or not', () => {
    const c = control(true);
    focusAfterRender(c.el, false);
    expect(c.scroll).not.toHaveBeenCalled();
  });

  it('an engine that cannot match `:focus-visible`, or has no `scrollIntoView`, scrolls nothing', () => {
    const unknown = control('throws');
    expect(() => focusAfterRender(unknown.el, true)).not.toThrow();
    expect(unknown.scroll).not.toHaveBeenCalled();
    const noScroll = control(true, false);
    expect(() => focusAfterRender(noScroll.el, true)).not.toThrow();
    expect(noScroll.order).toEqual(['layout', 'focus']);
  });

  it('nothing to focus, nothing done', () => {
    expect(() => focusAfterRender(undefined, true)).not.toThrow();
  });
});
