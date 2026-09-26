import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { validateSurveyPayload, type SurveyPayload, type SurveySendResult } from '../src/survey';

// survey.spec.ts — ADR 0014's end-of-run survey in a real browser (#158), carrying the axe
// audit §6 makes an acceptance criterion.
//
// It runs against the survey HARNESS (`e2e-harness/`, served on 4176), not the shipped page:
// the survey is offered only where a transport is injected, and production injects none
// until the endpoint exists — so the shipped page has no survey, by design. The harness
// boots the real `boot()` with a fake transport this spec drives through `window.__wySurvey`;
// storage, Web Locks, the dialog and the form are all the production path.
//
// What only a browser can prove, and the unit suites cannot: real focus movement, real
// radio-group keyboard behaviour under the in-flight lock, axe over the rendered form, and
// the ask surviving a reload through real storage.

const HARNESS = 'http://localhost:4176/e2e-harness/survey.html';
const VERSION_A = 'a'.repeat(40);
const VERSION_B = 'b'.repeat(40);
const VERSION_C = 'c'.repeat(40);

type Mode = SurveySendResult | 'hold';

async function setMode(page: Page, mode: Mode): Promise<void> {
  await page.evaluate((m) => {
    (window as unknown as { __wySurvey: { mode: string } }).__wySurvey.mode = m;
  }, mode);
}
async function harness(page: Page): Promise<{ sent: SurveyPayload[]; aborted: number }> {
  return page.evaluate(() => {
    const c = (window as unknown as { __wySurvey: { sent: SurveyPayload[]; aborted: number } })
      .__wySurvey;
    return { sent: c.sent, aborted: c.aborted };
  });
}

/** `playtrace.spec.ts`'s accelerator: an undefended run, wave 2 called early. */
async function playToResults(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start' }).click();
  const callWave = page.getByRole('button', { name: 'Call wave' });
  await expect(page.locator('.wy-wave-preview .wy-wave-preview-title')).toHaveText('Wave 2 of 10');
  await expect(callWave).toHaveAttribute('aria-disabled', 'false');
  await callWave.click();
  await expect(page.locator('.wy-results')).toBeVisible({ timeout: 60_000 });
}

const results = (page: Page) => page.locator('.wy-results');
const status = (page: Page) => page.locator('.wy-results .wy-verify');
const giveFeedback = (page: Page) => results(page).getByRole('button', { name: 'Give feedback' });
const rating = (page: Page, n: number) =>
  results(page)
    .getByRole('group', { name: /How was it/ })
    .getByRole('radio', { name: String(n) });

/** Presence is decided only once the dialog's ask refresh settles (`data-ready`); before
 *  that the slot is hidden whatever the answer, so a `toBeHidden` alone proves nothing. */
async function presenceDecided(page: Page): Promise<void> {
  await expect(results(page).locator('.wy-survey[data-ready]')).toHaveCount(1);
}

/** Wait for the ask's durable write (a commit is async, under Web Locks) before navigating
 *  away — otherwise the next page could read the store before the write lands. */
async function stored(page: Page, fragment: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('wynding:survey') ?? ''))
    .toContain(fragment);
}

async function axeClean(page: Page, when: string): Promise<void> {
  const audit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(audit.violations, `axe violations ${when}`).toEqual([]);
}

test.describe('the end-of-run survey (#158, ADR 0014)', () => {
  test.setTimeout(240_000);

  test('offers, gates on a rating, sends a valid payload, and is axe-clean throughout', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await playToResults(page);
    await expect(giveFeedback(page)).toBeVisible();
    // Play again keeps initial focus: the survey is never what the player lands on (§1).
    await expect(results(page).getByRole('button', { name: 'Play again' })).toBeFocused();
    await axeClean(page, 'with Give feedback collapsed');

    await giveFeedback(page).click();
    await expect(rating(page, 1)).toBeFocused();
    await expect(results(page)).toContainText('privacy notice');
    await axeClean(page, 'with the survey expanded');

    // No rating: Send is aria-disabled, and a press — here from the KEYBOARD — says why.
    const send = results(page).getByRole('button', { name: 'Send' });
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await send.focus();
    await page.keyboard.press('Enter');
    await expect(status(page)).toHaveText('Answer "How was it?" to send your feedback.');
    await expect(send).toBeFocused();
    expect((await harness(page)).sent).toHaveLength(0);

    await rating(page, 4).check();
    await results(page).getByRole('textbox', { name: 'Anything else?' }).fill('the maze held');
    await send.click();
    await expect(status(page)).toHaveText(/^Thanks for the feedback\. Reference: [0-9a-f-]{36}\.$/);
    // An accepted Send retires the control the player was on: focus goes to Play again.
    await expect(results(page).getByRole('button', { name: 'Play again' })).toBeFocused();
    await expect(giveFeedback(page)).toBeHidden();
    await axeClean(page, 'after an accepted send');

    const { sent } = await harness(page);
    expect(sent).toHaveLength(1);
    expect(validateSurveyPayload(sent[0]).ok, 'the endpoint’s own check accepts it').toBe(true);
    expect(sent[0]!.answers).toEqual({ rating: 4, somethingBroke: false, text: 'the maze held' });
    expect(sent[0]!.run.gameVersion).toBe('e2e0000000000000000000000000000000000001');
    // The reference shown is the session id the payload carries (§7).
    await expect(status(page)).toContainText(sent[0]!.run.sessionId);

    // Consumed: the next dialog on this version does not ask again.
    await results(page).getByRole('button', { name: 'Play again' }).click();
    await playToResults(page);
    await expect(results(page).getByRole('button', { name: 'Play again' })).toBeFocused();
    await presenceDecided(page);
    await expect(giveFeedback(page)).toBeHidden();
  });

  test('a failure keeps Try again in place; in flight every edit is locked; Play again cancels', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await playToResults(page);
    await giveFeedback(page).click();
    await rating(page, 3).check();
    const text = results(page).getByRole('textbox', { name: 'Anything else?' });
    await text.fill('abc');

    // Rejected: the SAME node becomes Try again, and focus never moves (§1).
    await setMode(page, 'rejected');
    const send = results(page).getByRole('button', { name: 'Send' });
    await send.click();
    await expect(status(page)).toHaveText("Couldn't send your feedback.");
    const tryAgain = results(page).getByRole('button', { name: 'Try again' });
    await expect(tryAgain).toBeFocused();
    await expect(text).toHaveValue('abc');
    const verify = results(page).getByRole('button', { name: 'Verify this run' });
    await expect(verify, 'the region was released on the outcome').toHaveAttribute(
      'aria-disabled',
      'false',
    );

    // In flight (§6): the region is held, Verify is locked, and no edit gets through.
    await setMode(page, 'hold');
    await tryAgain.click();
    await expect(status(page)).toHaveText('Sending your feedback…');
    await expect(verify).toHaveAttribute('aria-disabled', 'true');
    await verify.click({ force: true }); // aria-disabled: Playwright will not click it unforced
    await expect(status(page), 'a locked Verify says nothing').toHaveText('Sending your feedback…');
    // Count `change` events from here on: the render-from-model fallback would put a changed
    // choice back, so the final state alone cannot prove the edit was PREVENTED (§6).
    await page.evaluate(() => {
      const w = window as unknown as { __changes: number };
      w.__changes = 0;
      document
        .querySelector('.wy-survey-form')!
        .addEventListener('change', () => void w.__changes++);
    });
    await text.focus();
    await page.keyboard.type('zzz');
    await expect(text).toHaveValue('abc');
    await rating(page, 3).focus();
    await page.keyboard.press('ArrowRight');
    await expect(rating(page, 3), 'an unprevented Arrow would move focus too').toBeFocused();
    await expect(rating(page, 3)).toBeChecked();
    await expect(rating(page, 4)).not.toBeChecked();
    await rating(page, 5).click({ force: true });
    await expect(rating(page, 3)).toBeChecked();
    await expect(rating(page, 5)).not.toBeChecked();
    const broke = results(page).getByRole('checkbox', { name: 'Something broke' });
    await broke.focus();
    await page.keyboard.press('Space');
    await expect(broke).not.toBeChecked();
    expect(
      await page.evaluate(() => (window as unknown as { __changes: number }).__changes),
      'no edit got as far as a change event',
    ).toBe(0);
    await axeClean(page, 'with a send in flight');

    // Play again is reachable mid-send, and cancels the whole operation (§1).
    await results(page).getByRole('button', { name: 'Play again' }).click();
    await expect(results(page)).toBeHidden();
    expect((await harness(page)).aborted).toBe(1);
    await page.evaluate(() => {
      (window as unknown as { __wySurvey: { release(r: string): void } }).__wySurvey.release(
        'accepted',
      );
    });
    // The cancelled send committed nothing: the next dialog still asks.
    await playToResults(page);
    await expect(giveFeedback(page)).toBeVisible();
    await expect(status(page)).toHaveText('');
  });

  test('don’t ask again sticks across versions, and unchecking it before committing clears it', async ({
    page,
  }) => {
    // Version A: arm the dismissal and commit it with Not now — then, on the SAME dialog,
    // reopen, disarm and commit again: the stored dismissal is cleared (§3's way back).
    await page.goto(`${HARNESS}?version=${VERSION_A}`);
    await playToResults(page);
    await giveFeedback(page).click();
    const dontAsk = results(page).getByRole('checkbox', { name: "Don't ask again" });
    await dontAsk.check();
    await results(page).getByRole('button', { name: 'Not now' }).click();
    await expect(giveFeedback(page), 'Not now returns focus to Give feedback').toBeFocused();
    await giveFeedback(page).click();
    await expect(dontAsk, 'the draft survives a collapse on the same dialog').toBeChecked();
    await dontAsk.uncheck();
    await results(page).getByRole('button', { name: 'Not now' }).click();
    await stored(page, '"dismissed":false');

    // Version B: offered (the dismissal was cleared). Now dismiss for good.
    await page.goto(`${HARNESS}?version=${VERSION_B}`);
    await playToResults(page);
    await expect(giveFeedback(page)).toBeVisible();
    await giveFeedback(page).click();
    await dontAsk.check();
    await results(page).getByRole('button', { name: 'Not now' }).click();
    await stored(page, '"dismissed":true');

    // Version C: never asked again.
    await page.goto(`${HARNESS}?version=${VERSION_C}`);
    await playToResults(page);
    await expect(results(page).getByRole('button', { name: 'Play again' })).toBeFocused();
    await presenceDecided(page);
    await expect(giveFeedback(page)).toBeHidden();
    expect((await harness(page)).sent).toHaveLength(0);
  });

  test.describe('on a short landscape viewport', () => {
    test.use({ viewport: { width: 740, height: 360 } });

    test('the expanded survey scrolls, and the dialog’s top stays reachable', async ({ page }) => {
      await page.goto(HARNESS);
      await playToResults(page);
      await giveFeedback(page).click();
      const dialog = results(page);
      const overflows = await dialog.evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(overflows, 'the case under test: the form is taller than the viewport').toBe(true);
      // Scrolled to the top, the heading is fully on screen — not centred into negative
      // overflow, where no scroll position could ever reach it.
      await dialog.evaluate((el) => {
        el.scrollTop = 0;
      });
      const heading = await dialog.getByRole('heading').boundingBox();
      expect(heading, 'the heading renders').not.toBeNull();
      expect(heading!.y).toBeGreaterThanOrEqual(0);
      await expect(dialog.getByRole('button', { name: 'Play again' })).toBeInViewport();
      // ...and the bottom of the form is reachable by scrolling.
      const send = dialog.getByRole('button', { name: 'Send' });
      await send.scrollIntoViewIfNeeded();
      await expect(send).toBeInViewport();
      await axeClean(page, 'expanded on a short viewport');
    });
  });
});
