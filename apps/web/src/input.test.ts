import { describe, it, expect, beforeEach } from 'vitest';
import { createController } from './controller';
import { createKeymap } from './keymap';
import { attachInput } from './input';

// A fixed 280×240 board rect → 28×24 cells at 10 px each, origin (0,0): cell (c,r) spans
// [c*10, r*10)..; a client point (x,y) maps to cell (⌊x/10⌋, ⌊y/10⌋).
const RECT = { left: 0, top: 0, width: 280, height: 240 };

// A LETTERBOXED rect: 300 px wide for a 28-col × 10 px grid (= 280 px), so the projection
// centres the grid with a 10 px blank margin on each side (originX = 10, originY = 0). A
// client point with x in [0,10) or [290,300) is INSIDE the board rect but OUTSIDE the grid —
// the out-of-grid case FIX 2 must treat as "no target" rather than clamping onto an edge cell.
const LETTERBOX = { left: 0, top: 0, width: 300, height: 240 };

function ptr(
  type: string,
  clientX: number,
  clientY: number,
  pointerType = 'mouse',
  button = 0,
  pointerId = 1,
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { clientX, clientY, pointerType, button, pointerId });
  return e;
}

let board: HTMLDivElement;
let card: HTMLButtonElement;

/** Dispatch a full press+release (pointerdown then pointerup) on `board` — the click
 *  semantics the input layer requires to commit a build/select. */
function tap(x: number, y: number, pointerType = 'mouse', button = 0, pointerId = 1): void {
  board.dispatchEvent(ptr('pointerdown', x, y, pointerType, button, pointerId));
  board.dispatchEvent(ptr('pointerup', x, y, pointerType, button, pointerId));
}

beforeEach(() => {
  document.body.innerHTML = '';
  board = document.createElement('div');
  card = document.createElement('button');
  document.body.append(board, card);
});

describe('input — keyboard (rebindable, drives the cursor & commands)', () => {
  it('moves the cursor, ignores unbound keys, and toggles pause/speed', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    const km = createKeymap();
    attachInput(document, board, [], c, km, { getRect: () => RECT });
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

  it('KeyC (the start key, routed to the morphed primary action) unholds the run WITHOUT launching wave 1 (PLAN.md P3 step 15 decouple); then builds with confirm and sells with the sell key', () => {
    const c = createController(1);
    const km = createKeymap();
    attachInput(document, board, [], c, km, { getRect: () => RECT });

    expect(c.uiState().started).toBe(false); // held pre-start
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC' })); // start
    expect(c.uiState().started).toBe(true);

    c.armTower('basic');
    c.aimAt(3, 3); // a valid ghost
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' })); // confirm → build
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1);
    expect(c.hud().phase).toBe('running');
    expect(c.hud().waveCursor).toBe(0); // Start claimed nothing — wave 1 hasn't launched

    c.aimAt(3, 3); // now selects the tower
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX' })); // sell
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0);
  });

  it('ignores auto-repeat keydowns for discrete actions — holding pause toggles exactly once', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', repeat: false }));
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', repeat: true }));
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', repeat: true }));
    expect(c.isPaused()).toBe(true); // toggled exactly once, not thrice
  });

  it('keeps auto-repeat for cursor movement — a held arrow keeps moving', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
    const start = c.cursor();
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', repeat: false }));
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', repeat: true }));
    expect(c.cursor().col).toBe(start.col + 2); // moved on both the initial and repeat keydown
  });

  it('a repeated keydown is still consumed (preventDefault) even when its action is ignored', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
    const e = new KeyboardEvent('keydown', { code: 'Space', repeat: true, cancelable: true });
    board.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('classifies repeat-suppression by resolved action, not physical key — pause rebound onto ArrowRight is still edge-triggered', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    const km = createKeymap();
    km.rebind('pause', 'ArrowRight'); // displaces 'right', which becomes unbound
    attachInput(document, board, [], c, km, { getRect: () => RECT });
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', repeat: false }));
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', repeat: true }));
    expect(c.isPaused()).toBe(true); // toggled once despite two keydowns

    // Inversely: rebinding a movement action onto a letter key keeps it auto-repeating.
    km.rebind('up', 'KeyQ');
    const start = c.cursor();
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', repeat: false }));
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', repeat: true }));
    expect(c.cursor().row).toBe(start.row - 2);
  });
});

describe('input — mouse (P2 hover/click, unchanged by P3)', () => {
  it('hover previews (armed) and click commits on desktop', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
    c.armTower('basic'); // PLAN.md P2: a desktop click builds only while armed
    board.dispatchEvent(ptr('pointermove', 35, 35)); // → cell (3,3)
    expect(c.frame().ghost).toMatchObject({ col: 3, row: 3, valid: true });
    tap(35, 35); // press+release on the board → build
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1);
  });

  it('ignores a release from a drag that began OFF the board (no click semantics)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
    c.armTower('basic');
    board.dispatchEvent(ptr('pointermove', 35, 35)); // valid ghost under the cursor
    board.dispatchEvent(ptr('pointerup', 35, 35)); // release with NO preceding pointerdown
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0); // drag-in release must not build
  });

  it('a mouse click while UNARMED never places — it only selects a tower or deselects (PLAN.md P2: armed is placement-only)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
    c.armTower('basic');
    tap(35, 35); // armed click → build a tower at (3,3), disarms
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1);
    tap(35, 35); // unarmed click on the tower → selects it
    expect(c.frame().selection).not.toBeNull();
    // Hovering while unarmed is a no-op (the ghost preview is an armed-only affordance) —
    // it neither builds nor disturbs the selection.
    board.dispatchEvent(ptr('pointermove', 105, 105));
    expect(c.frame().selection).not.toBeNull();
    expect(c.frame().ghost).toBeNull();
    tap(105, 105); // unarmed click on an empty cell → deselects; never builds
    expect(c.frame().selection).toBeNull();
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1); // still just the one
  });

  it('builds only on the primary button — not right/middle (>0) or the no-button sentinel (-1)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
    c.armTower('basic');
    board.dispatchEvent(ptr('pointermove', 35, 35)); // aim a valid ghost
    tap(35, 35, 'mouse', 2); // right-click press+release
    tap(35, 35, 'mouse', -1); // stylus hover lift (no button)
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0); // neither committed a build
    tap(35, 35, 'mouse', 0); // primary → builds
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1);
  });

  // Pointer capture routes the pointerup back to the board even when released over chrome.
  it('a mouse release over Shell chrome never places — stays armed', () => {
    const chrome = document.createElement('div');
    chrome.className = 'wy-dock';
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [], c, createKeymap(), {
      getRect: () => RECT,
      elementFromPoint: () => chrome,
    });
    c.armTower('basic');
    board.dispatchEvent(ptr('pointerdown', 35, 35, 'mouse')); // armed press on the board
    board.dispatchEvent(ptr('pointerup', 35, 35, 'mouse')); // released over the overlapping Dock
    expect(c.uiState().armed).not.toBeNull(); // stays armed — the chrome release never committed
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0); // no placement on the cell underneath the Dock
  });

  it('does nothing for a pointer outside the board, and detaches cleanly', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    const handle = attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
    tap(9999, 9999); // press+release outside → null cell
    expect(c.frame().curVm.towers).toHaveLength(0);
    handle.destroy();
    board.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); // detached → ignored
    expect(c.isPaused()).toBe(false);
  });
});

describe.each([['touch'], ['pen']])(
  'input — board %s: press-adjust-release (PLAN.md P3)',
  (pointerType) => {
    it('shows the offset ghost 2 cells above the finger cell while armed', () => {
      const c = createController(1);
      c.start(); // PLAN.md P4: advance() no-ops while held
      attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
      c.armTower('basic');
      board.dispatchEvent(ptr('pointerdown', 35, 105, pointerType)); // finger at (3,10)
      // anchor row = fingerRow(10) - 2 = 8; col = fingerCol(3)
      expect(c.frame().ghost).toMatchObject({ col: 3, row: 8, valid: true });
    });

    it('flips the offset below the finger near the top edge, and clamps at the grid edges', () => {
      const c = createController(1);
      c.start(); // PLAN.md P4: advance() no-ops while held
      attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
      c.armTower('basic');
      // finger at row 0 (y in [0,10)): above = 0-2 = -2 < 0 → flips to row 0+1 = 1 (never
      // under the finger's own row).
      board.dispatchEvent(ptr('pointerdown', 35, 5, pointerType));
      expect(c.frame().ghost).toMatchObject({ col: 3, row: 1 });

      // finger at the far bottom-right cell (27,23): plenty of room above (above = 23-2 =
      // 21, no flip needed), but the finger's own column (27) is clamped so the 2×2
      // footprint stays in-bounds (cols-2=26). A fresh pointerId — the previous gesture's
      // press entry is irrelevant to this independent contact.
      board.dispatchEvent(ptr('pointerdown', 275, 235, pointerType, 0, 2));
      expect(c.frame().ghost).toMatchObject({ col: 26, row: 21 });
    });

    it('moving adjusts the ghost; release on a valid ghost commits (disarm → select)', () => {
      const c = createController(1);
      c.start(); // PLAN.md P4: advance() no-ops while held
      attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
      c.armTower('basic');
      board.dispatchEvent(ptr('pointerdown', 35, 105, pointerType)); // anchor (3,8)
      board.dispatchEvent(ptr('pointermove', 45, 105, pointerType)); // anchor moves to (4,8)
      expect(c.frame().ghost).toMatchObject({ col: 4, row: 8 });
      board.dispatchEvent(ptr('pointerup', 45, 105, pointerType));
      c.advance(50);
      expect(c.frame().curVm.towers).toHaveLength(1);
      expect(c.uiState().armed).toBeNull(); // disarmed
      expect(c.uiState().selection).toMatchObject({ col: 4, row: 8 }); // and selected
    });

    it('release on an invalid ghost places nothing, keeps armed, and the ghost persists', () => {
      const c = createController(1);
      c.start(); // PLAN.md P4: advance() no-ops while held
      attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
      c.armTower('basic');
      tap(35, 105, pointerType); // commit at anchor (3,8)
      c.advance(50);
      c.armTower('basic'); // re-arm to try the SAME (now occupied) anchor
      board.dispatchEvent(ptr('pointerdown', 35, 105, pointerType));
      board.dispatchEvent(ptr('pointerup', 35, 105, pointerType));
      expect(c.uiState().armed).not.toBeNull(); // stays armed
      expect(c.frame().ghost).toMatchObject({ col: 3, row: 8, valid: false }); // persistent invalid ghost
      c.advance(50);
      expect(c.frame().curVm.towers).toHaveLength(1); // no second tower placed
    });

    it('an unarmed single tap selects a tower (or deselects) — no two-tap required', () => {
      const c = createController(1);
      c.start(); // PLAN.md P4: advance() no-ops while held
      attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
      c.armTower('basic');
      tap(35, 105, pointerType); // anchor (3,8) → build
      c.advance(50);
      expect(c.frame().curVm.towers).toHaveLength(1);
      expect(c.uiState().armed).toBeNull();

      tap(35, 85, pointerType); // ONE tap on the tower's footprint (col 3, row 8) → selects it
      expect(c.uiState().selection).not.toBeNull();

      tap(215, 215, pointerType); // ONE tap on an empty cell → deselects
      expect(c.uiState().selection).toBeNull();
    });

    it('a release over Shell chrome never commits a placement — stays armed (tap-flow)', () => {
      const chrome = document.createElement('div');
      chrome.className = 'wy-dock';
      const c = createController(1);
      c.start(); // PLAN.md P4: advance() no-ops while held
      attachInput(document, board, [], c, createKeymap(), {
        getRect: () => RECT,
        elementFromPoint: () => chrome,
      });
      c.armTower('basic');
      board.dispatchEvent(ptr('pointerdown', 35, 105, pointerType)); // anchor (3,8), valid
      board.dispatchEvent(ptr('pointerup', 35, 105, pointerType));
      expect(c.uiState().armed).not.toBeNull(); // stays armed — never committed
      c.advance(50);
      expect(c.frame().curVm.towers).toHaveLength(0);
    });

    it('an unarmed release over Shell chrome never selects/deselects the board cell underneath', () => {
      const chrome = document.createElement('div');
      chrome.className = 'wy-dock';
      let hitChrome = false; // toggled after the tower is built, so the build itself isn't blocked
      const c = createController(1);
      c.start(); // PLAN.md P4: advance() no-ops while held
      attachInput(document, board, [], c, createKeymap(), {
        getRect: () => RECT,
        elementFromPoint: () => (hitChrome ? chrome : null),
      });
      c.armTower('basic');
      tap(35, 105, pointerType); // anchor (3,8) → build → disarm → auto-selects the new tower (PLAN.md P2)
      c.advance(50);
      expect(c.frame().curVm.towers).toHaveLength(1);
      expect(c.uiState().armed).toBeNull();
      c.escape(); // deselect, so the next tap's selection (if any) is unambiguously new
      expect(c.uiState().selection).toBeNull();

      hitChrome = true;
      board.dispatchEvent(ptr('pointerdown', 35, 85, pointerType)); // the tower's footprint, but hit-tests as chrome
      board.dispatchEvent(ptr('pointerup', 35, 85, pointerType));
      expect(c.uiState().selection).toBeNull(); // never selected the tower underneath the chrome
    });

    it('a cancelled board gesture clears the ghost but stays armed', () => {
      const c = createController(1);
      c.start(); // PLAN.md P4: advance() no-ops while held
      attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
      c.armTower('basic');
      board.dispatchEvent(ptr('pointerdown', 35, 105, pointerType));
      expect(c.frame().ghost).not.toBeNull();
      board.dispatchEvent(ptr('pointercancel', 35, 105, pointerType));
      expect(c.frame().ghost).toBeNull(); // ghost cleared
      expect(c.uiState().armed).not.toBeNull(); // but board-origin stays armed
    });

    it('a lostpointercapture after a completed release is ignored', () => {
      const c = createController(1);
      c.start(); // PLAN.md P4: advance() no-ops while held
      attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
      c.armTower('basic');
      board.dispatchEvent(ptr('pointerdown', 35, 105, pointerType));
      board.dispatchEvent(ptr('pointerup', 35, 105, pointerType)); // committed → disarmed
      c.advance(50);
      expect(c.frame().curVm.towers).toHaveLength(1);
      const selectionBefore = c.uiState().selection;
      board.dispatchEvent(ptr('lostpointercapture', 35, 105, pointerType)); // stale — no-op
      expect(c.uiState().selection).toEqual(selectionBefore);
      expect(c.uiState().armed).toBeNull();
    });

    it('a release whose press started off-board does not count — even with another finger down on the board', () => {
      const c = createController(1);
      c.start(); // PLAN.md P4: advance() no-ops while held
      attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
      board.dispatchEvent(ptr('pointerdown', 35, 35, pointerType, 0, 1)); // pointerId 1 down on board
      board.dispatchEvent(ptr('pointerup', 55, 55, pointerType, 0, 2)); // pointerId 2 up, no matching down
      c.advance(50);
      expect(c.frame().curVm.towers).toHaveLength(0);
    });

    it('two concurrent contacts on the board void the gesture — cross-origin multi-touch', () => {
      const c = createController(1);
      c.start(); // PLAN.md P4: advance() no-ops while held
      attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
      c.armTower('basic');
      board.dispatchEvent(ptr('pointerdown', 35, 105, pointerType, 0, 1)); // finger 1 down, anchor (3,8)
      board.dispatchEvent(ptr('pointerdown', 65, 105, pointerType, 0, 2)); // finger 2 down (concurrent)
      board.dispatchEvent(ptr('pointerup', 35, 105, pointerType, 0, 1)); // release finger 1
      board.dispatchEvent(ptr('pointerup', 35, 105, pointerType, 0, 2)); // release finger 2
      c.advance(50);
      expect(c.frame().curVm.towers).toHaveLength(0); // voided — no build
    });

    it('a voided board release cancels through the SAME contract as pointercancel — ghost cleared, but stays armed (no phantom ghost)', () => {
      const c = createController(1);
      c.start(); // PLAN.md P4: advance() no-ops while held
      attachInput(document, board, [], c, createKeymap(), { getRect: () => RECT });
      c.armTower('basic');
      board.dispatchEvent(ptr('pointerdown', 35, 105, pointerType, 0, 1)); // finger 1 down, anchor (3,8)
      expect(c.frame().ghost).not.toBeNull(); // armed press shows the offset ghost
      board.dispatchEvent(ptr('pointerdown', 65, 105, pointerType, 0, 2)); // finger 2 down (concurrent) — voids finger 1
      board.dispatchEvent(ptr('pointerup', 35, 105, pointerType, 0, 1)); // finger 1 releases, voided
      expect(c.frame().ghost).toBeNull(); // no lingering (phantom) ghost from the voided press
      expect(c.uiState().armed).toBe('basic'); // board-origin cancellation preserves armed
      c.advance(50);
      expect(c.frame().curVm.towers).toHaveLength(0); // nothing placed
    });
  },
);

describe('input — Card gestures: tap vs drag (touch/pen only, PLAN.md P3)', () => {
  it('a Card move of 7px (below DRAG_THRESHOLD_PX = 8) is a tap — toggles armed and suppresses the synthetic click', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointermove', 17, 10, 'touch')); // 7px — under the 8px threshold
    card.dispatchEvent(ptr('pointerup', 17, 10, 'touch'));
    expect(c.uiState().armed).toBe('basic'); // tap toggled it on

    // The browser's synthetic click after the touch tap must not double-toggle it off.
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(c.uiState().armed).toBe('basic');
  });

  it('a non-primary pen press (barrel/right button) registers no gesture — its pointerup neither arms nor places', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'pen', 2)); // pen barrel/right button — button !== 0
    card.dispatchEvent(ptr('pointerup', 10, 10, 'pen', 2));
    expect(c.uiState().armed).toBeNull(); // never armed
    expect(c.frame().curVm.towers).toHaveLength(0); // never placed
  });

  it('a second tap-toggle before the first synthetic click arrives still suppresses BOTH clicks (no shared reset-on-press race)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    // First tap: arms. Its browser-dispatched synthetic click hasn't arrived yet.
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointerup', 10, 10, 'touch'));
    expect(c.uiState().armed).toBe('basic');
    // A second, unrelated tap starts (and completes) before that first click lands — a
    // single shared "reset suppression on new press" flag would have cleared the first
    // tap's still-pending suppression here, letting its later synthetic click through
    // unsuppressed and double-toggling. A per-suppression counter must not.
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointerup', 10, 10, 'touch'));
    expect(c.uiState().armed).toBeNull(); // second tap toggled it back off
    // Now both browser synthetic clicks arrive, in order — neither may double-toggle.
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(c.uiState().armed).toBeNull();
  });

  it('a Card move of exactly DRAG_THRESHOLD_PX (8px) is a drag — the comparison is strict (`< 8` is a tap), so the boundary itself arms', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointermove', 18, 10, 'touch')); // exactly 8px — NOT `< 8`, so a drag
    expect(c.uiState().armed).toBe('basic'); // armed by the drag, not a tap-toggle
  });

  it('a Card move of 9px (above DRAG_THRESHOLD_PX = 8) is a drag — arms and starts press-adjust-release mapped onto the board', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointermove', 19, 10, 'touch')); // 9px — over the threshold
    expect(c.uiState().armed).toBe('basic'); // armed by the drag, not a tap-toggle
    // The move is mapped onto the board via the same offset transform: client (35,105) →
    // finger cell (3,10) → anchor (3, 10-2=8).
    card.dispatchEvent(ptr('pointermove', 35, 105, 'touch'));
    expect(c.frame().ghost).toMatchObject({ col: 3, row: 8 });
  });

  it('a valid drag-from-rail release places (disarm → select)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointermove', 35, 105, 'touch')); // crosses threshold, anchor (3,8)
    card.dispatchEvent(ptr('pointerup', 35, 105, 'touch'));
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1);
    expect(c.uiState().armed).toBeNull();
    expect(c.uiState().selection).toMatchObject({ col: 3, row: 8 });
  });

  it('an off-board / invalid / chrome drag release cancels AND disarms (unlike the board-native drag)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointermove', 35, 105, 'touch')); // crosses threshold, armed
    card.dispatchEvent(ptr('pointerup', 9999, 9999, 'touch')); // released off the board entirely
    expect(c.uiState().armed).toBeNull(); // cancelled AND disarmed
    expect(c.frame().ghost).toBeNull();
  });

  it('an invalid-cell drag release also disarms (drag-flow, unlike a board-origin invalid release)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    c.armTower('basic');
    board.dispatchEvent(ptr('pointerdown', 35, 65, 'touch')); // build at (3,6) directly
    board.dispatchEvent(ptr('pointerup', 35, 65, 'touch'));
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1);

    // Now drag the Card onto that SAME (now-occupied) cell.
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointermove', 35, 65, 'touch')); // maps to the occupied anchor
    card.dispatchEvent(ptr('pointerup', 35, 65, 'touch'));
    expect(c.uiState().armed).toBeNull(); // rejected AND disarmed — drag-flow, not tap-flow
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1); // no second tower
  });

  it('a release over Shell chrome cancels a Card drag AND disarms', () => {
    const chrome = document.createElement('div');
    chrome.className = 'wy-status';
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
      elementFromPoint: () => chrome,
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointermove', 35, 105, 'touch')); // crosses threshold, armed
    card.dispatchEvent(ptr('pointerup', 35, 105, 'touch'));
    expect(c.uiState().armed).toBeNull();
  });

  it('a Card press cancelled BEFORE the drag threshold performs no toggle — preserves the pre-gesture armed state (initially unarmed)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    expect(c.uiState().armed).toBeNull();
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointercancel', 10, 10, 'touch'));
    expect(c.uiState().armed).toBeNull(); // never touched
  });

  it('a Card press cancelled BEFORE the drag threshold performs no toggle — preserves the pre-gesture armed state (initially armed)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    c.armTower('basic');
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointercancel', 10, 10, 'touch'));
    expect(c.uiState().armed).toBe('basic'); // still armed — the cancelled press never toggled it
  });

  it('a Card drag cancelled AFTER crossing the threshold disarms (uniform cancellation)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointermove', 35, 105, 'touch')); // crosses threshold, armed
    expect(c.uiState().armed).toBe('basic');
    card.dispatchEvent(ptr('pointercancel', 10, 10, 'touch'));
    expect(c.uiState().armed).toBeNull();
    expect(c.frame().ghost).toBeNull();
  });

  it('mouse Card interaction is untouched — no drag-from-rail, pointer events on the Card no-op', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'mouse'));
    card.dispatchEvent(ptr('pointermove', 35, 105, 'mouse')); // far past the drag threshold
    card.dispatchEvent(ptr('pointerup', 35, 105, 'mouse'));
    expect(c.uiState().armed).toBeNull(); // input.ts's Card pointer handling ignores mouse entirely
    expect(c.frame().ghost).toBeNull();
  });

  it('a drag release over the board does NOT arm click-suppression — a genuine Card click within the expiry window is not swallowed', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
      elementFromPoint: () => board, // the release point resolves to the board, not the Card
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointermove', 35, 105, 'touch')); // crosses threshold, armed
    card.dispatchEvent(ptr('pointerup', 35, 105, 'touch')); // released over the board — no Card-targeted synthetic click is coming
    expect(c.uiState().armed).toBeNull(); // placed as usual, unrelated to suppression

    // A genuine mouse click on the Card, well within SUPPRESS_CLICK_EXPIRY_MS, must reach
    // it unsuppressed — `onDocumentClickCapture` only preventDefault()s/stopPropagation()s
    // a click it's actively suppressing, so an unsuppressed click's `defaultPrevented`
    // stays false and it's free to arm (via overlay.ts's own click-toggle listener, not
    // wired in this input-only test harness).
    const genuineClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    card.dispatchEvent(genuineClick);
    expect(genuineClick.defaultPrevented).toBe(false);
  });

  it('a second concurrent contact voids a Card gesture regardless of origin (cross-origin multi-touch)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    board.dispatchEvent(ptr('pointerdown', 35, 35, 'touch', 0, 1)); // board finger down
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch', 0, 2)); // Card finger down (concurrent!)
    card.dispatchEvent(ptr('pointermove', 35, 105, 'touch', 0, 2)); // would have crossed threshold
    card.dispatchEvent(ptr('pointerup', 35, 105, 'touch', 0, 2));
    board.dispatchEvent(ptr('pointerup', 35, 35, 'touch', 0, 1));
    expect(c.uiState().armed).toBeNull(); // both voided — no arm, no build
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0);
  });

  it('a Card drag already past the threshold that gets voided mid-flight (by a concurrent second contact) disarms and clears the ghost on release — the SAME cancellation contract as pointercancel', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch', 0, 1)); // finger A: Card press
    card.dispatchEvent(ptr('pointermove', 35, 105, 'touch', 0, 1)); // crosses threshold: armed + ghost
    expect(c.uiState().armed).toBe('basic');
    expect(c.frame().ghost).not.toBeNull();
    board.dispatchEvent(ptr('pointerdown', 50, 50, 'touch', 0, 2)); // finger B: concurrent contact voids A
    card.dispatchEvent(ptr('pointerup', 35, 105, 'touch', 0, 1)); // A releases — voided, was dragging
    expect(c.uiState().armed).toBeNull(); // disarmed, not left invisibly armed
    expect(c.frame().ghost).toBeNull(); // cleared
  });

  it('a drag STARTED FROM a card SWITCHES the armed tower — basic armed, drag from the slow Card places slow (Codex R1-6, M2-S3)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    const card2 = document.createElement('button');
    document.body.appendChild(card2);
    attachInput(
      document,
      board,
      [
        { el: card, towerId: 'basic' },
        { el: card2, towerId: 'slow' },
      ],
      c,
      createKeymap(),
      { getRect: () => RECT },
    );
    c.armTower('basic');
    expect(c.uiState().armed).toBe('basic');
    // The OLD guard (`armed === null`) would have left `basic` armed here — the drag
    // threshold guard must be `armed !== card.towerId`, so a drag from a DIFFERENT
    // card's Card switches instead of no-op'ing.
    card2.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card2.dispatchEvent(ptr('pointermove', 30, 10, 'touch')); // well past the threshold
    expect(c.uiState().armed).toBe('slow'); // switched
    card2.dispatchEvent(ptr('pointerup', 30, 10, 'touch'));
    c.advance(50);
    const towers = c.frame().curVm.towers;
    expect(towers).toHaveLength(1);
    // The committed tower is the slow one — asserted via the pending/committed towerId
    // the shared projection carries (state SoA), not merely "a tower exists".
    expect(c.uiState().selection?.towerId).toBe('slow');
  });
});

describe('input — letterbox margin: out-of-grid is a no-target, not an edge cell (PLAN.md P3)', () => {
  it('a board press-and-release in the margin places nothing and stays armed (tap-flow) — the raw margin cell is never clamped onto an edge cell', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [], c, createKeymap(), { getRect: () => LETTERBOX });
    c.armTower('basic');
    board.dispatchEvent(ptr('pointerdown', 5, 105, 'touch')); // x=5: inside the board rect, in the left margin
    expect(c.frame().ghost).toBeNull(); // no target shown — never snapped to edge col 0
    board.dispatchEvent(ptr('pointerup', 5, 105, 'touch'));
    expect(c.uiState().armed).not.toBeNull(); // board tap-flow stays armed
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0); // nothing placed on an edge cell
  });

  it('adjusting from in-grid into the margin hides the ghost; returning to the grid restores it', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [], c, createKeymap(), { getRect: () => LETTERBOX });
    c.armTower('basic');
    board.dispatchEvent(ptr('pointerdown', 45, 105, 'touch')); // finger (3,10) → anchor (3,8), in-grid
    expect(c.frame().ghost).toMatchObject({ col: 3, row: 8 });
    board.dispatchEvent(ptr('pointermove', 5, 105, 'touch')); // into the left margin
    expect(c.frame().ghost).toBeNull(); // target cleared — honest "no target" feedback
    board.dispatchEvent(ptr('pointermove', 45, 105, 'touch')); // back onto the grid
    expect(c.frame().ghost).toMatchObject({ col: 3, row: 8 }); // restored
  });

  it('a Card drag released in the margin cancels AND disarms (drag-flow, unlike the board tap-flow)', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => LETTERBOX,
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointermove', 45, 105, 'touch')); // crosses the threshold onto the grid, armed
    expect(c.uiState().armed).toBe('basic');
    card.dispatchEvent(ptr('pointerup', 5, 105, 'touch')); // released in the left margin (inside the board rect)
    expect(c.uiState().armed).toBeNull(); // drag-flow disarms — no edge-cell placement
    expect(c.frame().ghost).toBeNull();
  });

  it('an in-grid finger on a letterboxed layout still places with the origin offset applied — only the margin is a no-target', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [], c, createKeymap(), { getRect: () => LETTERBOX });
    c.armTower('basic');
    board.dispatchEvent(ptr('pointerdown', 45, 105, 'touch')); // finger (3,10) → anchor (3,8), inside the grid
    board.dispatchEvent(ptr('pointerup', 45, 105, 'touch'));
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1); // placed — the origin offset is honored, not clamped away
    expect(c.uiState().selection).toMatchObject({ col: 3, row: 8 });
  });
});

describe('input — cleanup: destroy(), reset(), abort() (PLAN.md P3)', () => {
  it('destroy() removes the contextmenu long-press-suppression listeners from the board and every Card', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    const handle = attachInput(
      document,
      board,
      [{ el: card, towerId: 'basic' }],
      c,
      createKeymap(),
      { getRect: () => RECT },
    );
    const boardEvt = new Event('contextmenu', { cancelable: true, bubbles: true });
    board.dispatchEvent(boardEvt);
    expect(boardEvt.defaultPrevented).toBe(true);
    const cardEvt = new Event('contextmenu', { cancelable: true, bubbles: true });
    card.dispatchEvent(cardEvt);
    expect(cardEvt.defaultPrevented).toBe(true);

    handle.destroy();
    const boardEvt2 = new Event('contextmenu', { cancelable: true, bubbles: true });
    board.dispatchEvent(boardEvt2);
    expect(boardEvt2.defaultPrevented).toBe(false);
    const cardEvt2 = new Event('contextmenu', { cancelable: true, bubbles: true });
    card.dispatchEvent(cardEvt2);
    expect(cardEvt2.defaultPrevented).toBe(false);
  });

  it('reset() clears the pointer registry — a stray release after reset is not treated as a click', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    const handle = attachInput(
      document,
      board,
      [{ el: card, towerId: 'basic' }],
      c,
      createKeymap(),
      { getRect: () => RECT },
    );
    board.dispatchEvent(ptr('pointerdown', 35, 35, 'touch', 0, 1)); // press started on board
    handle.reset();
    board.dispatchEvent(ptr('pointerup', 35, 35, 'touch', 0, 1)); // reset cleared the press origin
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0);
  });

  it('abort() cancels an in-flight board gesture (stays armed, ghost cleared) and a Card drag (disarms) — the P5 rotate-abort surface', () => {
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    const handle = attachInput(
      document,
      board,
      [{ el: card, towerId: 'basic' }],
      c,
      createKeymap(),
      { getRect: () => RECT },
    );
    c.armTower('basic');
    board.dispatchEvent(ptr('pointerdown', 35, 105, 'touch'));
    expect(c.frame().ghost).not.toBeNull();
    handle.abort();
    expect(c.frame().ghost).toBeNull();
    expect(c.uiState().armed).toBe('basic'); // board-origin stays armed

    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch', 0, 9));
    card.dispatchEvent(ptr('pointermove', 35, 105, 'touch', 0, 9)); // crosses threshold
    expect(c.uiState().armed).toBe('basic');
    handle.abort();
    expect(c.uiState().armed).toBeNull(); // Card-drag disarms
    expect(c.frame().ghost).toBeNull();
  });
});

describe('input — modal-open commit guard (the class guard)', () => {
  it('a board release while the Shell is inert commits nothing and stays armed — no abort needed', () => {
    // The belt-and-suspenders guard, independent of any modal opener remembering to abort():
    // a pointer captured on the board before a modal opened still routes its pointerup here,
    // even though the board is now inert. Model the ground truth `main.ts` reads — the
    // Shell's own `inert` attribute — rather than a bare boolean.
    const shellHost = document.createElement('div');
    document.body.appendChild(shellHost);
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
      isModalOpen: () => shellHost.hasAttribute('inert'),
    });
    c.armTower('basic');
    board.dispatchEvent(ptr('pointerdown', 35, 105, 'touch')); // held, anchor (3,8), valid ghost
    expect(c.frame().ghost).not.toBeNull();

    shellHost.setAttribute('inert', ''); // a modal opens while the gesture is held; NO abort() ran

    board.dispatchEvent(ptr('pointerup', 35, 105, 'touch'));
    expect(c.uiState().armed).toBe('basic'); // board-origin cancellation semantics: stays armed…
    expect(c.frame().ghost).toBeNull(); // …ghost cleared
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0); // nothing queued behind the inert Shell
  });

  it('a Card-drag release while the Shell is inert commits nothing and disarms — no abort needed', () => {
    const shellHost = document.createElement('div');
    document.body.appendChild(shellHost);
    const c = createController(1);
    c.start();
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
      isModalOpen: () => shellHost.hasAttribute('inert'),
    });
    card.dispatchEvent(ptr('pointerdown', 10, 10, 'touch'));
    card.dispatchEvent(ptr('pointermove', 35, 105, 'touch')); // crosses the drag threshold → arms
    expect(c.uiState().armed).toBe('basic');

    shellHost.setAttribute('inert', ''); // modal opens mid-drag, NO abort() ran

    card.dispatchEvent(ptr('pointerup', 35, 105, 'touch')); // over a valid board cell
    expect(c.uiState().armed).toBeNull(); // Card-drag cancellation semantics: disarms
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0); // nothing placed
  });

  it('leaves a normal release untouched when no modal is open (guard is inert-gated)', () => {
    // Regression guard: with the default (never-open) signal, the commit path is unchanged.
    const c = createController(1);
    c.start();
    attachInput(document, board, [{ el: card, towerId: 'basic' }], c, createKeymap(), {
      getRect: () => RECT,
    });
    c.armTower('basic');
    board.dispatchEvent(ptr('pointerdown', 35, 105, 'touch'));
    board.dispatchEvent(ptr('pointerup', 35, 105, 'touch')); // valid ghost → commits normally
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(1);
    expect(c.uiState().armed).toBeNull(); // committed → disarmed → selected
  });
});
