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
    test(`${size.width}×${size.height}: no buildable cell renders under the Dock, and every edge cell hit-tests to the board`, async ({
      page,
    }) => {
      await gotoStandard(page, size);
      await settle(page);
      await assertNoBuildableCellUnderDock(page);
      await assertEdgeCellsHitTheBoard(page);
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

interface DockCase {
  readonly width: number;
  readonly height: number;
  /** Root font size, percent — the text-zoom model every zoom case in this suite uses. */
  readonly zoom: number;
  readonly banner?: boolean;
  readonly coarse?: boolean;
  /** Owner ruling 2's single floor exception is EXPECTED here: the Stage is too short for one
   *  whole Dock row and the board's floor both, so the row wins. Every other case must NOT
   *  meet the exception's condition — the test proves the condition, not just the outcome. */
  readonly exception?: boolean;
}

const HARDENED: readonly DockCase[] = [
  { width: 540, height: 556, zoom: 100 },
  { width: 540, height: 578, zoom: 100 },
  { width: 800, height: 501, zoom: 150 },
  { width: 1080, height: 600, zoom: 200 },
  { width: 640, height: 560, zoom: 200, banner: true, coarse: true },
  { width: 640, height: 560, zoom: 200 },
  { width: 360, height: 640, zoom: 200 },
  { width: 1280, height: 800, zoom: 100, coarse: true },
  { width: 900, height: 501, zoom: 175, exception: true },
  // Fractional RESERVES, not just fractional Stages: under 100% text the float offset is
  // 0.5rem = 7.2px, so the Dock's band is never a whole px. A reserve rounded up to a whole px
  // leaves these boards 287.6px tall — 11px cells — with no exception to excuse it.
  { width: 540, height: 506, zoom: 90 },
  { width: 360, height: 591, zoom: 90 },
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

/** Tab into the Dock from the chips scrollport and walk every visible control. Each must be
 *  the next Tab stop and, focused, be WHOLLY reachable (hit-tested) — scrolled into view, never
 *  left under an edge. */
async function assertTabWalkShowsEachControl(page: Page, phase: string): Promise<void> {
  const controls = page.locator('.wy-dock .wy-btn:visible');
  const count = await controls.count();
  expect(count).toBeGreaterThan(1);
  await page.locator('.wy-hud').focus();
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
  }
}

/** The scroll cue, read from rendered pixels in the Dock's right-hand gutter: how many pixel
 *  rows carry cue colour at all (the TRACK), and how many near each end are WIDE (≥ 6px across
 *  — a CHEVRON; the 2px track never is). Colour is how the probe finds the cue; the claim is
 *  its shape and its place. */
async function cuePixels(page: Page): Promise<{ track: number; top: number; bottom: number }> {
  const box = (await regionRect(page, 'dock')) as Rect;
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--wy-accent').trim(),
  );
  const want = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16));
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
async function assertScrollCue(page: Page, phase: string): Promise<void> {
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
  const px = await cuePixels(page);
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
  await assertFloorOrException(page, c, phase);
  await assertNoPartialControl(page, phase);
  await assertScrollCue(page, phase);
  await assertTabWalkShowsEachControl(page, phase);
  // Focus leaves the Dock wherever the walk scrolled it: it is at rest again, and must hold.
  await page.locator('.wy-hud').focus();
  await settle(page);
  await assertNoPartialControl(page, `${phase}, after the Tab walk`);
  await assertScrollCue(page, `${phase}, after the Tab walk`);
  const audit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
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
      await assertPhase(page, c, 'started');
    });
  });
}

test.describe('the started Dock scrollport rests on whole rows (#152)', () => {
  test('360×640 at 200%: a wheel nudge part-way into a row settles on a row edge, and the cue follows the range', async ({
    page,
  }) => {
    await gotoCase(page, { width: 360, height: 640, zoom: 200 });
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

  test('540×556 at 100%, a 24px bottom inset (deeper than the row gap): whole rows at rest, every control clear of the inset, the floor kept', async ({
    page,
  }) => {
    const INSET = 24;
    await gotoCase(page, { width: 540, height: 556, zoom: 100 });
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
      556 - INSET + 0.5,
    );
    await assertFloorOrException(page, { width: 540, height: 556, zoom: 100 }, 'with an inset');
    await assertNoBuildableCellUnderDock(page);
    await assertTabWalkShowsEachControl(page, 'with a bottom inset');
  });

  test('540×556 at 100%: no point of the started Dock reaches a control that is not wholly in view', async ({
    page,
  }) => {
    await gotoCase(page, { width: 540, height: 556, zoom: 100 });
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await settle(page);
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
