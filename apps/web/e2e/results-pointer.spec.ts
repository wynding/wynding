import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  boxOf,
  expectSameBox,
  openResults,
  toggleOf,
  twoFrames,
  type Box,
} from './results-harness';
import { PRESS_GUARD_WINDOW_MS } from '../src/press-guard';

// results-pointer.spec.ts — the results panel under a real pointer (#181 H2), in Chromium AND
// WebKit (`playwright.config.ts` runs this spec in both projects).
//
// The invariant: a press never activates a control it was not aimed at. Content can still move
// under a resting pointer: a scrolled body clamps as the survey form or the Run data group
// closes, or as a status message shrinks, and opening the survey brings its first question into
// view. So the panel guards its presses (`press-guard.ts`): a second press at the same spot
// inside the double-click window may land only on the control the first was aimed at.
//
// Every reproduction below starts with the body scrolled where a collapse does the most harm (the
// end of its range, or for Run data's group the place where its closing carries the control above
// the toggle exactly under the pointer), and presses twice at ONE spot, the ways a player does
// it: a double-click (`page.mouse.dblclick`), two clicks 120 ms apart, and two taps. The real
// pointer (`page.mouse`, `page.touchscreen`) never scrolls anything into view first, as a
// locator's click does. What each asserts afterwards: no new run, no survey answer, and no change
// to the status region or the Run data disclosure beyond what the aimed control does.

type Size = { readonly width: number; readonly height: number };
type Pair = 'double-click' | 'two clicks 120 ms apart' | 'two taps';
const MOUSE_PAIRS: readonly Pair[] = ['double-click', 'two clicks 120 ms apart'];

const centreX = (b: Box): number => b.x + b.width / 2;
const at = (b: Box, f: number): number => b.y + b.height * f;

/** Start recording the pointer clicks the page receives: their `timeStamp`s, read in the capture
 *  phase at the window, before the panel's guard can swallow one. */
async function recordClicks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __clicks?: number[] };
    if (w.__clicks !== undefined) {
      w.__clicks.length = 0;
      return;
    }
    const clicks: number[] = [];
    w.__clicks = clicks;
    window.addEventListener('click', (e) => void (e.detail > 0 && clicks.push(e.timeStamp)), true);
  });
}

/** Two presses at one spot. The pair must have reached the page as two pointer clicks inside the
 *  guard's window, or it stands for no quick double press at all: a harness slow to deliver the
 *  second would pass a test the guard never had to hold. */
async function pressTwice(page: Page, pair: Pair, x: number, y: number): Promise<void> {
  await recordClicks(page);
  if (pair === 'double-click') {
    await page.mouse.dblclick(x, y);
  } else if (page.context().browser()?.browserType().name() === 'chromium') {
    await stampedPair(page, pair === 'two taps' ? 'touch' : 'mouse', x, y);
  } else if (pair === 'two clicks 120 ms apart') {
    await page.mouse.click(x, y);
    await page.waitForTimeout(120);
    await page.mouse.click(x, y);
  } else {
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(120);
    await page.touchscreen.tap(x, y);
  }
  await twoFrames(page);
  const stamps = await page.evaluate(() => (window as unknown as { __clicks: number[] }).__clicks);
  expect(stamps, `${pair}: two pointer clicks reached the page`).toHaveLength(2);
  expect(
    stamps[1]! - stamps[0]!,
    `${pair}: the second inside the ${String(PRESS_GUARD_WINDOW_MS)} ms window`,
  ).toBeLessThan(PRESS_GUARD_WINDOW_MS);
}

/** Two presses 120 ms apart at one spot, in Chromium. Its emulated input reaches a page this
 *  busy (the board renders behind the dialog) late, so a pause between two presses is not the
 *  pause the page sees: emulated taps arrive a second or more apart, and under load even clicks
 *  drift past the window. Dispatched with their own timestamps, as a device stamps them, they
 *  arrive 120 ms apart; the second click counts as a double-click's, as a system counts it. */
async function stampedPair(page: Page, kind: 'mouse' | 'touch', x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  const start = Date.now() / 1000;
  for (const [i, at] of [start, start + 0.12].entries()) {
    if (kind === 'touch') {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y }],
        timestamp: at,
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
        timestamp: at + 0.01,
      });
    } else {
      const press = { x, y, button: 'left', clickCount: i + 1 } as const;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...press, timestamp: at });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...press,
        timestamp: at + 0.01,
      });
    }
  }
  await cdp.detach();
}

/** One press with the real pointer on `selector`, brought into view first: a setup step. */
async function pressOnce(page: Page, selector: string, pair: Pair = 'double-click'): Promise<void> {
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  const b = await boxOf(page, selector);
  if (pair === 'two taps') await page.touchscreen.tap(centreX(b), at(b, 0.5));
  else await page.mouse.click(centreX(b), at(b, 0.5));
  await twoFrames(page);
}

/** Scroll the panel's body to the end of its range. */
async function scrollToEnd(page: Page): Promise<void> {
  await page.locator('.wy-results-body').evaluate((b) => (b.scrollTop = b.scrollHeight));
  await twoFrames(page);
}

/** The body's scroll position, and the end of its range. */
const scroll = (page: Page): Promise<{ top: number; end: number }> =>
  page
    .locator('.wy-results-body')
    .evaluate((b) => ({ top: b.scrollTop, end: b.scrollHeight - b.clientHeight }));

/** Whether `selector` stands wholly inside the body's scrollport. */
const wholeInView = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((sel) => {
    const body = document.querySelector('.wy-results-body')!;
    const port = body.getBoundingClientRect();
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return r.top >= port.top - 0.5 && r.bottom <= port.top + body.clientHeight + 0.5;
  }, selector);

/** Whether a press at (x, y) lands on `selector`, inside the body's scrollport. */
const pressableAt = (page: Page, selector: string, x: number, y: number): Promise<boolean> =>
  page.evaluate(
    ([sel, px, py]) => {
      const body = document.querySelector('.wy-results-body')!;
      const port = body.getBoundingClientRect();
      if (py < port.top || py > port.top + body.clientHeight) return false;
      const hit = document.elementFromPoint(px, py);
      return hit !== null && document.querySelector(sel)!.contains(hit);
    },
    [selector, x, y] as const,
  );

/** What a stray press could change, beyond the aimed control's own effect. */
const strayState = (page: Page) =>
  page.evaluate(() => ({
    phase: document.querySelector<HTMLElement>('.wy-board')!.dataset.simPhase,
    answers: document.querySelectorAll('.wy-survey-form input:checked').length,
    status: document.querySelector('.wy-results .wy-verify')!.textContent,
    runData: document.querySelector('.wy-results-more')!.getAttribute('aria-expanded'),
    survey: !document.querySelector<HTMLElement>('.wy-survey-form')!.hidden,
  }));

async function expectNoNewRun(page: Page, dialog: Locator, what: string): Promise<void> {
  await expect(dialog, `${what}: no new run`).toBeVisible();
  await expect(page.locator('.wy-board'), `${what}: no new run`).toHaveAttribute(
    'data-sim-phase',
    'won',
  );
}

type Case = 'a' | 'b' | 'c' | 'd';
type Repro = Size & { readonly text: 100 | 200 };

/** Where each reproduction ran in QC round 2: the sizes where, before the press guard, the
 *  second press reached a control it was not aimed at. Each case runs at its own. */
const REPRO: Record<Case, readonly Repro[]> = {
  // Not now, with the form scrolled to its end: Play again comes down under the pointer.
  a: [
    { width: 1440, height: 900, text: 200 },
    { width: 1280, height: 720, text: 200 },
    { width: 1024, height: 600, text: 200 },
    { width: 658, height: 320, text: 200 },
  ],
  // Send after the rating prompt: the accepted send's collapse, then Play again's focus.
  b: [
    { width: 1440, height: 900, text: 200 },
    { width: 1280, height: 720, text: 200 },
    { width: 1024, height: 600, text: 200 },
    { width: 844, height: 390, text: 200 },
    { width: 740, height: 360, text: 200 },
    { width: 658, height: 320, text: 100 },
  ],
  // Run data closing with its group scrolled into view: Play again (a new run) or Give
  // feedback (the survey opens) comes down under the pointer.
  c: [
    { width: 658, height: 320, text: 200 },
    { width: 480, height: 640, text: 200 },
    { width: 360, height: 640, text: 200 },
    { width: 844, height: 390, text: 200 },
    { width: 740, height: 360, text: 200 },
  ],
  // A shorter status message after a longer one: Run data's toggle comes down under Verify.
  // In Compact at 200% text Verify's message is a line shorter than Save's at 844×390 (at
  // 658×320 and 740×360 both take two lines, so nothing shrinks there).
  d: [
    { width: 1280, height: 720, text: 100 },
    { width: 1366, height: 657, text: 100 },
    { width: 1024, height: 600, text: 100 },
    { width: 844, height: 390, text: 200 },
  ],
};

const sizeLabel = (r: Repro): string =>
  `${String(r.width)}×${String(r.height)}, ${String(r.text)}% text`;

// --- Run data and Give feedback, pressed in place ---------------------------------------------

/** The campaign's pointer sizes. `reveals`: where the survey's first question would open mostly
 *  below the fold, so opening it scrolls the body to bring the question into view. */
const POINTER_SIZES: readonly (Size & { readonly reveals: boolean })[] = [
  { width: 1280, height: 720, reveals: false },
  { width: 1366, height: 657, reveals: false },
  { width: 1536, height: 730, reveals: false },
  { width: 1440, height: 900, reveals: false },
  { width: 1920, height: 960, reveals: false },
  { width: 658, height: 320, reveals: true },
];

for (const size of POINTER_SIZES) {
  const label = `${String(size.width)}×${String(size.height)}`;

  test(`at ${label} Run data opens and closes in place, and a double-click on it activates nothing else`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    let downloads = 0;
    page.on('download', () => void downloads++);
    const dialog = await openResults(page, 'win');
    const toggle = toggleOf(dialog);
    const box = await boxOf(page, '.wy-results-more');
    const before = await strayState(page);

    // Opening something never moves the panel: one click each way leaves the toggle's box.
    await page.mouse.click(centreX(box), at(box, 0.5));
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expectSameBox(await boxOf(page, '.wy-results-more'), box, 'Run data, opened');
    await page.mouse.click(centreX(box), at(box, 0.5));
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expectSameBox(await boxOf(page, '.wy-results-more'), box, 'Run data, closed');

    // Double-clicks, high and low: both presses are the toggle's, so it opens and closes.
    for (const f of [0.1, 0.5, 0.75, 0.9]) {
      await page.mouse.dblclick(centreX(box), at(box, f));
      await expect(toggle, `double-clicked at ${String(f)}`).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await expectNoNewRun(page, dialog, `double-clicked at ${String(f)}`);
      expect(await strayState(page), `double-clicked at ${String(f)}`).toEqual(before);
      expect(downloads, 'no download').toBe(0);
    }
  });

  test(`at ${label} Give feedback opens the form in view, and a pointer press on Not now closes it with nothing else activated`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const dialog = await openResults(page, 'win');
    const feedback = dialog.getByRole('button', { name: 'Give feedback' });
    const firstOption = dialog.getByRole('radio', { name: '1' }).first();
    const opener = '.wy-survey-opener > .wy-btn';
    const feedbackBox = await boxOf(page, opener);
    const before = await strayState(page);

    const openAndClose = async (open: () => Promise<void>, what: string): Promise<void> => {
      expectSameBox(await boxOf(page, opener), feedbackBox, `${what}: Give feedback at rest`);
      await open();
      await expect(feedback, `${what}: the form is open`).toBeHidden();
      // The question is in view: in place where it opened in view, or brought up into view.
      expect(await wholeInView(page, '.wy-survey-scale legend'), `${what}: its legend`).toBe(true);
      const { top } = await scroll(page);
      if (size.reveals) {
        expect(top, `${what}: the body scrolled to show it`).toBeGreaterThan(0);
      } else {
        expect(top, `${what}: nothing moved`).toBe(0);
        expectSameBox(await boxOf(page, opener), feedbackBox, `${what}: Give feedback's place`);
      }
      await expectNoNewRun(page, dialog, what);
      expect(await strayState(page), what).toEqual({ ...before, survey: true });

      // Closed with the real pointer on Not now, brought into view first.
      await pressOnce(page, '.wy-survey-actions .wy-btn:nth-child(2)');
      await expect(feedback, `${what}: Not now closed the form`).toBeVisible();
      await expect(feedback, `${what}: focus back on Give feedback`).toBeFocused();
      await expectNoNewRun(page, dialog, `${what}, closed`);
      expect(await strayState(page), `${what}, closed`).toEqual(before);
      // The press guard keeps the window open after a press: let it close before the next one.
      await page.waitForTimeout(500);
    };

    await openAndClose(async () => {
      await page.mouse.click(centreX(feedbackBox), at(feedbackBox, 0.5));
      // Focus moves to the first question (§1). After a double-click it may not end there: the
      // second press's mousedown lands where Give feedback was and moves focus as any press
      // does, though its click activates nothing.
      await expect(firstOption, 'one click: focus on the first question').toBeFocused();
    }, 'one click');
    for (const f of [0.1, 0.5, 0.75, 0.9]) {
      await openAndClose(
        () => page.mouse.dblclick(centreX(feedbackBox), at(feedbackBox, f)),
        `double-clicked at ${String(f)}`,
      );
    }
  });
}

// --- The four reproductions: content that moves under a resting pointer ----------------------

for (const r of REPRO.a) {
  for (const pair of MOUSE_PAIRS) {
    test(`(a) at ${sizeLabel(r)}, Not now pressed twice (${pair}) with the form scrolled to its end: the collapse never hands the second press to Play again`, async ({
      page,
    }) => {
      await page.setViewportSize(r);
      await notNowCase(page, await openResults(page, 'win', r.text), pair);
    });
  }
}

for (const r of REPRO.b) {
  for (const pair of MOUSE_PAIRS) {
    test(`(b) at ${sizeLabel(r)}, Send pressed twice (${pair}) after the rating prompt: the accepted send's collapse never hands the second press to Play again`, async ({
      page,
    }) => {
      await page.setViewportSize(r);
      await sendCase(page, await openResults(page, 'win', r.text), pair);
    });
  }
}

for (const r of REPRO.c) {
  for (const pair of MOUSE_PAIRS) {
    test(`(c) at ${sizeLabel(r)}, Run data pressed twice (${pair}) high on the toggle, scrolled to where its closing brings the control above under the pointer: the second press reaches nothing else`, async ({
      page,
    }) => {
      await page.setViewportSize(r);
      await runDataCase(page, await openResults(page, 'win', r.text), pair);
    });
  }
}

for (const r of REPRO.d) {
  for (const pair of MOUSE_PAIRS) {
    test(`(d) at ${sizeLabel(r)}, Verify pressed twice (${pair}) high on the button after Save's longer message: the status region never shrinks, and Run data stays open`, async ({
      page,
    }) => {
      await page.setViewportSize(r);
      await shorterMessageCase(page, await openResults(page, 'win', r.text), pair);
    });
  }
}

test.describe('on a touch screen', () => {
  // A phone: `isMobile` honours the page's `width=device-width`, so a tap's click is not held
  // for a double-tap zoom and two taps 120 ms apart arrive as two presses 120 ms apart.
  test.use({ hasTouch: true, isMobile: true });

  test('(a) at 658×320, 200% text, Not now tapped twice: the second tap never reaches Play again', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 658, height: 320 });
    const dialog = await openResults(page, 'win', 200);
    await notNowCase(page, dialog, 'two taps');
  });

  test('(b) at 658×320, 100% text, Send tapped twice after the rating prompt: the second tap never reaches Play again', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 658, height: 320 });
    const dialog = await openResults(page, 'win');
    await sendCase(page, dialog, 'two taps');
  });

  test('(c) at 658×320, 200% text, Run data tapped twice high on the toggle, scrolled to where its closing brings the control above under the finger: the second tap reaches nothing else', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 658, height: 320 });
    const dialog = await openResults(page, 'win', 200);
    await runDataCase(page, dialog, 'two taps');
  });

  test('(d) at 844×390, 200% text, Verify tapped twice after Save’s longer message: the status region never shrinks', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    const dialog = await openResults(page, 'win', 200);
    await shorterMessageCase(page, dialog, 'two taps');
  });
});

/** (a) Open the form, scroll to its end, press Not now twice. The first press closes the form;
 *  the body clamps and Play again comes down under the pointer. */
async function notNowCase(page: Page, dialog: Locator, pair: Pair): Promise<void> {
  await pressOnce(page, '.wy-survey-opener > .wy-btn', pair);
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
  await page.waitForTimeout(500); // let the guard's window from the opening press close
  await scrollToEnd(page);
  const notNow = '.wy-survey-actions .wy-btn:nth-child(2)';
  expect(await wholeInView(page, notNow), 'Not now is on screen').toBe(true);
  const box = await boxOf(page, notNow);
  const before = await strayState(page);
  await pressTwice(page, pair, centreX(box), at(box, 0.5));
  await expect(dialog.getByRole('button', { name: 'Give feedback' })).toBeVisible();
  await expectNoNewRun(page, dialog, 'Not now pressed twice');
  expect(await strayState(page), 'only the form closed').toEqual({ ...before, survey: false });
  // Focus went back to Give feedback without scrolling: the body rests where the collapse's
  // clamp left it, at the end of its range.
  const { top, end } = await scroll(page);
  expect(top, 'no scroll after the clamp').toBeGreaterThanOrEqual(end - 1);
}

/** (b) Open the form, press Send with no rating (the prompt), pick a rating, scroll to the end,
 *  press Send twice. The accepted send retires the form and the body clamps. */
async function sendCase(page: Page, dialog: Locator, pair: Pair): Promise<void> {
  await pressOnce(page, '.wy-survey-opener > .wy-btn', pair);
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
  await pressOnce(page, '.wy-survey-actions .wy-btn:nth-child(1)', pair);
  await expect(dialog.getByRole('status')).toContainText('to send your feedback');
  await pressOnce(page, '.wy-survey-scale label:nth-of-type(4)', pair);
  await expect(dialog.getByRole('radio', { name: '4' }).first()).toBeChecked();
  await page.waitForTimeout(500);
  await scrollToEnd(page);
  const send = '.wy-survey-actions .wy-btn:nth-child(1)';
  expect(await wholeInView(page, send), 'Send is on screen').toBe(true);
  const box = await boxOf(page, send);
  const before = await strayState(page);
  await pressTwice(page, pair, centreX(box), at(box, 0.5));
  await expect(dialog.getByRole('status')).toContainText('Thanks for the feedback');
  await expectNoNewRun(page, dialog, 'Send pressed twice');
  const after = await strayState(page);
  expect(after.runData, 'Run data untouched').toBe(before.runData);
  expect(after.survey, 'the survey retired').toBe(false);
  // Focus went to Play again without scrolling: the body rests where the clamp left it.
  const { top, end } = await scroll(page);
  expect(top, 'no scroll after the clamp').toBeGreaterThanOrEqual(end - 1);
}

/** (c) Open Run data, scroll the body to the worst place to press its toggle from, and press
 *  it twice HIGH on it. The first press closes the group and the body clamps to its shorter
 *  range, carrying everything above the group down. The worst place is where that carries the
 *  nearest control above the toggle (Play again, or Give feedback, where the row wraps) down to
 *  exactly the point pressed. At the end of the range the clamp is the group's whole height,
 *  which here carries a stat tile, not a control, under the pointer: a player can stop anywhere,
 *  so the case is set up where it is worst, not where it happens to be harmless. */
async function runDataCase(page: Page, dialog: Locator, pair: Pair): Promise<void> {
  const toggle = toggleOf(dialog);
  const body = dialog.locator('.wy-results-body');
  await pressOnce(page, '.wy-results-more', pair);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // The body's range with the group closed, measured by closing and reopening it from the
  // keyboard, which the guard never holds.
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const closedHeight = await body.evaluate((b) => b.scrollHeight);
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(500); // let the guard's window from the opening press close
  const worst = await body.evaluate((b, closed) => {
    const port = b.getBoundingClientRect();
    const inContent = (y: number): number => y - port.top + b.scrollTop;
    const t = document.querySelector('.wy-results-more')!.getBoundingClientRect();
    const x = t.left + t.width / 2;
    const press = inContent(t.top + t.height * 0.1);
    // The nearest control above the toggle, at the x it is pressed at.
    const above = [...document.querySelectorAll<HTMLElement>('.wy-results-actions .wy-btn')]
      .filter((el) => getComputedStyle(el).visibility === 'visible' && el.offsetParent !== null)
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.left <= x && r.right >= x && r.bottom <= t.top)
      .sort((p, q) => q.bottom - p.bottom)[0];
    if (above === undefined) return null;
    // Scrolled to `scroll`, the collapse clamps the body by `scroll - closedEnd`: that is the
    // distance the control above must come down.
    const closedEnd = Math.max(0, closed - b.clientHeight);
    const scroll = closedEnd + (press - inContent(above.top + above.height / 2));
    const reachable = scroll <= b.scrollHeight - b.clientHeight && scroll >= 0;
    const onScreen = press - scroll >= 0 && press - scroll <= b.clientHeight;
    return reachable && onScreen ? { scroll, x, y: port.top + (press - scroll) } : null;
  }, closedHeight);
  test.skip(worst === null, 'no control stands above the toggle within reach of the clamp here');
  await body.evaluate((b, top) => (b.scrollTop = top), worst!.scroll);
  await twoFrames(page);
  expect(await pressableAt(page, '.wy-results-more', worst!.x, worst!.y), 'the toggle').toBe(true);
  const before = await strayState(page);
  await pressTwice(page, pair, worst!.x, worst!.y);
  await expectNoNewRun(page, dialog, 'Run data pressed twice');
  const after = await strayState(page);
  // The second press, swallowed, left the group closed: nothing but the toggle changed.
  expect({ ...after, runData: null }, 'nothing but the toggle').toEqual({
    ...before,
    runData: null,
  });
}

/** (d) Open Run data, press Save (a two-line message), scroll to the end, press Verify twice
 *  HIGH on it. Verify's one-line message is shorter than Save's: were the region to shrink, the
 *  body would clamp and bring the toggle down under the pointer. */
async function shorterMessageCase(page: Page, dialog: Locator, pair: Pair): Promise<void> {
  const toggle = toggleOf(dialog);
  await pressOnce(page, '.wy-results-more', pair);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(500);
  const download = page.waitForEvent('download');
  await pressOnce(page, '.wy-results-run-data .wy-btn:nth-child(3)', pair);
  await download;
  await expect(dialog.getByRole('status')).not.toHaveText('');
  await page.waitForTimeout(500);
  await scrollToEnd(page);
  const verify = '.wy-results-run-data .wy-btn:nth-child(1)';
  // At the end of the range, or as near it as keeps Verify's top on screen: on a short window
  // a tall status message can leave Verify above the view at the very end.
  await page.locator('.wy-results-body').evaluate((b, sel) => {
    const above =
      b.getBoundingClientRect().top - document.querySelector(sel)!.getBoundingClientRect().top;
    if (above > 0) b.scrollTop -= above + 2;
  }, verify);
  await twoFrames(page);
  const box = await boxOf(page, verify);
  const [x, y] = [centreX(box), at(box, 0.1)];
  expect(await pressableAt(page, verify, x, y), 'Verify, high on it, is on screen').toBe(true);
  const status = dialog.locator('.wy-verify');
  const statusHeight = (await status.boundingBox())?.height ?? 0;
  await pressTwice(page, pair, x, y);
  await expect(dialog.getByRole('status')).toContainText('Verified');
  await expectNoNewRun(page, dialog, 'Verify pressed twice');
  await expect(toggle, 'Run data stayed open').toHaveAttribute('aria-expanded', 'true');
  expect(
    (await status.boundingBox())?.height,
    'the status region never shrinks within one dialog',
  ).toBeGreaterThanOrEqual(statusHeight);
}

// --- Opening the survey shows it ----------------------------------------------------------------

for (const r of [
  { width: 658, height: 320, text: 100 },
  { width: 658, height: 320, text: 200 },
  { width: 1280, height: 720, text: 200 },
  { width: 1440, height: 900, text: 200 },
] as const) {
  for (const route of ['pointer', 'keyboard'] as const) {
    test(`opening the survey by ${route} at ${sizeLabel(r)} brings its first question into view`, async ({
      page,
    }) => {
      await page.setViewportSize(r);
      const dialog = await openResults(page, 'win', r.text);
      const feedback = dialog.getByRole('button', { name: 'Give feedback' });
      await feedback.scrollIntoViewIfNeeded();
      const { top: before } = await scroll(page);
      if (route === 'pointer') {
        await pressOnce(page, '.wy-survey-opener > .wy-btn');
      } else {
        await feedback.focus();
        await page.keyboard.press('Enter');
        await twoFrames(page);
      }
      const { top: after } = await scroll(page);
      await expect(dialog.getByRole('radio', { name: '1' }).first()).toBeFocused();
      // In view — and where the open scrolled, by the least scroll that shows it: the whole
      // question, its legend and options, ending at the bottom of the body's view.
      const fit = await page.evaluate(() => {
        const body = document.querySelector('.wy-results-body')!;
        const port = body.getBoundingClientRect();
        const portBottom = port.top + body.clientHeight;
        const q = document.querySelector('.wy-survey-scale')!.getBoundingClientRect();
        const legend = document.querySelector('.wy-survey-scale legend')!.getBoundingClientRect();
        const option = document.querySelector('.wy-survey-scale label')!.getBoundingClientRect();
        return {
          legend: legend.top >= port.top - 0.5 && legend.bottom <= portBottom + 0.5,
          option: option.top >= port.top - 0.5 && option.bottom <= portBottom + 0.5,
          bottomGap: portBottom - q.bottom,
          fits: q.height <= body.clientHeight,
        };
      });
      expect(fit.legend, 'its legend in view').toBe(true);
      expect(fit.option, 'its first option in view').toBe(true);
      if (after !== before && fit.fits) {
        expect(Math.abs(fit.bottomGap), 'scrolled no further than needed').toBeLessThanOrEqual(1);
      }
    });
  }
}
