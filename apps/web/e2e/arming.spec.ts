import { test, expect, type Page } from '@playwright/test';
import { createProjection } from '@wynding/render';
import { FOCUS_RGB, GRID, edgeColours, type Rect } from './layout-probe';

// arming.spec.ts — the ARMED state's chrome, measured in a real browser (#69). Pressing a
// tower hotkey does three things at once — focuses the board, amber-borders the armed Card,
// and opens the Panel — and the two defects this file pins lived exactly there:
//
//  1. The board's focus ring was drawn OUTSIDE a border box that is flush with the
//     viewport's left and bottom edges, so those two segments clipped off-screen and a
//     keyboard user saw a top+right L that read as broken chrome (`ui.css` now draws it as
//     an inset `::after` ring stacked above the canvas). Only rendered pixels can prove
//     this: jsdom performs no layout, the DOM exposes no ring geometry, and axe does not
//     evaluate ring clipping.
//
//  2. The Cards flex-squashed toward their explicit 44px `min-height` (an explicit
//     `min-height` REPLACES the flex auto-minimum) whenever the Rail over-filled — which
//     the nine-Card catalog already does at Standard's default height before any Panel
//     opens, and the opening Panel made worse — pushing the hotkey badge outside its
//     Card's border box. The Rail is a scrollport; it must absorb overflow by scrolling,
//     never by squashing. Auto-scroll is keyed on intent (`UiState.inspectSeq`): only a
//     pointer click that lands on a tower reveals the Panel — arming, placing, and
//     keyboard cursor-steps never move the Rail (`touch.spec.ts` pins the tap-toggle and
//     the cached-Card-position-across-a-placement contracts on Compact).

const STANDARD = { width: 1280, height: 720 };

async function gotoStandard(page: Page): Promise<void> {
  await page.setViewportSize(STANDARD);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
}

test.describe('arming via hotkey — Standard layout', () => {
  test('1280×720: the board focus ring renders COMPLETE on all four sides', async ({ page }) => {
    await gotoStandard(page);

    // Baseline: no ring before arming — otherwise the assertions below could pass against a
    // board that is simply painted amber at its edges. Midpoints are the sampling points on
    // both sides of the baseline/armed pair (the `.wy-home` precedent): the ring's failure
    // modes here are whole missing segments, which any on-edge point detects.
    for (const [side, colour] of Object.entries(await edgeColours(page, '.wy-board'))) {
      expect(colour, `board ${side} edge is already focus-coloured before arming`).not.toBe(
        FOCUS_RGB,
      );
    }

    // The #69 repro: `1` arms the Basic Tower and the handler moves focus to the board
    // programmatically — which Chromium's last-input-modality heuristic (the input WAS a
    // keypress) resolves to `:focus-visible`, exactly the path the defect shipped on.
    await page.keyboard.press('1');
    await expect(page.locator('.wy-card[aria-pressed="true"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain(
      'wy-board',
    );

    for (const [side, colour] of Object.entries(await edgeColours(page, '.wy-board'))) {
      expect(
        colour,
        `the board focus ring ${side.toUpperCase()} segment is missing or clipped`,
      ).toBe(FOCUS_RGB);
    }
  });

  test('1280×720: the opening Panel scrolls the Rail — Cards keep their badges inside', async ({
    page,
  }) => {
    await gotoStandard(page);

    const cardGeometry = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.wy-card')].map((card) => {
          const badge = card.querySelector('.wy-card-hotkey');
          return {
            overflowPx: card.scrollHeight - card.clientHeight,
            badgeBelowPx:
              badge === null
                ? 0
                : badge.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom,
          };
        }),
      );

    // Pre-arm baseline: nine Cards (the shipped catalog — a count change is a signal, not
    // noise: the squash arithmetic below depends on the Rail over-filling), none internally
    // overflowing, every badge inside its Card's border box. Before the fix this baseline
    // already failed at 720px tall — the nine Cards alone over-filled the Rail and squashed
    // without any Panel's help.
    const before = await cardGeometry();
    expect(before).toHaveLength(9);
    for (const [i, g] of before.entries()) {
      expect(g.overflowPx, `card ${i + 1} overflows internally before arming`).toBeLessThanOrEqual(
        1,
      );
      expect(
        g.badgeBelowPx,
        `card ${i + 1}'s hotkey badge is outside its Card before arming`,
      ).toBeLessThanOrEqual(0.5);
    }

    await page.keyboard.press('1');
    await expect(page.locator('.wy-panel')).toBeVisible();

    // The squash pin: with the Panel open, every Card still holds its content.
    for (const [i, g] of (await cardGeometry()).entries()) {
      expect(g.overflowPx, `card ${i + 1} squashed by the open Panel`).toBeLessThanOrEqual(1);
      expect(
        g.badgeBelowPx,
        `card ${i + 1}'s hotkey badge pushed outside by the open Panel`,
      ).toBeLessThanOrEqual(0.5);
    }

    // The Rail took the overflow the honest way — internal scroll…
    const rail = await page.evaluate(() => {
      const el = document.querySelector('.wy-rail') as HTMLElement;
      return { scrollable: el.scrollHeight > el.clientHeight, scrollTop: el.scrollTop };
    });
    expect(rail.scrollable, 'the Rail should overflow internally with the Panel open').toBe(true);
    // …and arming did NOT auto-scroll it: the Card the player just tapped (or hotkeyed)
    // must stay under the pointer, so tap-again-to-disarm keeps hitting the same Card —
    // `touch.spec.ts` pins the toggle on Compact, this pins the no-scroll at Standard. The
    // armed Card's highlight and the board's focus ring are the armed feedback; a pointer
    // INSPECT of a placed tower is what auto-reveals the Panel (next test).
    expect(rail.scrollTop, 'arming must not scroll the Rail').toBe(0);
  });

  test('1280×720: ONLY a pointer inspect reveals the Panel — placement and cursor-steps never scroll', async ({
    page,
  }) => {
    await gotoStandard(page);

    const railScrollTop = () =>
      page.evaluate(() => (document.querySelector('.wy-rail') as HTMLElement).scrollTop);

    // Arm, then place via the keyboard cursor at (3,3) — smoke.spec's well-known buildable
    // cell, the same arrow walk.
    await page.keyboard.press('1');
    await expect(page.locator('.wy-panel')).toBeVisible();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();

    // The placement's auto-selection is a BUILD act and must not have scrolled the Rail:
    // the builder's next move is usually another Card, and `touch.spec.ts` pins that a
    // Card's cached position stays valid across a placement.
    expect(await railScrollTop(), 'a placement must not scroll the Rail').toBe(0);

    // Deselect, then step the keyboard cursor off the tower and back ONTO it. The cursor
    // SELECTS every tower it lands on (`aimAt`) — and held-arrow auto-repeat would re-fire
    // per step — so cursor navigation must not scroll the Rail either.
    await page.keyboard.press('Escape');
    await expect(page.locator('.wy-panel')).toBeHidden();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();
    expect(await railScrollTop(), 'a cursor-step selection must not scroll the Rail').toBe(0);

    // Now the deliberate act: a pointer click on the tower. Same selection, so the Panel
    // subtree doesn't even rebuild — the reveal keys on `UiState.inspectSeq`, not on a
    // panel-state transition — and the Rail scrolls until the Panel's heading is in view.
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
    // Polled: with the selection unchanged the Panel subtree never rebuilds, so no locator
    // state flip gates the reveal frame — the scroll is the observable.
    await expect
      .poll(railScrollTop, { message: 'a pointer inspect must scroll the Rail' })
      .toBeGreaterThan(0);
    // Heading-visible is the invariant. At this viewport the Panel FITS the scrollport, so
    // the top-align clamps to end-of-Rail and coincides with a naive scroll-to-end —
    // `compact.spec.ts`, where the Panel is TALLER than the scrollport, is the case that
    // discriminates the two (do not trim that one as "redundant" with this).
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
