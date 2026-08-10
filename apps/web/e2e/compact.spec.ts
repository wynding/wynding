import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  assertDeclaredRegions,
  assertRegionRelations,
  intersect,
  projectedGrid,
  regionRect,
  visibleChipAccessibleText,
  type Rect,
} from './layout-probe';
import { firePrompt, installPromptFactory, stubIosPlatform } from './install-stub';
import { stubFullscreen } from './fullscreen-stub';
import { COMPACT_QUERY } from '../src/layout';

/** The banner audience requires a coarse pointer, which only the `chromium-touch` device
 *  profile provides — the four banner specs below skip under the fine-pointer project. One
 *  helper so the four byte-identical guards cannot drift apart. */
function skipUnlessCoarsePointer(testInfo: import('@playwright/test').TestInfo): void {
  test.skip(
    testInfo.project.name !== 'chromium-touch',
    'the banner audience requires a coarse pointer — only the touch profile has one',
  );
}

// compact.spec.ts — the standing gate for Story 11's two-layouts contract. It runs under
// BOTH the default `chromium` project and `chromium-touch` (playwright.config.ts extends
// that project's `testMatch`; `chromium.testIgnore` is untouched, so it runs there by
// default): the Compact layout is triggered by viewport HEIGHT alone, so it must hold
// identically for a coarse-pointer phone and a short desktop window. Assertions branch on
// `testInfo.project.name` only where the POINTER genuinely matters.
//
// Every size gate is projection-based (`layout-probe.ts`) — the playable grid's own rect,
// never an element box — with the numeric floors pinned by PLAN.md P1.

const PHONE = { width: 658, height: 320 }; // Galaxy S9+ landscape — the smallest supported
const NARROW = { width: 568, height: 320 }; // iPhone-SE-class narrow floor
const TALL = { width: 1280, height: 720 }; // Standard
const SHORT_DESKTOP = { width: 900, height: 480 }; // Compact by HEIGHT, with a fine pointer
const TABLET = { width: 640, height: 560 }; // coarse-pointer LANDSCAPE tablet — Standard, banner-eligible

/** Board-floor gate, banner absent (PLAN.md P1): the projected grid keeps ≥ 85% of the
 *  viewport's height. Derivation: at 658×320 the vw-capped column (~64px) and rail (144px)
 *  leave a 450px-wide stage, so the 24-row grid is HEIGHT-limited at cellPx 13 → 312px of
 *  320 (97.5%). 85% is the floor with margin; a regression that re-introduced a full-width
 *  status row (~15% of the screen) would land at ~80% and fail. */
const GRID_HEIGHT_FRACTION_MIN = 0.85;

/** The board is unplayable below roughly a fingertip per cell; 12 CSS px is the pinned
 *  floor for the supported landscape sizes. */
const CELL_PX_MIN = 12;

/** Narrow devices are WIDTH-limited, not height-limited (PLAN.md risks): vertical chip
 *  scrolling does nothing for width, so 568×320 gets its own, lower floor. */
const CELL_PX_MIN_NARROW = 10;

/** Board-floor gate with the install banner VISIBLE (PLAN.md P3). The banner is a reserved
 *  row carrying ≥44px controls, so it costs roughly 52px of a 320px-tall viewport — 85% is
 *  arithmetically unreachable with it up, and quietly relaxing the banner-absent gate to
 *  suit would stop it catching a full-width status row. Both are asserted, separately. */
const GRID_HEIGHT_FRACTION_MIN_WITH_BANNER = 0.7;

/** Cell floor with the banner VISIBLE. Deliberately one px under `CELL_PX_MIN`, and asserted
 *  rather than omitted: the banner's ≥44px control row costs ~56px of a 320px-tall viewport,
 *  so the 24-row grid lands at cellPx 11 there — 12 would need the whole banner to fit in
 *  32px, which no ≥44px touch target can. The relaxation is bounded to the PRE-START state
 *  the banner lives in (nothing is being placed or fought yet) and the player can dismiss it
 *  to get the full 12px board back — which the test below also asserts. */
const CELL_PX_MIN_WITH_BANNER = 11;

/** Cell floor with the banner visible AND 200% text zoom — the two board-squeezing states
 *  stacked. `.wy-banner` is capped at `25dvh` with internal scrolling (ui.css), so its cost
 *  stays 80px of the 320px-tall viewport instead of the ~185px an unbounded rem-sized banner
 *  would take, which holds the grid at cellPx 10 — the same floor the width-limited narrow
 *  viewport gets. Drop the cap and this lands at 5. */
const CELL_PX_MIN_WITH_BANNER_ZOOMED = 10;

/** The STANDARD twin of the bound above. A coarse-pointer LANDSCAPE tablet is taller than
 *  500px, so it gets Standard WITH the banner — and there the status row and the banner are
 *  capped INDEPENDENTLY (40dvh + 25dvh), so at 200% zoom they both hit their caps and jointly
 *  take ~62% of a 560px-tall viewport, leaving the board's zero-minimum `1fr` row at cellPx 8.
 *  ui.css re-budgets the two capped boxes to 25dvh + 15dvh while the banner shows; the rest of
 *  the measured total is `.wy-status`'s own chrome OUTSIDE `.wy-hud` (the wordmark line, the
 *  wrapped row gap and the vertical padding — ~89px at 200% zoom, fixed rather than dvh-scaled),
 *  which is why the asserted ceiling is 50% and not a flat 40dvh. */
const STANDARD_CHROME_FRACTION_MAX_WITH_BANNER = 0.5;

async function gotoAt(
  page: import('@playwright/test').Page,
  size: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(size);
  // Some of these tests press Start under the touch project, where the fullscreen gate is
  // live; a real request would resize the viewport every projection floor here is measured
  // against (PLAN.md P4).
  await stubFullscreen(page);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
}

test.describe('Compact layout (PLAN.md P1 / two-layouts contract)', () => {
  test('658×320: a status COLUMN, no top row, four glanceable chips, and a board floor', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);

    // The Compact trigger is height-keyed, so it must have engaged regardless of pointer.
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);

    // No top row: the status header IS the left column — full height, narrow, flush left,
    // with the Stage starting at the very top of the viewport.
    const status = (await regionRect(page, 'status')) as Rect;
    const stage = (await regionRect(page, 'stage')) as Rect;
    expect(status.y).toBeLessThanOrEqual(1);
    expect(status.height).toBeGreaterThanOrEqual(PHONE.height * 0.9);
    expect(status.width).toBeLessThanOrEqual(96); // min(4rem, 10vw) → ~64px here
    expect(stage.y).toBeLessThanOrEqual(1);

    // The wordmark yields its space to the chips and controls; the hotkey badge is
    // COMPACT-gated (not pointer-gated — decision 1), so it is hidden here even under a
    // fine pointer.
    await expect(page.locator('.wy-wordmark')).toBeHidden();
    // Every Card's hotkey badge (M2-S3: card-hotkey-hidden ×2, widened to ×3 at M2-S4a's
    // third Card, ×4 at M2-S5a's fourth, ×5 at M2-S6's fifth, ×6 at M2-S7's sixth, ×7 at
    // M2-S8's seventh, ×8 at M2-S9's eighth, ×9 at M2-S10's ninth) — count pinned
    // first, so a renamed/removed badge class cannot pass this loop vacuously (QC round 1).
    await expect(page.locator('.wy-card-hotkey')).toHaveCount(9);
    for (const badge of await page.locator('.wy-card-hotkey').all())
      await expect(badge).toBeHidden();

    // All FIVE chip slots are visible pre-start now (M2-S2, PLAN.md P3 step 15's Start
    // decouple): the wave chip is countdown-only and the sim's real `countdownRemaining`
    // is meaningful before Start is ever pressed, not just after. Each chip reads to
    // assistive tech as its COMPLETE localized ICU message — the aria-hidden glance form
    // ("♥ 10") is invisible to AT.
    await expect.poll(async () => (await visibleChipAccessibleText(page)).length).toBe(5);
    const chips = await visibleChipAccessibleText(page);
    expect(chips[0]).toMatch(/^Lives: \d+$/);
    expect(chips[1]).toMatch(/^Bounty: \d+$/);
    expect(chips[2]).toMatch(/^Score: \d+$/);
    expect(chips[3]).toMatch(/^Wave in \d+s$/);
    expect(chips[4]).toMatch(/^Stars: \d+ of 3$/);
    // ...and the glance forms ARE what is painted on screen.
    await expect(page.locator('.wy-chip[data-wy-chip="lives"] .wy-chip-glance')).toHaveText(/^♥/);

    // Board floor, banner absent.
    const grid = await projectedGrid(page);
    expect(grid.cellPx).toBeGreaterThanOrEqual(CELL_PX_MIN);
    expect(grid.height / PHONE.height).toBeGreaterThanOrEqual(GRID_HEIGHT_FRACTION_MIN);

    await assertDeclaredRegions(page);
    await assertRegionRelations(page, 'compact');

    // The chip count stays five across Start (M2-S2) — only the wave chip's own value
    // (and the wave preview surface below it) changes as waves launch.
    await page.getByRole('button', { name: 'Start' }).click();
    await expect.poll(async () => (await visibleChipAccessibleText(page)).length).toBe(5);
  });

  // PLAN.md P3 step 19: the wave preview is its OWN visible surface in BOTH layouts (never
  // chip-hosted — the Compact chip's full text is screen-reader-only, so entries stuffed
  // into it would be invisible to sighted Compact users) — and if it scrolls, it is
  // KEYBOARD-reachable, not a mouse-only overflow container. It is hosted inside the same
  // `.wy-hud` scrollport the chips already use (contract §1), so it inherits that
  // scrollport's keyboard reachability by construction; this test proves that end to end.
  test('658×320: the wave preview is its own visible, sighted-readable surface, and stays keyboard-reachable when the chips scrollport overflows at 200% zoom', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    const preview = page.locator('.wy-wave-preview');
    await expect(preview).toBeVisible(); // visible pre-start too (M2-S2 decouple)
    await expect(preview.locator('.wy-wave-preview-title')).toHaveText('Wave 1 of 10'); // M2-S11: the ten-wave arc
    const entries = preview.locator('li');
    await expect(entries).toHaveCount(1); // the shipped bundle's single creep kind
    await expect(entries.first()).toHaveText(
      '10 × Creep — ground, armor 0, leak cost 1, no immunities',
    );

    // Force the SAME overflow smoke.spec's 200%-zoom gate proves for the chips, and confirm
    // the preview is still present and KEYBOARD-OPERABLE inside that same scrollport — never
    // a mouse-only overflow container. Same two-part proof smoke.spec's chips-scrollport gate
    // uses: an arrow key actually moves `scrollTop` (keyboard-operable, not merely present in
    // the DOM — `isVisible()`/axe cannot distinguish an off-screen row from a reachable one),
    // and the target CAN be scrolled fully into view within that same scrollport.
    await page.addStyleTag({ content: ':root { font-size: 200% }' });
    const hud = page.locator('.wy-hud');
    expect(await hud.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(preview).toBeVisible();
    await hud.focus();
    await expect(hud).toBeFocused();
    expect(await hud.evaluate((el) => el.scrollTop)).toBe(0);
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(async () => hud.evaluate((el) => el.scrollTop), {
        message: 'the chips scrollport should scroll on an arrow key',
      })
      .toBeGreaterThan(0);
    await entries.first().scrollIntoViewIfNeeded();
    await expect(entries.first()).toBeInViewport();
  });

  // M2-S11 P1b: the arc's densest tick (wave index 8, "Wave 9 of 10") carries FOUR
  // concurrent creep streams — the preview's row count grows from a maximum of 2 rows
  // (M2-S6's `resolute`+`fast`) to 4. `home.spec.ts`'s `STANDARD_ROW_MAX_PX` flag covers
  // the HORIZONTAL axis (a wider per-entry string); this is the first test of the
  // VERTICAL axis. The preview already lives inside `.wy-hud`'s bounded, keyboard-scrollable
  // box (contract §1) — the mechanism the test above proves generalizes to overflow content
  // — so this measures whether that SAME mechanism holds up honestly with 4× the rows: no
  // clipping, every row reachable by keyboard, and axe-clean, at the real compiled
  // wave-index-8 composition rather than a synthetic stand-in.
  test("658×320: the four-row wave-9 preview (M2-S11, the arc's densest tick) fits accessibly inside the bounded scrollport", async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    const preview = page.locator('.wy-wave-preview');
    const previewTitle = preview.locator('.wy-wave-preview-title');
    const entries = preview.locator('li');

    // Early-call through waves 1..8 to bring wave 9 (index 8, the four-stream wave) into
    // the preview slot — the same gate-each-press-on-aria pattern smoke.spec.ts /
    // start-gate.spec.ts use, so a same-tick-deduped press cannot silently short the loop.
    await page.getByRole('button', { name: 'Start' }).click();
    const callWave = page.getByRole('button', { name: 'Call wave' });
    for (let waveNumber = 1; waveNumber <= 8; waveNumber++) {
      await expect(previewTitle).toHaveText(`Wave ${waveNumber} of 10`);
      await expect(callWave).toHaveAttribute('aria-disabled', 'false');
      await callWave.click();
    }
    await expect(previewTitle).toHaveText('Wave 9 of 10');
    // FREEZE the race, don't just guard it: wave 9's own 300-tick countdown keeps
    // running under the long assertion tail below (axe + geometry + keyboard-scroll —
    // observed flaking once the tail crossed the auto-launch boundary on a loaded
    // machine). Pausing pins the preview on wave 9 for the whole tail; the preview
    // reflects Pending state under pause by design, so nothing measured changes.
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(entries).toHaveCount(4);
    await expect(entries).toHaveText([
      '10 × Swarm Creep — ground, armor 0, leak cost 1, no immunities',
      '6 × Fast Creep — ground, armor 0, leak cost 1, no immunities',
      '4 × Armored Creep — ground, armor 6, leak cost 1, no immunities',
      '4 × Flying Creep — air, armor 0, leak cost 1, no immunities',
    ]);

    // axe audit with all 4 rows showing — the standard bar every other HUD content is
    // held to (PLAN.md P3 step 19).
    const audit = await new AxeBuilder({ page }).include('#app').analyze();
    expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);

    // GUARD: wave 9's own 300-tick countdown keeps running in real time under this
    // tail (~15 s at 1×) — if it auto-launches, the preview flips to wave 10's two-row
    // composition and the 4 materialized entry locators go stale (boundingBox() null).
    // Re-asserting the title here turns that race into a NAMED failure instead of a
    // mystery null dereference on a slow runner.
    await expect(previewTitle).toHaveText('Wave 9 of 10');

    // No clipping: the preview's rendered box, and every one of its 4 rows, stays within
    // the Compact column's own width — never spilling past it or off the viewport (a
    // scrollport clips its OVERFLOW axis only; the cross axis must never overflow at all).
    const status = (await regionRect(page, 'status')) as Rect;
    const previewBox = (await preview.boundingBox())!;
    expect(
      previewBox.x + previewBox.width,
      `preview right edge ${previewBox.x + previewBox.width}px exceeds the status column's own right edge ${status.x + status.width}px`,
    ).toBeLessThanOrEqual(status.x + status.width + 1);
    for (const entry of await entries.all()) {
      const box = (await entry.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(status.x + status.width + 1);
    }

    // Text stays at the SAME readable size the 1-row preview uses — 4 rows never triggers
    // a "shrink to fit" degradation. `.wy-hud`'s own base size (ui.css) is the source of
    // truth; the preview carries no font-size rule of its own.
    const previewFontSize = await preview.evaluate((el) => getComputedStyle(el).fontSize);
    const hudFontSize = await page
      .locator('.wy-hud')
      .evaluate((el) => getComputedStyle(el).fontSize);
    expect(previewFontSize).toBe(hudFontSize);

    // Every row is reachable via the SAME keyboard scrollport path the test above proves
    // for the 200%-zoom 1-row case — proven here at 100% zoom with all 4 real rows, the
    // scrollport's own worst case for this wave.
    const hud = page.locator('.wy-hud');
    await hud.focus();
    await expect(hud).toBeFocused();
    // The SAME two-part keyboard proof the 200%-zoom test above and smoke.spec's
    // chips-scrollport gate use (PR #93 CodeRabbit round 1 — `scrollIntoViewIfNeeded`
    // alone proves nothing about the keyboard path): (a) a real arrow key moves the
    // focused scrollport's `scrollTop` with all four rows present — keyboard-operable,
    // not merely present in the DOM; (b) every row can then be scrolled fully into
    // view within that same scrollport.
    const scrollTopBefore = await hud.evaluate((el) => el.scrollTop);
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(async () => hud.evaluate((el) => el.scrollTop), {
        message: 'the hud scrollport should scroll on an arrow key with 4 preview rows',
      })
      .toBeGreaterThan(scrollTopBefore);
    for (const entry of await entries.all()) {
      await entry.scrollIntoViewIfNeeded();
      await expect(entry).toBeInViewport();
    }
  });

  test('658×320: no axe violations in the Compact layout', async ({ page }) => {
    await gotoAt(page, PHONE);
    const results = await new AxeBuilder({ page }).include('#app').analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  // The banner is a RESERVED grid row, so showing it genuinely costs board height. PLAN.md
  // P3 pins a separate, lower floor for that state: a ≥44px control row inside a 320px-tall
  // viewport cannot also meet the 85% banner-absent gate, so both are asserted rather than
  // one being quietly relaxed into the other.
  test('658×320 with the install banner visible: the board keeps its banner-present floor', async ({
    page,
  }, testInfo) => {
    skipUnlessCoarsePointer(testInfo);
    await installPromptFactory(page);
    await gotoAt(page, PHONE);
    await expect(page.locator('.wy-banner')).toBeHidden();

    await firePrompt(page, 'dismissed');
    const banner = page.locator('.wy-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Wynding plays best as an app');
    await expect(banner.getByRole('button', { name: 'Install', exact: true })).toBeVisible();

    const grid = await projectedGrid(page);
    expect(
      grid.height / PHONE.height,
      `grid height ${grid.height}px below the 70% banner-present floor`,
    ).toBeGreaterThanOrEqual(GRID_HEIGHT_FRACTION_MIN_WITH_BANNER);
    // ...and a CELL floor too: a height fraction alone cannot see a cell-size regression
    // (264/320 passes the 70% gate at cellPx 11 just as it would at a smaller cell).
    expect(
      grid.cellPx,
      `cellPx ${grid.cellPx} below the banner-present floor`,
    ).toBeGreaterThanOrEqual(CELL_PX_MIN_WITH_BANNER);

    // The banner is a declared region, disjoint from the playable grid like every other
    // chrome region — it never overlaps the board it made room beside.
    await assertDeclaredRegions(page);
    await assertRegionRelations(page, 'compact');

    // Axe with the banner visible.
    const audit = await new AxeBuilder({ page }).include('#app').analyze();
    expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);

    // Dismissing it returns the full board — and the banner-absent floor with it.
    await banner.getByRole('button', { name: 'Dismiss install suggestion' }).click();
    await expect(banner).toBeHidden();
    const restored = await projectedGrid(page);
    expect(restored.cellPx).toBeGreaterThanOrEqual(CELL_PX_MIN);
    expect(restored.height / PHONE.height).toBeGreaterThanOrEqual(GRID_HEIGHT_FRACTION_MIN);
  });

  // smoke.spec.ts's 200%-zoom gate runs with the banner ABSENT, and the banner test above
  // runs at 100% zoom — so the worst case (banner up AND 200% text zoom) had no coverage.
  // The banner is the shell's only other unbounded-by-default chrome region, and every
  // length inside it is rem-based, so it is exactly where an unbounded row would eat the
  // board (ADR 0003's text-resize commitment).
  test('658×320 with the install banner visible at 200% text zoom: the banner scrolls internally instead of eating the board', async ({
    page,
  }, testInfo) => {
    skipUnlessCoarsePointer(testInfo);
    await installPromptFactory(page);
    await gotoAt(page, PHONE);
    await firePrompt(page, 'dismissed');
    const banner = page.locator('.wy-banner');
    await expect(banner).toBeVisible();

    await page.addStyleTag({ content: ':root { font-size: 200% }' });

    // The banner is bounded, so it cannot grow past its share of the viewport...
    const bannerBox = (await banner.boundingBox()) as Rect;
    expect(
      bannerBox.height,
      `banner height ${bannerBox.height}px exceeds its 25dvh bound`,
    ).toBeLessThanOrEqual(PHONE.height * 0.25 + 1);
    // ...and what no longer fits scrolls INSIDE it rather than clipping.
    expect(
      await banner.evaluate((el) => el.scrollHeight > el.clientHeight),
      '.wy-banner should scroll internally at 200% zoom',
    ).toBe(true);

    // Its controls stay reachable inside that scrollport.
    for (const name of ['Install', 'Dismiss install suggestion']) {
      const btn = banner.getByRole('button', { name, exact: name === 'Install' });
      await btn.scrollIntoViewIfNeeded();
      await btn.focus();
      await expect(btn).toBeFocused();
      await expect(btn).toBeInViewport();
    }

    // ...which is what keeps the board above its floor in this doubly-squeezed state.
    const grid = await projectedGrid(page);
    expect(
      grid.cellPx,
      `cellPx ${grid.cellPx} below the zoomed banner-present floor`,
    ).toBeGreaterThanOrEqual(CELL_PX_MIN_WITH_BANNER_ZOOMED);

    await assertDeclaredRegions(page);
    await assertRegionRelations(page, 'compact');
  });

  // The Standard equivalent of the gate above. A coarse-pointer LANDSCAPE tablet is taller
  // than 500px, so it gets Standard WITH the banner — and the rotate overlay does not cover
  // it (that gates on portrait). smoke.spec.ts's Standard 200%-zoom gate runs under the
  // fine-pointer project, where the banner never appears, so this state had no coverage.
  test('640×560 Standard with the install banner visible at 200% text zoom: status + banner share one re-budgeted chrome bound', async ({
    page,
  }, testInfo) => {
    skipUnlessCoarsePointer(testInfo);
    await installPromptFactory(page);
    await gotoAt(page, TABLET);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(false);

    await firePrompt(page, 'dismissed');
    const banner = page.locator('.wy-banner');
    await expect(banner).toBeVisible();

    await page.addStyleTag({ content: ':root { font-size: 200% }' });

    // The two chrome rows are budgeted against each other, not independently...
    const status = (await regionRect(page, 'status')) as Rect;
    const bannerBox = (await banner.boundingBox()) as Rect;
    const chrome = status.height + bannerBox.height;
    expect(
      chrome,
      `status + banner ${chrome}px exceeds the shared banner-present chrome bound`,
    ).toBeLessThanOrEqual(TABLET.height * STANDARD_CHROME_FRACTION_MAX_WITH_BANNER + 1);

    // ...and the banner's controls stay reachable inside the tightened bound.
    for (const name of ['Install', 'Dismiss install suggestion']) {
      const btn = banner.getByRole('button', { name, exact: name === 'Install' });
      await btn.scrollIntoViewIfNeeded();
      await btn.focus();
      await expect(btn).toBeFocused();
      await expect(btn).toBeInViewport();
    }

    // ...which is what keeps the Standard board above its full 12px floor here.
    const grid = await projectedGrid(page);
    expect(
      grid.cellPx,
      `cellPx ${grid.cellPx} below the Standard floor with the banner up at 200% zoom`,
    ).toBeGreaterThanOrEqual(CELL_PX_MIN);

    // The banner is still a reserved row, disjoint from the board it made room above — the
    // full `assertRegionRelations` is not used here because the Standard Dock's own overlay
    // overlap grows with the zoom, which is a separate, already-pinned concern.
    await assertDeclaredRegions(page);
    expect(
      intersect((await regionRect(page, 'banner')) as Rect, grid),
      'the banner must be disjoint from the projected grid',
    ).toBeNull();
  });

  test('658×320 on iOS: the banner offers instructions, and the first Start ends it for the session', async ({
    page,
  }, testInfo) => {
    skipUnlessCoarsePointer(testInfo);
    await stubIosPlatform(page);
    await gotoAt(page, PHONE);

    const banner = page.locator('.wy-banner');
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Show me how' }).click();
    const instructions = page.getByRole('dialog', { name: 'Add Wynding to your Home Screen' });
    await expect(instructions).toBeVisible();
    await instructions.getByRole('button', { name: 'Close' }).click();
    await expect(instructions).toBeHidden();

    // The session's first Start ends the banner for good — including across Play-again,
    // which returns the run to a pre-start state.
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(banner).toBeHidden();
  });

  test('568×320 (narrow floor): the width-limited degradation gate still holds', async ({
    page,
  }) => {
    await gotoAt(page, NARROW);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);
    const grid = await projectedGrid(page);
    expect(
      grid.cellPx,
      `cellPx ${grid.cellPx} below the narrow-viewport floor`,
    ).toBeGreaterThanOrEqual(CELL_PX_MIN_NARROW);
    await assertDeclaredRegions(page);
    await assertRegionRelations(page, 'compact');
  });

  test('1280×720: Standard — top bar, wordmark, hotkey badge, and the Dock still floating over the Stage', async ({
    page,
  }) => {
    await gotoAt(page, TALL);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(false);

    // A top ROW, not a column: the status bar spans the viewport and the Stage sits below it.
    const status = (await regionRect(page, 'status')) as Rect;
    const stage = (await regionRect(page, 'stage')) as Rect;
    expect(status.width).toBeGreaterThanOrEqual(TALL.width * 0.9);
    expect(status.height).toBeLessThanOrEqual(TALL.height * 0.4);
    expect(stage.y).toBeGreaterThanOrEqual(status.y + status.height - 1);

    await expect(page.locator('.wy-wordmark')).toBeVisible();
    await expect(page.locator('.wy-card-hotkey')).toHaveCount(9); // vacuous-pass guard (QC round 1, M2-S4a: three cards, now nine at M2-S10)
    for (const badge of await page.locator('.wy-card-hotkey').all())
      await expect(badge).toBeVisible();

    // The full-form chips are what's painted; the glance forms never render on Standard.
    const chips = await visibleChipAccessibleText(page);
    expect(chips[0]).toMatch(/^Lives: \d+$/);
    await expect(page.locator('.wy-chip[data-wy-chip="lives"] .wy-chip-glance')).toBeHidden();

    // The Dock reparented into `header.wy-status` (contract §1's topology amendment) but
    // still RENDERS exactly as before: absolutely positioned against `.wy-shell`, floating
    // over the Stage's bottom-left — visible, geometrically inside the Stage, and actually
    // hit-testable there (an ancestor scroll box clipping it would fail this).
    const dock = (await regionRect(page, 'dock')) as Rect;
    await expect(page.locator('.wy-dock')).toBeVisible();
    expect(intersect(dock, stage), 'the Standard Dock must render over the Stage').not.toBeNull();
    const settings = page.getByRole('button', { name: 'Settings' });
    const settingsBox = (await settings.boundingBox()) as Rect;
    const hitInsideDock = await page.evaluate(
      // `el?.closest(...) !== null` would be `true` when nothing is hit at all — exactly the
      // regression this guards. Test the resolved node instead.
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.wy-dock')),
      { x: settingsBox.x + settingsBox.width / 2, y: settingsBox.y + settingsBox.height / 2 },
    );
    expect(hitInsideDock, 'the Standard Dock must be hit-testable over the Stage').toBe(true);

    await assertDeclaredRegions(page);
    await assertRegionRelations(page, 'standard');
  });

  // Decision 10: the chips list is a scrollable region, so it carries a tab stop in BOTH
  // layouts — an intentional accessibility improvement, asserted rather than left implicit.
  // This also pins the recorded Standard focus-order trade-off: the Dock lives in
  // `header.wy-status` for both layouts, so it is tabbed BEFORE the board it is painted over
  // in Standard (matching paint order in Compact). See the "Dock focus order" row in
  // docs/accessibility-checklist.md — the gate exists so that deviation cannot drift or grow
  // unnoticed, not because the mismatch is desirable.
  test('1280×720: the chips list is a Standard keyboard stop, ahead of the Dock controls', async ({
    page,
  }) => {
    await gotoAt(page, TALL);
    await page.locator('.wy-hud').focus();
    await expect(page.locator('.wy-hud')).toBeFocused();
    await page.keyboard.press('Tab');
    const nextIsDockControl = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('.wy-dock')),
    );
    expect(nextIsDockControl, 'Tab from the chips list must reach the Dock controls').toBe(true);
  });

  test('900×480: Compact engages on a SHORT window with a fine pointer (height-keyed, not pointer-keyed)', async ({
    page,
  }, testInfo) => {
    // Pointer genuinely matters here: the whole point is a fine-pointer session getting
    // Compact, which `chromium-touch`'s coarse-pointer device profile cannot demonstrate.
    test.skip(
      testInfo.project.name !== 'chromium',
      'needs the fine-pointer desktop profile to prove the trigger is not pointer-keyed',
    );
    await gotoAt(page, SHORT_DESKTOP);
    expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);

    const status = (await regionRect(page, 'status')) as Rect;
    expect(status.height).toBeGreaterThanOrEqual(SHORT_DESKTOP.height * 0.9);
    // The badge is Compact-gated, NOT pointer-gated: a fine pointer does not bring it back.
    await expect(page.locator('.wy-card-hotkey')).toHaveCount(9); // vacuous-pass guard (QC round 1, M2-S4a: three cards, now nine at M2-S10)
    for (const badge of await page.locator('.wy-card-hotkey').all())
      await expect(badge).toBeHidden();
    await expect(page.locator('.wy-wordmark')).toBeHidden();

    await assertDeclaredRegions(page);
    await assertRegionRelations(page, 'compact');
  });
});
