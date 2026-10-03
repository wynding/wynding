// scene.test.ts — the Phaser board renderer's DRAW LAYER, witnessed (M2-S5a QC round).
// `scene.ts` as a whole stays coverage-excluded (`mount()` needs a real Phaser/WebGL
// context no jsdom test can meaningfully drive), and it is genuinely exercised end-to-end
// by the Playwright e2e smoke — but that suite's own comment says axe cannot see canvas
// cues, so a deleted draw BRANCH (the hexagon silhouette, the droplet tower mark, the
// poisoned-pip loop) could vanish with every unit AND e2e test still green. So everything
// `scene.ts` draws is drawn by Phaser-free modules, and this file drives them with a
// recording `GraphicsLike` — no Phaser import, no WebGL/canvas context.
//
// RETARGETED BY V2 (#181). Static art is baked into an atlas now, so a tower's body/mark/✦
// and a creep's silhouette are drawn by the atlas FRAME PAINTERS (`art-frames.ts`, in
// frame-local coordinates) and shown at a position the PLACEMENT functions compute
// (`placement.ts`); only shells, the selection cue and creep pips/cues are still drawn per
// frame (`drawAuraShells`, `drawSelection`, `drawCreepCues`). Every test below that used
// to record `drawTowers`/`drawCreeps` now records the same thing through that chain —
// placement picks the frame, the frame's painter draws it — with the same geometry, count
// and colour assertions it made before. A tower or creep's "whole drawing" is the frame's
// calls followed by its live calls, which is the order the layers composite them in.

import { describe, it, expect } from 'vitest';
import {
  drawAuraShells,
  drawCreepCues,
  drawSelection,
  SPARKLE_STROKE_PX,
  type GraphicsLike,
} from './board-draw';
import { atlasFrameSpecs, type FrameSpec } from './art-frames';
import { placeCreeps, placeTowers } from './placement';
import { layerDepth } from './layers';
import { createProjection } from './projection';
import { resolvePalette } from './palette';
import type { CreepVM, RenderVM, RenderOverlay, TowerVM } from './types';

type Call = { method: string; args: unknown[] };

/** A minimal fake `GraphicsLike` that RECORDS every call instead of drawing anything —
 *  exactly the set of methods the board's draw functions call. Satisfies `GraphicsLike`
 *  directly — no cast needed, and (since a real `Phaser.GameObjects.Graphics` satisfies
 *  `GraphicsLike` structurally too, and the bake's Canvas2D adapter implements it) this is
 *  the same shape every real drawing surface hands these functions. */
function fakeGraphics(): GraphicsLike & { calls: Call[] } {
  const calls: Call[] = [];
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

const count = (calls: readonly Call[], method: string): number =>
  calls.filter((c) => c.method === method).length;

// A 10×10 board at 100×100 CSS px (10 px/cell, dpr 1) — plenty of room for a 2×2
// footprint anywhere used below.
const PROJECTION = createProjection({ cols: 10, rows: 10, cssWidth: 100, cssHeight: 100, dpr: 1 });
const PAL = resolvePalette('default');

/** The atlas this projection bakes (scale = its dpr): the frames placement points at. */
const FRAMES: ReadonlyMap<string, FrameSpec> = new Map(
  atlasFrameSpecs(PROJECTION.cellPx, PROJECTION.dpr).map((f) => [f.key, f]),
);

function frameSpec(key: string): FrameSpec {
  const spec = FRAMES.get(key);
  if (spec === undefined) throw new Error(`no atlas frame ${key}`);
  return spec;
}

/** Record what the atlas frame `key` paints — frame-local coordinates. */
function paintFrame(key: string): Call[] {
  const g = fakeGraphics();
  frameSpec(key).paint(g, PAL);
  return g.calls;
}

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

const vmWith = (towers: readonly TowerVM[]): RenderVM => ({
  tick: 0,
  phase: 'running',
  creeps: [],
  towers,
});

const tower = (towerId: string, opts: Partial<TowerVM> = {}): TowerVM => ({
  id: 1,
  col: 2,
  row: 2,
  towerId,
  support: towerId === 'beacon',
  buffed: false,
  ...opts,
});

/** Everything a board of `towers` draws for them, the way the layers composite it: the live
 *  shells, then each committed tower's baked frame (as placement picks it). */
function drawnTowers(
  towers: readonly TowerVM[],
  overlay: RenderOverlay = EMPTY_OVERLAY,
): { shells: Call[]; frames: Call[][]; all: Call[] } {
  const g = fakeGraphics();
  drawAuraShells(g, PAL, vmWith(towers), overlay, PROJECTION);
  const placed = placeTowers(vmWith(towers), overlay, PROJECTION, FRAMES);
  const frames = placed.committed.map((p) => paintFrame(p.frame));
  return { shells: g.calls, frames, all: [...g.calls, ...frames.flat()] };
}

/** One committed tower's drawing (shell, if any, then its frame). */
const drawnTower = (towerId: string, opts: Partial<TowerVM> = {}): Call[] =>
  drawnTowers([tower(towerId, opts)]).all;

/** A queued build's drawing: the pending frame placement picks for it. */
function drawnPending(towerId: string): Call[] {
  const placed = placeTowers(
    vmWith([]),
    { ...EMPTY_OVERLAY, pendingAdds: [{ col: 2, row: 2, towerId }] },
    PROJECTION,
    FRAMES,
  );
  expect(placed.pending).toHaveLength(1);
  return paintFrame((placed.pending[0] as { frame: string }).frame);
}

type CreepIn = Pick<
  CreepVM,
  | 'x'
  | 'y'
  | 'hpFrac'
  | 'creepId'
  | 'domain'
  | 'slowed'
  | 'poisoned'
  | 'stunned'
  | 'warded'
  | 'boss'
>;

const creep = (opts: Partial<CreepIn> = {}): CreepIn => ({
  x: 5 * 256,
  y: 5 * 256,
  hpFrac: 1,
  creepId: 'normal',
  domain: 'ground',
  slowed: false,
  poisoned: false,
  stunned: false,
  warded: false,
  boss: false,
  ...opts,
});

/** One creep's drawing: its silhouette frame (frame-local), then its live pip + cues
 *  (board coordinates) — the creep sprite layer, then the cue layer above it. */
function drawnCreep(
  c: CreepIn,
  reducedMotion = false,
): { frame: Call[]; cues: Call[]; all: Call[] } {
  const placed = placeCreeps([c], PAL, PROJECTION, FRAMES);
  expect(placed).toHaveLength(1);
  const frame = paintFrame((placed[0] as { frame: string }).frame);
  const g = fakeGraphics();
  drawCreepCues(g, PAL, placed, reducedMotion, 0);
  return { frame, cues: g.calls, all: [...frame, ...g.calls] };
}

describe('creep silhouettes — the hexagon (armored, M2-S5a)', () => {
  it('an armored creep draws fillPoints with exactly 6 points (the hexagon branch) — fails if that branch is deleted', () => {
    const fillPointsCalls = drawnCreep(creep({ creepId: 'armored' })).all.filter(
      (c) => c.method === 'fillPoints',
    );
    expect(fillPointsCalls).toHaveLength(1);
    const pts = fillPointsCalls[0]!.args[0] as unknown[];
    expect(pts).toHaveLength(6);
    // A non-hexagon shape (normal → triangle) must NOT hit fillPoints at all — this is
    // what would go red if the hexagon branch collapsed into the triangle fallback.
    expect(
      drawnCreep(creep({ creepId: 'normal' })).all.some((c) => c.method === 'fillPoints'),
    ).toBe(false);
  });
});

describe('creep silhouettes — the boss size cue (M2-S10, ruling 2: size only, no new shape)', () => {
  it('a boss and an armored creep share the hexagon silhouette but the boss draws it at BOSS_SCALE (1.5×) — fails if BOSS_SCALE is forced to 1', () => {
    // Both `armored` and `boss` map to `'hexagon'` (creep-paint.ts) — the composability
    // proof this story exercises — so size is the ONLY channel telling them apart at the
    // silhouette itself. The hexagon's apex vertex sits at exactly `(cx, cy - r)` (angle
    // -90°, the same "apex up" convention every other polygon builder here uses), so the
    // vertical offset from the frame's centre anchor IS `r` — no trig needed to recover it
    // from the recorded `fillPoints` call.
    const armored = placeCreeps([creep({ creepId: 'armored' })], PAL, PROJECTION, FRAMES)[0]!;
    const boss = placeCreeps(
      [creep({ creepId: 'boss', warded: true, boss: true })],
      PAL,
      PROJECTION,
      FRAMES,
    )[0]!;
    const radiusOf = (frame: string): number => {
      const pts = paintFrame(frame).find((c) => c.method === 'fillPoints')!.args[0] as {
        x: number;
        y: number;
      }[];
      expect(pts).toHaveLength(6); // still the SAME shape — ruling 2, no new CreepShape
      return frameSpec(frame).anchorY - pts[0]!.y; // apex vertex: y = cy - r
    };
    const armoredR = radiusOf(armored.frame);
    const bossR = radiusOf(boss.frame);
    // The boss draws strictly larger — dies if `BOSS_SCALE` is forced to 1 (equal radii).
    expect(bossR).toBeGreaterThan(armoredR);
    // Pinned to the spec's exact multiplier, not just "bigger" — BOSS_SCALE = 1.5.
    expect(bossR).toBeCloseTo(armoredR * 1.5, 5);
    // ... and the live cues are drawn around that same radius, so they scale with it.
    expect(boss.r).toBeCloseTo(armored.r * 1.5, 5);
    expect(armored.r).toBeCloseTo(armoredR, 5);
  });
});

describe('creep silhouettes — the pentagon (resolute, M2-S6)', () => {
  it('a resolute creep draws fillPoints with exactly 5 points (the pentagon branch) — fails if that branch is deleted', () => {
    const fillPointsCalls = drawnCreep(creep({ creepId: 'resolute' })).all.filter(
      (c) => c.method === 'fillPoints',
    );
    expect(fillPointsCalls).toHaveLength(1);
    const pts = fillPointsCalls[0]!.args[0] as unknown[];
    expect(pts).toHaveLength(5);
  });
});

describe('drawCreepCues — the poisoned-pip telegraph (M2-S5a)', () => {
  it('draws 3 pip fillCircles under reduced motion and 6 with motion allowed — fails if the pip loop is deleted', () => {
    expect(count(drawnCreep(creep({ poisoned: true }), true).all, 'fillCircle')).toBe(3);
    expect(count(drawnCreep(creep({ poisoned: true }), false).all, 'fillCircle')).toBe(6);
    // A creep that is NOT poisoned draws zero pips at all — the branch under test only
    // fires when it should.
    expect(count(drawnCreep(creep({ poisoned: false }), false).all, 'fillCircle')).toBe(0);
  });
});

describe('tower frames — the venom droplet mark (M2-S5a)', () => {
  it('a venom tower draws its droplet mark (strokeCircle bulb + 2 converging lineBetween calls) — fails if the droplet branch is deleted', () => {
    const calls = drawnTower('venom');
    // drawDroplet's own signature: one strokeCircle (the bulb) + two lineBetween calls
    // (the two lines converging above it) — distinct from `'ringed'`'s bare strokeCircle
    // (no lineBetween) and `'crosshair'`'s four lineBetween calls (no strokeCircle).
    expect(count(calls, 'strokeCircle')).toBe(1);
    expect(count(calls, 'lineBetween')).toBe(2);

    // A `basic` tower (mark 'plain') draws neither — proves the assertions above are
    // actually keyed on the droplet branch, not just "some tower was drawn".
    const basic = drawnTower('basic');
    expect(count(basic, 'strokeCircle')).toBe(0);
    expect(count(basic, 'lineBetween')).toBe(0);
  });
});

describe('tower frames — the stun bolt mark (M2-S6)', () => {
  it('a stun tower draws its bolt mark (3 lineBetween calls, no strokeCircle) — fails if the bolt branch is deleted', () => {
    const calls = drawnTower('stun');
    // The bolt's 3-segment zigzag is 3 `lineBetween` calls — distinct from `'crosshair'`'s
    // 4 (radiating spokes) and `'droplet'`'s 2 (converging lines) + 1 strokeCircle.
    expect(count(calls, 'lineBetween')).toBe(3);
    expect(count(calls, 'strokeCircle')).toBe(0);
  });
});

describe('tower frames — the antiair arrow mark (M2-S7)', () => {
  it('an antiair tower draws its arrow mark (3 lineBetween calls incl. a vertical shaft, no strokeCircle) — fails if the arrow branch is deleted, and is not conflated with basic or with the airborne creep cue', () => {
    const calls = drawnTower('antiair');
    // The arrow is 3 `lineBetween` calls — distinct from `'crosshair'`'s 4 (radiating
    // spokes). `'bolt'`'s zigzag is also 3, so the count alone would not key on this
    // branch: exactly one of the three strokes is VERTICAL (the shaft), which the bolt's
    // staggered polyline never is.
    const lines = calls.filter((c) => c.method === 'lineBetween');
    expect(lines).toHaveLength(3);
    expect(lines.filter((c) => c.args[0] === c.args[2])).toHaveLength(1);
    expect(count(calls, 'strokeCircle')).toBe(0);

    // A `basic` tower (mark 'plain') draws neither — proves the assertions above are
    // actually keyed on the arrow branch, not just "some tower was drawn".
    expect(count(drawnTower('basic'), 'lineBetween')).toBe(0);
  });
});

describe('tower frames — the frost-splash ringed-crosshair mark (M2-S10)', () => {
  // TWO mark-drawing painters in `board-draw.ts` — committed (this describe) and pending
  // (below, in the shared-marks block) — and BOTH must reach the arm, or
  // `'ringed-crosshair'` is a dead value that silently draws nothing (PLAN.md P4). This
  // test pins the COMMITTED frame specifically: deleting only the pending arm must NOT turn
  // this one red (see the pending test's own comment for the inverse).
  it('a frost-splash tower (committed) draws its ringed-crosshair mark: 1 strokeCircle (the ring) + 4 lineBetween (the outward spokes) — fails if the committed arm is deleted', () => {
    const calls = drawnTower('frost-splash');
    // The ring is `'ringed'`'s own strokeCircle; the 4 spokes are `'crosshair'`'s own
    // lineBetween count — reads as BOTH parents (m2.md:299), never `'ringed'` alone (which
    // draws 0 lineBetween) or `'crosshair'` alone (which draws 0 strokeCircle).
    expect(count(calls, 'strokeCircle')).toBe(1);
    expect(count(calls, 'lineBetween')).toBe(4);
  });
});

// The rest of the tower drawing's branches, exercised so the modules clear the package's
// normal 90% branch bar — not new QC witnesses, just the remaining plain coverage.
describe('tower frames — the remaining committed/pending marks + selection ring', () => {
  it('a slow tower draws the ringed mark: a bare strokeCircle, no lineBetween', () => {
    const calls = drawnTower('slow');
    expect(count(calls, 'strokeCircle')).toBe(1);
    expect(count(calls, 'lineBetween')).toBe(0);
  });

  it('a splash tower draws the crosshair mark: 4 lineBetween calls, no strokeCircle', () => {
    const calls = drawnTower('splash');
    expect(count(calls, 'lineBetween')).toBe(4);
    expect(count(calls, 'strokeCircle')).toBe(0);
  });

  it('a committed tower whose sell is pending is hidden entirely', () => {
    const drawn = drawnTowers([tower('basic')], {
      ...EMPTY_OVERLAY,
      pendingSells: [{ col: 2, row: 2 }],
    });
    // No sprite at all — so no body (the frame is where the body is painted).
    expect(drawn.frames).toHaveLength(0);
    expect(count(drawn.all, 'fillRoundedRect')).toBe(0);
    // ... and the unsold control does draw one, so the zero above is the sell's doing.
    expect(count(drawnTower('basic'), 'fillRoundedRect')).toBe(1);
  });

  it('a pending (queued, not yet committed) build draws its own footprint mark: ringed, crosshair, droplet, bolt, arrow, and ringed-crosshair — fails if the PENDING arm of ringed-crosshair is deleted while the committed one (above) stays green (PLAN.md P4 mutation check)', () => {
    for (const [towerId, expectStroke, expectLines] of [
      ['slow', 1, 0],
      ['splash', 0, 4],
      ['venom', 1, 2],
      ['stun', 0, 3],
      ['antiair', 0, 3],
      ['frost-splash', 1, 4],
    ] as const) {
      const calls = drawnPending(towerId);
      expect(count(calls, 'strokeRoundedRect')).toBe(1);
      expect(count(calls, 'strokeCircle')).toBe(expectStroke);
      expect(count(calls, 'lineBetween')).toBe(expectLines);
    }
  });

  // M2-S8 — the beacon's two aura cues, plus the recipient mark.
  it('a beacon draws its pylon mark AND the adjacency shell (a rounded RECT, never a second circle)', () => {
    const drawn = drawnTowers([tower('beacon')]);
    // The shell is the ONLY strokeRoundedRect here (a committed tower's body is FILLED,
    // `fillRoundedRect`), and there is NO strokeCircle: drawing the aura as a second
    // concentric circle on a footprint is the ambiguity Codex R1-15 rejected, and the
    // buff rule is a square edge-share a circle would misdraw regardless.
    expect(count(drawn.all, 'strokeRoundedRect')).toBe(1);
    expect(count(drawn.shells, 'strokeRoundedRect')).toBe(1); // ... and it is the LIVE shell
    expect(count(drawn.all, 'strokeCircle')).toBe(0);
    // drawPylon's own signature: mast + crossbar + base = three lineBetween calls.
    expect(count(drawn.all, 'lineBetween')).toBe(3);
  });

  it('a buffed recipient draws the four-stroke ✦ on top of its own footprint mark', () => {
    // `basic`'s mark is `'plain'` — no strokes at all — so the ✦'s four are unambiguous.
    expect(count(drawnTower('basic', { buffed: false }), 'lineBetween')).toBe(0);
    const buffed = drawnTower('basic', { buffed: true });
    expect(count(buffed, 'lineBetween')).toBe(4);
    // No shell — this tower receives an aura, it does not project one.
    expect(count(buffed, 'strokeRoundedRect')).toBe(0);
    // The ✦ is drawn AFTER the body it sits on, inside the same frame.
    const methods = buffed.map((c) => c.method);
    expect(methods.indexOf('fillRoundedRect')).toBeLessThan(methods.indexOf('lineBetween'));
  });

  it('the buffed ✦ stays inside the tower body at the SMALLEST supported cell (M2-S8)', () => {
    // The ✦ strokes `pal.floor` over the solid `pal.tower` fill, so any part of it that
    // lands outside the body renders floor-on-floor and is simply not there. Containment
    // is therefore a correctness property, not polish — and it BINDS at the narrow floor,
    // where the 6px corner radius eats most of a 16px-wide body.
    //
    // MEASURED FROM THE ACTUAL DRAW CALLS, not re-derived from the constants. An earlier
    // version of this test recomputed the tip set from `SPARKLE_*_FRAC` plus a local copy
    // of `drawSparkle`'s `r * 0.45` arm ratio and never invoked the draw at all, so it
    // pinned the two constants and nothing else: change the arm ratio, the tip formula, or
    // add a fifth stroke, and the mark could clip while the test stayed green. This file
    // has already shipped that failure once (a centreline-only version passed while the
    // stroke clipped), which is why it reads the endpoints the renderer really emits —
    // now from the buffed atlas frame, relative to the footprint corner it is anchored at.
    expect(PROJECTION.cellPx).toBe(10); // apps/web/e2e/compact.spec.ts's 568×320 floor
    // `basic`'s footprint mark is `'plain'` — no strokes of its own — so every
    // `lineBetween` below belongs to the ✦.
    const placed = placeTowers(
      vmWith([tower('basic', { buffed: true })]),
      EMPTY_OVERLAY,
      PROJECTION,
      FRAMES,
    );
    const frame = placed.committed[0]!.frame;
    const calls = paintFrame(frame);

    const RADIUS = 6; // the body's corner radius, `fillRoundedRect(..., 6)`
    const inset = 2; // the body's inset, `p + 2` / `size - 4`
    const span = PROJECTION.cellPx * 2 - inset * 2;
    // The mark is STROKED, so each endpoint carries half the line width beyond the
    // centreline and it is the outer edge that must clear the body.
    const halfStroke = SPARKLE_STROKE_PX / 2;
    const origin = { x: frameSpec(frame).anchorX, y: frameSpec(frame).anchorY };
    /** Is `(x, y)` — frame-local pixels — inside the body by at least `halfStroke`? */
    const insideBody = (x: number, y: number): boolean => {
      const lx = x - origin.x;
      const ly = y - origin.y;
      const cx = Math.min(Math.max(lx, inset + RADIUS), inset + span - RADIUS);
      const cy = Math.min(Math.max(ly, inset + RADIUS), inset + span - RADIUS);
      return (lx - cx) ** 2 + (ly - cy) ** 2 <= (RADIUS - halfStroke) ** 2 + 1e-9;
    };

    const strokes = calls.filter((c) => c.method === 'lineBetween');
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

  it('puts every aura shell in a layer UNDER every tower body, so the result is build-order independent', () => {
    // The shell's edge lands exactly on the boundary between an edge-adjacent recipient's
    // two footprint columns — down the middle of the tower it points at. Drawn inside the
    // body loop, whether that segment survived depended on SoA (placement) order. M2-S8
    // fixed it by stroking every shell before any body; since V2 (#181) bodies are sprites
    // and the guarantee is the LAYER ORDER, so that is what this pins: the shells layer
    // composites under the tower sprite layer (and the full order is pinned in
    // `layers.test.ts`).
    expect(layerDepth('shells')).toBeLessThan(layerDepth('towers'));
    // And the two halves cannot leak into each other's layer in EITHER build order: the
    // live shell pass draws the shell and never a body, the sprites carry every body and
    // never a shell — the same board built in opposite orders draws the same shells and
    // the same sprites.
    const beacon = tower('beacon', { id: 1, col: 2, row: 2 });
    const basic = tower('basic', { id: 2, col: 4, row: 2, buffed: true });
    const forward = drawnTowers([beacon, basic]);
    const reverse = drawnTowers([basic, beacon]);
    for (const drawn of [forward, reverse]) {
      expect(count(drawn.shells, 'strokeRoundedRect')).toBe(1); // the shell was drawn at all
      expect(count(drawn.shells, 'fillRoundedRect')).toBe(0); // ... and no body with it
      expect(drawn.frames.map((f) => count(f, 'fillRoundedRect'))).toEqual([1, 1]); // bodies
      expect(drawn.frames.every((f) => count(f, 'strokeRoundedRect') === 0)).toBe(true);
    }
    expect(forward.shells).toEqual(reverse.shells);
    const placedForward = placeTowers(vmWith([beacon, basic]), EMPTY_OVERLAY, PROJECTION, FRAMES);
    const placedReverse = placeTowers(vmWith([basic, beacon]), EMPTY_OVERLAY, PROJECTION, FRAMES);
    expect(new Set(placedForward.committed.map((p) => JSON.stringify(p)))).toEqual(
      new Set(placedReverse.committed.map((p) => JSON.stringify(p))),
    );
  });

  it('a pending-sold tower is hidden from BOTH passes — no body and no shell (M2-S8)', () => {
    // The two passes have to honour the pending-sell skip each on their own; drawing the
    // shells live while the bodies became sprites is exactly the kind of change that
    // drops a guard on one side. A sold beacon must take its shell with it.
    const drawn = drawnTowers([tower('beacon')], {
      ...EMPTY_OVERLAY,
      pendingSells: [{ col: 2, row: 2 }],
    });
    expect(count(drawn.all, 'fillRoundedRect')).toBe(0);
    expect(count(drawn.all, 'strokeRoundedRect')).toBe(0);
    // Unsold, the same beacon draws both — the zeros above are the sell's doing.
    const unsold = drawnTowers([tower('beacon')]);
    expect(count(unsold.all, 'fillRoundedRect')).toBe(1);
    expect(count(unsold.all, 'strokeRoundedRect')).toBe(1);
  });

  it('a selected ATTACKLESS tower draws no range ring at all (M2-S8)', () => {
    const g = fakeGraphics();
    const overlay: RenderOverlay = {
      ...EMPTY_OVERLAY,
      selection: { col: 2, row: 2, rangeFp: null, blastRadiusFp: null, towerId: 'beacon' },
    };
    drawSelection(g, PAL, overlay, PROJECTION);
    // No ring — but NOT nothing. The range ring is the only board-side rendering of
    // `selection`, so an empty branch would leave a selected beacon indistinguishable
    // from an unselected one, and Sell would act on a tower the board never identified.
    expect(count(g.calls, 'strokeCircle')).toBe(0);
    const outlines = g.calls.filter((c) => c.method === 'strokeRoundedRect');
    expect(outlines).toHaveLength(1);
    // ... and it must sit OUTSIDE the body rect, not on it. A stroke is centred on its
    // path, so tracing the body's own `p + 2 / size - 4` geometry would bury the inner
    // half of the line in the `pal.tower` fill it cannot contrast against. Asserted
    // against the body's own inset rather than a bare number.
    const BODY_INSET = 2; // the committed frame's own `fillRoundedRect(p + 2, size - 4)`
    const origin = PROJECTION.cellToPixel(2, 2);
    const [x, y, w, h] = outlines[0]!.args as number[];
    expect(x! - origin.x).toBeLessThan(BODY_INSET);
    expect(y! - origin.y).toBeLessThan(BODY_INSET);
    expect(w).toBeGreaterThan(PROJECTION.cellPx * 2 - BODY_INSET * 2);
    expect(h).toBeGreaterThan(PROJECTION.cellPx * 2 - BODY_INSET * 2);
  });

  it('a selected tower draws the range-ring strokeCircle', () => {
    const g = fakeGraphics();
    const overlay: RenderOverlay = {
      ...EMPTY_OVERLAY,
      selection: { col: 2, row: 2, rangeFp: 512, blastRadiusFp: null, towerId: 'basic' },
    };
    drawSelection(g, PAL, overlay, PROJECTION);
    expect(count(g.calls, 'strokeCircle')).toBe(1);
  });

  it('nothing selected draws nothing', () => {
    const g = fakeGraphics();
    drawSelection(g, PAL, EMPTY_OVERLAY, PROJECTION);
    expect(g.calls).toEqual([]);
  });

  it('a mine tower draws its charge mark: a single fillCircle, no strokeCircle/lineBetween — and no other tower draws fillCircle', () => {
    const calls = drawnTower('mine');
    // `'charge'` is the only FILLED mark in the vocabulary — a fillCircle, not a
    // strokeCircle (`'ringed'`) or any lineBetween-built shape.
    expect(count(calls, 'fillCircle')).toBe(1);
    expect(count(calls, 'strokeCircle')).toBe(0);
    expect(count(calls, 'lineBetween')).toBe(0);

    // No other shipped tower draws a fillCircle for its footprint mark — proves the
    // fillCircle above is `'charge'`-specific, not a shared side effect of drawing a body.
    for (const towerId of ['basic', 'slow', 'splash', 'venom', 'stun', 'antiair', 'beacon']) {
      expect(count(drawnTower(towerId), 'fillCircle')).toBe(0);
    }
  });

  it('a pending (queued) mine draws its charge mark as a fillCircle too', () => {
    const calls = drawnPending('mine');
    expect(count(calls, 'fillCircle')).toBe(1);
    expect(count(calls, 'strokeCircle')).toBe(0);
  });

  it('a selected mine draws the range ring PLUS its blast spokes — the blast reaches past the ring', () => {
    const g = fakeGraphics();
    // Mine-shaped numbers: rangeFp 576 (trigger, 2.25 tiles), blastRadiusFp 640 (blast,
    // 2.5 tiles) — the case that forced the cue to exist at all.
    const overlay: RenderOverlay = {
      ...EMPTY_OVERLAY,
      selection: { col: 2, row: 2, rangeFp: 576, blastRadiusFp: 640, towerId: 'mine' },
    };
    drawSelection(g, PAL, overlay, PROJECTION);
    // The range ring itself (1 strokeCircle) PLUS the crosshair spokes (4 lineBetween).
    expect(count(g.calls, 'strokeCircle')).toBe(1);
    expect(count(g.calls, 'lineBetween')).toBe(4);
  });

  it('a selected splash-shaped tower ALSO draws its blast spokes, matching the ghost preview (Rob, 2026-08-07)', () => {
    const g = fakeGraphics();
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
    drawSelection(g, PAL, overlay, PROJECTION);
    expect(count(g.calls, 'strokeCircle')).toBe(1);
    expect(count(g.calls, 'lineBetween')).toBe(4);
  });

  // The remaining negative control, and now the only one: a tower with no blast draws no
  // spokes. (The splash case above used to serve as the data-vs-id control; with the gate
  // reduced to "has a blast at all" there is no id/data distinction left to prove, so
  // `blastRadiusFp === null` is what keeps `drawCrosshair` from being unconditional.)
  it('a selected tower with no blast at all draws no spokes (blastRadiusFp null)', () => {
    const g = fakeGraphics();
    const overlay: RenderOverlay = {
      ...EMPTY_OVERLAY,
      selection: { col: 2, row: 2, rangeFp: 512, blastRadiusFp: null, towerId: 'basic' },
    };
    drawSelection(g, PAL, overlay, PROJECTION);
    expect(count(g.calls, 'strokeCircle')).toBe(1);
    expect(count(g.calls, 'lineBetween')).toBe(0);
  });
});

describe('creep silhouettes and cues — the remaining shapes + slowed telegraph', () => {
  it('a fast creep draws the diamond (2 fillTriangle calls); a swarm creep draws the square (fillRect); an unknown id falls back to a single triangle', () => {
    expect(count(drawnCreep(creep({ creepId: 'fast' })).all, 'fillTriangle')).toBe(2);
    // One fillRect for the square silhouette (its frame) + one for the HP pip (live).
    const swarm = drawnCreep(creep({ creepId: 'swarm' }));
    expect(count(swarm.all, 'fillRect')).toBe(2);
    expect(count(swarm.frame, 'fillRect')).toBe(1);
    expect(count(swarm.cues, 'fillRect')).toBe(1);
    expect(count(drawnCreep(creep({ creepId: 'unknown-id' })).all, 'fillTriangle')).toBe(1);
  });

  it('a low-hp creep switches the silhouette/pip colour (hpColour branch)', () => {
    const low = drawnCreep(creep({ hpFrac: 0.1 }));
    const fillStyleCalls = low.all.filter((c) => c.method === 'fillStyle');
    expect(fillStyleCalls[0]!.args[0]).toBe(PAL.creepLowHp); // the silhouette
    // ... and the live pip drawn over it wears the same tint.
    expect(low.cues.find((c) => c.method === 'fillStyle')!.args[0]).toBe(PAL.creepLowHp);
    // At full health both are the ordinary creep colour.
    const full = drawnCreep(creep({ hpFrac: 1 }));
    expect(full.all.filter((c) => c.method === 'fillStyle').map((c) => c.args[0])).toEqual([
      PAL.creep,
      PAL.creep,
    ]);
  });

  it('a slowed creep draws the ring (always) + pulse (motion allowed) or just the ring (reduced motion)', () => {
    expect(count(drawnCreep(creep({ slowed: true }), false).all, 'strokeCircle')).toBe(2); // ring + pulse
    expect(count(drawnCreep(creep({ slowed: true }), true).all, 'strokeCircle')).toBe(1); // ring only
  });

  it('a stunned creep draws the jolt (always) + flicker (motion allowed) or just the jolt (reduced motion)', () => {
    expect(count(drawnCreep(creep({ stunned: true }), false).all, 'strokeCircle')).toBe(2); // jolt + flicker
    expect(count(drawnCreep(creep({ stunned: true }), true).all, 'strokeCircle')).toBe(1); // jolt only
    expect(count(drawnCreep(creep({ stunned: false }), false).all, 'strokeCircle')).toBe(0);
  });

  it('a warded creep draws a single opaque ring, regardless of reducedMotion (not a timed status)', () => {
    expect(count(drawnCreep(creep({ warded: true }), false).all, 'strokeCircle')).toBe(1);
    expect(count(drawnCreep(creep({ warded: true }), true).all, 'strokeCircle')).toBe(1); // unchanged
    expect(count(drawnCreep(creep({ warded: false }), false).all, 'strokeCircle')).toBe(0);
  });

  it("an air creep's wingspan COMPOSES over the base silhouette (M2-S7) — both draw, regardless of reducedMotion (not a timed status)", () => {
    // `armored` (hexagon, 6-point fillPoints) rather than `normal`, so this proves the
    // airborne cue doesn't merely coexist with the DEFAULT triangle — it composes with
    // whatever base shape the id already draws, exactly the armored-flyer (S10)
    // requirement PLAN.md calls out.
    const air = drawnCreep(creep({ creepId: 'armored', domain: 'air' }));
    const fillPointsCalls = air.all.filter((c) => c.method === 'fillPoints');
    expect(fillPointsCalls).toHaveLength(1); // the hexagon silhouette — still drawn
    expect((fillPointsCalls[0]!.args[0] as unknown[]).length).toBe(6);
    // The wingspan is 2 `lineBetween` calls (apex→left, apex→right) — ADDITIONAL to
    // the silhouette, never a replacement for it.
    expect(count(air.all, 'lineBetween')).toBe(2);

    // Reduced motion changes nothing — the airborne cue carries no motion component.
    expect(
      count(drawnCreep(creep({ creepId: 'armored', domain: 'air' }), true).all, 'lineBetween'),
    ).toBe(2);

    // A ground creep of the same id draws the hexagon with no wingspan at all.
    const ground = drawnCreep(creep({ creepId: 'armored', domain: 'ground' }));
    expect(count(ground.all, 'fillPoints')).toBe(1);
    expect(count(ground.all, 'lineBetween')).toBe(0);
  });

  it('draws every creep’s health pip at its drawn centre: length AND colour carry health', () => {
    const placed = placeCreeps([creep({ hpFrac: 0.5 })], PAL, PROJECTION, FRAMES)[0]!;
    const g = fakeGraphics();
    drawCreepCues(g, PAL, [placed], false, 0);
    const pip = g.calls.find((c) => c.method === 'fillRect')!;
    const r = placed.r;
    // The pip spans the silhouette's width at full health, half of it here, 4px above it.
    expect(pip.args).toEqual([placed.cx - r, placed.cy - r - 4, r * 2 * 0.5, 3]);
  });
});

// The regression Codex caught on PR #78. `CreepVM.x`/`y` are FIXED-POINT sim units (256
// per cell); the silhouette projects them, but both telegraph plans were handed the raw
// creep, so their cues drew ~256x away from the visible creep — off-canvas. The slowed
// telegraph carried this from M2-S3 and had therefore never rendered at all; the DoT
// telegraph inherited it. These assert the cues land ON the projected centre, so passing
// the raw creep again fails immediately — and, since V2, ON the centre the creep's sprite
// is actually drawn at.
describe('drawCreepCues — every telegraph draws at the PROJECTED centre, not fixed-point (PR #78)', () => {
  const CREEP = creep({ slowed: true, poisoned: true });

  it('the slowed ring and the poison pips are centred within a cell of the silhouette', () => {
    const g = fakeGraphics();
    const placed = placeCreeps([CREEP], PAL, PROJECTION, FRAMES);
    drawCreepCues(g, PAL, placed, true, 0);
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
  const STUN_WARD_CREEP = creep({ stunned: true, warded: true });

  it('the stun jolt and the ward ring are centred EXACTLY on the projected silhouette centre', () => {
    const g = fakeGraphics();
    const placed = placeCreeps([STUN_WARD_CREEP], PAL, PROJECTION, FRAMES);
    drawCreepCues(g, PAL, placed, true, 0);
    const p = PROJECTION.fpToPixel(STUN_WARD_CREEP.x, STUN_WARD_CREEP.y);
    expect(Math.hypot(p.x - STUN_WARD_CREEP.x, p.y - STUN_WARD_CREEP.y)).toBeGreaterThan(
      PROJECTION.cellPx,
    );
    // The silhouette sprite's centre — its top-left plus its frame's centre anchor — IS the
    // projected point here (a whole pixel at dpr 1, so the device-pixel snap is a no-op).
    const sprite = placed[0]!;
    const spec = frameSpec(sprite.frame);
    expect(sprite.x + spec.anchorX).toBe(p.x);
    expect(sprite.y + spec.anchorY).toBe(p.y);

    // Reduced motion drops the flicker, so exactly 2 strokeCircle calls remain: jolt,
    // then ward (the cue pass's draw order) — both must land on the projected centre.
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
