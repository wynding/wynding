import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { HARNESS, toggleOf } from './results-harness';

// The results dialog's STOPPED form (#191), in a real browser. A run an error stopped opens the
// same dialog saying where the run stopped, with Start again in Play again's place, never Verify,
// and Run data only where the stopped run could be saved: after a draw that kept failing (the sim
// whole), never after a sim step that threw. The grade, the tiles and the Run data toggle are
// taken away by `[hidden]` rules a unit test cannot see (`ui.css` restores `display: none` over
// each part's own `display`), so they are checked here, with the band and an axe scan. The
// harness plays the run to wave 3 and breaks it on the app's tenth frame (`results-entry.ts`).

const SIZES = [
  { width: 1440, height: 900 },
  { width: 658, height: 320 }, // Galaxy S9+ landscape — Compact
] as const;

/** A colour as the browser computes it. */
async function resolveColour(page: Page, value: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement('span');
    probe.style.color = v;
    document.body.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);
}

for (const stop of ['step', 'draw'] as const) {
  for (const size of SIZES) {
    test(`a ${stop} stop opens the stopped form at ${String(size.width)}x${String(size.height)}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      await page.goto(`${HARNESS}?stop=${stop}`);

      const dialog = page.getByRole('dialog', { name: 'Something went wrong.' });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      const sentence = 'The run stopped at wave 3 because of an error.';
      await expect(dialog).toHaveAccessibleDescription(sentence);
      // ...said once: its visible copy is `aria-hidden` beside the description.
      const subtitle = dialog.locator('.wy-results-subtitle');
      await expect(subtitle).toHaveText(sentence);
      await expect(subtitle).toBeVisible();
      await expect(subtitle).toHaveAttribute('aria-hidden', 'true');

      // No outcome: no grade, no tiles, no Play again; Start again takes its place and its focus.
      await expect(page.locator('.wy-results-grade')).toBeHidden();
      await expect(page.locator('.wy-results-stats')).toBeHidden();
      await expect(dialog.getByRole('button', { name: 'Play again' })).toHaveCount(0);
      const startAgain = dialog.getByRole('button', { name: 'Start again' });
      await expect(startAgain).toBeFocused();

      // Run data: Copy and Save after a draw stop, never Verify; nothing at all after a step stop.
      const toggle = toggleOf(dialog);
      if (stop === 'draw') {
        await expect(toggle).toBeVisible();
        await toggle.click();
        await expect(dialog.getByRole('button', { name: 'Copy run data' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Save run data' })).toBeVisible();
      } else {
        await expect(toggle).toBeHidden();
      }
      await expect(dialog.getByRole('button', { name: 'Verify this run' })).toBeHidden();

      // The band takes the loss red: a stopped run must not read as a win.
      const band = await page.evaluate(
        () =>
          getComputedStyle(document.querySelector('.wy-results-panel')!, '::before')
            .backgroundColor,
      );
      expect(band).toBe(await resolveColour(page, 'var(--wy-loss)'));

      const audit = await new AxeBuilder({ page }).include('#app').analyze();
      expect(audit.violations, 'axe violations').toEqual([]);

      // State-driven: Escape is consumed, never a dismissal.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();

      if (stop === 'step') {
        // Start again: a fresh run, held at its start, that a player can begin.
        await page.waitForTimeout(600); // past the press guard's hold on a fresh dialog
        await startAgain.click();
        await expect(dialog).toBeHidden();
        const board = page.locator('.wy-board');
        await expect(board).toHaveAttribute('data-started', 'false');
        await expect(board).toHaveAttribute('data-sim-tick', '0');
      }

      // Nothing escaped to the page: the stop is caught, and its one record is the console's.
      expect(pageErrors, 'nothing uncaught').toEqual([]);
      expect(
        consoleErrors.some((m) => m.startsWith('Wynding: the run stopped')),
        'the stop is logged',
      ).toBe(true);
    });
  }
}
