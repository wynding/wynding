import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { stubFullscreen } from './fullscreen-stub';

// panel-scroll-keys.spec.ts — the pinned Panel's last line is reachable by KEYBOARD (#181 UAT
// ruling). At 658×320 with the Splash Tower armed by hotkey, `.wy-panel-scroll` is ~115px tall
// over ~138px of content, so its last line ("Blast 1.5 tiles") sits ~20px under the box and
// only scrolling reveals it. The scrollport is the Panel's own scroll container and its rows
// are `<p>` elements that cannot take focus, so the claim is that it carries a tab stop of its
// own while it overflows, the stop is reached in the tab order, and the keys scroll the last
// line fully into the box. Runs in Chromium AND WebKit (playwright.config.ts).
//
// WebKit differences, both engine behaviour rather than this app's: its Playwright Tab skips
// buttons, so there the scrollport is focused with `focus()`; and an active
// `requestAnimationFrame` loop suppresses ArrowDown on a focused scroll container (the app
// runs a continuous render loop; compact.spec.ts says the same), so PageDown and End are the
// keys asserted in both engines.

const PHONE = { width: 658, height: 320 };

async function armSplashPinned(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
  await stubFullscreen(page);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
  // A hotkey, never a Card click: a click on a below-the-fold Card would auto-scroll the Rail.
  await page.evaluate(() => ((document.querySelector('.wy-rail') as HTMLElement).scrollTop = 0));
  await page.keyboard.press('3');
  await expect(page.locator('.wy-panel')).toBeVisible();
  await expect(page.locator('.wy-panel-name')).toHaveText(/Splash/);
}

/** The scrollport's box against its last visible stat line, in CSS px. */
async function lastLineVsBox(page: Page): Promise<{
  overflow: number;
  scrollTop: number;
  lastTop: number;
  lastBottom: number;
  boxTop: number;
  boxBottom: number;
  text: string;
}> {
  return page.evaluate(() => {
    const sc = document.querySelector('.wy-panel-scroll') as HTMLElement;
    const box = sc.getBoundingClientRect();
    const last = [...sc.querySelectorAll('p')]
      .filter((p) => p.getBoundingClientRect().width > 2 && getComputedStyle(p).display !== 'none')
      .pop() as HTMLElement;
    const r = last.getBoundingClientRect();
    return {
      overflow: sc.scrollHeight - sc.clientHeight,
      scrollTop: sc.scrollTop,
      lastTop: r.top,
      lastBottom: r.bottom,
      boxTop: box.top,
      boxBottom: box.bottom,
      text: last.textContent ?? '',
    };
  });
}

test.describe('the pinned Panel scrollport is operable by keyboard', () => {
  test('658×320, Splash armed: the tab stop exists while it overflows, and the keys scroll the last line into the box', async ({
    page,
    browserName,
  }) => {
    await armSplashPinned(page);
    const scroller = page.locator('.wy-panel-scroll');

    // The premise: the last line starts below the box, and the scrollport has a tab stop.
    await expect(scroller).toHaveAttribute('tabindex', '0');
    await expect(scroller).toHaveAttribute('aria-label', /\S/);
    const before = await lastLineVsBox(page);
    expect(before.overflow, 'the scrollport must overflow in this state').toBeGreaterThan(8);
    expect(before.text).toMatch(/Blast/);
    expect(before.lastBottom, 'the last line starts hidden under the box').toBeGreaterThan(
      before.boxBottom,
    );

    if (browserName === 'chromium') {
      // Tab reaches it. The Cards precede the Panel in the tab order, so walk forward, bounded.
      let reached = false;
      for (let i = 0; i < 30 && !reached; i++) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(
          () => document.activeElement?.classList.contains('wy-panel-scroll') ?? false,
        );
      }
      expect(reached, 'Tab must land on the Panel scrollport').toBe(true);
      // ...and the Close panel button follows it, so the stop sits BEFORE Close panel.
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Close panel' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(scroller).toBeFocused();
    } else {
      await scroller.focus();
      await expect(scroller).toBeFocused();
    }

    // axe, in this state (the scrollport focused and overflowing).
    const audit = await new AxeBuilder({ page }).include('#app').analyze();
    expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);

    // PageDown, then End: the last line lies fully inside the box. Poll, because Chromium
    // animates keyboard scrolling.
    await page.keyboard.press('PageDown');
    await expect
      .poll(async () => (await lastLineVsBox(page)).scrollTop, {
        message: 'PageDown must scroll the scrollport',
      })
      .toBeGreaterThan(0);
    await page.keyboard.press('End');
    await expect
      .poll(
        async () => {
          const m = await lastLineVsBox(page);
          return m.lastTop >= m.boxTop - 1 && m.lastBottom <= m.boxBottom + 1;
        },
        { message: 'the last line must lie fully inside the box after End' },
      )
      .toBe(true);
    expect((await lastLineVsBox(page)).text).toMatch(/Blast/);

    // Chromium also takes ArrowDown (WebKit's is suppressed by the render loop, see above).
    if (browserName === 'chromium') {
      await page.keyboard.press('Home');
      await expect.poll(async () => (await lastLineVsBox(page)).scrollTop).toBe(0);
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(async () => (await lastLineVsBox(page)).scrollTop, {
          message: 'ArrowDown must scroll the scrollport in Chromium',
        })
        .toBeGreaterThan(0);
    }
  });
});
