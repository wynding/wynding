import { test, expect, type Page } from '@playwright/test';
import { createProjection } from '@wynding/render';
import { buildableRect, intersect, projectedGrid, GRID, type Rect } from './layout-probe';
import { callWavePaced, titleAfterCall } from './paced-call';

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
  // real in-run COUNT range, applied as a DOM probe so the pin needs no four-wave
  // playthrough.
  //
  // The injected row text is the pre-#101 verbose sentence, KEPT DELIBERATELY after the
  // content diet shortened real rows: these probes bound how far the preview may grow
  // before the Board re-projects, so a taller-than-real row is the conservative direction
  // and swapping in the shorter glance form would weaken every pin in this file. It is a
  // height fixture, not a rendering assertion — the rendered text is pinned in
  // `compact.spec.ts` and `smoke.spec.ts`, against both forms.
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
  // card + in-place scroll form serve every zoom level instead, so the hud homes are
  // Compact and (since #101) a Stage with no compliant dead band — never zoom itself.
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
  // A Standard shape whose dead space cannot host a readable float (#101): the hud
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
  //
  // THE CARD IS DRIVEN BACK OVER THE GRID, and that override is the honest consequence of
  // #101 rather than a convenience. The ratified placement now parks the float in dead
  // space, so at the SHIPPED position no release over it could place a tower anyway — which
  // would make every assertion below pass for a reason that has nothing to do with
  // `input.ts`. Overriding the band grant (the same custom property `main.ts` writes) puts
  // the card back on a placeable cell so the CHROME CLASSIFICATION is what is being tested,
  // exactly as before. That #101 removed the geometry this defect needed is a good outcome;
  // it is not a reason to stop pinning the contract.
  await gotoAt(page, { width: 1280, height: 720 });
  await page.addStyleTag({ content: ':root { font-size: 140% }' });
  await expect.poll(() => previewHome(page)).toBe('stage');
  await page.addStyleTag({
    content: '.wy-wave-preview { --wy-preview-left: 25% !important; --wy-preview-right: auto; }',
  });
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

// --- The ratified placement rule (#101, owner 2026-08-17) ---------------------------
//
// "The preview never occludes a STRUCTURALLY buildable cell" — a cell a tower could EVER
// be placed on, not one that happens to be empty. This replaces a ≤40%-of-grid-AREA
// allowance that was retired for cause: it passed while the playtest failed, and still
// passed at 3.5% coverage, because bounding an overlap by area says nothing about WHICH
// cells are covered.

/** Every Standard viewport this suite pins, plus the reported one, EACH WITH THE HOME IT
 *  MUST LAND IN at 100% and 200% zoom. Compact viewports are excluded on purpose — there the
 *  preview is in its in-flow hud home, where a layout rect inside a scrollport says nothing
 *  about occlusion (`layout-probe.ts` records why).
 *
 *  THE `home` COLUMN IS THE LIVENESS HALF OF THIS GATE, and it exists because the
 *  disjointness assertion alone cannot fail in the direction that matters. Parking every
 *  viewport in the hud satisfies "occludes no buildable cell" perfectly — an in-flow card
 *  occludes nothing — so a regression that over-parked the card would sail through all
 *  sixteen combinations while costing the board up to a third of its cells. That cost is the
 *  residual this PR measures, so the measurement is what gets pinned: these values ARE the
 *  residual table in `docs/accessibility-checklist.md`, and a change to either has to move
 *  the other.
 *
 *  Read the `hud` rows as the ratified escape hatch firing where the dead space cannot hold
 *  a legible card, not as spare capacity.
 *
 *  `'either'` is NOT a softened expectation — it is the honest one for a viewport whose dead
 *  space lands within a cell of the 64px floor, where the deciding input is the host's font
 *  metrics rather than anything this repo controls. Recorded because it was found the hard
 *  way: 1280×900 at 200% parks on macOS and FLOATS on CI's Linux runner (`e2e` red on
 *  e32165c, "Expected: hud / Received: stage"), and BOTH are correct — the status row is a
 *  few pixels taller there, so the board is a cell smaller, so the letterbox is a cell wider,
 *  so the band clears the floor. Pinning a literal there gates the font stack, not the
 *  placement. It costs the over-park guard nothing: an entry expecting `hud` could never
 *  catch over-parking in the first place (the forced-over-park proof failed exactly the ten
 *  `stage` entries and passed all six `hud` ones), and the occlusion half below still runs
 *  in whichever home it lands in. */
const PINNED_STANDARD = [
  // the viewport #101 was reported at
  { width: 1512, height: 854, home: { 100: 'stage', 200: 'stage' } },
  { width: 1440, height: 900, home: { 100: 'stage', 200: 'stage' } },
  { width: 1366, height: 768, home: { 100: 'stage', 200: 'stage' } },
  // the hidpi projects' fixed viewport — at 200% its band sits ON the floor; see `'either'`
  { width: 1280, height: 900, home: { 100: 'stage', 200: 'either' } },
  // Playwright's Desktop Chrome default
  { width: 1280, height: 720, home: { 100: 'stage', 200: 'stage' } },
  // the board very nearly fills the Stage here: 18px of letterbox at 100%
  { width: 1000, height: 720, home: { 100: 'hud', 200: 'stage' } },
  // coarse-pointer landscape tablet — Standard
  { width: 640, height: 560, home: { 100: 'hud', 200: 'hud' } },
  // portrait phone — Standard by height
  { width: 360, height: 640, home: { 100: 'hud', 200: 'hud' } },
] as const satisfies readonly {
  readonly width: number;
  readonly height: number;
  readonly home: {
    readonly 100: 'stage' | 'hud' | 'either';
    readonly 200: 'stage' | 'hud' | 'either';
  };
}[];

for (const size of PINNED_STANDARD) {
  for (const zoom of [100, 200] as const) {
    const expectedHome = size.home[zoom];
    test(`${size.width}×${size.height} at ${zoom}% zoom: the preview takes its ${expectedHome} home and occludes no structurally buildable cell (#101)`, async ({
      page,
    }) => {
      await gotoAt(page, size);
      if (zoom !== 100) {
        await page.addStyleTag({ content: `:root { font-size: ${zoom}% }` });
        await page.waitForTimeout(200); // the zoom's own (legitimate) reflow
      }
      // Grow the card to wave 9's four-entry shape FIRST: the rule has to hold at the
      // preview's largest real size, and a one-entry card would let a placement that only
      // just fits pass here and fail in play. Same height fixture the pins above use.
      await page.evaluate(() => {
        const list = document.querySelector('.wy-wave-preview-list')!;
        for (let i = 0; i < 3; i++) {
          const li = document.createElement('li');
          li.textContent = '12 × Probe — ground, armor 0, leak cost 1, no immunities';
          list.append(li);
        }
      });
      // POLL for the settled home rather than sleeping at it (the `expect.poll` precedent
      // this file already uses at the 140%-zoom pins). The re-placement is a
      // ResizeObserver tick, so a fixed 200ms was a bet on the runner's mood: too short
      // under load and this reads a half-settled home, too long and every one of sixteen
      // cases pays for it. Polling to the EXPECTED value is safe here because the assertion
      // that follows is the real gate — a home that never arrives fails it on timeout with
      // the same message, and a home that arrives and then moves would fail the occlusion
      // half. In the `either` case there is nothing to poll toward, so settle on a real
      // parent instead.
      await expect
        .poll(() => previewHome(page), { message: 'the re-placement never settled' })
        .toMatch(expectedHome === 'either' ? /^(stage|hud)$/ : new RegExp(`^${expectedHome}$`));

      // LIVENESS FIRST, before any branch reads it. Asserting the home against the measured
      // table is what stops an over-parking regression from passing the disjointness check
      // below by simply having nothing on the board to be disjoint from.
      const home = await previewHome(page);
      if (expectedHome === 'either') {
        // A band ON the floor — the host's font metrics decide, and both answers are
        // correct here (see the table's note). Still pinned to a REAL home, so a card that
        // lost its parent entirely cannot pass; the occlusion half below runs regardless.
        expect(home, 'the card must still be in one of its two homes').toMatch(/^(stage|hud)$/);
      } else {
        expect(
          home,
          home === 'hud'
            ? 'the card fell back to the hud, which costs the board its 40dvh reservation — ' +
                'if that is now correct here, re-measure and move the residual table with it'
            : 'the card floated where the measured residual says the dead space cannot hold it',
        ).toBe(expectedHome);
      }
      if (home === 'hud') {
        // The ratified escape hatch. Nothing to measure — an in-flow card inside a
        // scrollport occludes nothing — but assert it is genuinely in flow so a float that
        // merely lost its `.wy-stage` parent cannot slip through this branch.
        expect(
          await page.evaluate(
            () => getComputedStyle(document.querySelector('.wy-wave-preview')!).position,
          ),
        ).toBe('static');
        return;
      }

      const grid = await projectedGrid(page);
      const card = (await page.locator('.wy-wave-preview').boundingBox()) as Rect;
      expect(card, 'the floating preview must have a layout box to measure').not.toBeNull();
      const clipped = intersect(card, buildableRect(grid));
      expect(
        clipped,
        clipped === null
          ? ''
          : `covers ${(clipped.width / grid.cellPx).toFixed(1)}×${(
              clipped.height / grid.cellPx
            ).toFixed(1)} buildable cells`,
      ).toBeNull();
    });
  }
}

test('1000×720, walking to wave 9: the board never re-projects — the hud fallback is content-invariant on its WIDTH axis too (#101, Codex P2)', async ({
  page,
}) => {
  // The height pin (`.wy-hud:has(> .wy-wave-preview)`) covered one axis. `.wy-status` is a
  // wrapping flex row and the hud was an auto-basis item, so a four-entry wave grew the
  // hud's max-content WIDTH until the row wrapped: measured `.wy-status` 248 → 288px and
  // the board 19 → 18 cellPx as wave 9 arrived. That is the same mid-run re-projection the
  // height pin exists to prevent, arriving through the axis it did not cover — invisible
  // until #101 made this home the escape hatch for wide viewports, since the narrow ones it
  // used to serve have a width-fixed status COLUMN.
  //
  // Deliberately asserted WITHOUT a precondition on the home. The contract is "wave content
  // never moves the board", which must hold in both homes — and pinning the home here would
  // make this test hostage to the 64px floor's boundary behaviour on a given font stack.
  test.setTimeout(150_000);
  await gotoAt(page, { width: 1000, height: 720 });
  await expect(page.locator('.wy-wave-preview')).toBeVisible();

  const gridBefore = await projectedGrid(page);
  const statusBefore = await statusHeight(page);

  // The real walk, not an injected fixture: wave 9 is the arc's densest preview (four
  // entries) and its rows are the real localized strings, so this measures the width the
  // shipped content actually demands.
  const previewTitle = page.locator('.wy-wave-preview .wy-wave-preview-title');
  await page.getByRole('button', { name: 'Start' }).click(); // Start claims wave 1 (#70)
  await expect(previewTitle).toHaveText('Wave 2 of 10');
  await page.getByRole('button', { name: 'Pause' }).click();
  for (let waveNumber = 2; waveNumber <= 8; waveNumber++) {
    await callWavePaced(page, titleAfterCall(waveNumber, 10));
  }
  await expect(previewTitle).toHaveText('Wave 9 of 10');
  await expect(page.locator('.wy-wave-preview li')).toHaveCount(4);

  expect(await statusHeight(page), 'wave 9 resized the status row').toBe(statusBefore);
  expect(await projectedGrid(page), 'wave 9 re-projected the board').toEqual(gridBefore);

  // ...and then the CONSERVATIVE bound, which is what actually reproduces the defect and is
  // the reason this fix is structural rather than contingent. Shipped English at this
  // viewport happens not to demand enough width to wrap the row — #130's content diet
  // shortened the real rows — so the walk above passes even against the unfixed stylesheet.
  // That is luck, not a guarantee: the hud's width came from its own max-content, so the
  // invariant held only while the strings stayed short. A longer locale, a wider row, or a
  // future entry restores the wrap. These over-long rows are the same height/width fixture
  // every other pin in this file uses for exactly that reason, and they are what turns this
  // test red without `flex: 1 1 0`.
  await page.evaluate(() => {
    const list = document.querySelector('.wy-wave-preview-list')!;
    for (let i = 0; i < 3; i++) {
      const li = document.createElement('li');
      li.textContent = '12 × Probe — ground, armor 0, leak cost 1, no immunities';
      list.append(li);
    }
  });
  await page.waitForTimeout(200);
  expect(await statusHeight(page), 'over-long rows wrapped the status row').toBe(statusBefore);
  expect(await projectedGrid(page), 'over-long rows re-projected the board').toEqual(gridBefore);
});

test('1512×854, wave 9 pending: a tower built in the corner the preview used to own is FULLY visible (#101)', async ({
  page,
}) => {
  // The regression case, at the reported viewport, in the reported situation. The owner's
  // words were "I rarely build in that corner, though — but I could! Except I can't because
  // it's in the way" — so this builds there, walks the run to wave 9 (the arc's densest
  // preview, four entries), and proves the card and the tower do not share a pixel.
  //
  // Above the sum of this test's budgets — seven paced calls at a 5s in-page deadline each
  // (`paced-call.ts`) plus the placement and geometry tail — which the 60s config default
  // cannot hold. Same budget-coherence rule as the other marathon specs.
  test.setTimeout(150_000);
  await gotoAt(page, STANDARD);

  const board = page.locator('.wy-board');
  const box = (await board.boundingBox()) as Rect;
  const projection = createProjection({
    cols: GRID.cols,
    rows: GRID.rows,
    cssWidth: box.width,
    cssHeight: box.height,
    dpr: 1,
  });
  // THE corner: the top-left-most cell a 2×2 footprint can anchor on, one cell in from the
  // blocked border ring. Pre-#101 the float sat at the Stage's top-left with a 256px-wide
  // card, squarely over it.
  const CORNER = { col: 1, row: 1 };
  const anchor = projection.cellToPixel(CORNER.col, CORNER.row);
  await page.getByRole('button', { name: /Basic Tower/ }).click();
  await page.mouse.click(
    box.x + anchor.x + projection.cellPx / 2,
    box.y + anchor.y + projection.cellPx / 2,
  );
  await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();

  // Walk to wave 9. Start claims wave 1 (#70), so waves 2..8 are called from here; the
  // paced helper holds the sim frozen for every observation so an undefended marathon
  // cannot lose mid-loop (#97).
  const previewTitle = page.locator('.wy-wave-preview .wy-wave-preview-title');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(previewTitle).toHaveText('Wave 2 of 10');
  await page.getByRole('button', { name: 'Pause' }).click();
  for (let waveNumber = 2; waveNumber <= 8; waveNumber++) {
    await callWavePaced(page, titleAfterCall(waveNumber, 10));
  }
  await expect(previewTitle).toHaveText('Wave 9 of 10');
  await expect(page.locator('.wy-wave-preview li')).toHaveCount(4);

  // The tower's own 2×2 footprint in page coordinates, and the card's box. Not one pixel
  // of overlap — the whole complaint was that the corner was unusable because the card was
  // over it, and "mostly clear" is what the retired area budget already allowed.
  const grid = await projectedGrid(page);
  const footprint: Rect = {
    x: grid.x + CORNER.col * grid.cellPx,
    y: grid.y + CORNER.row * grid.cellPx,
    width: 2 * grid.cellPx,
    height: 2 * grid.cellPx,
  };
  const card = (await page.locator('.wy-wave-preview').boundingBox()) as Rect;
  expect(
    intersect(card, footprint),
    `the wave-9 preview at [${Math.round(card.x)},${Math.round(card.y)} ${Math.round(
      card.width,
    )}×${Math.round(card.height)}] covers the corner tower at [${Math.round(
      footprint.x,
    )},${Math.round(footprint.y)}]`,
  ).toBeNull();
  // ...and the card is still doing its job from wherever it moved to: the wave-9
  // composition is on screen, not merely out of the way.
  await expect(page.locator('.wy-wave-preview')).toBeVisible();
});
