import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// results-panel.spec.ts — the results panel (#181 H2) in a real browser, on finished runs.
//
// It runs against the results HARNESS (`e2e-harness/results.html`, served on 4176 beside the
// survey harness): the page plays a proven build script through the real controller — to a WIN
// (`?run=win`, the content suite's winning showcase build) or a LOSS (`?run=loss`, its 12-tower
// prefix) — then boots the real app on that finished run, so the dialog opens on the first
// frame with the run's own outcome, score, stars and numbers. `&survey=1` offers the survey,
// so Give feedback takes its place in the action row.
//
// What only a browser can prove, and the unit suites cannot: the disclosure's keyboard
// behaviour and tab order, the treatments as painted, axe over both of its states, the panel's
// fit at the four sizes the campaign checks, and where it rests while something opens.

const HARNESS = 'http://localhost:4176/e2e-harness/results.html';

type Run = 'win' | 'loss';

/** What each scripted run reads. The numbers are `controller.test.ts`'s, which derives them
 *  from the pure sim independently of the counters the panel reads; the score and the stars are
 *  the run's own, asserted below against the panel's one accessible sentence. */
const EXPECTED: Record<
  Run,
  {
    heading: string;
    subtitle: string;
    stars: number;
    tiles: readonly (readonly [string, string])[];
  }
> = {
  win: {
    heading: 'The maze held.',
    subtitle: 'All 10 waves cleared',
    stars: 3,
    tiles: [
      ['Waves cleared', '10 / 10'],
      ['Creeps stopped', '117'],
      ['Leaks', '0'],
      ['Towers built', '40'],
    ],
  },
  loss: {
    heading: 'The creeps broke through.',
    subtitle: 'Lost on wave 9 of 10',
    stars: 0,
    tiles: [
      ['Waves cleared', '8 / 10'],
      ['Creeps stopped', '93'],
      ['Leaks', '10'],
      ['Towers built', '12'],
    ],
  },
};

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 740, height: 360 },
  { width: 658, height: 320 }, // Galaxy S9+ landscape — Compact
] as const;

const ITEMS = ['Verify this run', 'Copy run data', 'Save run data'] as const;

async function openResults(page: Page, run: Run): Promise<Locator> {
  await page.goto(`${HARNESS}?run=${run}&survey=1`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('button', { name: 'Give feedback' })).toBeVisible();
  // Two frames: the panel's resting place is settled by a ResizeObserver pass.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return dialog;
}

const toggleOf = (dialog: Locator): Locator =>
  dialog.getByRole('button', { name: 'Run data', exact: true });

async function axeClean(page: Page, when: string): Promise<void> {
  const audit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(audit.violations, `axe violations ${when}`).toEqual([]);
}

/** A colour as the browser computes it — a token (`var(--…)`) or a system colour. */
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

for (const run of ['win', 'loss'] as const) {
  test(`the ${run} treatment: its band, heading, subtitle, stars, score and the run’s numbers`, async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[0]);
    const dialog = await openResults(page, run);
    const want = EXPECTED[run];

    // The outcome is the heading's, and the dialog is named by it.
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(want.heading);
    await expect(dialog).toHaveAccessibleName(want.heading);
    await expect(dialog.locator('.wy-results-subtitle')).toHaveText(want.subtitle);

    // ONE sentence carries the score and the stars to assistive tech — the dialog's
    // description — and the drawn grade beside it is hidden from it, so nothing reads twice.
    const score = (await dialog.locator('.wy-results-score-value').textContent()) ?? '';
    expect(score).toMatch(/^\d+$/);
    await expect(dialog).toHaveAccessibleDescription(
      `Score ${score} — ${String(want.stars)} of 3 stars`,
    );
    await expect(dialog.locator('.wy-results-grade')).toHaveAttribute('aria-hidden', 'true');

    // Three stars, the earned ones first.
    const stars = dialog.locator('.wy-results-star');
    await expect(stars).toHaveCount(3);
    const earned = await stars.evaluateAll((all) => all.map((s) => s.getAttribute('data-earned')));
    expect(earned).toEqual([0, 1, 2].map((i) => String(i < want.stars)));

    // The four tiles are real text, label and value, in reading order.
    await expect(dialog.getByRole('term')).toHaveText(want.tiles.map(([label]) => label));
    await expect(dialog.getByRole('definition')).toHaveText(want.tiles.map(([, value]) => value));

    // As painted: the band in the outcome's colour, the stars filled or dimmed, and the leaks
    // in the danger ink on a loss only.
    const painted = await page.evaluate(() => {
      const panel = document.querySelector('.wy-results-panel')!;
      const leaks = document.querySelector('.wy-results-stat[data-stat="leaks"] dd')!;
      const built = document.querySelector('.wy-results-stat[data-stat="towersBuilt"] dd')!;
      const bodies = [...document.querySelectorAll('.wy-results-star .wy-icon-body')];
      return {
        outcome: panel.getAttribute('data-outcome'),
        band: getComputedStyle(panel, '::before').backgroundColor,
        bandHeight: getComputedStyle(panel, '::before').height,
        starFills: bodies.map((b) => getComputedStyle(b).fill),
        starStrokes: bodies.map((b) => getComputedStyle(b).stroke),
        leaks: getComputedStyle(leaks).color,
        otherValue: getComputedStyle(built).color,
      };
    });
    expect(painted.outcome).toBe(run === 'win' ? 'won' : 'lost');
    expect(painted.bandHeight).toBe('5px');
    expect(painted.band).toBe(
      await resolveColour(page, run === 'win' ? 'var(--wy-stars)' : 'var(--wy-loss)'),
    );
    const gold = await resolveColour(page, 'var(--wy-stars)');
    const dim = await resolveColour(page, 'var(--wy-star-empty)');
    const edge = await resolveColour(page, 'var(--wy-panel-edge)');
    painted.starFills.forEach((fill, i) => {
      expect(fill, `star ${String(i + 1)}`).toBe(i < want.stars ? gold : dim);
    });
    // An unearned star keeps its shape by its outline: the grade never reads by colour alone.
    for (const stroke of painted.starStrokes.slice(want.stars)) expect(stroke).toBe(edge);
    if (run === 'loss') {
      expect(painted.leaks).toBe(await resolveColour(page, 'var(--wy-danger)'));
      expect(painted.leaks).not.toBe(painted.otherValue);
    } else {
      expect(painted.leaks).toBe(painted.otherValue);
    }
  });
}

test('Run data is a disclosure: click, Enter and Space toggle it, aria-expanded keeps step, and its actions join the tab order only while open', async ({
  page,
}) => {
  await page.setViewportSize(SIZES[0]);
  const dialog = await openResults(page, 'win');
  const playAgain = dialog.getByRole('button', { name: 'Play again' });
  const feedback = dialog.getByRole('button', { name: 'Give feedback' });
  const toggle = toggleOf(dialog);
  const items = ITEMS.map((name) => dialog.getByRole('button', { name }));
  const [verify] = items;

  // Collapsed on open, with Play again focused, and controlling the group it names.
  await expect(playAgain).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const controls = (await toggle.getAttribute('aria-controls')) ?? '';
  expect(controls).not.toBe('');
  const group = page.locator(`[id="${controls}"]`);
  await expect(group).toHaveCount(1);
  await expect(group).toBeHidden();
  for (const item of items) await expect(item).toBeHidden();
  const focusInGroup = (): Promise<boolean> =>
    group.evaluate((g) => g.contains(document.activeElement));

  // Closed: Tab walks Play again → Give feedback → Run data, then leaves the three alone.
  await page.keyboard.press('Tab');
  await expect(feedback).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await focusInGroup(), 'a collapsed group holds no tab stop').toBe(false);

  // Enter opens it, keeps focus on the toggle, and the three follow it in the tab order.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(group).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'Run data' })).toBeVisible();
  await expect(toggle).toBeFocused();
  for (const item of items) {
    await page.keyboard.press('Tab');
    await expect(item).toBeFocused();
  }
  // ...and Shift+Tab walks back to the toggle.
  for (const item of [...items].reverse().slice(1)) {
    await page.keyboard.press('Shift+Tab');
    await expect(item).toBeFocused();
  }
  await page.keyboard.press('Shift+Tab');
  await expect(toggle).toBeFocused();

  // Space closes it; focus stays put, and Tab no longer reaches the three.
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(group).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await focusInGroup()).toBe(false);

  // Space opens it again, and a click closes and reopens it — every route keeps step.
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(group).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(group).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  for (const item of items) await expect(item).toBeVisible();

  // The disclosed actions are the same ones as before: Verify reports through the dialog's one
  // status region.
  await verify!.click();
  await expect(dialog.getByRole('status')).toContainText('Verified');
});

test('the panel is axe-clean with Run data closed and open, on a win and a loss', async ({
  page,
}) => {
  await page.setViewportSize(SIZES[0]);
  for (const run of ['win', 'loss'] as const) {
    const dialog = await openResults(page, run);
    await axeClean(page, `${run}, Run data closed`);
    await toggleOf(dialog).click();
    await expect(dialog.getByRole('button', { name: ITEMS[0] })).toBeVisible();
    await axeClean(page, `${run}, Run data open`);
  }
});

/** Where the panel stands, and what overflows: everything the fit test reads in one pass. */
async function geometry(page: Page): Promise<{
  panel: { left: number; top: number; right: number; bottom: number };
  restTop: number;
  restBottom: number;
  dialogOverflow: [number, number];
  bodyOverflow: [number, number];
}> {
  return page.evaluate(() => {
    const dialogEl = document.querySelector<HTMLElement>('.wy-results')!;
    const panel = document.querySelector('.wy-results-panel')!.getBoundingClientRect();
    const body = document.querySelector('.wy-results-body')!;
    const pad = getComputedStyle(dialogEl);
    return {
      panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom },
      restTop: parseFloat(pad.paddingTop),
      restBottom: innerHeight - parseFloat(pad.paddingBottom),
      dialogOverflow: [
        dialogEl.scrollWidth - dialogEl.clientWidth,
        dialogEl.scrollHeight - dialogEl.clientHeight,
      ],
      bodyOverflow: [body.scrollWidth - body.clientWidth, body.scrollHeight - body.clientHeight],
    };
  });
}

for (const size of SIZES) {
  test(`fits at ${String(size.width)}×${String(size.height)}: whole while closed, reachable while open, and Run data opens downward`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    for (const run of ['win', 'loss'] as const) {
      const dialog = await openResults(page, run);
      const toggle = toggleOf(dialog);
      const inViewport = (g: Awaited<ReturnType<typeof geometry>>, when: string): void => {
        expect(g.panel.left, `${run} ${when}: left edge`).toBeGreaterThanOrEqual(0);
        expect(g.panel.right, `${run} ${when}: right edge`).toBeLessThanOrEqual(size.width);
        expect(g.panel.top, `${run} ${when}: top edge`).toBeGreaterThanOrEqual(0);
        expect(g.panel.bottom, `${run} ${when}: bottom edge`).toBeLessThanOrEqual(size.height);
        expect(g.dialogOverflow, `${run} ${when}: the dialog itself never scrolls`).toEqual([0, 0]);
        expect(g.bodyOverflow[0], `${run} ${when}: no sideways scroll`).toBeLessThanOrEqual(0);
      };

      // Closed: the whole panel fits, with nothing to scroll, and it rests centred.
      const closed = await geometry(page);
      inViewport(closed, 'closed');
      expect(closed.bodyOverflow[1], `${run} closed: the panel fits whole`).toBeLessThanOrEqual(0);
      // The resting spacer is a whole number of pixels, floored, so the panel may sit up to a
      // pixel above true centre: the two gaps differ by less than two pixels, never more.
      const above = closed.panel.top - closed.restTop;
      const below = closed.restBottom - closed.panel.bottom;
      expect(above - below, `${run} closed: centred`).toBeLessThanOrEqual(0.5);
      expect(above - below, `${run} closed: centred`).toBeGreaterThan(-2);
      for (const name of ['Play again', 'Give feedback']) {
        await expect(dialog.getByRole('button', { name })).toBeInViewport();
      }
      await expect(dialog.getByRole('heading')).toBeInViewport();
      await expect(toggle).toBeInViewport();

      // Open: the group grows the panel DOWNWARD from its resting place. The toggle moves only
      // where the open panel cannot fit below it, and then only as far as it must — the panel's
      // foot lands on the dialog's — and never down.
      const before = await toggle.boundingBox();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const after = await toggle.boundingBox();
      const open = await geometry(page);
      inViewport(open, 'open');
      const dy = (after?.y ?? NaN) - (before?.y ?? NaN);
      expect(dy, `${run}: the toggle never moves down`).toBeLessThanOrEqual(0.5);
      if (Math.abs(dy) > 0.5) {
        expect(
          Math.abs(open.panel.bottom - open.restBottom),
          `${run}: gave way only as far as it must`,
        ).toBeLessThanOrEqual(1);
      }
      for (const name of ITEMS) {
        const item = dialog.getByRole('button', { name });
        await item.scrollIntoViewIfNeeded();
        await expect(item).toBeInViewport();
      }
    }
  });
}

test('at 1440×900 the Run data toggle stays where it was pressed, and so does Verify when it reports', async ({
  page,
}) => {
  await page.setViewportSize(SIZES[0]);
  const dialog = await openResults(page, 'win');
  const toggle = toggleOf(dialog);
  const before = await toggle.boundingBox();
  await toggle.click();
  const verify = dialog.getByRole('button', { name: ITEMS[0] });
  await expect(verify).toBeVisible();
  expect((await toggle.boundingBox())?.y).toBeCloseTo(before?.y ?? NaN, 1);
  // A status message grows the panel downward too: Verify's report moves nothing above it.
  const verifyBefore = await verify.boundingBox();
  await verify.click();
  await expect(dialog.getByRole('status')).toContainText('Verified');
  expect((await verify.boundingBox())?.y).toBeCloseTo(verifyBefore?.y ?? NaN, 1);
});

test('forced colors: the stars, the outcome band and the chevron take the user’s system colours', async ({
  page,
}) => {
  // Chromium does not force SVG `fill` or `stroke`, and forced colors reset the band — a
  // background — to the Canvas it sits on. Emulated BEFORE the page loads, as the HUD's
  // forced-colors test does, and checked against the system colours themselves: under emulated
  // forced colors axe-core reads the authored text colours (`hud-strip.spec.ts` says why).
  await page.emulateMedia({ forcedColors: 'active' });
  await page.setViewportSize(SIZES[0]);
  for (const run of ['win', 'loss'] as const) {
    const dialog = await openResults(page, run);
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    const canvasText = await resolveColour(page, 'CanvasText');
    const canvas = await resolveColour(page, 'Canvas');
    expect(canvasText).not.toBe(canvas);
    await toggleOf(dialog).click();
    const inks = await page.evaluate(() => {
      const panel = document.querySelector('.wy-results-panel')!;
      const toggle = document.querySelector('.wy-results-more')!;
      const bodies = [...document.querySelectorAll('.wy-results-star .wy-icon-body')];
      return {
        fills: bodies.map((b) => getComputedStyle(b).fill),
        strokes: bodies.map((b) => getComputedStyle(b).stroke),
        band: getComputedStyle(panel, '::before').backgroundColor,
        bandAdjust: getComputedStyle(panel, '::before').getPropertyValue('forced-color-adjust'),
        chevron: getComputedStyle(document.querySelector('.wy-results-chevron')!).stroke,
        toggleInk: getComputedStyle(toggle).color,
      };
    });
    const earned = EXPECTED[run].stars;
    // Earned stars are solid in the text colour; unearned ones are outlined in it, on Canvas.
    inks.fills.forEach((fill, i) => expect(fill).toBe(i < earned ? canvasText : canvas));
    for (const stroke of inks.strokes) expect(stroke).toBe(canvasText);
    expect(inks.band).toBe(canvasText);
    expect(inks.bandAdjust).toBe('none');
    // The chevron strokes in its button's own (forced) colour, with the label.
    expect(inks.chevron).toBe(inks.toggleInk);
  }
});
