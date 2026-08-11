import { test, expect, type Page } from '@playwright/test';
import { projectedGrid } from './layout-probe';

// stage-stability.spec.ts — the playtest round's core invariant: THE BOARD NEVER MOVES.
//
// Before this round the wave preview lived in the status row, the shell's content-sized
// first grid row — so every preview change (a wave with more entry lines, a font-stack
// wrap, the end-of-run hide) resized the row and re-projected the whole board mid-run
// (cellPx 30 → 27 at a 1512×854 window when wave 9's four-entry preview arrived). The fix
// floats the preview over the Stage on Standard (`shell.placePreview` + ui.css); these
// tests pin the decoupling itself, not the current wave data: the preview is grown and
// hidden by direct DOM probes, which is exactly the class of change that used to reflow
// the board and now cannot.

const STANDARD = { width: 1512, height: 854 };
const PHONE = { width: 658, height: 320 }; // Galaxy S9+ landscape — the Compact trigger

async function gotoAt(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
}

const statusHeight = (page: Page): Promise<number> =>
  page.evaluate(() =>
    Math.round(document.querySelector('.wy-status')!.getBoundingClientRect().height),
  );

test('1512×854: preview growth and hiding cannot re-project the board', async ({ page }) => {
  await gotoAt(page, STANDARD);

  const preview = page.locator('.wy-wave-preview');
  await expect(preview).toBeVisible();
  // The float itself: a Stage child, absolutely positioned — out of every layout flow.
  expect(await preview.evaluate((el) => el.parentElement?.className)).toBe('wy-stage');
  expect(await preview.evaluate((el) => getComputedStyle(el).position)).toBe('absolute');

  const gridBefore = await projectedGrid(page);
  const statusBefore = await statusHeight(page);

  // Grow the preview by three entry lines — wave 9 previews FOUR entries, so this is the
  // real in-run range, applied as a DOM probe so the pin needs no four-wave playthrough.
  await page.evaluate(() => {
    const list = document.querySelector('.wy-wave-preview-list')!;
    for (let i = 0; i < 3; i++) {
      const li = document.createElement('li');
      li.textContent = '12 × Probe — ground, armor 0, leak cost 1, no immunities';
      list.append(li);
    }
  });
  const gridGrown = await projectedGrid(page);
  expect(gridGrown, 'a four-entry preview re-projected the board').toEqual(gridBefore);
  expect(await statusHeight(page), 'a four-entry preview resized the status row').toBe(
    statusBefore,
  );

  // The end-of-run hide — the same invariant from the other side.
  await page.evaluate(() => {
    (document.querySelector('.wy-wave-preview') as HTMLElement).hidden = true;
  });
  expect(await projectedGrid(page), 'hiding the preview re-projected the board').toEqual(
    gridBefore,
  );
  expect(await statusHeight(page), 'hiding the preview resized the status row').toBe(statusBefore);
});

test('1512×854: the floating preview is display-only — no pixel of it intercepts the board', async ({
  page,
}) => {
  await gotoAt(page, STANDARD);
  // Visible first, or the probe below samples a zero rect and passes vacuously.
  await expect(page.locator('.wy-wave-preview')).toBeVisible();
  const hit = await page.evaluate(() => {
    const r = document.querySelector('.wy-wave-preview')!.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      onPreview: el?.closest('.wy-wave-preview') !== null,
      onBoard: el?.closest('.wy-board') !== null,
    };
  });
  // `pointer-events: none` — the click passes THROUGH to the board beneath, not merely
  // "somewhere else" (a positive target assertion so a moved preview can't pass this by
  // sitting over different chrome).
  expect(hit.onPreview, 'the preview must never be a pointer target').toBe(false);
  expect(hit.onBoard, 'the click lands on the board beneath the preview').toBe(true);
});

test('1512×854 at 200% text zoom: the preview re-homes to the chips scrollport', async ({
  page,
}) => {
  // The float is `pointer-events: none` — it cannot scroll — and it is px-bounded, so
  // zoom would otherwise clip its content against the 40% Stage budget. From 150% root
  // font, `main.ts`'s zoom bucket returns it to `.wy-hud`, the bounded scrollport whose
  // 200%-zoom behavior the accessibility checklist certifies (smoke.spec's zoom gates).
  await gotoAt(page, STANDARD);
  const parentClass = () =>
    page.evaluate(() => document.querySelector('.wy-wave-preview')!.parentElement?.className);
  expect(await parentClass()).toBe('wy-stage');
  await page.addStyleTag({ content: ':root { font-size: 200% }' });
  await expect
    .poll(parentClass, { message: '200% zoom must re-home the preview to the hud' })
    .toBe('wy-hud');
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.wy-wave-preview')!).position,
    ),
  ).toBe('static'); // the in-flow form is keyed on the hud home, not on a media query
});

test('1280×720 at 140% zoom, overflowing preview: handled IN PLACE — the float scrolls, the board never moves', async ({
  page,
}) => {
  // UNDER the 150% coarse bucket with content the clamped card cannot hold: the card
  // flips to its scroll form (`--scroll`: wheel/drag + a tab stop) instead of re-homing.
  // A content-driven re-home is forbidden outright — the hud lives in the content-sized
  // status row, so moving there re-projects the board mid-run, the exact defect this
  // file exists to pin (measured -15%..-24% cellPx when an earlier draft re-homed here).
  // 1280×720 rests CLEAN at 140% (the shipped one-entry preview fits its clamp — smaller
  // windows like 700×560 already rest in scroll form there, so the return-to-resting half
  // below would be unsatisfiable); five injected lines then overflow the clamp with slack
  // on any font stack.
  await gotoAt(page, { width: 1280, height: 720 });
  await page.addStyleTag({ content: ':root { font-size: 140% }' });
  const parentClass = () =>
    page.evaluate(() => document.querySelector('.wy-wave-preview')!.parentElement?.className);
  // Settle after the zoom's own (user-initiated, legitimate) reflow, THEN pin.
  await expect.poll(parentClass).toBe('wy-stage');
  const gridBefore = await projectedGrid(page);
  const statusBefore = await statusHeight(page);

  await page.evaluate(() => {
    const list = document.querySelector('.wy-wave-preview-list')!;
    for (let i = 0; i < 5; i++) {
      const li = document.createElement('li');
      li.textContent = '12 × Probe — ground, armor 0, leak cost 1, no immunities';
      list.append(li);
    }
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          document.querySelector('.wy-wave-preview')!.classList.contains('wy-wave-preview--scroll'),
        ),
      { message: 'overflowing content must flip the float to its scroll form' },
    )
    .toBe(true);
  // The node never moved and the board never moved — the invariant, IN the 125-149% band.
  expect(await parentClass()).toBe('wy-stage');
  expect(await projectedGrid(page), 'the scroll form re-projected the board').toEqual(gridBefore);
  expect(await statusHeight(page), 'the scroll form resized the status row').toBe(statusBefore);
  // And every line is REACHABLE (WCAG 1.4.4): the card scrolls to its end and is a tab stop.
  const reach = await page.evaluate(() => {
    const el = document.querySelector('.wy-wave-preview') as HTMLElement;
    const scrollable = el.scrollHeight > el.clientHeight;
    el.scrollTop = el.scrollHeight;
    return {
      scrollable,
      atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
      tabIndex: el.tabIndex,
      role: el.getAttribute('role'),
      label: el.getAttribute('aria-label'),
    };
  });
  expect(reach.scrollable, 'the injected composition exceeds the clamp (the premise)').toBe(true);
  expect(reach.atEnd, 'the scroll form reaches the last line').toBe(true);
  expect(reach.tabIndex, 'keyboard reach: the scroll form is a tab stop').toBe(0);
  // The `.wy-hud` scrollport discipline: a focusable scrollable region is named, never a
  // bare div (axe's scrollable-region-focusable checks only the focusability half).
  expect(reach.role, 'the scroll form carries a role').toBe('group');
  expect(reach.label, 'the scroll form carries an accessible name').toBeTruthy();

  // BOTH halves of the pointer trade, pinned with the same elementFromPoint probe the
  // resting-form test uses: while scrolling, the card takes the pointer (delete
  // `pointer-events: auto` from the `--scroll` rule and no pointer could scroll it —
  // every other assertion here would stay green)…
  const hitTarget = () =>
    page.evaluate(() => {
      const r = document.querySelector('.wy-wave-preview')!.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return el?.closest('.wy-wave-preview') !== null
        ? 'preview'
        : el?.closest('.wy-board') !== null
          ? 'board'
          : 'other';
    });
  expect(await hitTarget(), 'the scroll form takes the pointer (it must be scrollable)').toBe(
    'preview',
  );
  // …and the moment content fits again, click-through RETURNS — the promise the
  // checklist's resting-form row makes.
  await page.evaluate(() => {
    for (const li of [...document.querySelectorAll('.wy-wave-preview-list li')].slice(1))
      li.remove();
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          document.querySelector('.wy-wave-preview')!.classList.contains('wy-wave-preview--scroll'),
        ),
      { message: 'a fitting composition must return the card to its resting form' },
    )
    .toBe(false);
  await expect
    .poll(hitTarget, { message: 'click-through must return with the resting form' })
    .toBe('board');
});

test('the preview re-homes across the layout fork — Stage on Standard, chips column on Compact', async ({
  page,
}) => {
  await gotoAt(page, STANDARD);
  const parentClass = () =>
    page.evaluate(() => document.querySelector('.wy-wave-preview')!.parentElement?.className);
  expect(await parentClass()).toBe('wy-stage');

  // Crossing the fork fires the real matchMedia change listener (`main.ts`) — the ONE
  // node is re-homed, never duplicated (one AT surface).
  await page.setViewportSize(PHONE);
  await expect.poll(parentClass, { message: 'Compact must re-home the preview' }).toBe('wy-hud');
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.wy-wave-preview')!).position,
    ),
  ).toBe('static'); // back in the chips-column flow
  expect(
    await page.evaluate(() => document.querySelectorAll('.wy-wave-preview').length),
    'exactly one preview node in the document',
  ).toBe(1);

  await page.setViewportSize(STANDARD);
  await expect
    .poll(parentClass, { message: 'Standard must re-float the preview' })
    .toBe('wy-stage');
});
