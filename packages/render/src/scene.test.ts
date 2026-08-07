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
import { drawTowers, drawCreeps, SPARKLE_STROKE_PX, type GraphicsLike } from './board-draw';
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
          domain: 'ground',
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
          domain: 'ground',
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
          domain: 'ground',
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
          domain: 'ground',
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
          domain: 'ground',
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
          domain: 'ground',
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
      towers: [{ id: 1, col: 2, row: 2, towerId: 'venom', support: false, buffed: false }],
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
      towers: [{ id: 1, col: 2, row: 2, towerId: 'basic', support: false, buffed: false }],
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
      towers: [{ id: 1, col: 2, row: 2, towerId: 'stun', support: false, buffed: false }],
    };
    drawTowers(g, PAL, vm, EMPTY_OVERLAY, PROJECTION);
    // The bolt's 3-segment zigzag is 3 `lineBetween` calls — distinct from `'crosshair'`'s
    // 4 (radiating spokes) and `'droplet'`'s 2 (converging lines) + 1 strokeCircle.
    expect(g.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(3);
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(0);
  });
});

describe('drawTowers — the antiair arrow mark (M2-S7)', () => {
  it('an antiair tower draws its arrow mark (3 lineBetween calls incl. a vertical shaft, no strokeCircle) — fails if the arrow branch is deleted, and is not conflated with basic or with the airborne creep cue', () => {
    const g = fakeGraphics();
    const vm: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'antiair', support: false, buffed: false }],
    };
    drawTowers(g, PAL, vm, EMPTY_OVERLAY, PROJECTION);
    // The arrow is 3 `lineBetween` calls — distinct from `'crosshair'`'s 4 (radiating
    // spokes). `'bolt'`'s zigzag is also 3, so the count alone would not key on this
    // branch: exactly one of the three strokes is VERTICAL (the shaft), which the bolt's
    // staggered polyline never is.
    const lines = g.calls.filter((c) => c.method === 'lineBetween');
    expect(lines).toHaveLength(3);
    expect(lines.filter((c) => c.args[0] === c.args[2])).toHaveLength(1);
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(0);

    // A `basic` tower (mark 'plain') draws neither — proves the assertions above are
    // actually keyed on the arrow branch, not just "some tower was drawn".
    const g2 = fakeGraphics();
    const vmBasic: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'basic', support: false, buffed: false }],
    };
    drawTowers(g2, PAL, vmBasic, EMPTY_OVERLAY, PROJECTION);
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
      towers: [{ id: 1, col: 2, row: 2, towerId: 'slow', support: false, buffed: false }],
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
      towers: [{ id: 1, col: 2, row: 2, towerId: 'splash', support: false, buffed: false }],
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
      towers: [{ id: 1, col: 2, row: 2, towerId: 'basic', support: false, buffed: false }],
    };
    const overlay: RenderOverlay = { ...EMPTY_OVERLAY, pendingSells: [{ col: 2, row: 2 }] };
    drawTowers(g, PAL, vm, overlay, PROJECTION);
    expect(g.calls.filter((c) => c.method === 'fillRoundedRect')).toHaveLength(0);
  });

  it('a pending (queued, not yet committed) build draws its own footprint mark: ringed, crosshair, droplet, bolt, and arrow', () => {
    for (const [towerId, expectStroke, expectLines] of [
      ['slow', 1, 0],
      ['splash', 0, 4],
      ['venom', 1, 2],
      ['stun', 0, 3],
      ['antiair', 0, 3],
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

  // M2-S8 — the beacon's two aura cues, plus the recipient mark.
  it('a beacon draws its pylon mark AND the adjacency shell (a rounded RECT, never a second circle)', () => {
    const g = fakeGraphics();
    const vm: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'beacon', support: true, buffed: false }],
    };
    drawTowers(g, PAL, vm, EMPTY_OVERLAY, PROJECTION);
    // The shell is the ONLY strokeRoundedRect here (a committed tower's body is FILLED,
    // `fillRoundedRect`), and there is NO strokeCircle: drawing the aura as a second
    // concentric circle on a footprint is the ambiguity Codex R1-15 rejected, and the
    // buff rule is a square edge-share a circle would misdraw regardless.
    expect(g.calls.filter((c) => c.method === 'strokeRoundedRect')).toHaveLength(1);
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(0);
    // drawPylon's own signature: mast + crossbar + base = three lineBetween calls.
    expect(g.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(3);
  });

  it('a buffed recipient draws the four-stroke ✦ on top of its own footprint mark', () => {
    const plain = fakeGraphics();
    const vmPlain: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'basic', support: false, buffed: false }],
    };
    drawTowers(plain, PAL, vmPlain, EMPTY_OVERLAY, PROJECTION);
    // `basic`'s mark is `'plain'` — no strokes at all — so the ✦'s four are unambiguous.
    expect(plain.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(0);

    const buffed = fakeGraphics();
    const vmBuffed: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'basic', support: false, buffed: true }],
    };
    drawTowers(buffed, PAL, vmBuffed, EMPTY_OVERLAY, PROJECTION);
    expect(buffed.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(4);
    // No shell — this tower receives an aura, it does not project one.
    expect(buffed.calls.filter((c) => c.method === 'strokeRoundedRect')).toHaveLength(0);
  });

  it('the buffed ✦ stays inside the tower body at the SMALLEST supported cell (M2-S8)', () => {
    // The ✦ strokes `pal.floor` over the solid `pal.tower` fill, so any part of it that
    // lands outside the body renders floor-on-floor and is simply not there. Containment
    // is therefore a correctness property, not polish — and it BINDS at the narrow floor,
    // where the 6px corner radius eats most of a 16px-wide body.
    //
    // MEASURED FROM THE ACTUAL DRAW CALLS, not re-derived from the constants. An earlier
    // version of this test recomputed the tip set from `SPARKLE_*_FRAC` plus a local copy
    // of `drawSparkle`'s `r * 0.45` arm ratio and never invoked `drawTowers` at all, so it
    // pinned the two constants and nothing else: change the arm ratio, the tip formula, or
    // add a fifth stroke, and the mark could clip while the test stayed green. This file
    // has already shipped that failure once (a centreline-only version passed while the
    // stroke clipped), which is why it now reads the endpoints the renderer really emits.
    expect(PROJECTION.cellPx).toBe(10); // apps/web/e2e/compact.spec.ts's 568×320 floor
    const g = fakeGraphics();
    const vm: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      // `basic`'s footprint mark is `'plain'` — no strokes of its own — so every
      // `lineBetween` below belongs to the ✦.
      towers: [{ id: 1, col: 2, row: 2, towerId: 'basic', support: false, buffed: true }],
    };
    drawTowers(g, PAL, vm, EMPTY_OVERLAY, PROJECTION);

    const RADIUS = 6; // the body's corner radius, `fillRoundedRect(..., 6)`
    const inset = 2; // the body's inset, `p + 2` / `size - 4`
    const span = PROJECTION.cellPx * 2 - inset * 2;
    // The mark is STROKED, so each endpoint carries half the line width beyond the
    // centreline and it is the outer edge that must clear the body.
    const halfStroke = SPARKLE_STROKE_PX / 2;
    const origin = PROJECTION.cellToPixel(2, 2);
    /** Is `(x, y)` — absolute pixels — inside the body by at least `halfStroke`? */
    const insideBody = (x: number, y: number): boolean => {
      const lx = x - origin.x;
      const ly = y - origin.y;
      const cx = Math.min(Math.max(lx, inset + RADIUS), inset + span - RADIUS);
      const cy = Math.min(Math.max(ly, inset + RADIUS), inset + span - RADIUS);
      return (lx - cx) ** 2 + (ly - cy) ** 2 <= (RADIUS - halfStroke) ** 2 + 1e-9;
    };

    const strokes = g.calls.filter((c) => c.method === 'lineBetween');
    expect(strokes).toHaveLength(4); // the ✦ drew at all — guards a vacuous pass below
    for (const call of strokes) {
      const [x0, y0, x1, y1] = call.args as number[];
      expect(insideBody(x0!, y0!)).toBe(true);
      expect(insideBody(x1!, y1!)).toBe(true);
    }
    // ... and the whole mark stays inside the footprint's TOP-LEFT CELL, so it never
    // reaches the footprint centre where every `TowerFootprintMark` is anchored. This is
    // the real, tested property — deliberately NOT "the two marks never touch", which is
    // false: a `size * 0.22` mark reaches 0.56 × cell and `'bolt'` spans the whole
    // footprint by design. Overlap at the narrow floor is a recorded legibility residual.
    for (const call of strokes) {
      for (const [x, y] of [
        [call.args[0], call.args[1]],
        [call.args[2], call.args[3]],
      ] as [number, number][]) {
        expect(x - origin.x + halfStroke).toBeLessThanOrEqual(PROJECTION.cellPx);
        expect(y - origin.y + halfStroke).toBeLessThanOrEqual(PROJECTION.cellPx);
      }
    }
  });

  it('draws every aura shell BEFORE any tower body, so the result is build-order independent', () => {
    // The shell's edge lands exactly on the boundary between an edge-adjacent recipient's
    // two footprint columns — down the middle of the tower it points at. Drawn inside the
    // body loop, whether that segment survived depended on SoA (placement) order. These
    // two view-models are the same board built in opposite orders; the call SEQUENCE must
    // match, not merely the call counts.
    const beacon = { id: 1, col: 2, row: 2, towerId: 'beacon', support: true, buffed: false };
    const basic = { id: 2, col: 4, row: 2, towerId: 'basic', support: false, buffed: true };
    const methodsFor = (towers: RenderVM['towers']): string[] => {
      const g = fakeGraphics();
      drawTowers(
        g,
        PAL,
        { tick: 0, phase: 'running', creeps: [], towers },
        EMPTY_OVERLAY,
        PROJECTION,
      );
      return g.calls.map((call) => call.method);
    };
    // The property is NOT that the two call sequences are identical — each tower draws
    // its own marks, and `beacon`'s pylon (3 strokes) and the recipient's ✦ (4) legitimately
    // swap places with the towers. What must hold in BOTH orders is the layering: every
    // shell is stroked before any body is filled, so a body can never be painted under a
    // shell in one build order and over it in the other.
    for (const methods of [methodsFor([beacon, basic]), methodsFor([basic, beacon])]) {
      const lastShell = methods.lastIndexOf('strokeRoundedRect');
      const firstBody = methods.indexOf('fillRoundedRect');
      expect(lastShell).toBeGreaterThanOrEqual(0); // the shell was drawn at all
      expect(firstBody).toBeGreaterThanOrEqual(0); // ... and so was a body
      expect(lastShell).toBeLessThan(firstBody);
    }
  });

  it('a pending-sold tower is hidden from BOTH passes — no body and no shell (M2-S8)', () => {
    // The two-pass split has to honour the pending-sell skip in each pass independently;
    // hoisting the shells out of the body loop is exactly the kind of change that drops a
    // guard on one side. A sold beacon must take its shell with it.
    const g = fakeGraphics();
    const vm: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'beacon', support: true, buffed: false }],
    };
    drawTowers(g, PAL, vm, { ...EMPTY_OVERLAY, pendingSells: [{ col: 2, row: 2 }] }, PROJECTION);
    expect(g.calls.filter((c) => c.method === 'fillRoundedRect')).toHaveLength(0);
    expect(g.calls.filter((c) => c.method === 'strokeRoundedRect')).toHaveLength(0);
  });

  it('a selected ATTACKLESS tower draws no range ring at all (M2-S8)', () => {
    const g = fakeGraphics();
    const vm: RenderVM = { tick: 0, phase: 'running', creeps: [], towers: [] };
    const overlay: RenderOverlay = {
      ...EMPTY_OVERLAY,
      selection: { col: 2, row: 2, rangeFp: null, blastRadiusFp: null, towerId: 'beacon' },
    };
    drawTowers(g, PAL, vm, overlay, PROJECTION);
    // No ring — but NOT nothing. The range ring is the only board-side rendering of
    // `selection`, so an empty branch would leave a selected beacon indistinguishable
    // from an unselected one, and Sell would act on a tower the board never identified.
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(0);
    const outlines = g.calls.filter((c) => c.method === 'strokeRoundedRect');
    expect(outlines).toHaveLength(1);
    // ... and it must sit OUTSIDE the body rect, not on it. A stroke is centred on its
    // path, so tracing the body's own `p + 2 / size - 4` geometry would bury the inner
    // half of the line in the `pal.tower` fill it cannot contrast against. Asserted
    // against the body's own inset rather than a bare number.
    const BODY_INSET = 2; // `drawTowers`' own `fillRoundedRect(p + 2, size - 4)`
    const origin = PROJECTION.cellToPixel(2, 2);
    const [x, y, w, h] = outlines[0]!.args as number[];
    expect(x! - origin.x).toBeLessThan(BODY_INSET);
    expect(y! - origin.y).toBeLessThan(BODY_INSET);
    expect(w).toBeGreaterThan(PROJECTION.cellPx * 2 - BODY_INSET * 2);
    expect(h).toBeGreaterThan(PROJECTION.cellPx * 2 - BODY_INSET * 2);
  });

  it('a selected tower draws the range-ring strokeCircle', () => {
    const g = fakeGraphics();
    const vm: RenderVM = { tick: 0, phase: 'running', creeps: [], towers: [] };
    const overlay: RenderOverlay = {
      ...EMPTY_OVERLAY,
      selection: { col: 2, row: 2, rangeFp: 512, blastRadiusFp: null, towerId: 'basic' },
    };
    drawTowers(g, PAL, vm, overlay, PROJECTION);
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(1);
  });

  it('a mine tower draws its charge mark: a single fillCircle, no strokeCircle/lineBetween — and no other tower draws fillCircle', () => {
    const g = fakeGraphics();
    const vm: RenderVM = {
      tick: 0,
      phase: 'running',
      creeps: [],
      towers: [{ id: 1, col: 2, row: 2, towerId: 'mine', support: false, buffed: false }],
    };
    drawTowers(g, PAL, vm, EMPTY_OVERLAY, PROJECTION);
    // `'charge'` is the only FILLED mark in the vocabulary — a fillCircle, not a
    // strokeCircle (`'ringed'`) or any lineBetween-built shape.
    expect(g.calls.filter((c) => c.method === 'fillCircle')).toHaveLength(1);
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(0);
    expect(g.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(0);

    // No other shipped tower draws a fillCircle for its footprint mark — proves the
    // fillCircle above is `'charge'`-specific, not a shared side effect of drawing a body.
    for (const towerId of ['basic', 'slow', 'splash', 'venom', 'stun', 'antiair', 'beacon']) {
      const g2 = fakeGraphics();
      drawTowers(
        g2,
        PAL,
        {
          tick: 0,
          phase: 'running',
          creeps: [],
          towers: [
            { id: 1, col: 2, row: 2, towerId, support: towerId === 'beacon', buffed: false },
          ],
        },
        EMPTY_OVERLAY,
        PROJECTION,
      );
      expect(g2.calls.filter((c) => c.method === 'fillCircle')).toHaveLength(0);
    }
  });

  it('a pending (queued) mine draws its charge mark as a fillCircle too', () => {
    const g = fakeGraphics();
    const vm: RenderVM = { tick: 0, phase: 'running', creeps: [], towers: [] };
    const overlay: RenderOverlay = {
      ...EMPTY_OVERLAY,
      pendingAdds: [{ col: 2, row: 2, towerId: 'mine' }],
    };
    drawTowers(g, PAL, vm, overlay, PROJECTION);
    expect(g.calls.filter((c) => c.method === 'fillCircle')).toHaveLength(1);
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(0);
  });

  it('a selected mine draws the range ring PLUS its blast spokes — the blast reaches past the ring', () => {
    const g = fakeGraphics();
    const vm: RenderVM = { tick: 0, phase: 'running', creeps: [], towers: [] };
    // Mine-shaped numbers: rangeFp 576 (trigger, 2.25 tiles), blastRadiusFp 640 (blast,
    // 2.5 tiles) — the case that forced the cue to exist at all.
    const overlay: RenderOverlay = {
      ...EMPTY_OVERLAY,
      selection: { col: 2, row: 2, rangeFp: 576, blastRadiusFp: 640, towerId: 'mine' },
    };
    drawTowers(g, PAL, vm, overlay, PROJECTION);
    // The range ring itself (1 strokeCircle) PLUS the crosshair spokes (4 lineBetween).
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(1);
    expect(g.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(4);
  });

  it('a selected splash-shaped tower ALSO draws its blast spokes, matching the ghost preview (Rob, 2026-08-07)', () => {
    const g = fakeGraphics();
    const vm: RenderVM = { tick: 0, phase: 'running', creeps: [], towers: [] };
    // splash-shaped numbers: rangeFp 4 tiles' worth, blastRadiusFp 1.5 tiles' worth — the
    // blast sits INSIDE the range. M2-S9 first shipped a gate that suppressed the spokes
    // in exactly this case so only `mine` drew them; the consequence was that arming a
    // `splash` previewed spokes and selecting that same `splash` showed none. Ruled the
    // other way: selection matches the ghost, so this case draws them. Flipping this back
    // to `toHaveLength(0)` is what a re-narrowed gate would look like.
    const overlay: RenderOverlay = {
      ...EMPTY_OVERLAY,
      selection: { col: 2, row: 2, rangeFp: 1024, blastRadiusFp: 384, towerId: 'splash' },
    };
    drawTowers(g, PAL, vm, overlay, PROJECTION);
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(1);
    expect(g.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(4);
  });

  // The remaining negative control, and now the only one: a tower with no blast draws no
  // spokes. (The splash case above used to serve as the data-vs-id control; with the gate
  // reduced to "has a blast at all" there is no id/data distinction left to prove, so
  // `blastRadiusFp === null` is what keeps `drawCrosshair` from being unconditional.)
  it('a selected tower with no blast at all draws no spokes (blastRadiusFp null)', () => {
    const g = fakeGraphics();
    const vm: RenderVM = { tick: 0, phase: 'running', creeps: [], towers: [] };
    const overlay: RenderOverlay = {
      ...EMPTY_OVERLAY,
      selection: { col: 2, row: 2, rangeFp: 512, blastRadiusFp: null, towerId: 'basic' },
    };
    drawTowers(g, PAL, vm, overlay, PROJECTION);
    expect(g.calls.filter((c) => c.method === 'strokeCircle')).toHaveLength(1);
    expect(g.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(0);
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
          domain: 'ground',
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
          domain: 'ground',
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
          domain: 'ground',
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
          domain: 'ground',
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
          domain: 'ground',
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
          domain: 'ground',
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
      domain: 'ground' as const,
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
      domain: 'ground' as const,
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

  it("an air creep's wingspan COMPOSES over the base silhouette (M2-S7) — both draw, regardless of reducedMotion (not a timed status)", () => {
    // `armored` (hexagon, 6-point fillPoints) rather than `normal`, so this proves the
    // airborne cue doesn't merely coexist with the DEFAULT triangle — it composes with
    // whatever base shape the id already draws, exactly the armored-flyer (S10)
    // requirement PLAN.md calls out.
    const creep = (domain: 'ground' | 'air') => ({
      x: 5 * 256,
      y: 5 * 256,
      hpFrac: 1,
      creepId: 'armored',
      domain,
      slowed: false,
      poisoned: false,
      stunned: false,
      warded: false,
    });
    const air = fakeGraphics();
    drawCreeps(air, PAL, [creep('air')], false, 0, PROJECTION);
    const fillPointsCalls = air.calls.filter((c) => c.method === 'fillPoints');
    expect(fillPointsCalls).toHaveLength(1); // the hexagon silhouette — still drawn
    expect((fillPointsCalls[0]!.args[0] as unknown[]).length).toBe(6);
    // The wingspan is 2 `lineBetween` calls (apex→left, apex→right) — ADDITIONAL to
    // the silhouette, never a replacement for it.
    expect(air.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(2);

    // Reduced motion changes nothing — the airborne cue carries no motion component.
    const reduced = fakeGraphics();
    drawCreeps(reduced, PAL, [creep('air')], true, 0, PROJECTION);
    expect(reduced.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(2);

    // A ground creep of the same id draws the hexagon with no wingspan at all.
    const ground = fakeGraphics();
    drawCreeps(ground, PAL, [creep('ground')], false, 0, PROJECTION);
    expect(ground.calls.filter((c) => c.method === 'fillPoints')).toHaveLength(1);
    expect(ground.calls.filter((c) => c.method === 'lineBetween')).toHaveLength(0);
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
    domain: 'ground' as const,
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
    domain: 'ground' as const,
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
