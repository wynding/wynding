// creep-art.test.ts — the creeps' vector art, tested as DATA (visual pass C3/C4/B3, #181):
// each family's size step, a body per silhouette in its family's hue and an ink outline, no
// two silhouettes sharing an outline, a flyer's wings attached to its body and distinct in
// shape from every ring cue, the soft shadows, every colour token resolvable in every mode,
// and the wave strip's icons drawn from the same master at the board's size steps.

import { describe, it, expect } from 'vitest';
import { artBounds } from './art-geometry';
import { strokeWidthAt, type ArtShape } from './art-ir';
import {
  BOSS_OVER_ARMORED,
  CREEP_ART_R,
  CREEP_BODY,
  CREEP_ICON_HALF,
  CREEP_ICON_SCALE,
  CREEP_LIFT,
  CREEP_OUTLINE_MIN_PX,
  CREEP_SHADOW,
  CREEP_SHADOW_ALPHA,
  CREEP_SIZE,
  CREEP_WINGS,
  creepArtColour,
  creepBaseRadius,
  creepBodyArt,
  creepIconArt,
  creepLiftPx,
  creepRadius,
} from './creep-art';
import { CREEP_FAMILIES, CREEP_LOOKS, CREEP_SHAPE_VALUES, type CreepShape } from './creep-paint';
import { COLOUR_MODES, creepColour, resolvePalette } from './palette';
import { ART_INK, ART_SHADOW, artColour } from './tower-art';
import { covers, outline, overlap } from './test-support/outline-overlap';

/** The narrow compact floor's cell (`CELL_PX_MIN_NARROW`). */
const FLOOR_CELL = 10;
const CELLS = [FLOOR_CELL, 12, 16, 20, 28, 40, 64] as const;

describe('size steps — from the small swarm to the large boss (C3)', () => {
  it('takes the style frame’s steps: the swarm smallest, the boss largest', () => {
    expect(CREEP_SIZE).toEqual({
      swarm: 0.78,
      normal: 1,
      fast: 0.95,
      armored: 1.12,
      flying: 1,
      boss: 1.12 * 1.5,
    });
    const sizes = CREEP_FAMILIES.map((f) => CREEP_SIZE[f]);
    expect(Math.min(...sizes)).toBe(CREEP_SIZE.swarm);
    expect(Math.max(...sizes)).toBe(CREEP_SIZE.boss);
  });

  it('keeps the boss at 1.5× the armored creep’s radius at every cell size — size and hue tell the two hexagons apart (M2-S10)', () => {
    expect(BOSS_OVER_ARMORED).toBe(1.5);
    for (const cellPx of [4, 6, 8, 8.5, ...CELLS]) {
      expect(
        creepRadius(cellPx, 'boss') / creepRadius(cellPx, 'armored'),
        `${cellPx}px`,
      ).toBeCloseTo(1.5, 12);
    }
  });

  it('applies each step AFTER the 3px floor, never inside it — below cellPx ≈ 8.57 every family still keeps its own size', () => {
    for (const cellPx of [2, 5, 8]) {
      expect(creepBaseRadius(cellPx)).toBe(3); // the floor binds
      for (const family of CREEP_FAMILIES) {
        expect(creepRadius(cellPx, family), `${family} at ${cellPx}px`).toBe(
          3 * CREEP_SIZE[family],
        );
      }
    }
    expect(creepRadius(20, 'normal')).toBe(7);
    expect(creepRadius(20, 'swarm')).toBeCloseTo(7 * 0.78, 12);
  });

  it('lifts a flyer 0.9 of its radius above its true position, and a ground creep not at all', () => {
    expect(CREEP_LIFT / CREEP_ART_R).toBe(0.9);
    expect(creepLiftPx(7, true)).toBeCloseTo(6.3, 12);
    expect(creepLiftPx(7, false)).toBe(0);
  });
});

describe('bodies — the silhouette, the primary cue, in its family’s hue and an ink outline (C3)', () => {
  it('fills every silhouette in its family’s hue and outlines it in ink at the frame’s max(1.4px, 0.16·r), round-joined', () => {
    for (const shape of CREEP_SHAPE_VALUES) {
      const body = CREEP_BODY[shape];
      expect(body.fill, shape).toBe('family');
      expect(body.stroke, shape).toBe('ink');
      expect(body.join, shape).toBe('round');
      expect(body.alpha ?? 1, shape).toBe(1); // opaque: what the gates measure is what is drawn
      for (const r of [3 * 0.78, 3.5, 7, 12, 40]) {
        // `unit` = CSS px per design unit at radius r; `strokeWidthAt` answers in design units.
        const unit = r / CREEP_ART_R;
        expect(strokeWidthAt(body, unit) * unit, `${shape} at r=${r}`).toBeCloseTo(
          Math.max(CREEP_OUTLINE_MIN_PX, 0.16 * r),
          12,
        );
      }
    }
    expect(CREEP_OUTLINE_MIN_PX).toBe(1.4);
  });

  it('draws the style frame’s geometry: a triangle a little low of centre, a diamond, a rounded square, a pentagon and a FLAT-TOPPED hexagon', () => {
    const points = (shape: CreepShape): readonly (readonly [number, number])[] => {
      const s = CREEP_BODY[shape];
      if (s.kind !== 'polygon') throw new Error(`${shape} is not a polygon`);
      return s.points;
    };
    expect(points('triangle')).toEqual([
      [0, -9.4],
      [9.7, 7.4],
      [-9.7, 7.4],
    ]);
    expect(points('diamond')).toEqual([
      [0, -11],
      [11, 0],
      [0, 11],
      [-11, 0],
    ]);
    expect(CREEP_BODY.square).toMatchObject({
      kind: 'rect',
      x: -8.2,
      y: -8.2,
      w: 16.4,
      h: 16.4,
      rx: 1.8,
    });
    expect(points('pentagon')[0]).toEqual([0, -10]);
    expect(points('pentagon')).toHaveLength(5);
    // Flat-topped: a vertex at each side, and a flat edge across the top (the board drew it
    // point-up until the visual pass; the style frame draws it flat).
    const hex = points('hexagon');
    expect(hex).toHaveLength(6);
    expect(hex).toContainEqual([10, 0]);
    expect(hex).toContainEqual([-10, 0]);
    expect(hex.filter(([, y]) => y === Math.min(...hex.map((p) => p[1])))).toHaveLength(2);
  });

  /** The most two silhouettes' outlines may overlap — the art kit's bar, the one the tower
   *  heads are held to (`tower-art.test.ts`'s `MAX_OUTLINE_OVERLAP`). */
  const MAX_OUTLINE_OVERLAP = 0.88;
  const shapes = CREEP_SHAPE_VALUES;
  // Built while the suite is collected: rasterising outlines takes a while under coverage.
  const atDesign = new Map(shapes.map((s) => [s, outline([CREEP_BODY[s]])]));
  // At the narrow floor the outline's 1.4px floor is 0.4 of the radius — fatter against the
  // shape than at its design width, which can only pull outlines together.
  const atFloor = new Map(
    shapes.map((s) => [
      s,
      outline([CREEP_BODY[s]], 64, 0, creepRadius(FLOOR_CELL, 'normal') / CREEP_ART_R),
    ]),
  );
  const coarse = new Map(shapes.map((s) => [s, outline([CREEP_BODY[s]], 48, 1 / 3)]));
  const pairs: { a: CreepShape; b: CreepShape }[] = [];
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) pairs.push({ a: shapes[i]!, b: shapes[j]! });
  }

  it(`no two silhouettes share an outline — every pair overlaps less than ${MAX_OUTLINE_OVERLAP}, at design width and at the narrow floor`, () => {
    const table: string[] = [];
    for (const { a, b } of pairs) {
      const design = overlap(atDesign.get(a)!, atDesign.get(b)!);
      const floor = overlap(atFloor.get(a)!, atFloor.get(b)!);
      table.push(`${a}/${b}=${design.toFixed(3)}|${floor.toFixed(3)}`);
      expect(design, `${a} vs ${b}`).toBeLessThan(MAX_OUTLINE_OVERLAP);
      expect(floor, `${a} vs ${b} at the floor`).toBeLessThan(MAX_OUTLINE_OVERLAP);
    }
    console.info(`[creep-art.test] silhouette outline overlap (design|floor): ${table.join(' ')}`);
  });

  it('measures the outline, not the pixel grid: a coarser grid at a third-cell offset reads every pair the same', () => {
    for (const { a, b } of pairs) {
      const fine = overlap(atDesign.get(a)!, atDesign.get(b)!);
      const again = overlap(coarse.get(a)!, coarse.get(b)!);
      expect(Math.abs(again - fine), `${a} vs ${b}`).toBeLessThan(0.01);
    }
  });

  it('can fail: a near-copy — the pentagon squashed to 90% of its height — shares the pentagon’s outline', () => {
    const pentagon = CREEP_BODY.pentagon;
    if (pentagon.kind !== 'polygon') throw new Error('the pentagon is a polygon');
    const squashed: ArtShape = {
      ...pentagon,
      points: pentagon.points.map(([x, y]) => [x, y * 0.9] as const),
    };
    expect(overlap(outline([squashed]), atDesign.get('pentagon')!)).toBeGreaterThanOrEqual(
      MAX_OUTLINE_OVERLAP,
    );
  });
});

describe('wings — the airborne cue, attached to the body (C4)', () => {
  const [left, right] = CREEP_WINGS as [ArtShape, ArtShape];
  const pts = (s: ArtShape): readonly (readonly [number, number])[] => {
    if (s.kind !== 'polygon') throw new Error('a wing is a polygon');
    return s.points;
  };

  it('a creep on the ground has none; a flyer has two, drawn under its body', () => {
    for (const shape of CREEP_SHAPE_VALUES) {
      expect(creepBodyArt({ shape, airborne: false })).toEqual([CREEP_BODY[shape]]);
      expect(creepBodyArt({ shape, airborne: true })).toEqual([left, right, CREEP_BODY[shape]]);
    }
    // Baked art, made once per shape and domain: the same array every time it is asked for.
    expect(creepBodyArt({ shape: 'hexagon', airborne: true })).toBe(
      creepBodyArt({ shape: 'hexagon', airborne: true }),
    );
  });

  it('fills each wing in airborne and outlines it in ink — the light fill for dark ground, the ink edge for a light head or creep', () => {
    for (const wing of [left, right]) {
      expect(wing).toMatchObject({
        kind: 'polygon',
        fill: 'airborne',
        stroke: 'ink',
        join: 'round',
      });
      expect(wing.alpha ?? 1).toBe(1);
      // In CSS px: the 1px floor at r = 7, where the frame's 1.4 design units would be 0.98px…
      expect(strokeWidthAt(wing, 7 / CREEP_ART_R) * (7 / CREEP_ART_R)).toBeCloseTo(1, 12);
      // …and wider with the art.
      expect(strokeWidthAt(wing, 20 / CREEP_ART_R) * (20 / CREEP_ART_R)).toBeCloseTo(2.8, 12);
    }
    // Mirror images of each other across the body's vertical.
    expect(pts(right)).toEqual(pts(left).map(([x, y]) => [-x + 0, y]));
  });

  it('are ATTACHED: each wing’s root lies inside every silhouette, so it grows out of the body', () => {
    const fillOnly = (s: ArtShape): ArtShape => ({ ...s, stroke: undefined });
    for (const shape of CREEP_SHAPE_VALUES) {
      for (const wing of [left, right]) {
        const [rx, ry] = pts(wing)[0]!;
        expect(covers(fillOnly(CREEP_BODY[shape]), rx, ry), `${shape}: root (${rx}, ${ry})`).toBe(
          true,
        );
      }
    }
  });

  it('span about ±2r and rise 0.75r above the body’s centre, as the frame’s', () => {
    const b = artBounds([left, right], Infinity);
    expect(b.maxX - 0.7).toBeCloseTo(20.5, 9); // the tip, outline half-width aside
    expect(-b.minX - 0.7).toBeCloseTo(20.5, 9);
    expect(-b.minY - 0.7).toBeCloseTo(7.5, 9);
  });

  it('nothing a flyer draws floats away from it: its whole art, lifted, reaches under 2.3 of its own radii above its true position — under 0.8 of a cell up to the normal size', () => {
    // The chevron this replaced sat 3.4 radii above its creep — about 1.2 cells, in the cell
    // to the north, on whatever tower stood there (#181's C4). Measured in the creep's OWN
    // radii, since a look's size step scales all of its art: a boss is drawn 1.68× the
    // normal creep, so a flying boss (none ships) reaches past a cell above its true
    // position — its body alone, on the ground, reaches 0.6 of one — as one creature, wings
    // attached, not a mark on a tower. Up to the normal size step that is under 0.8 of a cell.
    const MAX_REACH_R = 2.3;
    const report: string[] = [];
    for (const look of CREEP_LOOKS.filter((l) => l.airborne)) {
      for (const cellPx of CELLS) {
        const r = creepRadius(cellPx, look.family);
        const unit = r / CREEP_ART_R;
        const top = (CREEP_LIFT - artBounds(creepBodyArt(look), unit).minY) * unit;
        const at = `${look.shape}:${look.family} at ${cellPx}px`;
        expect(top / r, at).toBeLessThan(MAX_REACH_R);
        if (CREEP_SIZE[look.family] <= 1) expect(top / cellPx, at).toBeLessThan(0.8);
        if (cellPx === FLOOR_CELL || cellPx === 40) {
          report.push(
            `${look.shape}:${look.family}@${cellPx}=${(top / r).toFixed(2)}r/${(top / cellPx).toFixed(2)}c`,
          );
        }
      }
    }
    console.info(`[creep-art.test] a flyer's art above its true position: ${report.join(' ')}`);
  });

  it('are distinct in SHAPE from every ring cue: straight-edged triangles beside the body, never a curve around it', () => {
    for (const wing of [left, right]) {
      const p = pts(wing);
      expect(p).toHaveLength(3); // three straight edges, three corners
      // Every status cue is a circle centred on the body — a ring, or the pips on one. A
      // wing's corners lie at very different distances from that centre, so no ring traces
      // its outline…
      const dist = p.map(([x, y]) => Math.hypot(x, y));
      expect(Math.max(...dist) / Math.min(...dist)).toBeGreaterThan(2.5);
      // …and it lies wholly to one side of the body, seen from the centre across a narrow
      // angle, where a ring goes all the way round.
      const side = Math.sign(p[0]![0]);
      for (const [x] of p) expect(Math.sign(x)).toBe(side);
      const angles = p.map(([x, y]) => Math.atan2(y, side * x));
      const span = ((Math.max(...angles) - Math.min(...angles)) * 180) / Math.PI;
      expect(span).toBeLessThan(45);
    }
  });
});

describe('shadows — soft, on the ground (B3)', () => {
  it('lays one translucent ellipse under each creep, down and to the right of its true position — never stroked', () => {
    for (const domain of ['ground', 'air'] as const) {
      const [shadow, ...rest] = CREEP_SHADOW[domain];
      expect(rest).toHaveLength(0);
      expect(shadow).toMatchObject({
        kind: 'ellipse',
        fill: 'shadow',
        alpha: CREEP_SHADOW_ALPHA[domain],
      });
      expect(shadow!.stroke).toBeUndefined();
      if (shadow!.kind !== 'ellipse') throw new Error('a shadow is an ellipse');
      expect(shadow!.cx).toBeGreaterThan(0); // the light falls from the upper left, as on the towers
      expect(shadow!.cy).toBeGreaterThan(0);
      expect(shadow!.alpha).toBeLessThan(0.5); // decorative: dark on a dark floor, outside every gate
    }
  });

  it('a flyer’s shadow is smaller and fainter than a walking creep’s — it falls further from a lifted body', () => {
    const [ground] = CREEP_SHADOW.ground;
    const [air] = CREEP_SHADOW.air;
    if (ground!.kind !== 'ellipse' || air!.kind !== 'ellipse') throw new Error('ellipses');
    expect(air!.rx).toBeLessThan(ground!.rx);
    expect(air!.ry).toBeLessThan(ground!.ry);
    expect(CREEP_SHADOW_ALPHA.air).toBeLessThan(CREEP_SHADOW_ALPHA.ground);
    // …and it sits further from the lifted body than a walking creep's from its own.
    expect(air!.cy + CREEP_LIFT).toBeGreaterThan(ground!.cy);
  });
});

describe('creepArtColour — four colours, resolved per mode', () => {
  it('resolves the family hue, the wings’ airborne fill and the art kit’s ink and shadow, in every mode', () => {
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      for (const family of CREEP_FAMILIES) {
        expect(creepArtColour('family', pal, family)).toBe(creepColour(pal, family));
        expect(creepArtColour('airborne', pal, family)).toBe(pal.airborne);
        expect(creepArtColour('ink', pal, family)).toBe(ART_INK);
        expect(creepArtColour('shadow', pal, family)).toBe(ART_SHADOW);
      }
    }
  });

  it('throws for a tower’s colour, and tower art throws for a creep’s — art is code, and a stray token is a bug', () => {
    const pal = resolvePalette('default');
    for (const token of ['plate', 'rim', 'role', 'gloss', 'scorch'] as const) {
      expect(() => creepArtColour(token, pal, 'normal')).toThrow(
        `creep art has no '${token}' colour`,
      );
    }
    for (const token of ['family', 'airborne'] as const) {
      expect(() => artColour(token, pal, 'damage')).toThrow(`tower art has no '${token}' colour`);
    }
  });
});

describe('wave-strip icons — the board’s own creep art, as the DOM draws it', () => {
  it('draws a look’s BODY art — wings and silhouette — without the board’s shadow and lift', () => {
    for (const look of CREEP_LOOKS) {
      expect(creepIconArt(look).shapes).toBe(creepBodyArt(look));
    }
  });

  it('one scale for every icon: every look on the ground fits the icon’s box, outline included, and the largest fills it', () => {
    let largest = 0;
    for (const look of CREEP_LOOKS.filter((l) => !l.airborne)) {
      const { shapes, scale } = creepIconArt(look);
      const b = artBounds(shapes, Infinity);
      const reach = Math.max(-b.minX, b.maxX, -b.minY, b.maxY) * scale;
      expect(reach, `${look.shape}:${look.family}`).toBeLessThanOrEqual(CREEP_ICON_HALF + 1e-9);
      largest = Math.max(largest, reach);
    }
    expect(largest).toBeCloseTo(CREEP_ICON_HALF, 9);
    expect(CREEP_ICON_HALF).toBe(10); // the icons' shared `viewBox="-10 -10 20 20"`
  });

  it('keeps the board’s size steps: each icon’s scale is the shared scale times its family’s step', () => {
    for (const look of CREEP_LOOKS) {
      expect(creepIconArt(look).scale).toBeCloseTo(CREEP_ICON_SCALE * CREEP_SIZE[look.family], 12);
    }
    const scaleOf = (family: (typeof CREEP_FAMILIES)[number]): number =>
      creepIconArt(CREEP_LOOKS.find((l) => l.family === family && !l.airborne)!).scale;
    expect(scaleOf('boss') / scaleOf('armored')).toBeCloseTo(BOSS_OVER_ARMORED, 12);
    expect(Math.min(...CREEP_FAMILIES.map(scaleOf))).toBe(scaleOf('swarm'));
  });
});
