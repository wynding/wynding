import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { projectedGrid } from './layout-probe';
import { TARGET_MIN_PX } from './targets';

// rail-cards.spec.ts — #181 H3/L2, what a browser actually paints of the Rail's Cards and the
// Panel docked below them. The DOM contract (which parts exist, what they say, which ones
// assistive tech reads, that nothing is rebuilt) is unit-tested in `overlay.test.ts`; the
// phone rail's fit is pinned in `compact.spec.ts`. This spec owns the rest: the can't-afford
// state as painted and as described, the docked Panel's layout on Standard, axe in every
// state the redesign adds, and the armed Card under forced colours.

const WIDE = { width: 1440, height: 900 };
const LAPTOP = { width: 1280, height: 720 };
const PHONE = { width: 658, height: 320 };

/** The frame's red, `--wy-need` (ui.css). */
const NEED_RGB = 'rgb(255, 138, 138)';

async function gotoAt(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
}

const bounty = (page: Page) => page.locator('.wy-chip[data-wy-chip="bounty"] .wy-chip-full');

/** Build `key`'s tower at cell (col,row) BEFORE Start — a pending build, which the HUD's Bounty
 *  (and so every Card) already counts as spent — then close the selection it opens. */
async function place(page: Page, key: string, col: number, row: number): Promise<void> {
  const board = page.locator('.wy-board');
  const pending = Number(await board.getAttribute('data-pending-adds'));
  await page.keyboard.press(key);
  await expect(page.locator('.wy-card[aria-pressed="true"]')).toHaveCount(1);
  const grid = await projectedGrid(page);
  await page.mouse.click(grid.x + (col + 0.5) * grid.cellPx, grid.y + (row + 0.5) * grid.cellPx);
  await expect(board).toHaveAttribute('data-pending-adds', String(pending + 1));
  await page.keyboard.press('Escape');
  await expect(page.locator('.wy-panel')).toBeHidden();
}

/** Spend the Bounty from 80 to 11: four Frost Splash (16 each) and a Basic (5). Splash (12),
 *  Beacon (15) and Frost Splash (16) are then short; everything else is affordable. */
async function spendTo11(page: Page): Promise<void> {
  for (const col of [3, 6, 9, 12]) await place(page, '9', col, 3);
  await place(page, '1', 15, 3);
  await expect(bounty(page)).toHaveText('Bounty: 11');
}

test.describe("#181 H3: the can't-afford state", () => {
  test('a Card the Bounty cannot pay for dims its art, says "need N", and is DESCRIBED as short — its name unchanged', async ({
    page,
  }) => {
    await gotoAt(page, WIDE);
    await spendTo11(page);
    const splash = page.locator('.wy-card').nth(2);
    const basic = page.locator('.wy-card').nth(0);

    // Short by one.
    await expect(splash).toHaveClass(/wy-card--short/);
    await expect(splash.locator('.wy-card-need')).toBeVisible();
    await expect(splash.locator('.wy-card-need')).toHaveText('need 1');
    await expect(splash).toHaveAccessibleDescription('Not enough Bounty: 1 more needed.');
    await expect(splash).toHaveAccessibleName('Splash Tower Cost: 12 3');
    const shortLook = await splash.evaluate((card) => ({
      art: getComputedStyle(card.querySelector('.wy-card-swatch') as HTMLElement).opacity,
      cost: getComputedStyle(card.querySelector('.wy-card-cost-value') as HTMLElement).color,
    }));
    expect(Number(shortLook.art), 'the art fades').toBeLessThan(0.6);
    expect(shortLook.cost, 'the cost turns the need colour').toBe(NEED_RGB);

    // Affordable: none of it.
    await expect(basic).not.toHaveClass(/wy-card--short/);
    await expect(basic.locator('.wy-card-need')).toBeHidden();
    await expect(basic).toHaveAccessibleDescription('');
    await expect(basic).toHaveAccessibleName('Basic Tower Cost: 5 1');
    const fine = await basic.evaluate(
      (card) => getComputedStyle(card.querySelector('.wy-card-swatch') as HTMLElement).opacity,
    );
    expect(fine).toBe('1');
  });

  test('the state follows the Bounty in place — the painted text is rewritten, never rebuilt', async ({
    page,
  }) => {
    await gotoAt(page, WIDE);
    await spendTo11(page);
    const splash = page.locator('.wy-card').nth(2);
    // Tag the nodes a press could be resting on (#98): the "need N" text and the cost number.
    await splash.evaluate((card) => {
      const tag = (n: Node | null): void => {
        (n as unknown as { wyProbe?: number }).wyProbe = 1;
      };
      tag(card.querySelector('.wy-card-need')!.firstChild);
      tag(card.querySelector('.wy-card-cost-value')!.firstChild);
      tag(card);
    });
    await place(page, '1', 18, 3); // another Basic: 11 -> 6
    await expect(bounty(page)).toHaveText('Bounty: 6');
    await expect(splash.locator('.wy-card-need')).toHaveText('need 6');
    await expect(splash).toHaveAccessibleDescription('Not enough Bounty: 6 more needed.');
    const same = await splash.evaluate((card) => {
      const probe = (n: Node | null): boolean =>
        (n as unknown as { wyProbe?: number } | null)?.wyProbe === 1;
      return {
        need: probe(card.querySelector('.wy-card-need')!.firstChild),
        cost: probe(card.querySelector('.wy-card-cost-value')!.firstChild),
        card: probe(card),
      };
    });
    expect(same, 'the same nodes, rewritten in place').toEqual({
      need: true,
      cost: true,
      card: true,
    });
    // A Card that has just become short says so too: Slow (8) at 6.
    await expect(page.locator('.wy-card').nth(1)).toHaveAccessibleDescription(
      'Not enough Bounty: 2 more needed.',
    );
  });

  test('a short Card still arms — placement, not the Card, refuses the build', async ({ page }) => {
    await gotoAt(page, WIDE);
    await spendTo11(page);
    const splash = page.locator('.wy-card').nth(2);
    await splash.click();
    await expect(splash).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.wy-panel .wy-panel-name')).toHaveText('Splash Tower');
  });
});

test.describe('#181 H3: the Panel docked below the Cards', () => {
  for (const [label, size] of [
    ['1440×900', WIDE],
    ['1280×720', LAPTOP],
  ] as const) {
    test(`${label}: arming docks the Panel under the two-column Cards — art, name, role line, label-value rows, hint — and nothing scrolls`, async ({
      page,
    }) => {
      await gotoAt(page, size);
      await page.keyboard.press('4'); // venom, the frame's armed tower
      await expect(page.locator('.wy-panel')).toBeVisible();
      const m = await page.evaluate(() => {
        const rail = document.querySelector('.wy-rail') as HTMLElement;
        const panel = document.querySelector('.wy-panel') as HTMLElement;
        const rr = rail.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        const cards = [...document.querySelectorAll('.wy-card')].map((c) =>
          c.getBoundingClientRect(),
        );
        const art = panel.querySelector('.wy-panel-art') as HTMLCanvasElement;
        const ar = art.getBoundingClientRect();
        const ctx = art.getContext('2d');
        const colours = new Set<string>();
        if (ctx !== null) {
          const d = ctx.getImageData(0, 0, art.width, art.height).data;
          for (let i = 0; i < d.length; i += 4) colours.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
        }
        const name = panel.querySelector('.wy-panel-name') as HTMLElement;
        const role = panel.querySelector('.wy-panel-role') as HTMLElement;
        const rows = [...panel.querySelectorAll('.wy-stats-rows .wy-stat')].map((p) => {
          const l = p.querySelector('.wy-stat-label') as HTMLElement;
          const v = p.querySelector('.wy-stat-value') as HTMLElement;
          const lr = l.getBoundingClientRect();
          const vr = v.getBoundingClientRect();
          return {
            label: l.textContent,
            value: v.textContent,
            apart: lr.right <= vr.left,
            valueAtEdge: pr.right - vr.right,
          };
        });
        const hint = panel.querySelector('.wy-panel-hint') as HTMLElement;
        const close = panel.querySelector(':scope > button') as HTMLElement;
        const cr = close.getBoundingClientRect();
        return {
          columns: getComputedStyle(
            document.querySelector('.wy-cards') as HTMLElement,
          ).gridTemplateColumns.split(' ').length,
          panelPosition: getComputedStyle(panel).position,
          railScrollTop: rail.scrollTop,
          overflow: rail.scrollHeight - rail.clientHeight,
          belowCards: pr.top >= Math.max(...cards.map((c) => c.bottom)),
          panelInside: pr.top >= rr.top - 1 && pr.bottom <= rr.bottom + 1,
          art: {
            w: ar.width,
            h: ar.height,
            colours: colours.size,
            leftOfName: ar.right <= name.getBoundingClientRect().left,
          },
          name: name.textContent,
          role: role.textContent,
          roleVisible: role.getBoundingClientRect().height > 0,
          rows,
          hint: hint.textContent,
          hintVisible: hint.getBoundingClientRect().height > 0,
          closeInside: cr.top >= pr.top && cr.bottom <= pr.bottom,
          closeHeight: cr.height,
          fullWidth: (panel.querySelector('.wy-stats-full') as HTMLElement).getBoundingClientRect()
            .width,
        };
      });
      expect(m.columns, 'the two-column Cards').toBe(2);
      expect(m.panelPosition, 'docked in flow, not pinned').toBe('static');
      // The frame's promise: the Panel fills the empty space below the Cards, so the shop and
      // the Panel are on screen together with nothing to scroll.
      expect(m.belowCards, 'the Panel sits below every Card').toBe(true);
      expect(m.panelInside, 'the whole Panel is inside the Rail').toBe(true);
      expect(m.overflow, 'nothing overflows').toBe(0);
      expect(m.railScrollTop, 'arming scrolls nothing').toBe(0);
      // Head: the tower's art, painted, beside its name and role line.
      expect(m.art.w).toBe(40);
      expect(m.art.h).toBe(40);
      expect(m.art.colours, 'the head art is painted').toBeGreaterThanOrEqual(4);
      expect(m.art.leftOfName).toBe(true);
      expect(m.name).toBe('Venom Tower');
      expect(m.role).toBe('Poison · Ground');
      expect(m.roleVisible).toBe(true);
      // Label-value rows: the label on the left, the value at the right edge.
      expect(m.rows.map((r) => [r.label, r.value])).toEqual([
        ['Cost', '9'],
        ['Damage', '2'],
        ['Range', '4.0 tiles'],
        ['Fire rate', '0.7/s'],
        ['Poison', '4 every 0.5s for 3.0s'],
      ]);
      for (const r of m.rows) {
        expect(r.apart, `${r.label}: label and value apart`).toBe(true);
        expect(r.valueAtEdge, `${r.label}: value at the Panel's right edge`).toBeLessThan(20);
      }
      expect(m.hint).toBe('Choose a cell to build · Esc to cancel');
      expect(m.hintVisible).toBe(true);
      expect(m.closeInside).toBe(true);
      expect(m.closeHeight).toBeGreaterThanOrEqual(TARGET_MIN_PX);
      // The sentences are still there for assistive tech, painted at no width.
      expect(m.fullWidth).toBeLessThanOrEqual(2);
    });
  }

  test('1440×900: a placed tower’s docked Panel carries Sell and Max level, and no build hint', async ({
    page,
  }) => {
    await gotoAt(page, WIDE);
    await page.keyboard.press('1');
    const grid = await projectedGrid(page);
    await page.mouse.click(grid.x + 3.5 * grid.cellPx, grid.y + 3.5 * grid.cellPx);
    const panel = page.locator('.wy-panel');
    await expect(panel.getByRole('button', { name: /^Sell/ })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Max level' })).toBeVisible();
    await expect(panel.locator('.wy-panel-hint')).toHaveCount(0);
    await expect(panel.locator('.wy-panel-role')).toHaveText('Damage · Ground');
    await expect(panel.locator('.wy-panel-art')).toBeVisible();
    const nothingScrolled = await page.evaluate(
      () => (document.querySelector('.wy-rail') as HTMLElement).scrollTop,
    );
    expect(nothingScrolled).toBe(0);
  });
});

test.describe('#181 L2: a narrow Rail never scrolls sideways', () => {
  // Before #181 the Rail scrolled SIDEWAYS on every portrait phone — 15-34px of range at
  // default text and 101-120px at 200% (320×568, 360×640, 390×844), measured. The icon-form
  // Cards fixed default text; at 200% their bare 3.5rem tile minimum (112px) was still wider
  // than those Rails (58-77px of content) and left 19-38px, until the minimum was capped at
  // the Rail's own content box (`ui.css`). Read at rest, Panel closed, at both text sizes.
  const sideways = (page: Page) =>
    page.evaluate(() => {
      const rail = document.querySelector('.wy-rail') as HTMLElement;
      const cs = getComputedStyle(rail);
      const left = rail.getBoundingClientRect().left + rail.clientLeft;
      const contentLeft = left + parseFloat(cs.paddingLeft);
      const contentRight = left + rail.clientWidth - parseFloat(cs.paddingRight);
      const cards = [...document.querySelectorAll('.wy-card')].map((c) =>
        c.getBoundingClientRect(),
      );
      const chips = [...document.querySelectorAll('.wy-card--short')].map((card) => {
        const cb = card.getBoundingClientRect();
        const nb = (card.querySelector('.wy-card-need') as HTMLElement).getBoundingClientRect();
        return nb.left >= cb.left - 0.5 && nb.right <= cb.right + 0.5;
      });
      return {
        range: rail.scrollWidth - rail.clientWidth,
        cardsOutside: cards.filter(
          (b) => b.left < contentLeft - 0.5 || b.right > contentRight + 0.5,
        ).length,
        narrowest: Math.min(...cards.map((b) => b.width)),
        chipsShown: chips.length,
        chipsInside: chips.every(Boolean),
      };
    });

  for (const [w, h] of [
    [320, 568],
    [360, 640],
    [390, 844],
    [568, 320],
    [658, 320],
  ] as const) {
    for (const zoom of [100, 200] as const) {
      test(`${w}×${h} at ${zoom}% text: no sideways range, every Card inside the Rail and still a 44px target`, async ({
        page,
      }) => {
        await gotoAt(page, { width: w, height: h });
        if (zoom === 200) await page.addStyleTag({ content: ':root { font-size: 200% }' });
        const m = await sideways(page);
        expect(m.range, 'the Rail must not scroll sideways').toBe(0);
        expect(m.cardsOutside, 'every Card inside the Rail’s content box').toBe(0);
        expect(m.narrowest, 'every Card still a 44px target').toBeGreaterThanOrEqual(TARGET_MIN_PX);
      });
    }
  }

  test('360×640 at 200% text with Cards short: each "need N" stays inside its tile, and nothing scrolls sideways', async ({
    page,
  }) => {
    await gotoAt(page, { width: 360, height: 640 });
    await spendTo11(page);
    await page.addStyleTag({ content: ':root { font-size: 200% }' });
    const m = await sideways(page);
    expect(m.chipsShown, 'three Cards short, so three chips to check').toBe(3);
    expect(m.chipsInside, 'each "need N" wraps inside its tile').toBe(true);
    expect(m.range, 'the Rail must not scroll sideways').toBe(0);
  });
});

test.describe('#181 H3/L2: axe in every state the Rail redesign adds', () => {
  for (const [label, size] of [
    ['1440×900', WIDE],
    ['1280×720', LAPTOP],
    ['658×320', PHONE],
  ] as const) {
    test(`${label}: no violations at rest, with Cards short, armed short, and selected`, async ({
      page,
    }) => {
      const audit = async (state: string): Promise<void> => {
        const results = await new AxeBuilder({ page }).include('#app').analyze();
        expect(results.violations, state).toEqual([]);
      };
      await gotoAt(page, size);
      await audit('at rest');
      await spendTo11(page);
      await audit('three Cards short');
      await page.keyboard.press('3'); // Splash, short by one
      await expect(page.locator('.wy-panel')).toBeVisible();
      await audit('a short Card armed');
      await page.keyboard.press('Escape');
      const grid = await projectedGrid(page);
      await page.mouse.click(grid.x + 3.5 * grid.cellPx, grid.y + 3.5 * grid.cellPx);
      await expect(page.locator('.wy-panel').getByRole('button', { name: /^Sell/ })).toBeVisible();
      await audit('a tower selected');
    });
  }
});

test.describe('#181 H3: the armed Card under forced colours', () => {
  test('the armed Card keeps a mark of its own when the system repaints every Card', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await gotoAt(page, WIDE);
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    await page.keyboard.press('1');
    const armed = page.locator('.wy-card').nth(0);
    await expect(armed).toHaveAttribute('aria-pressed', 'true');
    // Off the armed Card, so its focus ring cannot stand in for the armed mark.
    await page.locator('.wy-board').focus();
    const look = (n: number) =>
      page
        .locator('.wy-card')
        .nth(n)
        .evaluate((card) => {
          const cs = getComputedStyle(card);
          return {
            border: cs.borderTopColor,
            outline: cs.outlineStyle,
            outlineColor: cs.outlineColor,
          };
        });
    const a = await look(0);
    const b = await look(1);
    expect(a.border, 'the armed border is not the resting one').not.toBe(b.border);
    expect(a.outline, 'and the armed Card carries the inner ring').toBe('solid');
    expect(b.outline).toBe('none');
  });
});
