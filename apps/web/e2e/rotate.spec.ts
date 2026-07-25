import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { assertRenderedContrast } from './contrast';

// The rotate overlay (PLAN.md P5/P6): shown on `(orientation: portrait)` AND
// `(pointer: coarse)` both matching. Runs under `chromium-touch`
// (`devices['Galaxy S9+ landscape']`) — landscape 658×320 by default; this spec swaps the
// viewport dimensions to flip the orientation media query while `hasTouch`/coarse-pointer
// stay constant (they come from the device profile, not the viewport).

const LANDSCAPE = { width: 658, height: 320 };
const PORTRAIT = { width: 320, height: 658 };

test('rotating to portrait shows the overlay and auto-pauses; returning to landscape closes it but the run stays paused until an explicit Resume', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/');

  // Precondition: the gate is `(pointer: coarse)` — assert it rather than assume the
  // device profile implies it.
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  expect(coarse).toBe(true);

  const board = page.locator('.wy-board');
  await page.getByRole('button', { name: 'Start' }).click();

  // Ticks advance while landscape and running.
  const tickAtStart = await board.getAttribute('data-sim-tick');
  await expect.poll(() => board.getAttribute('data-sim-tick')).not.toBe(tickAtStart);

  // Rotate to portrait: the overlay appears (gated on orientation AND pointer both
  // matching — this project's coarse pointer already confirmed above).
  await page.setViewportSize(PORTRAIT);
  const rotateDialog = page.getByRole('dialog', { name: 'Rotate your device' });
  await expect(rotateDialog).toBeVisible();

  // The run auto-pauses: sample the tick twice across a delay — it must not move either time.
  const stoppedTick = await board.getAttribute('data-sim-tick');
  await page.waitForTimeout(300);
  await expect(board).toHaveAttribute('data-sim-tick', stoppedTick as string);
  await page.waitForTimeout(300);
  await expect(board).toHaveAttribute('data-sim-tick', stoppedTick as string);

  // axe + rendered contrast on the rotate overlay itself.
  const results = await new AxeBuilder({ page }).include('#app').analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  await assertRenderedContrast(page, '.wy-rotate p', 4.5);

  // Back to landscape: the overlay closes, but the run STAYS paused — nothing auto-resumes.
  await page.setViewportSize(LANDSCAPE);
  await expect(rotateDialog).toBeHidden();
  await page.waitForTimeout(300);
  await expect(board).toHaveAttribute('data-sim-tick', stoppedTick as string);
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();

  // Only an explicit Resume from the Dock advances the tick again.
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => board.getAttribute('data-sim-tick')).not.toBe(stoppedTick);
});
