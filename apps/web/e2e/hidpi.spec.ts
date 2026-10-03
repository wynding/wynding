import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { createProjection, resolvePalette, roleColour, towerRoleFor } from '@wynding/render';
import { GRID } from './layout-probe';

// HiDPI backing-store gates (#28/P5). Runs ONLY under the chromium-dpr1/2/3 projects
// (playwright.config.ts pins a fixed 1280×900 viewport there so the board's letterboxed
// layout — and therefore every expected cell pixel below — is stable across dsf). The
// default `chromium` project explicitly ignores this file (`testIgnore`).
//
// Three gates, each catching a distinct failure mode a size check alone can't:
//   (a) backing store  — the canvas' actual pixel buffer sizes to the device pixels its
//       CSS rect snaps to at the clamped dpr, and its CSS size stays the rect.
//   (b) rendered alignment — a real screenshot, decoded with pngjs (the existing DOM
//       "rendered-contrast" spot checks in smoke.spec.ts read computed CSS on DOM
//       elements and cannot sample the canvas), pins that a known floor cell and a known
//       border cell land at their PROJECTED CSS position — catches an origin shift/crop
//       that a size check alone would miss.
//   (c) pointer alignment — a click at a known cell lands its resulting tower's cue at
//       that cell's projected pixel, not a neighbour's — the controller is private to
//       main.ts, so this is necessarily a visual assertion, same pngjs decoder.

function toRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

/** Per-channel tolerance for a GPU/AA-composited sample vs. the exact palette hex. */
const CHANNEL_TOL = 24;

function closeTo(actual: [number, number, number], expected: [number, number, number]): boolean {
  return actual.every((c, i) => Math.abs(c - (expected[i] as number)) <= CHANNEL_TOL);
}

/** Sample a CSS-space point from a `png` decoded from a clip whose origin is (clipX, clipY). */
function sampleCssPoint(
  png: PNG,
  clipX: number,
  clipY: number,
  cssX: number,
  cssY: number,
): [number, number, number] {
  const px = Math.min(png.width - 1, Math.max(0, Math.round(cssX - clipX)));
  const py = Math.min(png.height - 1, Math.max(0, Math.round(cssY - clipY)));
  const idx = (png.width * py + px) << 2;
  return [png.data[idx] as number, png.data[idx + 1] as number, png.data[idx + 2] as number];
}

test.describe('HiDPI backing store + alignment (#28/P5)', () => {
  test('backing store sizes to the device pixels the CSS rect snaps to at the clamped dpr; CSS size stays pinned to the rect', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    const board = page.locator('.wy-board');
    await expect(board).toBeVisible();
    const box = await board.boundingBox();
    expect(box).not.toBeNull();

    const rawDpr = (testInfo.project.use.deviceScaleFactor as number | undefined) ?? 1;
    const effectiveDpr = Math.min(2, rawDpr);

    // Phaser creates the canvas at 1×1 (scale: { width: 1, height: 1 }) and only resizes
    // it inside the READY handler's syncProjection — on CI (SwiftShader WebGL) READY can
    // lag well past `load`, so poll past that sync before reading the backing store.
    const canvasLocator = page.locator('.wy-board canvas');
    await expect
      .poll(() => canvasLocator.evaluate((el: HTMLCanvasElement) => el.width))
      .toBeGreaterThan(1);

    const canvas = await canvasLocator.evaluate((el: HTMLCanvasElement) => {
      const rect = el.getBoundingClientRect();
      return {
        width: el.width,
        height: el.height,
        left: rect.left,
        top: rect.top,
        cssWidth: rect.width,
        cssHeight: rect.height,
      };
    });

    // The backing store is the device pixels the canvas's box snaps to at the clamped dpr,
    // from the one nearest its left edge to the one nearest its right (and likewise down):
    // what a browser that lays the page out in device pixels draws it into, pixel for pixel.
    // That can be a pixel off round(width × dpr), which is what the store was once sized to —
    // and a store scaled into its box smears every one-pixel line (`plate-rim.spec.ts`).
    // Positions are read to the layout engine's 1/64 px before rounding.
    const edge = (v: number): number => Math.round(Math.round(v * effectiveDpr * 64) / 64);
    const span = (start: number, size: number): number => edge(start + size) - edge(start);
    expect(canvas.width).toBe(span(canvas.left, canvas.cssWidth));
    expect(canvas.height).toBe(span(canvas.top, canvas.cssHeight));
    // CSS size stays pinned to the container rect regardless of dpr/clamp.
    expect(Math.round(canvas.cssWidth)).toBe(Math.round((box as { width: number }).width));
    expect(Math.round(canvas.cssHeight)).toBe(Math.round((box as { height: number }).height));
  });

  test('rendered alignment: a known floor cell and a known border cell land at their projected pixel', async ({
    page,
  }) => {
    await page.goto('/');
    const board = page.locator('.wy-board');
    await expect(board).toBeVisible();
    // The floating wave preview (playtest round) is DOM chrome over the stage's top-left —
    // display-only and click-through, but opaque, and this tall 1280×900 viewport is
    // width-limited (≈10px of letterbox margin), so the card sits exactly over the corner
    // cells sampled below. Canvas backing-store alignment is this test's subject, not DOM
    // chrome occlusion (`stage-stability.spec.ts` owns the preview), so it is hidden for
    // the sampling.
    await page.evaluate(() => {
      (document.querySelector('.wy-wave-preview') as HTMLElement).hidden = true;
    });
    const box = (await board.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };

    // M1's "Open Field" board is 28×24 (entrance/exit on row 11) — the dims come from
    // `layout-probe.ts`'s shared `GRID`, the single mirror of content's boards.ts (e2e stays
    // decoupled from content internals).
    const projection = createProjection({
      cols: GRID.cols,
      rows: GRID.rows,
      cssWidth: box.width,
      cssHeight: box.height,
      dpr: 1, // CSS-px cell geometry is dpr-independent by design
    });
    const pal = resolvePalette('default');

    const floorCell = { col: 14, row: 5 }; // deep interior, far from the row-11 lane
    const borderCell = { col: 0, row: 0 }; // a corner — always part of the blocked ring

    const floorPx = projection.cellToPixel(floorCell.col, floorCell.row);
    const borderPx = projection.cellToPixel(borderCell.col, borderCell.row);
    const cellPx = projection.cellPx;

    const clipX = Math.min(floorPx.x, borderPx.x) - 2;
    const clipY = Math.min(floorPx.y, borderPx.y) - 2;
    const clip = {
      x: box.x + clipX,
      y: box.y + clipY,
      width: Math.max(floorPx.x, borderPx.x) - Math.min(floorPx.x, borderPx.x) + cellPx + 4,
      height: Math.max(floorPx.y, borderPx.y) - Math.min(floorPx.y, borderPx.y) + cellPx + 4,
    };
    // The first frame can lag Phaser READY on CI (SwiftShader WebGL) — a pre-paint
    // sample would read the page background, not the palette. Poll until the floor cell
    // reads as pal.floor, keeping the last decoded screenshot for the assertions below.
    let png!: PNG;
    await expect
      .poll(async () => {
        const buf = await page.screenshot({ clip, scale: 'css' });
        png = PNG.sync.read(buf);
        return closeTo(
          sampleCssPoint(png, clipX, clipY, floorPx.x + cellPx / 2, floorPx.y + cellPx / 2),
          toRgb(pal.floor),
        );
      }, 'first frame painted: floor cell reads as pal.floor')
      .toBe(true);

    const floorSample = sampleCssPoint(
      png,
      clipX,
      clipY,
      floorPx.x + cellPx / 2,
      floorPx.y + cellPx / 2,
    );
    const borderSample = sampleCssPoint(
      png,
      clipX,
      clipY,
      borderPx.x + cellPx / 2,
      borderPx.y + cellPx / 2,
    );

    expect(closeTo(floorSample, toRgb(pal.floor)), `floor sample ${floorSample.join(',')}`).toBe(
      true,
    );
    expect(
      closeTo(borderSample, toRgb(pal.border)),
      `border sample ${borderSample.join(',')}`,
    ).toBe(true);
  });

  test('pointer alignment: a click at a known cell places a tower whose cue appears at that cell, not a neighbour', async ({
    page,
  }) => {
    await page.goto('/');
    const board = page.locator('.wy-board');
    await expect(board).toBeVisible();
    const box = (await board.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };

    const projection = createProjection({
      cols: GRID.cols,
      rows: GRID.rows,
      cssWidth: box.width,
      cssHeight: box.height,
      dpr: 1,
    });
    const pal = resolvePalette('default');
    const cellPx = projection.cellPx;

    const targetCell = { col: 18, row: 5 }; // open interior, 2×2 footprint clear of row 11
    const neighbourCell = { col: 21, row: 5 }; // clear of the target's 2×2 footprint

    const targetPx = projection.cellToPixel(targetCell.col, targetCell.row);
    const neighbourPx = projection.cellToPixel(neighbourCell.col, neighbourCell.row);

    const clip = {
      x: box.x + Math.min(targetPx.x, neighbourPx.x) - 2,
      y: box.y + Math.min(targetPx.y, neighbourPx.y) - 2,
      width: Math.abs(neighbourPx.x - targetPx.x) + cellPx * 2 + 4,
      height: cellPx * 2 + 4,
    };
    const clipX = clip.x - box.x;
    const clipY = clip.y - box.y;

    // The first frame can lag Phaser READY on CI (SwiftShader WebGL) — a pre-paint
    // sample would read the page background, not the palette. Poll until the neighbour
    // cell reads as pal.floor before clicking (same pattern as the rendered-alignment
    // test) so the post-click samples measure the build, not a missing first frame.
    await expect
      .poll(async () => {
        const buf = await page.screenshot({ clip, scale: 'css' });
        const prePng = PNG.sync.read(buf);
        return closeTo(
          sampleCssPoint(
            prePng,
            clipX,
            clipY,
            neighbourPx.x + cellPx / 2,
            neighbourPx.y + cellPx / 2,
          ),
          toRgb(pal.floor),
        );
      }, 'first frame painted: neighbour cell reads as pal.floor')
      .toBe(true);

    // Press Start first (PLAN.md P4): a build on a held run is Pending (drawn translucent,
    // not the solid art this test samples) — the run must actually be stepping for the
    // build to commit and paint solid.
    await page.getByRole('button', { name: 'Start' }).click();

    // Desktop input is armed-click-to-place (PLAN.md P2): arm the Card first, then a
    // single click on an empty, in-bounds, affordable cell places directly.
    await page.getByRole('button', { name: /Basic Tower/ }).click();
    await page.mouse.click(box.x + targetPx.x + cellPx / 2, box.y + targetPx.y + cellPx / 2);

    // Two points the basic tower's art guarantees (`tower-art.ts`, a 64-unit box over the
    // 2×2 footprint, so one design unit is cellPx / 32 CSS px):
    //  - its HEAD: a role-coloured ring around an ink core, 3.6 to 11.5 units from the
    //    footprint centre — sampled 7.5 units straight below the centre (the barrel points
    //    up), in basic's role colour;
    //  - its PLATE: the slate inside the rim, at (12, 50) — 8 units in from the rim's inner
    //    edge, 13 from the head.
    const unit = cellPx / 32;
    const ringPoint = { x: targetPx.x + 32 * unit, y: targetPx.y + 39.5 * unit };
    const platePoint = { x: targetPx.x + 12 * unit, y: targetPx.y + 50 * unit };
    const roleRgb = toRgb(roleColour(pal, towerRoleFor('basic')));

    // The build paints on a later animation frame — poll the head's ring until it reads
    // as basic's role colour, keeping the last decoded screenshot for the assertions below.
    let png!: PNG;
    await expect
      .poll(async () => {
        const buf = await page.screenshot({ clip, scale: 'css' });
        png = PNG.sync.read(buf);
        return closeTo(sampleCssPoint(png, clipX, clipY, ringPoint.x, ringPoint.y), roleRgb);
      }, 'build painted: the head’s ring reads as basic’s role colour')
      .toBe(true);

    const ringSample = sampleCssPoint(png, clipX, clipY, ringPoint.x, ringPoint.y);
    const plateSample = sampleCssPoint(png, clipX, clipY, platePoint.x, platePoint.y);
    // Same offset applied to the untouched neighbour cell — must still read as floor.
    const neighbourSample = sampleCssPoint(
      png,
      clipX,
      clipY,
      neighbourPx.x + cellPx / 2,
      neighbourPx.y + cellPx / 2,
    );

    expect(closeTo(ringSample, roleRgb), `head sample ${ringSample.join(',')}`).toBe(true);
    // The plate is deliberately quiet against the floor (its rim carries the edge), so the
    // plate sample must match the plate AND not pass for the floor — at the ±24 tolerance
    // the two are told apart by the blue channel alone (69 against 42).
    expect(closeTo(plateSample, toRgb(pal.plate)), `plate sample ${plateSample.join(',')}`).toBe(
      true,
    );
    expect(
      closeTo(plateSample, toRgb(pal.floor)),
      `plate sample ${plateSample.join(',')} must not read as floor`,
    ).toBe(false);
    expect(
      closeTo(neighbourSample, toRgb(pal.floor)),
      `neighbour sample ${neighbourSample.join(',')} should still be floor`,
    ).toBe(true);
  });
});
