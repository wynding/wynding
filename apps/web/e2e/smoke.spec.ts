import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// One end-to-end smoke over the M1 slice, carrying the ADR 0003 axe-core audit. It
// exercises the real DOM UI (HUD + controls + settings) and the run lifecycle, then
// asserts zero accessibility violations. The Phaser canvas is out of axe's scope (ADR
// 0003 §3 — covered by the accessibility checklist + unit tests), so we audit the DOM.

test('renders the HUD, controls, and settings with no axe violations', async ({ page }) => {
  await page.goto('/');

  // Title + HUD + core controls are present as semantic elements.
  await expect(page.locator('.wy-title')).toHaveText('Wynding');
  await expect(page.locator('.wy-hud')).toContainText('Lives:');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

  // Open the accessibility settings and switch colour-vision mode + reduced motion.
  await page.getByRole('button', { name: 'Accessibility settings' }).click();
  await page.getByLabel('Deuteranopia').check();
  await page.getByLabel('Reduce motion').check();

  // axe audit of the live DOM UI.
  const results = await new AxeBuilder({ page }).include('#app').analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('supports the pause / speed / call-wave controls and reaches a result', async ({ page }) => {
  await page.goto('/');

  const pause = page.getByRole('button', { name: 'Pause' });
  await pause.click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();

  await page.getByRole('button', { name: 'Call wave now' }).click();
  // Run at 2× so the no-tower loss resolves well within the timeout regardless of CI
  // runner speed (a full M1 wave at 1× can approach ~25 s of wall-clock).
  await page.getByRole('button', { name: /^Speed:/ }).click();

  // The run resolves; the results dialog appears with a Play-again + Verify affordance.
  const results = page.getByRole('dialog');
  await expect(results).toBeVisible({ timeout: 40_000 });
  await expect(page.getByRole('button', { name: 'Verify this run' })).toBeVisible();

  // Dev-verify re-simulates the recorded replay and confirms it matches.
  await page.getByRole('button', { name: 'Verify this run' }).click();
  await expect(page.locator('.wy-verify')).toContainText('Verified');
});
