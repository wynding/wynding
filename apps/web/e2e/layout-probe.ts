import { expect, type Page } from '@playwright/test';
import { createProjection } from '@wynding/render';
import { LAYOUT_REGIONS, REGION_ATTR } from '../src/layout';

// layout-probe.ts — shared measurement helpers for the Story 11 layout gates
// (`compact.spec.ts` + `smoke.spec.ts`'s 200%-zoom section). Following `contrast.ts`'s
// precedent: a small e2e-only helper module rather than a duplicated block per spec.
//
// EVERY size gate here is computed against the PROJECTED PLAYABLE GRID — the letterboxed
// board rect `createProjection` derives from `.wy-board`'s box — never against element
// boxes. A stage that grows while the grid inside it stays the same size is not more
// playable space, and an element-box gate would not notice the difference.

// M1's "Open Field" board is 28×24 — duplicated from content's boards.ts rather than
// imported (e2e stays decoupled from content internals; the same two numbers touch.spec.ts
// and hidpi.spec.ts already duplicate).
export const GRID = { cols: 28, rows: 24 };

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The projected playable grid: where the board's cells actually are, in page coordinates,
 *  plus the CSS px per cell the projection resolved to. */
export interface GridRect extends Rect {
  readonly cellPx: number;
}

/** Measure the projected playable grid from `.wy-board`'s box. */
export async function projectedGrid(page: Page): Promise<GridRect> {
  const box = await page.locator('.wy-board').boundingBox();
  expect(box, '.wy-board has no layout box').not.toBeNull();
  const { x, y, width, height } = box as Rect;
  const projection = createProjection({
    cols: GRID.cols,
    rows: GRID.rows,
    cssWidth: width,
    cssHeight: height,
    dpr: 1,
  });
  return {
    x: x + projection.originX,
    y: y + projection.originY,
    width: projection.cellPx * GRID.cols,
    height: projection.cellPx * GRID.rows,
    cellPx: projection.cellPx,
  };
}

/** The box of the single element declaring `region`, or null when it is absent/invisible
 *  (the banner is present only pre-start·undismissed·qualifying, P3). */
export async function regionRect(page: Page, region: string): Promise<Rect | null> {
  const locator = page.locator(`[${REGION_ATTR}="${region}"]`);
  if ((await locator.count()) === 0) return null;
  if (!(await locator.isVisible())) return null;
  return (await locator.boundingBox()) as Rect | null;
}

/** The overlapping rectangle of `a` and `b`, or null when they are disjoint. Touching edges
 *  count as disjoint (a zero-area intersection is not an overlap). */
export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  // A sub-pixel sliver is layout rounding, not a real overlap — the regions are laid out by
  // a grid whose tracks can land on fractional pixels.
  const EPS = 1;
  if (right - x <= EPS || bottom - y <= EPS) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** True when `outer` fully contains `inner` (1px tolerance for fractional grid tracks). */
export function contains(outer: Rect, inner: Rect): boolean {
  const EPS = 1;
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.width <= outer.x + outer.width + EPS &&
    inner.y + inner.height <= outer.y + outer.height + EPS
  );
}

/** Rob's border-overlap design, pinned numerically (contract §5): the Standard Dock is an
 *  absolute overlay that may clip the projected grid's BOTTOM-LEFT corner and nothing else.
 */
export const STANDARD_DOCK_OVERLAP_MAX_PX = 64;

/** Enforce the per-region relation table (contract §5) against the projected grid.
 *  `layout` selects the Dock's expected relation: Compact's in-column Dock is measured
 *  SEPARATELY from the `status` box, so a Dock overflowing into the Stage cannot hide
 *  behind a passing status check. */
export async function assertRegionRelations(
  page: Page,
  layout: 'compact' | 'standard',
): Promise<void> {
  const grid = await projectedGrid(page);

  const stage = await regionRect(page, 'stage');
  expect(stage, 'the stage region must be present').not.toBeNull();
  expect(contains(stage as Rect, grid), 'stage must contain the projected grid').toBe(true);

  for (const region of ['status', 'rail', 'banner'] as const) {
    const rect = await regionRect(page, region);
    if (rect === null) continue; // absent by design (the banner, pre-P3 / once dismissed)
    expect(
      intersect(rect, grid),
      `region "${region}" must be disjoint from the projected grid`,
    ).toBeNull();
  }

  const dock = await regionRect(page, 'dock');
  expect(dock, 'the dock region must be present').not.toBeNull();
  const overlap = intersect(dock as Rect, grid);
  if (layout === 'compact') {
    expect(overlap, 'the Compact in-column Dock must be disjoint from the grid').toBeNull();
  } else if (overlap !== null) {
    expect(
      overlap.height,
      `Standard Dock overlaps ${overlap.height}px of the grid (max ${STANDARD_DOCK_OVERLAP_MAX_PX})`,
    ).toBeLessThanOrEqual(STANDARD_DOCK_OVERLAP_MAX_PX);
    // ...and only at the grid's BOTTOM-LEFT: entirely within the bottom band, in the left
    // half. (The grid can extend a few px BELOW the Dock — the Dock floats 0.5rem off the
    // viewport edge — so the overlap is bounded by where it STARTS, not by a flush edge.)
    expect(
      overlap.y,
      'the Standard Dock may only clip the grid inside its bottom band',
    ).toBeGreaterThanOrEqual(grid.y + grid.height - STANDARD_DOCK_OVERLAP_MAX_PX - 1);
    expect(overlap.x, 'the Standard Dock may only clip the grid on its LEFT').toBeLessThan(
      grid.x + grid.width / 2,
    );
  }
}

/** Contract §5's undeclared-child detection: every VISIBLE direct layout child of
 *  `.wy-shell` / `.wy-main` must carry a declared region attribute. Structural containers
 *  (`.wy-main`) are exempt from carrying one themselves — the rule then requires each of
 *  their visible children to be declared. The `.wy-sr-only` live region is excluded (it has
 *  no layout box to place). A future element cannot ship undeclared. */
export async function assertDeclaredRegions(page: Page): Promise<void> {
  const report = await page.evaluate(
    ({ attr, known }) => {
      const undeclared: string[] = [];
      const unknown: string[] = [];
      const describe = (el: Element): string => `${el.tagName.toLowerCase()}.${el.className}`;
      for (const containerSel of ['.wy-shell', '.wy-main']) {
        const container = document.querySelector(containerSel);
        if (container === null) continue;
        for (const child of Array.from(container.children)) {
          if (child.classList.contains('wy-sr-only')) continue;
          const r = child.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue; // not rendered in this layout
          if (child.matches('.wy-main')) continue; // the enumerated structural exemption
          const region = child.getAttribute(attr);
          if (region === null) undeclared.push(describe(child));
          else if (!known.includes(region)) unknown.push(`${describe(child)} → ${region}`);
        }
      }
      return { undeclared, unknown };
    },
    { attr: REGION_ATTR, known: [...LAYOUT_REGIONS, 'banner'] as string[] },
  );
  expect(report.undeclared, 'visible layout children missing a data-wy-region').toEqual([]);
  expect(report.unknown, 'layout children declaring a region outside the registry').toEqual([]);
}

/** The visible status chips, as the text assistive tech actually reads: every text node NOT
 *  inside an `aria-hidden` subtree. Proves the dual-form contract end to end — the glance
 *  form is invisible to AT, and the full ICU message is never sentence-split. */
export async function visibleChipAccessibleText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const chip of Array.from(document.querySelectorAll<HTMLElement>('.wy-hud > .wy-chip'))) {
      const r = chip.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const walker = document.createTreeWalker(chip, NodeFilter.SHOW_TEXT);
      let text = '';
      let node = walker.nextNode();
      while (node !== null) {
        if (node.parentElement?.closest('[aria-hidden="true"]') === null) {
          text += node.nodeValue ?? '';
        }
        node = walker.nextNode();
      }
      out.push(text.trim());
    }
    return out;
  });
}
