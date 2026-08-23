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
//     never by squashing.
//
// AUTO-SCROLL IS KEYED ON INTENT, AND THERE ARE EXACTLY TWO INTENTS (#145): a POINTER
// INSPECT — a click that lands on a tower (`UiState.inspectSeq`) — or an ARM WHILE THE PIN
// IS INACTIVE. Everything else still moves nothing: placing, keyboard cursor-steps, and
// arming where the Panel IS pinned (Compact, and any narrow Rail — `revealPanel()` early-
// returns there, which is what keeps `touch.spec.ts`'s tap-toggle and its
// cached-Card-position-across-a-placement contracts intact on Compact).
//
// The arm half is NEW, and this file's 1000×720 case is written around it rather than
// against it. Before #145 that case read "ONLY a pointer inspect reveals the Panel", and
// the reason it could was that arming revealed NOWHERE — which on ordinary desktop windows
// (~980–1279px, where neither pin arm matches) meant arming showed the player zero pixels
// of the Panel it opened: at 1000×720 the Panel's flow offset was 750px inside a 676px
// scrollport, byte-for-byte the defect `m2.md` item 12 describes. The invariant that
// survives — and that the rewritten phases below still pin — is that a PLACEMENT must not
// scroll: it is measured as a delta from the post-arm baseline rather than from zero.

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

  test('1366×768: all nine Cards AND the open Panel fit the Rail — nothing squashes, nothing scrolls', async ({
    page,
  }) => {
    // The smallest mainstream laptop viewport, inside the two-column gate (aspect 1.78)
    // with real slack: at 1280×720 the fit holds by single-digit pixels that move with
    // the platform font stack (the home.spec recalibration saga's lesson), so the pin
    // lives where it cannot flap.
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');
    await expect(page.locator('.wy-board')).toBeVisible();

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

    // The playtest-round requirement, pinned literally: with the two-column Rail active
    // (this viewport clears the width gate) every Card AND the open Panel sit fully inside
    // the Rail's own box — the shop never scrolls off the screen.
    const fit = await page.evaluate(() => {
      const rail = (document.querySelector('.wy-rail') as HTMLElement).getBoundingClientRect();
      const inside = (r: DOMRect): boolean => r.top >= rail.top - 1 && r.bottom <= rail.bottom + 1;
      return {
        cardsInside: [...document.querySelectorAll('.wy-card')].map((c) =>
          inside(c.getBoundingClientRect()),
        ),
        panelInside: inside(
          (document.querySelector('.wy-panel') as HTMLElement).getBoundingClientRect(),
        ),
        scrollTop: (document.querySelector('.wy-rail') as HTMLElement).scrollTop,
      };
    });
    expect(fit.cardsInside, 'every Card fully inside the Rail with the Panel open').toEqual(
      Array.from({ length: 9 }, () => true),
    );
    expect(fit.panelInside, 'the open Panel fully inside the Rail').toBe(true);
    // And arming did not auto-scroll: the Card the player just tapped (or hotkeyed) must
    // stay under the pointer — `touch.spec.ts` pins the toggle on Compact; here nothing
    // overflows so nothing COULD scroll, and the single-column reveal semantics are
    // pinned at a narrower viewport in the next test.
    expect(fit.scrollTop, 'arming must not scroll the Rail').toBe(0);

    // The swatches actually PAINTED — their unit seam is deliberately null-context inert
    // (vitest.setup.ts), so this is the one gate that proves the real canvas path runs.
    // Sampled on the SLOW card (index 1), whose 'ringed' mark strokes the ground colour
    // back INSIDE the body — witnessing that the shared dispatch ran, which the mark-less
    // basic tile could never do (its ground + body survive a dispatch deletion).
    const swatch = await page.evaluate(() => {
      const canvas = document.querySelectorAll('.wy-card-swatch')[1] as HTMLCanvasElement;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return null;
      const { width: w, height: h } = canvas;
      const data = ctx.getImageData(0, 0, w, h).data;
      const px = (x: number, y: number): string => {
        const i = (y * w + x) * 4;
        return `${data[i]},${data[i + 1]},${data[i + 2]}`;
      };
      const colours = new Set<string>();
      for (let i = 0; i < data.length; i += 4)
        colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      const ground = px(1, 1);
      // The ring crosses the centre row at cx ± 0.22·size — scan the middle band for a
      // ground-coloured pixel INSIDE the body (the stroke's core beats antialiasing).
      let markPixel = false;
      const cy = Math.floor(h / 2);
      for (let x = Math.floor(w * 0.25); x < Math.floor(w * 0.75); x++) {
        if (px(x, cy) === ground) {
          markPixel = true;
          break;
        }
      }
      return { colours: colours.size, markPixel };
    });
    expect(swatch, 'a real browser must hand the swatch a 2D context').not.toBeNull();
    expect(
      swatch!.colours,
      'the glyph swatch must be painted (ground + body at minimum)',
    ).toBeGreaterThanOrEqual(2);
    expect(
      swatch!.markPixel,
      "slow's ring must stroke the ground colour inside the body — the dispatch ran",
    ).toBe(true);
  });

  test('1000×720: an ARM and a pointer inspect reveal the Panel — placement and cursor-steps never scroll', async ({
    page,
  }) => {
    // 1000px sits UNDER the two-column width gate, so this is the single-column Rail —
    // the shape that still overflows and therefore still owns the scroll + reveal
    // machinery this test pins. (At two-column widths everything fits and the reveal is
    // a clamped no-op — the previous test pins that world.)
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.goto('/');
    await expect(page.locator('.wy-board')).toBeVisible();

    const railScrollTop = () =>
      page.evaluate(() => (document.querySelector('.wy-rail') as HTMLElement).scrollTop);

    /** Where the Panel's heading sits relative to the Rail's scrollport, in page px. */
    const headingVsRail = () =>
      page.evaluate(() => {
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

    // PHASE 1 — ARM. This viewport is unpinned Standard, so the arm itself must reveal
    // (#145). Asserted from `railScrollTop === 0`: `.click()`ing a below-the-fold Card would
    // auto-scroll the Rail on its own and let this pass with the defect fully intact, which
    // is exactly how the 224px figure in S12a's plan came to be wrong.
    expect(await railScrollTop(), 'the Rail must start unscrolled, or the arm proves nothing').toBe(
      0,
    );
    await page.keyboard.press('1');
    await expect(page.locator('.wy-panel')).toBeVisible();
    await expect
      .poll(railScrollTop, { message: 'an arm must scroll the Rail where the pin is inactive' })
      .toBeGreaterThan(0);
    // The SAME heading-visible invariant the inspect case pins below — the scroll is a means,
    // a readable Panel heading is the end.
    const armed = await headingVsRail();
    expect(
      armed.top,
      "the armed Panel's heading must not sit above the scrollport",
    ).toBeGreaterThanOrEqual(armed.railTop - 1);
    expect(
      armed.bottom,
      "the armed Panel's heading must be inside the scrollport",
    ).toBeLessThanOrEqual(armed.railBottom + 1);

    // PHASE 2 — PLACE, via the keyboard cursor at (3,3), smoke.spec's well-known buildable
    // cell and the same arrow walk. The placement's auto-selection is a BUILD act and must
    // not scroll: the builder's next move is usually another Card, and `touch.spec.ts` pins
    // that a Card's cached position stays valid across a placement. Measured as a DELTA from
    // the post-arm baseline rather than against zero — the arm legitimately moved the Rail,
    // and "a placement must not scroll" is a statement about the placement, not about where
    // the Rail happened to be.
    const afterArm = await railScrollTop();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();
    expect(await railScrollTop(), 'a placement must not scroll the Rail').toBe(afterArm);

    // PHASE 3 — CURSOR-STEP, the same assertion as before against the same baseline of 0.
    // Deselect, then step the keyboard cursor off the tower and back ONTO it. The cursor
    // SELECTS every tower it lands on (`aimAt`) — and held-arrow auto-repeat would re-fire
    // per step — so cursor navigation must not scroll the Rail either.
    //
    // REWOUND FIRST, because the arm in phase 1 legitimately left the Rail scrolled and the
    // engine's own bookkeeping would otherwise be mistaken for a scroll. Measured 2026-08-22,
    // Chromium: with the Rail at 306 the Escape below hides the Panel, shrinking max scroll to
    // 74 and CLAMPING the reading to 74 — then re-selecting restores the content height and
    // `scrollTop` returns to 306, having never been overwritten. A delta from the post-Escape
    // reading therefore reports +232px of "scroll" that no code performed. Rewinding removes
    // the confound instead of tolerating it: the property under test is whether the STEPS move
    // the Rail, and from 0 they must leave it at 0 — exactly what this asserted pre-#145.
    await page.keyboard.press('Escape');
    await expect(page.locator('.wy-panel')).toBeHidden();
    await page.evaluate(() => ((document.querySelector('.wy-rail') as HTMLElement).scrollTop = 0));
    expect(await railScrollTop(), 'the cursor-steps must be measured from a rewound Rail').toBe(0);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();
    expect(await railScrollTop(), 'a cursor-step selection must not scroll the Rail').toBe(0);

    // PHASE 4 — POINTER INSPECT, unchanged. Same selection, so the Panel subtree doesn't even
    // rebuild — the reveal keys on `UiState.inspectSeq`, not on a panel-state transition —
    // and the Rail scrolls until the Panel's heading is in view.
    const box = (await page.locator('.wy-board').boundingBox()) as Rect;
    const projection = createProjection({
      cols: GRID.cols,
      rows: GRID.rows,
      cssWidth: box.width,
      cssHeight: box.height,
      dpr: 1,
    });
    const cell = projection.cellToPixel(3, 3);
    // Rewound to the top FIRST. The arm in phase 1 legitimately left the Rail scrolled, and
    // "the inspect scrolled it" would otherwise be satisfied by that earlier scroll still
    // being there — vacuous. Setting `scrollTop` touches no selection state, so the
    // no-rebuild property this phase depends on is preserved.
    await page.evaluate(() => ((document.querySelector('.wy-rail') as HTMLElement).scrollTop = 0));
    expect(await railScrollTop(), 'the inspect must be measured from a rewound Rail').toBe(0);
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
    const name = await headingVsRail();
    expect(
      name.top,
      "the Panel's heading must not sit above the scrollport",
    ).toBeGreaterThanOrEqual(name.railTop - 1);
    expect(name.bottom, "the Panel's heading must be inside the scrollport").toBeLessThanOrEqual(
      name.railBottom + 1,
    );
  });

  // THE BAND #145 CLOSES, measured as visible Panel PIXELS rather than as a scroll offset —
  // "the Rail moved" is not the player's outcome, "I can see the Panel I just opened" is.
  //
  // 980–1279 is where NEITHER pin arm matches: the container-query arm needs a Rail content
  // box ≤160px (160.4px at 980, 192px at 1279) and the Compact arm needs a viewport ≤500px
  // tall. Every one of these measured 0 visible Panel px on `main`. The boundaries either
  // side are pinned in the same loop precisely so the fix cannot be mistaken for having
  // moved them: 970 is still served by the pin (`position: sticky`), and 1280 by the
  // two-column Rail, where the Panel simply fits.
  //
  // ARMED BY HOTKEY FROM A REWOUND RAIL, always. A Playwright `.click()` on a below-the-fold
  // Card auto-scrolls the Rail to reach it, which reveals the Panel as a side effect — that
  // is how S12a's plan recorded 224px visible at 1000×720 for a case that actually showed 0.
  for (const width of [970, 980, 1000, 1120, 1279, 1280]) {
    test(`${width}×720: arming shows the player real Panel pixels`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      await page.goto('/');
      await expect(page.locator('.wy-board')).toBeVisible();

      await page.evaluate(
        () => ((document.querySelector('.wy-rail') as HTMLElement).scrollTop = 0),
      );
      await page.keyboard.press('9'); // frost-splash — the catalog's tallest Panel
      await expect(page.locator('.wy-panel')).toBeVisible();

      const visible = async (): Promise<number> =>
        page.evaluate(() => {
          const rail = (document.querySelector('.wy-rail') as HTMLElement).getBoundingClientRect();
          const panel = (
            document.querySelector('.wy-panel') as HTMLElement
          ).getBoundingClientRect();
          return Math.max(0, Math.min(rail.bottom, panel.bottom) - Math.max(rail.top, panel.top));
        });
      // Polled: where the reveal scrolls, the Panel subtree is already built and visible
      // before the scroll lands, so no locator state flip gates the frame being measured.
      await expect
        .poll(visible, { message: `${width}×720 shows zero Panel pixels on arm` })
        .toBeGreaterThan(0);

      // And the heading specifically — the "which tower is this?" question the Panel exists
      // to answer. A sliver of the Panel's bottom edge is not an answer.
      const heading = await page.evaluate(() => {
        const rail = (document.querySelector('.wy-rail') as HTMLElement).getBoundingClientRect();
        const h = (document.querySelector('.wy-panel-name') as HTMLElement).getBoundingClientRect();
        return { railTop: rail.top, railBottom: rail.bottom, top: h.top, bottom: h.bottom };
      });
      expect(heading.top, 'the heading must not sit above the scrollport').toBeGreaterThanOrEqual(
        heading.railTop - 1,
      );
      expect(heading.bottom, 'the heading must be inside the scrollport').toBeLessThanOrEqual(
        heading.railBottom + 1,
      );
    });
  }
});
