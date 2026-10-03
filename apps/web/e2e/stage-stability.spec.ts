import { test, expect, type Page } from '@playwright/test';
import { createProjection } from '@wynding/render';
import { contains, intersect, projectedGrid, GRID, type Rect } from './layout-probe';
import { callWavePaced, titleAfterCall } from './paced-call';
import { COMPACT_QUERY } from '../src/layout';

// stage-stability.spec.ts — the playtest round's core invariant: THE BOARD NEVER MOVES.
//
// The wave preview first lived in the status row as a CONTENT-sized row item, so every preview
// change (a wave with more entries, a font-stack wrap, the end-of-run hide) resized the row and
// re-projected the whole board mid-run (cellPx 30 → 27 at a 1512×854 window when wave 9's
// four-entry preview arrived). The playtest round floated it over the Stage instead, and #101
// grew that float a placement chain (letterbox → border ring → a reserved 40dvh hud row) whose
// last link inflated a 1080×810 tablet's status row to ~284px.
//
// Since #181 (L1) the preview is a one-line STRIP with ONE home: the status row's chips list, in
// both layouts. It is back in the row, but the row SIZES it — its leftover width, one fixed line
// tall — and its content never sizes the row. These tests pin that decoupling, not the current
// wave data: the strip is grown and hidden by direct DOM probes, which is exactly the class of
// change that used to reflow the board and now cannot.

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

/** The strip's home by its PARENT's identity: `'chips'` is its one home (the status row's
 *  chips list); `'stage'` would be #101's float come back; anything else is a lost node. */
const previewHome = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const parent = document.querySelector('.wy-wave-preview')!.parentElement;
    if (parent?.matches('.wy-status > .wy-hud') === true) return 'chips';
    if (parent?.classList.contains('wy-stage') === true) return 'stage';
    return 'other';
  });

/** The strip's own box — read through `getBoundingClientRect`, so it is measured even while
 *  the strip is hidden (it hides by `visibility`, keeping its box). */
const stripBox = (page: Page): Promise<Rect> =>
  page.evaluate(() => {
    const r = document.querySelector('.wy-wave-preview')!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

/** What of the strip is actually ON SCREEN: its box clipped to the chips list's scrollport.
 *  Inside a scrollport an un-clipped layout rect means nothing — a scrolled-out entry reports
 *  coordinates anywhere, including over the grid, while painting nothing there. */
async function visibleStrip(page: Page): Promise<Rect | null> {
  const hud = (await page.locator('.wy-status > .wy-hud').boundingBox()) as Rect | null;
  return hud === null ? null : intersect(await stripBox(page), hud);
}

const isScrollForm = (page: Page): Promise<boolean> =>
  page.evaluate(() =>
    document.querySelector('.wy-wave-preview')!.classList.contains('wy-wave-preview--scroll'),
  );

/** Grow the strip to wave 9's four-entry shape (or longer) by DOM probe, so a pin needs no
 *  nine-wave walk. The rows are the pre-#101 verbose sentence ON PURPOSE: these probes bound how
 *  far content may grow before the board re-projects, so a longer-than-real row is the
 *  conservative direction, and swapping in the real (shorter) glance would weaken every pin in
 *  this file. It is a size fixture, not a rendering assertion — the rendered entries are pinned
 *  in `compact.spec.ts`, `smoke.spec.ts` and `hud-strip.spec.ts`. */
async function growPreview(page: Page, rows: number): Promise<void> {
  await page.evaluate((n) => {
    const list = document.querySelector('.wy-wave-preview-list')!;
    for (let i = 0; i < n; i++) {
      const li = document.createElement('li');
      li.textContent = '12 × Probe — ground, armor 0, leak cost 1, no immunities';
      list.append(li);
    }
  }, rows);
}

test('1512×854: preview growth and hiding cannot re-project the board, resize the row, or resize the strip', async ({
  page,
}) => {
  await gotoAt(page, STANDARD);

  const preview = page.locator('.wy-wave-preview');
  await expect(preview).toBeVisible();
  // The one home: a child of the status row's chips list, in flow — no float, no Stage.
  expect(await previewHome(page)).toBe('chips');
  expect(await preview.evaluate((el) => getComputedStyle(el).position)).toBe('static');

  const gridBefore = await projectedGrid(page);
  const statusBefore = await statusHeight(page);
  const stripBefore = await stripBox(page);

  // Grow the strip by three entries — wave 9 previews FOUR, so this is the real in-run COUNT
  // range, with longer-than-real rows (see `growPreview`).
  await growPreview(page, 3);
  expect(await projectedGrid(page), 'a four-entry preview re-projected the board').toEqual(
    gridBefore,
  );
  expect(await statusHeight(page), 'a four-entry preview resized the status row').toBe(
    statusBefore,
  );
  // The mechanism, measured: the strip's box comes from the row, never from its content.
  expect(await stripBox(page), 'a four-entry preview resized the strip itself').toEqual(
    stripBefore,
  );

  // The end-of-run hide — the same invariant from the other side. The strip hides by
  // `visibility`, so even its own box is held.
  await page.evaluate(() => {
    (document.querySelector('.wy-wave-preview') as HTMLElement).hidden = true;
  });
  expect(await projectedGrid(page), 'hiding the preview re-projected the board').toEqual(
    gridBefore,
  );
  expect(await statusHeight(page), 'hiding the preview resized the status row').toBe(statusBefore);
  expect(await stripBox(page), 'hiding the preview gave up its box').toEqual(stripBefore);
});

test('1512×854: no pixel of the strip is over the board — every point of it is status-row chrome', async ({
  page,
}) => {
  // The float this replaced sat OVER the board and was made click-through (`pointer-events:
  // none`) so it could intercept nothing. The strip needs no such trade: it is not over the
  // board at all. Asserted as geometry AND as the hit test a tap actually takes — centre and
  // four inset corners all land in the status row, never on the board.
  await gotoAt(page, STANDARD);
  // Visible first, or the probes below sample a zero rect and pass vacuously.
  await expect(page.locator('.wy-wave-preview')).toBeVisible();
  const strip = await stripBox(page);
  const board = (await page.locator('.wy-board').boundingBox()) as Rect;
  expect(intersect(strip, board), 'the strip overlaps the board').toBeNull();
  const hits = await page.evaluate(() => {
    const r = document.querySelector('.wy-wave-preview')!.getBoundingClientRect();
    const inset = 3;
    const points = [
      { x: r.x + r.width / 2, y: r.y + r.height / 2 },
      { x: r.x + inset, y: r.y + inset },
      { x: r.right - inset, y: r.y + inset },
      { x: r.x + inset, y: r.bottom - inset },
      { x: r.right - inset, y: r.bottom - inset },
    ];
    return points.map(({ x, y }) => {
      // The resolved node, never `el?.closest(...) !== null` — that is true when nothing is hit.
      const el = document.elementFromPoint(x, y);
      if (el === null) return 'nothing';
      if (el.closest('.wy-board') !== null) return 'board';
      return el.closest('.wy-status') !== null ? 'status' : 'other';
    });
  });
  expect(hits, 'a tap on the strip must land in the status row, never on the board').toEqual([
    'status',
    'status',
    'status',
    'status',
    'status',
  ]);
});

test('1512×854 at 200% text zoom: the strip keeps its one home — zoom never re-homes it, content never moves the board', async ({
  page,
}) => {
  // Codex #96 P1: an earlier draft re-homed the preview by ZOOM level, which put it in a
  // content-sized row for zoomed Standard users — the exact defect this file pins. The strip
  // has no other home to move to; zoom changes how the row lays out (legitimately — the strip
  // may take a line of its own at 200%), and from then on content changes nothing.
  await gotoAt(page, STANDARD);
  expect(await previewHome(page)).toBe('chips');
  await page.addStyleTag({ content: ':root { font-size: 200% }' });
  await page.waitForTimeout(200); // let the zoom's own (legitimate) reflow settle
  expect(await previewHome(page), 'zoom must not re-home the strip').toBe('chips');

  const gridBefore = await projectedGrid(page);
  const statusBefore = await statusHeight(page);
  const stripBefore = await stripBox(page);
  await growPreview(page, 3);
  await expect
    .poll(() => isScrollForm(page), {
      message: 'zoomed overflow is handled by the scroll form, in place',
    })
    .toBe(true);
  expect(await previewHome(page)).toBe('chips');
  expect(await projectedGrid(page), 'content re-projected the board at 200% zoom').toEqual(
    gridBefore,
  );
  expect(await statusHeight(page), 'content resized the status row at 200% zoom').toBe(
    statusBefore,
  );
  expect(await stripBox(page), 'content resized the strip at 200% zoom').toEqual(stripBefore);
});

test('360×640 (portrait Standard): the strip on its own line is content-invariant too', async ({
  page,
}) => {
  // A Standard shape too narrow to share the row: the strip's floor (`min(100%, 12rem)`) puts
  // it on a line of its own under the chips — decided by the VIEWPORT, never the wave. That
  // line is one fixed height, so the 1→4-entry swing and the end-of-run hide, the exact changes
  // that resized the row before the playtest round, cannot move the board from here either.
  await gotoAt(page, { width: 360, height: 640 });
  expect(await previewHome(page)).toBe('chips');
  const livesBottom = await page
    .locator('.wy-chip[data-wy-chip="lives"]')
    .evaluate((el) => el.getBoundingClientRect().bottom);
  expect(
    (await stripBox(page)).y,
    'the premise: the strip has a line of its own here',
  ).toBeGreaterThanOrEqual(livesBottom - 1);

  const gridBefore = await projectedGrid(page);
  const statusBefore = await statusHeight(page);
  const stripBefore = await stripBox(page);
  await growPreview(page, 3);
  expect(await projectedGrid(page), 'a four-entry preview re-projected the board').toEqual(
    gridBefore,
  );
  expect(await statusHeight(page), 'a four-entry preview resized the status row').toBe(
    statusBefore,
  );
  expect(await stripBox(page), 'a four-entry preview resized the strip').toEqual(stripBefore);
  await page.evaluate(() => {
    (document.querySelector('.wy-wave-preview') as HTMLElement).hidden = true;
  });
  expect(await projectedGrid(page), 'hiding the preview re-projected the board').toEqual(
    gridBefore,
  );
  expect(await statusHeight(page), 'hiding the preview resized the status row').toBe(statusBefore);
});

test('the countdown chip hiding once every wave has launched keeps its slot — the row, the strip and the board never move (#181 QC)', async ({
  page,
}) => {
  // The hide overlay.ts makes when no wave is left to count down — the chip's `hidden`
  // attribute — set in a real layout, at 200% text, where the countdown chip LEADS a hud of
  // several lines (#181 QC). `ui.css` holds its slot by visibility.
  let statusAtWidest = 0;
  for (const size of [
    { width: 1000, height: 720 },
    { width: 1512, height: 854 },
  ]) {
    await gotoAt(page, size);
    await page.addStyleTag({ content: ':root { font-size: 200% }' });
    await page.waitForTimeout(200); // the zoom's own (legitimate) reflow
    const at = `${size.width}×${size.height} at 200%`;
    const gridBefore = await projectedGrid(page);
    const statusBefore = await statusHeight(page);
    const stripBefore = await stripBox(page);
    await page.evaluate(() => {
      (document.querySelector('.wy-chip[data-wy-chip="wave"]') as HTMLElement).hidden = true;
    });
    await page.waitForTimeout(100); // two frames for any re-projection to land
    await expect(page.locator('.wy-chip[data-wy-chip="wave"] .wy-chip-glance')).toBeHidden();
    expect(await projectedGrid(page), `${at}: hiding the countdown re-projected the board`).toEqual(
      gridBefore,
    );
    expect(await statusHeight(page), `${at}: hiding the countdown resized the status row`).toBe(
      statusBefore,
    );
    expect(await stripBox(page), `${at}: hiding the countdown moved the strip`).toEqual(
      stripBefore,
    );
    statusAtWidest = statusBefore;
  }
  // POSITIVE CONTROL, at 1512×854 with the chip still hidden: were the slot given up, the row
  // WOULD re-wrap here (187.5px → 104px, measured), so the pins above measure a live rule.
  await page.addStyleTag({
    content: '.wy-shell .wy-hud > .wy-chip[hidden] { display: none !important; }',
  });
  await page.waitForTimeout(100);
  expect(
    await statusHeight(page),
    'the premise: without the held slot, the row re-wraps at this size',
  ).toBeLessThan(statusAtWidest);
});

test('1280×720 at 140% zoom, overflowing strip: handled IN PLACE — the strip scrolls sideways, the board never moves', async ({
  page,
}) => {
  // With content the strip's one line cannot hold — at any zoom level — the strip flips to its
  // scroll form (sideways: touch, wheel and keyboard, with a labelled tab stop) instead of
  // growing. 1280×720 rests CLEAN at 140% (the shipped one-entry wave fits its line), so the
  // return-to-resting half below is satisfiable; five injected rows then overflow it with
  // slack on any font stack.
  await gotoAt(page, { width: 1280, height: 720 });
  await page.addStyleTag({ content: ':root { font-size: 140% }' });
  await page.waitForTimeout(200); // the zoom's own (user-initiated, legitimate) reflow
  await expect
    .poll(() => isScrollForm(page), { message: 'the premise: it rests clean' })
    .toBe(false);
  const gridBefore = await projectedGrid(page);
  const statusBefore = await statusHeight(page);
  const stripBefore = await stripBox(page);

  await growPreview(page, 5);
  await expect
    .poll(() => isScrollForm(page), {
      message: 'overflowing content must flip the strip to its scroll form',
    })
    .toBe(true);
  // The node never moved and the board never moved — the invariant, under zoom.
  expect(await previewHome(page)).toBe('chips');
  expect(await projectedGrid(page), 'the scroll form re-projected the board').toEqual(gridBefore);
  expect(await statusHeight(page), 'the scroll form resized the status row').toBe(statusBefore);
  expect(await stripBox(page), 'the scroll form resized the strip').toEqual(stripBefore);
  // And every entry is REACHABLE (WCAG 1.4.4): the strip scrolls to its end and is a tab stop.
  const reach = await page.evaluate(() => {
    const el = document.querySelector('.wy-wave-preview') as HTMLElement;
    const scrollable = el.scrollWidth > el.clientWidth;
    el.scrollLeft = el.scrollWidth;
    return {
      scrollable,
      atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
      tabIndex: el.tabIndex,
      role: el.getAttribute('role'),
      label: el.getAttribute('aria-label'),
    };
  });
  expect(reach.scrollable, 'the injected composition exceeds the line (the premise)').toBe(true);
  expect(reach.atEnd, 'the scroll form reaches the last entry').toBe(true);
  expect(reach.tabIndex, 'keyboard reach: the scroll form is a tab stop').toBe(0);
  // The `.wy-hud` scrollport discipline: a focusable scrollable region is named, never a
  // bare div (axe's scrollable-region-focusable checks only the focusability half).
  expect(reach.role, 'the scroll form carries a role').toBe('group');
  expect(reach.label, 'the scroll form carries an accessible name').toBeTruthy();
  // The pointer half: the strip takes the pointer (wheel and drag scrolling need it) — which
  // costs the board nothing, because no pixel of it is over the board, in either form.
  const hitTarget = (): Promise<string> =>
    page.evaluate(() => {
      const r = document.querySelector('.wy-wave-preview')!.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (el === null) return 'nothing';
      if (el.closest('.wy-wave-preview') !== null) return 'preview';
      return el.closest('.wy-board') !== null ? 'board' : 'other';
    });
  expect(await hitTarget(), 'the scroll form takes the pointer (it must be scrollable)').toBe(
    'preview',
  );
  const board = (await page.locator('.wy-board').boundingBox()) as Rect;
  expect(intersect(await stripBox(page), board), 'the strip overlaps the board').toBeNull();

  // …and the moment content fits again, the scroll form — and its TAB STOP — go: a stop that
  // scrolls nothing would be a phantom in the tab order of a run's whole remaining length.
  await page.evaluate(() => {
    for (const li of [...document.querySelectorAll('.wy-wave-preview-list li')].slice(1))
      li.remove();
  });
  await expect
    .poll(() => isScrollForm(page), {
      message: 'a fitting composition must return the strip to its resting form',
    })
    .toBe(false);
  const rest = await page.evaluate(() => {
    const el = document.querySelector('.wy-wave-preview') as HTMLElement;
    return { tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role') };
  });
  expect(rest, 'the resting strip is no tab stop and no group').toEqual({
    tabindex: null,
    role: null,
  });
  expect(await stripBox(page), 'returning to rest resized the strip').toEqual(stripBefore);
});

test('1280×720: a captured board release over the strip cancels — the strip is input chrome, no tower placed behind it', async ({
  page,
}) => {
  // Codex #96 P2: pointer capture delivers a board-origin release wherever it lands, so a
  // release over the preview must cancel exactly like a release over the Dock — before
  // `input.ts` classified the preview as chrome, the release fell through and PLACED a tower
  // on the cell behind it. The drag here is real (mouse down on the plain board, release over
  // the strip), so the whole chain is exercised: capture, the live `document.elementFromPoint`,
  // and the chrome selector against the real node — which, since #181, classifies the strip
  // through its ONE home, `.wy-status`. The classification itself is unit-pinned per release
  // path in input.test.ts; this is the real-pipeline witness.
  //
  // THE STRIP IS DRIVEN OVER THE GRID, as #101's version of this test drove its card. The
  // shipped strip sits in the status row, so at its real position a release over it could not
  // place a tower anyway — every assertion below would pass for a reason that has nothing to do
  // with `input.ts`. Positioning the real node over a placeable cell (it stays a `.wy-status`
  // descendant) keeps the CHROME CLASSIFICATION the thing under test. That #181 removed the
  // geometry this defect needed is a good outcome; it is not a reason to stop pinning the
  // contract. (The scroll form is no premise any more: the strip takes the pointer in every
  // form, so this covers its resting form too.)
  await gotoAt(page, { width: 1280, height: 720 });
  await expect(page.locator('.wy-wave-preview')).toBeVisible();
  const grid = await projectedGrid(page);
  const stripW = 8 * grid.cellPx;
  const stripH = 2 * grid.cellPx;
  // Over the grid's left half, from the third column in — clear of the press point (right of
  // centre) and of the Dock (bottom-left).
  const left = grid.x + 2 * grid.cellPx;
  const top = grid.y + grid.height * 0.35;
  await page.addStyleTag({
    content:
      `.wy-wave-preview { position: fixed !important; left: ${left}px !important; ` +
      `top: ${top}px !important; width: ${stripW}px !important; min-width: 0 !important; ` +
      `max-width: none !important; height: ${stripH}px !important; z-index: 10 !important; }`,
  });

  await page.keyboard.press('1');
  const armedCard = page.locator('.wy-card[aria-pressed="true"]');
  await expect(armedCard).toHaveCount(1);
  const sellButton = page.locator('.wy-panel').getByRole('button', { name: /^Sell/ });

  const down = { x: grid.x + grid.width * 0.75, y: grid.y + grid.height / 2 };
  const release = { x: left + stripW / 2, y: top + stripH / 2 };
  const targetAt = (p: { x: number; y: number }): Promise<string> =>
    page.evaluate(({ x, y }) => {
      // Explicit null check so a bad point FAILS — `el?.closest(...) !== null` would pass
      // vacuously (undefined !== null) exactly when the point misses everything.
      const el = document.elementFromPoint(x, y);
      if (el === null) return 'nothing';
      if (el.closest('.wy-wave-preview') !== null) {
        return el.closest('.wy-status') !== null ? 'strip-in-status' : 'strip-elsewhere';
      }
      return el.closest('.wy-board') !== null ? 'board' : 'other';
    }, p);
  expect(await targetAt(down), 'the press must start on the plain board').toBe('board');
  expect(
    await targetAt(release),
    'the release lands on the strip, still inside its status-row home',
  ).toBe('strip-in-status');
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
  // to a cell a placement genuinely succeeds on. Make the strip hit-test-transparent and click
  // the same point — the tower now places and its Panel opens. Only the chrome classification
  // stopped the drag above, not geometry or cell validity.
  await page.evaluate(() => {
    (document.querySelector('.wy-wave-preview') as HTMLElement).style.pointerEvents = 'none';
  });
  await page.mouse.click(release.x, release.y);
  await expect(sellButton).toBeVisible();
});

test('the strip keeps its ONE home across the layout fork — the same node, the chips list, both layouts', async ({
  page,
}) => {
  // #101's preview was RE-HOMED by a matchMedia listener as the layout crossed its fork; that
  // listener is gone. The strip is built once in the chips list and never moves: the fork
  // only changes how `ui.css` draws it (a one-line strip on Standard, a block in the Compact
  // column). The node is TAGGED, so identity is asserted, not just a count of one.
  await gotoAt(page, STANDARD);
  const compact = (): Promise<boolean> =>
    page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY);
  expect(await compact()).toBe(false);
  expect(await previewHome(page)).toBe('chips');
  await page.evaluate(() => {
    document.querySelector('.wy-wave-preview')!.setAttribute('data-probe-identity', 'one');
  });

  await page.setViewportSize(PHONE);
  await expect.poll(compact, { message: 'the fork must actually cross' }).toBe(true);
  expect(await previewHome(page)).toBe('chips');
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.wy-wave-preview')!).position,
    ),
  ).toBe('static'); // in the chips-column flow
  expect(
    await page.evaluate(() => document.querySelectorAll('.wy-wave-preview').length),
    'exactly one preview node in the document',
  ).toBe(1);
  await expect(page.locator('.wy-wave-preview[data-probe-identity="one"]')).toHaveCount(1);
  await expect(page.locator('.wy-wave-preview')).toBeVisible();

  await page.setViewportSize(STANDARD);
  await expect.poll(compact).toBe(false);
  expect(await previewHome(page)).toBe('chips');
  await expect(page.locator('.wy-wave-preview[data-probe-identity="one"]')).toHaveCount(1);
});

// --- The strip's line, per Standard viewport (#181, superseding #101's placement table) -----
//
// #101 pinned, per viewport, which HOME its floating card landed in and that it occluded no
// structurally buildable cell. The strip has one home and is never over the board, so what is
// pinned now is what it COSTS the board: whether it SHARES the style frame's one status line
// with the home link and the chips, or takes a LINE OF ITS OWN under them.

/** Every Standard viewport this suite pins, plus the one #101 was reported at, EACH WITH THE
 *  LINE its strip must take at 100% and 200% zoom.
 *
 *  THE `line` COLUMN IS THE LIVENESS HALF OF THIS GATE, for the reason #101's `home` column
 *  was: the occlusion half below cannot fail in the direction that matters. A strip pushed onto
 *  a line of its own covers nothing — and still takes a line's height from the board. These
 *  values ARE the strip table in `docs/accessibility-checklist.md`; a change to either has to
 *  move the other.
 *
 *  THE `visible` COLUMN is what of the strip is ON SCREEN at rest — `whole`, `partial`, or
 *  `none` — because a line tells you where the strip sits, not whether anyone can see it: at
 *  heavy text the capped hud (ADR 0003's overflow remedy) can leave a strip on its own line
 *  wholly scrolled out of view at rest, still costing the board that line (#181 QC). These are
 *  the strip table's residuals in `docs/accessibility-checklist.md`; and because the
 *  occlusion half below can only check what is shown, a strip expected on screen that is not
 *  FAILS here rather than skipping it.
 *
 *  Every row is EXACT on both font stacks, measured on macOS and with CI's Linux metrics
 *  (DejaVu Sans): the nearest call, 1000×720 at 100%, leaves the strip ~360–380px against
 *  its 192px floor (`ui.css`'s 12rem). #101's table needed an `'either'` where the two
 *  stacks disagreed (1280×900 at 200%); this one has no row within a font stack of its
 *  floor, so it pins none. */
type StripVisible = 'whole' | 'partial' | 'none';
const PINNED_STANDARD = [
  // the viewport #101 was reported at
  {
    width: 1512,
    height: 854,
    line: { 100: 'shared', 200: 'own' },
    visible: { 100: 'whole', 200: 'whole' },
  },
  {
    width: 1440,
    height: 900,
    line: { 100: 'shared', 200: 'own' },
    visible: { 100: 'whole', 200: 'whole' },
  },
  {
    width: 1366,
    height: 768,
    line: { 100: 'shared', 200: 'own' },
    visible: { 100: 'whole', 200: 'whole' },
  },
  // the hidpi projects' fixed viewport
  {
    width: 1280,
    height: 900,
    line: { 100: 'shared', 200: 'own' },
    visible: { 100: 'whole', 200: 'whole' },
  },
  // Playwright's Desktop Chrome default
  {
    width: 1280,
    height: 720,
    line: { 100: 'shared', 200: 'own' },
    visible: { 100: 'whole', 200: 'whole' },
  },
  // the narrowest row in this table the strip shares, with the widest margin to spare
  {
    width: 1000,
    height: 720,
    line: { 100: 'shared', 200: 'own' },
    visible: { 100: 'whole', 200: 'whole' },
  },
  // coarse-pointer landscape tablet — Standard. At 200% the strip's line is past the capped
  // hud at rest (the hud scrolls to it).
  {
    width: 640,
    height: 560,
    line: { 100: 'own', 200: 'own' },
    visible: { 100: 'whole', 200: 'none' },
  },
  // portrait phone — Standard by height. At 200% likewise.
  {
    width: 360,
    height: 640,
    line: { 100: 'own', 200: 'own' },
    visible: { 100: 'whole', 200: 'none' },
  },
] as const satisfies readonly {
  readonly width: number;
  readonly height: number;
  readonly line: {
    readonly 100: 'shared' | 'own';
    readonly 200: 'shared' | 'own';
  };
  readonly visible: {
    readonly 100: StripVisible;
    readonly 200: StripVisible;
  };
}[];

/** The style frame's one status line at 100% text (`home.spec.ts`'s ceiling). */
const ONE_LINE_MAX_PX = 56;

for (const size of PINNED_STANDARD) {
  for (const zoom of [100, 200] as const) {
    const expectedLine = size.line[zoom];
    test(`${size.width}×${size.height} at ${zoom}% zoom: the strip takes its ${expectedLine} line, in its one home, and covers no cell of the board (#181)`, async ({
      page,
    }) => {
      await gotoAt(page, size);
      if (zoom !== 100) {
        await page.addStyleTag({ content: `:root { font-size: ${zoom}% }` });
        await page.waitForTimeout(200); // the zoom's own (legitimate) reflow
      }
      // Wave 9's four-entry shape FIRST: the rule has to hold at the strip's largest real
      // content, and the line it takes must not depend on it.
      await growPreview(page, 3);
      await page.waitForTimeout(100);
      expect(await previewHome(page), 'the strip must be in its one home').toBe('chips');

      // LIVENESS: which line, against the measured table.
      const lines = await page.evaluate(() => {
        const strip = document.querySelector('.wy-wave-preview')!.getBoundingClientRect();
        const lives = document
          .querySelector('.wy-chip[data-wy-chip="lives"]')!
          .getBoundingClientRect();
        const middle = strip.top + strip.height / 2;
        return {
          shared: middle > lives.top && middle < lives.bottom,
          own: strip.top >= lives.bottom - 1,
        };
      });
      const line = lines.shared ? 'shared' : lines.own ? 'own' : 'neither';
      expect(
        line,
        expectedLine === 'shared'
          ? 'the strip left the status line here, costing the board a line of height — ' +
              'if that is now correct, re-measure and move the strip table with it'
          : 'the strip shares a line the measured table says cannot hold it',
      ).toBe(expectedLine);
      const status = await statusHeight(page);
      if (line === 'shared' && zoom === 100) {
        expect(status, 'one shared line is the frame’s one status row').toBeLessThanOrEqual(
          ONE_LINE_MAX_PX,
        );
      }
      // Either line, the row stays inside the bound ADR 0003 commits it to.
      expect(status, 'the status row exceeds its 40dvh bound').toBeLessThanOrEqual(
        Math.ceil(size.height * 0.4) + 1,
      );

      // VISIBILITY at rest, against the measured table: a strip the table expects on screen
      // that is not (scrolled out of the capped hud) fails here.
      const strip = await stripBox(page);
      const shown = await visibleStrip(page);
      const visible: StripVisible =
        shown === null || shown.width <= 0 || shown.height <= 0
          ? 'none'
          : shown.height >= strip.height - 1
            ? 'whole'
            : 'partial';
      expect(
        visible,
        `what of the strip is on screen at rest (${shown === null ? 0 : shown.height.toFixed(1)} of ` +
          `${strip.height.toFixed(1)}px) — if that is now correct, re-measure and move the strip ` +
          'table with it',
      ).toBe(size.visible[zoom]);

      // OCCLUSION: what of the strip is on screen covers no cell of the board — the whole
      // projected grid, a stricter claim than #101's buildable-cells rule. Never skipped: a
      // strip expected on screen has been asserted on screen above, and one expected scrolled
      // out has nothing on screen to cover anything.
      const grid = await projectedGrid(page);
      if (visible === 'none') {
        expect(shown, 'nothing of the strip is on screen').toBeNull();
      } else {
        expect(intersect(shown!, grid), 'the strip covers part of the board').toBeNull();
      }
    });
  }
}

test('1000×720, walking to wave 9: the board never re-projects — the strip is content-invariant on its WIDTH axis too (#101, Codex P2)', async ({
  page,
}) => {
  // The width axis is the one #101's height pin missed: `.wy-status` is a wrapping flex row,
  // and a preview sized by its own max-content WIDTH grew until the row wrapped — measured
  // `.wy-status` 248 → 288px and the board 19 → 18 cellPx as wave 9 arrived. The strip takes
  // the row's LEFTOVER width (`flex: 1 1 0`, inline-size containment), so its content is in no
  // intrinsic measure the row's line breaks depend on.
  //
  // Deliberately asserted WITHOUT a precondition on the line the strip takes. The contract is
  // "wave content never moves the board", which must hold on either line — and pinning it here
  // would make this test hostage to the strip floor's boundary behaviour on a given font stack.
  test.setTimeout(150_000);
  await gotoAt(page, { width: 1000, height: 720 });
  await expect(page.locator('.wy-wave-preview')).toBeVisible();

  const gridBefore = await projectedGrid(page);
  const statusBefore = await statusHeight(page);

  // The real walk, not an injected fixture: wave 9 is the arc's densest preview (four
  // entries), so this measures the width the shipped content actually demands.
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

  // ...and then the CONSERVATIVE bound, which is what turns this red for a content-sized strip.
  // The shipped glance (icon and count) is narrow, so the walk above would pass even if the
  // strip measured its own content — that is luck, not a guarantee: a longer locale, a wider
  // entry, a future fifth creep restores the wrap. These over-long rows are the same fixture
  // every other pin in this file uses, for exactly that reason.
  await growPreview(page, 3);
  await page.waitForTimeout(200);
  expect(await statusHeight(page), 'over-long rows wrapped the status row').toBe(statusBefore);
  expect(await projectedGrid(page), 'over-long rows re-projected the board').toEqual(gridBefore);
});

test('1512×854, wave 9 pending: a tower built in the corner the preview used to own is FULLY visible (#101)', async ({
  page,
}) => {
  // The #101 regression case, at the reported viewport, in the reported situation. The
  // owner's words were "I rarely build in that corner, though — but I could! Except I can't
  // because it's in the way" — so this builds there, walks the run to wave 9 (the arc's
  // densest preview, four entries), and proves the strip and the tower do not share a pixel —
  // nor the strip and ANY cell of the board, since #181 put it in the status row for good.
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

  // The tower's own 2×2 footprint in page coordinates, and the strip's box. Not one pixel
  // of overlap — the whole complaint was that the corner was unusable because the card was
  // over it, and "mostly clear" is what the retired area budget already allowed.
  const grid = await projectedGrid(page);
  const footprint: Rect = {
    x: grid.x + CORNER.col * grid.cellPx,
    y: grid.y + CORNER.row * grid.cellPx,
    width: 2 * grid.cellPx,
    height: 2 * grid.cellPx,
  };
  const strip = await stripBox(page);
  expect(
    intersect(strip, footprint),
    `the wave-9 strip at [${Math.round(strip.x)},${Math.round(strip.y)} ${Math.round(
      strip.width,
    )}×${Math.round(strip.height)}] covers the corner tower at [${Math.round(
      footprint.x,
    )},${Math.round(footprint.y)}]`,
  ).toBeNull();
  expect(intersect(strip, grid), 'the wave-9 strip covers part of the board').toBeNull();
  // ...and the strip is still doing its job: the whole wave-9 composition is on screen, every
  // entry inside the strip's own box — not merely out of the way.
  await expect(page.locator('.wy-wave-preview')).toBeVisible();
  for (const entry of await page.locator('.wy-wave-preview li').all()) {
    const e = (await entry.boundingBox()) as Rect;
    expect(contains(strip, e), 'a wave-9 entry is cut off by the strip').toBe(true);
  }
});
