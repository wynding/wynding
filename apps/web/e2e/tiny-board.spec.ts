import { test, expect, type Page, type Locator } from '@playwright/test';
import { PNG } from 'pngjs';
import { createProjection, resolvePalette } from '@wynding/render';
import { GRID } from './layout-probe';

// A board too small to draw must never stop the game (#181, QC round 1 of the bake PR).
//
// Under ~56×48 CSS px — a hidden board measures 0×0, and a resize can pass through tiny
// sizes on its way — the projection falls back to 1px cells. Baking the board's static art
// at that size once threw from inside the renderer's `draw()` (a rounded rect smaller than
// its own inset asked Canvas2D for a negative arc radius, which it rejects), and an
// exception escaping `draw()` stops the frame loop for good: the sim, the HUD and the board
// all froze. These drive the two real ways a board gets that small and require the run to
// keep ticking with no error of any kind — the bake reports a failure on the console rather
// than throwing, so a console error fails these too.

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

const tickOf = async (board: Locator): Promise<number> =>
  Number(await board.getAttribute('data-sim-tick'));

/** The run must still be advancing: the tick moves past where it is now. */
async function expectTicking(board: Locator): Promise<void> {
  const from = await tickOf(board);
  await expect.poll(() => tickOf(board), { timeout: 5_000 }).toBeGreaterThan(from);
}

/** Every animation frame from here to `frames` later has run (the renderer drew them). */
async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const step = (): void => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    n,
  );
}

/** The colour at the centre of board cell (col, row), read off a real screenshot of the
 *  board — so it is what the canvas actually shows, not what the DOM claims. */
async function cellColour(page: Page, col: number, row: number): Promise<[number, number, number]> {
  const box = await page.locator('.wy-board').boundingBox();
  expect(box).not.toBeNull();
  const b = box as { x: number; y: number; width: number; height: number };
  const projection = createProjection({
    cols: GRID.cols,
    rows: GRID.rows,
    cssWidth: b.width,
    cssHeight: b.height,
    dpr: 1,
  });
  const at = projection.cellToPixel(col, row);
  const png = PNG.sync.read(await page.screenshot({ clip: b }));
  const scale = png.width / b.width; // screenshot pixels per CSS px
  const x = Math.round((at.x + projection.cellPx / 2) * scale);
  const y = Math.round((at.y + projection.cellPx / 2) * scale);
  const i = (png.width * y + x) << 2;
  return [png.data[i] as number, png.data[i + 1] as number, png.data[i + 2] as number];
}

function rgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

/** The board's own blocked-border colour at a border cell far from the corner: a board
 *  still drawn at 1px cells, or not drawn at all, shows the canvas background there. */
async function expectBoardDrawnAtFullSize(page: Page): Promise<void> {
  const want = rgb(resolvePalette('default').border);
  await expect
    .poll(async () => {
      const got = await cellColour(page, GRID.cols - 1, 2);
      return got.every((c, k) => Math.abs(c - (want[k] as number)) <= 24);
    })
    .toBe(true);
}

test.describe('a board too small to draw never stops the game (#181)', () => {
  test('shrinking the viewport mid-run under the 1px-cell floor and back: the run keeps ticking', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    const board = page.locator('.wy-board');
    await expect(board).toBeVisible();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(board).toHaveAttribute('data-started', 'true');
    await expectTicking(board);

    const original = page.viewportSize();
    expect(original).not.toBeNull();
    await page.setViewportSize({ width: 100, height: 40 });
    // The board really is under the floor that 2px cells need (28 × 2 by 24 × 2 CSS px).
    await expect
      .poll(() =>
        board.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.width < 56 || r.height < 48;
        }),
      )
      .toBe(true);
    await frames(page, 10);
    await expectTicking(board);

    await page.setViewportSize(original as { width: number; height: number });
    await frames(page, 10);
    await expectTicking(board);
    await expectBoardDrawnAtFullSize(page);
    expect(errors).toEqual([]);
  });

  test('mounting while the board is hidden, then revealing it: the board draws and the run ticks', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    // Hidden before any app script runs, so the renderer mounts into a 0×0 board. An adopted
    // stylesheet, because an init script runs before the document has an element to hold a
    // <style>.
    await page.addInitScript(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('.wy-board { display: none !important; }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      (window as unknown as { __wyHideBoard?: CSSStyleSheet }).__wyHideBoard = sheet;
    });
    await page.goto('/');
    const board = page.locator('.wy-board');
    await expect(page.locator('.wy-board canvas')).toBeAttached();
    await expect(board).toBeHidden();
    await frames(page, 10);

    await page.evaluate(() => {
      const sheet = (window as unknown as { __wyHideBoard?: CSSStyleSheet }).__wyHideBoard;
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    });
    await expect(board).toBeVisible();
    await frames(page, 10);
    await expectBoardDrawnAtFullSize(page);

    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(board).toHaveAttribute('data-started', 'true');
    await expectTicking(board);
    expect(errors).toEqual([]);
  });
});
