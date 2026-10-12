import { test, expect, type Page } from './fixtures';
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
      buttonFace: system('ButtonFace'),
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
  // crown in the control's own system ink, ButtonText, over a ButtonFace face — the wedge reads
  // at the control text's own contrast (GrayText under it was 1.5:1 in the contrast themes).
  expect([inks.buttonText, inks.canvasText]).toContain(inks.control);
  for (const part of [inks.wedge, inks.ring, inks.crown]) expect(part).toBe(inks.buttonText);
  expect(inks.face).toBe(inks.buttonFace);
  expect(inks.faceOpacity).toBe('1');
  expect(inks.buttonFace, 'the face stays apart from the remaining wedge').not.toBe(
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
    // Painted: EVERY icon renders — a box, never hidden — in both layouts, the countdown's
    // included, whose glance is the one readable countdown (#181 QC: it no longer stands down for
    // anything). In view is another matter: Compact's column shows what fits whole at rest, the
    // rest one scroll away (`hud-cut.ts`), and at 200% that is the countdown's seconds alone.
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
    // The visible bottom edge to the fraction, as `hud-cut.ts` measures its room. `clientHeight`
    // rounds to a whole px, which put this edge up to half a pixel high: added to the half pixel
    // an item may overhang the room and still count as whole, that read as an item cut by the
    // edge — the strip's title at 568×450 and 115% text on CI's font (#181).
    const bottom = h.bottom - parseFloat(getComputedStyle(hud).borderBottomWidth);
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

// ---- R4 QC (#181): an air entry's wings, where the strip draws them ----

/** One strip entry as drawn, in CSS px. */
interface StripEntry {
  /** Its place in the strip, and its count's text. */
  readonly entry: number;
  readonly text: string;
  /** Its icon's left edge. */
  readonly iconLeft: number;
  /** Its icon's other edges, and whether it is painted: a box, neither hidden nor undisplayed. */
  readonly icon: {
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
    readonly painted: boolean;
  };
  /** Its count's painted text: how many boxes it has — the premise of every check on it, since
   *  the edges of no box at all are infinities that pass any bound — and their extent (`NaN`
   *  without a box), the lines they take, and their widths summed: the count's width on one
   *  line (#181: a row wraps, and so may a count). */
  readonly count: {
    readonly boxes: number;
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
    readonly lines: number;
    readonly width: number;
  };
  /** The lines each run of digits in its count takes: one apiece where no number is split. */
  readonly digitLines: readonly number[];
  /** Each of an air entry's wings: its painted extent — its corners, grown by half its
   *  round-joined ink outline — and what clips it, the icon's own `svg` included. */
  readonly wings: readonly {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
    readonly clipLeft: number;
    readonly clipRight: number;
  }[];
}

/** Where one entry's count is drawn, measured again under `measureStrip`'s `restyle`. */
interface RestyledEntry {
  readonly iconLeft: number;
  readonly countLeft: number;
  readonly countRight: number;
  readonly countTop: number;
}

/** Every entry of the strip, measured where it is drawn (`StripEntry`) — the ONE in-page measure
 *  every check below on the strip's wings and counts reads, so none of them can take a wing's
 *  extent or a clip differently from another — and the column it sits in: the chips
 *  scrollport's content box, whose clip cuts whatever runs past it. Given `restyle`, a
 *  stylesheet, it then measures each entry's icon and count again with that stylesheet added —
 *  in the same task, so nothing else can change between the two — and takes the stylesheet off
 *  again. */
async function measureStrip(
  page: Page,
  restyle?: string,
): Promise<{
  column: { left: number; right: number };
  entries: StripEntry[];
  restyled: RestyledEntry[];
}> {
  return page.evaluate((restyle) => {
    /** What clips `from` across: the padding box of each of `from` and its ancestors whose
     *  overflow is not `visible`, intersected — for a wing, from its icon's `svg` up. */
    const clipOf = (from: Element): { left: number; right: number } => {
      let left = -Infinity;
      let right = Infinity;
      for (let el: Element | null = from; el; el = el.parentElement) {
        if (getComputedStyle(el).overflowX === 'visible') continue;
        const edge = el.getBoundingClientRect().left + el.clientLeft;
        left = Math.max(left, edge);
        right = Math.min(right, edge + el.clientWidth);
      }
      return { left, right };
    };
    const nonEmpty = (rects: DOMRectList): DOMRect[] => [...rects].filter((r) => r.width > 0);
    const textBoxes = (el: Element): DOMRect[] => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return nonEmpty(range.getClientRects());
    };
    /** The boxes of `el`'s text from character `from` to `to`, across its text nodes. */
    const runBoxes = (el: Element, from: number, to: number): DOMRect[] => {
      const range = document.createRange();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let at = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const end = at + (n.textContent ?? '').length;
        if (from >= at && from < end) range.setStart(n, from - at);
        if (to > at && to <= end) range.setEnd(n, to - at);
        at = end;
      }
      return nonEmpty(range.getClientRects());
    };
    const lines = (boxes: DOMRect[]): number => new Set(boxes.map((r) => Math.round(r.top))).size;
    const extent = (boxes: DOMRect[], edge: (r: DOMRect) => number, pick: typeof Math.min) =>
      boxes.length > 0 ? pick(...boxes.map(edge)) : NaN;
    const rows = [...document.querySelectorAll('.wy-wave-preview li')].map((li) => ({
      icon: li.querySelector('svg.wy-creep-icon')!,
      count: li.querySelector('.wy-preview-count')!,
      wings: [...li.querySelectorAll<SVGPolygonElement>('svg.wy-creep-icon .wy-creep-wing')],
    }));
    const entries = rows.map(({ icon, count, wings }, entry) => {
      const boxes = textBoxes(count);
      const iconBox = icon.getBoundingClientRect();
      const shown = getComputedStyle(icon);
      const text = count.textContent ?? '';
      return {
        entry,
        text,
        iconLeft: iconBox.left,
        icon: {
          right: iconBox.right,
          top: iconBox.top,
          bottom: iconBox.bottom,
          painted:
            iconBox.width > 0 &&
            iconBox.height > 0 &&
            shown.display !== 'none' &&
            shown.visibility === 'visible',
        },
        count: {
          boxes: boxes.length,
          left: extent(boxes, (r) => r.left, Math.min),
          right: extent(boxes, (r) => r.right, Math.max),
          top: extent(boxes, (r) => r.top, Math.min),
          bottom: extent(boxes, (r) => r.bottom, Math.max),
          lines: lines(boxes),
          width: boxes.reduce((sum, r) => sum + r.width, 0),
        },
        digitLines: [...text.matchAll(/\d+/g)].map((m) =>
          lines(runBoxes(count, m.index, m.index + m[0].length)),
        ),
        wings: wings.map((wing) => {
          const m = wing.getScreenCTM()!;
          const half = (parseFloat(getComputedStyle(wing).strokeWidth) * Math.hypot(m.a, m.b)) / 2;
          const corners = Array.from({ length: wing.points.numberOfItems }, (_, i) => {
            const p = wing.points.getItem(i);
            return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
          });
          const xs = corners.map((c) => c.x);
          const ys = corners.map((c) => c.y);
          const clip = clipOf(wing.ownerSVGElement!);
          return {
            left: Math.min(...xs) - half,
            right: Math.max(...xs) + half,
            top: Math.min(...ys) - half,
            bottom: Math.max(...ys) + half,
            clipLeft: clip.left,
            clipRight: clip.right,
          };
        }),
      };
    });
    const hud = document.querySelector<HTMLElement>('.wy-hud')!;
    const columnLeft = hud.getBoundingClientRect().left + hud.clientLeft;
    const column = { left: columnLeft, right: columnLeft + hud.clientWidth };
    if (restyle === undefined) return { column, entries, restyled: [] };
    const style = document.createElement('style');
    style.textContent = restyle;
    document.head.append(style);
    const restyled = rows.map(({ icon, count }) => {
      const boxes = textBoxes(count);
      return {
        iconLeft: icon.getBoundingClientRect().left,
        countLeft: extent(boxes, (r) => r.left, Math.min),
        countRight: extent(boxes, (r) => r.right, Math.max),
        countTop: extent(boxes, (r) => r.top, Math.min),
      };
    });
    style.remove();
    return { column, entries, restyled };
  }, restyle);
}

test('Compact: an air entry’s wings are never cut by the column — waves 6, 8 and 9, at 658×320 and 568×320 (#181 R4 QC)', async ({
  page,
}) => {
  // The wings reach past the icon's box by design (`ui.css`'s `overflow: visible`), so whatever
  // holds the icon must leave them room. In Compact the strip is a column inside the hud's
  // scrollport, and each entry's icon starts at its edge.
  test.setTimeout(120_000);
  await gotoAt(page, PHONE);
  expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);
  const previewTitle = page.locator('.wy-wave-preview .wy-wave-preview-title');
  await page.getByRole('button', { name: 'Start' }).click(); // Start claims wave 1 (#70)
  await expect(previewTitle).toHaveText('Wave 2 of 10');
  await page.getByRole('button', { name: 'Pause' }).click();
  let measured = 0;
  for (let waveNumber = 2; waveNumber <= 8; waveNumber++) {
    await callWavePaced(page, titleAfterCall(waveNumber, 10));
    const next = waveNumber + 1; // the wave the strip now previews
    if (next !== 6 && next !== 8 && next !== 9) continue; // the flyer, the armored flyer, wave 9's flyer
    for (const size of [PHONE, { width: 568, height: 320 }]) {
      await page.setViewportSize(size);
      await settle(page);
      const at = `wave ${next} at ${size.width}×${size.height}`;
      const wings = (await measureStrip(page)).entries.flatMap((e) =>
        e.wings.map((w) => ({
          entry: e.entry,
          left: w.clipLeft - w.left,
          right: w.right - w.clipRight,
        })),
      );
      expect(wings, `${at}: the premise, one air entry's two wings`).toHaveLength(2);
      for (const w of wings) {
        expect(
          w.left,
          `${at}: entry ${w.entry}'s wing cut ${w.left.toFixed(2)}px on the left`,
        ).toBeLessThanOrEqual(0.05);
        expect(
          w.right,
          `${at}: entry ${w.entry}'s wing cut ${w.right.toFixed(2)}px on the right`,
        ).toBeLessThanOrEqual(0.05);
      }
      measured++;
    }
    await page.setViewportSize(PHONE);
    await settle(page);
  }
  expect(measured).toBe(6);
});

test('forced colors: an air entry’s wings are outlines in the user’s text colour on the background, apart from its solid body (#181 R4 QC)', async ({
  page,
}) => {
  // Wave 1 is a ground creep, so the forced-colors test above never sees a wing; wave 6 is the
  // first flyer. The wings' palette inks are presentation attributes Chromium does not force.
  test.setTimeout(90_000);
  await page.emulateMedia({ forcedColors: 'active' });
  await gotoAt(page, STANDARD);
  const previewTitle = page.locator('.wy-wave-preview .wy-wave-preview-title');
  await page.getByRole('button', { name: 'Start' }).click(); // Start claims wave 1 (#70)
  await expect(previewTitle).toHaveText('Wave 2 of 10');
  await page.getByRole('button', { name: 'Pause' }).click();
  for (let waveNumber = 2; waveNumber <= 5; waveNumber++) {
    await callWavePaced(page, titleAfterCall(waveNumber, 10));
  }
  await expect(previewTitle).toHaveText('Wave 6 of 10');
  const inks = await page.evaluate(() => {
    const system = (value: string): string => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.append(probe);
      const out = getComputedStyle(probe).color;
      probe.remove();
      return out;
    };
    const paint = (sel: string): { fill: string; stroke: string }[] =>
      [...document.querySelectorAll(sel)].map((el) => {
        const cs = getComputedStyle(el);
        return { fill: cs.fill, stroke: cs.stroke };
      });
    return {
      canvas: system('Canvas'),
      canvasText: system('CanvasText'),
      wings: paint('.wy-wave-preview .wy-creep-wing'),
      bodies: paint('.wy-wave-preview .wy-creep-body'),
    };
  });
  expect(inks.canvasText).not.toBe(inks.canvas);
  expect(inks.wings, 'the premise: the flyer’s two wings').toHaveLength(2);
  for (const wing of inks.wings)
    expect(wing).toEqual({ fill: inks.canvas, stroke: inks.canvasText });
  expect(inks.bodies).toEqual([{ fill: inks.canvasText, stroke: inks.canvasText }]);
});

// ---- R4 QC round 2 (#181): the room the wings take moves no count ----

/** Sets the page's text size — `:root`'s font size, as a browser's text-size setting scales it —
 *  in place of any this set before. */
async function setTextSize(page: Page, percent: number): Promise<void> {
  await page.evaluate((percent) => {
    let style = document.getElementById('wy-test-text-size');
    if (style === null) {
      style = document.createElement('style');
      style.id = 'wy-test-text-size';
      document.head.append(style);
    }
    style.textContent = percent === 100 ? '' : `:root { font-size: ${percent}% }`;
  }, percent);
}

/** The strip WITHOUT R4's two Compact rules (`ui.css`, the icon's `margin-inline-start` and the
 *  glance's `gap`), as main draws it: main has no Compact rule for either, so the icon takes no
 *  margin and the glance the gap of its base rule. That gap is read off a glance outside the
 *  strip, where only the base rule reaches it, so this baseline follows the base rule. It sets
 *  the COLUMN gap alone — the gap beside the icon, the one R4 spends: since #181 a row may wrap,
 *  and the gap between its lines is the wrap's (`row-gap: 0`), which `gap` would set as well,
 *  moving every wrapped count down for a reason that is not the wings'. */
async function withoutWingRoom(page: Page): Promise<string> {
  const gapEm = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.className = 'wy-preview-glance';
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const em = parseFloat(style.columnGap) / parseFloat(style.fontSize);
    probe.remove();
    return em;
  });
  expect(gapEm, 'the premise: the glance’s base gap, read off the page').toBeGreaterThan(0);
  return (
    `.wy-wave-preview-list .wy-creep-icon { margin-inline-start: 0 !important; }\n` +
    `.wy-wave-preview-list .wy-preview-glance { column-gap: ${gapEm}em !important; }`
  );
}

test('Compact: the room the wings take moves no count, and no wing runs onto one — every entry of every wave, at 658×320 and 568×320, at 100, 125, 150 and 200% text (#181 R4 QC round 2)', async ({
  page,
}) => {
  // R4 gives the icon a margin for its left wing and takes the same length back from the gap
  // after it, so each count stays exactly where main draws it. That is what this pins, as a
  // difference: each count's place with R4's two rules, and again without them, in the same
  // layout. Since #181 a row too narrow for its icon and count wraps, the count on the line
  // under its icon, so the difference is taken on both axes: room that pushed a count onto the
  // next line would move it on both. And a wing runs onto a count only where the two meet on
  // the page — beside the icon, the old check exactly; a count on the line under it sits below
  // the wings, whatever their reach across. Both forms are measured (the premises at the end).
  // Whether a count fits the column at all is the wrap's, pinned by the per-phone tests below.
  test.setTimeout(360_000); // ten previews, two windows and four text sizes; generous for slow cores
  await gotoAt(page, PHONE);
  expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);
  const previewTitle = page.locator('.wy-wave-preview .wy-wave-preview-title');
  const baseline = await withoutWingRoom(page);
  /** The largest shift, in px, by window and text size. */
  const worst = new Map<string, number>();
  let measured = 0;
  /** Counts measured beside their icon, and on the line under it. */
  let beside = 0;
  let under = 0;
  const check = async (wave: string): Promise<void> => {
    for (const size of [PHONE, { width: 568, height: 320 }]) {
      await page.setViewportSize(size);
      for (const percent of [100, 125, 150, 200]) {
        await setTextSize(page, percent);
        await settle(page);
        const where = `${size.width}×${size.height} at ${percent}%`;
        const { entries, restyled } = await measureStrip(page, baseline);
        expect(entries.length, `${wave}, ${where}: the premise, a strip entry`).toBeGreaterThan(0);
        for (const e of entries) {
          const at = `${wave}, ${where}: ${e.text}`;
          const without = restyled[e.entry]!;
          expect(e.count.boxes, `${at}: the premise, a painted count`).toBeGreaterThan(0);
          expect(
            e.iconLeft - without.iconLeft,
            `${at}: the premise, R4's margin moves the icon`,
          ).toBeGreaterThan(0.5);
          const shifts = [
            ['left', e.count.left - without.countLeft],
            ['right', e.count.right - without.countRight],
            ['top', e.count.top - without.countTop],
          ] as const;
          for (const [edge, shift] of shifts) {
            expect(
              Math.abs(shift),
              `${at}: the wings' room moved the count's ${edge} edge ${shift.toFixed(3)}px`,
            ).toBeLessThanOrEqual(0.05);
          }
          for (const w of e.wings) {
            const across = Math.min(w.right, e.count.right) - Math.max(w.left, e.count.left);
            const down = Math.min(w.bottom, e.count.bottom) - Math.max(w.top, e.count.top);
            expect(
              down > 0 ? across : 0,
              `${at}: a wing ${across.toFixed(2)}px over the count`,
            ).toBeLessThanOrEqual(0);
          }
          if (e.count.top >= e.icon.bottom - 0.5) under++;
          else beside++;
          worst.set(
            where,
            Math.max(worst.get(where) ?? 0, ...shifts.map(([, shift]) => Math.abs(shift))),
          );
          measured++;
        }
      }
    }
    await setTextSize(page, 100);
    await page.setViewportSize(PHONE);
    await settle(page);
  };
  await check('wave 1');
  await page.getByRole('button', { name: 'Start' }).click(); // Start claims wave 1 (#70)
  await expect(previewTitle).toHaveText('Wave 2 of 10');
  await page.getByRole('button', { name: 'Pause' }).click();
  await check('wave 2');
  for (let waveNumber = 2; waveNumber <= 9; waveNumber++) {
    await callWavePaced(page, titleAfterCall(waveNumber, 10));
    await check(`wave ${waveNumber + 1}`);
  }
  console.log(
    `[hud-strip] the wings' room, each count's largest shift against main's strip: ${[...worst]
      .map(([where, px]) => `${where} ${px.toFixed(4)}px`)
      .join(', ')}`,
  );
  expect(
    measured,
    'the premise: every entry of every preview, at both windows and every text size',
  ).toBeGreaterThan(80);
  // Both forms, so neither half of the difference is vacuous: a count beside its icon, where R4
  // gives its margin back from the gap (658×320 at 100%), and one under it.
  expect(beside, 'the premise: a count beside its icon').toBeGreaterThan(0);
  expect(under, 'the premise: a count on the line under its icon').toBeGreaterThan(0);
});

// ---- #181: a strip row too narrow for the Compact column wraps, as the chips' glances do ----

/** Each strip row as assistive tech meets it: its text outside `aria-hidden` subtrees — what is
 *  read — and its glance's `aria-hidden` and the classes of its children, in DOM order. */
async function stripRowsRead(
  page: Page,
): Promise<{ text: string; glanceHidden: string | null; glance: (string | null)[] }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.wy-wave-preview li')].map((li) => {
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
      let text = '';
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement?.closest('[aria-hidden="true"]') === null) text += n.nodeValue ?? '';
      }
      const glance = li.querySelector('.wy-preview-glance')!;
      return {
        text: text.trim(),
        glanceHidden: glance.getAttribute('aria-hidden'),
        glance: [...glance.children].map((c) => c.getAttribute('class')),
      };
    }),
  );
}

/** What each phase's strip reads aloud: wave 1 before Start, wave 2 once Start claims wave 1. */
const SPOKEN = {
  'pre-start': ['10 × Creep — ground, armor 0, leak cost 1, no immunities'],
  started: ['16 × Swarm Creep — ground, armor 0, leak cost 1, no immunities'],
} as const;

// The column's track is vw-capped and does not grow with the text, so a one-line row ran its
// count past the column's edge, where the scrollport cut it: on macOS's fonts from 105% text at
// 568×320 and from 120% at 658×320, and at 100% at 568×320 on CI's. A row wraps instead, as the
// chips' glances do: its count on the line under its icon, and where even the count is wider
// than the column (on macOS's fonts 568×320 at 175–200% and 658×320 at 200%) its × above its
// digits, at the zero-width space beside its number — never inside it.

/** Every row of one measured strip (`measureStrip`): its icon painted, its icon and count inside
 *  the column, no number split across lines, and its count with its own icon — after it on its
 *  line, or on the line under it and above the next entry's icon, so that it never reads as the
 *  next creep's. A count takes a second line only where one line is too narrow for it. Returns
 *  how many counts sat under their icon, how many of those had an entry after them, and how many
 *  counts took two lines: the callers' premises. */
function expectRowsInColumn(
  what: string,
  column: { left: number; right: number },
  entries: readonly StripEntry[],
): { under: number; underAboveNext: number; countWrapped: number } {
  let under = 0;
  let underAboveNext = 0;
  let countWrapped = 0;
  entries.forEach((e, i) => {
    const at = `${what}: ${e.text}`;
    expect(e.count.boxes, `${at}: the premise, a painted count`).toBeGreaterThan(0);
    expect(e.digitLines.length, `${at}: the premise, a number in the count`).toBeGreaterThan(0);
    expect(e.icon.painted, `${at}: its icon is painted`).toBe(true);
    for (const [part, left, right] of [
      ['icon', e.iconLeft, e.icon.right],
      ['count', e.count.left, e.count.right],
    ] as const) {
      expect(left, `${at}: its ${part} starts inside the column`).toBeGreaterThanOrEqual(
        column.left - 0.5,
      );
      expect(right, `${at}: its ${part} ends inside the column`).toBeLessThanOrEqual(
        column.right + 0.5,
      );
    }
    expect(e.digitLines, `${at}: a number split across lines`).toEqual(e.digitLines.map(() => 1));
    const next = entries[i + 1];
    if (e.count.top >= e.icon.bottom - 0.5) {
      under++;
      if (next !== undefined) {
        expect(e.count.bottom, `${at}: above the next entry's icon`).toBeLessThanOrEqual(
          next.icon.top + 0.5,
        );
        underAboveNext++;
      }
    } else {
      expect(e.count.left, `${at}: beside its icon, after it`).toBeGreaterThanOrEqual(
        e.icon.right - 0.5,
      );
      expect(e.count.top, `${at}: beside its icon, on its line`).toBeGreaterThanOrEqual(
        e.icon.top - 0.5,
      );
    }
    if (e.count.lines > 1) {
      countWrapped++;
      expect(
        e.count.width,
        `${at}: a count wrapped though it fits the column on one line`,
      ).toBeGreaterThan(column.right - column.left - 0.5);
    }
  });
  return { under, underAboveNext, countWrapped };
}

/** The four Compact phones the strip's rows are measured on. */
const STRIP_PHONES = [
  PHONE,
  { width: 568, height: 320 },
  { width: 740, height: 360 },
  { width: 900, height: 480 },
] as const;

// One test per phone, so they run side by side.
for (const size of STRIP_PHONES) {
  test(`Compact ${size.width}×${size.height}: every strip row’s icon and count stay inside the column — the count under its icon where the two do not fit side by side, its × above its digits where even it does not — and no number is split, 100–200% text, before and after Start (#181)`, async ({
    page,
  }) => {
    test.setTimeout(240_000); // five page loads, each started, and two audits; generous for slow cores
    let under = 0;
    let countWrapped = 0;
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
        const { column, entries } = await measureStrip(page);
        expect(entries.length, `${what}: the premise, a strip entry`).toBeGreaterThan(0);
        const checked = expectRowsInColumn(what, column, entries);
        under += checked.under;
        countWrapped += checked.countWrapped;
        if (zoom === 200) {
          // Presentation only: each row's accessible text is its full sentence, exactly as
          // before, and its glance — the icon, then the count, in the DOM — is hidden from it.
          const rows = await stripRowsRead(page);
          expect(
            rows.map((r) => r.text),
            `${what}: the accessible text`,
          ).toEqual(SPOKEN[phase]);
          for (const row of rows) {
            expect(row.glanceHidden, `${what}: the glance is hidden from AT`).toBe('true');
            expect(row.glance.slice(0, 2), `${what}: the glance's DOM order`).toEqual([
              'wy-creep-icon',
              'wy-preview-count',
            ]);
          }
          const audit = await new AxeBuilder({ page }).include('#app').analyze();
          expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
        }
      }
    }
    // The premises: a row wrapped on this phone, and on the 320px-tall ones a count wrapped
    // beside its number.
    expect(under, 'the premise: a row wrapped, its count under its icon').toBeGreaterThan(0);
    if (size.height === 320) {
      expect(countWrapped, 'the premise: a count wrapped beside its number').toBeGreaterThan(0);
    }
  });
}

test('Compact: in a wave of several creeps each count stays with its own icon — under it and above the next entry’s — at the four phones and 100–200% text (#181)', async ({
  page,
}) => {
  // Waves 1 and 2, which the per-phone tests read, have one entry each, so no wrapped count
  // there has another entry's icon under it. Wave 9 has four, the last of them airborne.
  test.setTimeout(240_000); // seven paced calls, then four windows at five text sizes
  await gotoAt(page, PHONE);
  expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);
  const previewTitle = page.locator('.wy-wave-preview .wy-wave-preview-title');
  await page.getByRole('button', { name: 'Start', exact: true }).click(); // Start claims wave 1 (#70)
  await expect(previewTitle).toHaveText('Wave 2 of 10');
  await page.getByRole('button', { name: 'Pause' }).click();
  for (let waveNumber = 2; waveNumber <= 8; waveNumber++) {
    await callWavePaced(page, titleAfterCall(waveNumber, 10));
  }
  await expect(previewTitle).toHaveText('Wave 9 of 10');
  let underAboveNext = 0;
  for (const size of STRIP_PHONES) {
    await page.setViewportSize(size);
    for (const percent of [100, 125, 150, 175, 200]) {
      await setTextSize(page, percent);
      await settle(page);
      const what = `wave 9, ${size.width}×${size.height} at ${percent}%`;
      expect(
        await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY),
        `${what}: Compact`,
      ).toBe(true);
      const { column, entries } = await measureStrip(page);
      expect(entries.length, `${what}: the premise, several entries`).toBeGreaterThan(1);
      underAboveNext += expectRowsInColumn(what, column, entries).underAboveNext;
    }
    await setTextSize(page, 100);
  }
  expect(
    underAboveNext,
    'the premise: a count under its icon with another entry after it',
  ).toBeGreaterThan(0);
});

/** The strip's rows against the chips column's bottom edge, at rest: each row's box, and whether
 *  it is wrapped — its count on the line under its icon. */
async function stripRowsAgainstEdge(
  page: Page,
): Promise<{ edge: number; rows: { top: number; bottom: number; wrapped: boolean }[] }> {
  return page.evaluate(() => {
    const hud = document.querySelector<HTMLElement>('.wy-hud')!;
    hud.scrollTop = 0; // at rest
    // To the fraction, as `compactColumn` takes it.
    const edge =
      hud.getBoundingClientRect().bottom - parseFloat(getComputedStyle(hud).borderBottomWidth);
    const rows = [
      ...hud.querySelectorAll<HTMLElement>(':scope > .wy-wave-preview .wy-preview-entry'),
    ].map((li) => {
      const box = li.getBoundingClientRect();
      const icon = li.querySelector('svg.wy-creep-icon')!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(li.querySelector('.wy-preview-count')!);
      const tops = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => r.top);
      return { top: box.top, bottom: box.bottom, wrapped: Math.min(...tops) >= icon.bottom - 0.5 };
    });
    return { edge, rows };
  });
}

test('Compact: a wrapped strip row is one item to the cut — at rest the column shows it whole or leaves it wholly below its edge, never its icon without its count (#181)', async ({
  page,
}) => {
  // A wrapped row is two lines tall, and `hud-cut.ts` stops the column at the last WHOLE item,
  // so a row the room cannot hold whole is left out whole. On the four phones above, the strip
  // sits below the column's room at rest; these taller Compact windows bring it into the room,
  // and the text size is walked until a wrapped row is shown whole at rest and one is run through
  // by the room's edge (the premises at the end).
  test.setTimeout(240_000); // four windows, each started, sixteen text sizes; generous for slow cores
  let shownWhole = 0;
  let leftBelow = 0;
  for (const size of [
    { width: 568, height: 500 },
    { width: 640, height: 500 },
    { width: 600, height: 480 },
    { width: 568, height: 450 },
  ]) {
    await gotoAt(page, size);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);
    for (const phase of ['pre-start', 'started'] as const) {
      if (phase === 'started') {
        await setTextSize(page, 100);
        await settle(page);
        await page.getByRole('button', { name: 'Start', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Call wave' })).toBeVisible();
        // Paused: the walk below reads one wave's strip, and no run ends under it.
        await page.getByRole('button', { name: 'Pause' }).click();
      }
      for (const percent of [100, 105, 110, 115, 120, 125, 135, 150]) {
        await setTextSize(page, percent);
        await settle(page);
        const what = `${size.width}×${size.height} at ${percent}%, ${phase}`;
        const rest = await compactColumn(page);
        expect(rest.shownWhole, `${what}: the premise, an item shown whole`).toBeGreaterThan(0);
        expect(rest.straddling, `${what}: no item cut by the column's edge at rest`).toEqual([]);
        expect(rest.straddlingLines, `${what}: no line cut by the column's edge at rest`).toEqual(
          [],
        );
        const atRest = await stripRowsAgainstEdge(page);
        shownWhole += atRest.rows.filter((r) => r.wrapped && r.bottom <= atRest.edge + 0.5).length;
        // Lifted, the room's edge falls where the column's room ends: a wrapped row it runs
        // through must be left wholly below the cut at rest.
        await page.evaluate(() =>
          document.querySelector<HTMLElement>('.wy-hud')!.style.removeProperty('--wy-hud-cut'),
        );
        await settle(page);
        const lifted = await stripRowsAgainstEdge(page);
        lifted.rows.forEach((r, i) => {
          if (!r.wrapped || r.top >= lifted.edge - 0.5 || r.bottom <= lifted.edge + 0.5) return;
          expect(
            atRest.rows[i]!.top,
            `${what}: a wrapped row the room's edge runs through is left wholly below the cut`,
          ).toBeGreaterThanOrEqual(atRest.edge - 0.5);
          leftBelow++;
        });
        await page.evaluate((cut) => {
          if (cut !== '')
            document.querySelector<HTMLElement>('.wy-hud')!.style.setProperty('--wy-hud-cut', cut);
        }, rest.cut);
      }
    }
  }
  expect(shownWhole, 'the premise: a wrapped row shown whole at rest').toBeGreaterThan(0);
  expect(leftBelow, 'the premise: a wrapped row the room’s edge runs through').toBeGreaterThan(0);
});

/** Compact's strip as main draws it: each row one line, its count beside its icon and running
 *  past the column where the two do not fit — the wrap's declarations undone (`ui.css`). Under
 *  `nowrap` the count's zero-width space is no break, and the count reads as main's does. */
const UNWRAPPED =
  '.wy-wave-preview-list .wy-preview-glance { flex-wrap: nowrap !important; }\n' +
  '.wy-wave-preview-list .wy-preview-count { flex-shrink: 0 !important; white-space: nowrap !important; }';

test('Compact at 100% text: a row’s wrap moves nothing else — the Dock, its controls, the chips, the home mark and the board stay where the unwrapped strip leaves them, before and after Start (#181)', async ({
  page,
}) => {
  // At 100% text a row wraps at 568×320 on CI's font, and at 480×320 on both (a column narrower
  // than any row): the strip grows taller under the chips, and nothing else in the column, nor
  // the board beside it, may move for that. An A/B in the rendered page against the unwrapped
  // strip, as main draws it.
  test.setTimeout(120_000);
  let wrapped = 0;
  for (const size of [
    PHONE,
    { width: 568, height: 320 },
    { width: 740, height: 360 },
    { width: 900, height: 480 },
    { width: 480, height: 320 },
  ]) {
    await gotoAt(page, size);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);
    await settle(page);
    for (const phase of ['pre-start', 'started'] as const) {
      if (phase === 'started') {
        await page.getByRole('button', { name: 'Start', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Call wave' })).toBeVisible();
        await page.getByRole('button', { name: 'Pause' }).click(); // nothing moves between reads
        await settle(page);
      }
      const what = `${size.width}×${size.height}, ${phase}`;
      const read = (): Promise<{ others: string; rows: string }> =>
        page.evaluate(() => {
          const box = (el: Element): string => {
            const b = el.getBoundingClientRect();
            return [b.x, b.y, b.width, b.height].map((v) => v.toFixed(3)).join(',');
          };
          const all = (sel: string): string =>
            [...document.querySelectorAll(sel)].map(box).join(' | ');
          return {
            others: all(
              '.wy-dock, .wy-dock .wy-btn, .wy-hud > .wy-chip, .wy-home, .wy-mark, .wy-board',
            ),
            rows: all('.wy-wave-preview .wy-preview-entry'),
          };
        });
      const withWrap = await read();
      const grid = await projectedGrid(page);
      await page.evaluate((css) => {
        const style = document.createElement('style');
        style.id = 'wy-test-unwrapped';
        style.textContent = css;
        document.head.append(style);
      }, UNWRAPPED);
      await settle(page);
      const unwrapped = await read();
      const unwrappedGrid = await projectedGrid(page);
      await page.evaluate(() => document.getElementById('wy-test-unwrapped')?.remove());
      await settle(page);
      expect(
        withWrap.others,
        `${what}: the wrap moved the Dock, a control, a chip, the mark or the board`,
      ).toBe(unwrapped.others);
      expect(grid, `${what}: the wrap moved the board's grid`).toEqual(unwrappedGrid);
      if (withWrap.rows !== unwrapped.rows) wrapped++;
    }
  }
  expect(wrapped, 'the premise: a row wrapped at 100% text').toBeGreaterThan(0);
});

// ---- #181: the wave strip's title is never cut in Compact's column ----

/** The title's text, measured where it is drawn, against the column: the extent of its text
 *  boxes, and the column's content box (`measureStrip`'s). */
async function measureTitle(page: Page): Promise<{
  column: { left: number; right: number };
  text: string;
  left: number;
  right: number;
  wordBroke: boolean;
}> {
  return page.evaluate(() => {
    const hud = document.querySelector<HTMLElement>('.wy-hud')!;
    const columnLeft = hud.getBoundingClientRect().left + hud.clientLeft;
    const title = document.querySelector<HTMLElement>('.wy-wave-preview-title')!;
    const range = document.createRange();
    range.selectNodeContents(title);
    const boxes = [...range.getClientRects()].filter((r) => r.width > 0);
    // A break inside a word shows as the word's own boxes on more than one line.
    const word = document.createRange();
    const node = title.firstChild!;
    word.setStart(node, 0);
    word.setEnd(node, 4); // "Wave"
    const wordLines = new Set([...word.getClientRects()].map((r) => Math.round(r.top)));
    return {
      column: { left: columnLeft, right: columnLeft + hud.clientWidth },
      text: title.textContent ?? '',
      left: Math.min(...boxes.map((r) => r.left)),
      right: Math.max(...boxes.map((r) => r.right)),
      wordBroke: wordLines.size > 1,
    };
  });
}

// One test per phone, so they run side by side.
for (const size of STRIP_PHONES) {
  test(`Compact ${size.width}×${size.height}: the strip’s title lies wholly inside the column — a word wider than it breaks inside the word — 100–200% text, before and after Start (#181)`, async ({
    page,
  }) => {
    test.setTimeout(240_000); // five page loads, each started; generous for slow cores
    let broke = 0;
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
        const t = await measureTitle(page);
        expect(t.text, `${what}: the premise, the title`).toMatch(/^Wave \d+ of \d+$/);
        expect(t.left, `${what}: the title starts inside the column`).toBeGreaterThanOrEqual(
          t.column.left - 0.5,
        );
        expect(
          t.right,
          `${what}: the title ends ${(t.right - t.column.right).toFixed(1)}px past the column`,
        ).toBeLessThanOrEqual(t.column.right + 0.5);
        if (t.wordBroke) broke++;
      }
    }
    // The premise, where the column is the narrowest: a word broke somewhere.
    if (size.width === 568) {
      expect(broke, 'the premise: "Wave" broke inside the word at heavy text').toBeGreaterThan(0);
    }
  });
}

/** The title's mid-word break, undone (`ui.css`). */
const TITLE_UNBROKEN = '.wy-wave-preview-title { overflow-wrap: normal !important; }';

test('Compact at 100% text: the title’s mid-word break moves nothing — the Dock, its controls, the chips, the home mark, the board and the strip’s rows stay where they are, before and after Start (#181)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  for (const size of STRIP_PHONES) {
    await gotoAt(page, size);
    expect(await page.evaluate((q) => matchMedia(q).matches, COMPACT_QUERY)).toBe(true);
    await settle(page);
    for (const phase of ['pre-start', 'started'] as const) {
      if (phase === 'started') {
        await page.getByRole('button', { name: 'Start', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Call wave' })).toBeVisible();
        await page.getByRole('button', { name: 'Pause' }).click(); // nothing moves between reads
        await settle(page);
      }
      const what = `${size.width}×${size.height}, ${phase}`;
      const read = (): Promise<string> =>
        page.evaluate(() =>
          [
            ...document.querySelectorAll(
              '.wy-dock, .wy-dock .wy-btn, .wy-hud > .wy-chip, .wy-home, .wy-mark, .wy-board, .wy-wave-preview-title, .wy-wave-preview .wy-preview-entry',
            ),
          ]
            .map((el) => {
              const b = el.getBoundingClientRect();
              return [b.x, b.y, b.width, b.height].map((v) => v.toFixed(3)).join(',');
            })
            .join(' | '),
        );
      const withBreak = await read();
      await page.evaluate((css) => {
        const style = document.createElement('style');
        style.id = 'wy-test-unbroken';
        style.textContent = css;
        document.head.append(style);
      }, TITLE_UNBROKEN);
      await settle(page);
      const unbroken = await read();
      await page.evaluate(() => document.getElementById('wy-test-unbroken')?.remove());
      await settle(page);
      expect(withBreak, `${what}: the mid-word break moved a box at 100% text`).toBe(unbroken);
    }
  }
});
