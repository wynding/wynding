import { test, expect, devices, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { COMPACT_QUERY } from '../src/layout';
import {
  assertNoBuildableCellUnderDock,
  buildableRect,
  projectedGrid,
  regionRect,
  type Rect,
} from './layout-probe';
import { firePrompt, installPromptFactory } from './install-stub';
import { stubFullscreen } from './fullscreen-stub';

// dock-overlap.spec.ts — the Standard Dock swallows no playable cell's hit test (#152).
//
// THE DEFECT. The Standard Dock floats over the Stage's bottom-left, above the board
// (`z-index: 1`). Until #152 the board filled the whole Stage underneath it, so on a landscape
// tablet a tap on a buildable cell under the cluster was either lost or — where the cell sat
// under the Start button — silently began the wave instead of placing the armed tower.
//
// THE RULING. The board stops short of the Dock (`--wy-dock-reserve`), and the Standard Dock
// gets its own bounded height + scrollport so that reserve can never crush the board under its
// 12px floor. The relation asserted here — `assertNoBuildableCellUnderDock` — is ABSOLUTE:
// every viewport below, including the worst-case 640×560 banner-up 200% zoom, holds it with
// no exemption.
//
// Runs under the default fine-pointer `chromium` project; the tablet cases re-create the
// coarse-pointer context themselves (`test.use` below) rather than joining the
// `chromium-touch` project, whose 320px-tall profile is Compact — the layout this defect
// cannot occur in.

/** The reported repro: a landscape tablet, coarse pointer, Standard layout. */
const TABLET_REPRO = { width: 1280, height: 800 };

/** The Standard sweep (fine pointer). 360×640 is a portrait phone — Standard by height, and
 *  the size where the Dock wraps to two rows at 100% zoom. */
const SWEEP = [
  { width: 360, height: 640 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

/** The owner's worst case: a coarse-pointer landscape tablet, Standard, with the install
 *  banner up AND 200% text zoom — where the unbounded Dock wrapped to 162px and the reserve
 *  it demanded could not coexist with the 12px cell floor. */
const TABLET_WORST = { width: 640, height: 560 };

/** The Standard cell floor (`compact.spec.ts`'s `CELL_PX_MIN`, `ui.css`'s `--wy-cell-floor`). */
const CELL_PX_MIN = 12;

/** The Galaxy S9+'s touch identity, minus its viewport and browser type (a describe-level
 *  `test.use` may not set the latter). The coarse pointer is ASSERTED per test, never
 *  assumed — `hasTouch` alone does not guarantee `(pointer: coarse)` matches. */
const S9 = devices['Galaxy S9+ landscape'];
const COARSE = {
  userAgent: S9.userAgent,
  deviceScaleFactor: S9.deviceScaleFactor,
  isMobile: S9.isMobile,
  hasTouch: S9.hasTouch,
};

async function gotoStandard(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  // A Start press under a coarse pointer requests fullscreen, which would resize the viewport
  // out from under every measurement here (`fullscreen-stub.ts`).
  await stubFullscreen(page);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
  expect(
    await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY),
    'every case here is Standard — the Compact Dock is an in-flow column block',
  ).toBe(false);
}

/** Let the measured reserve land. It is written by a ResizeObserver pass one frame after the
 *  box that drives it changes, so a measurement taken in the same task as a zoom or a banner
 *  would read the previous frame's board. Polled to a board that has stopped moving — keyed
 *  on the OUTCOME, never on the property the fix writes, so this spec measures the pre-fix
 *  build exactly as it measures the fixed one (red for the defect, not for a missing hook). */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  let last = '';
  await expect
    .poll(async () => {
      const now = JSON.stringify(await projectedGrid(page));
      const stable = now === last;
      last = now;
      return stable;
    })
    .toBe(true);
}

/** The page-coordinate centre of board cell (col, row). */
async function cellCentre(page: Page, col: number, row: number): Promise<{ x: number; y: number }> {
  const grid = await projectedGrid(page);
  return {
    x: grid.x + (col + 0.5) * grid.cellPx,
    y: grid.y + (row + 0.5) * grid.cellPx,
  };
}

/** Every buildable cell of the bottom buildable row and the left buildable column must
 *  hit-test to the board. This is the defect's own terms — what a tap on that cell REACHES —
 *  rather than a geometric proxy for it: the Dock paints above the board, so any cell whose
 *  centre resolves to something outside `.wy-board` is a swallowed tap. */
async function assertEdgeCellsHitTheBoard(page: Page): Promise<void> {
  const grid = await projectedGrid(page);
  const buildable = buildableRect(grid);
  const cols = Math.round(buildable.width / grid.cellPx);
  const rows = Math.round(buildable.height / grid.cellPx);
  const probes: { col: number; row: number }[] = [];
  for (let c = 1; c <= cols; c++) probes.push({ col: c, row: rows });
  for (let r = 1; r < rows; r++) probes.push({ col: 1, row: r });
  const swallowed = await page.evaluate(
    ({ probes, grid }) =>
      probes
        .filter(({ col, row }) => {
          const x = grid.x + (col + 0.5) * grid.cellPx;
          const y = grid.y + (row + 0.5) * grid.cellPx;
          const hit = document.elementFromPoint(x, y);
          return hit === null || hit.closest('.wy-board') === null;
        })
        .map(({ col, row }) => {
          const hit = document.elementFromPoint(
            grid.x + (col + 0.5) * grid.cellPx,
            grid.y + (row + 0.5) * grid.cellPx,
          );
          return `(${col},${row}) → ${hit === null ? 'nothing' : hit.className || hit.tagName}`;
        }),
    { probes, grid },
  );
  expect(swallowed, 'buildable cells whose tap lands on something other than the board').toEqual(
    [],
  );
}

test.describe('the tablet repro (1280×800, coarse pointer): no cell under the Dock (#152)', () => {
  test.use(COARSE);

  test('no buildable cell renders under the Dock, and every edge cell hit-tests to the board', async ({
    page,
  }) => {
    await gotoStandard(page, TABLET_REPRO);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await settle(page);
    await assertNoBuildableCellUnderDock(page);
    await assertEdgeCellsHitTheBoard(page);
  });

  // Two taps, one per way the defect showed itself. Which Dock control sits over which cell
  // depends on the host's font metrics (they set the Dock's button widths), so rather than
  // hoping the bottom-left cell lands under Start on every runner, the second case ASKS where
  // Start is and taps the cell in its column. Measured against the pre-#152 build (headless
  // Chromium on Linux, 2026-09-24): the first tap opened Settings, and the second pressed
  // Start and began the wave.
  const TARGETS = ['the bottom-left buildable cell', "the Start button's column"] as const;
  for (const which of TARGETS) {
    test(`arming a tower and tapping ${which} places it — and starts no wave`, async ({ page }) => {
      await gotoStandard(page, TABLET_REPRO);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      await settle(page);

      const board = page.locator('.wy-board');
      const start = page.getByRole('button', { name: 'Start', exact: true });
      await expect(start).toBeVisible();
      await expect(board).toHaveAttribute('data-started', 'false');

      // Both targets sit on the last buildable row, just inside the blocked border ring.
      const grid = await projectedGrid(page);
      const bottomRow = Math.round(grid.height / grid.cellPx) - 2;
      let col = 1;
      if (which === "the Start button's column") {
        const s = (await start.boundingBox()) as Rect;
        col = Math.floor((s.x + s.width / 2 - grid.x) / grid.cellPx);
        // Inside the buildable columns, or this case would be probing nothing.
        expect(col).toBeGreaterThanOrEqual(1);
        expect(col).toBeLessThanOrEqual(Math.round(grid.width / grid.cellPx) - 2);
      }

      const card = page.getByRole('button', { name: /Basic Tower/ });
      await card.tap();
      await expect(card).toHaveAttribute('aria-pressed', 'true');
      const target = await cellCentre(page, col, bottomRow);
      await page.touchscreen.tap(target.x, target.y);

      // THE DESTRUCTIVE SYMPTOM FIRST: the tap must not have been taken by the Dock.
      await expect(board, 'the tap started the wave').toHaveAttribute('data-started', 'false');
      await expect(start).toBeVisible();
      await expect(page.getByRole('dialog'), 'the tap opened a Dock dialog').toHaveCount(0);
      // ...and the tap did what the player meant: the tower was placed (a successful
      // placement disarms the Card and selects the new tower, whose Panel offers Sell).
      await expect(card).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();
    });
  }
});

test.describe('the Standard sweep: no buildable cell under the Dock (#152)', () => {
  for (const size of SWEEP) {
    test(`${size.width}×${size.height}: no buildable cell renders under the Dock, and every edge cell hit-tests to the board`, async ({
      page,
    }) => {
      await gotoStandard(page, size);
      await settle(page);
      await assertNoBuildableCellUnderDock(page);
      await assertEdgeCellsHitTheBoard(page);
    });
  }
});

test.describe('the bounded Dock at the worst case: 640×560, banner up, 200% zoom (#152)', () => {
  test.use(COARSE);

  test('the relation holds with no exemption, the board keeps its 12px floor, and every Dock control is reachable by keyboard', async ({
    page,
  }) => {
    await installPromptFactory(page);
    await gotoStandard(page, TABLET_WORST);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await firePrompt(page, 'dismissed');
    await expect(page.locator('.wy-banner')).toBeVisible();
    await page.addStyleTag({ content: ':root { font-size: 200% }' });
    await settle(page);

    // The absolute relation, at the size where the unbounded Dock made it impossible...
    await assertNoBuildableCellUnderDock(page);
    await assertEdgeCellsHitTheBoard(page);
    // ...without spending the board's floor to get it.
    const grid = await projectedGrid(page);
    expect(grid.cellPx, `cellPx ${grid.cellPx} below the Standard floor`).toBeGreaterThanOrEqual(
      CELL_PX_MIN,
    );

    // The bound is live here — this is the case it exists for, so a Dock that merely happened
    // to fit would make every assertion below vacuous.
    const dockEl = page.locator('.wy-dock');
    expect(
      await dockEl.evaluate((el) => el.scrollHeight > el.clientHeight),
      'the Dock must be a live scrollport at this size',
    ).toBe(true);
    await expect(dockEl).toHaveClass(/wy-dock--scroll/);

    // KEYBOARD REACHABILITY, per control: Tab into the Dock from the chips scrollport and walk
    // every visible control. Each must take focus through real Tab traversal (not
    // `.focus()`), and focusing it must scroll it WHOLLY into the Dock's scrollport — the
    // accepted cost is that controls need scrolling to reach, never that one cannot be seen.
    const controls = dockEl.locator('.wy-btn:visible');
    const count = await controls.count();
    expect(count).toBeGreaterThan(1);
    await page.locator('.wy-hud').focus();
    for (let i = 0; i < count; i++) {
      await page.keyboard.press('Tab');
      const control = controls.nth(i);
      await expect(control, `Dock control ${i} must be the next Tab stop`).toBeFocused();
      const port = (await regionRect(page, 'dock')) as Rect;
      const box = (await control.boundingBox()) as Rect;
      expect(
        box.y >= port.y - 1 && box.y + box.height <= port.y + port.height + 1,
        `focused Dock control ${i} [${box.y.toFixed(1)}..${(box.y + box.height).toFixed(1)}] ` +
          `must sit wholly inside the Dock scrollport [${port.y.toFixed(1)}..${(
            port.y + port.height
          ).toFixed(1)}]`,
      ).toBe(true);
      await expect(control).toBeInViewport();
    }

    // Axe over the live scrollport — `scrollable-region-focusable` among the rest.
    const audit = await new AxeBuilder({ page }).include('#app').analyze();
    expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
  });
});
