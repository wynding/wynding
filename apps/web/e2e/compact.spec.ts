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
    expect(await page.evaluate(() => matchMedia('(max-height: 500px)').matches)).toBe(true);

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
    await expect(page.locator('.wy-card-hotkey')).toBeHidden();

    // Four of the five chip slots are visible pre-start (the wave slot is hidden until a
    // run begins), and each one reads to assistive tech as its COMPLETE localized ICU
    // message — the aria-hidden glance form ("♥ 10") is invisible to AT.
    await expect.poll(async () => (await visibleChipAccessibleText(page)).length).toBe(4);
    const chips = await visibleChipAccessibleText(page);
    expect(chips[0]).toMatch(/^Lives: \d+$/);
    expect(chips[1]).toMatch(/^Bounty: \d+$/);
    expect(chips[2]).toMatch(/^Score: \d+$/);
    expect(chips[3]).toMatch(/^Stars: \d+ of 3$/);
    // ...and the glance forms ARE what is painted on screen.
    await expect(page.locator('.wy-chip[data-wy-chip="lives"] .wy-chip-glance')).toHaveText(/^♥/);

    // Board floor, banner absent.
    const grid = await projectedGrid(page);
    expect(grid.cellPx).toBeGreaterThanOrEqual(CELL_PX_MIN);
    expect(grid.height / PHONE.height).toBeGreaterThanOrEqual(GRID_HEIGHT_FRACTION_MIN);

    await assertDeclaredRegions(page);
    await assertRegionRelations(page, 'compact');

    // Starting the run reveals the fifth slot (countdown, then the active marker).
    await page.getByRole('button', { name: 'Start' }).click();
    await expect.poll(async () => (await visibleChipAccessibleText(page)).length).toBe(5);
    const started = await visibleChipAccessibleText(page);
    expect(started.some((c) => /^Wave/.test(c))).toBe(true);
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
    test.skip(
      testInfo.project.name !== 'chromium-touch',
      'the banner audience requires a coarse pointer — only the touch profile has one',
    );
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
    expect(restored.height / PHONE.height).toBeGreaterThanOrEqual(GRID_HEIGHT_FRACTION_MIN);
  });

  test('658×320 on iOS: the banner offers instructions, and the first Start ends it for the session', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium-touch',
      'the banner audience requires a coarse pointer — only the touch profile has one',
    );
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
    expect(await page.evaluate(() => matchMedia('(max-height: 500px)').matches)).toBe(true);
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
    expect(await page.evaluate(() => matchMedia('(max-height: 500px)').matches)).toBe(false);

    // A top ROW, not a column: the status bar spans the viewport and the Stage sits below it.
    const status = (await regionRect(page, 'status')) as Rect;
    const stage = (await regionRect(page, 'stage')) as Rect;
    expect(status.width).toBeGreaterThanOrEqual(TALL.width * 0.9);
    expect(status.height).toBeLessThanOrEqual(TALL.height * 0.4);
    expect(stage.y).toBeGreaterThanOrEqual(status.y + status.height - 1);

    await expect(page.locator('.wy-wordmark')).toBeVisible();
    await expect(page.locator('.wy-card-hotkey')).toBeVisible();

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
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('.wy-dock') !== null,
      { x: settingsBox.x + settingsBox.width / 2, y: settingsBox.y + settingsBox.height / 2 },
    );
    expect(hitInsideDock, 'the Standard Dock must be hit-testable over the Stage').toBe(true);

    await assertDeclaredRegions(page);
    await assertRegionRelations(page, 'standard');
  });

  // Decision 10: the chips list is a scrollable region, so it carries a tab stop in BOTH
  // layouts — an intentional accessibility improvement, asserted rather than left implicit.
  test('1280×720: the chips list is a Standard keyboard stop, ahead of the Dock controls', async ({
    page,
  }) => {
    await gotoAt(page, TALL);
    await page.locator('.wy-hud').focus();
    await expect(page.locator('.wy-hud')).toBeFocused();
    await page.keyboard.press('Tab');
    const nextIsDockControl = await page.evaluate(
      () => document.activeElement?.closest('.wy-dock') !== null,
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
    expect(await page.evaluate(() => matchMedia('(max-height: 500px)').matches)).toBe(true);

    const status = (await regionRect(page, 'status')) as Rect;
    expect(status.height).toBeGreaterThanOrEqual(SHORT_DESKTOP.height * 0.9);
    // The badge is Compact-gated, NOT pointer-gated: a fine pointer does not bring it back.
    await expect(page.locator('.wy-card-hotkey')).toBeHidden();
    await expect(page.locator('.wy-wordmark')).toBeHidden();

    await assertDeclaredRegions(page);
    await assertRegionRelations(page, 'compact');
  });
});
