// scene.test.ts — the Phaser board renderer's DRAW LAYER, witnessed for the first time
// (M2-S5a QC round). `scene.ts` as a whole stays coverage-excluded (`mount()` needs a
// real Phaser/WebGL context no jsdom test can meaningfully drive), and it is genuinely
// exercised end-to-end by the Playwright e2e smoke — but that suite's own comment says
// axe cannot see canvas cues, so a deleted draw BRANCH (the hexagon silhouette, the
// droplet tower mark, the poisoned-pip loop) can vanish with every unit AND e2e test
// still green. `drawTowers`/`drawCreeps` (plus their `drawCrosshair`/`drawDroplet`
// helpers) were moved out of `mount()`'s closure into `./board-draw` — a Phaser-free
// module (`scene.ts` importing `Phaser` at module scope means it can never be imported
// by a plain test at all: Phaser's device/canvas-feature detection runs at import time
// and crashes even under jsdom). `projection` becomes an explicit parameter instead of
// a captured local, and the `Graphics` parameter is typed as a structural
// `GraphicsLike` instead of `Phaser.GameObjects.Graphics` — otherwise no drawing
// behaviour moved or changed. A fake `GraphicsLike` RECORDER stands in for the real
// thing below, so these tests run under plain Vitest with no Phaser/WebGL involved.

import { describe, it, expect } from 'vitest';
import { drawTowers, drawCreeps, type GraphicsLike } from './board-draw';
import { createProjection } from './projection';
import { resolvePalette } from './palette';
import type { RenderVM, RenderOverlay } from './types';

/** A minimal fake `GraphicsLike` that RECORDS every call instead of drawing anything —
 *  exactly the set of methods `drawTowers`/`drawCreeps` (and their `drawCrosshair`/
 *  `drawDroplet` helpers) actually call. Satisfies `GraphicsLike` directly — no cast
 *  needed, and (since a real `Phaser.GameObjects.Graphics` satisfies `GraphicsLike`
 *  structurally too) this is exactly the same shape the real renderer hands these
 *  functions in production. */
function fakeGraphics(): GraphicsLike & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  return {
    calls,
    fillStyle: record('fillStyle'),
    lineStyle: record('lineStyle'),
    fillRect: record('fillRect'),
    fillRoundedRect: record('fillRoundedRect'),
    strokeRoundedRect: record('strokeRoundedRect'),
    fillTriangle: record('fillTriangle'),
    fillCircle: record('fillCircle'),
    strokeCircle: record('strokeCircle'),
    fillPoints: record('fillPoints'),
    lineBetween: record('lineBetween'),
  };
}

// A 10×10 board at 100×100 CSS px (10 px/cell, dpr 1) — plenty of room for a 2×2
// footprint anywhere used below.
const PROJECTION = createProjection({ cols: 10, rows: 10, cssWidth: 100, cssHeight: 100, dpr: 1 });
const PAL = resolvePalette('default');

const EMPTY_OVERLAY: RenderOverlay = {
  ghost: null,
  selection: null,
  sparks: [],
  pendingAdds: [],
  pendingSells: [],
  colourMode: 'default',
  reducedMotion: false,
  tracers: [],
};

describe('drawCreeps — the hexagon silhouette (armored, M2-S5a)', () => {
  it('an armored creep draws fillPoints with exactly 6 points (the hexagon branch) — fails if that branch is deleted', () => {
    const g = fakeGraphics();
    drawCreeps(
      g,
      PAL,
      [{ x: 5 * 256, y: 5 * 256, hpFrac: 1, creepId: 'armored', slowed: false, poisoned: false }],
      false,
      0,
      PROJECTION,
    );
    const fillPointsCalls = g.calls.filter((c) => c.method === 'fillPoints');
    expect(fillPointsCalls).toHaveLength(1);
    const pts = fillPointsCalls[0]!.args[0] as unknown[];
    expect(pts).toHaveLength(6);
    // A non-hexagon shape (normal → triangle) must NOT hit fillPoints at all — this is
    // what would go red if the hexagon branch collapsed into the triangle fallback.
    const g2 = fakeGraphics();
    drawCreeps(
      g2,
      PAL,
      [{ x: 5 * 256, y: 5 * 256, hpFrac: 1, creepId: 'normal', slowed: false, poisoned: false }],
      false,
      0,
      PROJECTION,
    );
    expect(g2.calls.some((c) => c.method === 'fillPoints')).toBe(false);
  });
});

describe('drawCreeps — the poisoned-pip telegraph (M2-S5a)', () => {
  it('draws 3 pip fillCircles under reduced motion and 6 with motion allowed — fails if the pip loop is deleted', () => {
    const reduced = fakeGraphics();
    drawCreeps(
      reduced,
      PAL,
      [{ x: 5 * 256, y: 5 * 256, hpFrac: 1, creepId: 'normal', slowed: false, poisoned: true }],
      true, // reducedMotion
      0,
      PROJECTION,
    );
    expect(reduced.calls.filter((c) => c.method === 'fillCircle')).toHaveLength(3);

    const full = fakeGraphics();
    drawCreeps(
      full,
      PAL,
      [{ x: 5 * 256, y: 5 * 256, hpFrac: 1, creepId: 'normal', slowed: false, poisoned: true }],
      false, // motion allowed
      0,
      PROJECTION,
    );
    expect(full.calls.filter((c) => c.method === 'fillCircle')).toHaveLength(6);

    // A creep that is NOT poisoned draws zero pips at all — the branch under test only
    // fires when it should.
    const none = fakeGraphics();
    drawCreeps(
      none,
      PAL,
      [{ x: 5 * 256, y: 5 * 256, hpFrac: 1, creepId: 'normal', slowed: false, poisoned: false }],
      false,
      0,
      PROJECTION,
    );
    expect(none.calls.filter((c) => c.method === 'fillCircle')).toHaveLength(0);
  });
});

describe('drawTowers — the venom droplet mark (M2-S5a)', () => {
  it('a venom tower draws its droplet mark (strokeCircle bulb + 2 converging lineBetween calls) — fails if the droplet branch is deleted', () => {
    const g = fakeGraphics();
    const vm: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'venom' }],
    };
    drawTowers(g, PAL, vm, EMPTY_OVERLAY, PROJECTION);
    // drawDroplet's own signature: one strokeCircle (the bulb) + two lineBetween calls
    // (the two lines converging above it) — distinct from `'ringed'`'s bare strokeCircle
    // (no lineBetween) and `'crosshair'`'s four lineBetween calls (no strokeCircle).
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(1);
    expect(g.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(2);

    // A `basic` tower (mark 'plain') draws neither — proves the assertions above are
    // actually keyed on the droplet branch, not just "some tower was drawn".
    const g2 = fakeGraphics();
    const vmBasic: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'basic' }],
    };
    drawTowers(g2, PAL, vmBasic, EMPTY_OVERLAY, PROJECTION);
    expect(g2.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(0);
    expect(g2.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(0);
  });
});

// The rest of `board-draw.ts`'s branches, exercised so the module (no longer
// coverage-excluded now that it lives outside `scene.ts`) clears the package's normal
// 90% branch bar — not new QC witnesses, just the remaining plain coverage.
describe('drawTowers — the remaining committed/pending marks + selection ring', () => {
  it('a slow tower draws the ringed mark: a bare strokeCircle, no lineBetween', () => {
    const g = fakeGraphics();
    const vm: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'slow' }],
    };
    drawTowers(g, PAL, vm, EMPTY_OVERLAY, PROJECTION);
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(1);
    expect(g.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(0);
  });

  it('a splash tower draws the crosshair mark: 4 lineBetween calls, no strokeCircle', () => {
    const g = fakeGraphics();
    const vm: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'splash' }],
    };
    drawTowers(g, PAL, vm, EMPTY_OVERLAY, PROJECTION);
    expect(g.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(4);
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(0);
  });

  it('a committed tower whose sell is pending is hidden entirely', () => {
    const g = fakeGraphics();
    const vm: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'basic' }],
    };
    const overlay: RenderOverlay = { ...EMPTY_OVERLAY, pendingSells: [{ col: 2, row: 2 }] };
    drawTowers(g, PAL, vm, overlay, PROJECTION);
    expect(g.calls.filter((c) => c.method === 'fillRoundedRect')).toHaveLength(0);
  });

  it('a pending (queued, not yet committed) build draws its own footprint mark: ringed, crosshair, and droplet', () => {
    for (const [towerId, expectStroke, expectLines] of [
      ['slow', 1, 0],
      ['splash', 0, 4],
      ['venom', 1, 2],
    ] as const) {
      const g = fakeGraphics();
      const vm: RenderVM = { tick: 0, phase: 'running', creeps: [], towers: [] };
      const overlay: RenderOverlay = {
        ...EMPTY_OVERLAY,
        pendingAdds: [{ col: 2, row: 2, towerId }],
      };
      drawTowers(g, PAL, vm, overlay, PROJECTION);
      expect(g.calls.filter((c) => c.method === 'strokeRoundedRect')).toHaveLength(1);
      expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(expectStroke);
      expect(g.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(expectLines);
    }
  });

  it('a selected tower draws the range-ring strokeCircle', () => {
    const g = fakeGraphics();
    const vm: RenderVM = { tick: 0, phase: 'running', creeps: [], towers: [] };
    const overlay: RenderOverlay = {
      ...EMPTY_OVERLAY,
      selection: { col: 2, row: 2, rangeFp: 512, towerId: 'basic' },
    };
    drawTowers(g, PAL, vm, overlay, PROJECTION);
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(1);
  });
});

describe('drawCreeps — the remaining silhouette shapes + slowed telegraph', () => {
  it('a fast creep draws the diamond (2 fillTriangle calls); a swarm creep draws the square (fillRect); an unknown id falls back to a single triangle', () => {
    const diamond = fakeGraphics();
    drawCreeps(
      diamond,
      PAL,
      [{ x: 5 * 256, y: 5 * 256, hpFrac: 1, creepId: 'fast', slowed: false, poisoned: false }],
      false,
      0,
      PROJECTION,
    );
    expect(diamond.calls.filter((c) => c.method === 'fillTriangle')).toHaveLength(2);

    const square = fakeGraphics();
    drawCreeps(
      square,
      PAL,
      [{ x: 5 * 256, y: 5 * 256, hpFrac: 1, creepId: 'swarm', slowed: false, poisoned: false }],
      false,
      0,
      PROJECTION,
    );
    // One fillRect for the square silhouette + one for the HP pip.
    expect(square.calls.filter((c) => c.method === 'fillRect')).toHaveLength(2);

    const fallback = fakeGraphics();
    drawCreeps(
      fallback,
      PAL,
      [
        {
          x: 5 * 256,
          y: 5 * 256,
          hpFrac: 1,
          creepId: 'unknown-id',
          slowed: false,
          poisoned: false,
        },
      ],
      false,
      0,
      PROJECTION,
    );
    expect(fallback.calls.filter((c) => c.method === 'fillTriangle')).toHaveLength(1);
  });

  it('a low-hp creep switches the silhouette/pip colour (hpColour branch)', () => {
    const g = fakeGraphics();
    drawCreeps(
      g,
      PAL,
      [{ x: 5 * 256, y: 5 * 256, hpFrac: 0.1, creepId: 'normal', slowed: false, poisoned: false }],
      false,
      0,
      PROJECTION,
    );
    const fillStyleCalls = g.calls.filter((c) => c.method === 'fillStyle');
    expect(fillStyleCalls[0]!.args[0]).toBe(PAL.creepLowHp);
  });

  it('a slowed creep draws the ring (always) + pulse (motion allowed) or just the ring (reduced motion)', () => {
    const full = fakeGraphics();
    drawCreeps(
      full,
      PAL,
      [{ x: 5 * 256, y: 5 * 256, hpFrac: 1, creepId: 'normal', slowed: true, poisoned: false }],
      false,
      0,
      PROJECTION,
    );
    expect(full.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(2); // ring + pulse

    const reduced = fakeGraphics();
    drawCreeps(
      reduced,
      PAL,
      [{ x: 5 * 256, y: 5 * 256, hpFrac: 1, creepId: 'normal', slowed: true, poisoned: false }],
      true,
      0,
      PROJECTION,
    );
    expect(reduced.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(1); // ring only
  });
});
