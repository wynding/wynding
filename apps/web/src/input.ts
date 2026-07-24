// input.ts — pointer + keyboard capture, translated into controller commands (ADR 0003
// §2: full functionality across touch / mouse / keyboard). Lives in apps/web (it PRODUCES
// commands) so @wynding/render keeps its no-mutation charter. The pointer→cell mapping
// uses the render projection's inverse transform, so the cell the player sees is the cell
// the command targets. Keyboard uses the rebindable keymap and drives a focusable board
// cursor. Desktop (mouse) = hover-preview + click-commit (PLAN.md P2); touch/pen (treated
// identically) = press-adjust-release with the offset ghost (PLAN.md P3) — the two-tap
// confirm is gone, touch never requires tapping the same cell twice.
//
// ONE input manager owns pointer state across BOTH origins (the board and every Card): a
// single `presses` registry keyed by pointerId, and a single active/voided-touch pair
// (`activeIds`/`voidedIds`) — a second concurrent touch contact voids the gesture in
// flight regardless of which origin it lands on (#40's discipline, extended in P3).

import { createProjection, type Projection } from '@wynding/render';
import type { Controller } from './controller';
import type { Keymap } from './keymap';

export interface InputHandle {
  destroy(): void;
  /** Clear all gesture-tracking state (#40): the pointer registry and the concurrent-
   *  touch active/voided sets. Call on every new run identity (Play-again) — a gesture
   *  begun under the previous run must never carry across and be misread against the
   *  fresh one. */
  reset(): void;
  /** Cancel any active placement gesture across both origins, with the SAME semantics as
   *  a `pointercancel`/`lostpointercapture` (PLAN.md P3): ghost cleared always; a
   *  board-origin gesture stays armed, a Card-drag gesture disarms; capture released,
   *  registry cleaned. Not wired to anything in this packet — this is the API surface P5's
   *  rotate-entry handler calls to abort an in-flight gesture when the viewport flips to
   *  portrait. */
  abort(): void;
}

export interface InputOptions {
  /** Board element rect provider (injectable for tests; jsdom rects are zero-size). */
  getRect?: () => { left: number; top: number; width: number; height: number };
  /** Hit-test for the Shell-chrome release rule (injectable — jsdom's `elementFromPoint`
   *  is a no-op stub that always returns null). Defaults to `doc.elementFromPoint`. */
  elementFromPoint?: (x: number, y: number) => Element | null;
}

/** How many cells above the finger's cell the armed touch/pen ghost is offset, so the
 *  finger never covers the footprint it's aiming (PLAN.md P3). */
const TOUCH_GHOST_OFFSET_CELLS = 2;

/** The tower footprint size — a local mirror of `packages/sim`'s fixed 2×2 footprint (no
 *  exported constant; see `packages/sim/src/tower.ts`'s `FOOTPRINT_DELTAS` and
 *  `packages/render/src/scene.ts`'s own inline `× 2`, both of which do the same). */
const TOWER_FOOTPRINT = 2;

/** A drag-from-rail only begins once the pointer travels this far from its press origin;
 *  under the threshold the gesture is a tap (PLAN.md P3). */
const DRAG_THRESHOLD_PX = 8;

/** Shell chrome the release hit-test checks against (Dock/Status bar/Rail) — a release
 *  geometrically over any of these never commits a placement, even if it lands on a cell
 *  the Dock happens to overlap (PLAN.md P1's Dock overlaps the board's bottom-left). */
const CHROME_SELECTOR = '.wy-dock, .wy-status, .wy-rail';

const isTouchLike = (pointerType: string): boolean =>
  pointerType === 'touch' || pointerType === 'pen';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** One in-flight gesture, tracked from its `pointerdown` to its release/cancel. `dragging`
 *  only matters for Card-origin presses (has this crossed `DRAG_THRESHOLD_PX` yet?) — a
 *  board-origin press is always in press-adjust-release mode from the first pointerdown. */
interface PressEntry {
  readonly origin: 'board' | 'card';
  readonly cardEl?: HTMLElement;
  readonly startX: number;
  readonly startY: number;
  dragging: boolean;
}

/** Attach input handling to `boardEl` + `cardEls` for `controller`. Returns a handle to
 *  detach. `cardEls` is every Rail Card (M1 ships exactly one, PLAN.md P2) — Card gestures
 *  need the input manager's shared pointer registry (PLAN.md P3), so they're wired here
 *  rather than left to `overlay.ts`'s plain `click` listener (which still owns the MOUSE
 *  click-toggle path unchanged). */
export function attachInput(
  doc: Document,
  boardEl: HTMLElement,
  cardEls: readonly HTMLElement[],
  controller: Controller,
  keymap: Keymap,
  options: InputOptions = {},
): InputHandle {
  const grid = controller.ruleset.board.grid;
  const getRect = options.getRect ?? (() => boardEl.getBoundingClientRect() as DOMRect);
  // jsdom has no `elementFromPoint` at all (not even a null-returning stub) — default to
  // "never over chrome" rather than throwing when the browser API is absent.
  const elementFromPoint =
    options.elementFromPoint ??
    (typeof doc.elementFromPoint === 'function'
      ? (x: number, y: number) => doc.elementFromPoint(x, y)
      : () => null);

  // Memoize the projection on the board size — it only changes on resize, so a rapid
  // stream of pointermoves reuses one projection instead of allocating per event. Only
  // pointerToCell/originX/originY/cellPx are used here (pure CSS-px), so dpr is
  // irrelevant — it's fixed at 1.
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

  // The finger's cell, CLAMPED into the grid rather than null outside it — the offset
  // ghost's anchor must always resolve to something clampable in-bounds (PLAN.md P3: "the
  // anchor always clamped so the footprint is in-bounds"), unlike `cellFromEvent`'s null-
  // outside-the-board semantics (used for the mouse click / unarmed-touch-select paths,
  // which target the ACTUAL cell, never an offset one).
  const fingerCellFromEvent = (clientX: number, clientY: number): { col: number; row: number } => {
    const r = getRect();
    const p = projectionFor(r);
    const localX = clientX - r.left;
    const localY = clientY - r.top;
    const rawCol = Math.floor((localX - p.originX) / p.cellPx);
    const rawRow = Math.floor((localY - p.originY) / p.cellPx);
    return {
      col: clamp(rawCol, 0, grid.width - 1),
      row: clamp(rawRow, 0, grid.height - 1),
    };
  };

  // The armed offset-ghost anchor for a raw pointer point (PLAN.md P3): 2 cells above the
  // finger's cell; flips BELOW (never reduces to under-the-finger) when there isn't room
  // above for the offset + the 2×2 footprint; the anchor is then clamped so the footprint
  // never leaves the grid.
  const ghostAnchorFromPoint = (clientX: number, clientY: number): { col: number; row: number } => {
    const finger = fingerCellFromEvent(clientX, clientY);
    const above = finger.row - TOUCH_GHOST_OFFSET_CELLS;
    const row = above >= 0 ? above : finger.row + 1;
    return {
      col: clamp(finger.col, 0, grid.width - TOWER_FOOTPRINT),
      row: clamp(row, 0, grid.height - TOWER_FOOTPRINT),
    };
  };

  /** Update the armed ghost from a raw pointer point, mapped through the offset transform.
   *  A no-op while unarmed (`previewAt` itself guards that) — shared by board touch/pen
   *  moves AND Card-drag moves (mapped onto the board, PLAN.md P3). */
  const updateGhostFromPoint = (clientX: number, clientY: number): void => {
    const anchor = ghostAnchorFromPoint(clientX, clientY);
    controller.previewAt(anchor.col, anchor.row);
  };

  /** Clear the ghost WITHOUT disarming — `previewAt` with an out-of-bounds cell nulls the
   *  ghost and returns before touching `armed` or `cur` (see controller.ts), which is
   *  exactly the board-origin cancellation contract (PLAN.md P3): "ghost cleared... stays
   *  armed." A no-op while already unarmed (nothing to clear). */
  const clearGhostOnly = (): void => {
    controller.previewAt(-1, -1);
  };

  /** Disarm (if armed) and clear the ghost — the Card-drag cancellation/invalid-release
   *  contract (PLAN.md P3): "cancels AND disarms." `escape()` is a no-op while unarmed
   *  (nothing to undo) and, when a tower happens to be selected, would deselect it too —
   *  but a Card-drag gesture never leaves `armed === null` with a selection mid-flight, so
   *  that branch is unreachable here. */
  const disarmAndClearGhost = (): void => {
    if (controller.uiState().armed !== null) controller.escape();
  };

  const isWithinBoardRect = (clientX: number, clientY: number): boolean => {
    const r = getRect();
    return (
      clientX >= r.left &&
      clientX <= r.left + r.width &&
      clientY >= r.top &&
      clientY <= r.top + r.height
    );
  };

  /** Shell-chrome hit-test (PLAN.md P3): a release geometrically over the Dock/Status
   *  bar/Rail never commits, even when it also maps to an in-bounds board cell (the Dock
   *  overlaps the board's bottom-left corner, PLAN.md P1). */
  const isOverChrome = (clientX: number, clientY: number): boolean => {
    const el = elementFromPoint(clientX, clientY);
    return el !== null && el.closest(CHROME_SELECTOR) !== null;
  };

  /** Is `clientX,clientY` geometrically over `target` (or one of its descendants)? Used to
   *  gate the Card-drag click-suppression arm (below) to releases that will actually
   *  produce a Card-targeted synthetic click — a release over the board never does. */
  const isOverElement = (clientX: number, clientY: number, target: HTMLElement): boolean => {
    const el = elementFromPoint(clientX, clientY);
    return el !== null && (el === target || target.contains(el));
  };

  const capture = (el: HTMLElement, pointerId: number): void => {
    if (typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(pointerId);
      } catch {
        /* invalid/absent pointerId (e.g. synthetic events) — capture just not available */
      }
    }
  };
  const releaseCapture = (el: HTMLElement, pointerId: number): void => {
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        /* not captured, or an invalid pointerId — nothing to release */
      }
    }
  };

  // The shared gesture registry (PLAN.md P3): one entry per live pointerId, across BOTH
  // origins. `activeIds`/`voidedIds` extend #40's multi-touch voiding discipline across
  // origins too — a second concurrent touch/pen contact voids the gesture in flight no
  // matter which element (board or Card) it lands on.
  const presses = new Map<number, PressEntry>();
  const activeIds = new Set<number>();
  const voidedIds = new Set<number>();

  // Suppresses the synthetic `click` a browser dispatches after a touch/pen tap/drag on a
  // Card — otherwise `overlay.ts`'s own `click` listener would double-toggle armed (tap)
  // or fire a stray toggle after a drag that already placed/cancelled (PLAN.md P3). A
  // document-level CAPTURING listener guarantees this runs before the click reaches the
  // Card's own bubble-phase listener regardless of registration order.
  //
  // A COUNTER of pending suppressions, not a single flag: a flag reset at the start of
  // every new press can be cleared by an unrelated gesture that starts before the previous
  // gesture's still-pending synthetic click has arrived, letting that click through
  // unsuppressed. Each completed tap/drag arms its own expiring timer (guards against a
  // synthetic click that never fires at all, e.g. an aborted gesture, permanently
  // inflating the counter); consuming a suppression cancels the oldest pending timer so it
  // can't later fire and steal a decrement meant for a different, still-legitimate one.
  const SUPPRESS_CLICK_EXPIRY_MS = 500;
  let pendingClickSuppressions = 0;
  const pendingSuppressionTimers: Array<ReturnType<typeof setTimeout>> = [];
  const armClickSuppression = (): void => {
    pendingClickSuppressions++;
    const timer = setTimeout(() => {
      const idx = pendingSuppressionTimers.indexOf(timer);
      if (idx !== -1) pendingSuppressionTimers.splice(idx, 1);
      pendingClickSuppressions = Math.max(0, pendingClickSuppressions - 1);
    }, SUPPRESS_CLICK_EXPIRY_MS);
    pendingSuppressionTimers.push(timer);
  };
  const clearPendingSuppressionTimers = (): void => {
    for (const timer of pendingSuppressionTimers) clearTimeout(timer);
    pendingSuppressionTimers.length = 0;
    pendingClickSuppressions = 0;
  };
  const onDocumentClickCapture = (e: MouseEvent): void => {
    if (pendingClickSuppressions <= 0) return;
    const target = e.target as Element | null;
    if (target !== null && cardEls.some((c) => c === target || c.contains(target))) {
      pendingClickSuppressions--;
      const timer = pendingSuppressionTimers.shift(); // the oldest pending suppression
      if (timer !== undefined) clearTimeout(timer);
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const registerTouchLike = (pointerId: number, pointerType: string): void => {
    if (!isTouchLike(pointerType)) return;
    if (activeIds.size > 0) {
      for (const id of activeIds) voidedIds.add(id);
      voidedIds.add(pointerId);
    }
    activeIds.add(pointerId);
  };

  /** The uniform cancellation contract (PLAN.md P3), shared by `pointercancel`,
   *  `lostpointercapture`, and `abort()`: ghost cleared always; board-origin stays armed;
   *  Card-drag disarms (a Card press cancelled BEFORE crossing the drag threshold performs
   *  no toggle at all — armed was never touched, so there's nothing to undo). */
  const cancelPress = (pointerId: number, press: PressEntry): void => {
    if (press.origin === 'board') {
      clearGhostOnly();
      releaseCapture(boardEl, pointerId);
    } else {
      if (press.dragging) disarmAndClearGhost();
      releaseCapture(press.cardEl as HTMLElement, pointerId);
    }
  };

  // --- Board: mouse keeps P2 hover/click verbatim; touch/pen is press-adjust-release ---

  const onBoardPointerDown = (e: PointerEvent): void => {
    presses.set(e.pointerId, {
      origin: 'board',
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
    });
    registerTouchLike(e.pointerId, e.pointerType);
    // Capture the pointer so its pointerup fires on the board even if released off-board —
    // otherwise a press that starts on the board and releases outside would leave the
    // press-origin entry stuck and mis-classify a later off-board gesture as a click.
    capture(boardEl, e.pointerId);
    if (isTouchLike(e.pointerType)) updateGhostFromPoint(e.clientX, e.clientY); // press shows the ghost
  };

  const onBoardPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      // Hover previews the build ghost only — it must NOT clear a tower selection (else the
      // mouse loses the selection en route to the DOM Sell button).
      const cell = cellFromEvent(e.clientX, e.clientY);
      if (cell !== null) controller.previewAt(cell.col, cell.row);
      return;
    }
    const press = presses.get(e.pointerId);
    if (press === undefined || press.origin !== 'board') return;
    if (voidedIds.has(e.pointerId)) return;
    updateGhostFromPoint(e.clientX, e.clientY); // moving adjusts the offset ghost
  };

  /** The board-origin touch/pen release (PLAN.md P3): unarmed is a plain single-tap
   *  select/deselect at the ACTUAL touched cell (two-tap is gone — one tap is enough);
   *  armed commits/rejects at the offset ghost's anchor via `clickAt` (which already keeps
   *  it armed with a persistent invalid ghost on rejection — exactly this packet's "release
   *  on an invalid ghost... stays armed" contract, no extra state needed here). A release
   *  over Shell chrome never commits and leaves everything as it was (tap-flow: stays
   *  armed, ghost untouched). */
  const releaseBoardTouch = (clientX: number, clientY: number): void => {
    if (controller.uiState().armed === null) {
      if (isOverChrome(clientX, clientY)) return;
      const cell = cellFromEvent(clientX, clientY);
      if (cell !== null) controller.clickAt(cell.col, cell.row);
      return;
    }
    if (isOverChrome(clientX, clientY)) return;
    const anchor = ghostAnchorFromPoint(clientX, clientY);
    controller.clickAt(anchor.col, anchor.row);
  };

  const onBoardPointerUp = (e: PointerEvent): void => {
    const press = presses.get(e.pointerId);
    presses.delete(e.pointerId);
    const isTouchy = isTouchLike(e.pointerType);
    let voided = false;
    if (isTouchy) {
      voided = voidedIds.has(e.pointerId);
      activeIds.delete(e.pointerId);
      voidedIds.delete(e.pointerId);
    }
    if (e.button !== 0) return; // primary button / touch only — reject right/middle/no-button
    if (press === undefined || press.origin !== 'board') return; // must have started on the board
    if (isTouchy && voided) {
      // Voided by a concurrent second (or third+) contact: route through the SAME
      // cancellation contract as pointercancel (PLAN.md P3) rather than a bare early-exit —
      // otherwise the offset ghost from this armed press lingers on screen (phantom ghost)
      // even though nothing gets placed. Board-origin cancellation clears the ghost but
      // keeps the tower armed (unlike Card-drag, which disarms).
      cancelPress(e.pointerId, press);
      return;
    }
    if (e.pointerType === 'mouse') {
      // Mouse: the armed/selection state machine (PLAN.md P2) — `clickAt` owns
      // cur/ghost/selection for this path entirely.
      const cell = cellFromEvent(e.clientX, e.clientY);
      if (cell !== null) controller.clickAt(cell.col, cell.row);
      return;
    }
    releaseBoardTouch(e.clientX, e.clientY);
  };

  const onBoardPointerCancelOrLost = (e: PointerEvent): void => {
    const press = presses.get(e.pointerId);
    presses.delete(e.pointerId);
    activeIds.delete(e.pointerId);
    voidedIds.delete(e.pointerId);
    if (press !== undefined && press.origin === 'board') cancelPress(e.pointerId, press);
  };

  const onBoardContextMenu = (e: Event): void => e.preventDefault(); // long-press suppression

  // --- Keyboard (unchanged by P3) ---

  const onKeyDown = (e: KeyboardEvent): void => {
    const action = keymap.actionFor(e.code);
    if (action === null) return;
    e.preventDefault();
    // Auto-repeat only drives cursor movement (held arrow keeps moving); discrete actions
    // (confirm/sell/start/pause/speed) are edge-triggered — a held key must not repeat
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
      case 'start':
        controller.start();
        break;
      case 'pause':
        controller.togglePause();
        break;
      case 'speed':
        controller.cycleSpeed();
        break;
      case 'armTower1':
        // Intentionally NOT handled here: arming must work from "any state" (PLAN.md P2
        // table) regardless of whether the board currently has focus (e.g. focus on the
        // Card, or nowhere at all), so it's a document-scope listener in overlay.ts. This
        // case only exists so the switch stays exhaustive over `GameAction` — the
        // preventDefault() above still consumes the key here when the board IS focused.
        break;
    }
  };

  // --- Card: mouse stays exactly P2 click-toggle (handled by overlay.ts's own `click`
  // listener, untouched); touch/pen is tap-vs-drag (PLAN.md P3) ---

  const cardCleanups: (() => void)[] = [];
  for (const cardEl of cardEls) {
    const onCardPointerDown = (e: PointerEvent): void => {
      if (e.pointerType === 'mouse') return; // mouse Card interaction is click-toggle only
      presses.set(e.pointerId, {
        origin: 'card',
        cardEl,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
      });
      registerTouchLike(e.pointerId, e.pointerType);
      capture(cardEl, e.pointerId);
    };

    const onCardPointerMove = (e: PointerEvent): void => {
      if (e.pointerType === 'mouse') return;
      const press = presses.get(e.pointerId);
      if (press === undefined || press.origin !== 'card') return;
      if (voidedIds.has(e.pointerId)) return;
      if (!press.dragging) {
        const dx = e.clientX - press.startX;
        const dy = e.clientY - press.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return; // still under the tap threshold
        press.dragging = true;
        // Arm to begin the drag-from-rail flow — but never TOGGLE (a card already armed
        // by an earlier gesture must stay armed, not flip off) — `armTower` only arms when
        // called while unarmed.
        if (controller.uiState().armed === null) controller.armTower('basic');
      }
      updateGhostFromPoint(e.clientX, e.clientY); // coordinates mapped onto the board
    };

    const onCardPointerUp = (e: PointerEvent): void => {
      if (e.pointerType === 'mouse') return;
      const press = presses.get(e.pointerId);
      presses.delete(e.pointerId);
      const voided = voidedIds.has(e.pointerId);
      activeIds.delete(e.pointerId);
      voidedIds.delete(e.pointerId);
      if (press === undefined || press.origin !== 'card') return;
      if (voided) {
        // Voided by a concurrent second contact (PLAN.md P3): route through the SAME
        // cancellation contract as pointercancel — a pre-threshold press never touched
        // `armed`, so `cancelPress` is a no-op beyond releasing capture; a press that had
        // already crossed the drag threshold (armed, maybe showing a ghost) disarms and
        // clears the ghost, exactly like a genuine pointercancel would.
        cancelPress(e.pointerId, press);
        return;
      }
      if (!press.dragging) {
        // Tap: toggle armed per the P2 table, and suppress the subsequent synthetic click
        // so it doesn't double-toggle.
        controller.armTower('basic');
        armClickSuppression();
        return;
      }
      // Drag-from-rail release: valid cell places (→ disarm → select, via `clickAt`);
      // off-board, over Shell chrome, or an invalid cell cancels AND disarms (the drag was
      // one gesture — aborting returns to neutral, unlike the board-native drag, which
      // keeps a rejected placement armed).
      //
      // Arm the synthetic-click suppression ONLY when the release lands back over the
      // Card itself — a release over the board (the common case: the drag moved the
      // pointer off the Card) never produces a Card-targeted synthetic click, so arming
      // unconditionally left a suppression pending that could swallow the NEXT genuine
      // Card click within SUPPRESS_CLICK_EXPIRY_MS on hybrid touch+mouse devices.
      if (isOverElement(e.clientX, e.clientY, cardEl)) armClickSuppression();
      if (isOverChrome(e.clientX, e.clientY) || !isWithinBoardRect(e.clientX, e.clientY)) {
        disarmAndClearGhost();
        return;
      }
      const anchor = ghostAnchorFromPoint(e.clientX, e.clientY);
      controller.clickAt(anchor.col, anchor.row);
      if (controller.uiState().armed !== null) disarmAndClearGhost(); // invalid drop still disarms
    };

    const onCardPointerCancelOrLost = (e: PointerEvent): void => {
      if (e.pointerType === 'mouse') return;
      const press = presses.get(e.pointerId);
      presses.delete(e.pointerId);
      activeIds.delete(e.pointerId);
      voidedIds.delete(e.pointerId);
      if (press !== undefined && press.origin === 'card') cancelPress(e.pointerId, press);
    };

    const onCardContextMenu = (e: Event): void => e.preventDefault(); // long-press suppression

    cardEl.addEventListener('pointerdown', onCardPointerDown as EventListener);
    cardEl.addEventListener('pointermove', onCardPointerMove as EventListener);
    cardEl.addEventListener('pointerup', onCardPointerUp as EventListener);
    cardEl.addEventListener('pointercancel', onCardPointerCancelOrLost as EventListener);
    cardEl.addEventListener('lostpointercapture', onCardPointerCancelOrLost as EventListener);
    cardEl.addEventListener('contextmenu', onCardContextMenu);
    cardCleanups.push(() => {
      cardEl.removeEventListener('pointerdown', onCardPointerDown as EventListener);
      cardEl.removeEventListener('pointermove', onCardPointerMove as EventListener);
      cardEl.removeEventListener('pointerup', onCardPointerUp as EventListener);
      cardEl.removeEventListener('pointercancel', onCardPointerCancelOrLost as EventListener);
      cardEl.removeEventListener('lostpointercapture', onCardPointerCancelOrLost as EventListener);
      cardEl.removeEventListener('contextmenu', onCardContextMenu);
    });
  }

  boardEl.addEventListener('pointerdown', onBoardPointerDown as EventListener);
  boardEl.addEventListener('pointermove', onBoardPointerMove as EventListener);
  boardEl.addEventListener('pointerup', onBoardPointerUp as EventListener);
  boardEl.addEventListener('pointercancel', onBoardPointerCancelOrLost as EventListener);
  boardEl.addEventListener('lostpointercapture', onBoardPointerCancelOrLost as EventListener);
  boardEl.addEventListener('contextmenu', onBoardContextMenu);
  boardEl.addEventListener('keydown', onKeyDown as EventListener);
  doc.addEventListener('click', onDocumentClickCapture, true);

  return {
    destroy(): void {
      boardEl.removeEventListener('pointerdown', onBoardPointerDown as EventListener);
      boardEl.removeEventListener('pointermove', onBoardPointerMove as EventListener);
      boardEl.removeEventListener('pointerup', onBoardPointerUp as EventListener);
      boardEl.removeEventListener('pointercancel', onBoardPointerCancelOrLost as EventListener);
      boardEl.removeEventListener(
        'lostpointercapture',
        onBoardPointerCancelOrLost as EventListener,
      );
      boardEl.removeEventListener('contextmenu', onBoardContextMenu);
      boardEl.removeEventListener('keydown', onKeyDown as EventListener);
      doc.removeEventListener('click', onDocumentClickCapture, true);
      for (const cleanup of cardCleanups) cleanup();
      clearPendingSuppressionTimers();
    },
    reset(): void {
      presses.clear();
      activeIds.clear();
      voidedIds.clear();
      clearPendingSuppressionTimers();
    },
    abort(): void {
      for (const [pointerId, press] of presses) cancelPress(pointerId, press);
      presses.clear();
      activeIds.clear();
      voidedIds.clear();
    },
  };
}
