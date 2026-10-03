import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resolvePalette } from '@wynding/render';
import {
  contains,
  intersect,
  projectedGrid,
  regionRect,
  visibleChipAccessibleText,
  type Rect,
} from './layout-probe';
import { callWavePaced, titleAfterCall } from './paced-call';
import { stubFullscreen } from './fullscreen-stub';
import { COMPACT_QUERY } from '../src/layout';

// hud-strip.spec.ts — the icon HUD and the wave strip, measured where they are drawn (#181).
//
// L1 put the wave preview in ONE home, a one-line strip in the status row; H1 gave the chips
// the style frame's icons and put a countdown ring beside the Dock's primary action.
// `stage-stability.spec.ts` pins that no wave can move the board; this file pins what the
// change was FOR — the status row back to one line on the tablets #101's reserved row
// inflated, the strip whole and unclipped inside it, the icons painted with the accessible
// text untouched, and the ring as decoration that agrees with the countdown it decorates.

const STANDARD = { width: 1280, height: 720 };
const PHONE = { width: 658, height: 320 }; // Galaxy S9+ landscape — Compact

async function gotoAt(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await stubFullscreen(page);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
}

/** Two frames, then a board that has stopped moving: a resize's layout and the ResizeObserver
 *  passes it triggers (the Dock reserve, the strip's scroll form) have all landed. */
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

const hex = (colour: number): string => `#${(colour & 0xffffff).toString(16).padStart(6, '0')}`;

test('1080×810: the status row is one line and the board keeps 28px cells — the tablet #101’s reserved row shrank (#181)', async ({
  page,
}) => {
  // The bug that motivated L1: with too little letterbox to float the preview, #101 parked it
  // in a hud row reserved at the full 40dvh — ~284px of status row on this tablet, and a board
  // down from ~29px cells to ~19px.
  await gotoAt(page, { width: 1080, height: 810 });
  expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(false);
  await expect(page.locator('.wy-wave-preview')).toBeVisible();
  const status = (await regionRect(page, 'status')) as Rect;
  expect(status.height, `status row ${status.height}px`).toBeLessThanOrEqual(64);
  const grid = await projectedGrid(page);
  expect(grid.cellPx, `cellPx ${grid.cellPx}`).toBeGreaterThanOrEqual(28);
  const strip = (await page.locator('.wy-wave-preview').boundingBox()) as Rect;
  expect(contains(status, strip), 'the strip sits inside the status row').toBe(true);
  expect(intersect(strip, grid), 'the strip covers part of the board').toBeNull();
});

test('1080×810 at 200% text: the strip shares the wrapped chips’ second line — two lines, the strip wholly on screen (its floor is its smallest useful form)', async ({
  page,
}) => {
  // At 200% the chips wrap after the stars, leaving the countdown chip ~615px of line where
  // the strip's 12rem floor (384px here) fits beside it — on any font stack. A floor sized to
  // a longer line sends the strip to a third line inside the hud's 40dvh cap, partly scrolled
  // out of view, and takes ~57px from the board.
  await gotoAt(page, { width: 1080, height: 810 });
  await page.addStyleTag({ content: ':root { font-size: 200% }' });
  await settle(page);
  const m = await page.evaluate(() => {
    const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const strip = box('.wy-wave-preview');
    const hud = box('.wy-hud');
    const lives = box('.wy-chip[data-wy-chip="lives"]');
    const wave = box('.wy-chip[data-wy-chip="wave"]');
    const middle = strip.top + strip.height / 2;
    return {
      status: box('.wy-status').height,
      belowLives: strip.top >= lives.bottom - 1,
      besideWaveChip: middle > wave.top && middle < wave.bottom,
      inHudView: strip.top >= hud.top - 1 && strip.bottom <= hud.bottom + 1,
    };
  });
  expect(
    m.belowLives,
    'the premise: the chips wrapped, so the strip is under their first line',
  ).toBe(true);
  expect(m.besideWaveChip, 'the strip took a third line instead of sharing the second').toBe(true);
  expect(m.inHudView, 'part of the strip sits in the hud’s scroll range at rest').toBe(true);
  expect(m.status, 'two lines of status row').toBeLessThanOrEqual(190);
});

test('wave 1 and the real wave 9, at 1280×720, 1440×900, 1920×1080 and 1080×810: one status line, the strip whole inside it, unclipped, clear of the board', async ({
  page,
}) => {
  // Seven paced calls at a 5s in-page deadline each, plus four viewports measured twice and an
  // axe audit — above the 60s config default (the marathon specs' budget-coherence rule).
  test.setTimeout(150_000);
  const VIEWS = [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 1080, height: 810 },
  ];
  /** One status line (`home.spec.ts`'s 56px ceiling; 1080×810 gets the brief's 64px), the
   *  strip wholly inside the row, NOTHING clipped (its line no longer than its box, so no scroll
   *  form either), every entry inside the strip, and no pixel of it over the board. */
  async function assertStrip(wave: string): Promise<void> {
    for (const view of VIEWS) {
      await page.setViewportSize(view);
      await settle(page);
      const at = `${wave} at ${view.width}×${view.height}`;
      const status = (await regionRect(page, 'status')) as Rect;
      expect(status.height, `${at}: one status line`).toBeLessThanOrEqual(
        view.width === 1080 ? 64 : 56,
      );
      const m = await page.evaluate(() => {
        const el = document.querySelector('.wy-wave-preview') as HTMLElement;
        const rect = (e: Element): { x: number; y: number; width: number; height: number } => {
          const b = e.getBoundingClientRect();
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        };
        return {
          box: rect(el),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          scrollForm: el.classList.contains('wy-wave-preview--scroll'),
          entries: [...el.querySelectorAll('li')].map(rect),
        };
      });
      expect(contains(status, m.box), `${at}: the strip sits inside the status row`).toBe(true);
      expect(m.scrollWidth, `${at}: the strip's line is clipped`).toBeLessThanOrEqual(
        m.clientWidth + 1,
      );
      expect(m.scrollForm, `${at}: the strip needed its scroll form`).toBe(false);
      expect(m.entries.length, `${at}: entries`).toBeGreaterThan(0);
      for (const entry of m.entries) {
        expect(contains(m.box, entry), `${at}: an entry is cut off`).toBe(true);
      }
      const grid = await projectedGrid(page);
      expect(intersect(m.box, grid), `${at}: the strip covers part of the board`).toBeNull();
    }
  }

  await gotoAt(page, VIEWS[0]!);
  const previewTitle = page.locator('.wy-wave-preview .wy-wave-preview-title');
  await expect(previewTitle).toHaveText('Wave 1 of 10');
  await assertStrip('wave 1');
  // A single-entry wave shows its creep's NAME beside the count where there is room — the
  // frame's form — and at these widths there is: on the strip's one line, not wrapped away.
  for (const view of VIEWS) {
    await page.setViewportSize(view);
    await settle(page);
    const nameOnLine = await page.evaluate(() => {
      const detail = document.querySelector('.wy-wave-preview .wy-preview-detail')!;
      const name = detail.querySelector('.wy-preview-name')!;
      return name.getBoundingClientRect().top < detail.getBoundingClientRect().bottom - 1;
    });
    expect(nameOnLine, `wave 1's name at ${view.width}×${view.height}`).toBe(true);
    await expect(page.locator('.wy-wave-preview .wy-preview-name')).toHaveText('Creep');
  }

  await page.setViewportSize(VIEWS[0]!);
  await page.getByRole('button', { name: 'Start' }).click(); // Start claims wave 1 (#70)
  await expect(previewTitle).toHaveText('Wave 2 of 10');
  await page.getByRole('button', { name: 'Pause' }).click();
  for (let waveNumber = 2; waveNumber <= 8; waveNumber++) {
    await callWavePaced(page, titleAfterCall(waveNumber, 10));
  }
  await expect(previewTitle).toHaveText('Wave 9 of 10');
  await expect(page.locator('.wy-wave-preview li')).toHaveCount(4);
  await assertStrip('wave 9');
  // The densest wave on screen: axe-clean, the strip and its four icons included.
  const audit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
});

test('a strip whose line runs past its edge fades that edge, follows the scroll, costs no width, and keeps the fade under forced colors', async ({
  page,
}) => {
  // 360×640 (portrait Standard) gives the strip 203px beside the home link, and wave 5 is the
  // first real two-entry wave — a line longer than that on any font stack (asserted below, so
  // the test cannot pass vacuously on one whose line happens to fit).
  test.setTimeout(90_000);
  await gotoAt(page, { width: 360, height: 640 });
  const strip = page.locator('.wy-wave-preview');
  const previewTitle = strip.locator('.wy-wave-preview-title');
  await page.getByRole('button', { name: 'Start' }).click(); // Start claims wave 1 (#70)
  await expect(previewTitle).toHaveText('Wave 2 of 10');
  await page.getByRole('button', { name: 'Pause' }).click();
  for (let waveNumber = 2; waveNumber <= 4; waveNumber++) {
    await callWavePaced(page, titleAfterCall(waveNumber, 10));
  }
  await expect(previewTitle).toHaveText('Wave 5 of 10');
  await expect(strip.locator('li')).toHaveCount(2);
  await settle(page);

  const read = () =>
    strip.evaluate((el) => {
      const list = el.querySelector('.wy-wave-preview-list')!.getBoundingClientRect();
      const title = el.querySelector('.wy-wave-preview-title')!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const padStart = box.left + el.clientLeft + parseFloat(cs.paddingLeft);
      return {
        overflows: el.scrollWidth > el.clientWidth + 1,
        scrollForm: el.classList.contains('wy-wave-preview--scroll'),
        before: getComputedStyle(el, '::before').opacity,
        after: getComputedStyle(el, '::after').opacity,
        // The line's own extent — title to last entry, plus the trailing padding — measured
        // from the scrollport's start: what `scrollWidth` must be if the fades add nothing.
        lineExtent:
          list.right - (box.left + el.clientLeft) + el.scrollLeft + parseFloat(cs.paddingRight),
        scrollWidth: el.scrollWidth,
        titleStartOffset: title.left + el.scrollLeft - padStart,
      };
    });

  const rest = await read();
  expect(rest.overflows, 'the premise: wave 5 overflows the strip here').toBe(true);
  expect(rest.scrollForm).toBe(true);
  // At rest the line continues past the trailing edge only.
  expect([rest.before, rest.after]).toEqual(['0', '1']);
  // The fades cost no width: `scrollWidth` is the line's own extent, and the title still
  // starts at the strip's content edge — so the cue can never be what makes it scroll.
  expect(Math.abs(rest.scrollWidth - rest.lineExtent)).toBeLessThanOrEqual(1);
  expect(Math.abs(rest.titleStartOffset)).toBeLessThanOrEqual(1);

  await strip.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await expect.poll(async () => [(await read()).before, (await read()).after]).toEqual(['1', '0']);

  await page.emulateMedia({ forcedColors: 'active' });
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  const forced = await strip.evaluate((el) => ({
    image: getComputedStyle(el, '::before').backgroundImage,
    adjust: getComputedStyle(el, '::before').getPropertyValue('forced-color-adjust'),
    opacity: getComputedStyle(el, '::before').opacity,
  }));
  expect(forced.image, 'forced colors must not strip the fade').not.toBe('none');
  expect(forced.adjust).toBe('none');
  expect(forced.opacity).toBe('1');
  const audit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
});

for (const [layout, size] of [
  ['Standard', STANDARD],
  ['Compact', PHONE],
] as const) {
  test(`${layout}: every chip glance leads with its SVG icon, and the accessible text is unchanged`, async ({
    page,
  }) => {
    await gotoAt(page, size);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(
      layout === 'Compact',
    );
    // The full ICU messages, exactly as before #181 — still each chip's accessible text, in
    // the style frame's order.
    await expect.poll(async () => (await visibleChipAccessibleText(page)).length).toBe(5);
    const text = await visibleChipAccessibleText(page);
    expect(text[0]).toMatch(/^Lives: \d+$/);
    expect(text[1]).toMatch(/^Bounty: \d+$/);
    expect(text[2]).toMatch(/^Stars: \d+ of 3$/);
    expect(text[3]).toMatch(/^Score: \d+$/);
    expect(text[4]).toMatch(/^Wave in \d+s$/);
    for (const slot of ['lives', 'bounty', 'stars', 'score', 'wave']) {
      const shape = await page
        .locator(`.wy-chip[data-wy-chip="${slot}"] .wy-chip-glance`)
        .evaluate((glance) => ({
          glanceHidden: glance.getAttribute('aria-hidden'),
          first: glance.firstElementChild?.tagName.toLowerCase() ?? null,
          iconClass: glance.firstElementChild?.getAttribute('class') ?? null,
          iconHidden: glance.firstElementChild?.getAttribute('aria-hidden') ?? null,
        }));
      expect(shape, slot).toEqual({
        glanceHidden: 'true',
        first: 'svg',
        iconClass: `wy-icon wy-icon--${slot}`,
        iconHidden: 'true',
      });
    }
    // Painted: every icon but the countdown's is on screen in both layouts. The countdown
    // chip's glance shows only where the ring cannot (Compact has no ring).
    for (const slot of ['lives', 'bounty', 'stars', 'score']) {
      await expect(
        page.locator(`.wy-chip[data-wy-chip="${slot}"] svg.wy-icon--${slot}`),
        slot,
      ).toBeVisible();
    }
    const waveIcon = page.locator('.wy-chip[data-wy-chip="wave"] svg.wy-icon--wave');
    if (layout === 'Compact') await expect(waveIcon).toBeVisible();
    else await expect(waveIcon).toBeHidden();
    const audit = await new AxeBuilder({ page }).include('#app').analyze();
    expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
  });
}

test('Standard: the countdown ring is aria-hidden decoration showing the wave chip’s own seconds', async ({
  page,
}) => {
  await gotoAt(page, STANDARD);
  const slot = page.locator('.wy-dock > .wy-dock-ring');
  await expect(slot).toHaveAttribute('aria-hidden', 'true');
  await expect(slot.locator('svg.wy-ring')).toBeVisible();
  // One read, so the ring and the chip are compared at the same instant.
  const read = (): Promise<{ ring: string; chip: string; glance: string }> =>
    page.evaluate(() => ({
      ring: document.querySelector('.wy-dock-ring .wy-ring-text')!.textContent ?? '',
      chip:
        document.querySelector('.wy-chip[data-wy-chip="wave"] .wy-chip-full')!.textContent ?? '',
      glance: getComputedStyle(
        document.querySelector('.wy-chip[data-wy-chip="wave"] .wy-chip-glance')!,
      ).visibility,
    }));
  const agree = (r: { ring: string; chip: string }): void => {
    const seconds = /^Wave in (\d+)s$/.exec(r.chip)?.[1];
    expect(seconds, `the chip's full text "${r.chip}"`).toBeDefined();
    expect(r.ring, 'the ring shows the chip’s seconds').toBe(`${seconds}s`);
  };
  const pre = await read();
  agree(pre);
  // The seconds are shown ONCE: the chip's glance stands down while the ring shows them.
  expect(pre.glance).toBe('hidden');
  await expect(slot.locator('.wy-dock-ring-hint')).toHaveText('until wave 1');
  const audit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);

  // Running: the ring counts the next wave down, still in step with the chip.
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(slot.locator('.wy-dock-ring-hint')).toHaveText(
    'until wave 2 · calling early pays a bounty',
  );
  const first = await read();
  agree(first);
  await expect
    .poll(async () => (await read()).ring, { message: 'the ring counts down' })
    .not.toBe(first.ring);
  agree(await read());
});

test('Compact: no ring — the wave chip’s glance carries the seconds', async ({ page }) => {
  await gotoAt(page, PHONE);
  await expect(page.locator('.wy-dock-ring svg.wy-ring')).toBeHidden();
  const glance = page.locator('.wy-chip[data-wy-chip="wave"] .wy-chip-glance');
  await expect(glance).toBeVisible();
  const full = await page.locator('.wy-chip[data-wy-chip="wave"] .wy-chip-full').textContent();
  const seconds = /^Wave in (\d+)s$/.exec(full ?? '')?.[1];
  expect(seconds).toBeDefined();
  await expect(glance.locator('.wy-chip-value')).toHaveText(`${seconds}s`);
});

test('a colour-vision mode re-inks the strip’s creep icons in place (tritan)', async ({ page }) => {
  await gotoAt(page, STANDARD);
  const body = page.locator('.wy-wave-preview .wy-creep-body').first();
  await expect(body).toHaveAttribute('fill', hex(resolvePalette('default').creep));
  expect(resolvePalette('tritan').creep, 'the premise: tritan inks creeps differently').not.toBe(
    resolvePalette('default').creep,
  );
  await body.evaluate((el) => el.setAttribute('data-probe-identity', 'one'));

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('.wy-settings input[name="wy-colour-mode"][value="tritan"]').check();
  await page.keyboard.press('Escape');
  await expect(body).toHaveAttribute('fill', hex(resolvePalette('tritan').creep));
  // Repainted, never rebuilt: the same node took the new ink.
  await expect(
    page.locator('.wy-wave-preview .wy-creep-body[data-probe-identity="one"]'),
  ).toHaveCount(1);
});
