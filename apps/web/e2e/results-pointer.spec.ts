import { test, expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import {
  boxOf,
  expectSameBox,
  HARNESS,
  openResults,
  toggleOf,
  twoFrames,
  type Box,
} from './results-harness';
import {
  PRESS_GUARD_KEY_HOLD_MS,
  PRESS_GUARD_REPEAT_MS,
  PRESS_GUARD_SLOP_PX,
  PRESS_GUARD_TOUCH_SLOP_PX,
  PRESS_GUARD_WINDOW_MS,
} from '../src/press-guard';

// results-pointer.spec.ts — the results panel under a real pointer (#181 H2), in Chromium AND
// WebKit (`playwright.config.ts` runs this spec in both projects).
//
// The invariant: a press never activates a control it was not aimed at. Content can still move
// under a resting pointer: a scrolled body clamps as the survey form or the Run data group
// closes, or as a status message shrinks; opening the survey brings its first question into
// view; and the dialog itself opens under a pointer that was pressing the board. So the panel
// guards its presses (`press-guard.ts`): a press in the same gesture as the last one (inside the
// double-click window, or a repeat the system counts, however slow the player has set their
// double-click), at the same spot, on a different control, is held where the layout moved under
// it. Where nothing moved, a quick press on a neighbour is the player's.
//
// Every reproduction below starts with the body scrolled where a collapse does the most harm (the
// end of its range, or for Run data's group the place where its closing carries the control above
// the toggle exactly under the pointer), and presses twice at ONE spot, the ways a player does
// it: a double-click (`page.mouse.dblclick`), two clicks 120 ms apart, a double-click slowed to
// 750 ms, and two taps, the second drifting as a finger's does. The real pointer (`page.mouse`,
// `page.touchscreen`) never scrolls anything into view first, as a locator's click does. What
// each asserts afterwards: no new run, no survey answer, and no change to the status region or
// the Run data disclosure beyond what the aimed control does.
//
// Each pair must reach the page as the gesture it stands for: its timing premise. A pair the
// wall clock delivers can miss it on a slow runner (WebKit on CI has taken 720 ms to deliver two
// clicks 120 ms apart), and the guard is never judged on a pair that missed it: the scenario is
// played up to three times in all, and where no play meets the premise the test is skipped at run
// time, naming what was measured (`untilPremise`).

type Size = { readonly width: number; readonly height: number };
/** A double-click slowed to 750 ms, as a player who has slowed their system's double-click speed
 *  makes one: the system still counts the second press as a double-click's (`detail` 2). */
const SLOWED = 'a slowed double-click, 750 ms apart';
/** A first press held down 450 or 550 ms, then a single press 135 ms after its release: the
 *  second is inside the double-click window of the first's release, and past it from the first's
 *  `mousedown`. */
const HELD_450 = 'a press held 450 ms, then a press 135 ms after its release';
const HELD_550 = 'a press held 550 ms, then a press 135 ms after its release';
type Pair =
  | 'double-click'
  | 'two clicks 120 ms apart'
  | typeof SLOWED
  | 'two taps'
  | typeof HELD_450
  | typeof HELD_550;
/** How long a pair's first press is held, in ms: null for a pair that holds none. */
const holdOf = (pair: Pair): number | null =>
  pair === HELD_450 ? 450 : pair === HELD_550 ? 550 : null;
const MOUSE_PAIRS: readonly Pair[] = ['double-click', 'two clicks 120 ms apart'];
type Point = { readonly x: number; readonly y: number };
/** How far the second press of a pair lands from the first. */
type Drift = { readonly dx: number; readonly dy: number };
const NO_DRIFT: Drift = { dx: 0, dy: 0 };

/** A box's horizontal centre. */
const centreX = (b: Box): number => b.x + b.width / 2;
/** The y a fraction `f` of the way down a box. */
const at = (b: Box, f: number): number => b.y + b.height * f;
/** Whether the page runs in Chromium. */
const isChromium = (page: Page): boolean =>
  page.context().browser()?.browserType().name() === 'chromium';

type Click = { readonly t: number; readonly detail: number; readonly onPlay: boolean };

/** Start recording the pointer clicks the page receives: their `timeStamp`s and `detail`s (the
 *  system's click count), read in the capture phase at the window, before the panel's guard can
 *  swallow one. The click a label forwards to its radio (Chromium's carries its press's own
 *  time and `detail`) is that press's and is not counted again. A double-click's two clicks can
 *  share one time too, so only a forward is dropped: at the same time, on the control of the
 *  label the last click landed in. */
async function recordClicks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __clicks?: { t: number; detail: number; onPlay: boolean }[];
      __downs?: number[];
      __downsOnPlay?: boolean[];
      __lastClick?: { t: number; target: Element } | null;
    };
    w.__lastClick = null;
    if (w.__clicks !== undefined) {
      w.__clicks.length = 0;
      w.__downs!.length = 0;
      w.__downsOnPlay!.length = 0;
      return;
    }
    const clicks: { t: number; detail: number; onPlay: boolean }[] = [];
    const downs: number[] = [];
    const downsOnPlay: boolean[] = [];
    const onPlay = (e: Event): boolean =>
      (e.target as Element).closest('.wy-results .wy-primary') !== null;
    w.__clicks = clicks;
    w.__downs = downs;
    w.__downsOnPlay = downsOnPlay;
    window.addEventListener(
      'mousedown',
      (e) => {
        downs.push(e.timeStamp);
        downsOnPlay.push(onPlay(e));
      },
      true,
    );
    window.addEventListener(
      'click',
      (e) => {
        if (e.detail === 0) return;
        const target = e.target as Element;
        const last = w.__lastClick;
        const forwarded =
          last != null &&
          last.t === e.timeStamp &&
          last.target !== target &&
          last.target.closest('label')?.control === target;
        w.__lastClick = { t: e.timeStamp, target };
        if (!forwarded) clicks.push({ t: e.timeStamp, detail: e.detail, onPlay: onPlay(e) });
      },
      true,
    );
  });
}

/** The clicks the page recorded since `recordClicks`: when, their `detail`, and whether on Play
 *  again. */
const recordedClicks = (page: Page): Promise<Click[]> =>
  page.evaluate(() => (window as unknown as { __clicks: Click[] }).__clicks);

/** The `timeStamp` of each `mousedown` the page received since `recordClicks`. */
const recordedDowns = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as unknown as { __downs: number[] }).__downs);

/** Whether each of those `mousedown`s landed inside Play again. */
const recordedDownsOnPlay = (page: Page): Promise<boolean[]> =>
  page.evaluate(() => (window as unknown as { __downsOnPlay: boolean[] }).__downsOnPlay);

/** A keyboard activation's focus-move check (`press-guard.ts`) runs where the click's dispatch
 *  ends, so it has already run here. This barrier is belt and braces for a click stopped short of
 *  the window, whose check waits for the next key or a task: a scripted `focus()` made before it
 *  ran would be taken for the activation's own focus move, and the control it focused would take
 *  no Enter or Space for 500 ms. No player moves focus that way, so let any such check run first:
 *  a zero-delay timer queued now runs after the guard's. */
async function afterKeyActivation(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/** How many times a scenario is played, at most, for its press pair to meet its timing premise. */
const PREMISE_TRIES = 3;

/** Whether a press pair met its timing premise: null where it did, else what the page measured. */
type Premise = string | null;

/** A time for a message, rounded to whole ms. */
const ms = (t: number): string => `${String(Math.round(t))} ms`;

/** Whether `pair` reaches this browser with its own device timestamps: Chromium dispatches every
 *  pair but the double-click stamped (`stampedPair`, `heldThenQuick`), so it meets its premise by
 *  construction, and a miss there is the harness's fault, never the runner's pace. */
const isStamped = (page: Page, pair: Pair): boolean => isChromium(page) && pair !== 'double-click';

/** Play a scenario, from opening its page to its press pair, until the pair meets its timing
 *  premise (`premise` null), at most `PREMISE_TRIES` times, and resolve to that play's result. A
 *  pair the wall clock delivers (WebKit's `page.mouse` and `page.touchscreen`, and in both
 *  browsers the double-click and the raw presses) can reach the page slower than the gesture it
 *  stands for, and a pair that missed its premise stands for no double press at all: judged on
 *  it, the guard would prove nothing either way. So the guard is judged on a pair that met it, and
 *  only on that one. Where none does, the test is skipped at run time with every measured miss in
 *  the skip's annotation: the report shows that the runner could not create the premise, not that
 *  the guard failed. A miss means a slow runner, so it also marks the test slow (triple timeout)
 *  for the plays still to come. */
async function untilPremise<T extends { readonly premise: Premise }>(
  play: () => Promise<T>,
): Promise<T> {
  const missed: string[] = [];
  for (let i = 0; i < PREMISE_TRIES; i++) {
    const result = await play();
    if (result.premise === null) {
      if (missed.length > 0) {
        test.info().annotations.push({
          type: 'premise missed, played again',
          description: missed.join('; '),
        });
      }
      return result;
    }
    if (missed.length === 0) test.slow();
    missed.push(result.premise);
  }
  test.skip(
    true,
    `the press pair never met its timing premise in ${String(PREMISE_TRIES)} plays: ${missed.join('; ')}`,
  );
  throw new Error('unreachable: test.skip ends the test');
}

/** The gap between a held press's release and the quick press after it, in ms. */
const HELD_GAP = 135;
/** A press held `hold` ms, then a single press `HELD_GAP` ms after its release (each its own
 *  click, `detail` 1): stamped in Chromium, as `stampedPair` explains. */
async function heldThenQuick(page: Page, first: Point, second: Point, hold: number): Promise<void> {
  if (isChromium(page)) {
    const cdp = await page.context().newCDPSession(page);
    const start = Date.now() / 1000;
    for (const { x, y, down, up } of [
      { ...first, down: start, up: start + hold / 1000 },
      {
        ...second,
        down: start + (hold + HELD_GAP) / 1000,
        up: start + (hold + HELD_GAP) / 1000 + 0.01,
      },
    ]) {
      const press = { x, y, button: 'left', clickCount: 1 } as const;
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...press,
        timestamp: down,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...press,
        timestamp: up,
      });
    }
    await cdp.detach();
  } else {
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    await page.waitForTimeout(hold);
    await page.mouse.up();
    await page.waitForTimeout(HELD_GAP);
    await page.mouse.move(second.x, second.y);
    await page.mouse.down();
    await page.mouse.up();
  }
}

/** Two presses, the second `drift` off the first, resolving to whether the pair met its timing
 *  premise: two pointer clicks in one gesture, the second inside the guard's window (from the
 *  first's release, for a held pair), or for the slowed double-click past it but inside a
 *  repeat's span. A pair outside it stands for no double press at all: a harness slow to deliver
 *  the second would pass a test the guard never had to hold. What no runner's pace can change is
 *  asserted here: two clicks reached the page, each counted as the pair counts it, a held press
 *  was held, and a held or slowed pair's second press came past the window. So is a stamped
 *  pair's premise (`isStamped`). */
async function pressTwice(
  page: Page,
  pair: Pair,
  x: number,
  y: number,
  drift: Drift = NO_DRIFT,
): Promise<Premise> {
  const second = { x: x + drift.dx, y: y + drift.dy };
  await recordClicks(page);
  const hold = holdOf(pair);
  if (hold !== null) {
    await heldThenQuick(page, { x, y }, second, hold);
  } else if (pair === 'double-click') {
    expect(drift, 'a double-click has no drift').toEqual(NO_DRIFT);
    await page.mouse.dblclick(x, y);
  } else if (isChromium(page)) {
    await stampedPair(page, pair, { x, y }, second);
  } else if (pair === 'two taps') {
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(120);
    await page.touchscreen.tap(second.x, second.y);
  } else {
    const count = pair === SLOWED ? 2 : 1;
    await page.mouse.click(x, y);
    await page.waitForTimeout(pair === SLOWED ? 750 : 120);
    await page.mouse.move(second.x, second.y);
    await page.mouse.down({ clickCount: count });
    await page.mouse.up({ clickCount: count });
  }
  await twoFrames(page);
  const clicks = await recordedClicks(page);
  expect(clicks, `${pair}: two pointer clicks reached the page`).toHaveLength(2);
  const gap = clicks[1]!.t - clicks[0]!.t;
  let premise: Premise;
  if (hold !== null) {
    const downs = await recordedDowns(page);
    expect(downs, `${pair}: two presses reached the page`).toHaveLength(2);
    expect(
      clicks.map((c) => c.detail),
      `${pair}: each its own click`,
    ).toEqual([1, 1]);
    expect(clicks[0]!.t - downs[0]!, `${pair}: the first was held`).toBeGreaterThanOrEqual(
      hold - 20,
    );
    expect(
      downs[1]! - downs[0]!,
      `${pair}: the second is past the window from the first press's start`,
    ).toBeGreaterThanOrEqual(PRESS_GUARD_WINDOW_MS);
    const afterRelease = downs[1]! - clicks[0]!.t;
    premise =
      afterRelease < PRESS_GUARD_WINDOW_MS
        ? null
        : `${pair}: the second came ${ms(afterRelease)} after the first's release, not inside the ${ms(PRESS_GUARD_WINDOW_MS)} window`;
  } else if (pair === SLOWED) {
    expect(clicks[1]!.detail, `${pair}: the system counts the second as a repeat`).toBe(2);
    expect(gap, `${pair}: past the double-click window`).toBeGreaterThanOrEqual(
      PRESS_GUARD_WINDOW_MS,
    );
    premise =
      gap < PRESS_GUARD_REPEAT_MS
        ? null
        : `${pair}: the second came ${ms(gap)} after the first, past a repeat's ${ms(PRESS_GUARD_REPEAT_MS)} span`;
  } else {
    premise =
      gap < PRESS_GUARD_WINDOW_MS
        ? null
        : `${pair}: the second came ${ms(gap)} after the first, not inside the ${ms(PRESS_GUARD_WINDOW_MS)} window`;
  }
  if (isStamped(page, pair)) expect(premise, `${pair}: stamped, so inside its premise`).toBeNull();
  return premise;
}

/** Two presses in Chromium, each at its own spot, stamped as a device stamps them: 120 ms apart,
 *  or 750 ms for the slowed double-click. Its emulated input reaches a page this busy (the board
 *  renders behind the dialog) late, so a pause between two presses is not the pause the page
 *  sees: emulated taps arrive a second or more apart, and under load even clicks drift past the
 *  window. Dispatched with their own timestamps, they arrive as stamped; the second click counts
 *  as a double-click's, as a system counts it. */
async function stampedPair(
  page: Page,
  pair: Exclude<Pair, 'double-click'>,
  first: Point,
  second: Point,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const start = Date.now() / 1000;
  const presses = [
    { ...first, stamp: start },
    { ...second, stamp: start + (pair === SLOWED ? 0.75 : 0.12) },
  ];
  for (const [i, { x, y, stamp }] of presses.entries()) {
    if (pair === 'two taps') {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y }],
        timestamp: stamp,
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
        timestamp: stamp + 0.01,
      });
    } else {
      const press = { x, y, button: 'left', clickCount: i + 1 } as const;
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...press,
        timestamp: stamp,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...press,
        timestamp: stamp + 0.01,
      });
    }
  }
  await cdp.detach();
}

/** Two single presses, each its own click (`detail` 1) at its own spot, `gap` ms apart: stamped
 *  in Chromium, as `stampedPair` explains. Resolves to whether they met their premise: reaching
 *  the page inside the guard's window, or the guard never had to judge the second
 *  (`untilPremise`). */
async function pressApart(page: Page, first: Point, second: Point, gap: number): Promise<Premise> {
  await recordClicks(page);
  if (isChromium(page)) {
    const cdp = await page.context().newCDPSession(page);
    const start = Date.now() / 1000;
    for (const { x, y, stamp } of [
      { ...first, stamp: start },
      { ...second, stamp: start + gap / 1000 },
    ]) {
      const press = { x, y, button: 'left', clickCount: 1 } as const;
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...press,
        timestamp: stamp,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...press,
        timestamp: stamp + 0.01,
      });
    }
    await cdp.detach();
  } else {
    await page.mouse.click(first.x, first.y);
    await page.waitForTimeout(gap);
    await page.mouse.click(second.x, second.y);
  }
  await twoFrames(page);
  const clicks = await recordedClicks(page);
  expect(clicks, 'two pointer clicks reached the page').toHaveLength(2);
  expect(
    clicks.map((c) => c.detail),
    'each its own click',
  ).toEqual([1, 1]);
  const apart = clicks[1]!.t - clicks[0]!.t;
  const premise =
    apart < PRESS_GUARD_WINDOW_MS
      ? null
      : `two clicks ${String(gap)} ms apart: the second came ${ms(apart)} after the first, not inside the ${ms(PRESS_GUARD_WINDOW_MS)} window`;
  if (isChromium(page)) expect(premise, 'stamped, so inside the window').toBeNull();
  return premise;
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

/** Asserts the press began no new run: the dialog still shows, and the board is still won. */
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

/** A repro's window and text size, as the test titles name it. */
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
      // second press lands where Give feedback was. On a control the opening brought there, the
      // guard holds it, focus and all; on no control, its mousedown moves focus as such a press
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
      await notNowCase(page, () => openResults(page, 'win', r.text), pair);
    });
  }
}

// A player who has slowed their system's double-click speed (for motor access) presses a second
// time well past the guard's window; the system still counts it as a double-click's (#181 H2).
for (const r of REPRO.a.filter((size) => size.width >= 1280)) {
  test(`(a) at ${sizeLabel(r)}, Not now pressed twice as ${SLOWED}: the system counts the second as a repeat, and the collapse never hands it to Play again`, async ({
    page,
  }) => {
    await page.setViewportSize(r);
    await notNowCase(page, () => openResults(page, 'win', r.text), SLOWED);
  });
}

for (const r of REPRO.b) {
  for (const pair of MOUSE_PAIRS) {
    test(`(b) at ${sizeLabel(r)}, Send pressed twice (${pair}) after the rating prompt: the accepted send's collapse never hands the second press to Play again`, async ({
      page,
    }) => {
      await page.setViewportSize(r);
      await sendCase(page, () => openResults(page, 'win', r.text), pair);
    });
  }
}

for (const r of REPRO.c) {
  for (const pair of MOUSE_PAIRS) {
    test(`(c) at ${sizeLabel(r)}, Run data pressed twice (${pair}) high on the toggle, scrolled to where its closing brings the control above under the pointer: the second press reaches nothing else`, async ({
      page,
    }) => {
      await page.setViewportSize(r);
      await runDataCase(page, () => openResults(page, 'win', r.text), pair);
    });
  }
}

// A press held down before its release: its effect (the collapse) lands at the release, so the
// guard times the gesture from there. A press held 450 or 550 ms, then a press 135 ms after the
// release, is a double-press the guard must still hold, though it comes 585-685 ms after the
// first press began (#181 H2, QC round 4).
for (const pair of [HELD_450, HELD_550] as const) {
  test(`(a) at 1440×900, 200% text, Not now pressed as ${pair}: the collapse never hands the second press to Play again`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await notNowCase(page, () => openResults(page, 'win', 200), pair);
  });
  test(`(b) at 658×320, 100% text, Send pressed as ${pair} after the rating prompt: the accepted send's collapse never hands the second press to Play again`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 658, height: 320 });
    await sendCase(page, () => openResults(page, 'win', 100), pair);
  });
  test(`(c) at 480×640, 200% text, Run data pressed as ${pair}, high on the toggle where its closing brings the control above under the pointer: the second press reaches nothing else`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 480, height: 640 });
    await runDataCase(page, () => openResults(page, 'win', 200), pair);
  });
}

// Run data opened by a press on its TEXT, then double-clicked on the toggle's own edge: a press
// on a control's own content is that control's press (QC round 3).
for (const r of [
  { width: 658, height: 320, text: 200 },
  { width: 480, height: 640, text: 200 },
] as const) {
  test(`(c) at ${sizeLabel(r)}, Run data opened by a press on its text, then double-clicked high on its edge where its closing brings a control under the pointer: the second press reaches nothing else`, async ({
    page,
  }) => {
    await page.setViewportSize(r);
    const { dialog, before } = await untilPremise(async () => {
      const dialog = await openResults(page, 'win', r.text);
      const toggle = toggleOf(dialog);
      const body = dialog.locator('.wy-results-body');
      // The body's range with the group closed, measured before it opens.
      const closedHeight = await body.evaluate((b) => b.scrollHeight);
      await page.locator('.wy-results-more').scrollIntoViewIfNeeded();
      const text = await boxOf(page, '.wy-results-more > span');
      const [tx, ty] = [centreX(text), at(text, 0.5)];
      expect(
        await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [
          tx,
          ty,
        ] as const),
        'the opening press lands on the toggle’s text',
      ).toBe('SPAN');
      await page.mouse.click(tx, ty);
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await page.waitForTimeout(PRESS_GUARD_WINDOW_MS + 100);
      const worst = await worstPlace(body, closedHeight);
      expect(worst, 'a control above the toggle is within reach of the clamp').not.toBeNull();
      await body.evaluate((b, top) => (b.scrollTop = top), worst!.scroll);
      await twoFrames(page);
      expect(
        await page.evaluate(
          ([x, y]) =>
            document.elementFromPoint(x, y) === document.querySelector('.wy-results-more'),
          [worst!.x, worst!.y] as const,
        ),
        'the pair lands on the toggle itself, not its text',
      ).toBe(true);
      const before = await strayState(page);
      const premise = await pressTwice(page, 'double-click', worst!.x, worst!.y);
      return { premise, dialog, before };
    });
    await expectNoNewRun(page, dialog, 'Run data double-clicked');
    const after = await strayState(page);
    expect({ ...after, runData: null }, 'nothing but the toggle').toEqual({
      ...before,
      runData: null,
    });
  });
}

for (const r of REPRO.d) {
  for (const pair of MOUSE_PAIRS) {
    test(`(d) at ${sizeLabel(r)}, Verify pressed twice (${pair}) high on the button after Save's longer message: the status region never shrinks, and Run data stays open`, async ({
      page,
    }) => {
      await page.setViewportSize(r);
      await shorterMessageCase(page, () => openResults(page, 'win', r.text), pair);
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
    await notNowCase(page, () => openResults(page, 'win', 200), 'two taps');
  });

  // A finger's second tap drifts further than a resting mouse: past the mouse's slop, inside a
  // finger's (#181 H2). These two drifts are where the second tap lands on Play again.
  for (const drift of [
    { dx: 30, dy: 0 },
    { dx: 0, dy: -30 },
  ] as const) {
    test(`(a) at 658×320, 200% text, Not now tapped twice, the second tap 30px ${drift.dx === 0 ? 'higher' : 'to the right'}: inside a finger's slop, it never reaches Play again`, async ({
      page,
    }) => {
      const off = Math.hypot(drift.dx, drift.dy);
      expect(off, 'past a mouse’s slop').toBeGreaterThan(PRESS_GUARD_SLOP_PX);
      expect(off, 'inside a finger’s').toBeLessThanOrEqual(PRESS_GUARD_TOUCH_SLOP_PX);
      await page.setViewportSize({ width: 658, height: 320 });
      await notNowCase(page, () => openResults(page, 'win', 200), 'two taps', drift);
    });
  }

  test('(b) at 658×320, 100% text, Send tapped twice after the rating prompt: the second tap never reaches Play again', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 658, height: 320 });
    await sendCase(page, () => openResults(page, 'win'), 'two taps');
  });

  test('(c) at 658×320, 200% text, Run data tapped twice high on the toggle, scrolled to where its closing brings the control above under the finger: the second tap reaches nothing else', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 658, height: 320 });
    await runDataCase(page, () => openResults(page, 'win', 200), 'two taps');
  });

  test('(d) at 844×390, 200% text, Verify tapped twice after Save’s longer message: the status region never shrinks', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await shorterMessageCase(page, () => openResults(page, 'win', 200), 'two taps');
  });
});

/** A results dialog opened afresh: each play of a scenario opens its own (`untilPremise`). */
type Open = () => Promise<Locator>;

/** (a) Open the form, scroll to its end, press Not now twice. The first press closes the form;
 *  the body clamps and Play again comes down under the pointer. Resolves to the dialog it judged. */
async function notNowCase(
  page: Page,
  open: Open,
  pair: Pair,
  drift: Drift = NO_DRIFT,
): Promise<Locator> {
  const notNow = '.wy-survey-actions .wy-btn:nth-child(2)';
  const { dialog, before } = await untilPremise(async () => {
    const dialog = await open();
    await pressOnce(page, '.wy-survey-opener > .wy-btn', pair);
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
    await page.waitForTimeout(500); // let the guard's window from the opening press close
    await scrollToEnd(page);
    expect(await wholeInView(page, notNow), 'Not now is on screen').toBe(true);
    const box = await boxOf(page, notNow);
    const before = await strayState(page);
    const premise = await pressTwice(page, pair, centreX(box), at(box, 0.5), drift);
    return { premise, dialog, before };
  });
  await expect(dialog.getByRole('button', { name: 'Give feedback' })).toBeVisible();
  await expectNoNewRun(page, dialog, 'Not now pressed twice');
  expect(await strayState(page), 'only the form closed').toEqual({ ...before, survey: false });
  // Focus went back to Give feedback without scrolling: the body rests where the collapse's
  // clamp left it, at the end of its range.
  const { top, end } = await scroll(page);
  expect(top, 'no scroll after the clamp').toBeGreaterThanOrEqual(end - 1);
  return dialog;
}

/** (b) Open the form, press Send with no rating (the prompt), pick a rating, scroll to the end,
 *  press Send twice. The accepted send retires the form and the body clamps. */
async function sendCase(page: Page, open: Open, pair: Pair): Promise<void> {
  const send = '.wy-survey-actions .wy-btn:nth-child(1)';
  const { dialog, before } = await untilPremise(async () => {
    const dialog = await open();
    await pressOnce(page, '.wy-survey-opener > .wy-btn', pair);
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
    await pressOnce(page, send, pair);
    await expect(dialog.getByRole('status')).toContainText('to send your feedback');
    await pressOnce(page, '.wy-survey-scale label:nth-of-type(4)', pair);
    await expect(dialog.getByRole('radio', { name: '4' }).first()).toBeChecked();
    await page.waitForTimeout(500);
    await scrollToEnd(page);
    expect(await wholeInView(page, send), 'Send is on screen').toBe(true);
    const box = await boxOf(page, send);
    const before = await strayState(page);
    const premise = await pressTwice(page, pair, centreX(box), at(box, 0.5));
    return { premise, dialog, before };
  });
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
async function runDataCase(page: Page, open: Open, pair: Pair): Promise<void> {
  const { dialog, before } = await untilPremise(async () => {
    const dialog = await open();
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
    const worst = await worstPlace(body, closedHeight);
    expect(worst, 'a control above the toggle is within reach of the clamp here').not.toBeNull();
    await body.evaluate((b, top) => (b.scrollTop = top), worst!.scroll);
    await twoFrames(page);
    expect(await pressableAt(page, '.wy-results-more', worst!.x, worst!.y), 'the toggle').toBe(
      true,
    );
    const before = await strayState(page);
    const premise = await pressTwice(page, pair, worst!.x, worst!.y);
    return { premise, dialog, before };
  });
  await expectNoNewRun(page, dialog, 'Run data pressed twice');
  const after = await strayState(page);
  // The second press, swallowed, left the group closed: nothing but the toggle changed.
  expect({ ...after, runData: null }, 'nothing but the toggle').toEqual({
    ...before,
    runData: null,
  });
}

/** Where to scroll the body, and where to press high on Run data's toggle, so that the group's
 *  closing (the body clamps to `closedHeight`) carries the nearest control above the toggle
 *  (Play again, or Give feedback where the row wraps) down to exactly the point pressed; or null
 *  where none is within reach. */
const worstPlace = (
  body: Locator,
  closedHeight: number,
): Promise<{ scroll: number; x: number; y: number } | null> =>
  body.evaluate((b, closed) => {
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

/** (d) Open Run data, press Save (a two-line message), scroll to the end, press Verify twice
 *  HIGH on it. Verify's one-line message is shorter than Save's: were the region to shrink, the
 *  body would clamp and bring the toggle down under the pointer. */
async function shorterMessageCase(page: Page, open: Open, pair: Pair): Promise<void> {
  const verify = '.wy-results-run-data .wy-btn:nth-child(1)';
  const { dialog, statusHeight } = await untilPremise(async () => {
    const dialog = await open();
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
    const statusHeight = (await dialog.locator('.wy-verify').boundingBox())?.height ?? 0;
    const premise = await pressTwice(page, pair, x, y);
    return { premise, dialog, statusHeight };
  });
  const toggle = toggleOf(dialog);
  const status = dialog.locator('.wy-verify');
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

// --- Opening the survey where its first option straddles the fold --------------------------------

type Straddle = { readonly rel: number; readonly lo: number; readonly hi: number };

/** Where the survey's first option stands against the fold at scrollTop 0, in the body's content
 *  coordinates (so however far an open scrolled): how far the fold is below the top of its label
 *  (`rel`), and the band where at least half the label shows while its radio is cut by the fold
 *  (`lo`..`hi`). */
const firstOption = (page: Page): Promise<Straddle> =>
  page.evaluate(() => {
    const b = document.querySelector('.wy-results-body')!;
    const port = b.getBoundingClientRect();
    const label = document.querySelector('.wy-survey-scale label')!.getBoundingClientRect();
    const radio = document.querySelector('.wy-survey-scale input')!.getBoundingClientRect();
    const c = (y: number): number => y - port.top + b.scrollTop;
    return {
      rel: b.clientHeight - c(label.top),
      lo: label.height / 2 + 1,
      hi: c(radio.bottom) - c(label.top) - 1,
    };
  });

/** Whether the fold lies in `lo`..`hi`: half the label or more shows, and its radio is cut. */
const straddles = (m: Straddle): boolean => m.rel >= m.lo && m.rel <= m.hi;

/** `firstOption` at a size, read after opening the survey from the keyboard. */
async function firstOptionAt(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  const dialog = await openResults(page, 'win');
  await dialog.getByRole('button', { name: 'Give feedback' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
  return { h: height, ...(await firstOption(page)) };
}

/** The first window above Compact, by width, where the first option opens straddling the fold:
 *  found by bisecting on the height. */
async function findStraddle(page: Page): Promise<Size | null> {
  for (const width of [1280, 1024, 900, 800]) {
    let a = await firstOptionAt(page, width, 520);
    if (a.hi <= a.lo) continue;
    if (straddles(a)) return { width, height: a.h };
    let b = await firstOptionAt(page, width, 760);
    for (let i = 0; i < 6; i++) {
      if (straddles(b)) return { width, height: b.h };
      if (!(a.rel < a.lo && b.rel > b.hi)) break;
      const target = (a.lo + a.hi) / 2;
      const h = Math.round(a.h + ((target - a.rel) * (b.h - a.h)) / (b.rel - a.rel));
      if (h <= a.h || h >= b.h) break;
      const m = await firstOptionAt(page, width, h);
      if (straddles(m)) return { width, height: h };
      if (m.rel < m.lo) a = m;
      else b = m;
    }
  }
  return null;
}

test('opening the survey by pointer where its first option opens mostly, not wholly, in view moves nothing', async ({
  page,
}) => {
  // The question's reveal runs only where the option opened mostly below the fold, so here only
  // the layout read before the focus keeps the body still: WebKit scrolls a `preventScroll` focus
  // made over the layout a render has just dirtied into view at its next rendering update
  // (`focus-in-place.ts`).
  test.setTimeout(180_000);
  const found = await findStraddle(page);
  expect(
    found,
    'a window above Compact where the first option opens straddling the fold',
  ).not.toBeNull();
  await page.setViewportSize(found!);
  const dialog = await openResults(page, 'win');
  const body = dialog.locator('.wy-results-body');
  expect(await body.evaluate((b) => b.scrollTop), 'the closed panel fits: nothing scrolled').toBe(
    0,
  );
  const box = await boxOf(page, '.wy-survey-opener > .wy-btn');
  await page.mouse.click(centreX(box), at(box, 0.5));
  await expect(dialog.getByRole('radio', { name: '1' }).first()).toBeFocused();
  await page.waitForTimeout(300);
  await twoFrames(page);
  expect(
    straddles(await firstOption(page)),
    'the first option opened mostly, not wholly, in view',
  ).toBe(true);
  expect(await body.evaluate((b) => b.scrollTop), 'nothing moved').toBe(0);
});

// --- What the guard lets through, what the dialog's arrival holds, and the keyboard -------------

for (const size of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
] as const) {
  for (const gap of [150, 300]) {
    test(`at ${String(size.width)}×${String(size.height)}, a quick correction from rating 3 to rating 4, ${String(gap)} ms later and near their facing edges, is the player’s: nothing moved under the pointer`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const { dialog } = await untilPremise(async () => {
        const dialog = await openResults(page, 'win');
        // Opened from the keyboard: no pointer press comes before the two below.
        await dialog.getByRole('button', { name: 'Give feedback' }).focus();
        await page.keyboard.press('Enter');
        await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
        const three = '.wy-survey-scale label:nth-of-type(3)';
        await page.locator(three).first().scrollIntoViewIfNeeded();
        await twoFrames(page);
        const b3 = await boxOf(page, three);
        const b4 = await boxOf(page, '.wy-survey-scale label:nth-of-type(4)');
        // Just inside rating 3's facing edge, then on rating 4's radio.
        const p3 = { x: b3.x + b3.width - 4, y: at(b3, 0.5) };
        const p4 = { x: b4.x + 7, y: at(b4, 0.5) };
        expect(
          Math.hypot(p4.x - p3.x, p4.y - p3.y),
          'the two presses are at one spot, to the guard',
        ).toBeLessThanOrEqual(PRESS_GUARD_SLOP_PX);
        return { premise: await pressApart(page, p3, p4, gap), dialog };
      });
      await expect(dialog.getByRole('radio', { name: '4' }).first()).toBeChecked();
    });
  }
}

for (const key of ['Enter', 'Space'] as const) {
  test(`(a) at 1440×900, 200% text, Not now double-clicked, then ${key}: the held second press moved no focus, so ${key} acts on Give feedback, where Not now left it`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const dialog = await notNowCase(page, () => openResults(page, 'win', 200), 'double-click');
    const feedback = dialog.getByRole('button', { name: 'Give feedback' });
    await expect(feedback, 'focus where Not now put it').toBeFocused();
    await page.keyboard.press(key);
    await expect(
      dialog.getByRole('button', { name: 'Send' }),
      `${key} opened the survey again`,
    ).toBeVisible();
    await expectNoNewRun(page, dialog, `${key} after the double-click`);
  });
}

test('a double-click on the board as the run ends: its second press lands on Play again in the dialog that just opened, and is held', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  // Where Play again stands in the open dialog, measured on the same run already over.
  await openResults(page, 'win');
  const play = await boxOf(page, '.wy-results .wy-primary');
  const [x, y] = [centreX(play), at(play, 0.5)];
  const dialog = page.getByRole('dialog');
  const hit = ([px, py]: readonly [number, number]) =>
    page.evaluate(
      ([hx, hy]) => {
        const el = document.elementFromPoint(hx, hy);
        return {
          control: el?.closest('button, a[href], input, select, textarea, label') != null,
          playAgain: el !== null && document.querySelector('.wy-results .wy-primary')!.contains(el),
        };
      },
      [px, py] as const,
    );
  // Its presses are timed by the clock in both browsers (Chromium's carry the time they are sent
  // at), with the dialog's arrival awaited between them.
  await untilPremise(async () => {
    // The same run one tick short of its end: the first press anywhere plays that tick, and the
    // dialog opens on the next frame (`results-entry.ts`, `&endOnPress=1`).
    await page.goto(`${HARNESS}?run=win&survey=1&endOnPress=1`);
    const board = page.locator('.wy-board');
    await expect(board).toHaveAttribute('data-sim-phase', /\w/, { timeout: 30_000 });
    expect(await board.getAttribute('data-sim-phase'), 'the run is not over yet').not.toBe('won');
    await expect(dialog).toBeHidden();
    expect((await hit([x, y])).control, 'the first press lands on the board, on no control').toBe(
      false,
    );
    await recordClicks(page);
    if (isChromium(page)) {
      const cdp = await page.context().newCDPSession(page);
      const send = (type: 'mousePressed' | 'mouseReleased', clickCount: number) =>
        cdp.send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          clickCount,
          timestamp: Date.now() / 1000,
        });
      await send('mousePressed', 1);
      await send('mouseReleased', 1);
      await expect(dialog).toBeVisible();
      expect((await hit([x, y])).playAgain, 'Play again is under the pointer').toBe(true);
      await send('mousePressed', 2);
      await send('mouseReleased', 2);
      await cdp.detach();
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.up();
      await expect(dialog).toBeVisible();
      expect((await hit([x, y])).playAgain, 'Play again is under the pointer').toBe(true);
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
    }
    await twoFrames(page);
    const clicks = await recordedClicks(page);
    expect(
      clicks.map((c) => c.detail),
      'a double-click reached the page',
    ).toEqual([1, 2]);
    const gap = clicks[1]!.t - clicks[0]!.t;
    return {
      premise:
        gap < PRESS_GUARD_REPEAT_MS
          ? null
          : `a double-click on the board: its second click came ${ms(gap)} after the first, past a repeat's ${ms(PRESS_GUARD_REPEAT_MS)} span`,
    };
  });
  await expectNoNewRun(page, dialog, 'the board double-click');
});

test('Enter on Send pressed twice in a row, or held down, starts no new run: Play again takes no key for a moment after focus moves to it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  for (const way of ['twice', 'held'] as const) {
    const dialog = await openResults(page, 'win');
    await dialog.getByRole('button', { name: 'Give feedback' }).focus();
    await page.keyboard.press('Enter');
    await afterKeyActivation(page);
    const four = dialog.getByRole('radio', { name: '4' }).first();
    await four.focus();
    await page.keyboard.press('Space');
    await afterKeyActivation(page);
    await expect(four).toBeChecked();
    await dialog.getByRole('button', { name: 'Send' }).focus();
    if (way === 'twice') {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter');
    } else {
      // Held down: the system repeats the key after a delay (`repeat` set).
      await page.keyboard.down('Enter');
      await page.waitForTimeout(550);
      for (let i = 0; i < 4; i++) {
        await page.keyboard.down('Enter');
        await page.waitForTimeout(35);
      }
      await page.keyboard.up('Enter');
    }
    await expect(dialog.getByRole('status')).toContainText('Thanks for the feedback');
    await expect(dialog.getByRole('button', { name: 'Play again' }), `Enter ${way}`).toBeFocused();
    await twoFrames(page);
    await expectNoNewRun(page, dialog, `Enter ${way} on Send`);
  }
  // A moment on, Play again takes its key.
  await page.waitForTimeout(PRESS_GUARD_KEY_HOLD_MS);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog'), 'Play again started a new run').toBeHidden();
});

for (const r of [
  { width: 658, height: 320, text: 200 },
  { width: 1024, height: 600, text: 200 },
] as const) {
  test(`at ${sizeLabel(r)}, Run data open, a pointer Send and a Tab while it is in flight: Play again takes focus with its ring in view`, async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName === 'webkit',
      'WebKit focuses no button on a press, and its Tab reaches no button by default: focus never enters the form, so the accepted Send leaves focus where it is',
    );
    await page.setViewportSize(r);
    const dialog = await openResults(page, 'win', r.text, '&sendDelay=1500');
    await pressOnce(page, '.wy-results-more');
    await expect(toggleOf(dialog)).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(PRESS_GUARD_WINDOW_MS);
    await pressOnce(page, '.wy-survey-opener > .wy-btn');
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
    await page.waitForTimeout(PRESS_GUARD_WINDOW_MS);
    await pressOnce(page, '.wy-survey-scale label:nth-of-type(4)');
    await expect(dialog.getByRole('radio', { name: '4' }).first()).toBeChecked();
    await page.waitForTimeout(PRESS_GUARD_WINDOW_MS);
    await scrollToEnd(page);
    await pressOnce(page, '.wy-survey-actions .wy-btn:nth-child(1)');
    await expect(dialog.getByRole('status')).toContainText('Sending your feedback');
    // The player switches to the keyboard while the send is in flight.
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.matches(':focus-visible')),
      'a Tab rings focus',
    ).toBe(true);
    await expect(dialog.getByRole('status')).toContainText('Thanks for the feedback', {
      timeout: 10_000,
    });
    await expect(dialog.getByRole('button', { name: 'Play again' })).toBeFocused();
    await twoFrames(page);
    const ring = await page.evaluate(() => {
      const body = document.querySelector('.wy-results-body')!;
      const port = body.getBoundingClientRect();
      const el = document.querySelector('.wy-results .wy-primary')!;
      const box = el.getBoundingClientRect();
      return {
        ringed: el.matches(':focus-visible'),
        inView: box.top >= port.top - 0.5 && box.bottom <= port.top + body.clientHeight + 0.5,
      };
    });
    expect(ring.ringed, 'Play again shows its focus ring').toBe(true);
    expect(ring.inView, 'and the ring is in view').toBe(true);
  });
}

for (const r of [
  { width: 844, height: 390, text: 200 },
  { width: 1024, height: 600, text: 200 },
] as const) {
  test(`at ${sizeLabel(r)}, Run data open, a keyboard Send from the end of the form brings Play again into view as it takes focus`, async ({
    page,
  }) => {
    await page.setViewportSize(r);
    const dialog = await openResults(page, 'win', r.text);
    const toggle = toggleOf(dialog);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await afterKeyActivation(page);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await dialog.getByRole('button', { name: 'Give feedback' }).focus();
    await page.keyboard.press('Enter');
    await afterKeyActivation(page);
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
    const four = dialog.getByRole('radio', { name: '4' }).first();
    await four.focus();
    await page.keyboard.press('Space');
    await afterKeyActivation(page);
    await expect(four).toBeChecked();
    await dialog.getByRole('button', { name: 'Send' }).focus();
    await scrollToEnd(page);
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('status')).toContainText('Thanks for the feedback');
    await expect(dialog.getByRole('button', { name: 'Play again' })).toBeFocused();
    await twoFrames(page);
    const after = await page.locator('.wy-results-body').evaluate((b) => {
      const port = b.getBoundingClientRect();
      const box = document.querySelector('.wy-results .wy-primary')!.getBoundingClientRect();
      return {
        top: b.scrollTop,
        end: b.scrollHeight - b.clientHeight,
        inView: box.top >= port.top - 0.5 && box.bottom <= port.top + b.clientHeight + 0.5,
      };
    });
    expect(after.inView, 'focus on Play again is in view').toBe(true);
    // The collapse's clamp alone leaves the body at its end; only the focus scroll moves it off.
    expect(after.top, 'the focus scrolled Play again into view').toBeLessThan(after.end - 1);
  });
}

// --- The board as the run ends, and the keyboard (#181 H2, QC round 4) -----------------------

/** Where Play again stands in the open dialog at `size`, measured on the same run already over;
 *  then the page again on the run one tick short of its end (`results-entry.ts`: `&endOnPress=1`,
 *  with `extra` for its other knobs), the dialog not yet open. */
async function endingOnBoard(page: Page, size: Size, extra = ''): Promise<Point> {
  await page.setViewportSize(size);
  await openResults(page, 'win');
  const play = await boxOf(page, '.wy-results .wy-primary');
  await page.goto(`${HARNESS}?run=win&survey=1&endOnPress=1${extra}`);
  await expect(page.locator('.wy-board')).toHaveAttribute('data-sim-phase', /\w/, {
    timeout: 30_000,
  });
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.waitForTimeout(300);
  return { x: centreX(play), y: at(play, 0.5) };
}

/** A press with the real pointer, held `hold` ms: nothing scrolls first. */
async function rawPress(page: Page, p: Point, hold = 90, clickCount = 1): Promise<void> {
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({ clickCount });
  await page.waitForTimeout(hold);
  await page.mouse.up({ clickCount });
}

/** The run is over, no new run started, no answer was given, and the dialog is still open. */
async function expectHeld(page: Page, what: string): Promise<void> {
  await twoFrames(page);
  const dialog = page.getByRole('dialog');
  await expectNoNewRun(page, dialog, what);
  expect((await strayState(page)).answers, `${what}: no survey answer`).toBe(0);
}

for (const hold of [450, 550]) {
  test(`a press on the board held ${String(hold)} ms as the run ends, then a press 135 ms after its release on Play again, now under the pointer: held`, async ({
    page,
  }) => {
    await untilPremise(async () => {
      const spot = await endingOnBoard(page, { width: 1280, height: 720 });
      await recordClicks(page);
      await rawPress(page, spot, hold);
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.waitForTimeout(HELD_GAP);
      await rawPress(page, spot, 80);
      const downs = await recordedDowns(page);
      const clicks = await recordedClicks(page);
      expect(downs, 'two presses reached the page').toHaveLength(2);
      expect(downs[1]! - downs[0]!, 'past the window from the first press').toBeGreaterThanOrEqual(
        PRESS_GUARD_WINDOW_MS,
      );
      expect(clicks, 'the first press released over the dialog').toHaveLength(2);
      const afterRelease = downs[1]! - clicks[0]!.t;
      return {
        premise:
          afterRelease < PRESS_GUARD_WINDOW_MS
            ? null
            : `a board press held ${String(hold)} ms: the second came ${ms(afterRelease)} after its release, not inside the ${ms(PRESS_GUARD_WINDOW_MS)} window`,
      };
    });
    await expectHeld(page, 'the held board press');
  });
}

test('two single clicks at one spot, the dialog arriving 0–200 ms before the second: the second, aimed at the board, lands on Play again and is held', async ({
  page,
}) => {
  await untilPremise(async () => {
    const spot = await endingOnBoard(page, { width: 1280, height: 720 }, '&endDelay=570');
    await recordClicks(page);
    await rawPress(page, spot);
    await page.waitForTimeout(560);
    await rawPress(page, spot);
    const downs = await recordedDowns(page);
    const onPlay = await recordedDownsOnPlay(page);
    // Unset where the run had not ended yet when the second press came.
    const endedAt = await page.evaluate(
      () => (window as unknown as { __endedAt?: number }).__endedAt,
    );
    expect(downs, 'two presses reached the page').toHaveLength(2);
    expect(downs[1]! - downs[0]!, 'past the window from the first press').toBeGreaterThanOrEqual(
      PRESS_GUARD_WINDOW_MS,
    );
    // The premise: the dialog arrived 0–200 ms before the second press, which landed on Play
    // again in it.
    const arrived = endedAt === undefined ? null : downs[1]! - endedAt;
    return {
      premise:
        arrived !== null && arrived > 0 && arrived < 200 && onPlay[1] === true
          ? null
          : `the dialog arrived ${arrived === null ? 'after' : `${ms(arrived)} before`} the second press, ${onPlay[1] === true ? 'which landed on Play again' : 'which missed Play again'}, not 0–200 ms before it on Play again`,
    };
  });
  await expectHeld(page, 'two clicks, the dialog arriving between them');
});

test('a deliberate click on the board, then on Play again 700 ms after the dialog arrives: it starts the run', async ({
  page,
}) => {
  const spot = await endingOnBoard(page, { width: 1280, height: 720 });
  await rawPress(page, spot);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(700);
  await rawPress(page, spot);
  await expect(page.getByRole('dialog'), 'Play again started a new run').toBeHidden();
});

for (const key of ['Enter', 'Space'] as const) {
  test(`${key} pressed twice on the board as the run ends, 160 ms apart: the first ends it, and the second finds Play again focused and held`, async ({
    page,
  }) => {
    await endingOnBoard(page, { width: 1280, height: 720 }, '&endOnKey=1');
    await page.locator('.wy-board').focus();
    await page.evaluate(() => {
      const w = window as unknown as { __keyOnPlay: boolean[] };
      w.__keyOnPlay = [];
      window.addEventListener(
        'keydown',
        (e) =>
          w.__keyOnPlay.push((e.target as Element).closest('.wy-results .wy-primary') !== null),
        true,
      );
    });
    await page.keyboard.press(key, { delay: 90 });
    await page.waitForTimeout(160);
    await page.keyboard.press(key, { delay: 90 });
    await page.waitForTimeout(300);
    const keyOnPlay = await page.evaluate(
      () => (window as unknown as { __keyOnPlay: boolean[] }).__keyOnPlay,
    );
    expect(keyOnPlay, 'two keys reached the page').toHaveLength(2);
    expect(keyOnPlay[1], 'the second key found Play again focused').toBe(true);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectHeld(page, `${key} twice on the board`);
  });
}

test('Space pressed twice on Give feedback, 150 ms apart: the second finds the first rating focused and checks nothing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const dialog = await openResults(page, 'win');
  await dialog.getByRole('button', { name: 'Give feedback' }).focus();
  await page.keyboard.press('Space', { delay: 70 });
  await page.waitForTimeout(150);
  await page.keyboard.press('Space', { delay: 70 });
  await page.waitForTimeout(250);
  await expect(dialog.getByRole('button', { name: 'Send' }), 'the form opened').toBeVisible();
  await expectHeld(page, 'Space twice on Give feedback');
});

test('Enter pressed twice on Not now, 150 ms apart: the second finds Give feedback focused and does not reopen the survey', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const dialog = await openResults(page, 'win');
  await dialog.getByRole('button', { name: 'Give feedback' }).focus();
  await page.keyboard.press('Enter');
  await afterKeyActivation(page);
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Not now' }).focus();
  await page.keyboard.press('Enter', { delay: 60 });
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter', { delay: 60 });
  await page.waitForTimeout(250);
  expect((await strayState(page)).survey, 'the survey stayed closed').toBe(false);
  await expectHeld(page, 'Enter twice on Not now');
});

test('a deliberate Enter on Give feedback 650 ms after Not now reopens the survey, and a deliberate Space 650 ms after Give feedback checks the first rating', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const dialog = await openResults(page, 'win');
  await dialog.getByRole('button', { name: 'Give feedback' }).focus();
  await page.keyboard.press('Enter');
  await afterKeyActivation(page);
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Not now' }).focus();
  await page.keyboard.press('Enter', { delay: 60 });
  await page.waitForTimeout(650);
  await page.keyboard.press('Enter', { delay: 60 });
  await afterKeyActivation(page);
  await expect(dialog.getByRole('button', { name: 'Send' }), 'Enter reopened it').toBeVisible();
  // The form closed again by Not now, then Space on Give feedback, the same way.
  await dialog.getByRole('button', { name: 'Not now' }).focus();
  await page.keyboard.press('Enter', { delay: 60 });
  await page.waitForTimeout(650);
  await dialog.getByRole('button', { name: 'Give feedback' }).focus();
  await page.keyboard.press('Space', { delay: 60 });
  await page.waitForTimeout(650);
  await page.keyboard.press('Space', { delay: 60 });
  expect((await strayState(page)).answers, 'Space checked the first rating').toBe(1);
});

test.describe('a double-tap on the board as the run ends', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('at 844×390 the first tap gives the page no mousedown or click (the dialog arrived over it), and the second lands on Play again and is held', async ({
    page,
  }) => {
    const spot = await endingOnBoard(page, { width: 844, height: 390 });
    expect(
      await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
      'a coarse pointer',
    ).toBe(true);
    await recordClicks(page);
    const cdp = isChromium(page) ? await page.context().newCDPSession(page) : null;
    const tap = async (hold: number): Promise<void> => {
      if (cdp === null) return page.touchscreen.tap(spot.x, spot.y);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [spot] });
      await page.waitForTimeout(hold);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await tap(110);
    await page.waitForTimeout(140);
    await tap(90);
    await page.waitForTimeout(400);
    await cdp?.detach();
    const onPlay = (await recordedClicks(page)).filter((c) => c.onPlay);
    expect(onPlay, 'exactly one pointer click reached Play again').toHaveLength(1);
    if (isChromium(page)) expect(onPlay[0]!.detail, 'the second tap, counted as a repeat').toBe(2);
    await expectHeld(page, 'the double-tap on the board');
  });
});

/** A touch on `p` held `hold` ms, by CDP: the only way to hold a touch. */
async function cdpTap(page: Page, cdp: CDPSession, p: Point, hold: number): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  await page.waitForTimeout(hold);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('a slow tap, a burst of taps or a long touch on the board as the run ends', () => {
  test.use({ hasTouch: true, isMobile: true });

  // A tap the dialog arrived during gives the page no `mousedown` and no `click`, so the guard
  // times the arrival from its release; the system's count (`detail` above 1) holds a repeat for
  // 2 s. Chromium only: Playwright holds a touch only through CDP.
  const cases: {
    name: string;
    extra?: string;
    /** How many of the taps' clicks reach Play again (a tap the dialog arrived during gives none). */
    onPlay: number;
    taps: readonly { hold: number; after: number }[];
  }[] = [
    ...[450, 550, 800].map((hold) => ({
      onPlay: 1,
      name: `a first tap held ${String(hold)} ms, then a second tap 135 ms after its release`,
      taps: [
        { hold, after: HELD_GAP },
        { hold: 90, after: 400 },
      ],
    })),
    {
      name: 'a triple-tap burst, 250 ms apart',
      onPlay: 2,
      taps: [
        { hold: 90, after: 160 },
        { hold: 90, after: 160 },
        { hold: 90, after: 400 },
      ],
    },
    {
      name: 'a touch held 2.3 s with the dialog arriving 2.1 s in, then a second tap 135 ms after its release',
      extra: '&endDelay=2100',
      onPlay: 1,
      taps: [
        { hold: 2300, after: HELD_GAP },
        { hold: 90, after: 400 },
      ],
    },
  ];
  for (const c of cases) {
    test(`at 844×390, ${c.name}: the dialog stays open, with no new run and no answer`, async ({
      page,
    }) => {
      test.skip(!isChromium(page), 'a held touch needs CDP');
      const spot = await endingOnBoard(page, { width: 844, height: 390 }, c.extra ?? '');
      expect(
        await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
        'a coarse pointer',
      ).toBe(true);
      const cdp = await page.context().newCDPSession(page);
      await recordClicks(page);
      for (const tap of c.taps) {
        await cdpTap(page, cdp, spot, tap.hold);
        await page.waitForTimeout(tap.after);
      }
      await cdp.detach();
      const onPlay = (await recordedClicks(page)).filter((k) => k.onPlay);
      expect(onPlay, `${c.name}: the taps after the first reached Play again`).toHaveLength(
        c.onPlay,
      );
      await expectHeld(page, c.name);
    });
  }
});
