// hud-icons.test.ts — the HUD's inline-SVG icons (#181 H1 + L1).
//
// THE CREEP ICONS' PARITY GATE. `hud-icons.ts` asks the render package for each creep's paint
// plan (`creepSilhouettePaintOp`) and translates the plan's shape into SVG vertices — the one
// step the render package keeps inside its board executor (`drawCreeps`), which its barrel does
// not export. So this file runs that REAL executor through a recording `GraphicsLike` and pins
// the icon's vertices, its colour and the boss size step to what the board draws, and pins the
// chevron's proportions to the board's airborne plan. A change to the board's creep art fails
// here instead of drifting from the strip unseen.
//
// The executor and the airborne plan are imported by relative path because
// `@wynding/render`'s `exports` map has no subpath for them — test-only, the precedent
// `apps/server/src/replay-parity.test.ts` set for `packages/content/src`.

import { describe, it, expect } from 'vitest';
import {
  COLOUR_MODES,
  creepShapeFor,
  creepSilhouettePaintOp,
  resolvePalette,
  type GraphicsLike,
  type Palette,
  type Projection,
} from '@wynding/render';
import { compileRuleset } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from '@wynding/content';
import { drawCreeps } from '../../../packages/render/src/board-draw';
import { airborneCuePaintOps } from '../../../packages/render/src/creep-paint';
import {
  CHEVRON_DROP,
  CHEVRON_GAP,
  CHEVRON_HALF_SPAN,
  CREEP_ICON_BOSS_SCALE,
  CREEP_ICON_R,
  DIAL_BOX,
  DIAL_CIRCUMFERENCE,
  DIAL_R,
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

/** A `GraphicsLike` that records every call, with the fill colour in force at the time. */
function recorder(): { g: GraphicsLike; calls: { fn: string; args: unknown[]; fill: number }[] } {
  const calls: { fn: string; args: unknown[]; fill: number }[] = [];
  let fill = -1;
  const rec =
    (fn: string) =>
    (...args: unknown[]): void => {
      calls.push({ fn, args, fill });
    };
  const g: GraphicsLike = {
    fillStyle: (colour: number) => {
      fill = colour;
      calls.push({ fn: 'fillStyle', args: [colour], fill });
    },
    lineStyle: rec('lineStyle'),
    fillRect: rec('fillRect'),
    fillRoundedRect: rec('fillRoundedRect'),
    strokeRoundedRect: rec('strokeRoundedRect'),
    fillTriangle: rec('fillTriangle'),
    fillCircle: rec('fillCircle'),
    strokeCircle: rec('strokeCircle'),
    fillPoints: rec('fillPoints'),
    lineBetween: rec('lineBetween'),
  };
  return { g, calls };
}

/** A projection that puts the creep at the origin and sizes cells so the board's creep
 *  radius (`cellPx × 0.35`, before any boss step) is exactly `r`. */
function projectionFor(r: number): Projection {
  return {
    cellPx: r / 0.35,
    originX: 0,
    originY: 0,
    dpr: 1,
    cellToPixel: () => ({ x: 0, y: 0 }),
    fpToPixel: () => ({ x: 0, y: 0 }),
    fpLenToPixel: (n: number) => n,
    pointerToCell: () => null,
  };
}

/** What the board draws for one healthy, status-free creep at the origin. */
function boardCreep(
  creepId: string,
  opts: { readonly boss?: boolean; readonly domain?: 'ground' | 'air'; readonly pal?: Palette },
): { vertices: Point[]; fill: number; calls: { fn: string; args: unknown[]; fill: number }[] } {
  const { g, calls } = recorder();
  drawCreeps(
    g,
    opts.pal ?? resolvePalette('default'),
    [
      {
        x: 0,
        y: 0,
        hpFrac: 1,
        creepId,
        domain: opts.domain ?? 'ground',
        slowed: false,
        poisoned: false,
        stunned: false,
        warded: false,
        boss: opts.boss ?? false,
      },
    ],
    false,
    0,
    projectionFor(CREEP_ICON_R),
  );
  // The silhouette is every fill between the first `fillStyle` and the HP pip — the LAST
  // `fillRect` (a square silhouette is a `fillRect` too, so "the first" would be wrong).
  const pip = calls.map((c) => c.fn).lastIndexOf('fillRect');
  const silhouette = calls.slice(1, pip);
  expect(silhouette.length, `${creepId}: a silhouette was drawn`).toBeGreaterThan(0);
  const vertices: Point[] = [];
  for (const { fn, args } of silhouette) {
    const n = args as number[];
    if (fn === 'fillTriangle') {
      vertices.push([n[0]!, n[1]!], [n[2]!, n[3]!], [n[4]!, n[5]!]);
    } else if (fn === 'fillRect') {
      const [x, y, w, h] = n as [number, number, number, number];
      vertices.push([x, y], [x + w, y], [x + w, y + h], [x, y + h]);
    } else if (fn === 'fillPoints') {
      for (const p of args[0] as { x: number; y: number }[]) vertices.push([p.x, p.y]);
    } else {
      throw new Error(`unexpected silhouette call ${fn}`);
    }
  }
  return { vertices, fill: calls[0]!.fill, calls };
}

/** A vertex SET, order-free and rounded, so the board's two-triangle diamond and the icon's
 *  four-point polygon compare as the same shape. */
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

describe('hud-icons — the creep icons execute the board’s own art (#181 L1)', () => {
  it('every creep’s icon has the vertices the board draws for it', () => {
    for (const creepId of CREEP_IDS) {
      const board = boardCreep(creepId, {});
      const op = creepSilhouettePaintOp(creepId, 0, 0, CREEP_ICON_R, 0, 1);
      expect(op.shape, creepId).toBe(creepShapeFor(creepId));
      expect(vertexSet(silhouettePoints(op)), creepId).toEqual(vertexSet(board.vertices));
      // …and the built icon really draws those vertices (to its two-decimal precision).
      const icon = creepIcon(
        document,
        { creepId, domain: 'ground', boss: false },
        resolvePalette('default'),
      );
      expect(icon.dataset.wyShape).toBe(op.shape);
      const drawn = parsePoints(icon.querySelector('.wy-creep-body')!.getAttribute('points'));
      expect(vertexSet(drawn, 2), creepId).toEqual(vertexSet(board.vertices, 2));
    }
  });

  it('a boss is drawn larger by exactly the board’s boss step — size is the board’s only boss cue', () => {
    const extent = (pts: readonly Point[]): number =>
      Math.max(...pts.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));
    const plain = extent(boardCreep('boss', { boss: false }).vertices);
    const boss = extent(boardCreep('boss', { boss: true }).vertices);
    expect(boss / plain).toBeCloseTo(CREEP_ICON_BOSS_SCALE, 9);
    const icon = creepIcon(
      document,
      { creepId: 'boss', domain: 'ground', boss: true },
      resolvePalette('default'),
    );
    const drawn = parsePoints(icon.querySelector('.wy-creep-body')!.getAttribute('points'));
    expect(vertexSet(drawn, 2)).toEqual(vertexSet(boardCreep('boss', { boss: true }).vertices, 2));
  });

  it('is inked in the colour the board fills a healthy creep with, in every colour mode', () => {
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      expect(boardCreep('normal', { pal }).fill, mode).toBe(pal.creep);
      const icon = creepIcon(document, { creepId: 'normal', domain: 'air', boss: false }, pal);
      expect(icon.querySelector('.wy-creep-body')!.getAttribute('fill')).toBe(hexColour(pal.creep));
      expect(icon.querySelector('.wy-creep-chevron')!.getAttribute('stroke')).toBe(
        hexColour(pal.airborne),
      );
    }
  });

  it('an air entry carries the board’s chevron glyph — its span and drop — just above the silhouette', () => {
    const r = CREEP_ICON_R;
    const [plan] = airborneCuePaintOps({ x: 0, y: 0, airborne: true }, r, 0);
    expect(plan).toBeDefined();
    // The board's glyph, as fractions of r: the wingtips' half-span and their drop below the apex.
    expect((plan!.rightX - plan!.apexX) / r).toBeCloseTo(CHEVRON_HALF_SPAN, 9);
    expect((plan!.apexX - plan!.leftX) / r).toBeCloseTo(CHEVRON_HALF_SPAN, 9);
    expect((plan!.leftY - plan!.apexY) / r).toBeCloseTo(CHEVRON_DROP, 9);
    // The board strokes it in the airborne ink, through the same executor as the silhouette.
    const pal = resolvePalette('default');
    const strokes = boardCreep('normal', { domain: 'air', pal }).calls.filter(
      (c) => c.fn === 'lineStyle',
    );
    expect(strokes.at(-1)!.args[1]).toBe(pal.airborne);

    const [left, apex, right] = chevronPoints(0, 0, r);
    expect((right[0] - apex[0]) / r).toBeCloseTo(CHEVRON_HALF_SPAN, 9);
    expect((apex[0] - left[0]) / r).toBeCloseTo(CHEVRON_HALF_SPAN, 9);
    expect((left[1] - apex[1]) / r).toBeCloseTo(CHEVRON_DROP, 9);
    // The icon's own standoff: the tips sit clear ABOVE every silhouette's top — the glyph
    // must never touch the body it flies over, whatever the shape…
    for (const creepId of CREEP_IDS) {
      const top = Math.min(...boardCreep(creepId, {}).vertices.map(([, y]) => y));
      expect(top - left[1], creepId).toBeGreaterThanOrEqual(0.25 * r);
    }
    expect(CHEVRON_GAP).toBeGreaterThan(0);
    // …and the whole glyph stays inside the icon's box for an ordinary creep.
    expect(apex[1]).toBeGreaterThanOrEqual(-10);

    const icon = creepIcon(document, { creepId: 'normal', domain: 'air', boss: false }, pal);
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

describe('hud-icons — the countdown dial (#181 H1)', () => {
  const C = DIAL_CIRCUMFERENCE;
  const dash = (len: number): string =>
    `${Math.round(len * 100) / 100} ${Math.round(C * 100) / 100}`;

  it('is aria-hidden decoration with NO text: a wrapper, a track, and a progress stroke from twelve o’clock', () => {
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
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${DIAL_BOX} ${DIAL_BOX}`);
    expect([...svg.children].map((c) => c.getAttribute('class'))).toEqual([
      'wy-dial-track',
      'wy-dial-progress',
    ]);
    expect(svg.children[1]).toBe(progress);
    expect(svg.children[0]!.getAttribute('r')).toBe(String(DIAL_R));
    expect(progress.getAttribute('r')).toBe(String(DIAL_R));
    const c = String(DIAL_BOX / 2);
    expect(progress.getAttribute('cx')).toBe(c);
    expect(progress.getAttribute('cy')).toBe(c);
    expect(progress.getAttribute('transform')).toBe(`rotate(-90 ${c} ${c})`);
    expect(progress.getAttribute('stroke-dasharray')).toBe(dialDash(1)); // full until told
    // The seconds live in the wave chip, at every text size — the dial carries none (#181 QC:
    // the ring's fixed 13px seconds did not scale with text).
    expect(root.textContent).toBe('');
    expect(root.querySelector('text, tspan, foreignObject')).toBeNull();
    expect(root.querySelector('animate, animateTransform, set')).toBeNull(); // no animation
  });

  it('dialDash draws the remaining share of the circumference, clamped to [0, 1]', () => {
    expect(C).toBeCloseTo(2 * Math.PI * DIAL_R, 9);
    expect(dialDash(1)).toBe(dash(C));
    expect(dialDash(0.5)).toBe(dash(C / 2));
    expect(dialDash(0)).toBe(dash(0));
    expect(dialDash(2)).toBe(dialDash(1));
    expect(dialDash(-1)).toBe(dialDash(0));
    expect(dialDash(Number.NaN)).toBe(dialDash(0));
    expect(dialDash(Number.POSITIVE_INFINITY)).toBe(dialDash(0));
  });
});
