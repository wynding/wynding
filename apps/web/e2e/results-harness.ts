import { expect, type Locator, type Page } from '@playwright/test';

// results-harness.ts — opening the results HARNESS (`e2e-harness/results.html`, served on 4176)
// and reading the panel's boxes, shared by the results-panel specs (#181 H2).

export const HARNESS = 'http://localhost:4176/e2e-harness/results.html';

export type Run = 'win' | 'loss';

/** Open the harness on a finished run, with the survey offered so Give feedback takes its place
 *  in the action row, and wait for the panel's resting place to settle. Give feedback arrives a
 *  task after the dialog opens (the harness's ask refresh takes a Web Lock, as production's
 *  does), so the panel has re-settled for it by the time this returns. */
export async function openResults(page: Page, run: Run, text: 100 | 200 = 100): Promise<Locator> {
  await page.goto(`${HARNESS}?run=${run}&survey=1${text === 200 ? '&text=200' : ''}`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  // The fixture took: a test "at 200% text" that ran at 100% would prove nothing about zoom.
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).fontSize),
    `the page opened at ${String(text)}% text`,
  ).toBe(text === 200 ? '32px' : '16px');
  await expect(dialog.getByRole('button', { name: 'Give feedback' })).toBeVisible();
  await twoFrames(page);
  return dialog;
}

/** Two frames: the panel's resting place is (re)settled by a ResizeObserver pass. */
export async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

export const toggleOf = (dialog: Locator): Locator =>
  dialog.getByRole('button', { name: 'Run data', exact: true });

export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** An element's layout box, whether or not it is visible (Give feedback is `visibility:
 *  hidden` while its form is open, and keeps its box — `boundingBox()` would report null). */
export async function boxOf(page: Page, selector: string): Promise<Box> {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
}

export function expectSameBox(actual: Box, expected: Box, what: string): void {
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(actual[k] - expected[k]), `${what}: ${k} moved`).toBeLessThanOrEqual(0.5);
  }
}
