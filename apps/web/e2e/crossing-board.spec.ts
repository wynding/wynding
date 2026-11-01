// crossing-board.spec.ts — M3 story 4: the shipped game is the crossing board.
//
// What a player sees of it in a real browser: both pairs drawn, each opening in its own colour
// and pointing the way its creeps travel (the pair's shape cue, read off the screenshot — the
// unit suite pins the exact paint plan, `board-cells.test.ts`); a placement that would seal the
// north route refused like any other illegal build; the strip naming a two-route wave's routes,
// with no axe violation; and, on Compact, all four openings drawn and uncovered inside the safe
// area at nonzero system-bar insets, since the north entrance and the south exit sit on the
// board's top and bottom edges. Then the wave's hit-point clause, which no shipped wave shows
// yet, on the waves harness: stacked whole under the strip's title on Standard, wrapped inside
// the column on Compact, at 100% and 200% text.

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

/** System-bar insets, CSS px, as `--safe-area-inset-*` (`insets.spec.ts`'s seam), and the cell
 *  size the board keeps under them at 658×320 — 13 px with none. */
const INSET_CASES = [
  // A phone on its side with a notch at each end and a home bar: the board keeps 12 px.
  { name: 'notch and home bar', insets: { top: 0, right: 47, bottom: 21, left: 47 }, floor: 12 },
  // A status bar along the top and a navigation bar down one side: 12 px.
  { name: 'status and side bars', insets: { top: 24, right: 0, bottom: 0, left: 48 }, floor: 12 },
  // Every side at once. The north entrance and the south exit sit in the board's top and bottom
  // rows, so the board pays both vertical insets in full: 320 − 24 − 21 = 275 px for 24 rows is
  // 11 px a cell. 12 would need 288, more than the safe area holds, so this case keeps 11 — the
  // trade for both pairs' openings staying on screen (`compact.spec.ts`'s 12 px floor is at no
  // inset).
  { name: 'all four sides', insets: { top: 24, right: 29, bottom: 21, left: 37 }, floor: 11 },
] as const;

for (const { name, insets, floor } of INSET_CASES) {
  test(`on Compact all four openings stay drawn and uncovered inside the safe area: ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/');
    await boardReady(page);
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
    expect(proj.cellPx, `${name}: the board's cells`).toBeGreaterThanOrEqual(floor);
    for (const o of OPENINGS) {
      const p = proj.cellToPixel(o.col, o.row);
      const cell = {
        left: b.x + p.x,
        top: b.y + p.y,
        right: b.x + p.x + proj.cellPx,
        bottom: b.y + p.y + proj.cellPx,
      };
      // Inside the safe area…
      expect(cell.left, `${o.name}: left`).toBeGreaterThanOrEqual(insets.left - 0.5);
      expect(cell.top, `${o.name}: top`).toBeGreaterThanOrEqual(insets.top - 0.5);
      expect(cell.right, `${o.name}: right`).toBeLessThanOrEqual(PHONE.width - insets.right + 0.5);
      expect(cell.bottom, `${o.name}: bottom`).toBeLessThanOrEqual(
        PHONE.height - insets.bottom + 0.5,
      );
      // …uncovered: what is hit at the cell's centre is the board, not chrome over it…
      const centre = { x: (cell.left + cell.right) / 2, y: (cell.top + cell.bottom) / 2 };
      const onBoard = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest('.wy-board') != null,
        centre,
      );
      expect(onBoard, `${o.name}: the board is what is hit at its centre`).toBe(true);
      // …and drawn there in its own colour, by the board as it now stands.
      const colour = o.kind === 'entrance' ? PAL.entrance : PAL.exit;
      await expect
        .poll(async () => missAt(page, await pointIn(page, o, 0.3, 0.5), colour), {
          message: `${o.name}: drawn`,
        })
        .toBeLessThanOrEqual(TOL);
    }
  });
}

// --- The wave's hit-point clause, in a browser (M3) -----------------------------------------
// No shipped wave changes its creeps' hit points yet, so these run on the waves harness
// (`e2e-harness/waves-entry.ts`): the real app on the shipped bundle with every wave's
// `hpPercent` set (`?hp=`), and wave 1 given wave 9's four streams on two routes (`&wave=9`),
// the densest line the strip shows.

const WAVES = 'http://localhost:4176/e2e-harness/waves.html';

async function openWaves(page: Page, query: string, zoom: 100 | 200): Promise<void> {
  await page.goto(`${WAVES}?${query}`);
  if (zoom === 200) await page.addStyleTag({ content: ':root { font-size: 200% }' });
  await expect(page.locator('.wy-wave-preview-title')).toHaveText('Wave 1 of 10');
  await expect(page.locator('.wy-wave-preview li')).toHaveCount(4);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/** The Standard strip's head: where the rows start, the title's and the clause's text widths,
 *  whether the clause's text lies wholly inside the strip's visible box, and whether it sits
 *  under the title. */
async function stripHead(page: Page): Promise<{
  rowsAt: number;
  titleText: number;
  hpText: number;
  hpWhole: boolean;
  stacked: boolean;
}> {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('.wy-wave-preview')!;
    strip.scrollLeft = 0;
    const box = strip.getBoundingClientRect();
    const left = box.left + strip.clientLeft;
    const top = box.top + strip.clientTop;
    const textOf = (el: Element): DOMRect => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect();
    };
    const title = document.querySelector('.wy-wave-preview-title')!;
    const hp = document.querySelector<HTMLElement>('.wy-wave-preview-hp')!;
    const text = textOf(hp.querySelector('.wy-preview-hp-glance')!);
    const t = title.getBoundingClientRect();
    const h = hp.getBoundingClientRect();
    return {
      rowsAt: document.querySelector('.wy-wave-preview-list')!.getBoundingClientRect().left,
      titleText: textOf(title).width,
      hpText: hp.hidden ? 0 : text.width,
      hpWhole:
        !hp.hidden &&
        text.width > 0 &&
        text.left >= left - 0.5 &&
        text.right <= left + strip.clientWidth + 0.5 &&
        text.top >= top - 0.5 &&
        text.bottom <= top + strip.clientHeight + 0.5,
      stacked: !hp.hidden && h.top >= t.bottom - 0.5 && Math.abs(h.left - t.left) < 0.5,
    };
  });
}

for (const [zoom, hp, glance, sentence] of [
  [100, 170, '+70% hit points', 'Every creep in this wave has +70% hit points'],
  [200, 80, '20% fewer hit points', 'Every creep in this wave has 20% fewer hit points'],
] as const) {
  test(`Standard at ${String(zoom)}% text: the hit-point clause stacks whole under the title, moving the rows only by what it is wider than the title`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openWaves(page, 'hp=100&wave=9', zoom);
    const plain = await stripHead(page);
    await openWaves(page, `hp=${String(hp)}&wave=9`, zoom);
    const strip = page.locator('.wy-wave-preview');
    await expect(strip.locator('.wy-preview-hp-glance')).toHaveText(glance);
    await expect(strip.locator('.wy-preview-hp-glance')).toBeVisible();
    await expect(strip.locator('.wy-preview-hp-full')).toHaveText(sentence);
    const grown = await stripHead(page);
    expect(grown.stacked, 'the clause sits under the title, aligned with it').toBe(true);
    expect(grown.hpWhole, 'the clause is wholly inside the strip: nothing clipped').toBe(true);
    // Beside the title it would push the rows by its whole width (~110 px); stacked, only by
    // its excess over the title's — none at all where the title is the wider.
    expect(grown.rowsAt - plain.rowsAt).toBeCloseTo(Math.max(0, grown.hpText - plain.titleText), 0);
    if (zoom === 100) {
      const audit = await new AxeBuilder({ page }).include('#app').analyze();
      expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
    }
  });
}

for (const zoom of [100, 200] as const) {
  test(`Compact at ${String(zoom)}% text: the hit-point clause wraps inside the column, and the column rests on whole items`, async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await openWaves(page, 'hp=80&wave=9', zoom);
    await expect(page.locator('.wy-preview-hp-full')).toHaveText(
      'Every creep in this wave has 20% fewer hit points',
    );
    const column = await page.evaluate(() => {
      const hud = document.querySelector<HTMLElement>('.wy-hud')!;
      hud.scrollTop = 0; // at rest
      const h = hud.getBoundingClientRect();
      const top = h.top + hud.clientTop;
      const bottom = h.bottom - parseFloat(getComputedStyle(hud).borderBottomWidth);
      // The column's items as `hud-cut.ts` counts them, the clause among them.
      const items = [
        ...hud.querySelectorAll<HTMLElement>(
          ':scope > .wy-chip, :scope > .wy-wave-preview .wy-wave-preview-title, ' +
            ':scope > .wy-wave-preview .wy-wave-preview-hp, ' +
            ':scope > .wy-wave-preview .wy-preview-entry',
        ),
      ]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.height > 0);
      const shownWhole = items.filter((r) => r.top >= top - 0.5 && r.bottom <= bottom + 0.5);
      const straddling = items.filter((r) => r.top < bottom - 0.5 && r.bottom > bottom + 0.5);
      // Then the clause itself: every line of it within the column's width, and — the column
      // scrolls, and at 200% the clause is taller than what a 320px phone leaves it at rest —
      // each line, scrolled to, shown whole.
      const hp = hud.querySelector<HTMLElement>('.wy-wave-preview-hp')!;
      const left = h.left + hud.clientLeft;
      const right = left + hud.clientWidth;
      const glanceLines = (): DOMRect[] => {
        const range = document.createRange();
        range.selectNodeContents(hp.querySelector('.wy-preview-hp-glance')!);
        return [...range.getClientRects()].filter((r) => r.width > 0);
      };
      const lines = glanceLines();
      const sideways = lines.filter((r) => r.left < left - 0.5 || r.right > right + 0.5).length;
      let unseen = 0;
      for (let i = 0; i < lines.length; i++) {
        const before = glanceLines()[i]!;
        hud.scrollTop += before.top - top; // this line to the top of the visible box
        const r = glanceLines()[i]!;
        if (r.top < top - 0.5 || r.bottom > bottom + 0.5) unseen++;
      }
      hud.scrollTop = 0;
      return {
        sideways: hud.scrollWidth - hud.clientWidth,
        shownWhole: shownWhole.length,
        straddling: straddling.length,
        lines: lines.length,
        linesPastColumn: sideways,
        linesUnseen: unseen,
      };
    });
    expect(column.sideways, 'nothing runs past the column sideways').toBeLessThanOrEqual(0);
    expect(column.lines, 'the clause is painted').toBeGreaterThan(0);
    expect(column.linesPastColumn, 'every line of the clause within the column').toBe(0);
    expect(column.linesUnseen, 'every line of the clause can be scrolled to whole').toBe(0);
    if (column.shownWhole > 0) {
      expect(column.straddling, "no item cut by the column's edge at rest").toBe(0);
    }
  });
}
