import { test, expect, type Page } from '@playwright/test';
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
// one-pixel rim across two at about half strength (measured as low as 1.88:1). So the
// backing store is sized to that snapped box (`scene.ts`), and these checks place a tower
// and require each of its plate's four edges to show the rim's own colour at sizes where
// sizing by round(width × dpr) did not match it.

const PAL = resolvePalette('default');
const RIM = rgb(PAL.tower);
/** Per channel. A rim pixel spread across two at half strength is ~40 levels off. */
const TOL = 6;
/** Two committed builds (solid rims) — a Basic Tower, whose barrel points at its plate's top
 *  edge, and a Slow Tower — and a Pending one (a dashed rim), clear of the lane on row 11 and
 *  of each other. */
const BASIC = { col: 14, row: 5 };
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
): Promise<{ miss: number; sides: Record<string, number>; cellPx: number; board: Board }> {
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
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const per: number[] = [];
    for (let t = Math.ceil(size / 4); t <= Math.floor((3 * size) / 4); t++) {
      let best = 255;
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
      }
      per.push(best);
    }
    sides[side] = mode === 'every' ? Math.max(...per) : Math.min(...per);
  }
  return { miss: Math.max(...Object.values(sides)), sides, cellPx: proj.cellPx, board };
}

/** Polls until every rim is in its own colour, or fails with the last measurement. */
async function expectRimsInFullColour(page: Page, label: string): Promise<void> {
  for (const [cell, mode] of [
    [BASIC, 'every'],
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
  await place(/^Basic Tower/, BASIC);
  await place(/^Slow Tower/, SLOW);
  // Both built — paid for at a tick of the running game — before it pauses.
  await expect.poll(bounty).toBeLessThanOrEqual(before - 13); // 5 + 8
  await page.getByRole('button', { name: 'Pause' }).click(); // … and on a paused one is Pending
  await place(/^Basic Tower/, DASHED);
}

for (const [width, height, dsf] of [
  [525, 320, 1],
  [1280, 720, 0.9],
  [1280, 720, 0.8],
] as const) {
  test.describe(`the plate rim at ${width}×${height}, device scale ${dsf}`, () => {
    test.use({ viewport: { width, height }, deviceScaleFactor: dsf });
    test('every edge of a solid and a dashed rim shows the rim’s own colour', async ({ page }) => {
      await stage(page);
      await expectRimsInFullColour(page, `${width}×${height} @${dsf}`);
    });
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
    const boards = new Map<number, Board>();
    for (let w = 482; w <= 635; w++) {
      await page.setViewportSize({ width: w, height: 320 });
      boards.set(w, await boardRect(page));
    }
    const at = (w: number): Board => boards.get(w)!;
    // Where sizing by round(width × dpr) scaled the canvas into its box: the box's snapped
    // span differs from its rounded CSS size on either axis.
    const mismatched = [...boards.keys()].filter(
      (w) =>
        w > 482 &&
        (span(at(w).x, at(w).width) !== Math.round(at(w).width) ||
          span(at(w).y, at(w).height) !== Math.round(at(w).height)),
    );
    // Of those, the ones a window one pixel narrower MOVES the board into without resizing
    // it, changing its span: no ResizeObserver fires there, so only a window resize can
    // re-size the backing store (`scene.ts`).
    const moves = mismatched.filter(
      (w) =>
        at(w).width === at(w - 1).width &&
        at(w).height === at(w - 1).height &&
        (span(at(w).x, at(w).width) !== span(at(w - 1).x, at(w - 1).width) ||
          span(at(w).y, at(w).height) !== span(at(w - 1).y, at(w - 1).height)),
    );
    console.log(
      `[plate-rim] at 320 tall, mismatched: ${mismatched.join(', ')}; moves: ${moves.join(', ')}`,
    );
    expect(mismatched.length).toBeGreaterThanOrEqual(5);
    expect(moves.length).toBeGreaterThanOrEqual(1);
    const spread = (ws: readonly number[], n: number): number[] => [
      ...new Set(
        Array.from({ length: n }, (_, i) => ws[Math.round((i * (ws.length - 1)) / (n - 1))]!),
      ),
    ];
    // Each checked arriving from one pixel narrower, so a move arrives as a move.
    for (const w of [...new Set([...spread(moves, 3), ...spread(mismatched, 4)])]) {
      await page.setViewportSize({ width: w - 1, height: 320 });
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      await page.setViewportSize({ width: w, height: 320 });
      await expectRimsInFullColour(page, `${w}×320 @1, from ${w - 1}`);
    }
  });
});
