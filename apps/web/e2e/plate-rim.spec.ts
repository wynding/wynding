import { test, expect, chromium, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { createProjection, resolvePalette } from '@wynding/render';
import { GRID } from './layout-probe';

// The plate rim, as the screen shows it (#181). A tower's footprint edge is its plate's rim:
// `palette.tower`, 4.08:1 against the floor, drawn on whole device pixels one or two of them
// wide (`alignRectToTexels`). That contrast reaches the screen only if the board's canvas is
// shown pixel for pixel. The browser draws the canvas into the whole device pixels its CSS
// box SNAPS to, and that count depends on where the box sits, not only on its size: at
// 525×320 the board sits at x = 52.5 with w = 328.5, so it covers device pixels 53 to 381 —
// 328 of them, where round(328.5) is 329. A 329-pixel backing store scaled into 328 smears a
// one-pixel rim across two at about half strength (measured as low as 1.88:1). So the store
// is sized to the snapped box (`scene.ts`), and these checks place towers and require each
// plate's four edges to show the rim's own colour where sizing by round(width × dpr) did not
// match it — at dpr 1, and at a real device scale below 1.

const PAL = resolvePalette('default');
const RIM = rgb(PAL.tower);
/** Per channel. A rim pixel spread across two at half strength is ~40 levels off. */
const TOL = 6;
/** Two committed builds (solid rims) and a Pending one (a dashed rim), clear of the lane on
 *  row 11 and of each other. The solid ones are a Splash and a Slow Tower, whose heads keep
 *  clear of their rims. (A Basic Tower's barrel, a head drawn over its plate, ends a 16th of
 *  a pixel short of its rim at 11px cells and dpr 1, and its anti-aliasing darkens the rim's
 *  one pixel along part of the top edge, to 3.65:1 — docs/accessibility-checklist.md. This
 *  spec is about how the rim's own pixels reach the screen.) */
const SPLASH = { col: 14, row: 5 };
const SLOW = { col: 18, row: 5 };
const DASHED = { col: 22, row: 5 };

function rgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

interface Board {
  x: number;
  y: number;
  width: number;
  height: number;
}

const boardRect = (page: Page): Promise<Board> =>
  page.evaluate(() => {
    const r = document.querySelector('.wy-board')!.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });

/** Where the canvas's CSS box would put a cell's centre, page CSS px. */
async function cellCentre(page: Page, col: number, row: number): Promise<{ x: number; y: number }> {
  const b = await boardRect(page);
  const proj = createProjection({ ...GRID, cssWidth: b.width, cssHeight: b.height, dpr: 1 });
  const p = proj.cellToPixel(col, row);
  return { x: b.x + p.x + proj.cellPx / 2, y: b.y + p.y + proj.cellPx / 2 };
}

/**
 * For the tower at `cell`, how far each plate edge stays from the rim's own colour: along the
 * middle half of the edge, every position (`every`) — or at least one (`some`, for a dashed
 * rim) — must have a pixel, somewhere across the band where the rim lies, within that many
 * levels per channel of `palette.tower`.
 */
async function rimMiss(
  page: Page,
  cell: { col: number; row: number },
  mode: 'every' | 'some',
): Promise<{
  miss: number;
  sides: Record<string, number>;
  worst: Record<string, string>;
  cellPx: number;
  board: Board;
}> {
  const board = await boardRect(page);
  const vw = await page.evaluate(() => window.innerWidth);
  const proj = createProjection({
    ...GRID,
    cssWidth: board.width,
    cssHeight: board.height,
    dpr: 1,
  });
  const p = proj.cellToPixel(cell.col, cell.row);
  const png = PNG.sync.read(await page.screenshot({ scale: 'device' }));
  const s = png.width / vw; // device px per CSS px
  // The canvas starts on the device pixel its box snaps to; the sprite's corner on the one
  // its board position snaps to. (A pixel either way is inside the band scanned below.)
  const x0 = Math.round(board.x * s) + Math.round(p.x * s);
  const y0 = Math.round(board.y * s) + Math.round(p.y * s);
  const size = Math.round(2 * proj.cellPx * s);
  const depth = Math.ceil((size * 6) / 64) + 2; // the rim lies within 6/64 of the edge
  const off = (x: number, y: number): number => {
    const i = (y * png.width + x) << 2;
    return Math.max(...RIM.map((v, k) => Math.abs((png.data[i + k] as number) - v)));
  };
  const sides: Record<string, number> = {};
  /** For a failure's message: on each side, where the worst position is, and the column of
   *  pixels across the band there. */
  const worst: Record<string, string> = {};
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const per: number[] = [];
    const bands: string[] = [];
    for (let t = Math.ceil(size / 4); t <= Math.floor((3 * size) / 4); t++) {
      let best = 255;
      const band: string[] = [];
      for (let d = -2; d <= depth; d++) {
        const [x, y] =
          side === 'top'
            ? [x0 + t, y0 + d]
            : side === 'bottom'
              ? [x0 + t, y0 + size - 1 - d]
              : side === 'left'
                ? [x0 + d, y0 + t]
                : [x0 + size - 1 - d, y0 + t];
        best = Math.min(best, off(x, y));
        const i = (y * png.width + x) << 2;
        band.push(`${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`);
      }
      per.push(best);
      bands.push(band.join(' '));
    }
    sides[side] = mode === 'every' ? Math.max(...per) : Math.min(...per);
    const at = per.indexOf(sides[side]!);
    worst[side] = `at ${Math.ceil(size / 4) + at} of ${size}: ${bands[at]}`;
  }
  return { miss: Math.max(...Object.values(sides)), sides, worst, cellPx: proj.cellPx, board };
}

/** Polls until every rim is in its own colour, or fails with the last measurement. */
async function expectRimsInFullColour(page: Page, label: string): Promise<void> {
  for (const [cell, mode] of [
    [SPLASH, 'every'],
    [SLOW, 'every'],
    [DASHED, 'some'],
  ] as const) {
    let last: Awaited<ReturnType<typeof rimMiss>> | undefined;
    await expect
      .poll(
        async () => {
          last = await rimMiss(page, cell, mode);
          return last.miss;
        },
        { message: `${label}: the ${mode === 'every' ? 'solid' : 'dashed'} rim`, timeout: 10_000 },
      )
      .toBeLessThanOrEqual(TOL)
      .finally(() => console.log(`[plate-rim] ${label} ${mode}: ${JSON.stringify(last)}`));
  }
}

/** Two committed towers and a Pending one, the game paused. */
async function stage(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
  await expect
    .poll(() => page.locator('.wy-board canvas').evaluate((c: HTMLCanvasElement) => c.width))
    .toBeGreaterThan(1);
  // The floating wave preview is DOM chrome over the Stage; this spec reads the canvas.
  await page.evaluate(() => {
    const preview = document.querySelector<HTMLElement>('.wy-wave-preview');
    if (preview) preview.hidden = true;
  });
  const place = async (name: RegExp, cell: { col: number; row: number }): Promise<void> => {
    await page.getByRole('button', { name }).click();
    const c = await cellCentre(page, cell.col, cell.row);
    await page.mouse.click(c.x, c.y);
    await page.keyboard.press('Escape');
    await page.mouse.move(1, 1);
  };
  const bountyChip = page.locator('.wy-chip[data-wy-chip="bounty"] .wy-chip-full');
  const bounty = async (): Promise<number> =>
    Number(/(\d+)/.exec((await bountyChip.textContent()) ?? '')?.[1] ?? NaN);
  const before = await bounty();
  await page.getByRole('button', { name: 'Start' }).click(); // a build on a running game commits
  await place(/^Splash Tower/, SPLASH);
  await place(/^Slow Tower/, SLOW);
  // Both built — paid for at a tick of the running game — before it pauses.
  await expect.poll(bounty).toBeLessThanOrEqual(before - 20); // 12 + 8
  await page.getByRole('button', { name: 'Pause' }).click(); // … and on a paused one is Pending
  await place(/^Basic Tower/, DASHED);
}

test.describe('the plate rim at 525×320, device scale 1', () => {
  test.use({ viewport: { width: 525, height: 320 }, deviceScaleFactor: 1 });
  test('every edge of a solid and a dashed rim shows the rim’s own colour', async ({ page }) => {
    await stage(page);
    await expectRimsInFullColour(page, '525×320 @1');
  });
});

// A device scale below 1 — a screen, or browser zoom, at 0.9 or 0.8 — needs a browser that
// really runs at that scale: Playwright's `deviceScaleFactor` only EMULATES one, laying the
// page out in CSS px and scaling its picture, which resamples the canvas whatever its
// backing size. `--force-device-scale-factor` gives the real thing, where layout is in
// device pixels and the canvas is drawn into the pixels its box snaps to.
for (const dsf of [0.9, 0.8] as const) {
  test(`the plate rim at 1280×720, a real device scale of ${dsf}: every edge of a solid and a dashed rim shows the rim’s own colour`, async ({
    baseURL,
  }) => {
    const browser = await chromium.launch({
      args: [`--force-device-scale-factor=${dsf}`, '--window-size=1280,720'],
    });
    try {
      // `deviceScaleFactor: undefined` keeps Playwright Test from filling in the project's
      // emulated scale, which a context without a viewport refuses.
      const page = await (
        await browser.newContext({ viewport: null, deviceScaleFactor: undefined, baseURL })
      ).newPage();
      await stage(page);
      // A 1280×720 page at that scale, not an emulated one.
      expect(
        await page.evaluate(() => [innerWidth, innerHeight, Math.round(devicePixelRatio * 100)]),
      ).toEqual([1280, 720, Math.round(dsf * 100)]);
      await expectRimsInFullColour(page, `1280×720 @${dsf}`);
    } finally {
      await browser.close();
    }
  });
}

test.describe('the plate rim across window widths, 320 tall', () => {
  test.use({ viewport: { width: 525, height: 320 }, deviceScaleFactor: 1 });
  test('at widths where the board’s device box is not its rounded CSS size, every rim edge shows its own colour', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await stage(page);
    // The board at every width from 482 to 635. (At dpr 1 a layout position is a whole 64th
    // of a pixel, exact in a double, so these spans are the browser's own.)
    const span = (start: number, size: number): number =>
      Math.round(start + size) - Math.round(start);
    const mismatched: number[] = [];
    let moved = 0; // widths where the board moved without resizing
    let last: Board | undefined;
    for (let w = 482; w <= 635; w++) {
      await page.setViewportSize({ width: w, height: 320 });
      const b = await boardRect(page);
      // Where sizing by round(width × dpr) scaled the canvas into its box: the box's snapped
      // span differs from its rounded CSS size on either axis.
      if (
        span(b.x, b.width) !== Math.round(b.width) ||
        span(b.y, b.height) !== Math.round(b.height)
      )
        mismatched.push(w);
      const resized = last === undefined || b.width !== last.width || b.height !== last.height;
      if (!resized && (b.x !== last!.x || b.y !== last!.y)) moved++;
      last = b;
    }
    console.log(
      `[plate-rim] at 320 tall, mismatched: ${mismatched.join(', ')}; moved alone: ${moved}`,
    );
    expect(mismatched.length).toBeGreaterThanOrEqual(5);
    // The board fills its Stage: a width that moves it also resizes it, so the ResizeObserver
    // re-sizes the backing store wherever it moves (`scene.ts`).
    expect(moved).toBe(0);
    // Five of them, spread across the range, each reached from a pixel narrower.
    const picks = [
      ...new Set(
        [0, 1, 2, 3, 4].map((i) => mismatched[Math.round((i * (mismatched.length - 1)) / 4)]!),
      ),
    ];
    for (const w of picks) {
      await page.setViewportSize({ width: w - 1, height: 320 });
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      await page.setViewportSize({ width: w, height: 320 });
      await expectRimsInFullColour(page, `${w}×320 @1`);
    }
  });
});
