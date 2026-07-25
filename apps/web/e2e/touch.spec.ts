import { test, expect, type CDPSession, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PNG } from 'pngjs';
import { createProjection, resolvePalette } from '@wynding/render';

// Touch placement (PLAN.md P3/P6): press-adjust-release with the offset ghost, tap-vs-drag
// on the Card, and the chrome/off-board cancellation rule. Runs ONLY under the
// `chromium-touch` project (a real `devices['Galaxy S9+ landscape']` profile —
// `playwright.config.ts` scopes it via `testMatch`), since `hasTouch` alone does not
// guarantee `(pointer: coarse)` matches, which the gestures below are gated on.
//
// Playwright's `Touchscreen` API only supports taps — press-move-release and multi-touch
// need CDP's `Input.dispatchTouchEvent` directly. `touchPoints` is the FULL set of
// currently-active contacts for each event; CDP diffs against the previous event to
// synthesize press/move/release per point, so `touchEnd` with an EMPTY array lifts every
// active touch.

interface TouchPt {
  readonly x: number;
  readonly y: number;
  readonly id: number;
}

async function touchStart(session: CDPSession, points: readonly TouchPt[]): Promise<void> {
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [...points] });
}
async function touchMove(session: CDPSession, points: readonly TouchPt[]): Promise<void> {
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [...points] });
}
async function touchEnd(session: CDPSession, points: readonly TouchPt[] = []): Promise<void> {
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [...points] });
}

/** A single-finger tap: press then release at the same point, no move — under
 *  `DRAG_THRESHOLD_PX` by construction, so `input.ts` reads it as a tap, never a drag. */
async function tap(session: CDPSession, x: number, y: number): Promise<void> {
  await touchStart(session, [{ x, y, id: 0 }]);
  await touchEnd(session);
}

/** Press at `from`, move to `to`, release at `to` — one continuous single-finger gesture. */
async function pressMoveRelease(
  session: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await touchStart(session, [{ x: from.x, y: from.y, id: 0 }]);
  await touchMove(session, [{ x: to.x, y: to.y, id: 0 }]);
  await touchEnd(session);
}

// Rendered-pixel sampling helpers, duplicated from hidpi.spec.ts (existing precedent: each
// e2e file keeps its own small copy rather than sharing a helper module).
function toRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}
const CHANNEL_TOL = 24;
function closeTo(actual: [number, number, number], expected: [number, number, number]): boolean {
  return actual.every((c, i) => Math.abs(c - (expected[i] as number)) <= CHANNEL_TOL);
}
function sampleCssPoint(
  png: PNG,
  clipX: number,
  clipY: number,
  cssX: number,
  cssY: number,
): [number, number, number] {
  const px = Math.min(png.width - 1, Math.max(0, Math.round(cssX - clipX)));
  const py = Math.min(png.height - 1, Math.max(0, Math.round(cssY - clipY)));
  const idx = (png.width * py + px) << 2;
  return [png.data[idx] as number, png.data[idx + 1] as number, png.data[idx + 2] as number];
}

// M1's "Open Field" board is 28×24 (entrance/exit on row 11) — duplicated from
// hidpi.spec.ts/content's boards.ts without importing @wynding/content (e2e stays
// decoupled from content internals; only the two numbers are duplicated here).
const GRID = { cols: 28, rows: 24 };

test.describe('touch placement: press-adjust-release + tap-vs-drag (PLAN.md P3/P6)', () => {
  let session: CDPSession;

  test.beforeEach(async ({ page, context }) => {
    await page.goto('/');
    // Precondition: the gated behavior below depends on `(pointer: coarse)` — `hasTouch`
    // alone does not guarantee it, so assert it rather than assume the device profile.
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    expect(coarse).toBe(true);
    // ...and this 320px-tall profile renders the COMPACT layout (Story 11): the Shell chrome
    // this spec hit-tests against is a full-height status COLUMN on the left with its Dock
    // inside it — there is no top row any more. Asserted as a precondition so a trigger
    // change turns into a clear failure here rather than a confusing gesture mis-classification.
    const compact = await page.evaluate(() => matchMedia('(max-height: 500px)').matches);
    expect(compact).toBe(true);
    session = await context.newCDPSession(page);
    // Press Start first (PLAN.md P6): a touch build on a HELD run stays Pending — the
    // commit assertions below need the sim actually stepping.
    await page.getByRole('button', { name: 'Start' }).click();
  });

  test('press-adjust-release: moving adjusts the ghost, release commits at the offset anchor (not the finger cell)', async ({
    page,
  }) => {
    const board = page.locator('.wy-board');
    await expect(board).toBeVisible();
    const box = (await board.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const projection = createProjection({
      cols: GRID.cols,
      rows: GRID.rows,
      cssWidth: box.width,
      cssHeight: box.height,
      dpr: 1,
    });
    const pal = resolvePalette('default');
    const cellPx = projection.cellPx;

    const pressCell = { col: 20, row: 5 }; // press origin — well away from the final cell
    const fingerCell = { col: 10, row: 15 }; // release cell — the ghost's anchor is 2 ABOVE this
    const anchorCell = { col: 10, row: 13 }; // TOUCH_GHOST_OFFSET_CELLS above fingerCell

    const pressPx = projection.cellToPixel(pressCell.col, pressCell.row);
    const fingerPx = projection.cellToPixel(fingerCell.col, fingerCell.row);
    const anchorPx = projection.cellToPixel(anchorCell.col, anchorCell.row);

    // Arm the Card via a plain touch tap (under the drag threshold).
    const card = page.getByRole('button', { name: /Basic Tower/ });
    const cardBox = (await card.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    await tap(session, cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await expect(card).toHaveAttribute('aria-pressed', 'true');

    // Press over one cell, move to another (the ghost follows the move, not the press
    // origin), then release: commits at the RELEASE cell's offset anchor.
    await touchStart(session, [
      { x: box.x + pressPx.x + cellPx / 2, y: box.y + pressPx.y + cellPx / 2, id: 0 },
    ]);
    await touchMove(session, [
      { x: box.x + fingerPx.x + cellPx / 2, y: box.y + fingerPx.y + cellPx / 2, id: 0 },
    ]);
    await touchEnd(session);

    // Successful placement disarms and selects the new tower — no two-tap confirm anywhere.
    await expect(card).toHaveAttribute('aria-pressed', 'false');
    const panel = page.locator('.wy-panel');
    await expect(panel.getByRole('button', { name: /^Sell/ })).toBeVisible();

    // Rendered proof: the ANCHOR cell (2 rows above the finger) reads as pal.tower; the
    // finger's own cell stays floor — the commit landed at the offset, not under the finger.
    const clipX = anchorPx.x - 2;
    const clipY = anchorPx.y - 2;
    const clip = {
      x: box.x + clipX,
      y: box.y + clipY,
      width: cellPx * 2 + 4,
      height: fingerPx.y - anchorPx.y + cellPx + 4,
    };
    let png!: PNG;
    await expect
      .poll(async () => {
        const buf = await page.screenshot({ clip, scale: 'css' });
        png = PNG.sync.read(buf);
        return closeTo(
          sampleCssPoint(png, clipX, clipY, anchorPx.x + cellPx / 2, anchorPx.y + cellPx / 2),
          toRgb(pal.tower),
        );
      }, 'build painted: anchor cell reads as pal.tower')
      .toBe(true);
    const fingerSample = sampleCssPoint(
      png,
      clipX,
      clipY,
      fingerPx.x + cellPx / 2,
      fingerPx.y + cellPx / 2,
    );
    expect(
      closeTo(fingerSample, toRgb(pal.floor)),
      `finger cell sample ${fingerSample.join(',')} should still be floor`,
    ).toBe(true);
  });

  test('a Card tap (under the drag threshold) toggles armed; a Card drag (over the threshold) places directly', async ({
    page,
  }) => {
    const card = page.getByRole('button', { name: /Basic Tower/ });
    const cardBox = (await card.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const cx = cardBox.x + cardBox.width / 2;
    const cy = cardBox.y + cardBox.height / 2;

    await expect(card).toHaveAttribute('aria-pressed', 'false');
    await tap(session, cx, cy);
    await expect(card).toHaveAttribute('aria-pressed', 'true'); // tap: arm
    await tap(session, cx, cy);
    await expect(card).toHaveAttribute('aria-pressed', 'false'); // tap again: disarm

    const board = page.locator('.wy-board');
    const box = (await board.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const projection = createProjection({
      cols: GRID.cols,
      rows: GRID.rows,
      cssWidth: box.width,
      cssHeight: box.height,
      dpr: 1,
    });
    const cellPx = projection.cellPx;
    // A drag-from-rail maps its release point through the SAME offset transform as a
    // board-native press — the finger cell here anchors at (14,12).
    const releaseCell = { col: 14, row: 14 };
    const releasePx = projection.cellToPixel(releaseCell.col, releaseCell.row);
    const releaseX = box.x + releasePx.x + cellPx / 2;
    const releaseY = box.y + releasePx.y + cellPx / 2;

    // Drag-from-rail: press on the (unarmed) Card, move onto the board past the
    // threshold, release on a valid cell — arms + places in one gesture, never a second tap.
    await pressMoveRelease(session, { x: cx, y: cy }, { x: releaseX, y: releaseY });

    await expect(card).toHaveAttribute('aria-pressed', 'false'); // placed -> disarmed
    const panel = page.locator('.wy-panel');
    await expect(panel.getByRole('button', { name: /^Sell/ })).toBeVisible(); // now a selection
  });

  test('a Card drag released off-board or over Shell chrome cancels and disarms (no placement)', async ({
    page,
  }) => {
    const card = page.getByRole('button', { name: /Basic Tower/ });
    const cardBox = (await card.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const cx = cardBox.x + cardBox.width / 2;
    const cy = cardBox.y + cardBox.height / 2;

    // Release over the Compact COLUMN DOCK (Shell chrome — Story 11 moves the controls into
    // the status column, so this is the surface a real thumb actually strays onto mid-drag,
    // and the one the `CHROME_SELECTOR` hit-test has to keep covering). Never commits, and
    // unlike a board-native drag (which stays armed on a rejected placement) a Card-drag
    // cancellation ALSO disarms.
    const settingsBtn = page.getByRole('button', { name: 'Settings' });
    const settingsBox = (await settingsBtn.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    await touchStart(session, [{ x: cx, y: cy, id: 0 }]);
    await touchMove(session, [
      {
        x: settingsBox.x + settingsBox.width / 2,
        y: settingsBox.y + settingsBox.height / 2,
        id: 0,
      },
    ]);
    await touchEnd(session);

    await expect(card).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.wy-panel')).toBeHidden();
  });

  test('an invalid tap-release (an occupied cell) leaves the ghost persistent and stays armed — no flash timer, no two-tap', async ({
    page,
  }) => {
    const board = page.locator('.wy-board');
    const box = (await board.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const projection = createProjection({
      cols: GRID.cols,
      rows: GRID.rows,
      cssWidth: box.width,
      cssHeight: box.height,
      dpr: 1,
    });
    const cellPx = projection.cellPx;
    const fingerCell = { col: 10, row: 15 }; // anchor lands at (10,13)
    const fingerPx = projection.cellToPixel(fingerCell.col, fingerCell.row);
    const fx = box.x + fingerPx.x + cellPx / 2;
    const fy = box.y + fingerPx.y + cellPx / 2;

    const card = page.getByRole('button', { name: /Basic Tower/ });
    const cardBox = (await card.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const cardCenter = { x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2 };

    // Build the first tower at this anchor.
    await tap(session, cardCenter.x, cardCenter.y);
    await touchStart(session, [{ x: fx, y: fy, id: 0 }]);
    await touchEnd(session);
    await expect(card).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();

    // Arm again and press-release at the SAME anchor: occupied, so nothing places — the
    // invalid ghost persists and the Card stays armed.
    await tap(session, cardCenter.x, cardCenter.y);
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await touchStart(session, [{ x: fx, y: fy, id: 0 }]);
    await touchEnd(session);

    await expect(card).toHaveAttribute('aria-pressed', 'true'); // stays armed
    const live = page.locator('.wy-sr-only[role="status"][aria-live="polite"]');
    await expect(live).toContainText('already occupied');
  });

  test('axe: no violations with the Panel open (armed) under touch', async ({
    page,
  }: {
    page: Page;
  }) => {
    const card = page.getByRole('button', { name: /Basic Tower/ });
    const cardBox = (await card.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    await tap(session, cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.wy-panel')).toBeVisible();

    const results = await new AxeBuilder({ page }).include('#app').analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});
