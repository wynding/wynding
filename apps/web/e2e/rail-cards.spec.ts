import { test, expect, type Page } from './fixtures';
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
  test('the armed Card keeps a mark of its own when the system repaints every Card — focused or not', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await gotoAt(page, WIDE);
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    await page.keyboard.press('1');
    const armed = page.locator('.wy-card').nth(0);
    await expect(armed).toHaveAttribute('aria-pressed', 'true');
    // The armed mark is the border itself (3px double, in the selection colour), because the
    // focus ring is an outline: it replaces any outline mark, but not a border.
    const look = (n: number) =>
      page
        .locator('.wy-card')
        .nth(n)
        .evaluate((card) => {
          const cs = getComputedStyle(card);
          return {
            width: cs.borderTopWidth,
            style: cs.borderTopStyle,
            color: cs.borderTopColor,
            focused: card === document.activeElement,
            ring: cs.outlineStyle,
          };
        });
    // Off the armed Card first, then ON it: the same mark must show with its focus ring up.
    await page.locator('.wy-board').focus();
    const a = await look(0);
    const b = await look(1);
    expect(a.focused, 'the armed Card is not focused').toBe(false);
    expect({ width: a.width, style: a.style }, 'the armed Card has the 3px double border').toEqual({
      width: '3px',
      style: 'double',
    });
    expect({ width: b.width, style: b.style }, 'a resting Card keeps 1px solid').toEqual({
      width: '1px',
      style: 'solid',
    });
    expect(a.color, 'the armed border is not the resting one').not.toBe(b.color);

    await armed.focus();
    await expect(armed).toBeFocused();
    const f = await look(0);
    expect(f.focused).toBe(true);
    expect(f.ring, 'the focus ring is up (dashed, #181 UAT)').toBe('dashed');
    expect(
      { width: f.width, style: f.style },
      'and the armed mark still shows with focus ON the armed Card',
    ).toEqual({ width: '3px', style: 'double' });
    // A focused resting Card has the same ring and none of the mark: the two now differ.
    await page.locator('.wy-card').nth(1).focus();
    const g = await look(1);
    expect(g.focused).toBe(true);
    expect({ width: g.width, style: g.style }, 'a focused resting Card is 1px solid').toEqual({
      width: '1px',
      style: 'solid',
    });
  });
});

/** The frame's armed gold and the two inks a Card's name is drawn in (`--wy-armed`,
 *  `--wy-fg`, `--wy-fg-dim` in ui.css). */
const ARMED_RGB = 'rgb(255, 209, 102)';
const FG_RGB = 'rgb(244, 247, 251)';
const FG_DIM_RGB = 'rgb(155, 162, 174)';

/** What each Card paints over itself or past its own edges, one line per clash (empty when
 *  clean): its short name, art or "need N" under the hotkey, or its name, hotkey or "need N"
 *  past the Card's border box. Text is measured by its painted line boxes, not its element's
 *  box, and a part that is not painted (display: none, or visually hidden to 1px) takes no
 *  part. Runs in the page. */
function paintedClashes(): string[] {
  const textBox = (el: Element): DOMRect | null => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rs = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (rs.length === 0) return null;
    const left = Math.min(...rs.map((r) => r.left));
    const top = Math.min(...rs.map((r) => r.top));
    const right = Math.max(...rs.map((r) => r.right));
    const bottom = Math.max(...rs.map((r) => r.bottom));
    return new DOMRect(left, top, right - left, bottom - top);
  };
  const painted = (el: Element | null): el is HTMLElement =>
    el !== null && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 1;
  const overlap = (a: DOMRect, b: DOMRect): number =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const clashes: string[] = [];
  document.querySelectorAll('.wy-card').forEach((card, i) => {
    const cr = card.getBoundingClientRect();
    const part = (sel: string, text: boolean): DOMRect | null => {
      const el = card.querySelector(sel);
      if (!painted(el)) return null;
      return text ? textBox(el) : el.getBoundingClientRect();
    };
    const hotkey = part('.wy-card-hotkey', true);
    const name = part('.wy-card-label', true);
    const art = part('.wy-card-swatch', false);
    const need = part('.wy-card-need', false);
    for (const [what, box] of [
      ['name', name],
      ['art', art],
      ['"need N"', need],
    ] as const) {
      if (hotkey !== null && box !== null && overlap(hotkey, box) > 0.5) {
        clashes.push(`Card ${i + 1}: its hotkey paints over its ${what}`);
      }
    }
    for (const [what, box] of [
      ['name', name],
      ['hotkey', hotkey],
      ['"need N"', need],
    ] as const) {
      if (box !== null && (box.left < cr.left - 0.5 || box.right > cr.right + 0.5)) {
        clashes.push(`Card ${i + 1}: its ${what} runs past the Card's edge`);
      }
    }
  });
  return clashes;
}

test.describe('#181 H3: the corner hotkey never paints over its Card', () => {
  // The hotkey left the flow for the frame's corner, so it no longer narrows the name beside
  // it: the name must stay clear of it at the text sizes the two-column Rail is shown at.
  for (const [label, size, zoom] of [
    ['1280×720', LAPTOP, 150],
    ['1280×720', LAPTOP, 200],
    ['1440×900', WIDE, 200],
  ] as const) {
    test(`${label} at ${zoom}% text: no short name runs under its hotkey or out of its Card`, async ({
      page,
    }) => {
      await gotoAt(page, size);
      await page.addStyleTag({ content: `:root { font-size: ${zoom}% }` });
      expect(await page.evaluate(paintedClashes)).toEqual([]);
    });
  }

  // A player can rebind an arm key to one whose label is a word ("BracketLeft", "ArrowDown"),
  // or leave one unbound ("Unbound"): the label stays the tail of the Card's name either way.
  for (const [label, size] of [
    ['1440×900', WIDE],
    ['1000×720', { width: 1000, height: 720 }],
    ['640×560', { width: 640, height: 560 }],
  ] as const) {
    test(`${label}: a long key label never paints over its Card, and stays in its name`, async ({
      page,
    }) => {
      await gotoAt(page, size);
      await page.getByRole('button', { name: 'Settings' }).click();
      for (const [action, key] of [
        ['Arm tower 1', 'BracketLeft'],
        ['Arm tower 3', 'ArrowDown'],
        ['Arm tower 8', 'Digit9'], // takes 9's key, so Arm tower 9 is left unbound
      ] as const) {
        await page.getByRole('button', { name: `Rebind ${action}` }).click();
        await page.keyboard.press(key);
      }
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
      const cards = page.locator('.wy-card');
      await expect(cards.nth(0)).toHaveAccessibleName('Basic Tower Cost: 5 BracketLeft');
      await expect(cards.nth(2)).toHaveAccessibleName('Splash Tower Cost: 12 ArrowDown');
      await expect(cards.nth(8)).toHaveAccessibleName('Frost Splash Tower Cost: 16 Unbound');
      expect(await page.evaluate(paintedClashes)).toEqual([]);
    });
  }
});

test.describe('#181 H3: the armed and the short Card, as painted', () => {
  test('arming frames the Card in 3px — a 1px border and a 2px inset ring — and moves nothing inside it', async ({
    page,
  }) => {
    await gotoAt(page, WIDE);
    const card = page.locator('.wy-card').nth(0);
    const artAt = () =>
      card.locator('.wy-card-swatch').evaluate((art) => {
        const r = art.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      });
    const before = await artAt();
    await page.keyboard.press('1');
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(await artAt(), 'arming moves no part of the Card').toEqual(before);
    const frame = (n: number) =>
      page
        .locator('.wy-card')
        .nth(n)
        .evaluate((c) => {
          const cs = getComputedStyle(c);
          return { border: cs.borderTopWidth, ring: cs.boxShadow };
        });
    expect(await frame(0), 'armed: the frame').toEqual({
      border: '1px',
      ring: `${ARMED_RGB} 0px 0px 0px 2px inset`,
    });
    expect(await frame(1), 'resting: the quiet edge alone').toEqual({
      border: '1px',
      ring: 'none',
    });
  });

  test("a short Card's name steps down to the dim ink; an affordable one keeps the full ink", async ({
    page,
  }) => {
    await gotoAt(page, WIDE);
    await spendTo11(page);
    const ink = (n: number) =>
      page
        .locator('.wy-card')
        .nth(n)
        .locator('.wy-card-label')
        .evaluate((l) => getComputedStyle(l).color);
    expect(await ink(2), 'Splash, short by one').toBe(FG_DIM_RGB);
    expect(await ink(0), 'Basic, affordable').toBe(FG_RGB);
  });
});

test.describe('#181 H3: only a digit is painted in the corner', () => {
  // The corner was drawn for a digit. A letter ("W") or a function key ("F1") is wider, and on
  // the icon form's tile it lands on the art; every label but a digit is visually hidden, and
  // stays the tail of the Card's name. A digit is painted there only on a tile wide enough for
  // it (`ui.css`): DejaVu Sans, CI's Linux font, draws it 0.636em wide, and it painted over the
  // art at 360×640 at 200% and in the two 57px columns of 486×800 at 100%, where the macOS
  // system font cleared it by under 0.4px; at 320×568 at 175% it clashed in both. Each size
  // says whether Cards 4-9 paint their digits, so the rule can neither paint one over the art
  // nor hide one that fits.
  for (const [label, size, zoom, digits] of [
    ['640×560', { width: 640, height: 560 }, 100, 'painted'],
    ['820×720', { width: 820, height: 720 }, 100, 'painted'],
    ['360×640', { width: 360, height: 640 }, 175, 'painted'],
    ['360×640', { width: 360, height: 640 }, 200, 'hidden'],
    ['320×568', { width: 320, height: 568 }, 175, 'hidden'],
    ['486×800', { width: 486, height: 800 }, 100, 'hidden'],
  ] as const) {
    test(`${label} at ${zoom}% text: a letter or function-key label never paints over its Card, and stays in its name; the digits are ${digits}`, async ({
      page,
    }) => {
      await gotoAt(page, size);
      if (zoom !== 100) await page.addStyleTag({ content: `:root { font-size: ${zoom}% }` });
      await page.getByRole('button', { name: 'Settings' }).click();
      for (const [action, key] of [
        ['Arm tower 1', 'F1'],
        ['Arm tower 2', 'KeyW'],
        ['Arm tower 3', 'KeyM'],
      ] as const) {
        await page.getByRole('button', { name: `Rebind ${action}` }).click();
        await page.keyboard.press(key);
      }
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
      const cards = page.locator('.wy-card');
      await expect(cards.nth(0)).toHaveAccessibleName('Basic Tower Cost: 5 F1');
      await expect(cards.nth(1)).toHaveAccessibleName('Slow Tower Cost: 8 W');
      await expect(cards.nth(2)).toHaveAccessibleName('Splash Tower Cost: 12 M');
      // Cards 4-9 keep their digits, so a digit that is not painted was hidden by its tile.
      const hotkeys = page.locator('.wy-card-hotkey');
      await expect(hotkeys).toHaveText(['F1', 'W', 'M', '4', '5', '6', '7', '8', '9']);
      const digitsPainted = await hotkeys.evaluateAll((hs) =>
        hs.slice(3).map((h) => h.getBoundingClientRect().width > 1),
      );
      expect(digitsPainted, `Cards 4-9's digits are ${digits}`).toEqual(
        Array<boolean>(6).fill(digits === 'painted'),
      );
      expect(await page.evaluate(paintedClashes)).toEqual([]);
    });
  }

  test('a letter or a function key stays painted on the full form, where it fits', async ({
    page,
  }) => {
    await gotoAt(page, WIDE);
    await page.getByRole('button', { name: 'Settings' }).click();
    for (const [action, key] of [
      ['Arm tower 1', 'F1'],
      ['Arm tower 2', 'KeyW'],
      ['Arm tower 3', 'KeyM'],
    ] as const) {
      await page.getByRole('button', { name: `Rebind ${action}` }).click();
      await page.keyboard.press(key);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
    for (const [size, zoom] of [
      [WIDE, 100],
      [LAPTOP, 100],
      [WIDE, 200],
    ] as const) {
      await page.setViewportSize(size);
      await page.addStyleTag({ content: `:root { font-size: ${zoom}% }` });
      const widths = await page
        .locator('.wy-card-hotkey')
        .evaluateAll((hs) => hs.slice(0, 3).map((h) => h.getBoundingClientRect().width));
      expect(
        widths.every((w) => w > 1),
        `${size.width}×${size.height} at ${zoom}%: F1, W and M are painted`,
      ).toBe(true);
      expect(await page.evaluate(paintedClashes)).toEqual([]);
    }
  });

  test('a key rebound to a word and back to a digit is painted again', async ({ page }) => {
    await gotoAt(page, WIDE);
    const hotkey = page.locator('.wy-card').nth(0).locator('.wy-card-hotkey');
    const rebind = async (key: string): Promise<void> => {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Rebind Arm tower 1' }).click();
      await page.keyboard.press(key);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
    };
    const paintedWidth = () => hotkey.evaluate((h) => h.getBoundingClientRect().width);
    await rebind('BracketLeft');
    await expect(hotkey).toHaveText('BracketLeft');
    expect(await paintedWidth(), 'a word is not painted').toBeLessThanOrEqual(1);
    await rebind('Digit1');
    await expect(hotkey).toHaveText('1');
    expect(await paintedWidth(), 'the digit is painted again').toBeGreaterThan(1);
  });
});

test.describe('#181 H3: under forced colours, arming moves nothing inside the Card', () => {
  // The forced-colours armed mark is a 3px double border, 2px wider than the resting one. The
  // padding gives those 2px back, but the corner hotkey and the icon form's "need N" are placed
  // from the padding edge, so they must give them back too.
  for (const [label, size] of [
    ['1440×900 (full form)', WIDE],
    ['640×560 (icon form)', { width: 640, height: 560 }],
    ['658×320 (phone rail)', PHONE],
  ] as const) {
    test(`${label}: no part of a short Card moves when it is armed, the hotkey and "need N" included`, async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: 'active' });
      await gotoAt(page, size);
      await spendTo11(page); // Splash (Card 3) is short by one, so "need 1" paints
      const card = page.locator('.wy-card').nth(2);
      const parts = () =>
        card.evaluate((c) => {
          const cr = c.getBoundingClientRect();
          const at = (sel: string): number[] | null => {
            const el = c.querySelector(sel);
            if (el === null || getComputedStyle(el).display === 'none') return null;
            const r = el.getBoundingClientRect();
            if (r.width <= 1) return null; // visually hidden
            return [r.left - cr.left, r.top - cr.top, r.width, r.height];
          };
          return {
            art: at('.wy-card-swatch'),
            name: at('.wy-card-label'),
            cost: at('.wy-card-cost-glance'),
            hotkey: at('.wy-card-hotkey'),
            need: at('.wy-card-need'),
          };
        });
      const before = await parts();
      expect(before.need, '"need N" is painted').not.toBeNull();
      await page.keyboard.press('3');
      await expect(card).toHaveAttribute('aria-pressed', 'true');
      expect(
        await card.evaluate((c) => getComputedStyle(c).borderTopStyle),
        'the premise: the forced-colours armed mark',
      ).toBe('double');
      expect(await parts(), 'arming moves nothing inside the Card').toEqual(before);
    });
  }
});

// A focused Card must not read like an armed one (#181, the owner's UAT ruling). Both are the
// same yellow, and on the phone rail's small tiles a solid focus ring beside the armed frame
// looked like arming. The Card's focus ring is DASHED; the armed frame is a border and an inset
// ring. Armed and focused shows both, the frame inside and the dashed ring outside.
test.describe('#181 UAT: a focused Card is dashed, an armed Card is framed, and both show together', () => {
  for (const [label, size] of [
    ['658×320 (the phone rail)', PHONE],
    ['1440×900', WIDE],
  ] as const) {
    test(`${label}: focused only, armed only, armed and focused — and the Card's box is the same in all four states`, async ({
      page,
    }) => {
      await gotoAt(page, size);
      const look = (n: number) =>
        page
          .locator('.wy-card')
          .nth(n)
          .evaluate((card) => {
            const cs = getComputedStyle(card);
            const b = card.getBoundingClientRect();
            return {
              focused: card === document.activeElement,
              pressed: card.getAttribute('aria-pressed'),
              outlineStyle: cs.outlineStyle,
              outlineWidth: cs.outlineWidth,
              outlineOffset: cs.outlineOffset,
              outlineColor: cs.outlineColor,
              borderWidth: cs.borderTopWidth,
              borderColor: cs.borderTopColor,
              ring: cs.boxShadow,
              box: [b.x, b.y, b.width, b.height],
            };
          });

      // A key press first, so the page is in keyboard modality and a script `focus()` matches
      // `:focus-visible`; then back to nothing armed.
      await page.keyboard.press('1');
      await expect(page.locator('.wy-card').nth(0)).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape');
      await expect(page.locator('.wy-card[aria-pressed="true"]')).toHaveCount(0);
      await page.locator('.wy-board').focus();
      const rest = await look(0);
      expect(rest.pressed).toBe('false');
      expect(rest.outlineStyle, 'a resting, unfocused Card has no ring').toBe('none');

      // Focused only: the dashed ring, 3px at a 2px offset in the yellow, and no frame.
      await page.locator('.wy-card').nth(0).focus();
      const focusedOnly = await look(0);
      expect(focusedOnly.focused).toBe(true);
      expect(focusedOnly.pressed).toBe('false');
      expect(focusedOnly.outlineStyle, 'a focused Card’s ring is dashed').toBe('dashed');
      expect(focusedOnly.outlineWidth).toBe('3px');
      expect(focusedOnly.outlineOffset).toBe('2px');
      expect(focusedOnly.outlineColor).toBe(ARMED_RGB);
      expect(focusedOnly.ring, 'focus alone adds no frame').toBe('none');
      expect(focusedOnly.borderWidth).toBe('1px');

      // Armed only: the frame (a 1px border and a 2px inset ring), and no outline.
      await page.keyboard.press('1');
      await expect(page.locator('.wy-card').nth(0)).toHaveAttribute('aria-pressed', 'true');
      await page.locator('.wy-board').focus();
      const armedOnly = await look(0);
      expect(armedOnly.focused).toBe(false);
      expect(armedOnly.pressed).toBe('true');
      expect(armedOnly.outlineStyle, 'an armed, unfocused Card has no outline').toBe('none');
      expect(armedOnly.borderWidth).toBe('1px');
      expect(armedOnly.borderColor).toBe(ARMED_RGB);
      expect(armedOnly.ring).toBe(`${ARMED_RGB} 0px 0px 0px 2px inset`);

      // Armed and focused: both, the frame inside and the dashed ring outside.
      await page.locator('.wy-card').nth(0).focus();
      const both = await look(0);
      expect(both.focused).toBe(true);
      expect(both.pressed).toBe('true');
      expect(both.outlineStyle).toBe('dashed');
      expect(both.outlineWidth).toBe('3px');
      expect(both.outlineOffset).toBe('2px');
      expect(both.outlineColor).toBe(ARMED_RGB);
      expect(both.borderColor).toBe(ARMED_RGB);
      expect(both.ring).toBe(`${ARMED_RGB} 0px 0px 0px 2px inset`);

      // Nothing moves: the Card's box is identical in every state.
      for (const [state, s] of [
        ['focused only', focusedOnly],
        ['armed only', armedOnly],
        ['armed and focused', both],
      ] as const) {
        expect(s.box, `the Card's box when ${state}`).toEqual(rest.box);
      }
    });
  }
});
