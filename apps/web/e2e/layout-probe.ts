import { expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { createProjection } from '@wynding/render';
import {
  EXEMPT_FROM_DECLARATION,
  LAYOUT_REGIONS,
  REGION_ATTR,
  WALKED_CONTAINERS,
} from '../src/layout';

// layout-probe.ts — shared measurement helpers for the layout gates: the Story 11 pair
// (`compact.spec.ts` + `smoke.spec.ts`'s 200%-zoom section) plus `home.spec.ts` and
// `arming.spec.ts`'s focus-ring pixel sampling (#69). Following `contrast.ts`'s
// precedent: a small e2e-only helper module rather than a duplicated block per spec.
//
// EVERY size gate here is computed against the PROJECTED PLAYABLE GRID — the letterboxed
// board rect `createProjection` derives from `.wy-board`'s box — never against element
// boxes. A stage that grows while the grid inside it stays the same size is not more
// playable space, and an element-box gate would not notice the difference. (`edgeColours`
// is not a size gate: a focus ring's home IS its element's border box, so that one probe
// deliberately samples element edges.)

// M1's "Open Field" board is 28×24 — mirrored from content's boards.ts rather than imported
// (e2e stays decoupled from content internals). This is the ONE copy of those two numbers:
// `touch.spec.ts` and `hidpi.spec.ts` import it rather than each keeping their own.
export const GRID = { cols: 28, rows: 24 };

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The focus-ring colour every `:focus-visible` indicator resolves to (`--wy-focus:
 *  #ffd166` in ui.css), as a screenshot-sampled `r,g,b` string. The ONE copy —
 *  `home.spec.ts` and `arming.spec.ts` sample against it rather than each pinning their
 *  own literal that a palette change would silently desync. */
export const FOCUS_RGB = '255,209,102';

/** The rendered colour at the midpoint of each edge of `selector`'s border box, from a
 *  fresh full-page screenshot. Rings drawn INSIDE the box (a negative `outline-offset`, or
 *  the board's inset `::after` border) put ring pixels exactly on the box edge, so a
 *  complete ring reads `FOCUS_RGB` at all four midpoints and a clipped, hidden, or absent
 *  one reads the backdrop. A rendered-pixel probe because nothing else can answer this:
 *  the DOM exposes no ring geometry and axe does not evaluate ring clipping (the
 *  `.wy-home` comment in ui.css records the gate that passed while the defect shipped). */
export async function edgeColours(page: Page, selector: string): Promise<Record<string, string>> {
  const box = (await page.locator(selector).boundingBox()) as Rect;
  expect(box, `${selector} has no layout box`).not.toBeNull();
  const png = PNG.sync.read(await page.screenshot());
  const rgb = (x: number, y: number): string => {
    const i = (png.width * y + x) << 2;
    return `${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`;
  };
  const midX = Math.round(box.x + box.width / 2);
  const midY = Math.round(box.y + box.height / 2);
  return {
    left: rgb(Math.round(box.x), midY),
    right: rgb(Math.round(box.x + box.width) - 1, midY),
    top: rgb(midX, Math.round(box.y)),
    bottom: rgb(midX, Math.round(box.y + box.height) - 1),
  };
}

/** The projected playable grid: where the board's cells actually are, in page coordinates,
 *  plus the CSS px per cell the projection resolved to. */
export interface GridRect extends Rect {
  readonly cellPx: number;
}

/** The STRUCTURALLY BUILDABLE region of the projected grid, in page coordinates: the grid
 *  inset by exactly one cell on every side.
 *
 *  DERIVED, not chosen. `packages/sim`'s `footprintBuildable` accepts a 2×2 footprint only
 *  where all four cells are `buildable-open` base terrain, and `buildGrid` blocks the whole
 *  outer ring (its two openings are `walkable-unbuildable`, also never buildable). So legal
 *  anchors run `col ∈ [1, cols-3] × row ∈ [1, rows-3]`, and the union of the cells those
 *  footprints cover is precisely cols 1..cols-2 × rows 1..rows-2.
 *
 *  "Structurally" is the whole point (owner ruling, #101, 2026-08-17): a cell a tower could
 *  EVER be placed on, not one that happens to be empty. A rule keyed to currently-empty
 *  would LOOSEN as the board fills — letting an overlay drift back over the corner the issue
 *  was opened about, and pass its own test while doing it. */
export function buildableRect(grid: GridRect): Rect {
  return {
    x: grid.x + grid.cellPx,
    y: grid.y + grid.cellPx,
    width: grid.width - 2 * grid.cellPx,
    height: grid.height - 2 * grid.cellPx,
  };
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
 *
 *  Since #152 this is the LOOSER of two Dock relations, kept because every existing caller
 *  measures through it: the board now stops at the Dock's top edge, and
 *  `assertNoBuildableCellUnderDock` below holds the strict claim (no buildable cell under the
 *  Dock at all), which `dock-overlap.spec.ts` asserts across the Standard sizes.
 */
export const STANDARD_DOCK_OVERLAP_MAX_PX = 64;

/** Enforce the per-region relation table (contract §5) against the projected grid.
 *  `layout` selects the Dock's expected relation: Compact's in-column Dock is measured
 *  SEPARATELY from the `status` box, so a Dock overflowing into the Stage cannot hide
 *  behind a passing status check. */
export async function assertRegionRelations(
  page: Page,
  layout: 'compact' | 'standard',
  // The Dock cluster is TEXT-sized: at 200% zoom its controls (and the rows they wrap into)
  // grow with the root font, so the pinned 64px band only describes the 100%-zoom case. A
  // zoom gate passes its own, explicitly justified allowance rather than silently relaxing
  // the default every caller relies on.
  dockOverlapMaxPx: number = STANDARD_DOCK_OVERLAP_MAX_PX,
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

  // The wave preview — ONE home since #181 (L1). It used to float over the Stage (#101's
  // letterbox → border ring → reserved row chain), where this gate held it to zero buildable
  // cells. Now the strip is built in the status region's chips list in BOTH layouts and never
  // moves, so its relation is the status region's, and it is gated harder than before:
  //  - WHERE it lives is a DOM fact, asserted unconditionally — so a regression that re-homed it
  //    onto the Stage fails here instead of slipping past a geometry check that only runs in one
  //    home (the old gate's blind spot: it skipped every non-floating state);
  //  - what of it is VISIBLE — its rect clipped to the chips list's scrollport, because inside a
  //    scrollport a scrolled-out entry reports layout coordinates anywhere — must sit inside the
  //    status region and stay disjoint from the projected grid.
  // Hidden (`regionRect` null) is legal: the strip keeps its box but hides once the run resolves.
  const previewHome = await page.evaluate(() => {
    const el = document.querySelector('[data-wy-region="preview"]');
    if (el === null) return 'absent';
    return el.parentElement?.matches('.wy-status > .wy-hud') === true ? 'chips' : 'elsewhere';
  });
  expect(previewHome, "the wave preview's one home is the status region's chips list").toBe(
    'chips',
  );
  const preview = await regionRect(page, 'preview');
  if (preview !== null) {
    const hud = (await page.locator('.wy-status > .wy-hud').boundingBox()) as Rect | null;
    expect(hud, 'the chips list must have a box while the strip does').not.toBeNull();
    const visible = intersect(preview, hud as Rect);
    if (visible !== null) {
      const status = await regionRect(page, 'status');
      expect(status, 'the status region must be present').not.toBeNull();
      expect(
        contains(status as Rect, visible),
        'the visible strip must sit inside the status region',
      ).toBe(true);
      expect(
        intersect(visible, grid),
        'the visible strip must be disjoint from the projected grid',
      ).toBeNull();
    }
  }

  const dock = await regionRect(page, 'dock');
  expect(dock, 'the dock region must be present').not.toBeNull();
  const overlap = intersect(dock as Rect, grid);
  if (layout === 'compact') {
    expect(overlap, 'the Compact in-column Dock must be disjoint from the grid').toBeNull();
  } else if (overlap !== null) {
    expect(
      overlap.height,
      `Standard Dock overlaps ${overlap.height}px of the grid (max ${dockOverlapMaxPx})`,
    ).toBeLessThanOrEqual(dockOverlapMaxPx);
    // ...and only at the grid's BOTTOM-LEFT: entirely within the bottom band, in the left
    // half. (The grid can extend a few px BELOW the Dock — the Dock floats 0.5rem off the
    // viewport edge — so the overlap is bounded by where it STARTS, not by a flush edge.)
    expect(
      overlap.y,
      'the Standard Dock may only clip the grid inside its bottom band',
    ).toBeGreaterThanOrEqual(grid.y + grid.height - dockOverlapMaxPx - 1);
    expect(overlap.x, 'the Standard Dock may only clip the grid on its LEFT').toBeLessThan(
      grid.x + grid.width / 2,
    );
  }
}

/** The Standard Dock covers NO structurally buildable cell (#152, owner ruling) — the relation
 *  that replaced "may clip the grid's bottom-left corner" for the Dock, and it is ABSOLUTE:
 *  no viewport, zoom level or banner state is exempt.
 *
 *  Why the old allowance was not enough: an overlay's paint is not the harm, its HIT TEST is.
 *  The Dock sits above the board (`z-index: 1`), so a tap on any cell beneath it lands on a
 *  Dock control instead — on the landscape tablet it was reported on, the Start button, which
 *  began the wave rather than placing the armed tower. A budget in px cannot describe "no
 *  tap is ever swallowed"; zero intersection can.
 *
 *  Measured against `buildableRect` (the grid inset by one cell) for the same reason the
 *  floating preview was (#101; the preview has had one home, in the status row, since #181):
 *  the outer ring is blocked terrain no tower can ever occupy. The fix
 *  (`--wy-dock-reserve`) keeps the whole grid clear of the Dock anyway, so this is the
 *  weaker of the two claims it satisfies — and the one the defect is about.
 *
 *  The Dock rect is its border box, which is also its scrollport when the bounded Dock
 *  scrolls, so a scrolled-out control can neither hide an overlap nor fake one. */
export async function assertNoBuildableCellUnderDock(page: Page): Promise<void> {
  const grid = await projectedGrid(page);
  const dock = await regionRect(page, 'dock');
  expect(dock, 'the dock region must be present').not.toBeNull();
  const covered = intersect(dock as Rect, buildableRect(grid));
  expect(
    covered,
    covered === null
      ? ''
      : `the Dock covers ${Math.round(covered.width)}×${Math.round(covered.height)}px of ` +
          `STRUCTURALLY BUILDABLE board (${(covered.width / grid.cellPx).toFixed(1)}×${(
            covered.height / grid.cellPx
          ).toFixed(1)} cells at cellPx ${grid.cellPx})`,
  ).toBeNull();
}

/** Contract §5's undeclared-child detection: every VISIBLE layout child of `.wy-shell` /
 *  `.wy-main` / `.wy-status` must carry a declared region attribute, apart from the
 *  enumerated exemptions above. The `.wy-sr-only` live region is excluded (it has no layout
 *  box to place). A future element cannot ship undeclared. */
export async function assertDeclaredRegions(page: Page): Promise<void> {
  const report = await page.evaluate(
    ({ attr, known, containers, exempt }) => {
      const undeclared: string[] = [];
      const unknown: string[] = [];
      const describe = (el: Element): string => `${el.tagName.toLowerCase()}.${el.className}`;
      for (const containerSel of containers) {
        const container = document.querySelector(containerSel);
        if (container === null) continue;
        for (const child of Array.from(container.children)) {
          if (child.classList.contains('wy-sr-only')) continue;
          const r = child.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue; // not rendered in this layout
          if (child.matches(exempt)) continue;
          const region = child.getAttribute(attr);
          if (region === null) undeclared.push(describe(child));
          else if (!known.includes(region)) unknown.push(`${describe(child)} → ${region}`);
        }
      }
      return { undeclared, unknown };
    },
    {
      attr: REGION_ATTR,
      known: [...LAYOUT_REGIONS] as string[],
      containers: WALKED_CONTAINERS,
      exempt: EXEMPT_FROM_DECLARATION,
    },
  );
  expect(report.undeclared, 'visible layout children missing a data-wy-region').toEqual([]);
  expect(report.unknown, 'layout children declaring a region outside the registry').toEqual([]);
}

/** The visible status chips, as the text assistive tech actually reads: every text node NOT
 *  inside an `aria-hidden` subtree. Proves the dual-form contract end to end — the glance
 *  form is invisible to AT, and the full ICU message is never sentence-split. A hidden chip
 *  is skipped in either of its forms: no box (Compact, the UA's `[hidden]`), or a box held
 *  with `visibility: hidden` (Standard keeps the countdown chip's slot, #181). */
export async function visibleChipAccessibleText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const chip of Array.from(document.querySelectorAll<HTMLElement>('.wy-hud > .wy-chip'))) {
      const r = chip.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (getComputedStyle(chip).visibility === 'hidden') continue;
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
