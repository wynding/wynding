// hud-icons.test.ts — the HUD's inline-SVG icons (#181 H1 + L1).
//
// THE CREEP ICONS' GEOMETRY. `hud-icons.ts` asks the render package which silhouette a creep
// draws (`creepShapeFor` / `creepSilhouettePaintOp`, both exported) and translates that shape
// into SVG vertices itself, because the package exports no painter. That translation is pinned
// here to FIXED geometry: every shape's vertices at the icon's radius, the boss size step and
// the airborne chevron's proportions, recorded from the board's own painters when the board art
// was baked into its atlas (#182) and checked against them then (#181 QC round 2). This file
// imports nothing from inside the render package — a test that reached into its source by
// relative path broke when that source moved, and typechecks against the package's built
// declarations, not its source. So a change to the BOARD's creep art does not fail here; the
// render package's own tests own its painters. A new SHAPE does: the table is keyed on the
// exported `CreepShape` union, so a sixth shape is a type error until it has geometry here.

import { describe, it, expect } from 'vitest';
import {
  COLOUR_MODES,
  creepShapeFor,
  creepSilhouettePaintOp,
  resolvePalette,
  type CreepShape,
  type CreepSilhouettePaintOp,
} from '@wynding/render';
import { compileRuleset } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from '@wynding/content';
import {
  CHEVRON_DROP,
  CHEVRON_GAP,
  CHEVRON_HALF_SPAN,
  CREEP_ICON_BOSS_SCALE,
  CREEP_ICON_R,
  ICON_VIEWBOX,
  dialDash,
  chevronPoints,
  chipIcon,
  countdownDial,
  creepIcon,
  hexColour,
  paintCreepIcon,
  silhouettePoints,
  type ChipIconKind,
} from './hud-icons';

const bundle = getBundledRuleset();
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
/** Every creep the shipped content can preview, plus an id the catalog does not know (the
 *  board falls back to its triangle for it, and so must the icon). */
const CREEP_IDS = [...Object.keys(ruleset.creepById), 'not-a-catalog-creep'];

type Point = readonly [number, number];

/** The board's silhouettes at the icon's radius (6), apex up, centred on the origin — recorded
 *  from the board's frame painter at #182 (see the header). Literal numbers, not the icon's own
 *  trigonometry restated: the regular shapes' vertices sit at 60° (hexagon) and 72° (pentagon)
 *  steps from twelve o'clock. */
const BOARD_SILHOUETTE_AT_6: Readonly<Record<CreepShape, readonly Point[]>> = {
  triangle: [
    [0, -6],
    [6, 6],
    [-6, 6],
  ],
  diamond: [
    [0, -6],
    [6, 0],
    [0, 6],
    [-6, 0],
  ],
  square: [
    [-6, -6],
    [6, -6],
    [6, 6],
    [-6, 6],
  ],
  pentagon: [
    [0, -6],
    [5.706339, -1.854102],
    [3.526712, 4.854102],
    [-3.526712, 4.854102],
    [-5.706339, -1.854102],
  ],
  hexagon: [
    [0, -6],
    [5.196152, -3],
    [5.196152, 3],
    [0, 6],
    [-5.196152, 3],
    [-5.196152, -3],
  ],
};
const SHAPES = Object.keys(BOARD_SILHOUETTE_AT_6) as CreepShape[];

/** The board's boss size step, recorded at #182: a boss is its silhouette at 1.5× the radius —
 *  size being the board's only boss cue. */
const BOARD_BOSS_SCALE = 1.5;

/** The board's airborne chevron at #182, as fractions of r: the wingtips' half-span and their
 *  drop below the apex. */
const BOARD_CHEVRON = { halfSpan: 0.9, drop: 0.3 } as const;

/** A vertex SET, order-free and rounded, so a polygon compares as a shape whatever vertex it
 *  starts from. */
function vertexSet(points: readonly Point[], digits = 6): string[] {
  const k = 10 ** digits;
  const norm = (v: number): number => Math.round(v * k) / k + 0; // `+ 0` folds -0 into 0
  return [...new Set(points.map(([x, y]) => `${norm(x)},${norm(y)}`))].sort();
}

function parsePoints(attr: string | null): Point[] {
  return (attr ?? '')
    .trim()
    .split(/\s+/)
    .map((pair): Point => {
      const [x, y] = pair.split(',').map(Number);
      return [x!, y!];
    });
}

const scaled = (pts: readonly Point[], k: number, dx = 0, dy = 0): Point[] =>
  pts.map(([x, y]): Point => [x * k + dx, y * k + dy]);

describe('hud-icons — the chip icons (#181 H1)', () => {
  const KINDS: readonly ChipIconKind[] = ['lives', 'bounty', 'stars', 'score', 'wave'];

  it('every chip icon is decoration: aria-hidden, unfocusable, nameless, in the frame’s box', () => {
    for (const kind of KINDS) {
      const svg = chipIcon(document, kind);
      expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(svg.getAttribute('class')).toBe(`wy-icon wy-icon--${kind}`);
      expect(svg.getAttribute('viewBox')).toBe(ICON_VIEWBOX);
      expect(svg.getAttribute('viewBox')).toBe('-10 -10 20 20');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.querySelector('title, desc, text')).toBeNull();
      expect(svg.textContent).toBe('');
      expect(svg.childElementCount).toBeGreaterThan(0);
    }
  });

  it('draws the style frame’s heart, gem and star', () => {
    expect(chipIcon(document, 'lives').querySelector('path')!.getAttribute('d')).toBe(
      'M0 -3.5C0 -7.5 -6 -8.5 -8 -4.5C-10 -0.5 -4 4 0 7C4 4 10 -0.5 8 -4.5C6 -8.5 0 -7.5 0 -3.5Z',
    );
    const gem = chipIcon(document, 'bounty');
    expect(gem.querySelector('.wy-icon-body')!.getAttribute('d')).toBe('M0 -8L7 0L0 8L-7 0Z');
    expect(gem.querySelector('.wy-icon-body')!.getAttribute('stroke-width')).toBe('1.2');
    expect(gem.querySelector('.wy-icon-facets')!.getAttribute('d')).toBe(
      'M-7 0H7M0 -8L-2.5 0L0 8L2.5 0Z',
    );
    expect(gem.querySelector('.wy-icon-facets')!.getAttribute('stroke-width')).toBe('0.9');
    // The star: five points, outer radius 8.4 and inner 3.6, alternating, point up.
    const star = parsePoints(
      chipIcon(document, 'stars').querySelector('polygon')!.getAttribute('points'),
    );
    expect(star).toHaveLength(10);
    expect(star[0]![0]).toBeCloseTo(0, 2);
    expect(star[0]![1]).toBeCloseTo(-8.4, 2);
    star.forEach(([x, y], i) => {
      expect(Math.hypot(x, y)).toBeCloseTo(i % 2 === 0 ? 8.4 : 3.6, 1);
    });
  });
});

describe('hud-icons — the creep icons draw the board’s silhouettes (#181 L1)', () => {
  it('every creep’s icon takes its SHAPE from the render package and draws that shape’s fixed geometry', () => {
    const drawnShapes = new Set<CreepShape>();
    for (const creepId of CREEP_IDS) {
      const op = creepSilhouettePaintOp(creepId, 0, 0, CREEP_ICON_R, 0, 1);
      expect(op.shape, creepId).toBe(creepShapeFor(creepId));
      drawnShapes.add(op.shape);
      const icon = creepIcon(
        document,
        { creepId, domain: 'ground', boss: false },
        resolvePalette('default'),
      );
      expect(icon.dataset.wyShape, creepId).toBe(op.shape);
      // The built icon draws the board's vertices (to its two-decimal precision).
      const drawn = parsePoints(icon.querySelector('.wy-creep-body')!.getAttribute('points'));
      expect(vertexSet(drawn, 2), creepId).toEqual(vertexSet(BOARD_SILHOUETTE_AT_6[op.shape], 2));
    }
    // The unknown id takes the board's fallback, and the shipped catalog draws every shape.
    expect(creepShapeFor('not-a-catalog-creep')).toBe('triangle');
    expect([...drawnShapes].sort()).toEqual([...SHAPES].sort());
  });

  it('silhouettePoints draws every shape’s geometry around the plan’s own point, at its own radius', () => {
    expect(CREEP_ICON_R).toBe(6);
    for (const shape of SHAPES) {
      for (const [x, y, r] of [
        [0, 0, 6],
        [3, -2, 6],
        [-1.5, 4, 9],
      ] as const) {
        const op: CreepSilhouettePaintOp = { shape, x, y, r, colour: 0, hpFrac: 1 };
        expect(vertexSet(silhouettePoints(op), 5), `${shape} at (${x},${y}) r${r}`).toEqual(
          vertexSet(scaled(BOARD_SILHOUETTE_AT_6[shape], r / 6, x, y), 5),
        );
      }
    }
  });

  it('a boss is drawn larger by exactly the board’s boss step — size is the board’s only boss cue', () => {
    expect(CREEP_ICON_BOSS_SCALE).toBe(BOARD_BOSS_SCALE);
    for (const creepId of CREEP_IDS) {
      const icon = creepIcon(
        document,
        { creepId, domain: 'ground', boss: true },
        resolvePalette('default'),
      );
      const drawn = parsePoints(icon.querySelector('.wy-creep-body')!.getAttribute('points'));
      expect(vertexSet(drawn, 2), creepId).toEqual(
        vertexSet(scaled(BOARD_SILHOUETTE_AT_6[creepShapeFor(creepId)], BOARD_BOSS_SCALE), 2),
      );
    }
  });

  it('is inked in the palette’s creep and airborne colours, in every colour mode', () => {
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      const icon = creepIcon(document, { creepId: 'normal', domain: 'air', boss: false }, pal);
      expect(icon.querySelector('.wy-creep-body')!.getAttribute('fill'), mode).toBe(
        hexColour(pal.creep),
      );
      expect(icon.querySelector('.wy-creep-chevron')!.getAttribute('stroke'), mode).toBe(
        hexColour(pal.airborne),
      );
    }
  });

  it('an air entry carries the board’s chevron glyph — its span and drop — just above the silhouette', () => {
    expect(CHEVRON_HALF_SPAN).toBe(BOARD_CHEVRON.halfSpan);
    expect(CHEVRON_DROP).toBe(BOARD_CHEVRON.drop);
    const r = CREEP_ICON_R;
    const [left, apex, right] = chevronPoints(0, 0, r);
    // At the icon's radius: the tips 0.9r either side of the apex and 0.3r below it, and the
    // whole glyph a gap above the silhouette's top (y = −6).
    expect(vertexSet([left, apex, right], 5)).toEqual(
      vertexSet(
        [
          [-5.4, -7.8],
          [0, -9.6],
          [5.4, -7.8],
        ],
        5,
      ),
    );
    // The icon's own standoff: the tips sit clear ABOVE every silhouette's top — the glyph must
    // never touch the body it flies over, whatever the shape…
    for (const shape of SHAPES) {
      const top = Math.min(...BOARD_SILHOUETTE_AT_6[shape].map(([, y]) => y));
      expect(top - left[1], shape).toBeGreaterThanOrEqual(0.25 * r);
    }
    expect(CHEVRON_GAP).toBeGreaterThan(0);
    // …and the whole glyph stays inside the icon's box for an ordinary creep.
    expect(apex[1]).toBeGreaterThanOrEqual(-10);

    const icon = creepIcon(
      document,
      { creepId: 'normal', domain: 'air', boss: false },
      resolvePalette('default'),
    );
    const drawn = parsePoints(icon.querySelector('.wy-creep-chevron')!.getAttribute('points'));
    expect(vertexSet(drawn, 2)).toEqual(vertexSet([left, apex, right], 2));
  });

  it('a ground entry has no chevron; every icon is aria-hidden decoration', () => {
    for (const domain of ['ground', 'air'] as const) {
      const icon = creepIcon(
        document,
        { creepId: 'fast', domain, boss: false },
        resolvePalette('default'),
      );
      expect(icon.querySelector('.wy-creep-chevron') !== null).toBe(domain === 'air');
      expect(icon.getAttribute('class')).toBe('wy-creep-icon');
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.getAttribute('focusable')).toBe('false');
      expect(icon.textContent).toBe('');
    }
  });

  it('paintCreepIcon re-inks a built icon in place — the same nodes, the new palette', () => {
    const from = resolvePalette('default');
    const icon = creepIcon(document, { creepId: 'swarm', domain: 'air', boss: false }, from);
    const body = icon.querySelector('.wy-creep-body');
    const chevron = icon.querySelector('.wy-creep-chevron');
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      paintCreepIcon(icon, pal);
      expect(icon.querySelector('.wy-creep-body')).toBe(body);
      expect(icon.querySelector('.wy-creep-chevron')).toBe(chevron);
      expect(body!.getAttribute('fill')).toBe(hexColour(pal.creep));
      expect(chevron!.getAttribute('stroke')).toBe(hexColour(pal.airborne));
    }
  });

  it('hexColour writes an SVG paint value, zero-padded and masked to 24 bits', () => {
    expect(hexColour(0xf0e442)).toBe('#f0e442');
    expect(hexColour(0x0000ff)).toBe('#0000ff');
    expect(hexColour(0)).toBe('#000000');
    expect(hexColour(0x1abcdef)).toBe('#abcdef');
  });
});

describe('hud-icons — the countdown dial: a stopwatch face (#181 H1, QC round 2)', () => {
  /** The numeric presentation attributes the dial is drawn with, read back from the BUILT
   *  element — never the module's constants, which the geometry checks below would only
   *  restate. `ui.css` sets no geometry on the dial (`layout.test.ts` pins that), so these are
   *  the values the browser paints. */
  const num = (el: Element, attr: string): number => {
    const v = el.getAttribute(attr);
    expect(v, `${el.getAttribute('class')} has a ${attr}`).not.toBeNull();
    return Number(v);
  };
  const part = (root: Element, cls: string): Element => {
    const el = root.querySelector(`.${cls}`);
    expect(el, cls).not.toBeNull();
    return el!;
  };

  it('is aria-hidden decoration with NO text: a crown, a ring, a dim face and the remaining-time wedge', () => {
    const { root, progress } = countdownDial(document);
    // An HTML wrapper, so the UA's `[hidden]` rule can take the dial out of the paint.
    expect(root.tagName).toBe('SPAN');
    expect(root.className).toBe('wy-dial');
    expect(root.getAttribute('aria-hidden')).toBe('true');
    const svg = root.querySelector('svg')!;
    expect(root.children).toHaveLength(1);
    expect(svg.getAttribute('class')).toBe('wy-dial-svg');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('viewBox')).toBe(ICON_VIEWBOX);
    expect([...svg.children].map((c) => c.getAttribute('class'))).toEqual([
      'wy-dial-crown',
      'wy-dial-ring',
      'wy-dial-track',
      'wy-dial-wedge',
    ]);
    // The wedge is the part `overlay.ts` writes, and it starts full.
    expect(svg.children[3]).toBe(progress);
    expect(progress.getAttribute('stroke-dasharray')).toBe(dialDash(1));
    // The seconds live in the wave chip, at every text size — the dial carries none (#181 QC:
    // the ring's fixed 13px seconds did not scale with text).
    expect(root.textContent).toBe('');
    expect(root.querySelector('text, tspan, foreignObject')).toBeNull();
    // No animation of any kind: it takes a new value only when the second changes.
    expect(root.querySelector('animate, animateTransform, animateMotion, set')).toBeNull();
  });

  it('reads as a STOPWATCH, never as a letter: a crown attached to the ring, a face inside it, all inside the box', () => {
    const { root } = countdownDial(document);
    const crown = part(root, 'wy-dial-crown');
    const ring = part(root, 'wy-dial-ring');
    const track = part(root, 'wy-dial-track');
    const wedge = part(root, 'wy-dial-wedge');
    const [vx, vy, vw, vh] = root
      .querySelector('svg')!
      .getAttribute('viewBox')!
      .split(' ')
      .map(Number);
    const box = { left: vx!, top: vy!, right: vx! + vw!, bottom: vy! + vh! };

    // The ring: its stroke's outer edge stays inside the box on every side.
    const cx = num(ring, 'cx');
    const cy = num(ring, 'cy');
    const ringR = num(ring, 'r');
    const ringSw = num(ring, 'stroke-width');
    const ringOuter = ringR + ringSw / 2;
    expect(cx - ringOuter).toBeGreaterThanOrEqual(box.left);
    expect(cx + ringOuter).toBeLessThanOrEqual(box.right);
    expect(cy - ringOuter).toBeGreaterThanOrEqual(box.top);
    expect(cy + ringOuter).toBeLessThanOrEqual(box.bottom);

    // The crown — what makes the silhouette a stopwatch and not an "O" (#181 QC: "O Start"): a
    // cap bar above the ring and a stem down to it, round-capped, inside the box, and TOUCHING
    // the ring so the two read as one object.
    const d = crown.getAttribute('d')!;
    expect(d).toMatch(/^[MHV0-9 .-]+$/); // straight segments only, so the walk below is exact
    const tokens = d.match(/[MHV]|-?\d*\.?\d+/g)!;
    const pts: Point[] = [];
    let at: Point = [0, 0];
    for (let i = 0; i < tokens.length;) {
      const cmd = tokens[i++]!;
      if (cmd === 'M') at = [Number(tokens[i++]), Number(tokens[i++])];
      else if (cmd === 'H') at = [Number(tokens[i++]), at[1]];
      else if (cmd === 'V') at = [at[0], Number(tokens[i++])];
      else throw new Error(`unexpected crown command ${cmd}`);
      pts.push(at);
    }
    const crownSw = num(crown, 'stroke-width');
    expect(crown.getAttribute('stroke-linecap')).toBe('round');
    // Painted extents: a round cap reaches half the stroke width past each end.
    const crownTop = Math.min(...pts.map(([, y]) => y)) - crownSw / 2;
    const stemEnd = Math.max(...pts.map(([, y]) => y)) + crownSw / 2;
    expect(crownTop).toBeGreaterThanOrEqual(box.top);
    for (const [x] of pts) {
      expect(x - crownSw / 2).toBeGreaterThanOrEqual(box.left);
      expect(x + crownSw / 2).toBeLessThanOrEqual(box.right);
    }
    expect(crownTop, 'the crown stands above the ring').toBeLessThan(cy - ringOuter);
    // The ring's top band runs from its outer edge down to its inner edge; the stem's end lands
    // inside that band — attached to the ring, never poking through into the face.
    expect(stemEnd, 'the stem reaches into the ring').toBeGreaterThan(cy - ringOuter);
    expect(stemEnd, '…without poking into the face').toBeLessThanOrEqual(cy - ringR + ringSw / 2);

    // The face: the dim track disc and the wedge are concentric with the ring and leave a
    // visible gap inside its stroke, so the remaining time never merges into the ring.
    for (const el of [track, wedge]) {
      expect(num(el, 'cx')).toBe(cx);
      expect(num(el, 'cy')).toBe(cy);
    }
    const faceR = num(track, 'r');
    expect(
      ringR - ringSw / 2 - faceR,
      'a gap between the face and the ring',
    ).toBeGreaterThanOrEqual(1);
    // The wedge is a circle of half the face's radius stroked the face's radius wide: its stroke
    // runs from the centre to the face's edge, so a dash paints a pie sector of exactly the face.
    const wedgeR = num(wedge, 'r');
    const wedgeSw = num(wedge, 'stroke-width');
    expect(wedgeR - wedgeSw / 2).toBeCloseTo(0, 9);
    expect(wedgeR + wedgeSw / 2).toBeCloseTo(faceR, 9);
    expect(wedge.getAttribute('fill')).toBe('none');
    // …starting at twelve o'clock (the circle's stroke starts at three; a quarter turn back).
    expect(wedge.getAttribute('transform')).toBe(`rotate(-90 ${cx} ${cy})`);
  });

  it('dialDash draws the remaining share of the wedge’s circumference, clamped to [0, 1]', () => {
    const wedge = part(countdownDial(document).root, 'wy-dial-wedge');
    const C = 2 * Math.PI * num(wedge, 'r');
    const dash = (len: number): string =>
      `${Math.round(len * 100) / 100} ${Math.round(C * 100) / 100}`;
    expect(dialDash(1)).toBe(dash(C));
    expect(dialDash(0.5)).toBe(dash(C / 2));
    expect(dialDash(0.05)).toBe(dash(C * 0.05));
    expect(dialDash(0)).toBe(dash(0));
    expect(dialDash(2)).toBe(dialDash(1));
    expect(dialDash(-1)).toBe(dialDash(0));
    expect(dialDash(Number.NaN)).toBe(dialDash(0));
    expect(dialDash(Number.POSITIVE_INFINITY)).toBe(dialDash(0));
  });
});
