import { test, expect, devices, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PNG } from 'pngjs';
import { COMPACT_QUERY } from '../src/layout';
import {
  assertNoBuildableCellUnderDock,
  buildableRect,
  GRID,
  projectedGrid,
  regionRect,
  type Rect,
} from './layout-probe';
import { firePrompt, installPromptFactory } from './install-stub';
import { stubFullscreen } from './fullscreen-stub';
import { TARGET_MIN_PX } from './targets';

// dock-overlap.spec.ts — the Standard Dock swallows no playable cell's hit test (#152).
//
// THE DEFECT. The Standard Dock floats over the Stage's bottom-left, above the board
// (`z-index: 1`). Until #152 the board filled the whole Stage underneath it, so on a landscape
// tablet a tap on a buildable cell under the cluster was either lost or — where the cell sat
// under the Start button — silently began the wave instead of placing the armed tower.
//
// THE RULING. The board stops short of the Dock (`--wy-dock-reserve`), and the Standard Dock
// gets its own bounded height + scrollport so that reserve can never crush the board under its
// 12px floor. The relation asserted here — `assertNoBuildableCellUnderDock` — is ABSOLUTE:
// every viewport below, including the worst-case 640×560 banner-up 200% zoom, holds it with
// no exemption.
//
// Runs under the default fine-pointer `chromium` project; the tablet cases re-create the
// coarse-pointer context themselves (`test.use` below) rather than joining the
// `chromium-touch` project, whose 320px-tall profile is Compact — the layout this defect
// cannot occur in.

/** The reported repro: a landscape tablet, coarse pointer, Standard layout. */
const TABLET_REPRO = { width: 1280, height: 800 };

/** The Standard sweep (fine pointer). 360×640 is a portrait phone — Standard by height, and
 *  the size where the Dock wraps to two rows at 100% zoom. */
const SWEEP = [
  { width: 360, height: 640 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

/** The owner's worst case: a coarse-pointer landscape tablet, Standard, with the install
 *  banner up AND 200% text zoom — where the unbounded Dock wrapped to 162px and the reserve
 *  it demanded could not coexist with the 12px cell floor. */
const TABLET_WORST = { width: 640, height: 560 };

/** The Standard cell floor (`compact.spec.ts`'s `CELL_PX_MIN`, `ui.css`'s `--wy-cell-floor`). */
const CELL_PX_MIN = 12;

/** The Galaxy S9+'s touch identity, minus its viewport and browser type (a describe-level
 *  `test.use` may not set the latter). The coarse pointer is ASSERTED per test, never
 *  assumed — `hasTouch` alone does not guarantee `(pointer: coarse)` matches. */
const S9 = devices['Galaxy S9+ landscape'];
const COARSE = {
  userAgent: S9.userAgent,
  deviceScaleFactor: S9.deviceScaleFactor,
  isMobile: S9.isMobile,
  hasTouch: S9.hasTouch,
};

async function gotoStandard(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  // A Start press under a coarse pointer requests fullscreen, which would resize the viewport
  // out from under every measurement here (`fullscreen-stub.ts`).
  await stubFullscreen(page);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
  expect(
    await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY),
    'every case here is Standard — the Compact Dock is an in-flow column block',
  ).toBe(false);
}

/** Let the measured reserve land. It is written by a ResizeObserver pass one frame after the
 *  box that drives it changes, so a measurement taken in the same task as a zoom or a banner
 *  would read the previous frame's board. Polled to a board that has stopped moving — keyed
 *  on the OUTCOME, never on the property the fix writes, so this spec measures the pre-fix
 *  build exactly as it measures the fixed one (red for the defect, not for a missing hook). */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  let last = '';
  await expect
    .poll(async () => {
      const now = JSON.stringify(await projectedGrid(page));
      const stable = now === last;
      last = now;
      return stable;
    })
    .toBe(true);
}

/** The countdown dial (#181 H1, QC) may never move the Dock, and the countdown it decorates must
 *  be readable. The dial is drawn INSIDE the primary control, out of its layout (`ui.css`,
 *  `.wy-dial`): never a Dock item, so never a wrap, a taller row or a wider control. Proven as an
 *  A/B in the real layout: the Dock's box, every control's box, the reserve the Dock pass
 *  publishes and the board it leaves are identical with the dial REMOVED from the document —
 *  which also drops the padding redistribution it is drawn in, so the control's own unshifted
 *  box is the reference. While it shows it sits inside the control and clear of its label.
 *
 *  And THE COUNTDOWN IS READABLE (#181 QC): the wave chip's glance — the clock and the seconds,
 *  the one readable countdown at every text size — is painted, wholly inside the capped hud and
 *  the viewport at rest, in every Dock form, at every case this runs at. */
async function assertDialMovesNothing(page: Page, phase: string): Promise<void> {
  const dial = page.locator('.wy-dock .wy-primary > .wy-dial');
  await expect(dial, `${phase}: the dial is drawn inside the primary control`).toHaveCount(1);
  await expect(dial).toHaveAttribute('aria-hidden', 'true');
  expect(
    await page.evaluate(() =>
      [...document.querySelector('.wy-dock')!.children].map((c) => c.classList.contains('wy-btn')),
    ),
    `${phase}: the Dock holds its controls and nothing else`,
  ).not.toContain(false);

  const glance = await page.evaluate(() => {
    const chip = document.querySelector<HTMLElement>('.wy-hud > .wy-chip[data-wy-chip="wave"]');
    if (chip === null || chip.hidden) return null;
    const hud = document.querySelector<HTMLElement>('.wy-hud')!;
    const h = hud.getBoundingClientRect();
    const port = {
      left: h.left + hud.clientLeft,
      top: h.top + hud.clientTop,
      right: h.left + hud.clientLeft + hud.clientWidth,
      bottom: h.top + hud.clientTop + hud.clientHeight,
    };
    const g = chip.querySelector<HTMLElement>('.wy-chip-glance')!;
    const r = g.getBoundingClientRect();
    const near = (a: number, b: number): boolean => a >= b - 0.5;
    return {
      visibility: getComputedStyle(g).visibility,
      text: g.textContent ?? '',
      area: r.width * r.height,
      rect: `[${r.left.toFixed(1)},${r.top.toFixed(1)} ${r.width.toFixed(1)}×${r.height.toFixed(1)}]`,
      port: `[${port.left.toFixed(1)},${port.top.toFixed(1)} → ${port.right.toFixed(1)},${port.bottom.toFixed(1)}]`,
      inHud:
        near(r.left, port.left) &&
        near(r.top, port.top) &&
        near(port.right, r.right) &&
        near(port.bottom, r.bottom),
      inViewport:
        near(r.left, 0) &&
        near(r.top, 0) &&
        near(innerWidth, r.right) &&
        near(innerHeight, r.bottom),
    };
  });
  // Every phase this runs in has a countdown (before Start, and a run under way).
  expect(glance, `${phase}: the countdown chip is shown`).not.toBeNull();
  expect(glance!.visibility, `${phase}: the countdown's glance is painted`).toBe('visible');
  expect(glance!.text, `${phase}: …and reads the seconds`).toMatch(/\d+s/);
  expect(glance!.area, `${phase}: …in a box with area`).toBeGreaterThan(0);
  expect(
    glance!.inHud,
    `${phase}: the countdown's glance ${glance!.rect} must sit wholly inside the capped hud ${glance!.port} at rest`,
  ).toBe(true);
  expect(glance!.inViewport, `${phase}: …and inside the viewport`).toBe(true);

  const drawn = await page.evaluate(() => {
    const a = document.querySelector<HTMLElement>('.wy-dock .wy-primary > .wy-dial')!;
    const p = document.querySelector<HTMLElement>('.wy-dock .wy-primary')!;
    if (a.hidden || p.hidden || a.getClientRects().length === 0) return null;
    const ar = a.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(p.querySelector('.wy-btn-text')!);
    const ink = [...range.getClientRects()];
    return {
      width: ar.width,
      inside:
        ar.left >= pr.left && ar.right <= pr.right && ar.top >= pr.top && ar.bottom <= pr.bottom,
      clearOfLabel: ink.every(
        (r) => r.right <= ar.left || r.left >= ar.right || r.bottom <= ar.top || r.top >= ar.bottom,
      ),
    };
  });
  // Standard draws the dial whenever a countdown runs and no call is launching — both phases.
  expect(drawn, `${phase}: the dial is drawn`).not.toBeNull();
  expect(drawn!.width, `${phase}: …with a size`).toBeGreaterThan(0);
  expect(drawn!.inside, `${phase}: …inside the primary control's box`).toBe(true);
  expect(drawn!.clearOfLabel, `${phase}: …clear of the label's ink`).toBe(true);

  const snapshot = (): Promise<unknown> =>
    page.evaluate(() => {
      const box = (el: Element): string => {
        const b = el.getBoundingClientRect();
        return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 100) / 100).join(',');
      };
      const dock = document.querySelector('.wy-dock')!;
      return {
        dock: box(dock),
        controls: [...dock.querySelectorAll('.wy-btn')].map(box),
        reserve: getComputedStyle(document.querySelector('.wy-shell')!).getPropertyValue(
          '--wy-dock-reserve',
        ),
        board: box(document.querySelector('.wy-board')!),
        scrollForm: dock.classList.contains('wy-dock--scroll'),
      };
    });
  const present = await snapshot();
  await page.evaluate(() => {
    const a = document.querySelector('.wy-dock .wy-primary > .wy-dial')!;
    (window as unknown as { __wyDial: Element }).__wyDial = a;
    a.remove();
  });
  await settle(page);
  const absent = await snapshot();
  await page.evaluate(() => {
    const w = window as unknown as { __wyDial?: Element };
    document.querySelector('.wy-dock .wy-primary')!.append(w.__wyDial!);
    delete w.__wyDial;
  });
  await settle(page);
  expect(present, `${phase}: the countdown dial moved the Dock or the board`).toEqual(absent);
}

/** The page-coordinate centre of board cell (col, row). */
async function cellCentre(page: Page, col: number, row: number): Promise<{ x: number; y: number }> {
  const grid = await projectedGrid(page);
  return {
    x: grid.x + (col + 0.5) * grid.cellPx,
    y: grid.y + (row + 0.5) * grid.cellPx,
  };
}

/** Every buildable cell of the bottom buildable row and the left buildable column must
 *  hit-test to the board. This is the defect's own terms — what a tap on that cell REACHES —
 *  rather than a geometric proxy for it: the Dock paints above the board, so any cell whose
 *  centre resolves to something outside `.wy-board` is a swallowed tap. */
async function assertEdgeCellsHitTheBoard(page: Page): Promise<void> {
  const grid = await projectedGrid(page);
  const buildable = buildableRect(grid);
  const cols = Math.round(buildable.width / grid.cellPx);
  const rows = Math.round(buildable.height / grid.cellPx);
  const probes: { col: number; row: number }[] = [];
  for (let c = 1; c <= cols; c++) probes.push({ col: c, row: rows });
  for (let r = 1; r < rows; r++) probes.push({ col: 1, row: r });
  const swallowed = await page.evaluate(
    ({ probes, grid }) =>
      probes
        .filter(({ col, row }) => {
          const x = grid.x + (col + 0.5) * grid.cellPx;
          const y = grid.y + (row + 0.5) * grid.cellPx;
          const hit = document.elementFromPoint(x, y);
          return hit === null || hit.closest('.wy-board') === null;
        })
        .map(({ col, row }) => {
          const hit = document.elementFromPoint(
            grid.x + (col + 0.5) * grid.cellPx,
            grid.y + (row + 0.5) * grid.cellPx,
          );
          return `(${col},${row}) → ${hit === null ? 'nothing' : hit.className || hit.tagName}`;
        }),
    { probes, grid },
  );
  expect(swallowed, 'buildable cells whose tap lands on something other than the board').toEqual(
    [],
  );
}

test.describe('the tablet repro (1280×800, coarse pointer): no cell under the Dock (#152)', () => {
  test.use(COARSE);

  test('no buildable cell renders under the Dock, and every edge cell hit-tests to the board', async ({
    page,
  }) => {
    await gotoStandard(page, TABLET_REPRO);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await settle(page);
    await assertNoBuildableCellUnderDock(page);
    await assertEdgeCellsHitTheBoard(page);
  });

  // Two taps, one per way the defect showed itself. Which Dock control sits over which cell
  // depends on the host's font metrics (they set the Dock's button widths), so rather than
  // hoping the bottom-left cell lands under Start on every runner, the second case ASKS where
  // Start is and taps the cell in its column. Measured against the pre-#152 build (headless
  // Chromium on Linux, 2026-09-24): the first tap opened Settings, and the second pressed
  // Start and began the wave.
  const TARGETS = ['the bottom-left buildable cell', "the Start button's column"] as const;
  for (const which of TARGETS) {
    test(`arming a tower and tapping ${which} places it — and starts no wave`, async ({ page }) => {
      await gotoStandard(page, TABLET_REPRO);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      await settle(page);

      const board = page.locator('.wy-board');
      const start = page.getByRole('button', { name: 'Start', exact: true });
      await expect(start).toBeVisible();
      await expect(board).toHaveAttribute('data-started', 'false');

      // Both targets sit on the last buildable row, just inside the blocked border ring.
      const grid = await projectedGrid(page);
      const bottomRow = Math.round(grid.height / grid.cellPx) - 2;
      let col = 1;
      if (which === "the Start button's column") {
        const s = (await start.boundingBox()) as Rect;
        col = Math.floor((s.x + s.width / 2 - grid.x) / grid.cellPx);
        // Inside the buildable columns, or this case would be probing nothing.
        expect(col).toBeGreaterThanOrEqual(1);
        expect(col).toBeLessThanOrEqual(Math.round(grid.width / grid.cellPx) - 2);
      }

      const card = page.getByRole('button', { name: /Basic Tower/ });
      await card.tap();
      await expect(card).toHaveAttribute('aria-pressed', 'true');
      const target = await cellCentre(page, col, bottomRow);
      await page.touchscreen.tap(target.x, target.y);

      // THE DESTRUCTIVE SYMPTOM FIRST: the tap must not have been taken by the Dock.
      await expect(board, 'the tap started the wave').toHaveAttribute('data-started', 'false');
      await expect(start).toBeVisible();
      await expect(page.getByRole('dialog'), 'the tap opened a Dock dialog').toHaveCount(0);
      // ...and the tap did what the player meant: the tower was placed (a successful
      // placement disarms the Card and selects the new tower, whose Panel offers Sell).
      await expect(card).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();
    });
  }
});

test.describe('the Standard sweep: no buildable cell under the Dock (#152)', () => {
  for (const size of SWEEP) {
    test(`${size.width}×${size.height}: no buildable cell renders under the Dock, every edge cell hit-tests to the board, and the countdown dial moves nothing while the countdown reads`, async ({
      page,
    }) => {
      await gotoStandard(page, size);
      await settle(page);
      await assertNoBuildableCellUnderDock(page);
      await assertEdgeCellsHitTheBoard(page);
      await assertDialMovesNothing(page, 'pre-start');
      // …and with a run under way, when the primary control reads "Call wave" and the dial
      // inside it counts down to the next wave.
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(page.locator('.wy-board')).toHaveAttribute('data-started', 'true');
      await settle(page);
      await assertDialMovesNothing(page, 'started');
    });
  }
});

test.describe('the bounded Dock at the worst case: 640×560, banner up, 200% zoom (#152)', () => {
  test.use(COARSE);

  test('the relation holds with no exemption, the board keeps its 12px floor, and every Dock control is reachable by keyboard', async ({
    page,
  }) => {
    await installPromptFactory(page);
    await gotoStandard(page, TABLET_WORST);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await firePrompt(page, 'dismissed');
    await expect(page.locator('.wy-banner')).toBeVisible();
    await page.addStyleTag({ content: ':root { font-size: 200% }' });
    await settle(page);

    // The absolute relation, at the size where the unbounded Dock made it impossible...
    await assertNoBuildableCellUnderDock(page);
    await assertEdgeCellsHitTheBoard(page);
    // ...without spending the board's floor to get it.
    const grid = await projectedGrid(page);
    expect(grid.cellPx, `cellPx ${grid.cellPx} below the Standard floor`).toBeGreaterThanOrEqual(
      CELL_PX_MIN,
    );

    // The bound is live here — this is the case it exists for, so a Dock that merely happened
    // to fit would make every assertion below vacuous.
    const dockEl = page.locator('.wy-dock');
    expect(
      await dockEl.evaluate((el) => el.scrollHeight > el.clientHeight),
      'the Dock must be a live scrollport at this size',
    ).toBe(true);
    await expect(dockEl).toHaveClass(/wy-dock--scroll/);

    // KEYBOARD REACHABILITY, per control: Tab into the Dock from the chips scrollport and walk
    // every visible control. Each must take focus through real Tab traversal (not
    // `.focus()`), and focusing it must scroll it WHOLLY into the Dock's scrollport — the
    // accepted cost is that controls need scrolling to reach, never that one cannot be seen.
    const controls = dockEl.locator('.wy-btn:visible');
    const count = await controls.count();
    expect(count).toBeGreaterThan(1);
    await page.locator('.wy-hud').focus();
    for (let i = 0; i < count; i++) {
      await page.keyboard.press('Tab');
      const control = controls.nth(i);
      await expect(control, `Dock control ${i} must be the next Tab stop`).toBeFocused();
      const port = (await regionRect(page, 'dock')) as Rect;
      const box = (await control.boundingBox()) as Rect;
      expect(
        box.y >= port.y - 1 && box.y + box.height <= port.y + port.height + 1,
        `focused Dock control ${i} [${box.y.toFixed(1)}..${(box.y + box.height).toFixed(1)}] ` +
          `must sit wholly inside the Dock scrollport [${port.y.toFixed(1)}..${(
            port.y + port.height
          ).toFixed(1)}]`,
      ).toBe(true);
      await expect(control).toBeInViewport();
    }

    // Axe over the live scrollport — `scrollable-region-focusable` among the rest.
    const audit = await new AxeBuilder({ page }).include('#app').analyze();
    expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
  });
});

// --- THE HARDENED SCROLLPORT (#152 QC, owner rulings "harden the scrollport" + "control wins") ---
//
// Everything above is measured BEFORE Start. A run changes the Dock: Start gives way to Pause
// AND Call wave, so the cluster gains a control and wraps again — at 540×556, 100% zoom, from
// one row to two. These cases measure both phases, at the sizes the QC sweep found broken:
// fractional Stage heights (where a ceil'd reserve cost the board its 12px floor), a started
// Dock that became a scrollport at 100% zoom, and controls left partly visible at rest.
//
// THE STARTED SCROLLPORT MOVED WITH #181. The QC sweep found it at 540×556, where #101's
// reserved hud row had already taken the status row to ~200px. The strip gave that height back
// to the Stage: at 540 wide the strip shares the wrapped chips' second line (a 95px status
// row) and the started Dock no longer scrolls at 100% at any Standard height. With the
// countdown leading the hud (#181 QC) the same holds at 500 wide; at 480 the strip takes a line
// of its own (a 134px row) and the started Dock scrolls at 480×509 and 480×520 (not 480×540).
// The tests below that need it scrolling — and say so first — measure at 480×509, where the
// floor holds by 34.8px on macOS's font stack and CI's (DejaVu Sans) alike, and the table
// carries the same case, so every hardened check runs on a scrolling Dock at 100% too. Every
// case DECLARES its started Dock's form (`startedScrolls`), so the table can never again lose
// that state without failing. The bottom-inset test stays at 540×509, where the inset itself is
// what puts the Dock in its scroll form; 540×556 stays in the table, un-scrolled.

interface DockCase {
  readonly width: number;
  readonly height: number;
  /** Root font size, percent — the text-zoom model every zoom case in this suite uses. */
  readonly zoom: number;
  readonly banner?: boolean;
  readonly coarse?: boolean;
  /** Owner ruling 2's single floor exception is EXPECTED here: the Stage is too short for one
   *  whole Dock row — at the uniform, tallest-control height (owner ruling, 2026-09-24) — and
   *  the board's floor both, so the row wins. Every other case must NOT meet the exception's
   *  condition — the test proves the condition, not just the outcome. */
  readonly exception?: boolean;
  /** Whether the STARTED Dock is in its scroll form here — declared by every case and asserted
   *  (#181 QC), so a layout change that moves a case across that line fails loudly instead of
   *  silently emptying the table of scrolling (or whole) cases. Each value is measured on
   *  macOS's font stack and CI's (DejaVu Sans) alike, at a size where the form is the ONLY one
   *  the controls allow: not where both are (see the 560×560 case). A case whose form is a
   *  font metric declares it per stack, and each run asserts its own. */
  readonly startedScrolls: boolean | { readonly macOS: boolean; readonly dejaVu: boolean };
}

/** The started form a case declares for THIS run's font stack: macOS's locally, DejaVu Sans on
 *  CI's Linux runners — the two stacks every value in the table is measured on. */
function declaredStartedScrolls(c: DockCase): boolean {
  const v = c.startedScrolls;
  if (typeof v === 'boolean') return v;
  return process.platform === 'darwin' ? v.macOS : v.dejaVu;
}

const HARDENED: readonly DockCase[] = [
  { width: 540, height: 556, zoom: 100, startedScrolls: false },
  { width: 540, height: 578, zoom: 100, startedScrolls: false },
  // The 100% SCROLLING case (#181 QC): see THE STARTED SCROLLPORT MOVED above.
  { width: 480, height: 509, zoom: 100, startedScrolls: true },
  { width: 800, height: 501, zoom: 150, startedScrolls: true },
  { width: 1080, height: 600, zoom: 200, startedScrolls: false },
  // The owner's worst case. Start takes the banner down, so its started phase is plain
  // 640×560 at 200%, where the started Dock's form is a font metric (#181 QC): DejaVu Sans sets
  // the four controls 3–13% wider, so on CI they need three rows where only two fit, and the
  // Dock scrolls; on macOS's stack they take two, whole, in either form. One form per stack, so
  // the case declares both.
  {
    width: 640,
    height: 560,
    zoom: 200,
    banner: true,
    coarse: true,
    startedScrolls: { macOS: false, dejaVu: true },
  },
  // The worst case's size without the banner, at 560 rather than 640 wide (#181 QC), where the
  // started Dock scrolls on both stacks — and MUST: its controls need three rows even with the
  // scroll cue's gutter given back (four on CI), and two fit. Not 600: there, on macOS, the
  // controls take two rows in the whole Dock and three in the scroll form's narrower box, so
  // both forms hold and the one shown depends on the Dock's history (#152's pass measures rows
  // in the form it is in) — a fresh page scrolls, a page that has been through this test's
  // pre-start checks does not.
  { width: 560, height: 560, zoom: 200, startedScrolls: true },
  { width: 360, height: 640, zoom: 200, startedScrolls: true },
  { width: 1280, height: 800, zoom: 100, coarse: true, startedScrolls: false },
  // Ruling 2's exception was found at 175% here, where — on CI's font stack — the status row
  // spent a line on the home link alone and set the hud (at its 40dvh cap) below it: Stage
  // 333.6px against ~341px. Since #181 the hud sits BESIDE the link wherever it can show a
  // whole chip there (`flex: 1 1 0` above a 5rem floor), and at 175% this Stage holds the floor
  // and a whole Dock row on both font stacks (by 30.6px on macOS, 29.6px with CI's DejaVu Sans
  // metrics), so it proves the floor. The exception is proven where its condition holds on
  // both by ~30px: 300%, where the capped hud and a taller Dock row leave 333px against
  // 363–364px.
  { width: 900, height: 501, zoom: 175, startedScrolls: true },
  { width: 900, height: 501, zoom: 300, exception: true, startedScrolls: true },
  // Fractional RESERVES, not just fractional Stages: under 100% text the float offset is
  // 0.5rem = 7.2px, so the Dock's band is never a whole px. A reserve rounded up to a whole px
  // leaves these boards 287.6px tall — 11px cells — with no exception to excuse it.
  { width: 540, height: 506, zoom: 90, startedScrolls: false },
  { width: 360, height: 591, zoom: 90, startedScrolls: false },
  // UNEQUAL LABELS (round-2 QC). At phone widths under heavy text zoom a Dock label wraps
  // ("Call wave", "Speed: 1x" take two lines) while its neighbours do not, so a row can be
  // nearly twice as tall as the one above it. 320×640 at 200% is in scope twice over: WCAG
  // 1.4.10 reflow at 320px, and ADR 0003's 200% text commitment.
  { width: 320, height: 640, zoom: 200, startedScrolls: true },
  { width: 320, height: 640, zoom: 250, startedScrolls: true },
  { width: 360, height: 640, zoom: 250, startedScrolls: true },
  { width: 320, height: 900, zoom: 300, startedScrolls: true },
  // THE EXCEPTION ON AN ORDINARY PHONE (owner ruling, 2026-09-24: "one full Dock row" is the
  // TALLEST control's row). At 320px and 200% text a wrapped two-line label sets every row's
  // height (86px, measured 2026-09-24, before and after Start), one such row no longer fits
  // beside the 12px floor, and the row wins: the board drops to 11px rows. Accepted, not a
  // defect — and the exception's condition, not just its outcome, is asserted in both phases.
  // It WAS font-sensitive: on CI's stack the hud sat under the home link and the condition held
  // by ~9px, while on macOS's the hud was a 14px sliver BESIDE the link and the case reported
  // the floor held (a local macOS run of the base commit fails it). The hud's floor (`ui.css`,
  // #181 QC) sets it under the link on both stacks now, and the condition holds on both: by
  // 7.3px on macOS's and 9.3px on CI's.
  { width: 320, height: 560, zoom: 200, exception: true, startedScrolls: true },
  // The same phone at 250%, where the condition holds by ~30px on both font stacks, so the
  // exception's code path stays checkable on any machine (#181).
  { width: 320, height: 560, zoom: 250, exception: true, startedScrolls: true },
];

interface Reach {
  readonly name: string;
  readonly hits: number;
  readonly probes: number;
  readonly width: number;
  readonly height: number;
}

/** How much of each visible Dock control a tap can actually reach, by hit-testing one probe
 *  per CSS px down its vertical centre line. Rendered truth, not geometry: a control scrolled
 *  out, clipped by the scrollport, or painted over by anything reads as missing rows. */
async function dockControlReach(page: Page): Promise<Reach[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.wy-dock .wy-btn')]
      .filter((el) => !el.hidden && el.getClientRects().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        let hits = 0;
        let probes = 0;
        for (let y = Math.ceil(r.top) + 0.5; y < r.bottom; y += 1) {
          probes++;
          if (document.elementFromPoint(cx, y)?.closest('.wy-btn') === el) hits++;
        }
        return {
          name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
          hits,
          probes,
          width: r.width,
          height: r.height,
        };
      }),
  );
}

/** The no-partial-control claim, allowed to SETTLE first: a focus scroll or a flick is followed
 *  by a snap, and the claim is about where the scrollport comes to rest. */
async function assertNoPartialControlOnceSettled(page: Page, when: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (await dockControlReach(page))
          .filter((c) => c.hits > 0 && c.hits < c.probes)
          .map((c) => `${c.name}: ${c.hits}/${c.probes}px reachable`),
      { message: `${when}: Dock controls partly visible at rest` },
    )
    .toEqual([]);
  await assertNoPartialControl(page, when);
}

/** Owner ruling 1: at rest, every Dock control is wholly reachable or wholly out of sight —
 *  never a sliver, and never a clipped touch target. At least one control is always whole. */
async function assertNoPartialControl(page: Page, when: string): Promise<void> {
  const reach = await dockControlReach(page);
  const partial = reach.filter((c) => c.hits > 0 && c.hits < c.probes);
  expect(
    partial.map((c) => `${c.name}: ${c.hits}/${c.probes}px reachable`),
    `${when}: Dock controls partly visible at rest`,
  ).toEqual([]);
  const whole = reach.filter((c) => c.hits === c.probes);
  expect(whole.length, `${when}: no Dock control is wholly visible`).toBeGreaterThan(0);
  for (const c of whole) {
    expect(c.height, `${when}: ${c.name} height`).toBeGreaterThanOrEqual(TARGET_MIN_PX);
    expect(c.width, `${when}: ${c.name} width`).toBeGreaterThanOrEqual(TARGET_MIN_PX);
  }
}

/** The geometry ruling 2 is stated in: the Stage, the board, the Dock's float offset, and the
 *  height one whole row of Dock controls needs (its bottom edge in scroll-content
 *  coordinates, plus the Dock's bottom padding). */
async function dockGeometry(page: Page): Promise<{
  stageH: number;
  boardH: number;
  boardW: number;
  offset: number;
  firstRow: number;
}> {
  return page.evaluate(() => {
    const stage = document.querySelector('.wy-stage')!.getBoundingClientRect();
    const board = document.querySelector('.wy-board')!.getBoundingClientRect();
    const dock = document.querySelector<HTMLElement>('.wy-dock')!;
    const d = dock.getBoundingClientRect();
    const boxes = [...dock.querySelectorAll<HTMLElement>('.wy-btn')]
      .filter((el) => !el.hidden && el.getClientRects().length > 0)
      .map((el) => el.getBoundingClientRect());
    const first = Math.min(...boxes.map((r) => r.top));
    const firstBottom = Math.max(
      ...boxes.filter((r) => Math.abs(r.top - first) <= 1).map((r) => r.bottom),
    );
    const origin = d.top + dock.clientTop - dock.scrollTop;
    return {
      stageH: stage.height,
      boardH: board.height,
      boardW: board.width,
      offset: stage.bottom - d.bottom,
      firstRow: firstBottom - origin + parseFloat(getComputedStyle(dock).paddingBottom),
    };
  });
}

/** The 12px floor, or ruling 2's exception — decided by the ruling's own condition. */
async function assertFloorOrException(page: Page, c: DockCase, phase: string): Promise<void> {
  const g = await dockGeometry(page);
  const grid = await projectedGrid(page);
  const need = GRID.rows * CELL_PX_MIN + g.offset + g.firstRow;
  const exception = g.stageH < need;
  expect(
    exception,
    `${phase}: Stage ${g.stageH.toFixed(2)}px vs floor + one row ${need.toFixed(2)}px — the ` +
      `floor exception must trigger exactly where the case says it does`,
  ).toBe(c.exception === true);
  if (exception) {
    // The row wins: at least one control is whole (asserted with the rest at rest), and the
    // board — which may now fall under the floor, and here does — takes everything else.
    expect(
      Math.floor(g.boardH / GRID.rows),
      `${phase}: the exception case must actually be under the floor, or it tests nothing`,
    ).toBeLessThan(CELL_PX_MIN);
    return;
  }
  // The height the board keeps is the floor's to guarantee, at ANY fractional Stage height.
  expect(
    g.boardH,
    `${phase}: board ${g.boardH.toFixed(2)}px is under ${GRID.rows} × ${CELL_PX_MIN}px`,
  ).toBeGreaterThanOrEqual(GRID.rows * CELL_PX_MIN);
  // ...and so is the projected cell, wherever the board is not narrower than the floor anyway
  // (360×640 is width-limited: 9px cells with or without a Dock).
  expect(
    grid.cellPx,
    `${phase}: cellPx ${grid.cellPx} below the floor at a height-limited size`,
  ).toBeGreaterThanOrEqual(Math.min(CELL_PX_MIN, Math.floor(g.boardW / GRID.cols)));
}

/** The owner's reading of "one full Dock row" (2026-09-24): the row is as tall as the TALLEST
 *  visible control, and no taller. `assertFloorOrException` takes its row from the rendered
 *  (equalised) layout, so an inflated row height would read there as the floor exception and
 *  pass; this oracle pins that height independently of the code that writes it.
 *
 *  Each visible control's NATURAL height is measured with the equaliser switched off on the
 *  control itself — an inline `min-height: 0` and `align-self: flex-start`, both `!important`,
 *  so neither the row-height `min-height` nor the flex line's stretch can reach it — and all of
 *  it is restored inside the same task, so no frame ever renders the probe. The expected row is
 *  ADR 0003's 44px target floor or the tallest natural control, whichever is taller; every
 *  visible control must render at exactly that height (one layout unit of rounding), and so
 *  must the `--wy-dock-row-h` handed to the stylesheet. */
async function assertRowHeightIsTallestControl(page: Page, phase: string): Promise<void> {
  const m = await page.evaluate(() => {
    const btns = [...document.querySelectorAll<HTMLElement>('.wy-dock .wy-btn')].filter(
      (el) => !el.hidden && el.getClientRects().length > 0,
    );
    const rendered = btns.map((el) => ({
      name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
      height: el.getBoundingClientRect().height,
    }));
    const saved = btns.map((el) => el.style.cssText);
    for (const el of btns) {
      el.style.setProperty('min-height', '0', 'important');
      el.style.setProperty('align-self', 'flex-start', 'important');
    }
    const natural = btns.map((el) => el.getBoundingClientRect().height);
    btns.forEach((el, i) => (el.style.cssText = saved[i]!));
    const shell = document.querySelector<HTMLElement>('.wy-shell')!;
    return {
      rendered,
      tallest: Math.max(...natural),
      rowVar: getComputedStyle(shell).getPropertyValue('--wy-dock-row-h').trim(),
    };
  });
  const want = Math.max(TARGET_MIN_PX, m.tallest);
  const UNIT = 1 / 64 + 0.01;
  for (const c of m.rendered) {
    expect(
      Math.abs(c.height - want),
      `${phase}: Dock control "${c.name}" renders ${c.height.toFixed(3)}px; one Dock row is ` +
        `max(${TARGET_MIN_PX}, tallest natural control ${m.tallest.toFixed(3)}) = ` +
        `${want.toFixed(3)}px`,
    ).toBeLessThanOrEqual(UNIT);
  }
  expect(m.rowVar, `${phase}: --wy-dock-row-h must be written in the Standard layout`).not.toBe('');
  expect(
    Math.abs(parseFloat(m.rowVar) - want),
    `${phase}: --wy-dock-row-h ${m.rowVar} vs the tallest control's row ${want.toFixed(3)}px`,
  ).toBeLessThanOrEqual(UNIT);
}

/** Tab into the Dock from the chips scrollport and walk every visible control. Each must be
 *  the next Tab stop and, focused, be WHOLLY reachable (hit-tested) — scrolled into view, never
 *  left under an edge. */
async function assertTabWalkShowsEachControl(page: Page, phase: string): Promise<void> {
  const controls = page.locator('.wy-dock .wy-btn:visible');
  const count = await controls.count();
  expect(count).toBeGreaterThan(1);
  // The walk starts at the last tab stop BEFORE the Dock: the chips list — or, while the wave
  // strip is in its scroll form (#181), the strip, a labelled tab stop of its own inside it.
  const scrollingStrip = page.locator('.wy-hud .wy-wave-preview--scroll');
  await ((await scrollingStrip.count()) > 0 ? scrollingStrip : page.locator('.wy-hud')).focus();
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab');
    const control = controls.nth(i);
    await expect(control, `${phase}: Dock control ${i} must be the next Tab stop`).toBeFocused();
    const name = await control.evaluate(
      (el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
    );
    await expect
      .poll(
        async () => {
          const r = (await dockControlReach(page)).find((x) => x.name === name);
          return r === undefined ? 'missing' : `${r.hits}/${r.probes}`;
        },
        { message: `${phase}: focused Dock control "${name}" must be wholly reachable` },
      )
      .toMatch(/^(\d+)\/\1$/);
    await expect(control).toBeInViewport({ ratio: 1 });
    // ...and where the focus scroll comes to rest, no OTHER control is left as a sliver.
    await assertNoPartialControlOnceSettled(page, `${phase}, Tab stop ${i} ("${name}")`);
  }
}

/** The scroll cue, read from rendered pixels in the Dock's right-hand gutter: how many pixel
 *  rows carry cue colour at all (the TRACK), and how many near each end are WIDE (≥ 6px across
 *  — a CHEVRON; the 2px track never is). Colour is how the probe finds the cue; the claim is
 *  its shape and its place. */
async function cuePixels(
  page: Page,
  ink?: readonly number[],
): Promise<{ track: number; top: number; bottom: number }> {
  const box = (await regionRect(page, 'dock')) as Rect;
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--wy-accent').trim(),
  );
  const want = ink ?? [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16));
  const png = PNG.sync.read(await page.screenshot({ scale: 'css' }));
  const isCue = (x: number, y: number): boolean => {
    const i = (png.width * y + x) << 2;
    return want.every((v, k) => Math.abs(png.data[i + k]! - v) <= 24);
  };
  const right = Math.floor(box.x + box.width) - 1;
  const left = right - 15;
  const top = Math.ceil(box.y);
  const bottom = Math.floor(box.y + box.height) - 1;
  const rowWidth = (y: number): number => {
    let n = 0;
    for (let x = left; x <= right; x++) if (isCue(x, y)) n++;
    return n;
  };
  let track = 0;
  for (let y = top; y <= bottom; y++) if (rowWidth(y) > 0) track++;
  let topWide = 0;
  let bottomWide = 0;
  for (let y = top; y < top + 8; y++) if (rowWidth(y) >= 6) topWide++;
  for (let y = bottom; y > bottom - 8; y--) if (rowWidth(y) >= 6) bottomWide++;
  return { track, top: topWide, bottom: bottomWide };
}

/** Owner ruling 1's cue: shown exactly in the scroll form, pointing where rows remain. (A
 *  Dock that does not scroll has no gutter to sample — its last control sits flush with its
 *  right edge — so there the claim is that it paints nothing behind its controls.) */
async function assertScrollCue(page: Page, phase: string, ink?: readonly number[]): Promise<void> {
  const state = await page.locator('.wy-dock').evaluate((el) => ({
    scrolls: el.scrollHeight > el.clientHeight + 1,
    below: el.scrollHeight - el.clientHeight - el.scrollTop > 1,
    above: el.scrollTop > 1,
    height: el.clientHeight,
    background: getComputedStyle(el).backgroundImage,
  }));
  if (!state.scrolls) {
    expect(state.background, `${phase}: a Dock that does not scroll must show no cue`).toBe('none');
    return;
  }
  const px = await cuePixels(page, ink);
  expect(px.track, `${phase}: the scroll cue's track must run down the gutter`).toBeGreaterThan(
    state.height / 2,
  );
  expect(px.bottom > 0, `${phase}: a down chevron iff rows remain below`).toBe(state.below);
  expect(px.top > 0, `${phase}: an up chevron iff rows remain above`).toBe(state.above);
}

async function gotoCase(page: Page, c: DockCase): Promise<void> {
  if (c.banner) await installPromptFactory(page);
  await gotoStandard(page, { width: c.width, height: c.height });
  if (c.coarse) {
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  }
  if (c.banner) {
    await firePrompt(page, 'dismissed');
    await expect(page.locator('.wy-banner')).toBeVisible();
  }
  if (c.zoom !== 100) await page.addStyleTag({ content: `:root { font-size: ${c.zoom}% }` });
  await settle(page);
}

async function assertPhase(page: Page, c: DockCase, phase: string): Promise<void> {
  await assertNoBuildableCellUnderDock(page);
  await assertDialMovesNothing(page, phase);
  await assertRowHeightIsTallestControl(page, phase);
  await assertFloorOrException(page, c, phase);
  await assertNoPartialControl(page, phase);
  await assertScrollCue(page, phase);
  await assertTabWalkShowsEachControl(page, phase);
  // Focus leaves the Dock wherever the walk scrolled it: it is at rest again, and must hold.
  await page.locator('.wy-hud').focus();
  await settle(page);
  await assertNoPartialControl(page, `${phase}, after the Tab walk`);
  await assertScrollCue(page, `${phase}, after the Tab walk`);
  // The END of the scroll range is a resting place too, and must show whole rows only.
  const dock = page.locator('.wy-dock');
  if (await dock.evaluate((el) => el.scrollHeight > el.clientHeight + 1)) {
    await dock.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await settle(page);
    await assertNoPartialControlOnceSettled(page, `${phase}, at the end of the scroll range`);
    await assertScrollCue(page, `${phase}, at the end of the scroll range`);
    await dock.evaluate((el) => el.scrollTo({ top: 0 }));
    await settle(page);
  }
  const audit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
  // The hud is a scrollport too, and the Tab walk scrolls it: in its scroll form the strip is a
  // tab stop, and focusing it scrolls the capped hud down to its line. A user's scroll is not
  // rest, and the next phase's at-rest checks (the countdown's glance among them) measure from
  // rest — so the hud goes back there, as the Dock does above.
  await page.locator('.wy-hud').evaluate((el) => el.scrollTo({ top: 0 }));
  await settle(page);
}

for (const c of HARDENED) {
  const label =
    `${c.width}×${c.height} at ${c.zoom}%` +
    (c.banner ? ', banner up' : '') +
    (c.coarse ? ', coarse pointer' : '') +
    (c.exception ? ' — the floor exception' : '');
  test.describe(`the hardened Dock, ${label} (#152)`, () => {
    if (c.coarse) test.use(COARSE);

    test('before AND after Start: no cell under the Dock, the floor or its one exception, whole controls at rest, the scroll cue, every control whole under Tab, axe clean', async ({
      page,
    }) => {
      await gotoCase(page, c);
      await assertPhase(page, c, 'pre-start');

      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(page.locator('.wy-board')).toHaveAttribute('data-started', 'true');
      await settle(page);
      const startedScrolls = declaredStartedScrolls(c);
      expect(
        await page.locator('.wy-dock').evaluate((el) => el.classList.contains('wy-dock--scroll')),
        `started: the case declares the started Dock ${startedScrolls ? 'scrolls' : 'is whole'}`,
      ).toBe(startedScrolls);
      await assertPhase(page, c, 'started');
    });
  });
}

test.describe('the started Dock scrollport rests on whole rows (#152)', () => {
  test('360×640 at 200%: a wheel nudge part-way into a row settles on a row edge, and the cue follows the range', async ({
    page,
  }) => {
    await gotoCase(page, { width: 360, height: 640, zoom: 200, startedScrolls: true });
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await settle(page);
    const dock = page.locator('.wy-dock');
    expect(
      await dock.evaluate((el) => el.scrollHeight > el.clientHeight + 1),
      'the started Dock must scroll here, or this case probes nothing',
    ).toBe(true);
    await assertScrollCue(page, 'at the top');

    const box = (await regionRect(page, 'dock')) as Rect;
    await page.mouse.move(box.x + 20, box.y + 20);
    // Most of a row, not all of it: a free scroll would come to rest part-way through a
    // control; a snapping one settles on the next row's top edge.
    const rowStep = await dock.evaluate((el) => {
      const tops = [...el.querySelectorAll<HTMLElement>('.wy-btn')]
        .filter((b) => !b.hidden)
        .map((b) => b.offsetTop);
      const distinct = [...new Set(tops)].sort((a, b) => a - b);
      return distinct[1]! - distinct[0]!;
    });
    await page.mouse.wheel(0, Math.round(rowStep * 0.7));
    let last = -1;
    await expect
      .poll(
        async () => {
          const now = await dock.evaluate((el) => el.scrollTop);
          const still = now === last && now > 0;
          last = now;
          return still;
        },
        { intervals: [250] },
      )
      .toBe(true);
    await assertNoPartialControl(page, 'after a wheel nudge');
    await assertScrollCue(page, 'after a wheel nudge');

    await dock.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await settle(page);
    await assertNoPartialControl(page, 'at the end of the range');
    await assertScrollCue(page, 'at the end of the range');
  });

  test('540×509 at 100%, a 24px bottom inset (deeper than the row gap): whole rows at rest, every control clear of the inset, the floor kept', async ({
    page,
  }) => {
    const INSET = 24;
    await gotoCase(page, { width: 540, height: 509, zoom: 100, startedScrolls: true });
    // The Capacitor-owned property the `--wy-safe-*` seam reads (`insets.spec.ts`'s route).
    await page.evaluate(
      (v) => document.documentElement.style.setProperty('--safe-area-inset-bottom', `${v}px`),
      INSET,
    );
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await settle(page);
    const dock = page.locator('.wy-dock');
    await expect(dock, 'the started Dock must scroll here').toHaveClass(/wy-dock--scroll/);
    // The inset band below the rows is the one a padded scrollport would let the next row
    // show through — so at rest nothing may be partly visible, and nothing may sit in it.
    await assertNoPartialControl(page, 'with a bottom inset');
    const lowest = await page.evaluate(() =>
      Math.max(
        ...[...document.querySelectorAll<HTMLElement>('.wy-dock .wy-btn')]
          .filter((el) => !el.hidden)
          .map((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom - 1);
            return hit?.closest('.wy-btn') === el ? r.bottom : -Infinity;
          }),
      ),
    );
    expect(lowest, 'a visible Dock control reaches into the bottom inset').toBeLessThanOrEqual(
      509 - INSET + 0.5,
    );
    await assertFloorOrException(
      page,
      { width: 540, height: 509, zoom: 100, startedScrolls: true },
      'with an inset',
    );
    await assertNoBuildableCellUnderDock(page);
    await assertTabWalkShowsEachControl(page, 'with a bottom inset');
  });

  test('480×509 at 100%, a bottom inset that ARRIVES after the Dock scrolls: the reserve follows it', async ({
    page,
  }) => {
    // Codex P2 on #169: in scroll form the inset lifts the Dock by `bottom`, which MOVES it
    // without resizing any observed box — so an inset written after the scroll form engaged
    // (a native write of `--safe-area-inset-bottom`, or `env()` changing) must still re-sync
    // the reserve, or the lifted Dock covers buildable cells by the inset delta.
    await gotoCase(page, { width: 480, height: 509, zoom: 100, startedScrolls: true });
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await settle(page);
    await expect(page.locator('.wy-dock'), 'the started Dock must scroll here').toHaveClass(
      /wy-dock--scroll/,
    );
    await assertNoBuildableCellUnderDock(page);
    const reserveBefore = await page.evaluate(() =>
      parseFloat(
        getComputedStyle(document.querySelector('.wy-shell')!).getPropertyValue(
          '--wy-dock-reserve',
        ),
      ),
    );
    for (const inset of [24]) {
      await page.evaluate(
        (v) => document.documentElement.style.setProperty('--safe-area-inset-bottom', `${v}px`),
        inset,
      );
      await settle(page);
      await assertNoBuildableCellUnderDock(page);
      await assertNoPartialControl(page, `after a ${inset}px inset arrived`);
      await assertFloorOrException(
        page,
        { width: 480, height: 509, zoom: 100, startedScrolls: true },
        `after a ${inset}px inset arrived`,
      );
    }
    const reserveAfter = await page.evaluate(() =>
      parseFloat(
        getComputedStyle(document.querySelector('.wy-shell')!).getPropertyValue(
          '--wy-dock-reserve',
        ),
      ),
    );
    expect(reserveAfter, 'the reserve must grow with the arriving inset').toBeGreaterThan(
      reserveBefore,
    );
  });

  test('480×509 at 100%, forced colors: the scroll cue survives, inked in the system CanvasText', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await gotoCase(page, { width: 480, height: 509, zoom: 100, startedScrolls: true });
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await settle(page);
    const dock = page.locator('.wy-dock');
    await expect(dock, 'the started Dock must scroll here').toHaveClass(/wy-dock--scroll/);
    // The colour the user's theme gives CanvasText, resolved by the browser — never assumed.
    const ink = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'CanvasText';
      document.body.append(probe);
      const rgb = getComputedStyle(probe).color.match(/\d+/g)!.slice(0, 3).map(Number);
      probe.remove();
      return rgb;
    });
    expect(
      await dock.evaluate((el) => getComputedStyle(el).backgroundImage),
      'forced colors must not strip the cue',
    ).not.toBe('none');
    // The Dock's own box opts OUT of forced colors (so the cue survives); its controls must
    // not follow it out. Each visible control's text and fill must be the user's system
    // colours — resolved by the browser through a probe, never assumed — not the authored
    // theme a control would keep if it inherited the Dock's `forced-color-adjust: none`.
    const controlColours = await page.evaluate(() => {
      const resolve = (prop: 'color' | 'backgroundColor', value: string): string => {
        const probe = document.createElement('span');
        probe.style[prop] = value;
        document.body.append(probe);
        const out = getComputedStyle(probe)[prop];
        probe.remove();
        return out;
      };
      const rgb = (c: string): string => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).join(',');
      const text = ['CanvasText', 'ButtonText'].map((v) => rgb(resolve('color', v)));
      const fill = ['Canvas', 'ButtonFace'].map((v) => rgb(resolve('backgroundColor', v)));
      return [...document.querySelectorAll<HTMLElement>('.wy-dock .wy-btn')]
        .filter((el) => !el.hidden && el.getClientRects().length > 0)
        .map((el) => {
          const cs = getComputedStyle(el);
          return {
            name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
            color: cs.color,
            background: cs.backgroundColor,
            systemText: text.includes(rgb(cs.color)),
            systemFill: fill.includes(rgb(cs.backgroundColor)),
            text,
            fill,
          };
        });
    });
    expect(controlColours.length).toBeGreaterThan(1);
    for (const c of controlColours) {
      expect(
        c.systemText,
        `forced colors: Dock control "${c.name}" text ${c.color} must be a system colour ` +
          `(CanvasText/ButtonText resolve to ${c.text.join(' | ')})`,
      ).toBe(true);
      expect(
        c.systemFill,
        `forced colors: Dock control "${c.name}" fill ${c.background} must be a system colour ` +
          `(Canvas/ButtonFace resolve to ${c.fill.join(' | ')})`,
      ).toBe(true);
    }
    await assertScrollCue(page, 'forced colors, at the top', ink);
    await dock.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await settle(page);
    await assertScrollCue(page, 'forced colors, at the end of the range', ink);
    await assertNoPartialControl(page, 'forced colors');
  });

  test('480×509 at 100%: no point of the started Dock reaches a control that is not wholly in view', async ({
    page,
  }) => {
    await gotoCase(page, { width: 480, height: 509, zoom: 100, startedScrolls: true });
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await settle(page);
    // The premise, asserted like its siblings': an unscrolled Dock has no control to leak.
    await expect(page.locator('.wy-dock'), 'the started Dock must scroll here').toHaveClass(
      /wy-dock--scroll/,
    );
    const box = (await regionRect(page, 'dock')) as Rect;
    const leaks = await page.evaluate((b) => {
      const port = document.querySelector('.wy-dock')!.getBoundingClientRect();
      const out: string[] = [];
      for (let y = Math.ceil(b.y) + 0.5; y < b.y + b.height; y += 2) {
        for (let x = Math.ceil(b.x) + 0.5; x < b.x + b.width; x += 4) {
          const btn = document.elementFromPoint(x, y)?.closest<HTMLElement>('.wy-btn');
          if (!btn) continue;
          const r = btn.getBoundingClientRect();
          if (r.top < port.top - 0.5 || r.bottom > port.bottom + 0.5) {
            out.push(`(${x},${y}) → ${btn.textContent?.trim()}`);
          }
        }
      }
      return out;
    }, box);
    expect(leaks, 'points in the Dock whose tap reaches a control not wholly in view').toEqual([]);
  });
});
