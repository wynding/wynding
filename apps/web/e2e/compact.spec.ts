import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PNG } from 'pngjs';
import { createProjection } from '@wynding/render';
import {
  GRID,
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
import { callWavePaced, titleAfterCall } from './paced-call';
import { COMPACT_QUERY } from '../src/layout';
import { TARGET_MIN_PX } from './targets';

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
    // The glyph swatch is COMPACT-gated like the badge (space, not capability — its
    // ui.css comment): count pinned first for the same vacuous-pass reason.
    await expect(page.locator('.wy-card-swatch')).toHaveCount(9);
    for (const swatch of await page.locator('.wy-card-swatch').all())
      await expect(swatch).toBeHidden();

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
    // Rows carry BOTH forms since #101, so a bare `li` locator reads the accessible
    // sentence and the visible glance concatenated. Address each explicitly: the full form
    // is unchanged (which is the parity guarantee — the diet cost no information), and the
    // glance is the text a sighted player actually reads.
    const entries = preview.locator('li');
    await expect(entries).toHaveCount(1); // the shipped bundle's single creep kind
    await expect(preview.locator('.wy-preview-full').first()).toHaveText(
      '10 × Creep — ground, armor 0, leak cost 1, no immunities',
    );
    await expect(preview.locator('.wy-preview-glance').first()).toHaveText('10 × Creep');

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
    // Above the sum of this test's declared worst-case budgets — seven paced calls
    // (#70: wave 1 now launches on Start itself, not through this loop) carrying a 5s
    // in-page deadline each (paced-call.ts) plus the axe/geometry/keyboard tail — which
    // the 60s config default cannot hold (same budget-coherence rule as the two marathon
    // specs, CodeRabbit #117). The budget itself is unchanged — one fewer paced call
    // only widens the margin.
    test.setTimeout(120_000);
    await gotoAt(page, PHONE);
    const preview = page.locator('.wy-wave-preview');
    const previewTitle = preview.locator('.wy-wave-preview-title');
    const entries = preview.locator('li');
    const callWave = page.getByRole('button', { name: 'Call wave' });

    // Start CLAIMS wave 1 as well as unholding the run (#70) — settle on the wave-2
    // preview + a call-ready control before the Pause press below, so the claim itself
    // is a named assertion rather than an incidental side effect of what follows.
    await page.getByRole('button', { name: 'Start' }).click();
    // The settle window itself runs UNPAUSED — the claim can only be consumed by a real
    // tick, so it cannot be waited for under pause. Bounded, not unbounded: two awaited
    // assertions at 1x against ~450 ticks before this undefended run's first leak, so the
    // #97 lag class has orders of magnitude of headroom here even though this is, strictly,
    // a window the old same-tick Start->Pause did not have.
    await expect(previewTitle).toHaveText('Wave 2 of 10');
    await expect(callWave).toHaveAttribute('aria-disabled', 'false');

    // Early-call through the REMAINING waves 2..8 to bring wave 9 (index 8, the
    // four-stream wave) into the preview slot — the same gate-each-press-on-aria
    // pattern smoke.spec.ts / start-gate.spec.ts use, so a same-tick-deduped press
    // cannot silently short the loop.
    // #97: the same undefended-marathon pacing the smoke/start-gate loops use — enter
    // the loop PAUSED so runner lag between iterations stalls a frozen sim instead of
    // leaking creeps (this loop free-ran eight calls, the same class that lost runs
    // mid-loop in those specs, just at 1× with a shorter horizon).
    await page.getByRole('button', { name: 'Pause' }).click();
    for (let waveNumber = 2; waveNumber <= 8; waveNumber++) {
      await expect(previewTitle).toHaveText(`Wave ${waveNumber} of 10`);
      await expect(callWave).toHaveAttribute('aria-disabled', 'false');
      await callWavePaced(page, titleAfterCall(waveNumber, 10));
    }
    await expect(previewTitle).toHaveText('Wave 9 of 10');
    // The loop exits paused (callWavePaced's contract), and the tail below NEEDS that
    // freeze — wave 9's own 300-tick countdown would otherwise keep running under the
    // long assertion tail (axe + geometry + keyboard-scroll — observed flaking once the
    // tail crossed the auto-launch boundary on a loaded machine). Paused pins the
    // preview on wave 9 for the whole tail; the preview reflects Pending state under
    // pause by design, so nothing measured changes.
    await expect(entries).toHaveCount(4);
    await expect(preview.locator('.wy-preview-full')).toHaveText([
      '10 × Swarm Creep — ground, armor 0, leak cost 1, no immunities',
      '6 × Fast Creep — ground, armor 0, leak cost 1, no immunities',
      '4 × Armored Creep — ground, armor 6 (subtracted from each direct hit; damage over time ignores it), leak cost 1, no immunities',
      '4 × Flying Creep — air, armor 0, leak cost 1, no immunities',
    ]);
    // The arc's densest wave, in the form a player actually reads it (#101): three of the
    // four rows collapse to bare count-and-name, and `air` is the only annotation standing
    // — which is precisely the "is air next?" question the surface is scanned for.
    await expect(preview.locator('.wy-preview-glance')).toHaveText([
      '10 × Swarm Creep',
      '6 × Fast Creep',
      '4 × Armored Creep — armor −6 direct',
      '4 × Flying Creep — air',
    ]);

    // axe audit with all 4 rows showing — the standard bar every other HUD content is
    // held to (PLAN.md P3 step 19).
    const audit = await new AxeBuilder({ page }).include('#app').analyze();
    expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);

    // GUARD: the paused sim (the loop's #97 exit state) is what pins this title — wave
    // 9's 300-tick countdown would otherwise auto-launch under this tail (~15 s at 1×)
    // and flip the preview to wave 10's two-row composition, going stale on the 4
    // materialized entry locators (boundingBox() null). Re-asserting the title keeps
    // that a NAMED failure if the freeze is ever lost, instead of a mystery null
    // dereference on a slow runner.
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

test.describe('Rail under the open Panel — Compact (#69)', () => {
  test('658×320: Cards never squash, arming/placing never scrolls, and a pointer inspect needs no reveal — the Panel is PINNED', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);

    const railScrollTop = () =>
      page.evaluate(() => (document.querySelector('.wy-rail') as HTMLElement).scrollTop);
    // Internal overflow only: the hotkey badge is `display: none` on Compact, so a
    // badge-position assertion here would pass vacuously on a zero rect.
    const cardOverflows = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.wy-card')].map((c) => c.scrollHeight - c.clientHeight),
      );

    await page.getByRole('button', { name: /Basic Tower/ }).click();
    await expect(page.locator('.wy-panel')).toBeVisible();
    const overflows = await cardOverflows();
    expect(overflows).toHaveLength(9); // vacuous-pass guard — same rule as the badge counts above
    for (const [i, overflow] of overflows.entries())
      expect(overflow, `card ${i + 1} squashed by the open Panel`).toBeLessThanOrEqual(1);
    expect(await railScrollTop(), 'arming must not scroll the Rail').toBe(0);

    // Place at (3,3) — smoke.spec's walk; the placement's auto-selection is a build act
    // and must not scroll either (`touch.spec.ts` pins a Card's cached position across a
    // placement). The Sell-button await gates the rebuild frame, so the zero reads are
    // post-frame, not not-yet.
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();
    expect(await railScrollTop(), 'a placement must not scroll the Rail').toBe(0);

    // The deliberate pointer inspect. On Compact the Panel is TALLER than the scrollport —
    // the case that separates the top-aligned reveal from a naive scroll-to-end, which
    // would clip the heading ("which tower is this?") off the top.
    await page.keyboard.press('Escape');
    await expect(page.locator('.wy-panel')).toBeHidden();
    const box = (await page.locator('.wy-board').boundingBox()) as Rect;
    const projection = createProjection({
      cols: GRID.cols,
      rows: GRID.rows,
      cssWidth: box.width,
      cssHeight: box.height,
      dpr: 1,
    });
    const cell = projection.cellToPixel(3, 3);
    await page.mouse.click(
      box.x + cell.x + projection.cellPx / 2,
      box.y + cell.y + projection.cellPx / 2,
    );
    await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();

    // M2-S12a P3 INVERTS this branch, and does so deliberately. At 658×320 the Panel is
    // now PINNED to the Rail's bottom edge, so it is already fully visible and
    // `revealPanel()` no-ops instead of scrolling the Rail to its end for nothing. The
    // OUTCOME this test has always been about — the heading readable after a pointer
    // inspect — is asserted immediately below and is now strictly STRONGER: it holds at
    // `scrollTop === 0`, with every Card still exactly where the finger left it. The three
    // `=== 0` assertions earlier in this test are untouched, which is the check that the
    // design did not drift: they pass for the same reason they always did.
    expect(
      await page.evaluate(
        () => getComputedStyle(document.querySelector('.wy-panel') as HTMLElement).position,
      ),
      'the Panel must be pinned at this viewport — the whole premise of the assertion below',
    ).toBe('sticky');
    expect(
      await railScrollTop(),
      'a pinned Panel is already visible, so a reveal must not scroll the Rail',
    ).toBe(0);
    const name = await page.evaluate(() => {
      const rail = (document.querySelector('.wy-rail') as HTMLElement).getBoundingClientRect();
      const heading = (
        document.querySelector('.wy-panel-name') as HTMLElement
      ).getBoundingClientRect();
      return {
        railTop: rail.top,
        railBottom: rail.bottom,
        top: heading.top,
        bottom: heading.bottom,
      };
    });
    expect(
      name.top,
      "the Panel's heading must not sit above the scrollport",
    ).toBeGreaterThanOrEqual(name.railTop - 1);
    expect(name.bottom, "the Panel's heading must be inside the scrollport").toBeLessThanOrEqual(
      name.railBottom + 1,
    );
  });
});

// =====================================================================================
// M2-S12a — the Compact build loop. THE assertion this story exists to add: after arming
// a tower on the smallest supported viewports, can the player actually SEE what they
// armed? Before this story the answer was measurably no — the Panel rendered at content
// offset 677.5px in a 320px scrollport, with zero pixels on screen, and nothing had ever
// asserted the outcome (only that arming did not scroll, which it did not).
// =====================================================================================

/** Arm a tower by HOTKEY, never by clicking its Card. A Playwright `.click()` on a
 *  below-the-fold Card auto-scrolls the Rail to reach it, which would move the Panel into
 *  view as a side effect and let every assertion below pass with the defect fully intact. */
async function armByHotkey(page: import('@playwright/test').Page, key: string): Promise<void> {
  await page.evaluate(() => ((document.querySelector('.wy-rail') as HTMLElement).scrollTop = 0));
  await page.keyboard.press(key);
  await expect(page.locator('.wy-panel')).toBeVisible();
}

/** Wait for a scroll container to come to rest, measured in ANIMATION FRAMES rather than on
 *  the wall clock. Focus and keyboard scrolling are both animated in Chromium, so a geometry
 *  read taken straight after `.focus()` catches the container mid-flight — a different world,
 *  where the fade is still painted and the focused Card has not reached its resting place.
 *  Measured without settling, the last Card reported 16px under the band; settled, it sits at
 *  maximum scroll where `wy-rail-has-more` is false and the band paints nothing at all.
 *
 *  FRAMES, and CONSECUTIVE ones, for two distinct reasons. Sleeping a fixed interval couples
 *  the test to machine speed and to the engine's animation timing, which is the flake this
 *  suite exists to avoid. And returning on the FIRST unchanged reading — which the wall-clock
 *  version this replaced did — can observe a single quiet sample during easing, or before the
 *  animation has advanced at all, and settle on a value the scroll is about to leave.
 *  Requiring four consecutive unchanged frames outlasts both by construction rather than by
 *  luck. */
async function settleScroll(
  page: import('@playwright/test').Page,
  selector: string,
): Promise<void> {
  await page.evaluate(async (sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    let previous = Number.NaN;
    let stableFrames = 0;
    // Bounded at ~2s of frames; the animation itself runs ~100-150ms.
    for (let i = 0; i < 120 && stableFrames < 4; i++) {
      await nextFrame();
      const now = el.scrollTop;
      stableFrames = now === previous ? stableFrames + 1 : 0;
      previous = now;
    }
  }, selector);
}

async function settleRailScroll(page: import('@playwright/test').Page): Promise<void> {
  await settleScroll(page, '.wy-rail');
}

/* NOTE — the visible-stats-block fork (`glance` unless it is `display: none`) is
   re-derived inline in each `page.evaluate` below rather than hoisted. Playwright
   serializes every evaluate body independently, so sharing it means either an
   `evaluateHandle` threaded through each call or an init-script global — and the failure
   mode the duplication risks is a LOUD one: if the fork or either class name moves, these
   tests fail rather than silently passing, which is precisely their job. Declined as a
   worse trade than the repetition. */

/** The rows a browser is actually SHOWING — catalog-derived, never a hardcoded list.
 *  `beacon` has no Damage row at all (cost + support only) and `mine` has no Fire rate, so
 *  a fixed "cost and damage" expectation is unsatisfiable for one and incomplete for the
 *  other. */
async function visibleRowTexts(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const panel = document.querySelector('.wy-panel') as HTMLElement;
    const glance = panel.querySelector('.wy-stats-glance') as HTMLElement;
    const full = panel.querySelector('.wy-stats-full') as HTMLElement;
    const shown = getComputedStyle(glance).display !== 'none' ? glance : full;
    return [...shown.querySelectorAll('p')].map((p) => p.textContent ?? '');
  });
}

test.describe('M2-S12a: arming shows the player what they armed', () => {
  // Run for the three shapes the catalog actually has — an ordinary cadenced tower, the
  // attackless support tower, and the burst tower — because each produces a different row
  // set and a Panel sized differently.
  for (const [label, hotkey] of [
    ['basic (ordinary, cadenced)', '1'],
    ['beacon (no attack at all)', '7'],
    ['mine (burst, no fire rate)', '8'],
  ] as const) {
    test(`658×320: arming ${label} by hotkey puts its heading and first row on screen`, async ({
      page,
    }) => {
      await gotoAt(page, PHONE);
      await armByHotkey(page, hotkey);

      const geom = await page.evaluate(() => {
        const rail = (document.querySelector('.wy-rail') as HTMLElement).getBoundingClientRect();
        const panel = (document.querySelector('.wy-panel') as HTMLElement).getBoundingClientRect();
        const heading = (
          document.querySelector('.wy-panel-name') as HTMLElement
        ).getBoundingClientRect();
        const shownBlock = document.querySelector('.wy-stats-glance') as HTMLElement;
        const firstRow = (
          (getComputedStyle(shownBlock).display !== 'none'
            ? shownBlock
            : (document.querySelector('.wy-stats-full') as HTMLElement)
          ).querySelector('p') as HTMLElement
        ).getBoundingClientRect();
        return {
          rail,
          panel,
          heading,
          firstRow,
          railScrollTop: (document.querySelector('.wy-rail') as HTMLElement).scrollTop,
        };
      });

      // Arming still must not scroll the Rail — the guarantee `touch.spec.ts` depends on.
      expect(geom.railScrollTop, 'arming must not scroll the Rail').toBe(0);
      // FULLY inside, both boxes. A one-pixel border sliver peeking into the scrollport
      // would satisfy a naive "> 0 pixels visible" check while showing the player nothing.
      for (const [name, r] of [
        ['heading', geom.heading],
        ['first row', geom.firstRow],
      ] as const) {
        expect(r.top, `${name} must be inside the Rail's scrollport`).toBeGreaterThanOrEqual(
          geom.rail.top - 1,
        );
        expect(r.bottom, `${name} must be inside the Rail's scrollport`).toBeLessThanOrEqual(
          geom.rail.bottom + 1,
        );
        expect(r.top, `${name} must be inside the Panel's own box`).toBeGreaterThanOrEqual(
          geom.panel.top - 1,
        );
        expect(r.bottom, `${name} must be inside the Panel's own box`).toBeLessThanOrEqual(
          geom.panel.bottom + 1,
        );
        expect(r.height, `${name} must have a real box, not a collapsed one`).toBeGreaterThan(4);
      }
    });
  }

  test('658×320: every remaining row is reachable by KEYBOARD from the Panel’s own tab stop', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    await armByHotkey(page, '9'); // frost-splash — the catalog's densest Panel

    const rowCount = (await visibleRowTexts(page)).length;
    expect(rowCount, 'the densest tower must actually have rows to reach').toBeGreaterThan(3);

    const scroller = page.locator('.wy-panel-scroll');
    // The cap gives the rows their own scroll container, and the rows are `<p>` elements
    // that cannot take focus — so without a tab stop of its own it would be operable by
    // mouse and test only. That is a WCAG 2.1.1 regression, and it would be one of this
    // story's own making.
    await expect(scroller).toHaveAttribute('tabindex', '0');
    await expect(scroller).toHaveAttribute('aria-label', /\S/);
    await scroller.focus();

    // Every row must become fully visible through ACTUAL KEY PRESSES — never
    // `scrollIntoViewIfNeeded()`, which would prove only that the row exists in the DOM,
    // not that a keyboard user can reach it.
    const seen = new Set<number>();
    const recordVisible = async (): Promise<void> => {
      const idx = await page.evaluate(() => {
        const sc = document.querySelector('.wy-panel-scroll') as HTMLElement;
        const glance = sc.querySelector('.wy-stats-glance') as HTMLElement;
        const shown =
          getComputedStyle(glance).display !== 'none'
            ? glance
            : (sc.querySelector('.wy-stats-full') as HTMLElement);
        const box = sc.getBoundingClientRect();
        return [...shown.querySelectorAll('p')]
          .map((p, i) => {
            const r = p.getBoundingClientRect();
            return r.top >= box.top - 1 && r.bottom <= box.bottom + 1 ? i : -1;
          })
          .filter((i) => i >= 0);
      });
      for (const i of idx) seen.add(i);
    };

    // Chromium ANIMATES keyboard scrolling by default, so a read taken straight after the
    // keypress catches the container a pixel or two into a ~100ms animation and reports the
    // row as still clipped. Settle before measuring — otherwise this test fails for a
    // reason that has nothing to do with whether the row is reachable.
    const settle = (): Promise<void> => settleScroll(page, '.wy-panel-scroll');

    await recordVisible();
    // ArrowDown AND PageDown, alternating. Both are ordinary keyboard operation of a focused
    // scroll container, and the claim under test is that every row is REACHABLE by keyboard
    // — not that one particular key does it. That distinction is load-bearing: in WebKit an
    // active `requestAnimationFrame` loop suppresses arrow-key scrolling of a focused scroll
    // container, and this app runs a continuous render loop, so an ArrowDown-only assertion
    // states a property that holds in Chromium and fails on the only engine iOS allows.
    for (let i = 0; i < 16 && seen.size < rowCount; i++) {
      await page.keyboard.press(i % 2 === 0 ? 'ArrowDown' : 'PageDown');
      await settle();
      await recordVisible();
    }
    expect(
      [...seen].sort((a, b) => a - b),
      'every row must be reachable with the keyboard alone',
    ).toEqual(Array.from({ length: rowCount }, (_, i) => i));
  });

  // The four viewports the design argument rests on, at both zoom levels. 900×480 and
  // 640×560 would otherwise be unguarded — and 640×560 is the case that proves the rule is
  // keyed on the RAIL rather than on the Compact fork, since it is Standard by height and
  // carries the identical 144px Rail.
  for (const [label, size] of [
    ['PHONE 658×320', PHONE],
    ['NARROW 568×320', NARROW],
    ['SHORT_DESKTOP 900×480', SHORT_DESKTOP],
    ['TABLET 640×560', TABLET],
  ] as const) {
    for (const zoom of [100, 200]) {
      test(`${label} at ${zoom}% text zoom: an armed Panel is on screen and pinned`, async ({
        page,
      }) => {
        await gotoAt(page, size);
        if (zoom === 200) await page.addStyleTag({ content: ':root { font-size: 200% }' });
        await armByHotkey(page, '9');

        const m = await page.evaluate(() => {
          const rail = document.querySelector('.wy-rail') as HTMLElement;
          const panel = document.querySelector('.wy-panel') as HTMLElement;
          const rr = rail.getBoundingClientRect();
          const pr = panel.getBoundingClientRect();
          return {
            position: getComputedStyle(panel).position,
            visiblePx: Math.max(0, Math.min(pr.bottom, rr.bottom) - Math.max(pr.top, rr.top)),
            railHeight: rr.height,
          };
        });
        expect(m.position, 'the Panel must be pinned at every Compact-class viewport').toBe(
          'sticky',
        );
        // The headline defect: this read exactly 0 at all four of these before the story.
        expect(m.visiblePx, 'the armed Panel must be on screen').toBeGreaterThan(0);
        // And a real slice of it, not a sliver — enough for the heading plus a row.
        expect(m.visiblePx).toBeGreaterThan(60);
        // The cap is what stands between 200% zoom and a Panel that swallows the Rail.
        expect(m.visiblePx, 'the cap must leave room for the Cards').toBeLessThan(
          m.railHeight * 0.75,
        );
      });
    }
  }

  // The SELECTED Panel, which the armed cases above cannot reach: it carries the action row
  // ON TOP of everything the armed form shows, and it is the form a placement leaves on
  // screen — the build loop's resting state, not a detour. A cap only squeezes what may
  // shrink, so while the name row and the actions sat OUTSIDE the scrollport they were not
  // squeezed by it, they overflowed it: measured at both 320px-tall floors, 220px of content
  // in a 182px cap, the rows block collapsed to 0px and 17 of the Close button's 44px on
  // screen with its centre below the Rail's bottom edge. The Panel's visible height is
  // unchanged by the fix, so no assertion above could have caught it.
  for (const [label, size] of [
    ['658×320', PHONE],
    ['568×320', NARROW],
  ] as const) {
    for (const zoom of [100, 200]) {
      test(`${label} at ${zoom}% text zoom: a placement's Panel keeps its Close button whole and clickable`, async ({
        page,
      }) => {
        await gotoAt(page, size);
        if (zoom === 200) await page.addStyleTag({ content: ':root { font-size: 200% }' });
        // The ordinary build path, by keyboard: arm, walk, place. The placement
        // auto-selects, which is the form under test — and, like `armByHotkey`, none of it
        // scrolls the Rail, so a passing read cannot be a scroll's doing.
        await armByHotkey(page, '1');
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
        for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Enter');
        await expect(
          page.locator('.wy-panel').getByRole('button', { name: /^Sell/ }),
        ).toBeVisible();

        const m = await page.evaluate(() => {
          const rail = document.querySelector('.wy-rail') as HTMLElement;
          const panel = document.querySelector('.wy-panel') as HTMLElement;
          const scroll = document.querySelector('.wy-panel-scroll') as HTMLElement;
          const heading = document.querySelector('.wy-panel-name') as HTMLElement;
          // The Panel's only DIRECT-child button: Sell and Max level live inside the
          // scrollport, so this selector also pins WHICH control was kept out of the scroll.
          const close = document.querySelector('.wy-panel > button') as HTMLElement;
          const rr = rail.getBoundingClientRect();
          const sr = scroll.getBoundingClientRect();
          const cr = close.getBoundingClientRect();
          const shownBlock = panel.querySelector('.wy-stats-glance') as HTMLElement;
          const shown =
            getComputedStyle(shownBlock).display !== 'none'
              ? shownBlock
              : (panel.querySelector('.wy-stats-full') as HTMLElement);
          const hit = document.elementFromPoint((cr.left + cr.right) / 2, (cr.top + cr.bottom) / 2);
          return {
            position: getComputedStyle(panel).position,
            railScrollTop: rail.scrollTop,
            closeName: close.textContent ?? '',
            closeHeight: cr.height,
            closeTopGap: cr.top - rr.top,
            closeBottomGap: rr.bottom - cr.bottom,
            closeIsHit: hit !== null && (hit === close || close.contains(hit)),
            headingStartsInside: heading.getBoundingClientRect().top >= sr.top - 1,
            scrollportHeight: sr.height,
            rowsFullyVisible: [...shown.querySelectorAll('p')].filter((p) => {
              const r = p.getBoundingClientRect();
              return r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1;
            }).length,
          };
        });

        expect(m.position, 'the Panel must be pinned at this viewport').toBe('sticky');
        expect(m.railScrollTop, 'a placement must not scroll the Rail').toBe(0);
        // WHOLE: both edges inside the scrollport, not a clipped stub of a 44px target.
        expect(m.closeName, 'the Panel-level button is the Close button').toMatch(/\S/);
        expect(m.closeHeight, 'the Close button keeps its 44px floor').toBeGreaterThanOrEqual(
          TARGET_MIN_PX,
        );
        expect(m.closeTopGap, 'the Close button must be inside the Rail').toBeGreaterThanOrEqual(
          -1,
        );
        expect(m.closeBottomGap, 'the Close button must be inside the Rail').toBeGreaterThanOrEqual(
          -1,
        );
        // CLICKABLE: laid out inside the scrollport is not the same as reachable by a
        // finger — the pre-fix Panel had a Close button whose centre hit-tested to nothing.
        expect(m.closeIsHit, 'the Close button must answer a press at its centre').toBe(true);
        // And the scrollport still has a box to read the tower in, starting at its name.
        expect(m.scrollportHeight, 'the scrollport must not collapse').toBeGreaterThan(40);
        expect(m.headingStartsInside, 'the Panel opens on its name row').toBe(true);
        // The stat rows are the story's headline outcome, and they are only geometrically
        // possible at 100%: at 200% on a 320px-tall Rail the name row alone is 134px of a
        // 92px scrollport, so what the player sees first is the name and the rows are one
        // scroll of the Panel's own tab stop away.
        if (zoom === 100) {
          expect(m.rowsFullyVisible, 'a placed tower must show what it is worth').toBeGreaterThan(
            0,
          );
        }
      });
    }
  }
});

test.describe('M2-S12a: the condensed Panel and the Rail affordance', () => {
  // Asserted on WHICH BLOCK IS SELECTED, never on whether rows wrap. "Rows wrap at 144px
  // and not at 208px" is already true of the form that shipped before this story, so a
  // wrapping assertion would pass with the condensed form entirely absent — the vacuous
  // pass this gate exists to avoid. Real, reachable viewports on both sides; never the
  // threshold value itself.
  test('658×320: the GLANCE block is the visible one and the full sentences stay the accessible text', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    await armByHotkey(page, '9');
    const m = await page.evaluate(() => {
      const glance = document.querySelector('.wy-stats-glance') as HTMLElement;
      const full = document.querySelector('.wy-stats-full') as HTMLElement;
      const gs = getComputedStyle(glance);
      const fs = getComputedStyle(full);
      return {
        glanceDisplay: gs.display,
        glanceAriaHidden: glance.getAttribute('aria-hidden'),
        fullPosition: fs.position,
        fullClip: fs.clipPath,
        fullWidth: full.getBoundingClientRect().width,
        glanceScrollHeight: glance.scrollHeight,
        glanceText: glance.textContent ?? '',
        fullText: full.textContent ?? '',
      };
    });
    expect(m.glanceDisplay, 'the glance block is the visible one at a 144px Rail').not.toBe('none');
    // Visually hidden, NOT removed: the full sentences remain the Panel's accessible text
    // at every width, so only the presentation forks.
    expect(m.fullPosition).toBe('absolute');
    expect(m.fullClip).toContain('inset');
    expect(m.fullWidth).toBeLessThanOrEqual(2);
    expect(m.glanceAriaHidden).toBe('true');
    expect(m.fullText).toContain('Cost: 16');
    expect(m.glanceText).toContain('◈16');

    // The BOUND, asserted on intrinsic `scrollHeight` rather than rendered height: P3's cap
    // already squeezes any Panel in a 320px Rail, so a rendered-height bound could not tell
    // the condensed form from the capped uncondensed one and would pass either way.
    // Measured on the same element: 293px uncondensed at this Rail width, before the story.
    expect(
      m.glanceScrollHeight,
      'the condensed rows block must actually be condensed',
    ).toBeLessThanOrEqual(180);
  });

  test('1000×720: a wide Rail keeps the FULL block visible and drops the glance entirely', async ({
    page,
  }) => {
    await gotoAt(page, { width: 1000, height: 720 });
    await armByHotkey(page, '9');
    const m = await page.evaluate(() => {
      const glance = document.querySelector('.wy-stats-glance') as HTMLElement;
      const full = document.querySelector('.wy-stats-full') as HTMLElement;
      return {
        glanceDisplay: getComputedStyle(glance).display,
        fullPosition: getComputedStyle(full).position,
        panelPosition: getComputedStyle(document.querySelector('.wy-panel') as HTMLElement)
          .position,
      };
    });
    // A Rail wide enough to render the full sentences never pays for the glance block.
    expect(m.glanceDisplay).toBe('none');
    // ...and an UNPINNED scrollport must not carry a tab stop. Deleting
    // `.wy-panel-scroll > .wy-sr-only { top: 0 }` leaves the Upgrade description at the end
    // of the content instead of its origin — ~5px of phantom scroll extent, enough for the
    // overflow test to hand every Standard keyboard user a tab stop that scrolls nothing.
    // Asserted in the SELECTION state, the only one that renders that description at all.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Basic Tower/ }).click();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();
    await expect(page.locator('.wy-panel-scroll')).not.toHaveAttribute('tabindex');
    expect(m.fullPosition, 'the full block is in normal flow here').toBe('static');
    // And the non-pinned branch stays reachable — this is the shape that still owns the
    // scroll + reveal machinery (`arming.spec.ts`).
    expect(m.panelPosition).toBe('static');
  });

  // THE SELECTION PATH, which the arming tests above cannot reach. A selected tower's Panel
  // carries an action row (Sell + Max level) that an armed one does not, and the cap can
  // only squeeze what is allowed to shrink — so chrome left outside the scrollport does not
  // get squeezed, it OVERFLOWS past the Rail's bottom edge. Measured while that was the
  // shape: 220px of content in a 182px cap, zero stat rows rendered, and 17 of the Close
  // button's 44px on screen. Nothing caught it, because every other test here ARMS.
  test('658×320: a SELECTED tower fits the cap — stat rows render and Close keeps its full 44px', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    await page.getByRole('button', { name: /Basic Tower/ }).click();
    // Place at (3,3) — smoke.spec's walk. A placement auto-selects, which is the state.
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();

    const m = await page.evaluate(() => {
      const rail = (document.querySelector('.wy-rail') as HTMLElement).getBoundingClientRect();
      const panel = document.querySelector('.wy-panel') as HTMLElement;
      const pr = panel.getBoundingClientRect();
      const close = [...panel.querySelectorAll('button')].find((b) =>
        /close/i.test(b.textContent ?? ''),
      ) as HTMLElement;
      const cr = close.getBoundingClientRect();
      const shown =
        getComputedStyle(panel.querySelector('.wy-stats-glance') as HTMLElement).display !== 'none'
          ? (panel.querySelector('.wy-stats-glance') as HTMLElement)
          : (panel.querySelector('.wy-stats-full') as HTMLElement);
      return {
        railScrollTop: (document.querySelector('.wy-rail') as HTMLElement).scrollTop,
        pinned: getComputedStyle(panel).position === 'sticky',
        panelWithinRail: pr.top >= rail.top - 1 && pr.bottom <= rail.bottom + 1,
        closeHeight: cr.height,
        closeWithinPanel: cr.top >= pr.top - 1 && cr.bottom <= pr.bottom + 1,
        closeWithinRail: cr.top >= rail.top - 1 && cr.bottom <= rail.bottom + 1,
        renderedRows: shown.querySelectorAll('p').length,
      };
    });
    expect(m.pinned).toBe(true);
    // The same guard the sibling placement test carries, and for the reason `armByHotkey`'s
    // docstring records: a Playwright `.click()` on a Card auto-scrolls the Rail, which would
    // move the Panel into view as a side effect and let every geometry claim below pass with
    // the defect intact. Basic Tower is above the fold today; nothing pins that but this.
    expect(m.railScrollTop, 'the click path must not have scrolled the Rail').toBe(0);
    // The whole Panel — chrome included — stays inside the scrollport it is pinned to.
    expect(m.panelWithinRail, 'the capped Panel must not overflow the Rail').toBe(true);
    expect(m.renderedRows, 'the stat rows must actually render').toBeGreaterThan(0);
    // ADR 0003's 44px target, in full, not a clipped remnant.
    expect(m.closeHeight).toBeGreaterThanOrEqual(TARGET_MIN_PX);
    expect(m.closeWithinPanel, 'Close must be inside the Panel').toBe(true);
    expect(m.closeWithinRail, 'Close must be on screen').toBe(true);
  });

  test('658×320: a focused Card always clears the pinned Panel — all nine of them', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    await armByHotkey(page, '1');
    const results: boolean[] = [];
    for (let i = 0; i < 9; i++) {
      await page.locator('.wy-card').nth(i).focus();
      await settleRailScroll(page);
      results.push(
        await page.evaluate((n) => {
          const card = document.querySelectorAll('.wy-card')[n] as HTMLElement;
          const panel = document.querySelector('.wy-panel') as HTMLElement;
          const rail = document.querySelector('.wy-rail') as HTMLElement;
          const cb = card.getBoundingClientRect();
          const pb = panel.getBoundingClientRect();
          const rb = rail.getBoundingClientRect();
          return cb.bottom <= pb.top + 0.5 && cb.top >= rb.top - 0.5;
        }, i),
      );
    }
    // A sticky Panel paints OVER earlier siblings, and native focus scrolling only
    // guarantees a focused Card INTERSECTS the scrollport — not that it clears an overlay,
    // which is what ADR 0003's visible-focus requirement actually needs.
    expect(results, 'every focused Card must sit above the pinned Panel').toEqual(
      Array.from({ length: 9 }, () => true),
    );
  });

  // The scroll fade is an overlay too, and its gradient ends FULLY OPAQUE at the band's
  // bottom — the exact edge native focus scrolling parks a Card against. Before the band was
  // reserved this covered 24px of a 58.4px Card, erasing its bottom border and the lower
  // legs of its 3px focus outline. Asserted in both states, because the band has two homes.
  for (const [label, armFirst] of [
    ['Panel closed', false],
    ['Panel pinned open', true],
  ] as const) {
    test(`658×320 (${label}): the scroll fade never covers a focused Card`, async ({ page }) => {
      await gotoAt(page, PHONE);
      if (armFirst) await armByHotkey(page, '1');
      const covered: number[] = [];
      for (let i = 0; i < 9; i++) {
        await page.locator('.wy-card').nth(i).focus();
        await settleRailScroll(page);
        covered.push(
          await page.evaluate((n) => {
            const rail = document.querySelector('.wy-rail') as HTMLElement;
            const card = (
              document.querySelectorAll('.wy-card')[n] as HTMLElement
            ).getBoundingClientRect();
            const panel = document.querySelector('.wy-panel') as HTMLElement;
            const pinned = !panel.hidden && getComputedStyle(panel).position === 'sticky';
            // Read the PAINTED pseudo-element, never the token. `--wy-rail-fade-h` is an
            // unregistered custom property, so `getComputedStyle` returns the literal token
            // stream "1.5rem" and `parseFloat` keeps the 1.5 while silently dropping the
            // unit — a 16x under-measure that made this assertion unfailable.
            const band = pinned
              ? getComputedStyle(panel, '::before')
              : getComputedStyle(rail, '::after');
            // A band at `opacity: 0` paints nothing, so it occludes nothing. Not a
            // convenience: at maximum scroll the last Card's bottom sits inside the band's
            // geometry while `wy-rail-has-more` is false, so measuring geometry alone would
            // report a defect where no pixel is drawn.
            if (band.opacity === '0' || band.display === 'none') return 0;
            const fadeH = parseFloat(band.height);
            // The occluding band rides the Panel's top edge when pinned, and the Rail's own
            // CONTENT-box bottom otherwise — not the scrollport's. Unpinned the band is a
            // flex item, so it is laid out inside the padding, and reading
            // `rail.bottom` put this measurement 8px too low: the exact width of the overlap
            // it exists to catch, which is how a reserve short by the Rail's bottom padding
            // held nine zeroes here while 7.6px of Cards 3 and 6 painted under the gradient.
            const bandBottom = pinned
              ? panel.getBoundingClientRect().top
              : rail.getBoundingClientRect().bottom -
                parseFloat(getComputedStyle(rail).paddingBottom);
            return Math.max(
              0,
              Math.min(card.bottom, bandBottom) - Math.max(card.top, bandBottom - fadeH),
            );
          }, i),
        );
      }
      expect(covered, 'no focused Card may sit under the fade band').toEqual(
        Array.from({ length: 9 }, () => 0),
      );
    });
  }

  test('658×320: the scroll affordance appears only while Cards remain below', async ({ page }) => {
    await gotoAt(page, PHONE);
    const rail = page.locator('.wy-rail');
    // At rest, with five of nine Cards below a 0px-scrollbar-gutter fold.
    await expect(rail).toHaveClass(/wy-rail-has-more/);
    const fadeAt = () =>
      page.evaluate(
        () =>
          getComputedStyle(document.querySelector('.wy-rail') as HTMLElement, '::after').opacity,
      );
    expect(await fadeAt()).toBe('1');

    // At the end of the scroll there is nothing below, so the affordance must go.
    await page.evaluate(() => {
      const r = document.querySelector('.wy-rail') as HTMLElement;
      r.scrollTop = r.scrollHeight;
    });
    await expect(rail).not.toHaveClass(/wy-rail-has-more/);
    expect(await fadeAt(), 'the fade must be gone at the end of the scroll').toBe('0');

    // And it returns on the way back up.
    await page.evaluate(() => ((document.querySelector('.wy-rail') as HTMLElement).scrollTop = 0));
    await expect(rail).toHaveClass(/wy-rail-has-more/);

    // Opening the Panel does not disturb it, and the fade then rides the PANEL's top edge
    // rather than the Rail's — the Rail's own edge is occupied.
    await armByHotkey(page, '1');
    await expect(rail).toHaveClass(/wy-rail-has-more/);
    const placement = await page.evaluate(() => {
      const panel = document.querySelector('.wy-panel') as HTMLElement;
      const before = getComputedStyle(panel, '::before');
      return { opacity: before.opacity, height: before.height };
    });
    expect(placement.opacity, "the Panel's own fade must be showing").toBe('1');
    expect(parseFloat(placement.height)).toBeGreaterThan(0);
  });

  test('658×320: the Rail at rest is untouched — the affordance costs no scroll extent and no Card', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    const m = await page.evaluate(() => {
      const rail = document.querySelector('.wy-rail') as HTMLElement;
      const rr = rail.getBoundingClientRect();
      return {
        cardsFullyVisible: [...document.querySelectorAll('.wy-card')].filter((c) => {
          const b = c.getBoundingClientRect();
          return b.top >= rr.top - 0.5 && b.bottom <= rr.bottom + 0.5;
        }).length,
        overflow: rail.scrollHeight - rail.clientHeight,
        panelHidden: (document.querySelector('.wy-panel') as HTMLElement).hidden,
        contentEndsAtLastChild: (() => {
          const kids = [...rail.children] as HTMLElement[];
          const last = kids.filter((k) => !k.hidden).at(-1) as HTMLElement;
          const padBottom = parseFloat(getComputedStyle(rail).paddingBottom);
          return (
            Math.abs(rail.scrollHeight - (last.offsetTop + last.offsetHeight + padBottom)) <= 1
          );
        })(),
      };
    });
    expect(m.panelHidden, 'at rest means Panel closed').toBe(true);
    // Reachability floor: browsing must not get worse than it already was. Measured before
    // the story at this viewport: 4 Cards, 358px of overflow.
    expect(
      m.cardsFullyVisible,
      'at-rest Card reachability must not regress',
    ).toBeGreaterThanOrEqual(4);
    // The fade cancels its own box AND the flex gap before it, so the quantity the
    // has-more computation reads is the same one it read before the affordance existed —
    // otherwise the fade would become a reason the fade is shown. Asserted as the INVARIANT
    // rather than as the 358px this happens to measure today: a pixel total would break on
    // any legitimate Card-height change while saying nothing about the property. The
    // scrollable content must end exactly at the last REAL child plus the Rail's own bottom
    // padding, leaving no room for a pseudo-element to have contributed.
    expect(m.contentEndsAtLastChild, 'the affordance must not add scroll extent').toBe(true);
  });

  // The scrollport's tab stop is revoked when it stops overflowing — but revoking
  // `tabindex` from the FOCUSED element makes it unfocusable, and Chromium then resets
  // focus to `<body>`. A keyboard user reading a pinned Panel through a window resize would
  // lose their place and Tab from the top of the document.
  test('a resize that un-pins the Panel never drops focus out of a focused scrollport', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    await armByHotkey(page, '9'); // frost-splash — dense enough that the scrollport overflows
    const scroller = page.locator('.wy-panel-scroll');
    await expect(scroller).toHaveAttribute('tabindex', '0');
    await scroller.focus();
    expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain(
      'wy-panel-scroll',
    );

    // Widen past the pin: the Panel un-pins, the cap lifts, the scrollport stops overflowing
    // — and the revoke path runs with focus still inside it.
    await page.setViewportSize({ width: 1000, height: 720 });
    await expect(page.locator('.wy-panel')).toBeVisible();
    // Wait on the REVOKE, not on the clock. The 200ms this replaced was a bet on how fast
    // the ResizeObserver fires and the revoke path runs, which is machine- and engine-
    // dependent — the one flake candidate in this suite. The un-pin is the observable
    // state change that says the path has run.
    await expect
      .poll(async () =>
        page.evaluate(
          () => getComputedStyle(document.querySelector('.wy-panel') as HTMLElement).position,
        ),
      )
      .toBe('static');
    expect(
      await page.evaluate(() => document.activeElement?.className ?? ''),
      'focus must not fall to document.body',
    ).toContain('wy-panel-scroll');
  });

  // The other half of the retention rule. Keeping the tab stop while the scrollport holds
  // focus is only correct if something releases it once focus leaves — and neither scroll,
  // resize nor render is guaranteed to follow the click that moves focus away, so without a
  // focus trigger the non-scrollable element sat in the tab order for the rest of the
  // session as a stop that scrolls nothing.
  test('the retained tab stop is released once focus leaves the scrollport', async ({ page }) => {
    await gotoAt(page, PHONE);
    await armByHotkey(page, '9');
    const scroller = page.locator('.wy-panel-scroll');
    await expect(scroller).toHaveAttribute('tabindex', '0');
    await scroller.focus();

    // Un-pin: the cap lifts, the scrollport stops overflowing, and the stop is RETAINED
    // because releasing it here would drop focus to `<body>`.
    await page.setViewportSize({ width: 1000, height: 720 });
    await expect
      .poll(async () =>
        page.evaluate(
          () => getComputedStyle(document.querySelector('.wy-panel') as HTMLElement).position,
        ),
      )
      .toBe('static');
    await expect(
      scroller,
      'retained while focused — releasing it would drop focus',
    ).toHaveAttribute('tabindex', '0');

    // Now move focus OUT OF THE RAIL entirely — to the board. Deliberately not to a Card:
    // focusing a Card scrolls it into view, which fires the scroll trigger and would revoke
    // the stop for a reason that has nothing to do with focus, leaving this test green with
    // the focus trigger deleted. Focus landing outside the Rail scrolls nothing, so the
    // focusout listener is the only thing that can release it.
    const scrollBefore = await page.evaluate(
      () => (document.querySelector('.wy-rail') as HTMLElement).scrollTop,
    );
    await page.locator('.wy-board').focus();
    expect(
      await page.evaluate(() => (document.querySelector('.wy-rail') as HTMLElement).scrollTop),
      'this step must not scroll the Rail — that would be a different trigger releasing it',
    ).toBe(scrollBefore);
    await expect(scroller, 'released once focus leaves the Rail').not.toHaveAttribute('tabindex');
  });

  // STANDARD, Panel OPEN — the state every other fade assertion here misses. The others run
  // with the Panel closed or in the pinned arms, and the pinned arms have `.wy-panel::before`
  // to fall back on. Outside them there is no fallback, so if the Panel outranks the Rail's
  // own band the cue simply vanishes at the one moment it exists for.
  //
  // Asserted on the PAINTED PIXEL, not on the cascade. The defect this catches was invisible
  // to every computed-style check: `wy-rail-has-more` was true and `::after` resolved to
  // `opacity: 1` while nothing was drawn, because a flex item with a z-index other than
  // `auto` forms a stacking context and joins paint order even at `position: static`.
  test('1000×720 Standard, Panel open: the Rail fade is actually PAINTED over the Cards', async ({
    page,
  }) => {
    await gotoAt(page, { width: 1000, height: 720 });
    // Repaint the band in a colour no part of this UI uses, so one pixel is decisive.
    await page.addStyleTag({
      content: '.wy-rail::after { background: rgb(255, 0, 0) !important; }',
    });
    await armByHotkey(page, '1');
    await page.evaluate(
      () => ((document.querySelector('.wy-rail') as HTMLElement).scrollTop = 200),
    );
    await settleRailScroll(page);

    const state = await page.evaluate(() => {
      const rail = document.querySelector('.wy-rail') as HTMLElement;
      const panel = document.querySelector('.wy-panel') as HTMLElement;
      const rr = rail.getBoundingClientRect();
      const after = getComputedStyle(rail, '::after');
      return {
        panelPosition: getComputedStyle(panel).position,
        panelZIndex: getComputedStyle(panel).zIndex,
        hasMore: rail.classList.contains('wy-rail-has-more'),
        opacity: after.opacity,
        belowFold: rail.scrollHeight - rail.clientHeight - rail.scrollTop,
        x: Math.round(rr.left + rr.width / 2),
        y: Math.round(rr.bottom - parseFloat(after.height) / 2),
      };
    });
    // Preconditions — without these the pixel proves nothing.
    expect(state.panelPosition, 'this viewport must be the UNPINNED branch').toBe('static');
    expect(state.belowFold, 'there must be content below the fold').toBeGreaterThan(0);
    expect(state.hasMore).toBe(true);
    expect(state.opacity).toBe('1');
    // The mechanism, so a regression names itself: an unpinned Panel must not form a
    // stacking context that outranks the band.
    expect(state.panelZIndex, 'an unpinned Panel must not outrank the Rail fade').toBe('auto');

    const shot = await page.screenshot({ clip: { x: state.x, y: state.y, width: 1, height: 1 } });
    const px = PNG.sync.read(shot);
    expect(
      [px.data[0], px.data[1], px.data[2]],
      'the fade must be painted, not merely opaque in the cascade',
    ).toEqual([255, 0, 0]);
  });

  // The keyboard path the `focusout` trigger alone does not complete. Retention exists for
  // ONE hazard — revoking `tabindex` from the focused element drops focus to `<body>` — and
  // that hazard ends the moment focus moves to a DESCENDANT. Tab from the container reaches
  // the Sell button inside it; if the guard treats that as "still inside", the obsolete stop
  // survives and Shift+Tab lands right back on a container that no longer scrolls.
  test('tabbing from the retained scrollport into its own Sell button releases the stop', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    // A SELECTION, not an arm: the action row only exists here, and it is the descendant the
    // guard has to distinguish from a real departure.
    await page.getByRole('button', { name: /Basic Tower/ }).click();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    const sell = page.locator('.wy-panel').getByRole('button', { name: /^Sell/ });
    await expect(sell).toBeVisible();

    const scroller = page.locator('.wy-panel-scroll');
    await expect(scroller).toHaveAttribute('tabindex', '0');
    await scroller.focus();

    // Widen past the pin: the cap lifts, the scrollport stops overflowing, and the stop is
    // RETAINED because revoking it here would drop focus to the document body.
    await page.setViewportSize({ width: 1000, height: 720 });
    await expect
      .poll(async () =>
        page.evaluate(
          () => getComputedStyle(document.querySelector('.wy-panel') as HTMLElement).position,
        ),
      )
      .toBe('static');
    await expect(scroller, 'retained while the container itself is focused').toHaveAttribute(
      'tabindex',
      '0',
    );

    // Move focus into the scrollport's own child WITHOUT scrolling. `preventScroll` is what
    // makes this test bite: an ordinary Tab scrolls the Sell button into view (measured: the
    // Rail jumps 187 -> 406), and that scroll fires the scroll trigger, which revokes the stop
    // on its own. A Tab-based assertion therefore passes with this guard deleted — it proves
    // only that SOMETHING released the stop, not that focus movement did.
    const railTopBefore = await page.evaluate(
      () => (document.querySelector('.wy-rail') as HTMLElement).scrollTop,
    );
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.wy-panel-scroll button')].find((b) =>
        /^Sell/.test(b.textContent ?? ''),
      ) as HTMLElement;
      btn.focus({ preventScroll: true });
    });
    expect(
      await page.evaluate(() => (document.querySelector('.wy-rail') as HTMLElement).scrollTop),
      'no scroll may occur — otherwise the scroll trigger, not focus, explains the release',
    ).toBe(railTopBefore);
    await expect(sell, 'focus must land on the child, not fall to the body').toBeFocused();
    await expect(scroller, 'the obsolete stop must be released').not.toHaveAttribute('tabindex');

    // And the realistic path still behaves: Shift+Tab back out must not land on a phantom
    // stop, which is the symptom this whole guard exists to prevent.
    await page.keyboard.press('Shift+Tab');
    await expect(scroller, 'the container must not be a tab stop any more').not.toHaveAttribute(
      'tabindex',
    );
  });

  // The two-column Rail (>=1280w, aspect >= 16/10) is a GRID, where the fade needs its own
  // construction. It genuinely never overflows at 100% — but it does at 200% text zoom,
  // which this project commits to supporting, and an earlier draft switched the fade off
  // here on the false premise that it never overflows at all.
  test('1440x900 two-column: the fade is absent at 100% and present at 200% zoom', async ({
    page,
  }) => {
    await gotoAt(page, { width: 1440, height: 900 });
    const rail = page.locator('.wy-rail');
    const state = () =>
      page.evaluate(() => {
        const r = document.querySelector('.wy-rail') as HTMLElement;
        const after = getComputedStyle(r, '::after');
        return {
          columns: getComputedStyle(r).gridTemplateColumns.split(' ').length,
          overflow: r.scrollHeight - r.clientHeight,
          hasMore: r.classList.contains('wy-rail-has-more'),
          display: after.display,
          opacity: after.opacity,
        };
      });

    const at100 = await state();
    expect(at100.columns, 'this viewport must actually be the two-column Rail').toBe(2);
    // Swept across the two-column band, not measured once: the 0.5rem this fade costs can
    // only bite in the `overflow in (0, 8px]` regime, so a single height would leave the
    // property the CSS comment leans on ungated.
    for (const h of [501, 620, 760, 900]) {
      await page.setViewportSize({ width: 1440, height: h });
      const s = await state();
      expect(s.columns, `1440x${h} must still be two-column`).toBe(2);
      expect(s.overflow, `1440x${h} must not overflow at 100%`).toBe(0);
      expect(s.hasMore, `1440x${h} must show no cue`).toBe(false);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // The fade costs 0.5rem of scroll extent here (a grid track clamps at zero where a flex
    // line does not), so the load-bearing assertion is that it never becomes its own cause.
    expect(at100.overflow, 'the two-column Rail must not overflow at 100%').toBe(0);
    expect(at100.hasMore, 'no cue where there is nothing below').toBe(false);
    expect(at100.opacity).toBe('0');

    await page.addStyleTag({ content: ':root { font-size: 200% }' });
    await expect(rail).toHaveClass(/wy-rail-has-more/);
    const at200 = await state();
    expect(at200.overflow, 'the two-column Rail DOES overflow at 200%').toBeGreaterThan(0);
    // The box must be GENERATED, not merely opaque — `display: none` here was the defect.
    expect(at200.display, 'the fade must exist as a box in the grid').not.toBe('none');
    expect(at200.opacity, 'and be painted').toBe('1');
  });

  for (const [label, size] of [
    ['658×320', PHONE],
    ['568×320', NARROW],
  ] as const) {
    test(`${label}: axe is clean with the pinned Panel both open and closed`, async ({ page }) => {
      await gotoAt(page, size);
      const closed = await new AxeBuilder({ page }).include('#app').analyze();
      expect(closed.violations, 'Panel closed').toEqual([]);
      await armByHotkey(page, '9');
      const open = await new AxeBuilder({ page }).include('#app').analyze();
      expect(open.violations, 'Panel open').toEqual([]);
    });
  }
});
