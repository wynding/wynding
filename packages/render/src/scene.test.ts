// scene.test.ts — the Phaser board renderer's DRAW LAYER, witnessed (M2-S5a QC round).
// `scene.ts` as a whole stays coverage-excluded (`mount()` needs a real Phaser/WebGL
// context no jsdom test can meaningfully drive), and it is genuinely exercised end-to-end
// by the Playwright e2e smoke — but that suite's own comment says axe cannot see canvas
// cues, so a deleted draw BRANCH (the hexagon silhouette, the droplet tower mark, the
// poisoned-pip loop) could vanish with every unit AND e2e test still green. So everything
// `scene.ts` draws is drawn by Phaser-free modules, and this file drives them with a
// recording `GraphicsLike` — no Phaser import, no WebGL/canvas context.
//
// RETARGETED BY V2 (#181). Static art is baked into an atlas now, so a tower's art and a
// creep's silhouette are drawn by the atlas FRAME PAINTERS (`art-frames.ts`, in frame-local
// coordinates) and shown at a position the PLACEMENT functions compute (`placement.ts`);
// only shells, the selection cue and creep pips/cues are still drawn per frame
// (`drawAuraShells`, `drawSelection`, `drawCreepCues`). Every test below that used to record
// `drawTowers`/`drawCreeps` records the same thing through that chain — placement picks the
// frame, the frame's painter draws it. A tower or creep's "whole drawing" is the frame's
// calls followed by its live calls, which is the order the layers composite them in.
//
// RETARGETED AGAIN BY THE VISUAL PASS'S TOWER ART (T1/T2/T4/B3). A tower is now vector art
// (`tower-art.ts`): a plate frame and a head frame, painted through the art kit's `art()`
// call rather than `GraphicsLike` primitives. So a tower's drawing is read as the ART it
// paints — the IR shapes each frame hands `art()` — and each mark's old primitive-count
// witness ("1 strokeCircle + 4 lineBetween") is now the same count of the same glyph in the
// head: its ink rings, ink discs and ink line segments. The body ✦ is gone, replaced by the
// boost glow, and its containment test measures the glow from the drawn frames instead.

import { describe, it, expect } from 'vitest';
import { drawAuraShells, drawCreepCues, drawSelection } from './board-draw';
import {
  atlasFrameSpecs,
  artUnit,
  PAD_FRAME_KEY,
  PLATE_FRAME_KEY,
  type FrameSpec,
} from './art-frames';
import { flattenPath, parsePath } from './art-geometry';
import { strokeWidthAt, type ArtShape } from './art-ir';
import {
  ART_BOX,
  ART_INK,
  PAD_ART,
  PENDING_ALPHA,
  PENDING_PLATE_ALPHA,
  PLATE_RECT,
} from './tower-art';
import { placeCreeps, placeTowers, type CreepPlacementInput as CreepIn } from './placement';
import { layerDepth } from './layers';
import { createProjection } from './projection';
import { snapToDevicePx } from './device-px';
import { resolvePalette } from './palette';
import type { RenderVM, RenderOverlay, TowerVM } from './types';
// A recording `GraphicsLike` (`fakeGraphics`) records every call instead of drawing; the
// art variant (`fakeArtGraphics`) adds the art kit's calls, what an atlas frame painter
// draws into. Both satisfy the real interfaces directly — `test-support/`.
import {
  recordingArtGraphics as fakeArtGraphics,
  recordingGraphics as fakeGraphics,
  type Call,
} from './test-support/recording-graphics';

const count = (calls: readonly Call[], method: string): number =>
  calls.filter((c) => c.method === method).length;

/** One `art()` call: the shapes it painted, where, and at what scale. */
interface ArtCall {
  readonly shapes: readonly ArtShape[];
  readonly x: number;
  readonly y: number;
  readonly unit: number;
}

const artCallsOf = (calls: readonly Call[]): ArtCall[] =>
  calls
    .filter((c) => c.method === 'art')
    .map((c) => {
      const [shapes, , x, y, unit] = c.args as [
        readonly ArtShape[],
        unknown,
        number,
        number,
        number,
      ];
      return { shapes, x, y, unit };
    });

/** Every shape a frame's calls painted, in order. */
const shapesOf = (calls: readonly Call[]): ArtShape[] => artCallsOf(calls).flatMap((c) => c.shapes);

/** A head's GLYPH, counted the way the old footprint-mark tests counted primitives: closed
 *  ink rings (stroked, unfilled circles — the old `strokeCircle`), filled ink discs (the old
 *  `fillCircle`), and the straight ink line segments of unfilled paths (the old
 *  `lineBetween`), with how many of those are vertical. */
function glyphOf(shapes: readonly ArtShape[]): {
  rings: number;
  discs: number;
  segments: number;
  vertical: number;
} {
  let rings = 0;
  let discs = 0;
  let segments = 0;
  let vertical = 0;
  for (const s of shapes) {
    if (s.kind === 'circle' && s.stroke === 'ink' && s.fill === undefined) rings++;
    if (s.kind === 'circle' && s.fill === 'ink') discs++;
    if (s.kind === 'path' && s.stroke === 'ink' && s.fill === undefined) {
      // Glyph paths are straight lines only — a curve here would not be a segment count.
      expect(parsePath(s.d).every((c) => c.c === 'M' || c.c === 'L')).toBe(true);
      for (const line of flattenPath(s.d)) {
        for (let i = 1; i < line.points.length; i++) {
          segments++;
          if (line.points[i]![0] === line.points[i - 1]![0]) vertical++;
        }
      }
    }
  }
  return { rings, discs, segments, vertical };
}

/** The head's own outline — the shape filled in the role colour and outlined in ink that
 *  every head has exactly one of as its body, or the first of several (the beacon's base). */
const bodyOf = (shapes: readonly ArtShape[]): ArtShape =>
  shapes.find((s) => s.fill === 'role' && s.stroke === 'ink')!;

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
  const g = fakeArtGraphics();
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
  targetId: 0,
  ...opts,
});

/** Everything a board of `towers` draws for them, the way the layers composite it: the live
 *  shells, then each committed tower's baked plate frame (if it has one), then each head
 *  frame — as placement picks them. */
function drawnTowers(
  towers: readonly TowerVM[],
  overlay: RenderOverlay = EMPTY_OVERLAY,
): { shells: Call[]; plates: Call[][]; heads: Call[][]; all: Call[] } {
  const g = fakeGraphics();
  drawAuraShells(g, PAL, vmWith(towers), overlay, PROJECTION);
  const placed = placeTowers(vmWith(towers), overlay, PROJECTION, FRAMES);
  const plates = placed.plates.map((p) => paintFrame(p.frame));
  const heads = placed.heads.map((p) => paintFrame(p.frame));
  return { shells: g.calls, plates, heads, all: [...g.calls, ...plates.flat(), ...heads.flat()] };
}

/** The shapes one committed tower's HEAD frame paints. */
function headShapes(towerId: string, opts: Partial<TowerVM> = {}): ArtShape[] {
  const drawn = drawnTowers([tower(towerId, opts)]);
  expect(drawn.heads).toHaveLength(1);
  return shapesOf(drawn.heads[0]!);
}

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

// Off the diagonal (x ≠ y) on purpose: a cue or pip drawn with its coordinates swapped must
// land somewhere else, or the centre tests below could not see it.
const creep = (opts: Partial<CreepIn> = {}): CreepIn => ({
  x: 5 * 256,
  y: 3 * 256,
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

describe('tower heads — the venom droplet (M2-S5a)', () => {
  it('a venom tower’s head IS the droplet — one curved body coming to a single tip at the top, with its highlight — and no other head is', () => {
    const shapes = headShapes('venom');
    // The droplet is the head's own outline now, not a mark inside a body: a closed path
    // of curves (the bulb's arc and the two flanks), its topmost point the tip, straight
    // up the footprint's centre line.
    const body = bodyOf(shapes);
    expect(body.kind).toBe('path');
    if (body.kind !== 'path') return;
    const cmds = parsePath(body.d).map((c) => c.c);
    expect(cmds).toContain('A');
    expect(cmds).toContain('C');
    expect(cmds).not.toContain('L');
    const pts = flattenPath(body.d).flatMap((l) => l.points);
    const top = pts.reduce((a, b) => (b[1] < a[1] ? b : a));
    expect(top[0]).toBeCloseTo(ART_BOX / 2, 9);
    // ... and its highlight, the one shape in the art kit painted in `gloss`.
    expect(shapes.filter((s) => s.fill === 'gloss')).toHaveLength(1);
    // No ink glyph strokes inside it: the droplet carries its idea by its outline.
    expect(glyphOf(shapes)).toEqual({ rings: 0, discs: 0, segments: 0, vertical: 0 });

    // No other tower's head is a curved path body or wears the gloss — the assertions
    // above key on the droplet, not on "some head was drawn".
    for (const id of [
      'basic',
      'slow',
      'splash',
      'stun',
      'antiair',
      'beacon',
      'mine',
      'frost-splash',
    ]) {
      const other = headShapes(id);
      expect(
        other.some((s) => s.fill === 'gloss'),
        id,
      ).toBe(false);
      const b = bodyOf(other);
      expect(b.kind === 'path' && parsePath(b.d).some((c) => c.c === 'C'), id).toBe(false);
    }
  });
});

describe('tower heads — the stun bolt (M2-S6)', () => {
  it('a stun tower’s head carries the bolt: a 3-segment ink zigzag, none of it vertical, no ring — on a diamond', () => {
    const shapes = headShapes('stun');
    // The bolt's zigzag is 3 ink segments — distinct from `'crosshair'`'s 4 (spokes) and
    // from `'arrow'`'s shaft (vertical); the stagger means none of the three is vertical.
    expect(glyphOf(shapes)).toEqual({ rings: 0, discs: 0, segments: 3, vertical: 0 });
    const body = bodyOf(shapes);
    expect(body.kind === 'polygon' && body.points.length).toBe(4); // the diamond
  });
});

describe('tower heads — the antiair arrow (M2-S7)', () => {
  it('an antiair tower’s head IS the arrow, swept back and pointing up, with ONE vertical ink shaft — not conflated with basic, the bolt or the airborne creep cue', () => {
    const shapes = headShapes('antiair');
    // The shaft is the one ink stroke, and it is vertical — which the bolt's staggered
    // zigzag never is.
    expect(glyphOf(shapes)).toEqual({ rings: 0, discs: 0, segments: 1, vertical: 1 });
    // The arrowhead is the head's own filled outline — a closed shape, so it reads as a
    // solid dart, never as the airborne cue's bare open chevron (two strokes, no fill).
    const body = bodyOf(shapes);
    expect(body.kind).toBe('path');
    if (body.kind !== 'path') return;
    const outline = flattenPath(body.d);
    expect(outline).toHaveLength(1);
    expect(outline[0]!.closed).toBe(true);
    expect(outline[0]!.points).toHaveLength(6); // tip, two barbs, two notches, the tail

    // A `basic` tower's head draws no ink strokes at all — the assertions above key on
    // the arrow, not on "some head was drawn".
    expect(glyphOf(headShapes('basic')).segments).toBe(0);
  });
});

describe('tower heads — the frost-splash ringed-crosshair (M2-S10)', () => {
  // The committed head (this describe) and the pending build (below, in the shared block)
  // must BOTH carry the glyph, or `'ringed-crosshair'` is a dead value that silently draws
  // nothing (PLAN.md P4). This pins the COMMITTED head frame specifically.
  it('a frost-splash tower (committed) carries the ringed-crosshair: 1 ink ring + 4 ink spokes running OUTWARD from it — on an outline of its own', () => {
    const shapes = headShapes('frost-splash');
    // The ring is `'ringed'`'s; the 4 spokes are `'crosshair'`'s count — it reads as BOTH
    // parents (m2.md:299), never `'ringed'` alone (no spokes) or `'crosshair'` alone (no
    // ring, a filled hub instead).
    expect(glyphOf(shapes)).toEqual({ rings: 1, discs: 0, segments: 4, vertical: 2 });
    // The spokes start AT the ring and point away from it: each one's inner end sits on
    // the ring's radius, unlike `'crosshair'`'s, which start beyond its hub with a gap.
    const ring = shapes.find((s) => s.kind === 'circle' && s.stroke === 'ink' && !s.fill)!;
    const spokes = shapes.find((s) => s.kind === 'path' && s.stroke === 'ink' && !s.fill)!;
    if (ring.kind !== 'circle' || spokes.kind !== 'path') throw new Error('glyph shapes');
    for (const { points } of flattenPath(spokes.d)) {
      const reach = points.map(([x, y]) => Math.hypot(x - ART_BOX / 2, y - ART_BOX / 2));
      expect(Math.min(...reach)).toBeCloseTo(ring.r, 9);
      expect(Math.max(...reach)).toBeGreaterThan(ring.r);
    }
    // Its own outline — a twelve-cornered plus — not splash's octagon (T1).
    const body = bodyOf(shapes);
    expect(body.kind === 'polygon' && body.points.length).toBe(12);
    const splash = bodyOf(headShapes('splash'));
    expect(splash.kind === 'polygon' && splash.points.length).toBe(8);
  });
});

// The rest of the tower drawing's branches, exercised so the modules clear the package's
// normal 90% branch bar — not new QC witnesses, just the remaining plain coverage.
describe('tower heads — the remaining committed/pending heads, the boost glow, the selection ring', () => {
  it('a slow tower’s head carries the ringed mark: a bare ink ring, no spokes — on a six-pointed star', () => {
    const shapes = headShapes('slow');
    expect(glyphOf(shapes)).toEqual({ rings: 1, discs: 0, segments: 0, vertical: 0 });
    const body = bodyOf(shapes);
    expect(body.kind === 'polygon' && body.points.length).toBe(12);
  });

  it('a splash tower’s head carries the crosshair mark: 4 ink spokes around a filled hub, no ring — on an octagon', () => {
    const shapes = headShapes('splash');
    expect(glyphOf(shapes)).toEqual({ rings: 0, discs: 1, segments: 4, vertical: 2 });
    // The spokes keep the crosshair's centre gap: none reaches the hub.
    const hub = shapes.find((s) => s.kind === 'circle' && s.fill === 'ink')!;
    const spokes = shapes.find((s) => s.kind === 'path' && s.stroke === 'ink' && !s.fill)!;
    if (hub.kind !== 'circle' || spokes.kind !== 'path') throw new Error('glyph shapes');
    for (const { points } of flattenPath(spokes.d)) {
      for (const [x, y] of points) {
        expect(Math.hypot(x - ART_BOX / 2, y - ART_BOX / 2)).toBeGreaterThan(hub.r);
      }
    }
  });

  it('a basic tower’s head is the plain turret: its barrel up, a ring body and an ink centre — no glyph strokes', () => {
    const shapes = headShapes('basic');
    expect(glyphOf(shapes)).toEqual({ rings: 0, discs: 1, segments: 0, vertical: 0 });
    const barrel = bodyOf(shapes);
    expect(barrel.kind === 'rect' && barrel.y + barrel.h).toBeLessThan(ART_BOX / 2); // up
  });

  it('a committed tower whose sell is pending is hidden entirely — no plate, no head', () => {
    const drawn = drawnTowers([tower('basic')], {
      ...EMPTY_OVERLAY,
      pendingSells: [{ col: 2, row: 2 }],
    });
    // No sprite at all — so nothing painted (the frames are where a tower is painted).
    expect(drawn.plates).toHaveLength(0);
    expect(drawn.heads).toHaveLength(0);
    expect(count(drawn.all, 'art')).toBe(0);
    // ... and the unsold control does draw both, so the zero above is the sell's doing.
    const unsold = drawnTowers([tower('basic')]);
    expect([unsold.plates.length, unsold.heads.length]).toEqual([1, 1]);
  });

  it('a pending (queued, not yet committed) build draws its OWN head — the same glyph as the committed one, for every tower — faded, under one dashed rim; fails if the pending frame’s head is deleted while the committed one stays green (PLAN.md P4 mutation check)', () => {
    for (const towerId of [
      'basic',
      'slow',
      'splash',
      'venom',
      'stun',
      'antiair',
      'beacon',
      'mine',
      'frost-splash',
    ]) {
      const calls = drawnPending(towerId);
      const committed = headShapes(towerId);
      const parts = artCallsOf(calls);
      const rim = parts[parts.length - 1];
      // The pending picture's head is the committed head's shapes, every one, in order.
      const head = parts[parts.length - 2]!;
      expect(head.shapes, towerId).toEqual(committed);
      expect(glyphOf(head.shapes), towerId).toEqual(glyphOf(committed));
      // The plate (every tower but the mine) fades on its own first, further than the head;
      // then plate and head fade as ONE picture to `PENDING_ALPHA`; then ONE dashed rim at
      // full opacity on top.
      const plated = towerId !== 'mine';
      expect(parts, towerId).toHaveLength(plated ? 3 : 2);
      expect(
        calls.filter((c) => c.method === 'fade').map((c) => c.args[0]),
        towerId,
      ).toEqual(plated ? [PENDING_PLATE_ALPHA / PENDING_ALPHA, PENDING_ALPHA] : [PENDING_ALPHA]);
      expect(rim!.shapes).toHaveLength(1);
      expect(rim!.shapes[0]!.dash?.length, towerId).toBeGreaterThanOrEqual(2);
      expect(rim!.shapes[0]!.alpha ?? 1, towerId).toBe(1);
    }
  });

  // M2-S8 — the beacon's two aura cues, plus the recipient's glow.
  it('a beacon draws its pylon head AND the adjacency shell (a rounded RECT, never a circle)', () => {
    const drawn = drawnTowers([tower('beacon')]);
    // The shell is the live layer's ONLY strokeRoundedRect, and there is NO circle in it:
    // drawing the aura as a concentric circle on a footprint is the ambiguity Codex R1-15
    // rejected, and the buff rule is a square edge-share a circle would misdraw regardless.
    expect(count(drawn.shells, 'strokeRoundedRect')).toBe(1);
    expect(count(drawn.shells, 'strokeCircle')).toBe(0);
    // The beacon itself wears no boost glow — its aura reads as the shell, not as rings.
    expect(shapesOf(drawn.all).some((s) => s.stroke === 'aura')).toBe(false);
    // The pylon: a base, a tapered mast and a lamp — and the two broadcast arcs over it,
    // stroked in the role colour (the only role-coloured strokes any head has).
    const shapes = headShapes('beacon');
    expect(
      shapes.filter((s) => s.fill === 'role' && s.stroke === 'ink').map((s) => s.kind),
    ).toEqual(['rect', 'path', 'circle']);
    const arcs = shapes.filter((s) => s.stroke === 'role');
    expect(arcs).toHaveLength(2);
    for (const a of arcs)
      expect(a.kind === 'path' && parsePath(a.d).some((c) => c.c === 'A')).toBe(true);
  });

  it('a boosted tower’s head wears the glow — two aura rings, drawn UNDER the head — and an unboosted one none (it replaced the ✦)', () => {
    const plain = headShapes('basic', { buffed: false });
    expect(plain.filter((s) => s.stroke === 'aura')).toHaveLength(0);
    const boosted = headShapes('basic', { buffed: true });
    const glow = boosted.filter((s) => s.stroke === 'aura');
    expect(glow).toHaveLength(2);
    for (const ring of glow) {
      expect(ring.kind).toBe('circle');
      expect(ring.fill).toBeUndefined();
    }
    // The glow comes first, so the head is painted over it, as in the style frame.
    expect(boosted.indexOf(glow[0]!)).toBe(0);
    expect(boosted.indexOf(glow[1]!)).toBe(1);
    expect(boosted.slice(2)).toEqual(plain);
    // No shell — this tower receives an aura, it does not project one.
    expect(count(drawnTowers([tower('basic', { buffed: true })]).shells, 'strokeRoundedRect')).toBe(
      0,
    );
  });

  it('the boost glow stays on the plate — inside its rim — at the SMALLEST supported cell (M2-S8’s ✦ rule, kept)', () => {
    // The glow is `pal.aura`, gated ≥ 3:1 against the PLATE (palette.test.ts) — not against
    // the rim it measures 2.23:1 on, nor everywhere on the floor. So containment on the
    // plate is a correctness property, not polish, exactly as it was for the ✦ it replaced
    // — and it binds at the narrow floor, where the rim's one-CSS-px floor is widest
    // relative to the plate.
    //
    // MEASURED FROM THE ACTUAL DRAW CALLS, not re-derived from the constants (this file
    // shipped a constants-only version of the ✦ test once, which passed while the mark
    // clipped): the rings are read from the boosted head frame and the rim from the plate
    // frame, each at the scale its frame really paints at, relative to the corner both
    // frames are anchored at.
    expect(PROJECTION.cellPx).toBe(10); // apps/web/e2e/compact.spec.ts's 568×320 floor
    const drawn = drawnTowers([tower('basic', { buffed: true })]);
    const [head] = artCallsOf(drawn.heads[0]!);
    const [plate] = artCallsOf(drawn.plates[0]!);
    expect(head!.unit).toBe(artUnit(PROJECTION.cellPx));
    expect([head!.x, head!.y]).toEqual([plate!.x, plate!.y]); // the same footprint corner

    const rim = plate!.shapes.find((s) => s.stroke === 'rim')!;
    expect(rim.kind).toBe('rect');
    if (rim.kind !== 'rect') return;
    const u = plate!.unit;
    // The rim's INNER edge on each side, CSS px — the rim as the plate frame draws it, on
    // whole device pixels, so each side may have moved its own way.
    const half = strokeWidthAt(rim, u) / 2;
    const inner = {
      left: plate!.x + (rim.x + half) * u,
      right: plate!.x + (rim.x + rim.w - half) * u,
      top: plate!.y + (rim.y + half) * u,
      bottom: plate!.y + (rim.y + rim.h - half) * u,
    };

    const rings = head!.shapes.filter((s) => s.stroke === 'aura');
    expect(rings).toHaveLength(2); // the glow drew at all — guards a vacuous pass below
    for (const ring of rings) {
      if (ring.kind !== 'circle') throw new Error('the glow is rings');
      // Centred on the footprint...
      const cx = head!.x + ring.cx * head!.unit;
      const cy = head!.y + ring.cy * head!.unit;
      expect(cx).toBeCloseTo(plate!.x + (ART_BOX / 2) * u, 9);
      expect(cy).toBeCloseTo(plate!.y + (ART_BOX / 2) * u, 9);
      // ... and its OUTER edge — the stroke is centred on its radius — inside the rim on
      // every side.
      const outer = (ring.r + strokeWidthAt(ring, head!.unit) / 2) * head!.unit;
      expect(cx - outer).toBeGreaterThan(inner.left);
      expect(cx + outer).toBeLessThan(inner.right);
      expect(cy - outer).toBeGreaterThan(inner.top);
      expect(cy + outer).toBeLessThan(inner.bottom);
    }
  });

  it('puts every aura shell in a layer UNDER every tower, so the result is build-order independent', () => {
    // The shell's edge lands exactly on the boundary between an edge-adjacent recipient's
    // two footprint columns — down the middle of the tower it points at. Drawn inside the
    // body loop, whether that segment survived depended on SoA (placement) order. M2-S8
    // fixed it by stroking every shell before any body; since V2 (#181) towers are sprites
    // and the guarantee is the LAYER ORDER, so that is what this pins: the shells layer
    // composites under the plate and head layers (the full order is pinned in
    // `layers.test.ts`).
    expect(layerDepth('shells')).toBeLessThan(layerDepth('plates'));
    expect(layerDepth('shells')).toBeLessThan(layerDepth('heads'));
    // And the two halves cannot leak into each other's layer in EITHER build order: the
    // live shell pass draws the shell and never a tower, the sprites carry every tower
    // and never a shell — the same board built in opposite orders draws the same shells
    // and the same sprites.
    const beacon = tower('beacon', { id: 1, col: 2, row: 2 });
    const basic = tower('basic', { id: 2, col: 4, row: 2, buffed: true });
    const forward = drawnTowers([beacon, basic]);
    const reverse = drawnTowers([basic, beacon]);
    for (const drawn of [forward, reverse]) {
      expect(count(drawn.shells, 'strokeRoundedRect')).toBe(1); // the shell was drawn at all
      expect(count(drawn.shells, 'art')).toBe(0); // ... and no tower with it
      expect(drawn.plates.map((f) => count(f, 'art'))).toEqual([1, 1]); // two plates
      expect(drawn.heads.map((f) => count(f, 'art'))).toEqual([1, 1]); // two heads
      for (const f of [...drawn.plates, ...drawn.heads]) {
        expect(count(f, 'strokeRoundedRect')).toBe(0); // never a shell in a frame
      }
    }
    expect(forward.shells).toEqual(reverse.shells);
    const placedForward = placeTowers(vmWith([beacon, basic]), EMPTY_OVERLAY, PROJECTION, FRAMES);
    const placedReverse = placeTowers(vmWith([basic, beacon]), EMPTY_OVERLAY, PROJECTION, FRAMES);
    for (const part of ['plates', 'heads'] as const) {
      expect(new Set(placedForward[part].map((p) => JSON.stringify(p)))).toEqual(
        new Set(placedReverse[part].map((p) => JSON.stringify(p))),
      );
    }
  });

  it('a mine beside a beacon keeps the shell off its footprint as a plated tower does — its pad covers the crossing (QC round 1)', () => {
    // The shell runs one cell out from its beacon — down the middle of an edge-adjacent
    // neighbour's footprint. A plate hides that segment; the mine has no plate and its
    // studded head covers too little, so before the pad a lavender line ran through most of
    // a mine's footprint and across its own boost rings. Beacon at (4,12), mine at (6,12),
    // 32px cells.
    const P32 = createProjection({ cols: 16, rows: 16, cssWidth: 512, cssHeight: 512, dpr: 1 });
    expect(P32.cellPx).toBe(32);
    const frames32: ReadonlyMap<string, FrameSpec> = new Map(
      atlasFrameSpecs(32, 1).map((f) => [f.key, f]),
    );
    const beacon = tower('beacon', { id: 1, col: 4, row: 12 });
    const mine = tower('mine', { id: 2, col: 6, row: 12, buffed: true });

    // The shell's right edge, in board px, crosses the mine's footprint top to bottom.
    const g = fakeGraphics();
    drawAuraShells(g, PAL, vmWith([beacon, mine]), EMPTY_OVERLAY, P32);
    const half = (g.calls.find((c) => c.method === 'lineStyle')!.args[0] as number) / 2;
    const [sx, sy, sw, sh] = g.calls.find((c) => c.method === 'strokeRoundedRect')!
      .args as number[];
    const edgeX = sx! + sw!;
    const foot = P32.cellToPixel(6, 12);
    const side = 2 * P32.cellPx;
    expect(edgeX - half).toBeGreaterThan(foot.x);
    expect(edgeX + half).toBeLessThan(foot.x + side);
    expect(sy!).toBeLessThan(foot.y);
    expect(sy! + sh!).toBeGreaterThan(foot.y + side);

    /** The opaque rect a plates-layer sprite paints, in board px. */
    const groundRect = (placement: {
      frame: string;
      x: number;
      y: number;
    }): [number, number, number, number] => {
      const rg = fakeArtGraphics();
      frames32.get(placement.frame)!.paint(rg, PAL);
      const [call] = artCallsOf(rg.calls);
      const fill = call!.shapes.find(
        (s) => s.kind === 'rect' && (s.alpha ?? 1) === 1 && s.fill !== 'shadow',
      )!;
      if (fill.kind !== 'rect') throw new Error('a ground is a rect');
      const left = placement.x + call!.x + fill.x * call!.unit;
      const top = placement.y + call!.y + fill.y * call!.unit;
      return [left, top, left + fill.w * call!.unit, top + fill.h * call!.unit];
    };

    for (const order of [
      [beacon, mine],
      [mine, beacon],
    ]) {
      const placed = placeTowers(vmWith(order), EMPTY_OVERLAY, P32, frames32);
      const pad = placed.plates.find((p) => p.frame === PAD_FRAME_KEY)!;
      expect(pad).toBeDefined();
      const [left, top, right, bottom] = groundRect(pad);
      // The pad spans the shell's whole band across the footprint...
      expect(left).toBeLessThan(edgeX - half);
      expect(right).toBeGreaterThan(edgeX + half);
      // ... over all of the footprint but its 3/64 margins, top and bottom — exactly the
      // rect a plated tower stands on at the same anchor.
      expect(top - foot.y).toBeCloseTo((PLATE_RECT.y / ART_BOX) * side, 9);
      expect(foot.y + side - bottom).toBeCloseTo((PLATE_RECT.y / ART_BOX) * side, 9);
      // (The frames differ — a plate's is sized for its shadow — but the rects coincide.)
      const plated = placeTowers(
        vmWith([beacon, { ...mine, towerId: 'basic' }]),
        EMPTY_OVERLAY,
        P32,
        frames32,
      ).plates[1]!;
      expect(plated.frame).toBe(PLATE_FRAME_KEY);
      const plateRect = groundRect(plated);
      [left, top, right, bottom].forEach((v, i) => expect(plateRect[i]).toBeCloseTo(v!, 9));
    }
    // And the plates layer composites over the shells layer, so the pad hides what it covers.
    expect(layerDepth('plates')).toBeGreaterThan(layerDepth('shells'));
  });

  it('a pending-sold tower is hidden from BOTH passes — no plate, no head and no shell (M2-S8)', () => {
    // The two passes have to honour the pending-sell skip each on their own; drawing the
    // shells live while the towers became sprites is exactly the kind of change that
    // drops a guard on one side. A sold beacon must take its shell with it.
    const drawn = drawnTowers([tower('beacon')], {
      ...EMPTY_OVERLAY,
      pendingSells: [{ col: 2, row: 2 }],
    });
    expect(count(drawn.all, 'art')).toBe(0);
    expect(count(drawn.all, 'strokeRoundedRect')).toBe(0);
    // Unsold, the same beacon draws all three — the zeros above are the sell's doing.
    const unsold = drawnTowers([tower('beacon')]);
    expect([unsold.plates.length, unsold.heads.length]).toEqual([1, 1]);
    expect(count(unsold.shells, 'strokeRoundedRect')).toBe(1);
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
    // ... and its OUTER edge must never sit inside the plate's rim: `range` against the rim
    // is 1.32:1, against the floor outside the footprint 4.61:1. The rim is the plate's
    // stroke as the plate frame draws it at this cell size: its one-CSS-px floor applied and
    // moved onto whole device pixels — which at this narrowest cell, at dpr 1, is the
    // footprint's outermost pixel (the design puts its outer edge only 0.44px in). The 2px
    // outline covers the whole of it, so its inner edge lies on the plate, where `range`
    // clears 3.70:1 composited (gated, palette.test.ts). The next test walks the other cell
    // sizes and dprs.
    const lineStyle = g.calls.find((c) => c.method === 'lineStyle')!;
    const half = (lineStyle.args[0] as number) / 2;
    const origin = PROJECTION.cellToPixel(2, 2);
    const [x, y, w, h] = outlines[0]!.args as number[];
    const [plate] = artCallsOf(paintFrame(PLATE_FRAME_KEY));
    const rim = plate!.shapes.find((s) => s.stroke === 'rim')!;
    if (rim.kind !== 'rect') throw new Error('the rim is the plate rect’s stroke');
    const u = plate!.unit;
    // The rim's two edges, CSS px in from the footprint corner (widths are design units).
    const rimOuter = (rim.x - strokeWidthAt(rim, u) / 2) * u;
    const rimInner = (rim.x + strokeWidthAt(rim, u) / 2) * u;
    expect(rimOuter).toBeGreaterThanOrEqual(0); // the rim stays inside the footprint
    for (const edge of [x! - origin.x, y! - origin.y]) {
      expect(edge - half).toBeGreaterThanOrEqual(0); // inside the footprint...
      // ... its outer edge at or outside the rim's, so no pixel of the rim lies outside it ...
      expect(edge - half).toBeLessThanOrEqual(rimOuter + 1e-9);
      expect(edge + half).toBeGreaterThanOrEqual(rimInner); // ... covering the whole rim
    }
    for (const span of [w!, h!]) {
      expect(span + 2 * half).toBeLessThanOrEqual(PROJECTION.cellPx * 2); // never past it
    }
    // The rim read here IS the plate's, moved at most half a pixel onto the pixel grid.
    expect(Math.abs(rim.x - PLATE_RECT.x) * u).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(rim.x).not.toBe(PLATE_RECT.x); // (and at this size it did move)
  });

  it('the attackless outline’s outer edge is never inside the rim, on any side, at any cell size or dpr — at dpr 1 covering the rim up to 21 px, clear of it at 22–24 px and from 29 px (its near sides from 28)', () => {
    for (const dpr of [0.8, 0.9, 1, 1.25, 1.5, 1.75, 2, 3]) {
      for (const cellPx of [10, 11, 12, 13, 16, 20, 21, 22, 24, 25, 27, 28, 29, 31, 32, 40, 60]) {
        const at = `cellPx ${cellPx} at dpr ${dpr}`;
        const projection = createProjection({
          cols: 10,
          rows: 10,
          cssWidth: cellPx * 10,
          cssHeight: cellPx * 10,
          dpr,
        });
        expect(projection.cellPx).toBe(cellPx);
        const g = fakeGraphics();
        drawSelection(
          g,
          PAL,
          {
            ...EMPTY_OVERLAY,
            selection: { col: 2, row: 2, rangeFp: null, blastRadiusFp: null, towerId: 'beacon' },
          },
          projection,
        );
        const half = (g.calls.find((c) => c.method === 'lineStyle')!.args[0] as number) / 2;
        const [x, , w] = g.calls.find((c) => c.method === 'strokeRoundedRect')!.args as number[];
        // The rim as the plate frame draws it at this cell size and dpr: on whole device
        // pixels.
        const plateSpec = atlasFrameSpecs(cellPx, dpr).find((s) => s.key === PLATE_FRAME_KEY)!;
        const pg = fakeArtGraphics();
        plateSpec.paint(pg, PAL);
        const [plate] = artCallsOf(pg.calls);
        const rim = plate!.shapes.find((s) => s.stroke === 'rim')!;
        if (rim.kind !== 'rect') throw new Error('the rim is the plate rect’s stroke');
        const u = plate!.unit;
        const sw = strokeWidthAt(rim, u);
        // Each side's outline centre line and rim edges, CSS px in from that side's footprint
        // edge — from the corner the outline is drawn at (the sprite's, snapped to a device
        // pixel), and two cells on from it.
        const corner = snapToDevicePx(projection.cellToPixel(2, 2).x, dpr);
        const foot = 2 * cellPx;
        for (const side of [
          {
            name: 'near',
            edge: x! - corner,
            rimOuter: (rim.x - sw / 2) * u,
            rimInner: (rim.x + sw / 2) * u,
          },
          {
            name: 'far',
            edge: corner + foot - (x! + w!),
            rimOuter: foot - (rim.x + rim.w + sw / 2) * u,
            rimInner: foot - (rim.x + rim.w - sw / 2) * u,
          },
        ]) {
          const on = `${at}, ${side.name} side`;
          // Always: the outline's outer edge inside the footprint, and at or outside the
          // rim's — no pixel of the rim lies outside the outline.
          expect(side.edge - half, on).toBeGreaterThanOrEqual(-1e-9);
          expect(side.edge - half, on).toBeLessThanOrEqual(side.rimOuter + 1e-9);
          // At dpr 1 — up to 21 px: it covers the whole rim, so its inner edge meets the
          // plate. At 22–24 px and from 29 px: the floor margin holds all of it. Between, at
          // 25–27 px, where the rim's own width rounds up to two pixels and widens outward, its
          // inner edge ends on the rim, and its floor-side edge carries the cue — and at 28 px
          // on the far sides: there the widened rim's place is an exact tie, which rounds up
          // on both axes, moving the near sides in and the far sides out. (A fractional dpr
          // moves these bands, the rim being on whole device pixels.)
          if (dpr !== 1) continue;
          if (cellPx <= 21)
            expect(side.edge + half, on).toBeGreaterThanOrEqual(side.rimInner - 1e-9);
          else if (cellPx <= 24 || cellPx >= 29 || (cellPx === 28 && side.name === 'near')) {
            expect(side.edge + half, on).toBeLessThanOrEqual(side.rimOuter + 1e-9);
          } else {
            expect(side.edge + half, on).toBeGreaterThan(side.rimOuter + 1e-9);
            expect(side.edge + half, on).toBeLessThan(side.rimInner - 1e-9);
          }
        }
      }
    }
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

  it('a mine tower’s head is the charge — a filled disc ringed by six studs, an ink core — lying on the floor with NO plate, and no other tower is', () => {
    const drawn = drawnTowers([tower('mine')]);
    // No plate and no rim: what it stands on in the plates layer is the floor-coloured pad
    // that keeps aura shells off its footprint, invisible against the floor.
    expect(drawn.plates).toHaveLength(1);
    expect(shapesOf(drawn.plates[0]!)).toEqual(PAD_ART);
    const shapes = shapesOf(drawn.heads[0]!);
    // The charge's filled disc, its ink core and no glyph strokes.
    expect(glyphOf(shapes)).toEqual({ rings: 0, discs: 1, segments: 0, vertical: 0 });
    const studs = shapes.filter((s) => s.kind === 'circle' && s.fill === 'role' && s.r < 5);
    expect(studs).toHaveLength(6);
    // With no plate under it, it carries its own ground shadow.
    expect(shapes.filter((s) => s.fill === 'shadow')).toHaveLength(1);

    // No other shipped tower lies plateless, wears studs, or casts its shadow from its
    // head — proves the above is `'charge'`-specific, not a side effect of drawing a head.
    for (const towerId of ['basic', 'slow', 'splash', 'venom', 'stun', 'antiair', 'beacon']) {
      const other = drawnTowers([tower(towerId)]);
      expect(other.plates, towerId).toHaveLength(1);
      const ground = shapesOf(other.plates[0]!);
      expect(
        ground.some((s) => s.fill === 'plate') && ground.some((s) => s.stroke === 'rim'),
        towerId,
      ).toBe(true); // a real plate, rimmed — not the pad
      const os = shapesOf(other.heads[0]!);
      expect(
        os.filter((s) => s.kind === 'circle' && s.fill === 'role' && s.r < 5),
        towerId,
      ).toEqual([]);
      expect(
        os.some((s) => s.fill === 'shadow'),
        towerId,
      ).toBe(false);
    }
  });

  it('a pending (queued) mine draws its studded charge too, with no plate under it', () => {
    const calls = drawnPending('mine');
    const [picture] = artCallsOf(calls);
    expect(picture!.shapes.some((s) => s.fill === 'plate')).toBe(false);
    expect(glyphOf(picture!.shapes)).toEqual({ rings: 0, discs: 1, segments: 0, vertical: 0 });
    expect(
      picture!.shapes.filter((s) => s.kind === 'circle' && s.fill === 'role' && s.r < 5),
    ).toHaveLength(6);
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
    // The wingspan is 2 light strokes (apex→left, apex→right) over 2 ink strokes under them
    // (QC round 1, #181) — ADDITIONAL to the silhouette, never a replacement for it.
    expect(count(air.all, 'lineBetween')).toBe(4);
    const strokes = air.cues.flatMap((c, i) =>
      c.method === 'lineBetween'
        ? [
            {
              style: air.cues
                .slice(0, i)
                .filter((s) => s.method === 'lineStyle')
                .pop()!,
              c,
            },
          ]
        : [],
    );
    const [inkL, inkR, lightL, lightR] = strokes;
    // The ink first, in the art kit's ink, 1px wider on each side than the light stroke...
    for (const ink of [inkL!, inkR!]) expect(ink.style.args).toEqual([4, ART_INK, 1]);
    for (const light of [lightL!, lightR!]) expect(light.style.args).toEqual([2, PAL.airborne, 1]);
    // ... and run 1px past both ends of the light stroke it outlines: the same line, longer.
    for (const [ink, light] of [
      [inkL!, lightL!],
      [inkR!, lightR!],
    ] as const) {
      const [lx0, ly0, lx1, ly1] = light.c.args as number[];
      const [ix0, iy0, ix1, iy1] = ink.c.args as number[];
      const lightLen = Math.hypot(lx1! - lx0!, ly1! - ly0!);
      expect(Math.hypot(ix1! - ix0!, iy1! - iy0!)).toBeCloseTo(lightLen + 2, 9);
      expect(Math.hypot(ix0! - lx0!, iy0! - ly0!)).toBeCloseTo(1, 9); // past the apex
      expect(Math.hypot(ix1! - lx1!, iy1! - ly1!)).toBeCloseTo(1, 9); // past the tip
    }

    // Reduced motion changes nothing — the airborne cue carries no motion component.
    expect(
      count(drawnCreep(creep({ creepId: 'armored', domain: 'air' }), true).all, 'lineBetween'),
    ).toBe(4);

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

// A fractional dpr that puts footprint corners BETWEEN device pixels: 33px cells at dpr 1.25.
// The tower sprite's corner snaps to the nearest device pixel (`placement.ts`); the cues drawn
// around the tower must snap the same way or they drift off it. Two footprints tell rounding
// from both of its neighbours: (3,5) lands on device (217.5, 212.5), a half-pixel tie where
// round and ceil agree but floor does not; (2,4) lands on (176.25, 171.25), where round and
// floor agree but ceil does not.
describe('selection and aura shells at a fractional dpr — they follow the snapped sprite corner', () => {
  const FRAC = createProjection({
    cols: 28,
    rows: 24,
    cssWidth: 1074,
    cssHeight: 802,
    dpr: 1.25,
  });
  const FRAC_FRAMES = new Map(atlasFrameSpecs(FRAC.cellPx, FRAC.dpr).map((f) => [f.key, f]));

  /** Where `placeTowers` puts the tower's 2×2 footprint corner: a sprite's top-left plus its
   *  frame's anchor. A committed tower is two sprites, its plate and its head, each anchored
   *  at that corner — so both must give the same one. */
  function spriteCorner(t: TowerVM): { sx: number; sy: number } {
    const placed = placeTowers(vmWith([t]), EMPTY_OVERLAY, FRAC, FRAC_FRAMES);
    const [plate, head] = [placed.plates[0]!, placed.heads[0]!].map((p) => {
      const a = FRAC_FRAMES.get(p.frame)!;
      return { sx: p.x + a.anchorX, sy: p.y + a.anchorY };
    });
    expect(head).toEqual(plate);
    return plate!;
  }

  for (const at of [
    { col: 3, row: 5 },
    { col: 2, row: 4 },
  ]) {
    describe(`footprint (${at.col}, ${at.row})`, () => {
      it('is genuinely off the device grid (the fixture can tell snapping from not)', () => {
        const raw = FRAC.cellToPixel(at.col, at.row);
        expect(raw.x * 1.25).not.toBeCloseTo(Math.round(raw.x * 1.25), 3);
        expect(raw.y * 1.25).not.toBeCloseTo(Math.round(raw.y * 1.25), 3);
      });

      it('an attackless selection outline stays at inset 1 from the sprite corner', () => {
        const { sx, sy } = spriteCorner(tower('beacon', at));
        const g = fakeGraphics();
        drawSelection(
          g,
          PAL,
          {
            ...EMPTY_OVERLAY,
            selection: { ...at, rangeFp: null, blastRadiusFp: null, towerId: 'beacon' },
          },
          FRAC,
        );
        const outline = g.calls.find((c) => c.method === 'strokeRoundedRect')!;
        const size = FRAC.cellPx * 2;
        expect(outline.args.slice(0, 4)).toEqual([sx + 1, sy + 1, size - 2, size - 2]);
      });

      it('a range ring and its blast spokes are centred on the sprite footprint centre', () => {
        const { sx, sy } = spriteCorner(tower('splash', at));
        const g = fakeGraphics();
        drawSelection(
          g,
          PAL,
          {
            ...EMPTY_OVERLAY,
            selection: { ...at, rangeFp: 512, blastRadiusFp: 384, towerId: 'splash' },
          },
          FRAC,
        );
        const cx = sx + FRAC.cellPx;
        const cy = sy + FRAC.cellPx;
        const ring = g.calls.find((c) => c.method === 'strokeCircle')!;
        expect(ring.args.slice(0, 2)).toEqual([cx, cy]);
        // `drawCrosshair`: two vertical spokes on the centre's x, then two horizontal ones on
        // its y.
        const spokes = g.calls.filter((c) => c.method === 'lineBetween');
        expect(spokes).toHaveLength(4);
        for (const v of spokes.slice(0, 2)) expect([v.args[0], v.args[2]]).toEqual([cx, cx]);
        for (const h of spokes.slice(2)) expect([h.args[1], h.args[3]]).toEqual([cy, cy]);
      });

      it('an aura shell stays one cell out from the sprite footprint', () => {
        const beacon = tower('beacon', at);
        const { sx, sy } = spriteCorner(beacon);
        const g = fakeGraphics();
        drawAuraShells(g, PAL, vmWith([beacon]), EMPTY_OVERLAY, FRAC);
        const shell = g.calls.find((c) => c.method === 'strokeRoundedRect')!;
        const cell = FRAC.cellPx;
        expect(shell.args.slice(0, 4)).toEqual([
          sx - cell + 2,
          sy - cell + 2,
          cell * 4 - 4,
          cell * 4 - 4,
        ]);
      });
    });
  }
});
