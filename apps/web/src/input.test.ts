import { describe, it, expect, beforeEach } from 'vitest';
import { createController } from './controller';
import { createKeymap } from './keymap';
import { attachInput } from './input';

// A fixed 280×240 board rect → 28×24 cells at 10 px each, origin (0,0): cell (c,r) spans
// [c*10, r*10)..; a client point (x,y) maps to cell (⌊x/10⌋, ⌊y/10⌋).
const RECT = { left: 0, top: 0, width: 280, height: 240 };

function ptr(
  type: string,
  clientX: number,
  clientY: number,
  pointerType = 'mouse',
  button = 0,
): Event {
  const e = new Event(type, { bubbles: true });
  Object.assign(e, { clientX, clientY, pointerType, button });
  return e;
}

let board: HTMLDivElement;

/** Dispatch a full press+release (pointerdown then pointerup) — the click semantics the
 *  input layer requires to commit a build/select. */
function tap(x: number, y: number, pointerType = 'mouse', button = 0): void {
  board.dispatchEvent(ptr('pointerdown', x, y, pointerType, button));
  board.dispatchEvent(ptr('pointerup', x, y, pointerType, button));
}
beforeEach(() => {
  document.body.innerHTML = '';
  board = document.createElement('div');
  document.body.appendChild(board);
});

describe('input — keyboard (rebindable, drives the cursor & commands)', () => {
  it('moves the cursor, ignores unbound keys, and toggles pause/speed', () => {
    const c = createController(1);
    const km = createKeymap();
    attachInput(document, board, c, km, { getRect: () => RECT });
    const start = c.cursor();
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight' }));
    expect(c.cursor().col).toBe(start.col + 1);
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown' }));
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' }));
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft' }));
    expect(c.cursor()).toEqual(start);
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' })); // unbound → no-op
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); // pause
    expect(c.isPaused()).toBe(true);
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF' })); // speed
    expect(c.speed()).toBe(2);
  });

  it('builds with confirm, sells with the sell key, and calls the wave', () => {
    const c = createController(1);
    const km = createKeymap();
    attachInput(document, board, c, km, { getRect: () => RECT });

    c.aimAt(3, 3); // a valid ghost
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' })); // confirm → build
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1);

    c.aimAt(3, 3); // now selects the tower
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX' })); // sell
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0);

    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC' })); // call wave
    c.advance(50);
    expect(c.hud().phase).toBe('active');
  });
});

describe('input — pointer (mouse hover/click & touch two-tap)', () => {
  it('hover aims and click commits on desktop', () => {
    const c = createController(1);
    attachInput(document, board, c, createKeymap(), { getRect: () => RECT });
    board.dispatchEvent(ptr('pointermove', 35, 35)); // → cell (3,3)
    expect(c.frame().ghost).toMatchObject({ col: 3, row: 3, valid: true });
    tap(35, 35); // press+release on the board → build
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1);
  });

  it('ignores a release from a drag that began OFF the board (no click semantics)', () => {
    const c = createController(1);
    attachInput(document, board, c, createKeymap(), { getRect: () => RECT });
    board.dispatchEvent(ptr('pointermove', 35, 35)); // valid ghost under the cursor
    board.dispatchEvent(ptr('pointerup', 35, 35)); // release with NO preceding pointerdown
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0); // drag-in release must not build
  });

  it('keeps a tower selected as the mouse hovers empty cells toward the Sell button', () => {
    const c = createController(1);
    attachInput(document, board, c, createKeymap(), { getRect: () => RECT });
    board.dispatchEvent(ptr('pointermove', 35, 35)); // hover empty (3,3)
    tap(35, 35); // click → build a tower at (3,3)
    c.advance(50);
    tap(35, 35); // click the tower → select it
    expect(c.frame().selection).not.toBeNull();
    board.dispatchEvent(ptr('pointermove', 105, 105)); // hover an empty cell en route to Sell
    expect(c.frame().selection).not.toBeNull(); // selection NOT lost by hover
  });

  it('ignores hover on touch and requires a second tap on the same cell to commit', () => {
    const c = createController(1);
    attachInput(document, board, c, createKeymap(), { getRect: () => RECT });
    board.dispatchEvent(ptr('pointermove', 55, 55, 'touch')); // no hover on touch
    expect(c.frame().ghost).toBeNull();
    tap(55, 55, 'touch'); // first tap → preview only
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0);
    tap(55, 55, 'touch'); // second tap → commit
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1);
  });

  it('builds only on the primary button — not right/middle (>0) or the no-button sentinel (-1)', () => {
    const c = createController(1);
    attachInput(document, board, c, createKeymap(), { getRect: () => RECT });
    board.dispatchEvent(ptr('pointermove', 35, 35)); // aim a valid ghost
    tap(35, 35, 'mouse', 2); // right-click press+release
    tap(35, 35, 'mouse', -1); // stylus hover lift (no button)
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0); // neither committed a build
    tap(35, 35, 'mouse', 0); // primary → builds
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1);
  });

  it('treats a stale second touch-tap (past the confirm window) as a fresh preview, not a build', () => {
    const c = createController(1);
    let clock = 0;
    attachInput(document, board, c, createKeymap(), { getRect: () => RECT, now: () => clock });
    tap(55, 55, 'touch'); // first tap (t=0) → preview
    clock = 5000; // player moved on; comes back much later
    tap(55, 55, 'touch'); // same cell but stale → preview only
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0); // no unintended build
    tap(55, 55, 'touch'); // prompt second tap → commits
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1);
  });

  it('a cancelled touch clears the armed first tap', () => {
    const c = createController(1);
    attachInput(document, board, c, createKeymap(), { getRect: () => RECT, now: () => 0 });
    tap(55, 55, 'touch'); // first tap → preview
    board.dispatchEvent(new Event('pointercancel', { bubbles: true })); // gesture cancelled
    tap(55, 55, 'touch'); // now a fresh first tap, not a commit
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0);
  });

  it('does nothing for a pointer outside the board, and detaches cleanly', () => {
    const c = createController(1);
    const handle = attachInput(document, board, c, createKeymap(), { getRect: () => RECT });
    tap(9999, 9999); // press+release outside → null cell
    expect(c.frame().curVm.towers).toHaveLength(0);
    handle.destroy();
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); // detached → ignored
    expect(c.isPaused()).toBe(false);
  });
});
