import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  FOCUS_RGB,
  edgeColours,
  intersect,
  projectedGrid,
  regionRect,
  type Rect,
} from './layout-probe';
import { stubFullscreen } from './fullscreen-stub';
import { COMPACT_QUERY } from '../src/layout';

// home.spec.ts — the site home affordance, measured in a REAL browser in BOTH layouts.
//
// Everything geometric about this link is Playwright's to prove: jsdom performs no CSS
// layout, so the unit tests can only assert structure and the stylesheet's source text. The
// two claims that actually matter to a player — "you can hit it" and "it never costs the
// board anything" — only exist as rendered pixels, and that is what is measured here.

const STANDARD = { width: 1280, height: 720 };
const PHONE = { width: 658, height: 320 }; // Galaxy S9+ landscape — the smallest supported
const NARROW = { width: 568, height: 320 }; // iPhone-SE-class narrow floor

/** ADR 0003's interactive-target floor. */
const TARGET_MIN_PX = 44;

/** The Standard status row's expected height once the link's 44px hit box is absorbed into
 *  the row's own padding (ui.css derives this exactly): 44px, up from ≈40.6px — a NET growth
 *  of ≈3.4px OVER THE ROW'S OWN BASELINE CONTENT. The ceiling is what makes this test worth
 *  having: a naive `min-height: 44px` flex item would stack ON TOP OF that growth and take a
 *  further ~19px from the board.
 *
 *  The baseline itself moved at M2-S2 (PLAN.md P3 step 17): the wave chip is now VISIBLE
 *  pre-start (the Start decouple makes its countdown meaningful before Start is ever
 *  pressed) and the wave-preview surface — its own title + entry-list block — sits beside
 *  it, both inside `.wy-hud`. Those two content rows are UNRELATED to the home link under
 *  test here, so the ceiling is recalibrated to (new baseline + the same ~3.4px/nowhere-near
 *  the naive-box-model slack this test exists to catch), not tightened back to the pre-M2-S2
 *  figure. */
/*  RECALIBRATED AT M2-S10, by the same rule the paragraph above states, and the cause is
 *  worth recording because it is a real product side-effect rather than test drift. Ruling 3
 *  added an always-present "leak cost" slot to every wave-preview entry, taking the wave-1
 *  line from `10 x Creep - ground, armor 0, no immunities` to `..., armor 0, leak cost 1, no
 *  immunities`. MEASURED at 1280x720: that string grew 354.5px -> 445.8px inside a 485.8px
 *  preview box, so its horizontal headroom fell from ~27% to ~8%. macOS font metrics still
 *  fit it on ONE line (row 118.0px); CI's Linux metrics do not, so the entry wraps and the
 *  row lands at 158.0px. This is NOT flakiness - it is font-stack-dependent reflow of
 *  legitimately longer text, and it reproduces deterministically on each platform.
 *
 *  The ceiling therefore tracks the WIDER (wrapped) baseline plus the same ~3.4px, so the
 *  test keeps catching what it exists to catch: a naive `min-height: 44px` flex item would
 *  add ~19px on top of the baseline and still breach this. The honest cost: on a font stack
 *  where the entry does NOT wrap, the ceiling carries ~44px of slack, so the guard is
 *  blunter locally than in CI. The 40dvh contract (`.wy-hud`'s own max-height, 232px here)
 *  is unaffected and is still asserted separately above - the row stays well inside it.
 *  FLAGGED FOR S11/S12: if the preview ever gains a seventh field this line wraps on EVERY
 *  platform, and the Standard status row wants a real look rather than a third
 *  recalibration. */
const STANDARD_ROW_MAX_PX = 162;

async function gotoAt(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  // Several tests below press Start; a real fullscreen request would resize the viewport
  // every measurement here is taken against.
  await stubFullscreen(page);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
}

/** The link's rendered rectangle, proven ACTUALLY hittable rather than merely laid out: every
 *  corner (inset 2px) and the centre must hit-test back into `.wy-home`. A box that an
 *  ancestor's `overflow: hidden` clips, or that something else paints over, has a perfectly
 *  respectable `boundingBox()` and is still unreachable — that is the regression this catches. */
async function hitTestedHomeRect(page: Page): Promise<Rect> {
  const box = (await page.locator('.wy-home').boundingBox()) as Rect;
  expect(box, 'the home link has no layout box').not.toBeNull();
  const inset = 2;
  const probes = [
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: box.x + inset, y: box.y + inset },
    { x: box.x + box.width - inset, y: box.y + inset },
    { x: box.x + inset, y: box.y + box.height - inset },
    { x: box.x + box.width - inset, y: box.y + box.height - inset },
  ];
  const hits = await page.evaluate(
    (points) =>
      points.map((p) => Boolean(document.elementFromPoint(p.x, p.y)?.closest('.wy-home'))),
    probes,
  );
  expect(hits, 'every corner and the centre of the home link must hit-test to it').toEqual(
    probes.map(() => true),
  );
  return box;
}

/** The link's live-state attributes plus the computed properties that actually gate
 *  activation. Opacity alone is NOT enough: a fully transparent element still takes clicks
 *  and still holds a tab stop unless `pointer-events`/`inert` say otherwise. */
async function homeInteractivity(page: Page): Promise<{
  live: boolean;
  inert: boolean;
  pointerEvents: string;
  visibility: string;
}> {
  return page.evaluate(() => {
    const el = document.querySelector('.wy-home') as HTMLElement;
    const cs = getComputedStyle(el);
    return {
      live: el.hasAttribute('data-live'),
      inert: el.hasAttribute('inert'),
      pointerEvents: cs.pointerEvents,
      visibility: cs.visibility,
    };
  });
}

/** Assert the link is a legal, unclipped, board-disjoint target at the current viewport. */
async function assertUsableTarget(page: Page): Promise<Rect> {
  const home = await hitTestedHomeRect(page);
  expect(home.width, `home link ${home.width}px wide, below the 44px floor`).toBeGreaterThanOrEqual(
    TARGET_MIN_PX,
  );
  expect(
    home.height,
    `home link ${home.height}px tall, below the 44px floor`,
  ).toBeGreaterThanOrEqual(TARGET_MIN_PX);

  // The whole point of the box model: the hit box may spend the STATUS row's own padding, but
  // it may never reach into the projected playable grid. Measured against the projection (the
  // letterboxed cells), not the stage box — a stage that grew while the grid inside it stayed
  // put is not more playable space.
  const grid = await projectedGrid(page);
  expect(
    intersect(home, grid),
    'the home link must be disjoint from the projected playable grid',
  ).toBeNull();

  // …and it must sit INSIDE the status region it belongs to, so "it only spends chrome" is
  // proven rather than inferred from the disjointness above.
  const status = (await regionRect(page, 'status')) as Rect;
  expect(intersect(home, status), 'the home link must be inside the status region').not.toBeNull();
  expect(home.y).toBeGreaterThanOrEqual(status.y - 1);
  expect(home.y + home.height).toBeLessThanOrEqual(status.y + status.height + 1);
  return home;
}

/** Assert the focus ring renders on ALL FOUR sides at the current viewport.
 *
 *  A rendered-pixel assertion, because nothing else can answer this: `layout.test.ts` can only
 *  read the stylesheet's source text, the DOM exposes no ring geometry, and axe does not
 *  evaluate ring clipping. An outline is ALWAYS painted outside the border edge, and in both
 *  layouts the anchor's border box is flush with something that eats an outside ring —
 *  Standard pins it to exactly the status row (top segment lands off-screen, bottom under the
 *  board canvas); Compact reclaims the column padding so `overflow: hidden` clips the sides.
 *  Both leave a keyboard user on the Shell's FIRST tab stop looking at two lone bars
 *  (WCAG 2.4.7). Sampling all four edges is what makes the symmetry impossible to half-fix:
 *  an earlier `outline-offset: 0` attempt passed every other gate while rendering the exact
 *  defect it claimed to have fixed, and a later Compact-only fix left Standard broken. */
async function assertCompleteFocusRing(page: Page): Promise<void> {
  await page.locator('.wy-home').focus();
  for (const [side, colour] of Object.entries(await edgeColours(page, '.wy-home'))) {
    expect(colour, `the focus ring ${side.toUpperCase()} segment is missing or clipped`).toBe(
      FOCUS_RGB,
    );
  }
}

test.describe('home affordance — Standard layout', () => {
  test('1280×720: a ≥44×44 unclipped target that costs the board ≈3.4px, not ≈19px', async ({
    page,
  }) => {
    await gotoAt(page, STANDARD);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(false);

    // Mark AND wordmark: Standard shows both, as one link.
    await expect(page.locator('.wy-home .wy-mark')).toBeVisible();
    await expect(page.locator('.wy-home .wy-wordmark')).toBeVisible();
    await expect(page.locator('.wy-home')).toHaveAttribute('href', '/');

    await assertUsableTarget(page);

    const status = (await regionRect(page, 'status')) as Rect;
    // The re-derived bound: ADR 0003 commits the whole Standard status row to 40dvh, and the
    // `.wy-hud` cap is what enforces it. Still comfortably inside after the link's growth.
    expect(
      status.height,
      `status row ${status.height}px exceeds its 40dvh bound`,
    ).toBeLessThanOrEqual(STANDARD.height * 0.4);
    // …and the growth is the BOUNDED one the box model promises, not the naive one.
    expect(
      status.height,
      `status row ${status.height}px — the 44px hit box was added to the row instead of` +
        ' being absorbed into its padding',
    ).toBeLessThanOrEqual(STANDARD_ROW_MAX_PX);
  });

  test('1280×720: the focus ring renders COMPLETE on all four sides', async ({ page }) => {
    // The Standard box model pins the anchor's border box to exactly the status row, so an
    // OUTSIDE ring puts its top segment above the viewport and its bottom segment under the
    // board canvas — the mirror image of the Compact clipping, and just as invisible to every
    // non-pixel gate.
    await gotoAt(page, STANDARD);
    await assertCompleteFocusRing(page);
  });

  test('1280×720: hidden after Start — inert and pointer-events:none, not merely transparent', async ({
    page,
  }) => {
    await gotoAt(page, STANDARD);
    expect(await homeInteractivity(page)).toMatchObject({ live: false, inert: false });

    await page.getByRole('button', { name: 'Start' }).click();

    // Interactivity is gone IMMEDIATELY — this is asserted without waiting for the fade,
    // because the fade is exactly the window an opacity-only implementation would leave the
    // link clickable in.
    const live = await homeInteractivity(page);
    expect(live.live).toBe(true);
    expect(live.inert).toBe(true);
    expect(live.pointerEvents).toBe('none');

    // No hit-test reaches it any more (the fade may still be running; the corner probe is
    // about reachability, not paint).
    const box = (await page.locator('.wy-home').boundingBox()) as Rect;
    const reachable = await page.evaluate(
      (p) => Boolean(document.elementFromPoint(p.x, p.y)?.closest('.wy-home')),
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(reachable, 'a hidden home link must not be hit-testable').toBe(false);

    // …and once the fade completes it also leaves the paint/AT tree entirely.
    await expect.poll(async () => (await homeInteractivity(page)).visibility).toBe('hidden');
  });

  test('1280×720: pause → home → Stay leaves the run exactly as it was', async ({ page }) => {
    await gotoAt(page, STANDARD);
    await page.getByRole('button', { name: 'Start' }).click();
    const board = page.locator('.wy-board');

    // Let the run actually advance so "intact" means something, then pause.
    await expect
      .poll(async () => Number(await board.getAttribute('data-sim-tick')))
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.wy-home')).not.toHaveAttribute('data-live', /.*/);

    const tickAtPause = Number(await board.getAttribute('data-sim-tick'));

    // A sentinel that only survives if the document is never replaced. A URL check CANNOT
    // discriminate here: the preview server serves the game at `/`, which is the very href
    // the confirm path navigates to — `expect(page.url()).toContain('/')` would hold whether
    // Stay stayed put or navigated away, so it would report coverage it does not have.
    await page.evaluate(() => {
      (window as unknown as { __wyNoNav?: true }).__wyNoNav = true;
    });

    await page.locator('.wy-home').click();
    const leave = page.locator('.wy-leave');
    await expect(leave).toBeVisible();
    // Initial focus is the SAFE action.
    await expect(leave.locator('.wy-leave-stay')).toBeFocused();

    await leave.locator('.wy-leave-stay').click();
    await expect(leave).toBeHidden();

    // Still on the game, still the SAME run: this exact document is live (no navigation and
    // no reload — either would wipe the sentinel), the sim never rewound, and it is still
    // paused (Stay does not resume — the player resumes deliberately, like every other modal).
    expect(
      await page.evaluate(() => (window as unknown as { __wyNoNav?: true }).__wyNoNav === true),
      'Stay navigated or reloaded the page',
    ).toBe(true);
    await expect(board).toHaveAttribute('data-started', 'true');
    expect(Number(await board.getAttribute('data-sim-tick'))).toBe(tickAtPause);
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  });

  test('1280×720: the open leave dialog contains Tab, and passes an axe scan', async ({ page }) => {
    await gotoAt(page, STANDARD);
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('button', { name: 'Pause' }).click();
    await page.locator('.wy-home').click();
    await expect(page.locator('.wy-leave')).toBeVisible();

    // CONTAINMENT, not a trap. The distinction is the point: this app implements no focus
    // cycle. The modal owner inerts `.wy-shell` and keeps every other dialog hidden, so the
    // browser's own tab order has nowhere else to go — tabbing past the dialog's last control
    // hands focus to the document (and then to browser chrome), never to anything BEHIND the
    // dialog. Asserting a wrap would be asserting a trap that does not exist; what must hold
    // is that no game control is ever reachable while the dialog is up.
    //
    // Walk well past the dialog's two stops, in both directions, and record every landing.
    const landings: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(i < 5 ? 'Tab' : 'Shift+Tab');
      landings.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          if (el === null || el === document.body) return 'document';
          return el.closest('.wy-leave') !== null ? 'dialog' : `ESCAPED:${el.className}`;
        }),
      );
    }
    expect(landings.filter((l) => l.startsWith('ESCAPED'))).toEqual([]);
    // …and the dialog's own controls are genuinely reachable — a "containment" that simply
    // dropped focus into the void on the very first Tab would pass the check above vacuously.
    expect(landings, 'the dialog controls must be tab-reachable').toContain('dialog');

    const results = await new AxeBuilder({ page }).exclude('canvas').analyze();
    expect(results.violations).toEqual([]);
  });

  test('1280×720: after Play-again the link is actionable again (terminal is orientation-only)', async ({
    page,
  }) => {
    await gotoAt(page, STANDARD);
    await page.getByRole('button', { name: 'Start' }).click();
    // Start no longer claims wave 1 (M2-S2, PLAN.md P3 step 15) — early-call it via the
    // morphed primary control so this undefended loss resolves well within the wait below
    // (wave 1's own natural 500-tick countdown alone would otherwise cost ~25s before a
    // single creep even spawns).
    await page.getByRole('button', { name: 'Call wave' }).click();
    const results = page.locator('.wy-results');
    await expect(results).toBeVisible({ timeout: 40_000 });

    // Terminal: the link is visible for orientation, but the results dialog is deliberately
    // non-dismissible and inerts the whole Shell, so it is not a control yet.
    expect((await homeInteractivity(page)).live).toBe(false);
    expect(await page.locator('.wy-shell').getAttribute('inert')).not.toBeNull();

    await results.getByRole('button', { name: 'Play again' }).click();
    await expect(results).toBeHidden();

    // Back to held pre-start → a real, reachable link again.
    expect(await page.locator('.wy-shell').getAttribute('inert')).toBeNull();
    await assertUsableTarget(page);
    expect(await homeInteractivity(page)).toMatchObject({
      live: false,
      inert: false,
      pointerEvents: 'auto',
      visibility: 'visible',
    });
  });
});

test.describe('home affordance — Compact layout (the playfield is sacred)', () => {
  test('658×320: a mark-only in-column button, ≥44×44, unclipped and board-disjoint', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);

    // Mark only — the wordmark text stays hidden exactly as it was before this link existed.
    await expect(page.locator('.wy-home .wy-mark')).toBeVisible();
    await expect(page.locator('.wy-wordmark')).toBeHidden();

    const home = await assertUsableTarget(page);
    // In FLOW at the top of the chrome column: it sits above the chips scrollport, inside the
    // status column, which is why it can never overlap the board rather than merely happening
    // not to. (Disjointness from the grid is asserted inside `assertUsableTarget`.)
    const hud = (await page.locator('.wy-hud').boundingBox()) as Rect;
    expect(
      home.y + home.height,
      'the mark must sit ABOVE the chips scrollport',
    ).toBeLessThanOrEqual(hud.y + 1);
  });

  test('568×320: the narrow floor still yields a legal target', async ({ page }) => {
    await gotoAt(page, NARROW);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);
    await assertUsableTarget(page);
  });

  test('658×320 at 200% text zoom: still ≥44×44, unclipped, and still off the board', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    // The board floor BEFORE zooming, so the comparison below is against a real baseline.
    const before = await projectedGrid(page);

    await page.addStyleTag({ content: ':root { font-size: 200% }' });

    await assertUsableTarget(page);

    // The link must not have eaten the board on the way: the Compact column is a grid track
    // the board never occupies, and the artwork is `min(2.5rem, 100%)`, so a doubled root
    // font-size cannot push it wider than the column it lives in.
    const after = await projectedGrid(page);
    expect(
      after.cellPx,
      `cellPx fell from ${before.cellPx} to ${after.cellPx} under 200% zoom`,
    ).toBeGreaterThanOrEqual(10);
  });

  test('658×320 at 200% text zoom: the mark does not balloon and starve the chips scrollport', async ({
    page,
  }) => {
    // `.wy-status` is a flex COLUMN whose only shrinkable child is `.wy-hud`, so every pixel
    // the home link takes comes straight out of the chips readout — the one thing 200% text
    // zoom exists to make readable. The mark is `min(2.5rem, 100%, 40px)`: without the px cap
    // the `100%` term wins at this zoom (the column track is vw-capped and does not grow with
    // the root font, but 2.5rem does), the anchor renders ~66px instead of 44px, and the
    // scrollport drops from ~71px to ~49px.
    //
    // The existing `smoke.spec.ts` zoom gate cannot catch this: it asserts `.wy-hud` overflows
    // internally (MORE true when it shrinks) and that the last chip is `toBeInViewport()`
    // (true on any non-zero intersection). Measure the actual box instead.
    await gotoAt(page, PHONE);
    await page.addStyleTag({ content: ':root { font-size: 200% }' });

    const box = await page.evaluate(() => {
      const el = (s: string) => document.querySelector(s) as HTMLElement;
      return {
        home: el('.wy-home').getBoundingClientRect().height,
        hud: el('.wy-hud').clientHeight,
      };
    });
    // The link takes the 44px floor it is entitled to, and not a pixel more.
    expect(
      box.home,
      `home link ${box.home}px — the mark ballooned past the 44px floor`,
    ).toBeLessThanOrEqual(TARGET_MIN_PX + 1);
    expect(box.home).toBeGreaterThanOrEqual(TARGET_MIN_PX);
    // …leaving the chips a scrollport worth scrolling: at least one full 200%-zoom chip line.
    expect(
      box.hud,
      `chips scrollport collapsed to ${box.hud}px at 200% zoom`,
    ).toBeGreaterThanOrEqual(64);
  });

  test('568×320 at 200% text zoom: the NARROWEST supported viewport still clears 44×44', async ({
    page,
  }) => {
    // The worst case for the Compact column, and the one the 658-wide zoom test above does
    // NOT reach: the column is `min(4rem, 10vw)`, so on a narrow viewport the vw term wins
    // and the track does NOT grow with the root font — while the column's own rem padding
    // DOES double. At 568px that is a 56.8px track whose internal padding goes from 2 × 4px
    // to 2 × 8px, so the content box shrinks from 48.8px to 40.8px and takes the link under
    // the ADR 0003 floor with it. Fixed by letting the anchor reclaim the column's own inline
    // padding (the same spend-the-chrome trick Standard uses vertically).
    await gotoAt(page, NARROW);
    await page.addStyleTag({ content: ':root { font-size: 200% }' });
    await assertUsableTarget(page);
  });

  test('658×320: the focus ring renders COMPLETE on all four sides', async ({ page }) => {
    // Here the threat is horizontal: the anchor reclaims the column's inline padding, so its
    // border box coincides with `.wy-status`'s padding box and `overflow: hidden` clips any
    // ring drawn outside it.
    await gotoAt(page, PHONE);
    await assertCompleteFocusRing(page);
  });

  test('658×320: hidden after Start here too — inert and pointer-events:none', async ({ page }) => {
    await gotoAt(page, PHONE);
    expect(await homeInteractivity(page)).toMatchObject({ live: false, inert: false });
    await page.getByRole('button', { name: 'Start' }).click();
    const live = await homeInteractivity(page);
    expect(live.live).toBe(true);
    expect(live.inert).toBe(true);
    expect(live.pointerEvents).toBe('none');
  });
});
