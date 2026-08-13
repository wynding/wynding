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

/** The preview's current home by CLASS MEMBERSHIP, never className equality — a modifier
 *  class on either host must not fail (or worse, silently mis-route) these assertions. */
const previewHome = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const parent = document.querySelector('.wy-wave-preview')!.parentElement;
    if (parent?.classList.contains('wy-stage')) return 'stage';
    if (parent?.classList.contains('wy-hud')) return 'hud';
    return 'other';
  });

test('1512×854: preview growth and hiding cannot re-project the board', async ({ page }) => {
  await gotoAt(page, STANDARD);

  const preview = page.locator('.wy-wave-preview');
  await expect(preview).toBeVisible();
  // The float itself: a Stage child, absolutely positioned — out of every layout flow.
  expect(await previewHome(page)).toBe('stage');
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

test('1512×854 at 200% text zoom: the float STAYS — zoom never re-homes, content never moves the board', async ({
  page,
}) => {
  // Codex #96 P1: an earlier draft re-homed the preview to the hud from 150% root font —
  // but the hud lives in the content-sized status row, so wave changes re-projected the
  // board for zoomed Standard users, the exact defect this round ends. The px-capped
  // card + in-place scroll form serve every zoom level instead, so the ONLY hud homes
  // are static (Compact; sub-400px stages).
  await gotoAt(page, STANDARD);
  expect(await previewHome(page)).toBe('stage');
  await page.addStyleTag({ content: ':root { font-size: 200% }' });
  await page.waitForTimeout(200); // let the zoom's own (legitimate) reflow settle
  expect(await previewHome(page), 'zoom must not re-home the float').toBe('stage');

  const gridBefore = await projectedGrid(page);
  const statusBefore = await statusHeight(page);
  await page.evaluate(() => {
    const list = document.querySelector('.wy-wave-preview-list')!;
    for (let i = 0; i < 3; i++) {
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
      { message: 'zoomed overflow is handled by the scroll form, in place' },
    )
    .toBe(true);
  expect(await previewHome(page)).toBe('stage');
  expect(await projectedGrid(page), 'content re-projected the board at 200% zoom').toEqual(
    gridBefore,
  );
  expect(await statusHeight(page), 'content resized the status row at 200% zoom').toBe(
    statusBefore,
  );
});

test('360×640 (portrait Standard): the hud home is content-invariant — the row reservation', async ({
  page,
}) => {
  // The one Standard shape that cannot host a readable float (the width bucket): the hud
  // hosts the preview, and ui.css's reservation pins the hud at its cap — so the wave
  // 1→4-entry swing and the end-of-run hide, the exact changes that resized the row
  // pre-round, cannot move the board from this home either (Codex #96 P1's second half).
  await gotoAt(page, { width: 360, height: 640 });
  expect(await previewHome(page)).toBe('hud');

  const gridBefore = await projectedGrid(page);
  const statusBefore = await statusHeight(page);
  await page.evaluate(() => {
    const list = document.querySelector('.wy-wave-preview-list')!;
    for (let i = 0; i < 3; i++) {
      const li = document.createElement('li');
      li.textContent = '12 × Probe — ground, armor 0, leak cost 1, no immunities';
      list.append(li);
    }
  });
  expect(await projectedGrid(page), 'a four-entry preview re-projected the board').toEqual(
    gridBefore,
  );
  expect(await statusHeight(page), 'a four-entry preview resized the reserved row').toBe(
    statusBefore,
  );
  await page.evaluate(() => {
    (document.querySelector('.wy-wave-preview') as HTMLElement).hidden = true;
  });
  expect(await projectedGrid(page), 'hiding the preview re-projected the board').toEqual(
    gridBefore,
  );
  expect(await statusHeight(page), 'hiding the preview resized the reserved row').toBe(
    statusBefore,
  );
});

test('1280×720 at 140% zoom, overflowing preview: handled IN PLACE — the float scrolls, the board never moves', async ({
  page,
}) => {
  // With content the clamped card cannot hold — at any zoom level: the card flips to its
  // scroll form (`--scroll`: wheel/drag + a tab stop) instead of re-homing.
  // A content-driven re-home is forbidden outright — the hud lives in the content-sized
  // status row, so moving there re-projects the board mid-run, the exact defect this
  // file exists to pin (measured -15%..-24% cellPx when an earlier draft re-homed here).
  // 1280×720 rests CLEAN at 140% (the shipped one-entry preview fits its clamp — smaller
  // windows like 700×560 already rest in scroll form there, so the return-to-resting half
  // below would be unsatisfiable); five injected lines then overflow the clamp with slack
  // on any font stack.
  await gotoAt(page, { width: 1280, height: 720 });
  await page.addStyleTag({ content: ':root { font-size: 140% }' });
  // Settle after the zoom's own (user-initiated, legitimate) reflow, THEN pin.
  await expect.poll(() => previewHome(page)).toBe('stage');
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
  // The node never moved and the board never moved — the invariant, under zoom.
  expect(await previewHome(page)).toBe('stage');
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

test('1280×720 at 140% zoom, scroll-form preview: a captured board release over it cancels — the card is input chrome, no tower placed behind it', async ({
  page,
}) => {
  // Codex #96 P2: pointer capture delivers a board-origin release wherever it lands, and in
  // the overflow scroll form the preview takes the pointer — so before `input.ts` listed
  // `.wy-wave-preview` in `CHROME_SELECTOR`, the release fell through the chrome hit-test
  // and PLACED a tower on the cell behind the card. The drag here is real (mouse down on
  // the plain board, release over the card), so the whole chain is exercised: capture, the
  // live `document.elementFromPoint`, and the selector against the real node. The
  // classification itself is unit-pinned per release path in input.test.ts; this is the
  // real-pipeline witness.
  await gotoAt(page, { width: 1280, height: 720 });
  await page.addStyleTag({ content: ':root { font-size: 140% }' });
  await expect.poll(() => previewHome(page)).toBe('stage');
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
      { message: 'the fixture premise: the injected composition flips the scroll form on' },
    )
    .toBe(true);

  await page.keyboard.press('1');
  const armedCard = page.locator('.wy-card[aria-pressed="true"]');
  await expect(armedCard).toHaveCount(1);
  const sellButton = page.locator('.wy-panel').getByRole('button', { name: /^Sell/ });

  // Press on the plain board (grid right-of-centre — clear of the float AND the Dock's
  // bottom-left overlap), then release over the scrollable card.
  const grid = await projectedGrid(page);
  const previewBox = (await page.locator('.wy-wave-preview').boundingBox())!;
  const down = { x: grid.x + grid.width * 0.75, y: grid.y + grid.height / 2 };
  const release = {
    x: previewBox.x + previewBox.width / 2,
    y: previewBox.y + previewBox.height / 2,
  };
  expect(
    await page.evaluate(
      ({ x, y }) => {
        // Explicit null check so a bad point FAILS this guard — `el?.closest(...) !== null`
        // would pass vacuously (undefined !== null) exactly when the point misses everything.
        const el = document.elementFromPoint(x, y);
        return el !== null && el.closest('.wy-board') !== null;
      },
      { x: down.x, y: down.y },
    ),
    'the press must start on the plain board or the drag proves nothing',
  ).toBe(true);
  await page.mouse.move(down.x, down.y);
  await page.mouse.down();
  await page.mouse.move(release.x, release.y);
  await page.mouse.up();

  // Settle two frames before asserting: `clickAt` mutates controller state synchronously,
  // but `aria-pressed` and the Panel only update on the next frame-loop pass — an
  // immediate assert could sample the stale DOM inside that one-frame window and wave a
  // regression through (and the control arm below would then green-wash it by selecting
  // the wrongly-placed tower). Two RAFs guarantee at least one full app frame ran.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );

  // The chrome-release contract: nothing placed, and the board-origin mouse flow stays
  // armed with everything as it was.
  await expect(armedCard).toHaveCount(1);
  await expect(sellButton).toBeHidden();

  // The premise, proven in-test so this can never rot vacuous: the SAME release point maps
  // to a cell a placement genuinely succeeds on. Make the card hit-test-transparent (its
  // resting state) and click the same point — the tower now places and its Panel opens.
  // Only the chrome classification stopped the drag above, not geometry or cell validity.
  await page.evaluate(() => {
    (document.querySelector('.wy-wave-preview') as HTMLElement).style.pointerEvents = 'none';
  });
  await page.mouse.click(release.x, release.y);
  await expect(sellButton).toBeVisible();
});

test('the preview re-homes across the layout fork — Stage on Standard, chips column on Compact', async ({
  page,
}) => {
  await gotoAt(page, STANDARD);
  expect(await previewHome(page)).toBe('stage');

  // Crossing the fork fires the real matchMedia change listener (`main.ts`) — the ONE
  // node is re-homed, never duplicated (one AT surface).
  await page.setViewportSize(PHONE);
  await expect
    .poll(() => previewHome(page), { message: 'Compact must re-home the preview' })
    .toBe('hud');
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
    .poll(() => previewHome(page), { message: 'Standard must re-float the preview' })
    .toBe('stage');
});
