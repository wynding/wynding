import { test, expect, chromium, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { createProjection, resolvePalette, type CreepVM, type TowerVM } from '@wynding/render';
import { contrastRatio } from './contrast';
import { GRID } from './layout-probe';

// A turned head never darkens its plate's rim (visual pass T3, #181). The rim is a tower's
// footprint edge, `palette.tower` at 4.08:1 against the floor, drawn on whole device pixels
// (`plate-rim.spec.ts`). An aiming head turns about its footprint centre, and a turned sprite
// is resampled, so its outline spreads up to a pixel past its art; and at dprs between the
// whole ones, where the footprint ends inside a pixel, the texel grid brings the rim's far
// sides — bottom and right — in by up to a pixel. A Basic Tower turned toward one darkened the
// rim there: at 11 px cells, to 1.98:1 at dpr 1.125 (Windows' 125% under 90% browser zoom) and
// 2.89:1 at 1.25; at 10 px and 0.8375, where the rim is one pixel wide, to 2.81:1. So a posed
// head has its rim painted again over it (`placement.ts`, the `rims` layer).
//
// The harness (`e2e-harness/turned-heads.html`) mounts the real renderer with a scene this spec
// sets: a Basic Tower, and a creep standing at the bearing its head is to turn to. Every rim
// pixel is found with the head at rest, then each is measured with it turned.

const HARNESS = 'http://localhost:4176/e2e-harness/turned-heads.html';
const PAL = resolvePalette('default');
const rgb = (hex: number): [number, number, number] => [
  (hex >> 16) & 0xff,
  (hex >> 8) & 0xff,
  hex & 0xff,
];
const RIM = rgb(PAL.tower);
const FLOOR = rgb(PAL.floor);
/** WCAG 1.4.11, the bar the palette gate holds `tower` to against the floor. */
const MIN_CONTRAST = 3;
const FP = 256; // sim units per cell
const TOWER = { col: 5, row: 5 };

interface Harness {
  towers: TowerVM[];
  creeps: CreepVM[];
  frames: number;
}

const basic = (targetId: number): TowerVM => ({
  id: 1,
  col: TOWER.col,
  row: TOWER.row,
  towerId: 'basic',
  support: false,
  buffed: false,
  targetId,
});

/** A creep standing 8 cells from the footprint centre, `deg` clockwise from straight up. */
const creepAt = (deg: number): CreepVM => {
  const a = (deg * Math.PI) / 180;
  return {
    id: 7,
    creepId: 'normal',
    domain: 'ground',
    x: Math.round((TOWER.col + 1) * FP + 8 * FP * Math.sin(a)),
    y: Math.round((TOWER.row + 1) * FP - 8 * FP * Math.cos(a)),
    hpFrac: 1,
    slowed: false,
    poisoned: false,
    stunned: false,
    warded: false,
    boss: false,
  };
};

/** Set the harness's scene and wait out the frames a head takes to settle on its bearing. */
async function show(page: Page, towers: TowerVM[], creeps: CreepVM[]): Promise<void> {
  const from = await page.evaluate(
    ([t, c]) => {
      const h = (window as unknown as { __wyTurnedHeads: Harness }).__wyTurnedHeads;
      h.towers = t;
      h.creeps = c;
      return h.frames;
    },
    [towers, creeps] as const,
  );
  await page.waitForFunction(
    (f) => (window as unknown as { __wyTurnedHeads: Harness }).__wyTurnedHeads.frames >= f,
    from + 24,
  );
}

type Shot = { png: PNG; at: (x: number, y: number) => [number, number, number] };
async function shoot(page: Page): Promise<Shot> {
  const png = PNG.sync.read(await page.screenshot({ scale: 'device' }));
  return {
    png,
    at: (x, y) => {
      const i = (y * png.width + x) << 2;
      return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
    },
  };
}

for (const { cell, dsf } of [
  { cell: 11, dsf: 1.125 },
  { cell: 11, dsf: 1.25 },
  { cell: 10, dsf: 0.8375 },
]) {
  test(`at ${cell} px cells and a real device scale of ${dsf}, a Basic Tower's head turned toward its rim's far sides leaves every rim pixel at 3:1 or more`, async () => {
    const browser = await chromium.launch({
      args: [`--force-device-scale-factor=${dsf}`, '--window-size=400,320'],
    });
    try {
      const page = await (
        await browser.newContext({ viewport: null, deviceScaleFactor: undefined })
      ).newPage();
      await page.goto(`${HARNESS}?cell=${cell}`);
      await expect
        .poll(() => page.evaluate(() => Math.round(devicePixelRatio * 10000)))
        .toBe(Math.round(dsf * 10000));
      // The renderer sizes its cells from the board's layout box, which at some scales lands a
      // fraction of a pixel under its CSS size (at 13 px and 1.1 it gives 12 px cells): at
      // these three the board is `cell` px a cell from the page's corner.
      const box = await page.evaluate(() => {
        const r = document.getElementById('board')!.getBoundingClientRect();
        return { cssWidth: r.width, cssHeight: r.height };
      });
      const proj = createProjection({ ...GRID, ...box, dpr: 1 });
      expect([proj.cellPx, proj.originX, proj.originY]).toEqual([cell, 0, 0]);
      // The footprint in device pixels: the board sits at the page's corner, its cells start
      // at its corner (it is sized to the grid), and a sprite's corner snaps to a device pixel.
      const x0 = Math.round(TOWER.col * cell * dsf);
      const y0 = Math.round(TOWER.row * cell * dsf);
      const size = Math.round(2 * cell * dsf);
      const cx = x0 + size / 2;
      const cy = y0 + size / 2;

      // At rest (no target): the rim's own pixels, side by side.
      await show(page, [basic(0)], []);
      const rest = await shoot(page);
      const rim: { x: number; y: number; side: 'top' | 'bottom' | 'left' | 'right' }[] = [];
      for (let y = y0 - 2; y < y0 + size + 2; y++) {
        for (let x = x0 - 2; x < x0 + size + 2; x++) {
          const c = rest.at(x, y);
          if (Math.max(...c.map((v, k) => Math.abs(v - RIM[k]!))) > 1) continue;
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          const side =
            Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? 'top' : 'bottom') : dx < 0 ? 'left' : 'right';
          rim.push({ x, y, side });
        }
      }
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        expect(
          rim.filter((p) => p.side === side).length,
          `the rim's ${side} run is found at rest`,
        ).toBeGreaterThanOrEqual(size / 2);
      }

      // Turned to face each far side, square on and a few degrees either way.
      for (const [deg, side] of [
        [90, 'right'],
        [85, 'right'],
        [95, 'right'],
        [180, 'bottom'],
        [175, 'bottom'],
        [185, 'bottom'],
      ] as const) {
        await show(page, [basic(7)], [creepAt(deg)]);
        const turned = await shoot(page);
        // The head did turn: the footprint's picture changed.
        let changed = 0;
        for (let y = y0; y < y0 + size; y++) {
          for (let x = x0; x < x0 + size; x++) {
            if (turned.at(x, y).some((v, k) => v !== rest.at(x, y)[k])) changed++;
          }
        }
        expect(changed, `the head turned to ${deg}°`).toBeGreaterThan(size);
        let worst = { k: Infinity, at: '' };
        for (const p of rim.filter((q) => q.side === side)) {
          const c = turned.at(p.x, p.y);
          const k = contrastRatio(c, FLOOR);
          if (k < worst.k) worst = { k, at: `(${p.x - x0},${p.y - y0}) rgb(${c.join(',')})` };
        }
        expect(
          worst.k,
          `turned to ${deg}°, the ${side} rim's darkest pixel ${worst.at} against the floor`,
        ).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
    } finally {
      await browser.close();
    }
  });
}
