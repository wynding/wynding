// input.ts — pointer + keyboard capture, translated into controller commands (ADR 0003
// §2: full functionality across touch / mouse / keyboard). Lives in apps/web (it PRODUCES
// commands) so @wynding/render keeps its no-mutation charter. The pointer→cell mapping
// uses the render projection's inverse transform, so the cell the player sees is the cell
// the command targets. Keyboard uses the rebindable keymap and drives a focusable board
// cursor. Desktop = hover-preview + click-commit; touch = two-tap preview-then-confirm.

import { createProjection, type Projection } from '@wynding/render';
import type { Controller } from './controller';
import type { Keymap } from './keymap';

export interface InputHandle {
  destroy(): void;
  /** Clear all gesture-tracking state (#40): the armed touch two-tap, per-pointer press
   *  origins, and the concurrent-touch active/voided sets. Call on every new run identity
   *  (Play-again) — a gesture begun under the previous run must never carry across and be
   *  misread as a confirm/void against the fresh one. */
  reset(): void;
}

export interface InputOptions {
  /** Board element rect provider (injectable for tests; jsdom rects are zero-size). */
  getRect?: () => { left: number; top: number; width: number; height: number };
  /** Monotonic clock for the touch two-tap window (injectable for tests). */
  now?: () => number;
}

/** How long (ms) a first touch-tap stays "armed" for a confirming second tap on the same
 *  cell. A later tap on that cell is treated as a fresh preview, not a commit. */
const TOUCH_CONFIRM_MS = 1200;

/** Attach input handling to `boardEl` for `controller`. Returns a handle to detach. */
export function attachInput(
  doc: Document,
  boardEl: HTMLElement,
  controller: Controller,
  keymap: Keymap,
  options: InputOptions = {},
): InputHandle {
  const grid = controller.ruleset.board.grid;
  const getRect = options.getRect ?? (() => boardEl.getBoundingClientRect() as DOMRect);

  // Memoize the projection on the board size — it only changes on resize, so a rapid
  // stream of pointermoves reuses one projection instead of allocating per event. Only
  // pointerToCell is used here (pure CSS-px), so dpr is irrelevant — it's fixed at 1.
  let cached: { w: number; h: number; projection: Projection } | null = null;
  const projectionFor = (r: { width: number; height: number }): Projection => {
    if (cached === null || cached.w !== r.width || cached.h !== r.height) {
      cached = {
        w: r.width,
        h: r.height,
        projection: createProjection({
          cols: grid.width,
          rows: grid.height,
          cssWidth: r.width,
          cssHeight: r.height,
          dpr: 1,
        }),
      };
    }
    return cached.projection;
  };

  const cellFromEvent = (clientX: number, clientY: number): { col: number; row: number } | null => {
    // One layout read per pointer event (getBoundingClientRect forces reflow): build/reuse
    // the projection from the same rect used for the client→local offset.
    const r = getRect();
    return projectionFor(r).pointerToCell(clientX - r.left, clientY - r.top);
  };

  // Touch two-tap: the first tap previews (aims); a second tap on the SAME cell WITHIN the
  // confirm window commits. A tap on that cell after the window (the player moved on and
  // came back) is a fresh preview, not an accidental build. `at` timestamps the first tap.
  const now = options.now ?? (() => Date.now());
  let pendingTouch: { col: number; row: number; at: number } | null = null;
  // Click semantics: a commit requires the press to have STARTED on the board. Without
  // this, a drag that begins off-board (or on a HUD button) and releases over a valid cell
  // would build a tower — pointerup targets whatever is under the pointer at release.
  // Per-pointer (not a single shared flag) — otherwise finger A's press-on-board legitimises
  // finger B's off-board-started release.
  const pressOriginIds = new Set<number>();
  // Touch pointers currently down, and touch ids voided by a concurrent second (or third+)
  // contact — a fat-finger double contact or pinch must never read as preview-then-confirm.
  const activeTouchIds = new Set<number>();
  const voidedTouchIds = new Set<number>();

  const onPointerDown = (e: PointerEvent): void => {
    pressOriginIds.add(e.pointerId);
    if (e.pointerType === 'touch') {
      if (activeTouchIds.size > 0) {
        pendingTouch = null;
        for (const id of activeTouchIds) voidedTouchIds.add(id);
        voidedTouchIds.add(e.pointerId);
      }
      activeTouchIds.add(e.pointerId);
    }
    // Capture the pointer so its pointerup fires on the board even if released off-board —
    // otherwise a press that starts on the board and releases outside would leave the
    // press-origin flag stuck true and mis-classify a later off-board gesture as a click.
    if (typeof boardEl.setPointerCapture === 'function') {
      try {
        boardEl.setPointerCapture(e.pointerId);
      } catch {
        /* invalid/absent pointerId (e.g. synthetic events) — capture just not available */
      }
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return; // no hover on touch
    const cell = cellFromEvent(e.clientX, e.clientY);
    // Hover previews the build ghost only — it must NOT clear a tower selection (else the
    // mouse loses the selection en route to the DOM Sell button).
    if (cell !== null) controller.previewAt(cell.col, cell.row);
  };

  const onPointerUp = (e: PointerEvent): void => {
    const startedOnBoard = pressOriginIds.has(e.pointerId);
    pressOriginIds.delete(e.pointerId);
    const isTouch = e.pointerType === 'touch';
    let voided = false;
    if (isTouch) {
      voided = voidedTouchIds.has(e.pointerId);
      activeTouchIds.delete(e.pointerId);
      voidedTouchIds.delete(e.pointerId);
    }
    if (e.button !== 0) {
      // primary button / touch only — reject right/middle (>0) and the "no button changed"
      // sentinel (-1, e.g. a stylus hover lift); a touch release still clears any arming.
      if (isTouch) pendingTouch = null;
      return;
    }
    if (!startedOnBoard) {
      // a press that did not start on the board is not a click — ignore it, but a touch
      // release still ends any armed preview (uniform touch-tap rule: every release clears
      // unless it explicitly confirms or arms).
      if (isTouch) pendingTouch = null;
      return;
    }
    if (isTouch && voided) {
      // a release from a gesture voided by a concurrent second (or third+) touch contact
      // neither aims, arms, nor confirms.
      pendingTouch = null;
      return;
    }
    const cell = cellFromEvent(e.clientX, e.clientY);
    if (cell === null) {
      if (isTouch) pendingTouch = null; // off-board release clears an armed first tap
      return;
    }
    const res = controller.aimAt(cell.col, cell.row);
    if (isTouch) {
      const t = now();
      const fresh =
        pendingTouch !== null &&
        pendingTouch.col === cell.col &&
        pendingTouch.row === cell.row &&
        t - pendingTouch.at <= TOUCH_CONFIRM_MS;
      if (res.kind === 'ghost' && res.valid && fresh) {
        controller.confirm(); // second tap on the same armed cell within the window
        pendingTouch = null;
      } else if (res.kind === 'ghost' && res.valid) {
        pendingTouch = { col: cell.col, row: cell.row, at: t }; // first tap arms the preview
      } else {
        pendingTouch = null; // tower select, blocked, or invalid ghost — never arms
      }
    } else if (res.kind === 'ghost' && res.valid) {
      controller.confirm();
    }
  };

  // A cancelled pointer (scroll, gesture, off-screen) clears the armed first tap and the
  // press-origin/touch-tracking state so a subsequent stray release can't be treated as a
  // click or inherit a stale void.
  const onPointerCancel = (e: PointerEvent): void => {
    pendingTouch = null;
    pressOriginIds.delete(e.pointerId);
    if (e.pointerType === 'touch') {
      activeTouchIds.delete(e.pointerId);
      voidedTouchIds.delete(e.pointerId);
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const action = keymap.actionFor(e.code);
    if (action === null) return;
    e.preventDefault();
    // Auto-repeat only drives cursor movement (held arrow keeps moving); discrete actions
    // (confirm/sell/callWave/pause/speed) are edge-triggered — a held key must not repeat
    // them. preventDefault() still ran above, so the key stays consumed (no page scroll).
    const isMovement =
      action === 'up' || action === 'down' || action === 'left' || action === 'right';
    if (e.repeat && !isMovement) return;
    switch (action) {
      case 'up':
        controller.moveCursor(0, -1);
        break;
      case 'down':
        controller.moveCursor(0, 1);
        break;
      case 'left':
        controller.moveCursor(-1, 0);
        break;
      case 'right':
        controller.moveCursor(1, 0);
        break;
      case 'confirm':
        controller.confirm();
        break;
      case 'sell':
        controller.sellSelected();
        break;
      case 'callWave':
        controller.callWaveEarly();
        break;
      case 'pause':
        controller.togglePause();
        break;
      case 'speed':
        controller.cycleSpeed();
        break;
    }
  };

  boardEl.addEventListener('pointerdown', onPointerDown as EventListener);
  boardEl.addEventListener('pointermove', onPointerMove as EventListener);
  boardEl.addEventListener('pointerup', onPointerUp as EventListener);
  boardEl.addEventListener('pointercancel', onPointerCancel as EventListener);
  boardEl.addEventListener('keydown', onKeyDown as EventListener);

  return {
    destroy(): void {
      boardEl.removeEventListener('pointerdown', onPointerDown as EventListener);
      boardEl.removeEventListener('pointercancel', onPointerCancel as EventListener);
      boardEl.removeEventListener('pointermove', onPointerMove as EventListener);
      boardEl.removeEventListener('pointerup', onPointerUp as EventListener);
      boardEl.removeEventListener('keydown', onKeyDown as EventListener);
    },
    reset(): void {
      pendingTouch = null;
      pressOriginIds.clear();
      activeTouchIds.clear();
      voidedTouchIds.clear();
    },
  };
}
