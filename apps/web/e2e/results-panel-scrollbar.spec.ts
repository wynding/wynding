import { test, expect } from '@playwright/test';
import { boxOf, expectSameBox, openResults, toggleOf, twoFrames } from './results-harness';

// results-panel-scrollbar.spec.ts — the results panel (#181 H2) where a scrollbar takes room.
//
// Playwright starts headless Chromium with `--hide-scrollbars`, so in every other spec a
// scrollbar takes no room and the panel body's reserved gutter (`ui.css`, `.wy-results-body`)
// changes nothing they can see. This file starts the browser without that argument and gives
// the body a styled 15px scrollbar: a styled WebKit scrollbar is never an overlay, so it takes
// room the way a classic one does (Windows, Linux, any system set to always show scrollbars),
// and the same on every platform the suite runs on.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test('where a scrollbar takes room, Run data and Give feedback still open without moving, and the heading stays centred', async ({
  page,
}) => {
  // The body reserves its gutter, so something opening that makes it overflow cannot narrow it
  // and reflow the row under the pointer; and it reserves the gutter on both edges, so the
  // centred content stays centred on the panel and its band. At 1280×720 the open group and
  // the open form both overflow the body.
  await page.setViewportSize({ width: 1280, height: 720 });
  const dialog = await openResults(page, 'win');
  await page.addStyleTag({ content: '.wy-results-body::-webkit-scrollbar { width: 15px; }' });
  await twoFrames(page);
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

  const feedbackBox = await boxOf(page, '.wy-survey-opener > .wy-btn');
  await page.mouse.click(
    feedbackBox.x + feedbackBox.width / 2,
    feedbackBox.y + feedbackBox.height / 2,
  );
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeAttached();
  expectSameBox(await boxOf(page, '.wy-survey-opener > .wy-btn'), feedbackBox, 'Give feedback');
  expectSameBox(await boxOf(page, '.wy-results-more'), toggleBox, 'Run data, with the form open');
});
