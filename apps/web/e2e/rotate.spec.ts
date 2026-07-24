import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// The rotate overlay (PLAN.md P5/P6): shown on `(orientation: portrait)` AND
// `(pointer: coarse)` both matching. Runs under `chromium-touch`
// (`devices['Galaxy S9+ landscape']`) — landscape 658×320 by default; this spec swaps the
// viewport dimensions to flip the orientation media query while `hasTouch`/coarse-pointer
// stay constant (they come from the device profile, not the viewport).

// WCAG contrast helpers, duplicated from smoke.spec.ts (existing precedent: no shared e2e
// helper module — each spec file keeps its own small copy).
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
