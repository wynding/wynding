// tower-art.test.ts — the towers' vector art, tested as DATA (visual pass T1/T2/T4/B3, #181):
// a head for every mark, the role colour as the head's fill, every colour token resolvable in
// every mode, the paint combinations the painter is exact for, heads inside their footprint
// and the aiming ones pointing up, the boost glow on the plate, the pending rim dashed, the
// mine's pad — and the T1 promise itself: no two heads share an outline.

import { describe, it, expect } from 'vitest';
import { artBounds, shapeOutline, type Point, type Polyline } from './art-geometry';
import { alignRectToTexels, strokeWidthAt, type ArtShape } from './art-ir';
import {
  ART_BOX,
  ART_INK,
  BOOST_ART,
  BOOST_RING_ALPHA,
  HEAD_ART,
  PAD_ART,
  PENDING_ALPHA,
  PENDING_PLATE_ALPHA,
  PENDING_PLATE_ART,
  PENDING_RIM_ART,
  PLATE_ART,
  PLATE_RECT,
  SCORCH_ART,
  artColour,
} from './tower-art';
import { COLOUR_MODES, resolvePalette, roleColour } from './palette';
import {
  TOWER_FOOTPRINT_MARKS,
  TOWER_LOOKS,
  TOWER_ROLES,
  towerLookFor,
  type TowerFootprintMark,
} from './tower-paint';

const ALL_ART: readonly (readonly [string, readonly ArtShape[]])[] = [
  ['plate', PLATE_ART],
  ['pad', PAD_ART],
  ['pending plate', PENDING_PLATE_ART],
  ['pending rim', PENDING_RIM_ART],
  ['boost', BOOST_ART],
  ['scorch', SCORCH_ART],
  ...TOWER_FOOTPRINT_MARKS.map((m): [string, readonly ArtShape[]] => [
    `head ${m}`,
    HEAD_ART[m].shapes,
  ]),
];

// ---- A small rasterizer: what a head COVERS, sampled on a grid ----

/** Even-odd point-in-polygon over a set of rings. */
function insideRings(x: number, y: number, rings: readonly (readonly Point[])[]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function distToSegment(x: number, y: number, a: Point, b: Point): number {
  const [ax, ay] = a;
  const dx = b[0] - ax;
  const dy = b[1] - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function nearStroke(x: number, y: number, lines: readonly Polyline[], half: number): boolean {
  for (const { points, closed } of lines) {
    const n = points.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      if (distToSegment(x, y, points[i]!, points[(i + 1) % n]!) <= half) return true;
    }
  }
  return false;
}

/** A head's OUTLINE as fractional coverage of an `n`×`n` grid laid over its own bounding
 *  box: scaled uniformly (aspect kept) so the box's longer side spans the grid, centred, and
 *  shifted by `offset` of a grid cell. Each cell is supersampled 4×4 over every visible shape
 *  — fills, and strokes at their design width — so a cell an edge crosses counts the share
 *  of it covered. Shadows are not part of a silhouette (dark on the dark floor).
 *
 *  Normalising to the box makes this measure SHAPE — not size, which a copy at 90% of the
 *  size only changes (a footprint-sized raster scored such a copy as a different outline),
 *  and not where edges fall on the pixel grid (a footprint-sized raster at a phone's 26px
 *  swung splash against frost-splash from 0.82 to 0.91 between 20px and 33px). The measure
 *  itself is pinned grid-independent below. */
function outline(shapes: readonly ArtShape[], n = 64, offset = 0): Float64Array {
  const visible = shapes.filter((s) => s.fill !== 'shadow');
  const b = artBounds(visible, Infinity); // Infinity: strokes at their design width
  const side = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const x0 = (b.minX + b.maxX) / 2 - side / 2 - (offset * side) / n;
  const y0 = (b.minY + b.maxY) / 2 - side / 2 - (offset * side) / n;
  const prepared = visible.map((s) => {
    const lines = shapeOutline(s);
    return {
      rings: s.fill === undefined ? null : lines.map((l) => l.points),
      half: s.stroke === undefined ? -1 : strokeWidthAt(s, Infinity) / 2,
      lines,
    };
  });
  const SS = 4;
  const out = new Float64Array(n * n);
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = x0 + ((px + (sx + 0.5) / SS) * side) / n;
          const y = y0 + ((py + (sy + 0.5) / SS) * side) / n;
          if (
            prepared.some(
              (p) =>
                (p.rings !== null && insideRings(x, y, p.rings)) ||
                (p.half >= 0 && nearStroke(x, y, p.lines, p.half)),
            )
          ) {
            hits++;
          }
        }
      }
      out[py * n + px] = hits / (SS * SS);
    }
  }
  return out;
}

/** How much two outlines overlap: soft intersection over union of their coverage, Σmin/Σmax
 *  — 1 for one outline twice, falling as they differ. */
function overlap(a: Float64Array, b: Float64Array): number {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < a.length; i++) {
    lo += Math.min(a[i]!, b[i]!);
    hi += Math.max(a[i]!, b[i]!);
  }
  return lo / hi;
}

/** The most any two heads' outlines may overlap. Measured, closest first: basic's ring with
 *  its barrel against venom's droplet, 0.85 (each a round body with a point straight up —
 *  and each its own colour and glyph); then splash's octagon against frost-splash's plus,
 *  0.72 (0.83 with the plus's first, broader arms, which this bar would still have passed but
 *  not clearly — so the arms were slimmed). Controls that must FAIL it, below: stun's
 *  diamond at 90% of its size (0.99 — scale is not shape), the style frame's own
 *  frost-splash against splash (1.00 — splash's octagon with another glyph inside), and
 *  stun's diamond squashed to 90% of its height (0.90 — a near-copy of an outline). */
const MAX_OUTLINE_OVERLAP = 0.88;

/** The most two heads of ONE role may overlap — they share a colour, so outline and glyph are
 *  all that tell them apart at a glance. The closest such pair is slow's star and stun's
 *  diamond, 0.71 (their glyphs differ too — a ring, a zigzag); stun's diamond squashed to 85%
 *  of its height scores 0.86 against the original. */
const MAX_SAME_ROLE_OVERLAP = 0.75;

/** Stun's diamond — the outline of the head the near-copy controls copy — scaled by `kx`
 *  across and `ky` down, about the footprint centre. */
function scaledDiamond(kx: number, ky: number): ArtShape {
  const diamond = HEAD_ART.bolt.shapes[0]!;
  if (diamond.kind !== 'polygon') throw new Error('stun’s outline is a polygon');
  const C = ART_BOX / 2;
  return {
    ...diamond,
    points: diamond.points.map(([x, y]) => [C + (x - C) * kx, C + (y - C) * ky] as const),
  };
}

describe('silhouettes — T1: an outline per tower', () => {
  const marks = TOWER_FOOTPRINT_MARKS;
  const outlines = new Map(marks.map((m) => [m, outline(HEAD_ART[m].shapes)]));
  const roleOf = (m: TowerFootprintMark): string => TOWER_LOOKS.find((l) => l.mark === m)!.role;
  const pairs: { a: TowerFootprintMark; b: TowerFootprintMark; overlap: number }[] = [];
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const a = marks[i]!;
      const b = marks[j]!;
      pairs.push({ a, b, overlap: overlap(outlines.get(a)!, outlines.get(b)!) });
    }
  }

  it('measures the outline, not the pixel grid: a coarser grid at a third-cell offset reads every pair the same', () => {
    const coarse = new Map(marks.map((m) => [m, outline(HEAD_ART[m].shapes, 48, 1 / 3)]));
    for (const p of pairs) {
      const again = overlap(coarse.get(p.a)!, coarse.get(p.b)!);
      expect(Math.abs(again - p.overlap), `${p.a} vs ${p.b}`).toBeLessThan(0.01);
    }
  });

  it(`no two heads share an outline — every pair overlaps less than ${MAX_OUTLINE_OVERLAP}`, () => {
    const table = [...pairs]
      .sort((x, y) => y.overlap - x.overlap)
      .map((p) => `${p.a}/${p.b}=${p.overlap.toFixed(3)}`)
      .join(' ');
    console.info(`[tower-art.test] head outline overlap, highest first: ${table}`);
    for (const p of pairs) {
      expect(p.overlap, `${p.a} vs ${p.b}`).toBeLessThan(MAX_OUTLINE_OVERLAP);
    }
  });

  it(`heads of one role — the three control heads among them — overlap at most ${MAX_SAME_ROLE_OVERLAP}`, () => {
    const same = pairs.filter((p) => roleOf(p.a) === roleOf(p.b));
    // The pairs this bar is about, pinned so it cannot pass by matching nothing: slow, stun
    // and frost-splash share the control colour, basic and splash the damage one.
    expect(same.map((p) => `${p.a}/${p.b}`)).toEqual([
      'plain/crosshair',
      'ringed/bolt',
      'ringed/ringed-crosshair',
      'bolt/ringed-crosshair',
    ]);
    for (const p of same) {
      expect(p.overlap, `${p.a} vs ${p.b}`).toBeLessThanOrEqual(MAX_SAME_ROLE_OVERLAP);
    }
  });

  it('can fail: the style frame’s own frost-splash — splash’s octagon — shares splash’s outline', () => {
    // The frame drew frost-splash as splash's octagon with its own glyph inside, the case T1's
    // "an outline per tower" rules out. Rebuilt from splash's outline and frost-splash's glyph:
    const frameFrost: ArtShape[] = [
      HEAD_ART.crosshair.shapes[0]!,
      ...HEAD_ART['ringed-crosshair'].shapes.slice(1),
    ];
    expect(overlap(outline(frameFrost), outlines.get('crosshair')!)).toBeGreaterThanOrEqual(
      MAX_OUTLINE_OVERLAP,
    );
  });

  it('can fail: near-copies of a head — stun’s diamond at 90% of its size, and squashed to 90% and 85% of its height', () => {
    const diamond = outline([scaledDiamond(1, 1)]);
    const against = (kx: number, ky: number): number =>
      overlap(outline([scaledDiamond(kx, ky)]), diamond);
    // A smaller copy is the same outline — the measure is blind to size, by design.
    expect(against(0.9, 0.9)).toBeGreaterThanOrEqual(MAX_OUTLINE_OVERLAP);
    // A 10% change of proportion is still too close to pass for a different outline...
    expect(against(1, 0.9)).toBeGreaterThanOrEqual(MAX_OUTLINE_OVERLAP);
    // ... and 15% is too close for two heads that share a colour.
    expect(against(1, 0.85)).toBeGreaterThan(MAX_SAME_ROLE_OVERLAP);
  });
});

describe('heads — one per look, role-coloured, outlined in ink', () => {
  it('every mark has a head, and only the mine’s stands without a plate', () => {
    for (const m of TOWER_FOOTPRINT_MARKS) expect(HEAD_ART[m].shapes.length).toBeGreaterThan(0);
    expect(TOWER_FOOTPRINT_MARKS.filter((m) => !HEAD_ART[m].plate)).toEqual(['charge']);
  });

  it('every head is filled in its role colour and outlined in ink', () => {
    for (const m of TOWER_FOOTPRINT_MARKS) {
      const shapes = HEAD_ART[m].shapes;
      expect(
        shapes.some((s) => s.fill === 'role' && s.stroke === 'ink'),
        m,
      ).toBe(true);
    }
  });

  it('every head stays inside its own footprint, strokes included, at every cell size', () => {
    for (const cellPx of [10, 13, 30, 60]) {
      const unit = (2 * cellPx) / ART_BOX;
      for (const m of TOWER_FOOTPRINT_MARKS) {
        const b = artBounds(HEAD_ART[m].shapes, unit);
        expect(b.minX, m).toBeGreaterThanOrEqual(0);
        expect(b.minY, m).toBeGreaterThanOrEqual(0);
        expect(b.maxX, m).toBeLessThanOrEqual(ART_BOX);
        expect(b.maxY, m).toBeLessThanOrEqual(ART_BOX);
      }
    }
  });

  it('the area-effect heads stay inside 0.6 of a cell along the axes, where the selection’s blast spokes begin', () => {
    // `drawSelection` draws a selected splash or frost-splash's blast as four spokes along
    // the axes, starting 0.4 × the 1.5-tile blast = 0.6 of a cell out; held inside that,
    // the head never hides a spoke's start (`board-draw.ts` states the clearance).
    const cell = ART_BOX / 2;
    for (const id of ['splash', 'frost-splash']) {
      const b = artBounds(HEAD_ART[towerLookFor(id).mark].shapes, 1);
      const reach = Math.max(cell - b.minX, b.maxX - cell, cell - b.minY, b.maxY - cell);
      expect(reach / cell, id).toBeLessThan(0.6);
    }
  });

  it('the heads that will aim point UP, symmetric about the footprint’s vertical centre line', () => {
    // basic, venom, stun and antiair turn toward their target in a later pass, about the
    // footprint centre; drawn at aim angle 0 their tip is straight up and nothing reaches
    // further from the centre.
    const C = ART_BOX / 2;
    for (const id of ['basic', 'venom', 'stun', 'antiair']) {
      const { mark } = towerLookFor(id);
      const body = HEAD_ART[mark].shapes.filter((s) => s.fill === 'role');
      const pts = body.flatMap((s) => shapeOutline(s).flatMap((l) => l.points));
      const top = pts.reduce((best, p) => (p[1] < best[1] ? p : best));
      expect(Math.abs(top[0] - C), id).toBeLessThan(3.6); // basic's barrel is 7 wide
      expect(top[1], id).toBeLessThan(C);
      const reach = (p: Point): number => Math.hypot(p[0] - C, p[1] - C);
      const tipReach = Math.max(
        ...pts.filter((p) => Math.abs(p[0] - C) < 3.6 && p[1] < C).map(reach),
      );
      for (const p of pts) expect(reach(p), id).toBeLessThanOrEqual(tipReach + 1e-9);
      // Mirror-symmetric silhouette: the body's extents match on both sides of the line.
      const xs = pts.map(([x]) => x);
      expect(Math.min(...xs) + Math.max(...xs), id).toBeCloseTo(2 * C, 6);
    }
  });
});

describe('colours — tokens every mode can resolve', () => {
  it('every token in every piece of art resolves to a colour, in every mode, for every role', () => {
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      for (const role of TOWER_ROLES) {
        for (const [name, shapes] of ALL_ART) {
          for (const s of shapes) {
            for (const token of [s.fill, s.stroke]) {
              if (token === undefined) continue;
              const c = artColour(token, pal, role);
              expect(Number.isInteger(c) && c >= 0 && c <= 0xffffff, `${name} ${token}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it('maps the palette tokens to their keys, and the role to the role’s colour', () => {
    const pal = resolvePalette('protan');
    expect(artColour('role', pal, 'poison')).toBe(roleColour(pal, 'poison'));
    expect(artColour('plate', pal, 'damage')).toBe(pal.plate);
    expect(artColour('rim', pal, 'damage')).toBe(pal.tower);
    expect(artColour('aura', pal, 'damage')).toBe(pal.aura);
    expect(artColour('ink', pal, 'damage')).toBe(ART_INK);
    expect(artColour('floor', pal, 'burst')).toBe(pal.floor);
  });

  it('only a head asks for the role colour — plate, pad, glow, rim and scorch never do', () => {
    for (const [name, shapes] of ALL_ART) {
      if (name.startsWith('head')) continue;
      for (const s of shapes) expect([s.fill, s.stroke], name).not.toContain('role');
    }
  });
});

describe('paint the painter is exact for', () => {
  it('no shape both fills and strokes below full opacity (alpha rides in each colour)', () => {
    for (const [name, shapes] of ALL_ART) {
      for (const s of shapes) {
        const both = s.fill !== undefined && s.stroke !== undefined;
        expect(both && (s.alpha ?? 1) < 1, name).toBe(false);
      }
    }
  });

  it('every stroke that turns a corner joins round, and no open stroke has square caps', () => {
    // `artBounds` grows a stroke by half its width — exact for round joins and caps, and the
    // frames are sized from it.
    const turnsACorner = (line: Polyline): boolean => {
      const pts = line.points;
      const n = pts.length;
      const count = line.closed ? n : n - 2;
      for (let i = 0; i < count; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % n]!;
        const c = pts[(i + 2) % n]!;
        const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
        let turn = Math.abs(t2 - t1);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn > Math.PI / 6) return true;
      }
      return false;
    };
    for (const [name, shapes] of ALL_ART) {
      for (const s of shapes) {
        if (s.stroke === undefined) continue;
        expect(s.cap, name).not.toBe('square');
        if (s.kind === 'rect' || s.kind === 'circle' || s.kind === 'ellipse') continue;
        if (shapeOutline(s).some(turnsACorner)) expect(s.join, `${name} ${s.kind}`).toBe('round');
      }
    }
  });
});

describe('the plate, the boost glow and the pending rim', () => {
  const plateInnerEdge = (unit: number): number => {
    const rim = PLATE_ART.find((s) => s.stroke === 'rim')!;
    // The nearest the plate's inner rim edge comes to the centre: the middle of a side.
    return PLATE_RECT.w / 2 - strokeWidthAt(rim, unit) / 2;
  };

  it('the plate is inset 3/64 of the footprint and rimmed — the rim is what the floor gate guards', () => {
    expect(PLATE_RECT).toEqual({ x: 3, y: 3, w: 58, h: 58, rx: 9 });
    // The slate plate and its rim are the same rectangle, as two shapes — so that drawing
    // the rim crisp moves the rim alone — and the rim is drawn over the plate's edge.
    const plate = PLATE_ART.find((s) => s.fill === 'plate')!;
    const rim = PLATE_ART.find((s) => s.stroke === 'rim')!;
    expect(plate).toMatchObject({ kind: 'rect', ...PLATE_RECT });
    expect(plate.stroke).toBeUndefined();
    expect(rim).toMatchObject({ kind: 'rect', ...PLATE_RECT, crisp: true });
    expect(rim.fill).toBeUndefined();
    expect(PLATE_ART.indexOf(rim)).toBeGreaterThan(PLATE_ART.indexOf(plate));
    // Never thinner than one CSS px in the design, at any cell size ...
    for (const cellPx of [1, 10, 13, 30]) {
      const unit = (2 * cellPx) / ART_BOX;
      expect(strokeWidthAt(rim, unit) * unit).toBeGreaterThanOrEqual(1 - 1e-9);
    }
    // ... and, baked crisp, a whole number of device pixels and never fewer than one.
    if (rim.kind !== 'rect') throw new Error('the rim is a rect');
    for (const [cellPx, scale] of [
      [10, 1],
      [10, 1.25],
      [13, 1.5],
      [13, 2],
      [30, 3],
    ] as const) {
      const unit = (2 * cellPx) / ART_BOX;
      const baked = strokeWidthAt(alignRectToTexels(rim, unit, scale), unit) * unit * scale;
      expect(baked, `${cellPx}px at dpr ${scale}`).toBeCloseTo(Math.round(baked), 9);
      expect(baked, `${cellPx}px at dpr ${scale}`).toBeGreaterThanOrEqual(1 - 1e-9);
    }
  });

  it('the boost glow lies wholly on the plate — inside its rim — at every supported cell size', () => {
    // The glow's colour is gated against the PLATE (palette.test.ts), so it must not reach
    // the rim or the floor: measured to each ring's outer stroke edge, floor applied.
    for (const cellPx of [10, 13, 30, 60]) {
      const unit = (2 * cellPx) / ART_BOX;
      expect(BOOST_ART).toHaveLength(2);
      for (const ring of BOOST_ART) {
        expect(ring.kind).toBe('circle');
        if (ring.kind !== 'circle') continue;
        expect([ring.cx, ring.cy]).toEqual([ART_BOX / 2, ART_BOX / 2]);
        expect(ring.r + strokeWidthAt(ring, unit) / 2, `cellPx ${cellPx}`).toBeLessThan(
          plateInnerEdge(unit),
        );
      }
    }
  });

  it('the glow shows around almost all of every head a beacon can boost — drawn under the head, it is hidden only where an aiming head’s tip crosses it', () => {
    // A beacon boosts towers that attack (the sim's rule; a beacon is never boosted), so
    // every look but the beacon's can wear the glow. Sampled along the inner ring's centre
    // line: the share of it no head shape covers.
    const inner = BOOST_ART[0]!;
    if (inner.kind !== 'circle') throw new Error('the glow is rings');
    const N = 720;
    const shown: string[] = [];
    for (const look of TOWER_LOOKS.filter((l) => l.role !== 'support')) {
      const prepared = HEAD_ART[look.mark].shapes
        .filter((s) => s.fill !== 'shadow')
        .map((s) => ({
          fills: s.fill !== undefined,
          half: s.stroke === undefined ? -1 : strokeWidthAt(s, 1) / 2,
          lines: shapeOutline(s),
        }));
      let covered = 0;
      for (let k = 0; k < N; k++) {
        const t = (2 * Math.PI * k) / N;
        const x = inner.cx + inner.r * Math.cos(t);
        const y = inner.cy + inner.r * Math.sin(t);
        if (
          prepared.some(
            (p) =>
              (p.fills &&
                insideRings(
                  x,
                  y,
                  p.lines.map((l) => l.points),
                )) ||
              (p.half >= 0 && nearStroke(x, y, p.lines, p.half)),
          )
        ) {
          covered++;
        }
      }
      const share = 1 - covered / N;
      shown.push(`${look.mark}=${share.toFixed(3)}`);
      expect(share, look.mark).toBeGreaterThanOrEqual(0.9);
    }
    console.info(`[tower-art.test] boost ring shown around each head: ${shown.join(' ')}`);
  });

  it('the glow is two aura rings, the inner one the opaque cue at least a CSS px wide', () => {
    const [inner, outer] = BOOST_ART as [ArtShape, ArtShape];
    expect(inner.stroke).toBe('aura');
    expect(outer.stroke).toBe('aura');
    expect(inner.fill).toBeUndefined();
    expect(inner.minWidthPx).toBe(1);
    expect(inner.alpha).toBeGreaterThan(outer.alpha ?? 1);
    // The opacity the palette gate composites the cue at is the one actually painted.
    expect(inner.alpha).toBe(BOOST_RING_ALPHA);
  });

  it('the mine’s pad is the plate’s own rectangle, opaque in the floor colour — no rim, shadow or bevel', () => {
    expect(PAD_ART).toEqual([{ kind: 'rect', ...PLATE_RECT, fill: 'floor' }]);
    // Opaque, so whatever lies under it — an aura shell — is hidden, as a plate hides it.
    expect(PAD_ART[0]!.alpha ?? 1).toBe(1);
  });

  it('a pending build fades to a part-opacity picture — its plate further than its head — and draws a DASHED rim on top', () => {
    expect(PENDING_ALPHA).toBeGreaterThan(0);
    expect(PENDING_ALPHA).toBeLessThan(1);
    expect(PENDING_PLATE_ALPHA).toBeGreaterThan(0);
    expect(PENDING_PLATE_ALPHA).toBeLessThan(PENDING_ALPHA);
    expect(PENDING_RIM_ART).toHaveLength(1);
    const rim = PENDING_RIM_ART[0]!;
    expect(rim).toMatchObject({ kind: 'rect', ...PLATE_RECT, stroke: 'rim' });
    expect(rim.fill).toBeUndefined();
    expect(rim.alpha ?? 1).toBe(1);
    expect(rim.dash?.length).toBeGreaterThanOrEqual(2);
    expect(rim.dashMinPx).toBeGreaterThan(0);
    // The plate under a pending build has no solid rim of its own to blur the dashes.
    expect(PENDING_PLATE_ART.some((s) => s.stroke === 'rim')).toBe(false);
    expect(PENDING_PLATE_ART.some((s) => s.fill === 'plate')).toBe(true);
  });

  it('the scorch is centred on the footprint and stays inside it', () => {
    const b = artBounds(SCORCH_ART, 1);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(ART_BOX / 2, 1);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(ART_BOX / 2, 1);
    expect(b.minX).toBeGreaterThanOrEqual(0);
    expect(b.minY).toBeGreaterThanOrEqual(0);
    expect(b.maxX).toBeLessThanOrEqual(ART_BOX);
    expect(b.maxY).toBeLessThanOrEqual(ART_BOX);
  });
});
