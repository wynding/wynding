import { test, expect, type Locator, type Page } from '@playwright/test';
import { boxOf, expectSameBox, openResults, toggleOf, twoFrames } from './results-harness';

// results-panel-scrollbar.spec.ts — the results panel (#181 H2) where a scrollbar takes room.
//
// Playwright starts headless Chromium with `--hide-scrollbars`, so in every other spec a
// scrollbar takes no room and the panel body's reserved gutter (`ui.css`, `.wy-results-body`)
// changes nothing they can see. This file starts the browser without that argument and gives
// the body a styled 15px or 17px scrollbar: a styled WebKit scrollbar is never an overlay, so it
// takes room the way a classic one does (Windows, Linux, any system set to always show
// scrollbars), and the same on every platform the suite runs on.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

/** A styled scrollbar `px` wide on the panel's body: one that takes room, as a classic one does
 *  (15px on Windows, 17px in some Linux themes). */
async function scrollbarOf(page: Page, px: number): Promise<void> {
  await page.addStyleTag({
    content: `.wy-results-body::-webkit-scrollbar { width: ${String(px)}px; }`,
  });
  await twoFrames(page);
}

/** The width the body reserves for its scrollbar: its gutter, on one edge or both. */
const reserved = (dialog: Locator): Promise<number> =>
  dialog
    .locator('.wy-results-body')
    .evaluate((b) => (b as HTMLElement).offsetWidth - b.clientWidth);

test('where a scrollbar takes room, Run data and Give feedback still open without moving, and the heading stays centred', async ({
  page,
}) => {
  // The body reserves its gutter, so something opening that makes it overflow cannot narrow it
  // and reflow the row under the pointer; and it reserves the gutter on both edges, so the
  // centred content stays centred on the panel and its band. At 1280×720 the open group and
  // the open form each overflow the body. Each opens on its own: the form opened below an open
  // group would start mostly below the fold, and opening it would then scroll the body to show
  // its first question (`survey-form.ts`), moving the row on purpose.
  await page.setViewportSize({ width: 1280, height: 720 });
  const dialog = await openResults(page, 'win');
  await scrollbarOf(page, 15);
  // The premise: the scrollbar takes room, and the body reserves it on both edges before
  // anything overflows. A browser whose scrollbars took none would pass everything below.
  expect(await reserved(dialog), 'a 15px gutter on each edge').toBe(30);
  const body = dialog.locator('.wy-results-body');
  const overflows = (): Promise<boolean> => body.evaluate((b) => b.scrollHeight > b.clientHeight);

  const offCentre = await page.evaluate(() => {
    const panel = document.querySelector('.wy-results-panel')!.getBoundingClientRect();
    const title = document.querySelector('.wy-results-title')!.getBoundingClientRect();
    return title.left + title.width / 2 - (panel.left + panel.width / 2);
  });
  expect(Math.abs(offCentre), 'the heading is centred on the panel').toBeLessThanOrEqual(0.5);
  expect(await overflows(), 'nothing open yet: no overflow').toBe(false);

  const toggleBox = await boxOf(page, '.wy-results-more');
  await page.mouse.click(toggleBox.x + toggleBox.width / 2, toggleBox.y + toggleBox.height / 2);
  await expect(toggleOf(dialog)).toHaveAttribute('aria-expanded', 'true');
  expect(await overflows(), 'the open group overflows the body').toBe(true);
  expectSameBox(await boxOf(page, '.wy-results-more'), toggleBox, 'Run data');
  // Closed again from the keyboard (focus stayed on the toggle), so nothing is open.
  await page.keyboard.press('Enter');
  await expect(toggleOf(dialog)).toHaveAttribute('aria-expanded', 'false');
  expect(await overflows(), 'closed again: no overflow').toBe(false);

  const feedbackBox = await boxOf(page, '.wy-survey-opener > .wy-btn');
  await page.mouse.click(
    feedbackBox.x + feedbackBox.width / 2,
    feedbackBox.y + feedbackBox.height / 2,
  );
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeAttached();
  expect(await overflows(), 'the open form overflows the body').toBe(true);
  expect(await body.evaluate((b) => b.scrollTop), 'its question opened in view').toBe(0);
  expectSameBox(await boxOf(page, '.wy-survey-opener > .wy-btn'), feedbackBox, 'Give feedback');
  expectSameBox(await boxOf(page, '.wy-results-more'), toggleBox, 'Run data, with the form open');
});

for (const px of [15, 17] as const) {
  test(`at 200% text on a phone-width window a ${String(px)}px scrollbar's gutter takes one edge only, and nothing scrolls sideways, closed or open`, async ({
    page,
  }) => {
    // On a narrow panel a gutter on both edges would cost the stacked tiles more width than a
    // 320px window at 200% text has ("117", Run data). There the body reserves one edge only.
    // The walk ends on the status region's two longest words, neither of which wraps at a space:
    // an accepted Send's reference (a UUID) and the name of the file Save wrote.
    test.setTimeout(180_000); // twelve page loads
    for (const width of [320, 340, 360]) {
      await page.setViewportSize({ width, height: 640 });
      for (const run of ['win', 'loss'] as const) {
        const dialog = await openResults(page, run, 200);
        await scrollbarOf(page, px);
        const at = `${String(width)}px, ${run}`;
        expect(await reserved(dialog), `${at}: the gutter on one edge`).toBe(px);
        const noSideways = async (when: string): Promise<void> => {
          const sideways = await page.evaluate(() => {
            const body = document.querySelector('.wy-results-body')!;
            const dialogEl = document.querySelector('.wy-results')!;
            return [
              body.scrollWidth - body.clientWidth,
              dialogEl.scrollWidth - dialogEl.clientWidth,
            ];
          });
          expect(
            sideways,
            `${at}, ${when}: neither the body nor the dialog scrolls sideways`,
          ).toEqual([0, 0]);
        };
        await noSideways('closed');
        await toggleOf(dialog).click();
        await expect(toggleOf(dialog)).toHaveAttribute('aria-expanded', 'true');
        await noSideways('Run data open');
        await dialog.getByRole('button', { name: 'Give feedback' }).click();
        await expect(dialog.getByRole('button', { name: 'Send' })).toBeAttached();
        await noSideways('the survey open too');
        await dialog.getByRole('radio', { name: '4' }).first().check();
        await dialog.getByRole('button', { name: 'Send' }).click();
        await expect(dialog.getByRole('status')).toContainText('Reference:');
        await noSideways('the accepted Send’s reference shown');
        const download = page.waitForEvent('download');
        await dialog.getByRole('button', { name: 'Save run data' }).click();
        await download;
        await expect(dialog.getByRole('status')).toContainText('saved as');
        await noSideways('the saved file’s name shown');
      }
    }
  });
}
