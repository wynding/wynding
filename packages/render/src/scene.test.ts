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
      [
        {
          x: 5 * 256,
          y: 5 * 256,
          hpFrac: 1,
          creepId: 'armored',
          slowed: false,
          poisoned: false,
          stunned: false,
          warded: false,
        },
      ],
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
      [
        {
          x: 5 * 256,
          y: 5 * 256,
          hpFrac: 1,
          creepId: 'normal',
          slowed: false,
          poisoned: false,
          stunned: false,
          warded: false,
        },
      ],
      false,
      0,
      PROJECTION,
    );
    expect(g2.calls.some((c) => c.method === 'fillPoints')).toBe(false);
  });
});

describe('drawCreeps — the pentagon silhouette (resolute, M2-S6)', () => {
  it('a resolute creep draws fillPoints with exactly 5 points (the pentagon branch) — fails if that branch is deleted', () => {
    const g = fakeGraphics();
    drawCreeps(
      g,
      PAL,
      [
        {
          x: 5 * 256,
          y: 5 * 256,
          hpFrac: 1,
          creepId: 'resolute',
          slowed: false,
          poisoned: false,
          stunned: false,
          warded: false,
        },
      ],
      false,
      0,
      PROJECTION,
    );
    const fillPointsCalls = g.calls.filter((c) => c.method === 'fillPoints');
    expect(fillPointsCalls).toHaveLength(1);
    const pts = fillPointsCalls[0]!.args[0] as unknown[];
    expect(pts).toHaveLength(5);
  });
});

describe('drawCreeps — the poisoned-pip telegraph (M2-S5a)', () => {
  it('draws 3 pip fillCircles under reduced motion and 6 with motion allowed — fails if the pip loop is deleted', () => {
    const reduced = fakeGraphics();
    drawCreeps(
      reduced,
      PAL,
      [
        {
          x: 5 * 256,
          y: 5 * 256,
          hpFrac: 1,
          creepId: 'normal',
          slowed: false,
          poisoned: true,
          stunned: false,
          warded: false,
        },
      ],
      true, // reducedMotion
      0,
      PROJECTION,
    );
    expect(reduced.calls.filter((c) => c.method === 'fillCircle')).toHaveLength(3);

    const full = fakeGraphics();
    drawCreeps(
      full,
      PAL,
      [
        {
          x: 5 * 256,
          y: 5 * 256,
          hpFrac: 1,
          creepId: 'normal',
          slowed: false,
          poisoned: true,
          stunned: false,
          warded: false,
        },
      ],
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
      [
        {
          x: 5 * 256,
          y: 5 * 256,
          hpFrac: 1,
          creepId: 'normal',
          slowed: false,
          poisoned: false,
          stunned: false,
          warded: false,
        },
      ],
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

describe('drawTowers — the stun bolt mark (M2-S6)', () => {
  it('a stun tower draws its bolt mark (3 lineBetween calls, no strokeCircle) — fails if the bolt branch is deleted', () => {
    const g = fakeGraphics();
    const vm: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'stun' }],
    };
    drawTowers(g, PAL, vm, EMPTY_OVERLAY, PROJECTION);
    // The bolt's 3-segment zigzag is 3 `lineBetween` calls — distinct from `'crosshair'`'s
    // 4 (radiating spokes) and `'droplet'`'s 2 (converging lines) + 1 strokeCircle.
    expect(g.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(3);
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(0);
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

  it('a pending (queued, not yet committed) build draws its own footprint mark: ringed, crosshair, droplet, and bolt', () => {
    for (const [towerId, expectStroke, expectLines] of [
      ['slow', 1, 0],
      ['splash', 0, 4],
      ['venom', 1, 2],
      ['stun', 0, 3],
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
      [
        {
          x: 5 * 256,
          y: 5 * 256,
          hpFrac: 1,
          creepId: 'fast',
          slowed: false,
          poisoned: false,
          stunned: false,
          warded: false,
        },
      ],
      false,
      0,
      PROJECTION,
    );
    expect(diamond.calls.filter((c) => c.method === 'fillTriangle')).toHaveLength(2);

    const square = fakeGraphics();
    drawCreeps(
      square,
      PAL,
      [
        {
          x: 5 * 256,
          y: 5 * 256,
          hpFrac: 1,
          creepId: 'swarm',
          slowed: false,
          poisoned: false,
          stunned: false,
          warded: false,
        },
      ],
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
          stunned: false,
          warded: false,
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
      [
        {
          x: 5 * 256,
          y: 5 * 256,
          hpFrac: 0.1,
          creepId: 'normal',
          slowed: false,
          poisoned: false,
          stunned: false,
          warded: false,
        },
      ],
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
      [
        {
          x: 5 * 256,
          y: 5 * 256,
          hpFrac: 1,
          creepId: 'normal',
          slowed: true,
          poisoned: false,
          stunned: false,
          warded: false,
        },
      ],
      false,
      0,
      PROJECTION,
    );
    expect(full.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(2); // ring + pulse

    const reduced = fakeGraphics();
    drawCreeps(
      reduced,
      PAL,
      [
        {
          x: 5 * 256,
          y: 5 * 256,
          hpFrac: 1,
          creepId: 'normal',
          slowed: true,
          poisoned: false,
          stunned: false,
          warded: false,
        },
      ],
      true,
      0,
      PROJECTION,
    );
    expect(reduced.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(1); // ring only
  });

  it('a stunned creep draws the jolt (always) + flicker (motion allowed) or just the jolt (reduced motion)', () => {
    const creep = (stunned: boolean) => ({
      x: 5 * 256,
      y: 5 * 256,
      hpFrac: 1,
      creepId: 'normal',
      slowed: false,
      poisoned: false,
      stunned,
      warded: false,
    });
    const full = fakeGraphics();
    drawCreeps(full, PAL, [creep(true)], false, 0, PROJECTION);
    expect(full.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(2); // jolt + flicker

    const reduced = fakeGraphics();
    drawCreeps(reduced, PAL, [creep(true)], true, 0, PROJECTION);
    expect(reduced.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(1); // jolt only

    const none = fakeGraphics();
    drawCreeps(none, PAL, [creep(false)], false, 0, PROJECTION);
    expect(none.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(0);
  });

  it('a warded creep draws a single opaque ring, regardless of reducedMotion (not a timed status)', () => {
    const creep = (warded: boolean) => ({
      x: 5 * 256,
      y: 5 * 256,
      hpFrac: 1,
      creepId: 'normal',
      slowed: false,
      poisoned: false,
      stunned: false,
      warded,
    });
    const full = fakeGraphics();
    drawCreeps(full, PAL, [creep(true)], false, 0, PROJECTION);
    expect(full.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(1);

    const reduced = fakeGraphics();
    drawCreeps(reduced, PAL, [creep(true)], true, 0, PROJECTION);
    expect(reduced.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(1); // unchanged

    const none = fakeGraphics();
    drawCreeps(none, PAL, [creep(false)], false, 0, PROJECTION);
    expect(none.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(0);
  });
});

// The regression Codex caught on PR #78. `CreepVM.x`/`y` are FIXED-POINT sim units (256
// per cell); the silhouette projects them, but both telegraph plans were handed the raw
// creep, so their cues drew ~256x away from the visible creep — off-canvas. The slowed
// telegraph carried this from M2-S3 and had therefore never rendered at all; the DoT
// telegraph inherited it. These assert the cues land ON the projected centre, so passing
// the raw creep again fails immediately.
describe('drawCreeps — both telegraphs draw at the PROJECTED centre, not fixed-point (PR #78)', () => {
  const CREEP = {
    x: 5 * 256,
    y: 5 * 256,
    hpFrac: 1,
    creepId: 'normal',
    slowed: true,
    poisoned: true,
    stunned: false,
    warded: false,
  };

  it('the slowed ring and the poison pips are centred within a cell of the silhouette', () => {
    const g = fakeGraphics();
    drawCreeps(g, PAL, [CREEP], true, 0, PROJECTION);
    const p = PROJECTION.fpToPixel(CREEP.x, CREEP.y);
    // Sanity: the projection must actually MOVE the point, or this test proves nothing.
    expect(Math.hypot(p.x - CREEP.x, p.y - CREEP.y)).toBeGreaterThan(PROJECTION.cellPx);

    const ring = g.calls.find((c) => c.method === 'strokeCircle');
    expect(ring).toBeDefined();
    const [rx, ry] = ring!.args as [number, number, number];
    expect(Math.hypot(rx - p.x, ry - p.y)).toBeLessThan(PROJECTION.cellPx);

    const pips = g.calls.filter((c) => c.method === 'fillCircle');
    expect(pips.length).toBeGreaterThan(0);
    for (const pip of pips) {
      const [px, py] = pip.args as [number, number, number];
      // Pips sit at r*1.8 from centre, well inside one cell at this scale.
      expect(Math.hypot(px - p.x, py - p.y)).toBeLessThan(PROJECTION.cellPx * 2);
    }
  });

  // M2-S6: the same PR #78 mistake, guarded for the two NEW telegraphs. Isolated from
  // `CREEP` above (slowed/poisoned false here) so the strokeCircle calls this test reads
  // are unambiguously the stun/ward cues, not the slow ring.
  const STUN_WARD_CREEP = {
    x: 5 * 256,
    y: 5 * 256,
    hpFrac: 1,
    creepId: 'normal',
    slowed: false,
    poisoned: false,
    stunned: true,
    warded: true,
  };

  it('the stun jolt and the ward ring are centred EXACTLY on the projected silhouette centre', () => {
    const g = fakeGraphics();
    drawCreeps(g, PAL, [STUN_WARD_CREEP], true, 0, PROJECTION);
    const p = PROJECTION.fpToPixel(STUN_WARD_CREEP.x, STUN_WARD_CREEP.y);
    expect(Math.hypot(p.x - STUN_WARD_CREEP.x, p.y - STUN_WARD_CREEP.y)).toBeGreaterThan(
      PROJECTION.cellPx,
    );

    // Reduced motion drops the flicker, so exactly 2 strokeCircle calls remain: jolt,
    // then ward (board-draw's draw order) — both must land on the projected centre.
    const strokes = g.calls.filter((c) => c.method === 'strokeCircle');
    expect(strokes).toHaveLength(2);
    for (const s of strokes) {
      const [sx, sy] = s.args as [number, number, number];
      // EXACT, not a tolerance. `strokeCircle` takes its centre directly, so every one of
      // these ops must be centred on the projected point — the radius is a separate
      // argument and cannot move the centre. A distance bound (this was `< cellPx * 3`)
      // would happily accept a cue drawn a cell or two off, which is precisely the defect
      // class this test exists for: passing the raw `CreepVM` instead of the projected
      // centre silently drew these cues off-canvas for two milestones.
      expect(sx).toBe(p.x);
      expect(sy).toBe(p.y);
    }
  });
});
