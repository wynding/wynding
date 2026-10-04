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
// the style frame's icons, and a countdown dial inside the Dock's primary action (#181 QC: it
// replaced a ring beside the Dock). `stage-stability.spec.ts` pins that no wave can move the
// board; this file pins what the change was FOR — the status row back to one line on the
// tablets #101's reserved row inflated, the strip whole and unclipped inside it, the icons
// painted with the accessible text untouched, the countdown readable in the chip that leads
// the hud, and the dial as decoration that adds nothing to the control it sits in.

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
  // At 200% the chips wrap after the stars — the countdown, lives, bounty and stars on the first
  // line — and the score chip leaves ~500–540px of the second, where the strip's 12rem floor
  // (384px here) fits beside it, on macOS's font stack and CI's (DejaVu Sans) alike. A floor
  // sized to a longer line sends the strip to a third line inside the hud's 40dvh cap, partly
  // scrolled out of view, and takes ~57px from the board. The lines are found from the chips
  // themselves, so the check does not depend on which chip the row wraps before.
  await gotoAt(page, { width: 1080, height: 810 });
  await page.addStyleTag({ content: ':root { font-size: 200% }' });
  await settle(page);
  const m = await page.evaluate(() => {
    const box = (el: Element): DOMRect => el.getBoundingClientRect();
    const strip = box(document.querySelector('.wy-wave-preview')!);
    const hud = box(document.querySelector('.wy-hud')!);
    const chips = [...document.querySelectorAll('.wy-hud > .wy-chip')].map(box);
    // Chips that overlap vertically share a line (1px tolerance); the rest start a new one.
    const lines: DOMRect[][] = [];
    for (const chip of chips) {
      const line = lines.find((l) =>
        l.some((c) => chip.top < c.bottom - 1 && c.top < chip.bottom - 1),
      );
      if (line === undefined) lines.push([chip]);
      else line.push(chip);
    }
    const middle = strip.top + strip.height / 2;
    const first = lines[0]!;
    const second = lines[1] ?? [];
    return {
      status: box(document.querySelector('.wy-status')!).height,
      chipLines: lines.length,
      belowFirstLine: strip.top >= Math.max(...first.map((c) => c.bottom)) - 1,
      besideSecondLine: second.some((c) => middle > c.top && middle < c.bottom),
      inHudView: strip.top >= hud.top - 1 && strip.bottom <= hud.bottom + 1,
    };
  });
  expect(m.chipLines, 'the premise: the chips wrapped onto exactly two lines').toBe(2);
  expect(
    m.belowFirstLine,
    'the premise: the chips wrapped, so the strip is under their first line',
  ).toBe(true);
  expect(m.besideSecondLine, 'the strip took a third line instead of sharing the second').toBe(
    true,
  );
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

test('a strip whose line runs past its edge fades that edge, follows the scroll and costs no width', async ({
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

  const audit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
});

test('forced colors: every HUD icon and the strip’s creep icon take the user’s system colours, the dial follows its control’s, and the strip’s fade survives', async ({
  page,
}) => {
  // Chromium does not force SVG `fill` or `stroke`, so without `ui.css`'s forced-colors block
  // the countdown clock and the chips' icons stay near-white on the user's Canvas. Emulated
  // BEFORE the page loads, as the Dock's forced-colors test does. No axe audit in this state:
  // under emulated forced colors axe-core reports the authored text colour (it reads
  // `-webkit-text-fill-color`, which Chromium leaves unforced while it paints the forced one —
  // 26 such findings on the commit before #181), so the inks are checked against the system
  // colours themselves, resolved by the browser.
  await page.emulateMedia({ forcedColors: 'active' });
  await gotoAt(page, STANDARD);
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  await expect(page.locator('.wy-dock .wy-primary > .wy-dial')).toBeVisible();
  await expect(page.locator('.wy-wave-preview .wy-creep-icon')).toHaveCount(1);
  const inks = await page.evaluate(() => {
    const system = (value: string): string => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.append(probe);
      const out = getComputedStyle(probe).color;
      probe.remove();
      return out;
    };
    const paint = (sel: string, prop: 'fill' | 'stroke'): string[] =>
      [...document.querySelectorAll(sel)].map((el) => getComputedStyle(el)[prop]);
    const primary = document.querySelector<HTMLElement>('.wy-dock .wy-primary')!;
    const style = (sel: string): CSSStyleDeclaration =>
      getComputedStyle(primary.querySelector(sel)!);
    return {
      canvasText: system('CanvasText'),
      canvas: system('Canvas'),
      buttonText: system('ButtonText'),
      bodies: paint('.wy-hud .wy-icon .wy-icon-body', 'fill'),
      lines: paint('.wy-hud .wy-icon .wy-icon-line', 'stroke'),
      facets: paint('.wy-hud .wy-icon .wy-icon-facets', 'stroke'),
      creep: paint('.wy-wave-preview .wy-creep-body', 'fill'),
      control: getComputedStyle(primary).color,
      grayText: system('GrayText'),
      wedge: style('.wy-dial-wedge').stroke,
      ring: style('.wy-dial-ring').stroke,
      crown: style('.wy-dial-crown').stroke,
      face: style('.wy-dial-track').fill,
      faceOpacity: style('.wy-dial-track').fillOpacity,
      labelFill: style('.wy-btn-text').backgroundColor,
      fade: getComputedStyle(document.querySelector('.wy-wave-preview')!, '::after')
        .backgroundImage,
      fadeAdjust: getComputedStyle(
        document.querySelector('.wy-wave-preview')!,
        '::after',
      ).getPropertyValue('forced-color-adjust'),
    };
  });
  expect(inks.canvasText).not.toBe(inks.canvas);
  // lives, bounty, stars and score bodies; the countdown clock's lines.
  expect(inks.bodies).toHaveLength(4);
  for (const ink of [...inks.bodies, ...inks.lines, ...inks.creep]) {
    expect(ink).toBe(inks.canvasText);
  }
  expect(inks.lines.length).toBeGreaterThan(0);
  expect(inks.creep).toHaveLength(1);
  expect(inks.facets).toEqual([inks.canvas]); // drawn on the gem's body, in the colour around it
  // The dial (#181 QC round 2, a stopwatch face): the remaining-time wedge, the ring and the
  // crown in the control's own system ink, ButtonText; the spent face in GrayText at full
  // strength — a second system colour, where the dimmed first the default theme uses would not
  // stay apart in a forced palette.
  expect([inks.buttonText, inks.canvasText]).toContain(inks.control);
  for (const part of [inks.wedge, inks.ring, inks.crown]) expect(part).toBe(inks.buttonText);
  expect(inks.face).toBe(inks.grayText);
  expect(inks.faceOpacity).toBe('1');
  expect(inks.grayText, 'the spent face stays apart from the remaining wedge').not.toBe(
    inks.buttonText,
  );
  // The label paints no box of its own (#181 QC round 2: a mask that once covered the dial
  // painted accent boxes outside the control). Only the ALPHA is compared — the UA forces a
  // colour's channels to a system colour and keeps the authored alpha, so a transparent fill
  // computes as Canvas at alpha 0.
  expect(inks.labelFill, 'the label paints no box under forced colors').toMatch(
    /^rgba\(\d+, \d+, \d+, 0\)$/,
  );
  // The fade is a background image, which forced colors would otherwise drop.
  expect(inks.fade, 'forced colors must not strip the strip’s fade').not.toBe('none');
  expect(inks.fadeAdjust).toBe('none');
});

// The third case is Compact at 200% text, where the glances wrap and the countdown's seconds sit
// ABOVE its clock (#181 QC round 2): `wrap-reverse` reorders the lines on screen only, so the DOM
// still leads with the icon and the accessible text is the same, in the same order.
for (const [layout, size, zoom] of [
  ['Standard', STANDARD, 100],
  ['Compact', PHONE, 100],
  ['Compact at 200% text', PHONE, 200],
] as const) {
  test(`${layout}: every chip glance leads with its SVG icon, and the accessible text is unchanged`, async ({
    page,
  }) => {
    await gotoAt(page, size);
    if (zoom !== 100) await page.addStyleTag({ content: `:root { font-size: ${zoom}% }` });
    await settle(page);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(
      layout !== 'Standard',
    );
    // The full ICU messages, exactly as before #181 — still each chip's accessible text — with
    // the countdown first (#181 QC), then the style frame's order.
    await expect.poll(async () => (await visibleChipAccessibleText(page)).length).toBe(5);
    const text = await visibleChipAccessibleText(page);
    expect(text[0]).toMatch(/^Wave in \d+s$/);
    expect(text[1]).toMatch(/^Lives: \d+$/);
    expect(text[2]).toMatch(/^Bounty: \d+$/);
    expect(text[3]).toMatch(/^Stars: \d+ of 3$/);
    expect(text[4]).toMatch(/^Score: \d+$/);
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
    if (zoom !== 100) {
      // On screen the countdown's seconds lead — above its clock — while its DOM leads with it.
      const order = await page
        .locator('.wy-chip[data-wy-chip="wave"] .wy-chip-glance')
        .evaluate((g) => ({
          icon: g.querySelector('svg')!.getBoundingClientRect().top,
          value: g.querySelector('.wy-chip-value')!.getBoundingClientRect().bottom,
        }));
      expect(order.value, 'the seconds sit above the clock').toBeLessThanOrEqual(order.icon + 0.5);
    }
    // Painted: EVERY icon is on screen in both layouts — the countdown's included, whose glance
    // is the one readable countdown (#181 QC: it no longer stands down for anything).
    for (const slot of ['wave', 'lives', 'bounty', 'stars', 'score']) {
      await expect(
        page.locator(`.wy-chip[data-wy-chip="${slot}"] svg.wy-icon--${slot}`),
        slot,
      ).toBeVisible();
    }
    const audit = await new AxeBuilder({ page }).include('#app').analyze();
    expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
  });
}

test('Standard: the dial is aria-hidden decoration inside the primary control, the chip reads the seconds, and the control notes the early-call bonus only once a call would pay', async ({
  page,
}) => {
  await gotoAt(page, STANDARD);
  const primary = page.locator('.wy-dock .wy-primary');
  const dial = primary.locator(':scope > .wy-dial');
  await expect(dial).toHaveAttribute('aria-hidden', 'true');
  // Drawn where the Dock pass measured room for it (#181 QC round 2) — as it has here.
  await expect(primary).toHaveClass(/(^|\s)wy-primary--dial(\s|$)/);
  await expect(dial).toBeVisible();
  // One read, so the chip's two forms are compared at the same instant.
  const read = (): Promise<{ full: string; value: string; visibility: string; dash: number }> =>
    page.evaluate(() => {
      const chip = document.querySelector('.wy-chip[data-wy-chip="wave"]')!;
      const glance = chip.querySelector('.wy-chip-glance')!;
      return {
        full: chip.querySelector('.wy-chip-full')!.textContent ?? '',
        value: glance.querySelector('.wy-chip-value')!.textContent ?? '',
        visibility: getComputedStyle(glance).visibility,
        dash: parseFloat(
          document.querySelector('.wy-dial-wedge')!.getAttribute('stroke-dasharray') ?? 'NaN',
        ),
      };
    });
  const agree = (r: { full: string; value: string; visibility: string }): void => {
    const seconds = /^Wave in (\d+)s$/.exec(r.full)?.[1];
    expect(seconds, `the chip's full text "${r.full}"`).toBeDefined();
    expect(r.value, 'the glance shows the full text’s seconds').toBe(`${seconds}s`);
    expect(r.visibility, 'the glance is painted').toBe('visible');
  };
  const pre = await read();
  agree(pre);
  // The dial adds no text: the control's name is its label, and Start notes nothing — the
  // opening launch pays no bounty (sv15).
  await expect(primary).toHaveAccessibleName('Start');
  await expect(primary).toHaveAccessibleDescription('');
  await expect(primary).not.toHaveAttribute('title');
  const audit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);

  // Running: the chip counts the next wave down, the dial's wedge shrinks with it, and a call
  // now would pay — said as the control's description (and tooltip), never as part of its name.
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(primary).toHaveAccessibleName('Call wave');
  await expect(primary).toHaveAccessibleDescription('Calling now pays an early-call bonus');
  await expect(primary).toHaveAttribute('title', 'Calling now pays an early-call bonus');
  const first = await read();
  agree(first);
  await expect
    .poll(async () => (await read()).value, { message: 'the chip counts down' })
    .not.toBe(first.value);
  const later = await read();
  agree(later);
  expect(later.dash, 'the dial’s wedge shrinks as the countdown runs').toBeLessThan(first.dash);
  const running = await new AxeBuilder({ page }).include('#app').analyze();
  expect(running.violations, JSON.stringify(running.violations, null, 2)).toEqual([]);
});

test('Compact: no dial — the primary control keeps its own padding, and the chip’s glance carries the seconds', async ({
  page,
}) => {
  await gotoAt(page, PHONE);
  const primary = page.locator('.wy-dock .wy-primary');
  await expect(primary.locator(':scope > .wy-dial')).toBeHidden();
  // As it was: no room made for a dial that is not there.
  const pad = await primary.evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.paddingLeft, cs.paddingRight];
  });
  expect(pad[0], 'Compact keeps its button as it was').toBe(pad[1]);
  const glance = page.locator('.wy-chip[data-wy-chip="wave"] .wy-chip-glance');
  await expect(glance).toBeVisible();
  const full = await page.locator('.wy-chip[data-wy-chip="wave"] .wy-chip-full').textContent();
  const seconds = /^Wave in (\d+)s$/.exec(full ?? '')?.[1];
  expect(seconds).toBeDefined();
  await expect(glance.locator('.wy-chip-value')).toHaveText(`${seconds}s`);
});

test('the hud’s floor holds one whole chip: forced to it, every glance sits inside, 100–300% text (#181 QC round 2)', async ({
  page,
}) => {
  // The floor (`ui.css`: the hud never narrower than 5rem beside the home link) was pinned only
  // against a sliver. A 3rem floor passed every other test and still clipped the countdown's
  // glance at 412–420×915 and 200% text, by 4.5–12.5px. Forced to the floor here — no basis, no
  // growth — the hud must still hold each chip a line shows whole.
  await gotoAt(page, { width: 360, height: 640 });
  for (const zoom of [100, 150, 200, 250, 300]) {
    await page.addStyleTag({
      content: `:root { font-size: ${zoom}% } .wy-shell .wy-hud { flex: 0 0 0 !important; }`,
    });
    await settle(page);
    const glances = await page.evaluate(() => {
      const hud = document.querySelector<HTMLElement>('.wy-hud')!;
      const left = hud.getBoundingClientRect().left + hud.clientLeft;
      const right = left + hud.clientWidth;
      return ['wave', 'lives', 'bounty', 'stars'].map((slot) => {
        const g = document
          .querySelector(`.wy-chip[data-wy-chip="${slot}"] .wy-chip-glance`)!
          .getBoundingClientRect();
        return {
          slot,
          start: g.left - left,
          end: right - g.right,
          width: g.width,
          floor: hud.clientWidth,
        };
      });
    });
    for (const g of glances) {
      const what = `${zoom}%: ${g.slot} (${g.width.toFixed(1)}px) inside the ${g.floor}px floor`;
      expect(g.start, `${what} — its start`).toBeGreaterThanOrEqual(-0.5);
      expect(g.end, `${what} — its end`).toBeGreaterThanOrEqual(-0.5);
    }
  }
});

/** Compact's chips column, measured at rest: its visible box, every item's box in it (the chips,
 *  and the wave strip's title and lines), every painted LINE of those items — an icon's box, a
 *  line of visible text — the cut the pass wrote, and — for the A/B — every box that must not
 *  move for the cut: the Dock, its controls, the chips and the home mark. */
async function compactColumn(page: Page): Promise<{
  cut: string;
  straddling: string[];
  straddlingLines: string[];
  firstLinesInRoom: number;
  shownWhole: number;
  boxes: string;
}> {
  return page.evaluate(() => {
    const hud = document.querySelector<HTMLElement>('.wy-hud')!;
    hud.scrollTop = 0; // at rest
    const h = hud.getBoundingClientRect();
    const top = h.top + hud.clientTop;
    const bottom = top + hud.clientHeight;
    const items = [
      ...hud.querySelectorAll<HTMLElement>(
        ':scope > .wy-chip, :scope > .wy-wave-preview .wy-wave-preview-title, :scope > .wy-wave-preview .wy-preview-entry',
      ),
    ]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.height > 0);
    const name = (el: HTMLElement): string =>
      el.dataset.wyChip ?? (el.textContent ?? '').trim().slice(0, 16);
    const box = (el: Element): string => {
      const b = el.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height].map((v) => v.toFixed(3)).join(',');
    };
    // Each item's painted lines, from its visible form: a chip's glance, a strip line's glance, the
    // title itself — never a visually hidden sentence, whose 1px box is not painted.
    const lines = (el: HTMLElement): DOMRect[] => {
      const shown = el.querySelector<HTMLElement>('.wy-chip-glance, .wy-preview-glance') ?? el;
      const out = [...shown.querySelectorAll('svg')].map((svg) => svg.getBoundingClientRect());
      const walker = document.createTreeWalker(shown, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim() || n.parentElement?.closest('.wy-preview-full')) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        out.push(...range.getClientRects());
      }
      return out.filter((r) => r.width > 0 && r.height > 0);
    };
    const runsThrough = (r: DOMRect): boolean => r.top < bottom - 0.5 && r.bottom > bottom + 0.5;
    return {
      cut: hud.style.getPropertyValue('--wy-hud-cut'),
      // An item the visible box's bottom edge runs through: part shown, part not.
      straddling: items
        .filter(({ r }) => runsThrough(r))
        .map(
          ({ el, r }) =>
            `${name(el)} ${r.top.toFixed(1)}→${r.bottom.toFixed(1)} vs ${bottom.toFixed(1)}`,
        ),
      // A painted line — an icon, a line of digits — the edge runs through: half a glyph shown.
      straddlingLines: items.flatMap(({ el }) =>
        lines(el)
          .filter(runsThrough)
          .map((r) => `${name(el)} ${r.top.toFixed(1)}→${r.bottom.toFixed(1)}`),
      ),
      firstLinesInRoom:
        items.length > 0 ? lines(items[0]!.el).filter((r) => r.bottom <= bottom + 0.5).length : 0,
      shownWhole: items.filter(({ r }) => r.top >= top - 0.5 && r.bottom <= bottom + 0.5).length,
      boxes: [
        ...document.querySelectorAll('.wy-dock, .wy-dock .wy-btn, .wy-hud > .wy-chip, .wy-home'),
      ]
        .map(box)
        .join(' | '),
    };
  });
}

test('Compact: the chips column rests on WHOLE items — or, where none fits, on whole lines — nothing else moves for it, and every chip stays reachable (#181 QC round 2)', async ({
  page,
}) => {
  test.setTimeout(480_000); // sixteen page loads, each started; generous for slow cores
  // At 658×320 before the run the column cut the score chip through its icon and value, just
  // above the Dock. `hud-cut.ts` stops it at the last whole item; the room it gives up stays
  // empty above the Dock. The glances wrap at heavy text, so the chips are taller there (from
  // 150% the countdown is two lines, its seconds above its clock).
  let cutSomewhere = false;
  let onAWholeLine = false;
  const keptRoom: string[] = [];
  for (const size of [
    PHONE,
    { width: 568, height: 320 },
    { width: 740, height: 360 },
    { width: 900, height: 480 },
  ]) {
    for (const zoom of [100, 150, 175, 200]) {
      await gotoAt(page, size);
      expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);
      if (zoom !== 100) await page.addStyleTag({ content: `:root { font-size: ${zoom}% }` });
      await settle(page);
      for (const phase of ['pre-start', 'started'] as const) {
        if (phase === 'started') {
          await page.getByRole('button', { name: 'Start', exact: true }).click();
          await expect(page.getByRole('button', { name: 'Call wave' })).toBeVisible();
          await settle(page);
        }
        const what = `${size.width}×${size.height} at ${zoom}%, ${phase}`;
        const rest = await compactColumn(page);
        if (rest.shownWhole > 0) {
          expect(rest.straddling, `${what}: no item cut by the column's edge at rest`).toEqual([]);
        } else {
          // NO ITEM FITS WHOLE: after Start at 150–200% text on a 320px-tall phone the Dock leaves
          // the chips room for one line, and the countdown is two. The column rests on its last
          // whole line — its seconds — and only the countdown runs past the edge, its clock one
          // scroll away.
          expect(rest.straddling, `${what}: only the countdown runs past the edge`).toHaveLength(1);
          expect(rest.straddling[0]).toMatch(/^wave /);
          if (rest.cut !== '') onAWholeLine = true;
        }
        if (rest.cut === '' && rest.shownWhole === 0) {
          // …unless not even one line of it fits: 31px of room for a 33px line of digits at
          // 200%. The column keeps its room (the checklist's Compact residual).
          expect(rest.firstLinesInRoom, `${what}: the room is kept only where no line fits`).toBe(
            0,
          );
          keptRoom.push(what);
        } else {
          expect(rest.straddlingLines, `${what}: no line cut by the column's edge at rest`).toEqual(
            [],
          );
        }
        if (rest.cut !== '') cutSomewhere = true;
        // A/B: lift the cut, and nothing but the column's own height may change.
        await page.evaluate(() =>
          document.querySelector<HTMLElement>('.wy-hud')!.style.removeProperty('--wy-hud-cut'),
        );
        await settle(page);
        const lifted = await compactColumn(page);
        expect(rest.boxes, `${what}: the cut moved the Dock, a control, a chip or the mark`).toBe(
          lifted.boxes,
        );
        // Every chip stays reachable: the column still scrolls to its last item, whole.
        const reach = await page.evaluate(() => {
          const hud = document.querySelector<HTMLElement>('.wy-hud')!;
          hud.scrollTop = hud.scrollHeight;
          const bottom = hud.getBoundingClientRect().top + hud.clientTop + hud.clientHeight;
          const chips = [...hud.querySelectorAll<HTMLElement>(':scope > .wy-chip')].filter(
            (c) => c.getBoundingClientRect().height > 0,
          );
          const last = chips[chips.length - 1]!.getBoundingClientRect();
          hud.scrollTop = 0;
          return { lastBottom: last.bottom, bottom, chips: chips.length };
        });
        expect(reach.chips, `${what}: all five chips are in the column`).toBe(5);
        expect(
          reach.lastBottom,
          `${what}: scrolled to its end, the last chip is whole`,
        ).toBeLessThanOrEqual(reach.bottom + 0.5);
        // Put the cut back exactly as the pass left it, for the next phase.
        await page.evaluate((cut) => {
          if (cut !== '')
            document.querySelector<HTMLElement>('.wy-hud')!.style.setProperty('--wy-hud-cut', cut);
        }, rest.cut);
      }
    }
  }
  // The premises, so neither rule is vacuous: the cut was in force somewhere — at the very least
  // the case that found the defect — and somewhere it rested on a whole line of the countdown.
  expect(cutSomewhere, 'some case needed a cut').toBe(true);
  expect(onAWholeLine, 'some case rested on a whole line').toBe(true);
  // The residual is 200% text's alone.
  for (const what of keptRoom) expect(what).toContain(' at 200%');
});

// The column's track is vw-capped: it does not grow with the text. A one-line glance ran its
// value past the column's edge from 125–175% text, where the scrollport clipped it — at 568×320
// and 150% the countdown read "1" for 14s. The glances wrap instead: icon above value, so lives,
// bounty, stars and score stay labelled; the countdown's seconds above its clock, so the one line
// a crowded column can show is the seconds; and the countdown's unit under its digits where even
// the value is wider than the column — never a digit. One test per phone, so they run side by
// side; the unit wraps only on the 320px-tall ones (568×320 at 175–200%, 658×320 at 200%).
for (const size of [
  PHONE,
  { width: 568, height: 320 },
  { width: 740, height: 360 },
  { width: 900, height: 480 },
]) {
  test(`Compact ${size.width}×${size.height}: every chip keeps its icon, and its icon and value stay inside the column — wrapping, the countdown’s seconds above its clock — 100–200% text, before and after Start (#181 QC round 2)`, async ({
    page,
  }) => {
    test.setTimeout(240_000); // five page loads, each started; generous for slow cores
    const wrapped = new Set<string>();
    let unitWrapped = false;
    for (const zoom of [100, 125, 150, 175, 200]) {
      await gotoAt(page, size);
      expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);
      if (zoom !== 100) await page.addStyleTag({ content: `:root { font-size: ${zoom}% }` });
      await settle(page);
      for (const phase of ['pre-start', 'started'] as const) {
        if (phase === 'started') {
          await page.getByRole('button', { name: 'Start', exact: true }).click();
          await expect(page.getByRole('button', { name: 'Call wave' })).toBeVisible();
          await settle(page);
        }
        const what = `${size.width}×${size.height} at ${zoom}%, ${phase}`;
        const m = await page.evaluate(() => {
          const hud = document.querySelector<HTMLElement>('.wy-hud')!;
          const h = hud.getBoundingClientRect();
          const left = h.left + hud.clientLeft;
          const right = left + hud.clientWidth;
          const span = (rs: DOMRect[]): { top: number; bottom: number } => ({
            top: Math.min(...rs.map((r) => r.top)),
            bottom: Math.max(...rs.map((r) => r.bottom)),
          });
          const textRects = (el: Element): DOMRect[] => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return [...range.getClientRects()].filter((r) => r.width > 0);
          };
          const chips = [...hud.querySelectorAll<HTMLElement>(':scope > .wy-chip')]
            .filter((c) => !c.hidden && getComputedStyle(c).display !== 'none')
            .map((chip) => {
              const glance = chip.querySelector<HTMLElement>('.wy-chip-glance')!;
              const svg = glance.querySelector('svg')!;
              const icon = svg.getBoundingClientRect();
              const shown = getComputedStyle(svg);
              const value = textRects(glance.querySelector('.wy-chip-value')!);
              const number = chip.querySelector('.wy-chip-number');
              const unit = chip.querySelector('.wy-chip-unit');
              return {
                slot: chip.dataset.wyChip!,
                painted:
                  icon.width > 0 &&
                  icon.height > 0 &&
                  shown.display !== 'none' &&
                  shown.visibility === 'visible',
                parts: [
                  { what: 'icon', left: icon.left, right: icon.right },
                  ...value.map((r) => ({ what: 'value', left: r.left, right: r.right })),
                ],
                icon: { top: icon.top, bottom: icon.bottom },
                value: span(value),
                unitBelow:
                  number !== null && unit !== null
                    ? span(textRects(unit)).top >= span(textRects(number)).bottom - 0.5
                    : false,
              };
            });
          return { left, right, chips };
        });
        expect(
          m.chips.map((c) => c.slot),
          `${what}: every chip is in the column`,
        ).toEqual(['wave', 'lives', 'bounty', 'stars', 'score']);
        for (const c of m.chips) {
          expect(c.painted, `${what}: ${c.slot} keeps its icon`).toBe(true);
          for (const p of c.parts) {
            expect(
              p.left,
              `${what}: ${c.slot}’s ${p.what} starts inside the column`,
            ).toBeGreaterThanOrEqual(m.left - 0.5);
            expect(
              p.right,
              `${what}: ${c.slot}’s ${p.what} ends inside the column`,
            ).toBeLessThanOrEqual(m.right + 0.5);
          }
          if (c.unitBelow) unitWrapped = true;
          // Wrapped — the icon and the value each on lines of their own — the order is the
          // decision's: the countdown's seconds above its clock, every other icon above its value.
          const apart = c.icon.bottom <= c.value.top + 0.5 || c.value.bottom <= c.icon.top + 0.5;
          if (!apart) continue;
          if (c.slot === 'wave') {
            wrapped.add('countdown');
            expect(
              c.value.bottom,
              `${what}: the countdown’s seconds sit above its clock`,
            ).toBeLessThanOrEqual(c.icon.top + 0.5);
          } else {
            wrapped.add('labelled');
            expect(
              c.icon.bottom,
              `${what}: ${c.slot}’s icon sits above its value`,
            ).toBeLessThanOrEqual(c.value.top + 0.5);
          }
        }
      }
    }
    // The premises: both orders were exercised on this phone, and — on the 320px-tall ones —
    // the unit wrapped under its digits.
    expect([...wrapped].sort(), 'the countdown and a labelled chip each wrapped').toEqual([
      'countdown',
      'labelled',
    ]);
    if (size.height === 320) {
      expect(unitWrapped, 'the countdown’s unit wrapped under its digits').toBe(true);
    }
  });
}

/** The page's own scroll range on both axes. `body` is `overflow: hidden`, so any range here is
 *  range no one can pan back — but a focus move or a screen reader can still scroll it. */
async function pageScrollRange(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const se = document.scrollingElement!;
    return { x: se.scrollWidth - se.clientWidth, y: se.scrollHeight - se.clientHeight };
  });
}

test('no hidden sentence or hidden chip becomes PAGE scroll range — the page never scrolls, before or after Start (#181 QC)', async ({
  page,
}) => {
  // Measured on the commit before this fix: 131–134px of sideways range at 360×640 and 200%
  // text, 82px at 412×915, and 70–317px of range downwards where hidden boxes sat past the
  // viewport — the visually-hidden sentences resolving against `.wy-shell`, outside the hud's
  // and the strip's clips. A CHIP's sentence does the same once its chip sits in a capped hud's
  // scroll range past the viewport's bottom, unless the chip is its containing block: without
  // that, 80–88px of range downwards in the Compact column at 300% text, and 2–6px at 400×560
  // (measured on macOS's font stack and CI's DejaVu Sans; neither size has any range sideways).
  for (const c of [
    { width: 360, height: 640, zoom: 200 },
    { width: 412, height: 915, zoom: 200 },
    { width: 640, height: 560, zoom: 100 },
    { width: 600, height: 1024, zoom: 200 },
    { width: 400, height: 560, zoom: 300 },
    { width: 658, height: 320, zoom: 300 },
  ]) {
    await gotoAt(page, { width: c.width, height: c.height });
    if (c.zoom !== 100) await page.addStyleTag({ content: `:root { font-size: ${c.zoom}% }` });
    await settle(page);
    const at = `${c.width}×${c.height} at ${c.zoom}%`;
    expect(await pageScrollRange(page), `${at}, before Start`).toEqual({ x: 0, y: 0 });
    await page.getByRole('button', { name: 'Start' }).click();
    await settle(page);
    expect(await pageScrollRange(page), `${at}, after Start`).toEqual({ x: 0, y: 0 });
  }
});

test('360×640, the real wave 9: no page scroll range, a reader’s move to a row scrolls the STRIP, and a plain wheel scrolls it until it can go no further', async ({
  page,
}) => {
  test.setTimeout(120_000); // seven paced calls (the marathon specs' budget-coherence rule)
  await gotoAt(page, { width: 360, height: 640 });
  await settle(page);
  expect(await pageScrollRange(page), 'wave 1, before Start').toEqual({ x: 0, y: 0 });
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.wy-wave-preview .wy-wave-preview-title')).toHaveText('Wave 2 of 10');
  await page.getByRole('button', { name: 'Pause' }).click();
  for (let waveNumber = 2; waveNumber <= 8; waveNumber++) {
    await callWavePaced(page, titleAfterCall(waveNumber, 10));
  }
  await expect(page.locator('.wy-wave-preview li')).toHaveCount(4);
  await settle(page);
  const strip = page.locator('.wy-wave-preview');
  await expect(strip, 'the premise: four entries scroll in a phone’s strip').toHaveClass(
    /wy-wave-preview--scroll/,
  );
  expect(await pageScrollRange(page), 'wave 9').toEqual({ x: 0, y: 0 });

  // A screen reader moving to the last row's sentence brings it into view by scrolling the
  // STRIP — its containing block is the row now — never the page, which nothing could pan back.
  const moved = await page.evaluate(() => {
    const el = document.querySelector('.wy-wave-preview') as HTMLElement;
    el.scrollLeft = 0;
    const rows = el.querySelectorAll('.wy-preview-full');
    rows[rows.length - 1]!.scrollIntoView();
    return {
      strip: el.scrollLeft,
      pageX: document.scrollingElement!.scrollLeft,
      pageY: document.scrollingElement!.scrollTop,
    };
  });
  expect(moved.strip, 'the strip scrolled to the row').toBeGreaterThan(0);
  expect({ x: moved.pageX, y: moved.pageY }, 'the page did not move').toEqual({ x: 0, y: 0 });

  // A plain mouse wheel (vertical deltas only) moves the line sideways…
  await page.evaluate(() => {
    (document.querySelector('.wy-wave-preview') as HTMLElement).scrollLeft = 0;
    const w = window as unknown as { __wyWheel: boolean[] };
    w.__wyWheel = [];
    document.addEventListener('wheel', (e) => w.__wyWheel.push(e.defaultPrevented));
  });
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const scrollLeft = (): Promise<number> => strip.evaluate((el) => (el as HTMLElement).scrollLeft);
  const max = await strip.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(max, 'there is a line to scroll').toBeGreaterThan(1);
  await page.mouse.wheel(0, 40);
  await expect.poll(scrollLeft, { message: 'a wheel turn scrolls the strip' }).toBeGreaterThan(0);
  // …and is TAKEN while the line can move, then LEFT ALONE at the end, for whatever scrolls
  // beyond the strip.
  for (let i = 0; i < 40 && (await scrollLeft()) < max - 1; i++) await page.mouse.wheel(0, 120);
  expect(await scrollLeft()).toBeGreaterThanOrEqual(max - 1);
  const seen = (): Promise<boolean[]> =>
    page.evaluate(() => {
      const w = window as unknown as { __wyWheel: boolean[] };
      const out = w.__wyWheel;
      w.__wyWheel = [];
      return out;
    });
  await seen();
  await page.mouse.wheel(0, 120);
  let atEnd: boolean[] = [];
  await expect.poll(async () => (atEnd = [...atEnd, ...(await seen())]).length > 0).toBe(true);
  expect(atEnd, 'at the end every wheel event is left alone').not.toContain(true);
  await page.mouse.wheel(0, -120); // back from the end: taken again
  let back: boolean[] = [];
  await expect.poll(async () => (back = [...back, ...(await seen())]).length > 0).toBe(true);
  expect(back, 'turning back from the end is taken').not.toContain(false);
  expect(await pageScrollRange(page), 'after the wheel').toEqual({ x: 0, y: 0 });
});

test('a NARROW strip’s tightened spacing applies, and a wide one keeps the frame’s (#181 QC)', async ({
  page,
}) => {
  const spacing = (): Promise<{ strip: number; rem: number; titleEnd: string; gap: string }> =>
    page.evaluate(() => ({
      strip: document.querySelector('.wy-wave-preview')!.getBoundingClientRect().width,
      rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
      titleEnd: getComputedStyle(document.querySelector('.wy-wave-preview-title')!).marginInlineEnd,
      gap: getComputedStyle(document.querySelector('.wy-wave-preview-list')!).columnGap,
    }));
  // A phone's strip, well under the 22rem query: both tightenings win the cascade.
  await gotoAt(page, { width: 360, height: 640 });
  await settle(page);
  const narrow = await spacing();
  expect(narrow.strip / narrow.rem, 'the premise: a narrow strip').toBeLessThan(22);
  expect(narrow.titleEnd).toBe(`${-0.35 * narrow.rem}px`);
  expect(narrow.gap).toBe(`${0.55 * narrow.rem}px`);
  // A desktop's strip, at its 30rem cap: the frame's spacing (the positive control).
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page);
  const wide = await spacing();
  expect(wide.strip / wide.rem, 'the premise: a wide strip').toBeGreaterThan(22);
  expect(wide.titleEnd).toBe('0px');
  expect(wide.gap).toBe(`${0.9 * wide.rem}px`);
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
