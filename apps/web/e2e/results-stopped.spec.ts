import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PNG } from 'pngjs';
import { HARNESS, toggleOf } from './results-harness';

// The results dialog's STOPPED form (#191), in a real browser. A run an error stopped opens the
// same dialog saying where the run stopped, with Start again in Play again's place, never Verify,
// and Run data only where the stopped run could be saved: after a draw that kept failing (the sim
// whole), never after a sim step that threw. The grade, the tiles and the Run data toggle are
// taken away by `[hidden]` rules a unit test cannot see (`ui.css` restores `display: none` over
// each part's own `display`), so they are checked here, with the band and an axe scan. The
// harness plays the run to wave 3 and breaks it on the app's tenth frame (`results-entry.ts`).
//
// Phaser's own frame loop, which makes the board's pixels, is guarded too (#195). The harness
// breaks Phaser's real render pass (`render`): a render that keeps failing must stop the run as a
// draw that keeps failing does, with nothing escaping to the page, and one that fails once must
// cost a frame, not the board: Phaser's loop goes on, the board is drawn again and the run
// carries on, with no stopped form. These run in WebKit too, since the render path is the
// browser's; the other stops are the app's own JavaScript, and run in Chromium only.

/** Why a render break is skipped: what the harness breaks is Phaser's WebGL render pass. */
const NEEDS_WEBGL =
  'Phaser draws this board with its Canvas renderer here, which never calls ' +
  "MultiPipeline#batchSprite, the WebGL render pass the harness's render breaks patch";

/** Whether Phaser draws the board with its WebGL renderer. Phaser makes its context when it
 *  boots, before its canvas joins the page, and a canvas holds one kind of context: asking for
 *  `webgl` hands back Phaser's own, or null under its Canvas renderer. */
async function drawsWithWebGL(page: Page): Promise<boolean> {
  return page
    .locator('.wy-board canvas')
    .evaluate((c) => (c as HTMLCanvasElement).getContext('webgl') !== null);
}

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

for (const stop of ['step', 'draw', 'render'] as const) {
  for (const size of SIZES) {
    test(`a ${stop} stop opens the stopped form at ${String(size.width)}x${String(size.height)}`, async ({
      page,
      browserName,
    }) => {
      test.skip(
        browserName === 'webkit' && stop !== 'render',
        "the app's own stops run in Chromium only; WebKit runs the render breaks",
      );
      await page.setViewportSize(size);
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      await page.goto(`${HARNESS}?stop=${stop}`);
      if (stop === 'render') test.skip(!(await drawsWithWebGL(page)), NEEDS_WEBGL);

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

      // Run data: Copy and Save after a draw or render stop (the sim whole), never Verify; nothing
      // at all after a step stop.
      const toggle = toggleOf(dialog);
      if (stop !== 'step') {
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
      if (stop === 'render') {
        // ...after the failed frames, logged once with what Phaser's render threw (#195).
        expect(
          consoleErrors.filter((m) => m.startsWith('Wynding: a frame failed')),
          "the render's own error, logged once",
        ).toEqual([expect.stringContaining('results harness: the render broke')]);
      }
    });
  }
}

/** `n` animation frames from now. */
async function animationFrames(page: Page, n: number): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const step = (): void => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    n,
  );
}

/** The share of the board's screenshot that is not the canvas's clear colour (Phaser's
 *  `backgroundColor`, `scene.ts`): the floor alone covers most of a drawn board, and a blank one
 *  shows the clear colour and nothing else. */
async function drawnShare(page: Page): Promise<number> {
  const box = await page.locator('.wy-board').boundingBox();
  expect(box, 'the board is laid out').not.toBeNull();
  const png = PNG.sync.read(await page.screenshot({ clip: box! }));
  const clear = [0x12, 0x14, 0x1c];
  let drawn = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (clear.some((c, k) => Math.abs((png.data[i + k] as number) - c) > 4)) drawn++;
  }
  return drawn / (png.width * png.height);
}

test('a render that breaks once costs Phaser a frame: the board draws again, and the run carries on', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.goto(`${HARNESS}?stop=render-once`);
  test.skip(!(await drawsWithWebGL(page)), NEEDS_WEBGL);

  type Break = { threw: number; frame: () => number };
  const threw = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { __wyRenderBreak: Break }).__wyRenderBreak.threw);
  const phaserFrame = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { __wyRenderBreak: Break }).__wyRenderBreak.frame());
  const board = page.locator('.wy-board');
  const tick = async (): Promise<number> => Number(await board.getAttribute('data-sim-tick'));

  // Phaser's render threw, once.
  await expect.poll(threw, { timeout: 30_000 }).toBe(1);
  const frameAtBreak = await phaserFrame();
  const tickAtBreak = await tick();
  // Half a second of animation frames on, Phaser's loop has gone on: its frame count has moved,
  // and the board is drawn again.
  await animationFrames(page, 30);
  expect.soft(await phaserFrame(), "Phaser's frame count").toBeGreaterThan(frameAtBreak + 10);
  expect.soft(await drawnShare(page), 'the share of the board drawn').toBeGreaterThan(0.25);
  // And the run carries on: the sim held for the frame that failed, then stepped on.
  await expect.poll(tick, { timeout: 10_000 }).toBeGreaterThan(tickAtBreak + 10);

  // One failed frame: held and logged once, with what the render threw, and never a stop.
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(await threw(), 'the render broke once').toBe(1);
  expect(
    consoleErrors.filter((m) => m.startsWith('Wynding: a frame failed')),
    "the render's own error, logged once",
  ).toEqual([expect.stringContaining('results harness: the render broke')]);
  expect(consoleErrors.filter((m) => m.startsWith('Wynding: the run stopped'))).toEqual([]);
  expect(pageErrors, 'nothing uncaught').toEqual([]);
});
