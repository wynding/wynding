import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  boxOf,
  expectSameBox,
  openResults,
  toggleOf,
  twoFrames,
  type Box,
  type Run,
} from './results-harness';

// results-panel.spec.ts — the results panel (#181 H2) in a real browser, on finished runs.
//
// It runs against the results HARNESS (`e2e-harness/results.html`, served on 4176 beside the
// survey harness): the page plays a proven build script through the real controller — to a WIN
// (`?run=win`, the content suite's winning showcase build) or a LOSS (`?run=loss`, its 12-tower
// prefix) — then boots the real app on that finished run, so the dialog opens on the first
// frame with the run's own outcome, score, stars and numbers. `&survey=1` offers the survey,
// so Give feedback takes its place in the action row; `&text=200` opens it at 200% text.
//
// What only a browser can prove, and the unit suites cannot: the disclosure's keyboard
// behaviour and tab order, the treatments as painted, axe over every state, the panel's fit and
// resting place at the campaign's sizes and at 200% text, and that opening Run data never moves
// its toggle, pressed with the real pointer (`page.mouse`), which, unlike a locator's click,
// never scrolls anything into view first. That a press never activates a control it was not
// aimed at is `results-pointer.spec.ts`'s, in Chromium and WebKit. The panel where a scrollbar
// takes room is `results-panel-scrollbar.spec.ts`'s: it needs a browser started with scrollbars.

type Size = { readonly width: number; readonly height: number };

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

const DESKTOP: Size = { width: 1440, height: 900 };

/** The campaign's four fit sizes. */
const FIT_SIZES: readonly Size[] = [
  DESKTOP,
  { width: 1280, height: 720 },
  { width: 740, height: 360 },
  { width: 658, height: 320 }, // Galaxy S9+ landscape — Compact
];

const ITEMS = ['Verify this run', 'Copy run data', 'Save run data'] as const;

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

/** Whether the element `selector` (or the focused element) is wholly inside the panel body's
 *  scrollport, and the body wholly inside the viewport — i.e. on screen, not scrolled away. */
async function wholeOnScreen(page: Page, selector: string | null): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = sel === null ? document.activeElement : document.querySelector(sel);
    if (el === null) return false;
    const body = document.querySelector('.wy-results-body')!;
    const port = body.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const portBottom = port.top + body.clientHeight;
    return (
      r.top >= port.top - 0.5 &&
      r.bottom <= portBottom + 0.5 &&
      port.top >= 0 &&
      portBottom <= innerHeight &&
      r.left >= 0 &&
      r.right <= innerWidth
    );
  }, selector);
}

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

for (const run of ['win', 'loss'] as const) {
  test(`the ${run} treatment: its band, heading, subtitle, stars, score and the run’s numbers`, async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
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
    const yellow = await resolveColour(page, 'var(--wy-stars)');
    const dim = await resolveColour(page, 'var(--wy-star-empty)');
    const edge = await resolveColour(page, 'var(--wy-panel-edge)');
    painted.starFills.forEach((fill, i) => {
      expect(fill, `star ${String(i + 1)}`).toBe(i < want.stars ? yellow : dim);
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
  await page.setViewportSize(DESKTOP);
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
  await page.setViewportSize(DESKTOP);
  for (const run of ['win', 'loss'] as const) {
    const dialog = await openResults(page, run);
    await axeClean(page, `${run}, Run data closed`);
    await toggleOf(dialog).click();
    await expect(dialog.getByRole('button', { name: ITEMS[0] })).toBeVisible();
    await axeClean(page, `${run}, Run data open`);
  }
});

for (const size of [
  { width: 1280, height: 720 },
  { width: 658, height: 320 },
] as const) {
  test(`axe-clean at ${String(size.width)}×${String(size.height)} with the survey form open, with Give feedback keeping its place`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const dialog = await openResults(page, 'win');
    // Give feedback's place in the row, measured from Play again: opening the form may scroll
    // the body to show its first question, which moves the whole row, not a place in it.
    const place = (): Promise<Box> =>
      page.evaluate(() => {
        const play = document.querySelector('.wy-results .wy-primary')!.getBoundingClientRect();
        const own = document.querySelector('.wy-survey-opener > .wy-btn')!.getBoundingClientRect();
        return { x: own.x - play.x, y: own.y - play.y, width: own.width, height: own.height };
      });
    const before = await place();
    await dialog.getByRole('button', { name: 'Give feedback' }).click();
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeAttached();
    // Kept as a box for the row's sake, but out of sight, the tab order and the tree.
    await expect(dialog.getByRole('button', { name: 'Give feedback' })).toBeHidden();
    expectSameBox(await place(), before, 'Give feedback, its form open');
    await axeClean(page, 'with the survey form open');
    await toggleOf(dialog).click();
    await axeClean(page, 'with the survey form and Run data open');
  });
}

for (const text of [100, 200] as const) {
  for (const size of FIT_SIZES) {
    test(`fits at ${String(size.width)}×${String(size.height)}, ${String(text)}% text: opens on the outcome, never scrolls sideways, and Run data opens without moving its toggle`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      for (const run of ['win', 'loss'] as const) {
        const dialog = await openResults(page, run, text);
        const toggle = toggleOf(dialog);
        const onScreen = (g: Awaited<ReturnType<typeof geometry>>, when: string): void => {
          expect(g.panel.left, `${run} ${when}: left edge`).toBeGreaterThanOrEqual(0);
          expect(g.panel.right, `${run} ${when}: right edge`).toBeLessThanOrEqual(size.width);
          expect(g.panel.top, `${run} ${when}: top edge`).toBeGreaterThanOrEqual(0);
          expect(g.panel.bottom, `${run} ${when}: bottom edge`).toBeLessThanOrEqual(size.height);
          expect(g.dialogOverflow, `${run} ${when}: the dialog itself never scrolls`).toEqual([
            0, 0,
          ]);
          expect(g.bodyOverflow[0], `${run} ${when}: no sideways scroll`).toBeLessThanOrEqual(0);
        };

        // Opened at the TOP of the panel's scroll range — nothing scrolled to reach a first
        // focus — with the outcome heading on screen, and whatever took focus on screen too:
        // Play again where it is wholly in view there, else the heading (the ARIA dialog
        // pattern's static first focus).
        const closed = await geometry(page);
        onScreen(closed, 'closed');
        expect(
          await dialog.locator('.wy-results-body').evaluate((b) => b.scrollTop),
          `${run}: opens at the top`,
        ).toBe(0);
        expect(await wholeOnScreen(page, '.wy-results-title'), `${run}: the heading`).toBe(true);
        expect(await wholeOnScreen(page, null), `${run}: focus is never hidden`).toBe(true);
        const playAgainInView = await wholeOnScreen(page, '.wy-results .wy-primary');
        const focused = playAgainInView
          ? dialog.getByRole('button', { name: 'Play again' })
          : dialog.getByRole('heading', { level: 2 });
        await expect(focused).toBeFocused();
        if (text === 100) {
          // At 100% the closed panel fits whole and rests centred (the spacer is a floored
          // pixel count, so the panel may sit up to a pixel high), with Play again focused.
          expect(playAgainInView, `${run}: Play again in view`).toBe(true);
          expect(closed.bodyOverflow[1], `${run}: fits whole`).toBeLessThanOrEqual(0);
          const above = closed.panel.top - closed.restTop;
          const below = closed.restBottom - closed.panel.bottom;
          expect(above - below, `${run}: centred`).toBeLessThanOrEqual(0.5);
          expect(above - below, `${run}: centred`).toBeGreaterThan(-2);
        }

        // Run data, pressed with the real pointer (brought into view first where 200% text puts
        // it below the fold): its toggle does not move — not by a fraction of a pixel, at any
        // size, whether or not the open group fits below the panel's resting place.
        await toggle.scrollIntoViewIfNeeded();
        const before = await boxOf(page, '.wy-results-more');
        await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expectSameBox(await boxOf(page, '.wy-results-more'), before, `${run}: Run data`);
        onScreen(await geometry(page), 'open');

        // The open group is reachable by Tab (keyboard focus may scroll the body to it)...
        await expect(toggle).toBeFocused();
        for (const name of ITEMS) {
          await page.keyboard.press('Tab');
          await expect(dialog.getByRole('button', { name })).toBeFocused();
          expect(await wholeOnScreen(page, null), `${run}: ${name} scrolled into view`).toBe(true);
        }
        // ...and by scrolling.
        await dialog.locator('.wy-results-body').evaluate((b) => (b.scrollTop = 0));
        for (const name of ITEMS) {
          const item = dialog.getByRole('button', { name });
          await item.scrollIntoViewIfNeeded();
          await expect(item).toBeInViewport();
        }
      }
    });
  }
}

// The campaign's pointer sizes (`results-pointer.spec.ts` presses them with the real pointer).
for (const size of [
  { width: 1280, height: 720 },
  { width: 1366, height: 657 },
  { width: 1536, height: 730 },
  DESKTOP,
  { width: 1920, height: 960 },
  { width: 658, height: 320 },
] as const) {
  test(`at ${String(size.width)}×${String(size.height)} the open survey form is reachable by scrolling, and by Tab from its first question`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const dialog = await openResults(page, 'win');
    await dialog.getByRole('button', { name: 'Give feedback' }).click();
    const send = dialog.getByRole('button', { name: 'Send' });
    await send.scrollIntoViewIfNeeded();
    await expect(send).toBeInViewport();
    await dialog.getByRole('radio', { name: '1' }).first().focus();
    for (let i = 0; i < 12 && !(await send.evaluate((s) => s === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(send).toBeFocused();
    await expect(send).toBeInViewport();
  });
}

test('at 200% text on a phone-width window neither the panel nor the dialog scrolls sideways, and every star stays inside both', async ({
  page,
}) => {
  // The narrow sizes QC round 1 measured overflowing (a fixed-size star row; a value that would
  // not wrap), and a sweep across the widths where the tiles change columns.
  for (const size of [
    { width: 360, height: 640 },
    { width: 320, height: 568 },
    { width: 480, height: 640 },
    { width: 640, height: 640 },
    { width: 800, height: 640 },
    { width: 1000, height: 640 },
  ]) {
    await page.setViewportSize(size);
    for (const run of ['win', 'loss'] as const) {
      await openResults(page, run, 200);
      const fit = await page.evaluate(() => {
        const dialogEl = document.querySelector('.wy-results')!;
        const body = document.querySelector('.wy-results-body')!;
        const port = body.getBoundingClientRect();
        const panel = document.querySelector('.wy-results-panel')!.getBoundingClientRect();
        const stars = [...document.querySelectorAll('.wy-results-star')].map((s) =>
          s.getBoundingClientRect(),
        );
        return {
          sideways: body.scrollWidth - body.clientWidth,
          dialogSideways: dialogEl.scrollWidth - dialogEl.clientWidth,
          panelOnScreen: panel.left >= 0 && panel.right <= innerWidth,
          starsInside: stars.every((s) => s.left >= port.left && s.right <= port.right),
          starsOnScreen: stars.every((s) => s.left >= 0 && s.right <= innerWidth),
        };
      });
      const at = `${String(size.width)}×${String(size.height)} ${run}`;
      expect(fit.sideways, `${at}: no sideways scroll`).toBeLessThanOrEqual(0);
      expect(fit.dialogSideways, `${at}: the dialog never scrolls sideways`).toBeLessThanOrEqual(0);
      expect(fit.panelOnScreen, `${at}: the panel inside the window`).toBe(true);
      expect(fit.starsInside, `${at}: every star inside the body`).toBe(true);
      expect(fit.starsOnScreen, `${at}: every star inside the window`).toBe(true);
    }
  }
});

/** The closed panel is centred: the gap above it less the gap below, which a centred panel on
 *  a floored pixel spacer reads in (-2, 0.5]. */
async function expectCentred(page: Page, what: string): Promise<void> {
  const g = await geometry(page);
  const off = g.panel.top - g.restTop - (g.restBottom - g.panel.bottom);
  expect(off, `${what}: centred`).toBeLessThanOrEqual(0.5);
  expect(off, `${what}: centred`).toBeGreaterThan(-2);
}

test('the panel re-settles when the window grows: opened at 1280×720, centred again at 1440×900', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openResults(page, 'win');
  await page.setViewportSize(DESKTOP);
  await twoFrames(page);
  await expectCentred(page, 'grown to 1440×900');
});

test('the panel re-settles when the window shrinks: opened at 1440×900, centred again at 1280×720', async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await openResults(page, 'win');
  await page.setViewportSize({ width: 1280, height: 720 });
  await twoFrames(page);
  await expectCentred(page, 'shrunk to 1280×720');
});

test('a resize with Run data and the survey form open re-settles on the CLOSED panel', async ({
  page,
}) => {
  // The resting place is the closed panel's: what stands open below the row is left out of it.
  await page.setViewportSize({ width: 1280, height: 720 });
  const dialog = await openResults(page, 'win');
  const toggle = toggleOf(dialog);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await dialog.getByRole('button', { name: 'Give feedback' }).click();
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeAttached();
  await page.setViewportSize(DESKTOP);
  await twoFrames(page);
  // Close both (neither close re-settles anything): the panel must already rest where a closed
  // panel is centred on the new window.
  const body = dialog.locator('.wy-results-body');
  await body.evaluate((b) => (b.scrollTop = 0));
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await body.evaluate((b) => (b.scrollTop = 0));
  await twoFrames(page);
  await expectCentred(page, 'closed again after the resize');
});

test('Give feedback arriving after the panel first settles, and wrapping the row, re-settles it', async ({
  page,
}) => {
  // The harness's ask refresh takes a Web Lock, as production's does, so Give feedback arrives
  // a task after the dialog opens. At 400×760 it wraps the action row onto a second line.
  await page.setViewportSize({ width: 400, height: 760 });
  await openResults(page, 'win');
  const rowHeight = await page.evaluate(
    () => document.querySelector('.wy-results-actions')!.getBoundingClientRect().height,
  );
  expect(rowHeight, 'the row wrapped').toBeGreaterThan(80);
  await expectCentred(page, 'after Give feedback arrived');
});

test('at 200% text on a narrow COMPACT window nothing scrolls sideways, and the grade stays inside the body', async ({
  page,
}) => {
  for (const size of [
    { width: 400, height: 480 },
    { width: 480, height: 400 },
  ]) {
    await page.setViewportSize(size);
    for (const run of ['win', 'loss'] as const) {
      await openResults(page, run, 200);
      const fit = await page.evaluate(() => {
        const body = document.querySelector('.wy-results-body')!;
        const port = body.getBoundingClientRect();
        const grade = [...document.querySelectorAll('.wy-results-grade > *')].map((el) =>
          el.getBoundingClientRect(),
        );
        return {
          compact: matchMedia('(max-height: 500px)').matches,
          sideways: body.scrollWidth - body.clientWidth,
          gradeInside: grade.every((g) => g.left >= port.left && g.right <= port.right),
        };
      });
      const at = `${String(size.width)}×${String(size.height)} ${run}`;
      expect(fit.compact, `${at}: Compact applies`).toBe(true);
      expect(fit.sideways, `${at}: no sideways scroll`).toBeLessThanOrEqual(0);
      expect(fit.gradeInside, `${at}: the stars and the score inside the body`).toBe(true);
    }
  }
});

test('the heading that takes first focus at 200% text wears the app’s focus ring', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const dialog = await openResults(page, 'win', 200);
  await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();
  const ring = await page.evaluate(() => {
    const h = document.querySelector('.wy-results-title')!;
    const style = getComputedStyle(h);
    return {
      visible: h.matches(':focus-visible'),
      style: style.outlineStyle,
      width: style.outlineWidth,
      colour: style.outlineColor,
    };
  });
  expect(ring.visible, 'focus on open is visible').toBe(true);
  expect(ring.style).toBe('solid');
  expect(ring.width).toBe('3px');
  expect(ring.colour).toBe(await resolveColour(page, 'var(--wy-focus)'));
});

test('at 1440×900 Verify’s report grows the panel downward: the button stays where it was pressed', async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const dialog = await openResults(page, 'win');
  await toggleOf(dialog).click();
  const verify = dialog.getByRole('button', { name: ITEMS[0] });
  await expect(verify).toBeVisible();
  const before = await verify.boundingBox();
  await verify.click();
  await expect(dialog.getByRole('status')).toContainText('Verified');
  expect((await verify.boundingBox())?.y).toBeCloseTo(before?.y ?? NaN, 1);
});

test('forced colors: the stars, the outcome band and the chevron take the user’s system colours', async ({
  page,
}) => {
  // Chromium does not force SVG `fill` or `stroke`, and forced colors reset the band — a
  // background — to the Canvas it sits on. Emulated BEFORE the page loads, as the HUD's
  // forced-colors test does, and checked against the system colours themselves: under emulated
  // forced colors axe-core reads the authored text colours (`hud-strip.spec.ts` says why).
  await page.emulateMedia({ forcedColors: 'active' });
  await page.setViewportSize(DESKTOP);
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
