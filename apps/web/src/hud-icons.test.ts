// hud-icons.test.ts — the HUD's inline-SVG icons (#181 H1 + L1).
//
// THE CREEP ICONS ARE THE BOARD'S OWN CREEP ART (#181 C3/C4). `hud-icons.ts` asks the render
// package for a creep's look (`creepLookFor`) and its art (`creepIconArt`), and has the
// package's own SVG renderer (`artSvgNodes`) write it — no geometry lives in the app any more.
// So what this file pins is that WIRING: every icon is exactly the renderer's elements for its
// creep's art, at the scale the package gives it, inked from the active palette by the colour
// tokens its parts carry — and what the strip relies on: the board's size steps, wings on an
// air entry and none on the ground, decoration only. The art itself — its silhouettes, wings
// and size steps — is the render package's to test (`creep-art.test.ts`). This file imports
// only the package's public API, and typechecks against its declarations.

import { describe, it, expect } from 'vitest';
import {
  artSvgNodes,
  COLOUR_MODES,
  creepArtColour,
  creepIconArt,
  creepLookFor,
  creepShapeFor,
  resolvePalette,
  type ArtColour,
} from '@wynding/render';
import { compileRuleset } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from '@wynding/content';
import {
  ICON_VIEWBOX,
  dialDash,
  chipIcon,
  countdownDial,
  creepIcon,
  hexColour,
  paintCreepIcon,
  type ChipIconKind,
} from './hud-icons';

const bundle = getBundledRuleset();
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
/** Every creep the shipped content can preview, plus an id the catalog does not know (the
 *  board draws its fallback look for it, and so must the icon). */
const CREEP_IDS = [...Object.keys(ruleset.creepById), 'not-a-catalog-creep'];

type Point = readonly [number, number];

function parsePoints(attr: string | null): Point[] {
  return (attr ?? '')
    .trim()
    .split(/\s+/)
    .map((pair): Point => {
      const [x, y] = pair.split(',').map(Number);
      return [x!, y!];
    });
}

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

describe('hud-icons — the creep icons draw the board’s own creep art (#181 L1, C3/C4)', () => {
  /** A built part's art attributes: everything but its class and the paint `paintCreepIcon`
   *  writes — what the renderer wrote. */
  const artAttrs = (el: Element): Record<string, string> =>
    Object.fromEntries(
      [...el.attributes]
        .filter((a) => !['class', 'fill', 'stroke'].includes(a.name))
        .map((a) => [a.name, a.value]),
    );
  const scaleOf = (icon: SVGSVGElement): number => {
    const m = /^scale\(([\d.]+)\)$/.exec(icon.querySelector('g')!.getAttribute('transform')!);
    expect(m).not.toBeNull();
    return Number(m![1]);
  };
  const SPECS = CREEP_IDS.flatMap((creepId) =>
    (['ground', 'air'] as const).flatMap((domain) =>
      [false, true].map((boss) => ({ creepId, domain, boss })),
    ),
  );

  it('every creep’s icon is the render package’s art for its look, as its SVG renderer writes it, at the scale the package gives it', () => {
    const drawnShapes = new Set<string>();
    for (const spec of SPECS) {
      const at = `${spec.creepId}/${spec.domain}${spec.boss ? '/boss' : ''}`;
      const look = creepLookFor(spec.creepId, spec.boss, spec.domain === 'air');
      const icon = creepIcon(document, spec, resolvePalette('default'));
      expect(icon.dataset.wyShape, at).toBe(creepShapeFor(spec.creepId));
      expect(icon.dataset.wyFamily, at).toBe(look.family);
      drawnShapes.add(look.shape);
      const { shapes, scale } = creepIconArt(look);
      expect(scaleOf(icon), at).toBeCloseTo(scale, 4);
      const parts = [...icon.querySelector('g')!.children];
      expect(
        parts.map((p) => ({ tag: p.tagName, attrs: artAttrs(p) })),
        at,
      ).toEqual(artSvgNodes(shapes).map((n) => ({ tag: n.tag, attrs: n.attrs })));
    }
    // The unknown id takes the board's fallback, and the shipped catalog draws every shape.
    expect(creepShapeFor('not-a-catalog-creep')).toBe('triangle');
    expect([...drawnShapes].sort()).toEqual([
      'diamond',
      'hexagon',
      'pentagon',
      'square',
      'triangle',
    ]);
  });

  it('keeps the board’s size steps: a boss drawn 1.5× the armored creep, the swarm the smallest', () => {
    const scale = (creepId: string, boss = false): number =>
      scaleOf(creepIcon(document, { creepId, domain: 'ground', boss }, resolvePalette('default')));
    expect(scale('boss', true) / scale('armored')).toBeCloseTo(1.5, 3);
    const all = ['swarm', 'normal', 'fast', 'armored', 'flying', 'resolute'].map((id) => scale(id));
    expect(Math.min(...all)).toBe(scale('swarm'));
    expect(Math.max(...all, scale('boss', true))).toBe(scale('boss', true));
  });

  it('is inked in the family’s hue, the airborne colour and the ink, in every colour mode', () => {
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      for (const creepId of ['normal', 'armored-flyer', 'swarm']) {
        const icon = creepIcon(document, { creepId, domain: 'air', boss: false }, pal);
        const family = creepLookFor(creepId, false, true).family;
        const ink = (token: ArtColour): string => hexColour(creepArtColour(token, pal, family));
        const body = icon.querySelector('.wy-creep-body')!;
        expect(body.getAttribute('fill'), `${mode} ${creepId}`).toBe(ink('family'));
        expect(body.getAttribute('stroke'), `${mode} ${creepId}`).toBe(ink('ink'));
        for (const wing of icon.querySelectorAll('.wy-creep-wing')) {
          expect(wing.getAttribute('fill'), `${mode} ${creepId}`).toBe(hexColour(pal.airborne));
          expect(wing.getAttribute('stroke'), `${mode} ${creepId}`).toBe(ink('ink'));
        }
      }
      // A creep's hue is its family's: normal and resolute share one, fast has its own.
      const fill = (creepId: string): string | null =>
        creepIcon(document, { creepId, domain: 'ground', boss: false }, pal)
          .querySelector('.wy-creep-body')!
          .getAttribute('fill');
      expect(fill('resolute'), mode).toBe(fill('normal'));
      expect(fill('fast'), mode).not.toBe(fill('normal'));
    }
  });

  it('an air entry carries the two wings, under its body; a ground entry none; every icon is aria-hidden decoration', () => {
    for (const domain of ['ground', 'air'] as const) {
      const icon = creepIcon(
        document,
        { creepId: 'fast', domain, boss: false },
        resolvePalette('default'),
      );
      const parts = [...icon.querySelector('g')!.children].map((p) => p.getAttribute('class'));
      expect(parts).toEqual(
        domain === 'air' ? ['wy-creep-wing', 'wy-creep-wing', 'wy-creep-body'] : ['wy-creep-body'],
      );
      expect(icon.getAttribute('class')).toBe('wy-creep-icon');
      expect(icon.getAttribute('viewBox')).toBe(ICON_VIEWBOX);
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.getAttribute('focusable')).toBe('false');
      expect(icon.textContent).toBe('');
    }
  });

  it('paintCreepIcon re-inks a built icon in place — the same nodes, the new palette', () => {
    const from = resolvePalette('default');
    const icon = creepIcon(document, { creepId: 'swarm', domain: 'air', boss: false }, from);
    const body = icon.querySelector('.wy-creep-body');
    const wings = [...icon.querySelectorAll('.wy-creep-wing')];
    expect(wings).toHaveLength(2);
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      paintCreepIcon(icon, pal);
      expect(icon.querySelector('.wy-creep-body')).toBe(body);
      expect([...icon.querySelectorAll('.wy-creep-wing')]).toEqual(wings);
      expect(body!.getAttribute('fill')).toBe(hexColour(creepArtColour('family', pal, 'swarm')));
      for (const wing of wings) expect(wing.getAttribute('fill')).toBe(hexColour(pal.airborne));
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

  it('the ring is a stroke alone: unfilled, it never paints the SVG default black under the face', () => {
    const { root } = countdownDial(document);
    expect(part(root, 'wy-dial-ring').getAttribute('fill')).toBe('none');
  });

  describe('the crown, read as a path', () => {
    const crownWalk = (): {
      cx: number;
      cy: number;
      outerR: number;
      innerR: number;
      stems: { x: number; top: number; end: number }[];
      bars: number[];
    } => {
      const { root } = countdownDial(document);
      const crown = part(root, 'wy-dial-crown');
      const ring = part(root, 'wy-dial-ring');
      const cx = num(ring, 'cx');
      const cy = num(ring, 'cy');
      const r = num(ring, 'r');
      const sw = num(ring, 'stroke-width');
      const outerR = r + sw / 2;
      const innerR = r - sw / 2;
      const half = num(crown, 'stroke-width') / 2;
      const tokens = crown.getAttribute('d')!.match(/[MHV]|-?\d*\.?\d+/g)!;
      const stems: { x: number; top: number; end: number }[] = [];
      const bars: number[] = [];
      let at: Point = [0, 0];
      for (let i = 0; i < tokens.length;) {
        const cmd = tokens[i++]!;
        if (cmd === 'M') at = [Number(tokens[i++]), Number(tokens[i++])];
        else if (cmd === 'H') {
          bars.push(at[1]);
          at = [Number(tokens[i++]), at[1]];
        } else if (cmd === 'V') {
          const y = Number(tokens[i++]);
          stems.push({ x: at[0], top: Math.min(at[1], y), end: Math.max(at[1], y) + half });
          at = [at[0], y];
        } else throw new Error(`unexpected crown command ${cmd}`);
      }
      return { cx, cy, outerR, innerR, stems, bars };
    };

    it('the crown stands ON the ring straight below its stem', () => {
      const { cx, cy, outerR, innerR, stems } = crownWalk();
      expect(stems.length).toBeGreaterThan(0);
      for (const s of stems) {
        const dx = s.x - cx;
        const outer = cy - Math.sqrt(outerR ** 2 - dx ** 2);
        const inner = cy - Math.sqrt(innerR ** 2 - dx ** 2);
        expect(s.end, 'the stem reaches the ring below it').toBeGreaterThan(outer);
        expect(s.end, '…without poking into the face').toBeLessThanOrEqual(inner);
      }
    });

    it('the cap bar is the crown’s top', () => {
      const { stems, bars } = crownWalk();
      expect(bars.length).toBeGreaterThan(0);
      for (const y of bars) expect(y).toBeLessThanOrEqual(Math.min(...stems.map((s) => s.top)));
    });
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
