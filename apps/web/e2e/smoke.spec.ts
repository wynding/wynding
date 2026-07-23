import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// One end-to-end smoke over the M1 slice, carrying the ADR 0003 axe-core audit. It
// exercises the real DOM UI (HUD + controls + settings) and the run lifecycle, then
// asserts zero accessibility violations. The Phaser canvas is out of axe's scope (ADR
// 0003 §3 — covered by the accessibility checklist + unit tests), so we audit the DOM.

// WCAG relative luminance / contrast ratio — the real-browser counterpart to the unit
// contrast gates (palette.test.ts, ui-contrast.test.ts): this checks the ACTUAL rendered
// colours via getComputedStyle, catching a future hardcoded hex or unused token that a
// static/token test cannot see.
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rl, gl, bl] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function parseRgb(css: string): [number, number, number] {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
  if (m === null) throw new Error(`unparsable colour: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Rendered-contrast spot check for one element: its own `color` against its own
 *  `background-color` (each pair has its own background — not the page's). */
async function assertRenderedContrast(
  page: Page,
  selector: string,
  minRatio: number,
): Promise<void> {
  const colours = await page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
  const ratio = contrastRatio(parseRgb(colours.color), parseRgb(colours.background));
  expect(
    ratio,
    `${selector}: ${colours.color} on ${colours.background} = ${ratio.toFixed(2)}`,
  ).toBeGreaterThanOrEqual(minRatio);
}

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

  // Rendered-contrast spot checks (actual computed colours, not tokens): body text and a
  // control button, each against its own background.
  await assertRenderedContrast(page, 'body', 4.5);
  await assertRenderedContrast(page, '.wy-btn', 4.5);
});

test('supports the pause / speed / call-wave controls and reaches a result', async ({ page }) => {
  test.setTimeout(90_000);
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

  // axe audit of the results-dialog state — the settings-panel state is covered by the
  // other test; this closes the gap where the dialog was never scanned.
  const dialogResults = await new AxeBuilder({ page }).include('#app').analyze();
  expect(dialogResults.violations, JSON.stringify(dialogResults.violations, null, 2)).toEqual([]);

  // Modal semantics: the board, the controls, and the title all carry `inert` while the
  // dialog is open, and Tab never escapes into them. `body` is the transit state (identical
  // to native `showModal()`, which also hands focus to browser chrome between tabbables
  // rather than wrapping directly) — so it's an allowed member of the "outside the dialog"
  // set per press, but the count + re-entry assertions below prove focus keeps cycling back
  // into the dialog rather than escaping permanently.
  await expect(page.locator('.wy-title')).toHaveAttribute('inert', '');
  await expect(page.locator('.wy-board')).toHaveAttribute('inert', '');
  await expect(page.locator('.wy-controls')).toHaveAttribute('inert', '');

  const dialogTabbableCount = await results
    .locator('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    .count();
  let inDialogCount = 0;
  let lastOnBody = false;
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    const inDialog = await page.evaluate(() => {
      const el = document.activeElement;
      const dialog = document.querySelector('[role="dialog"]');
      return dialog !== null && el !== null && dialog.contains(el);
    });
    const onBody = await page.evaluate(() => document.activeElement === document.body);
    expect(
      inDialog || onBody,
      `Tab press ${i + 1} landed outside the dialog and outside body`,
    ).toBe(true);
    if (inDialog) inDialogCount++;
    lastOnBody = onBody;
  }
  expect(
    inDialogCount,
    `only ${inDialogCount}/10 Tab presses landed in the dialog`,
  ).toBeGreaterThanOrEqual(6);
  if (lastOnBody) {
    // Focus transited to body on the final press — confirm it re-enters the dialog rather
    // than escaping permanently.
    await page.keyboard.press('Tab');
    const backInDialog = await page.evaluate(() => {
      const el = document.activeElement;
      const dialog = document.querySelector('[role="dialog"]');
      return dialog !== null && el !== null && dialog.contains(el);
    });
    expect(backInDialog, 'focus did not re-enter the dialog after transiting body').toBe(true);
  }
  expect(dialogTabbableCount).toBeGreaterThan(0);

  // Rendered-contrast spot check inside the dialog: the primary Play-again button.
  await assertRenderedContrast(page, '.wy-primary', 4.5);

  // Dev-verify re-simulates the recorded replay and confirms it matches.
  await page.getByRole('button', { name: 'Verify this run' }).click();
  await expect(page.locator('.wy-verify')).toContainText('Verified');

  // Focus-restore: Play again clears inert and returns focus to the board.
  await page.getByRole('button', { name: 'Play again' }).click();
  await expect(page.locator('.wy-title')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.wy-board')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.wy-board')).toBeFocused();
});
