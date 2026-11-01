// crossing-board.spec.ts — M3 story 4: the shipped game is the crossing board.
//
// What a player sees of it in a real browser: both pairs drawn, each opening in its own colour
// and pointing the way its creeps travel (the pair's shape cue, read off the screenshot — the
// unit suite pins the exact paint plan, `board-cells.test.ts`); a placement that would seal the
// north route refused like any other illegal build; the strip naming a two-route wave's routes,
// with no axe violation; and, on Compact, all four openings inside the safe area at nonzero
// system-bar insets, since the north entrance and the south exit sit on the board's top and
// bottom edges.

import { test, expect, type Page } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import { PNG } from 'pngjs';
import { createProjection, resolvePalette } from '@wynding/render';
import { GRID } from './layout-probe';
import { callWavePaced, titleAfterCall } from './paced-call';

const PAL = resolvePalette('default');
const PHONE = { width: 658, height: 320 }; // Compact — Galaxy S9+ landscape
/** Per channel: a sample well inside a glyph, away from its anti-aliased edge. */
const TOL = 12;

type Heading = 'east' | 'south';
interface Opening {
  readonly name: string;
  readonly col: number;
  readonly row: number;
  readonly kind: 'entrance' | 'exit';
  readonly heading: Heading;
}
const OPENINGS: readonly Opening[] = [
  { name: 'west entrance', col: 0, row: 11, kind: 'entrance', heading: 'east' },
  { name: 'north entrance', col: 13, row: 0, kind: 'entrance', heading: 'south' },
  { name: 'east exit', col: 27, row: 11, kind: 'exit', heading: 'east' },
  { name: 'south exit', col: 13, row: 23, kind: 'exit', heading: 'south' },
];

const rgb = (hex: number): [number, number, number] => [
  (hex >> 16) & 0xff,
  (hex >> 8) & 0xff,
  hex & 0xff,
];

async function boardBox(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  return page.evaluate(() => {
    const r = document.querySelector('.wy-board')!.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
}

/** The page CSS px of a point given along a heading (`u`) and across it (`v`) in a cell — the
 *  frame the board's glyphs are drawn in. */
async function pointIn(
  page: Page,
  o: Opening,
  u: number,
  v: number,
): Promise<{ x: number; y: number }> {
  const b = await boardBox(page);
  const proj = createProjection({ ...GRID, cssWidth: b.w, cssHeight: b.h, dpr: 1 });
  const p = proj.cellToPixel(o.col, o.row);
  const [dx, dy] = o.heading === 'east' ? [u, v] : [v, u];
  return { x: b.x + p.x + dx * proj.cellPx, y: b.y + p.y + dy * proj.cellPx };
}

/** How far the screenshot's pixel at a page point is from `hex`, worst channel. */
async function missAt(page: Page, at: { x: number; y: number }, hex: number): Promise<number> {
  const vw = await page.evaluate(() => window.innerWidth);
  const png = PNG.sync.read(await page.screenshot({ scale: 'device' }));
  const s = png.width / vw;
  const i = (Math.round(at.y * s) * png.width + Math.round(at.x * s)) << 2;
  return Math.max(...rgb(hex).map((c, k) => Math.abs((png.data[i + k] as number) - c)));
}

async function boardReady(page: Page): Promise<void> {
  await expect(page.locator('.wy-board')).toBeVisible();
  await expect
    .poll(() => page.locator('.wy-board canvas').evaluate((c: HTMLCanvasElement) => c.width))
    .toBeGreaterThan(1);
}

test('the shipped game draws both pairs: each opening in its own colour, pointing the way its creeps travel', async ({
  page,
}) => {
  await page.goto('/');
  await boardReady(page);
  for (const o of OPENINGS) {
    const colour = o.kind === 'entrance' ? PAL.entrance : PAL.exit;
    // The glyph's body, then a point only a glyph pointing THIS way covers: the entrance's
    // triangle three quarters of the way to its tip, the exit's bar.
    const body = await pointIn(page, o, 0.3, 0.5);
    const tip = await pointIn(page, o, o.kind === 'entrance' ? 0.7 : 0.775, 0.5);
    await expect
      .poll(() => missAt(page, body, colour), { message: `${o.name}: its body` })
      .toBeLessThanOrEqual(TOL);
    await expect
      .poll(() => missAt(page, tip, colour), { message: `${o.name}: its heading` })
      .toBeLessThanOrEqual(TOL);
    // Beside the tip the cell is bare floor — a glyph turned a quarter would cover it.
    const across = await pointIn(page, o, 0.7, 0.1);
    expect(await missAt(page, across, colour), `${o.name}: not turned`).toBeGreaterThan(TOL);
  }
});

test('a placement that would seal the north route is refused, the twelve before it standing', async ({
  page,
}) => {
  await page.goto('/');
  await boardReady(page);
  const board = page.locator('.wy-board');
  const card = page.getByRole('button', { name: /Basic Tower/ });
  const live = page.locator('.wy-sr-only[role="status"][aria-live="polite"]');
  // A wall across rows 5–6 from col 1 to col 26 would cut the north entrance off from the
  // south exit, while west → east still runs beneath it. The keyboard cursor starts on the
  // west entrance (0,11): one right and six up is the wall's first anchor, (1,5).
  await card.click();
  await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowUp');
  for (let i = 0; i < 13; i++) {
    if (i > 0) {
      await card.click();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('Enter');
    if (i < 12) {
      await expect(live, `the tower at (${1 + 2 * i}, 5)`).toContainText('placed');
      await expect(board).toHaveAttribute('data-pending-adds', String(i + 1));
    }
  }
  // The thirteenth, at (25,5), would close the wall: refused, as any illegal build is.
  await expect(live).toHaveText("Can't build there.");
  await expect(board).toHaveAttribute('data-pending-adds', '12');
});

test('the strip names each stream’s route — in words beside a lone stream, by arrow on a two-route line — with no axe violation', async ({
  page,
}) => {
  await page.goto('/');
  await boardReady(page);
  const preview = page.locator('.wy-wave-preview');
  // Wave 1, one stream: the arrow leads its row and its route in words leads the detail.
  await expect(preview.locator('.wy-preview-arrow')).toHaveText(['→']);
  await expect(preview.locator('.wy-preview-route-name')).toHaveText(['west to east']);
  await expect(preview.locator('.wy-preview-route-name')).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: 'Pause' }).click();
  // Start claims wave 1, so the calls launch waves 2–4 and wave 5 — the north route's first — is next.
  for (let wave = 2; wave <= 4; wave++) await callWavePaced(page, titleAfterCall(wave, 10));
  await expect(preview.locator('.wy-wave-preview-title')).toHaveText('Wave 5 of 10');
  await expect(preview.locator('.wy-preview-full')).toHaveText([
    '12 × Creep — west to east, ground, armor 0, leak cost 1, no immunities',
    '6 × Swarm Creep — north to south, ground, armor 0, leak cost 1, no immunities',
  ]);
  // Two streams: each row's arrow carries its route; the line has no room for words.
  await expect(preview.locator('.wy-preview-arrow')).toHaveText(['→', '↓']);
  await expect(preview.locator('.wy-preview-arrow').last()).toBeVisible();
  await expect(preview.locator('.wy-preview-route-name')).toHaveCount(0);
  const audit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
});

test('on Compact the strip keeps each route’s arrow and drops its words, the sentence still naming it', async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await boardReady(page);
  const preview = page.locator('.wy-wave-preview');
  await expect(preview.locator('.wy-preview-arrow')).toHaveText(['→']);
  await expect(preview.locator('.wy-preview-arrow').first()).toBeVisible();
  await expect(preview.locator('.wy-preview-route-name').first()).toBeHidden();
  await expect(preview.locator('.wy-preview-full')).toHaveText([
    '10 × Creep — west to east, ground, armor 0, leak cost 1, no immunities',
  ]);
});

test('on Compact all four openings stay inside the safe area under system-bar insets', async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await boardReady(page);
  const insets = { top: 24, right: 29, bottom: 21, left: 37 };
  await page.evaluate((v) => {
    for (const [axis, px] of Object.entries(v)) {
      document.documentElement.style.setProperty(`--safe-area-inset-${axis}`, `${px}px`);
    }
  }, insets);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const b = await boardBox(page);
  const proj = createProjection({ ...GRID, cssWidth: b.w, cssHeight: b.h, dpr: 1 });
  for (const o of OPENINGS) {
    const p = proj.cellToPixel(o.col, o.row);
    const cell = {
      left: b.x + p.x,
      top: b.y + p.y,
      right: b.x + p.x + proj.cellPx,
      bottom: b.y + p.y + proj.cellPx,
    };
    expect(cell.left, `${o.name}: left`).toBeGreaterThanOrEqual(insets.left - 0.5);
    expect(cell.top, `${o.name}: top`).toBeGreaterThanOrEqual(insets.top - 0.5);
    expect(cell.right, `${o.name}: right`).toBeLessThanOrEqual(PHONE.width - insets.right + 0.5);
    expect(cell.bottom, `${o.name}: bottom`).toBeLessThanOrEqual(
      PHONE.height - insets.bottom + 0.5,
    );
  }
});
