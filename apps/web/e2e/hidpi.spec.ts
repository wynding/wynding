import { test, expect, chromium, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { createProjection, resolvePalette, roleColour, towerRoleFor } from '@wynding/render';
import { GRID } from './layout-probe';

// HiDPI backing-store gates (#28/P5). Runs ONLY under the chromium-dpr1/2/3 projects
// (playwright.config.ts pins a fixed 1280×900 viewport there so the board's letterboxed
// layout — and therefore every expected cell pixel below — is stable across dsf). The
// default `chromium` project explicitly ignores this file (`testIgnore`).
//
// Three gates, each catching a distinct failure mode a size check alone can't:
//   (a) backing store  — the canvas' actual pixel buffer is the device pixels the browser
//       draws its CSS rect into: by the browser's OWN count (a `device-pixel-content-box`
//       observer the test makes itself, never the renderer's arithmetic) in browsers really
//       running at a device scale, below; under emulation, whose count is the screen's own
//       pixels and not the emulated ones, to within a pixel of the rect × the clamped dpr.
//       Its CSS size stays the rect.
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

/** The board canvas's backing store, and the device pixels the browser draws its box into
 *  by its own count: a `device-pixel-content-box` observer made here, independent of the
 *  renderer's. (Through the getter `hideDevicePixels` keeps, where it has hidden it.) */
async function storeAndBrowserCount(
  page: Page,
): Promise<{ store: [number, number]; browser: [number, number]; css: [number, number] }> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const canvas = document.querySelector<HTMLCanvasElement>('.wy-board canvas')!;
        const kept = (
          window as unknown as {
            __wyDevicePixels?: (e: ResizeObserverEntry) => readonly ResizeObserverSize[];
          }
        ).__wyDevicePixels;
        const observer = new ResizeObserver((entries) => {
          const entry = entries[entries.length - 1]!;
          const device = (kept ? kept(entry) : entry.devicePixelContentBoxSize)[0]!;
          const rect = canvas.getBoundingClientRect();
          observer.disconnect();
          resolve({
            store: [canvas.width, canvas.height],
            browser: [device.inlineSize, device.blockSize],
            css: [rect.width, rect.height],
          });
        });
        observer.observe(canvas, { box: 'device-pixel-content-box' });
      }),
  );
}

/** Polls until the store is the browser's own count, or fails with the last reading. */
async function expectStoreIsBrowserCount(page: Page, label: string, log = true): Promise<void> {
  let last = '';
  let held = false;
  await expect
    .poll(
      async () => {
        const r = await storeAndBrowserCount(page);
        last = JSON.stringify(r);
        return r.store[0] === r.browser[0] && r.store[1] === r.browser[1];
      },
      { message: `${label}: the backing store is the browser's count`, timeout: 5_000 },
    )
    .toBe(true)
    .then(() => (held = true))
    .finally(() => {
      if (log || !held) console.log(`[hidpi] ${label}: ${last}`);
    });
}

/** Init script: keep the browser's `devicePixelContentBoxSize` getter for the test's own
 *  observer, and with `hide`, take it away from the page — as a browser without it (WebKit),
 *  so the renderer works its store out from where the box sits. */
function hideDevicePixels({ hide }: { hide: boolean }): void {
  const proto = ResizeObserverEntry.prototype;
  const getter = Object.getOwnPropertyDescriptor(proto, 'devicePixelContentBoxSize')?.get;
  if (getter === undefined) return;
  (
    window as unknown as {
      __wyDevicePixels: (e: ResizeObserverEntry) => readonly ResizeObserverSize[];
    }
  ).__wyDevicePixels = (e) => getter.call(e) as readonly ResizeObserverSize[];
  if (hide)
    delete (proto as unknown as { devicePixelContentBoxSize?: unknown }).devicePixelContentBoxSize;
}

/** Runs `body` on the app in a browser really running at device scale `dsf`, its window
 *  `width`×`height`: `--force-device-scale-factor` lays the page out in device pixels and
 *  draws the canvas into the pixels its box snaps to — which Playwright's `deviceScaleFactor`
 *  does not: it lays the page out in CSS px and scales its picture. With `fallback`, the app
 *  sees no `device-pixel-content-box` (`hideDevicePixels`). */
async function atRealScale(
  {
    dsf,
    width,
    height,
    fallback,
  }: { dsf: number; width: number; height: number; fallback: boolean },
  baseURL: string | undefined,
  body: (page: Page) => Promise<void>,
): Promise<void> {
  const browser = await chromium.launch({
    args: [`--force-device-scale-factor=${dsf}`, `--window-size=${width},${height}`],
  });
  try {
    // `deviceScaleFactor: undefined` keeps Playwright Test from filling in the project's
    // emulated scale, which a context without a viewport refuses.
    const context = await browser.newContext({
      viewport: null,
      deviceScaleFactor: undefined,
      baseURL,
    });
    await context.addInitScript(hideDevicePixels, { hide: fallback });
    const page = await context.newPage();
    await page.goto('/');
    await expect
      .poll(() => page.locator('.wy-board canvas').evaluate((c: HTMLCanvasElement) => c.width))
      .toBeGreaterThan(1);
    const [innerW, innerH, dpr100] = await page.evaluate(() => [
      innerWidth,
      innerHeight,
      Math.round(devicePixelRatio * 100),
    ]);
    expect(dpr100, 'the device scale').toBe(Math.round(dsf * 100));
    // The window, to within a CSS px: at a fractional scale the browser sizes it in whole
    // device pixels (asked for 525 wide at 1.25, it is 526).
    expect(Math.abs(innerW! - width), `inner width ${innerW}`).toBeLessThanOrEqual(1);
    expect(Math.abs(innerH! - height), `inner height ${innerH}`).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() => 'devicePixelContentBoxSize' in ResizeObserverEntry.prototype),
      'the app sees the device-pixel box exactly when it should',
    ).toBe(!fallback);
    await body(page);
  } finally {
    await browser.close();
  }
}

test.describe('the backing store against the browser’s own count, at a real device scale', () => {
  // Worked out from where the box sits (as in WebKit): at each scale, at two window sizes —
  // 525×320 puts the board at x = 52.5 — and again after the board is resized by a fraction.
  for (const dsf of [0.8, 0.9, 1, 1.1, 1.25, 1.5, 2]) {
    test(`worked out from where the box sits, at ${dsf}: the browser's count, before and after a fractional resize`, async ({
      baseURL,
    }, testInfo) => {
      // A real-scale launch is its own browser: once, not once per emulated project.
      test.skip(testInfo.project.name !== 'chromium-dpr1', 'launches its own browser: run once');
      test.setTimeout(90_000);
      for (const [width, height] of [
        [525, 320],
        [1280, 720],
      ] as const) {
        await atRealScale({ dsf, width, height, fallback: true }, baseURL, async (page) => {
          const at = `${width}×${height} @${dsf}, worked out`;
          await expectStoreIsBrowserCount(page, at);
          // Narrower and shorter by fractions of a pixel: the ResizeObserver's sync.
          await page.evaluate(() => {
            const board = document.querySelector<HTMLElement>('.wy-board')!;
            board.style.right = '0.3px';
            board.style.top = '0.45px';
          });
          await expectStoreIsBrowserCount(page, `${at}, resized`);
        });
      }
    });
  }

  // The browser's own count (Chromium, Firefox), which it reports again when it changes —
  // after a move that changes it, too, which no size observer sees.
  for (const dsf of [0.8, 1, 1.25, 1.75]) {
    test(`the browser's own count at ${dsf}, followed through a move that does not resize the board`, async ({
      baseURL,
    }, testInfo) => {
      // A real-scale launch is its own browser: once, not once per emulated project.
      test.skip(testInfo.project.name !== 'chromium-dpr1', 'launches its own browser: run once');
      test.setTimeout(60_000);
      await atRealScale(
        { dsf, width: 525, height: 320, fallback: false },
        baseURL,
        async (page) => {
          const at = `525×320 @${dsf}`;
          await expectStoreIsBrowserCount(page, at);
          const counts = new Set<string>();
          // The Stage nudged across two device pixels, at most a 16th of one at a time (in the
          // page's own 64ths of a CSS px): the board keeps its size and moves, and its two
          // edges cross a pixel's middle at different nudges — where the count changes, which
          // a few coarse nudges can step over (at 1.75 the board spans 575.11 device pixels,
          // so the count changes only within an 0.11-pixel window per pixel).
          const step = Math.max(1, Math.floor(4 / dsf));
          for (let i = 1; i * step * dsf <= 128; i++) {
            const nudge = (i * step) / 64;
            await page.evaluate((n) => {
              document.querySelector<HTMLElement>('.wy-stage')!.style.left = `${n}px`;
            }, nudge);
            await expectStoreIsBrowserCount(page, `${at}, moved ${nudge}px`, false);
            counts.add(JSON.stringify((await storeAndBrowserCount(page)).browser));
          }
          console.log(`[hidpi] ${at}, through the moves: ${[...counts].join(' ')}`);
          // ... at least one of which changed the count, or this tested nothing.
          expect(counts.size, 'a move that changes the device-pixel count').toBeGreaterThan(1);
        },
      );
    });
  }
});

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
      return { cssWidth: rect.width, cssHeight: rect.height };
    });

    // The backing store is the device pixels the browser draws the canvas's box into — which
    // can be a pixel off round(width × dpr), what the store was once sized to; a store scaled
    // into its box smears every one-pixel line (`plate-rim.spec.ts`). Under emulation the
    // browser's own count is no oracle: Chromium counts the screen's own pixels, not the
    // emulated ones (a 1072 × 804 CSS box read 1072 × 804 at an emulated 2 — the count the
    // app once took for its store there, halving the board's resolution: QC round 4). So it
    // is the oracle only where the emulated scale is the screen's own, 1; elsewhere the store
    // is held within a pixel of the box × the clamped dpr — past the clamp (a 3× screen)
    // drawn at 2, fewer pixels than the box by design. The real-scale launches above hold it
    // to the browser's own count, exactly.
    if (rawDpr === 1) {
      await expectStoreIsBrowserCount(page, 'dpr 1');
    } else {
      const store = await canvasLocator.evaluate((el: HTMLCanvasElement) => [el.width, el.height]);
      console.log(
        `[hidpi] dpr ${rawDpr}: store ${store.join('×')} for the CSS box ${canvas.cssWidth}×${canvas.cssHeight}`,
      );
      expect(Math.abs(store[0]! - canvas.cssWidth * effectiveDpr), 'store width').toBeLessThan(1);
      expect(Math.abs(store[1]! - canvas.cssHeight * effectiveDpr), 'store height').toBeLessThan(1);
    }
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
