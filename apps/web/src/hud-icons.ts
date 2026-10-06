// hud-icons.ts — the HUD's inline-SVG icons (#181, H1 + L1): the chip icons (heart, gem,
// star, plus the score sparkle and the countdown clock), the wave strip's creep icons, and
// the countdown dial inside the primary Dock button.
//
// Every icon is DECORATION. Each one sits inside an `aria-hidden` glance form next to a full
// localized sentence that stays the accessible text (the chip's `.wy-chip-full`, the strip
// entry's `.wy-preview-full`), so the SVGs carry `aria-hidden` and `focusable="false"`
// themselves too and never take a name. They are built with `createElementNS` — no markup
// strings — in the injected document, like the Shell's own board-mark.
//
// THE CREEP ICONS DRAW THE BOARD'S SILHOUETTES. Which silhouette a creep draws is the render
// package's decision (`creepSilhouettePaintOp` / `creepShapeFor`), never a second table here:
// the icon asks for the plan and only translates its shape into SVG, as the board's silhouette
// painter (`board-draw.ts`'s `paintCreepSilhouette`, baked into its atlas since #182) translates
// it into Phaser calls. The vertex arithmetic per shape is therefore the one thing restated,
// because `@wynding/render` exports the plan but not its painter. `hud-icons.test.ts` pins every
// shape's vertices, the airborne chevron's proportions and the boss size step to the board's
// geometry, recorded from its painters at #182 — fixed numbers, not a reach into the package's
// source. If the board's creep art is redrawn, that table (and this file) must follow it.
//
// Two deliberate departures from the board, both icon-scale concerns:
//  - The airborne chevron keeps the board's glyph SHAPE (half-span 0.9r, tips 0.3r below the
//    apex) but not its STANDOFF. On the board the apex floats 3.4r above the creep so it clears
//    every timed telegraph ring (`creep-paint.ts`'s cue-radius ordering); an icon has no rings,
//    and at that standoff the silhouette would shrink to a third of the icon. Here it sits just
//    above the silhouette.
//  - Colour comes from the ACTIVE palette (`resolvePalette(mode).creep` / `.airborne`), so the
//    icons follow the colour-vision mode; `paintCreepIcon` re-inks a built icon in place.

import { creepSilhouettePaintOp, type CreepSilhouettePaintOp, type Palette } from '@wynding/render';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The icons' shared coordinate box, the style frame's own (`viewBox="-10 -10 20 20"`). */
export const ICON_VIEWBOX = '-10 -10 20 20';

/** A creep silhouette's half-size inside that box. Leaves the box's top band free for the
 *  airborne chevron, so every creep icon centres its silhouette on the same point and a row of
 *  mixed ground and air entries lines up. */
export const CREEP_ICON_R = 6;

/** The boss's size step — the board's own boss cue (`board-draw.ts`'s `BOSS_SCALE`, size being
 *  the ONLY thing that tells a boss from an armored creep there). Restated because the board
 *  does not export it; `hud-icons.test.ts` pins it to the board's step recorded at #182. */
export const CREEP_ICON_BOSS_SCALE = 1.5;

/** The airborne chevron's glyph, as fractions of r — the board's shape (see the header). */
export const CHEVRON_HALF_SPAN = 0.9;
export const CHEVRON_DROP = 0.3;
/** The icon-only standoff: the gap between the silhouette's top and the chevron's tips. */
export const CHEVRON_GAP = 0.3;

type Point = readonly [number, number];

function el<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Readonly<Record<string, string>>,
): SVGElementTagNameMap[K] {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function iconRoot(doc: Document, className: string): SVGSVGElement {
  return el(doc, 'svg', {
    class: className,
    viewBox: ICON_VIEWBOX,
    'aria-hidden': 'true',
    focusable: 'false',
  });
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100);
const pointsAttr = (pts: readonly Point[]): string =>
  pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ');

/** `0xRRGGBB` → `#rrggbb`, the form an SVG paint attribute takes. */
export function hexColour(colour: number): string {
  return `#${(colour & 0xffffff).toString(16).padStart(6, '0')}`;
}

// --- The chip icons -------------------------------------------------------------------------

/** Which chip an icon belongs to. */
export type ChipIconKind = 'lives' | 'bounty' | 'stars' | 'score' | 'wave';

/** The star's ten points: outer radius 8.4, inner 3.6, point up (the style frame's star). */
function starPoints(): Point[] {
  return Array.from({ length: 10 }, (_, i): Point => {
    const r = i % 2 === 1 ? 3.6 : 8.4;
    const t = (Math.PI * i) / 5 - Math.PI / 2;
    return [r * Math.cos(t), r * Math.sin(t)];
  });
}

/** One chip's icon. The heart, gem and star are the style frame's shapes; the sparkle (score)
 *  and the clock (the countdown) complete the set so every chip's glance leads with an icon.
 *  Fills and strokes are left to `ui.css` (`.wy-icon--<kind>` and its parts), so the colours
 *  are stylesheet tokens and forced-colors mode can repaint them like any other ink. */
export function chipIcon(doc: Document, kind: ChipIconKind): SVGSVGElement {
  const svg = iconRoot(doc, `wy-icon wy-icon--${kind}`);
  switch (kind) {
    case 'lives':
      svg.append(
        el(doc, 'path', {
          class: 'wy-icon-body',
          d: 'M0 -3.5C0 -7.5 -6 -8.5 -8 -4.5C-10 -0.5 -4 4 0 7C4 4 10 -0.5 8 -4.5C6 -8.5 0 -7.5 0 -3.5Z',
        }),
      );
      break;
    case 'bounty':
      svg.append(
        el(doc, 'path', { class: 'wy-icon-body', d: 'M0 -8L7 0L0 8L-7 0Z', 'stroke-width': '1.2' }),
        el(doc, 'path', {
          class: 'wy-icon-facets',
          d: 'M-7 0H7M0 -8L-2.5 0L0 8L2.5 0Z',
          'stroke-width': '0.9',
        }),
      );
      break;
    case 'stars':
      svg.append(
        el(doc, 'polygon', {
          class: 'wy-icon-body',
          points: pointsAttr(starPoints()),
          'stroke-width': '1',
        }),
      );
      break;
    case 'score':
      svg.append(
        el(doc, 'path', {
          class: 'wy-icon-body',
          d: 'M0 -8.5L2.2 -2.2L8.5 0L2.2 2.2L0 8.5L-2.2 2.2L-8.5 0L-2.2 -2.2Z',
        }),
      );
      break;
    case 'wave':
      svg.append(
        el(doc, 'circle', {
          class: 'wy-icon-line',
          cx: '0',
          cy: '0',
          r: '7.5',
          'stroke-width': '2',
        }),
        el(doc, 'path', { class: 'wy-icon-line', d: 'M0 -4.5V0L3 2.5', 'stroke-width': '2' }),
      );
      break;
  }
  return svg;
}

// --- The creep icons ------------------------------------------------------------------------

/** The silhouette's vertices for a paint op, centred on the op's point — the SVG twin of the
 *  board's per-shape silhouette painter, pinned to its recorded geometry by `hud-icons.test.ts`. */
export function silhouettePoints(op: CreepSilhouettePaintOp): Point[] {
  const { x, y, r } = op;
  const ring = (n: number): Point[] =>
    Array.from({ length: n }, (_, i): Point => {
      const angle = ((2 * Math.PI) / n) * i - Math.PI / 2; // apex up, like every board shape
      return [x + r * Math.cos(angle), y + r * Math.sin(angle)];
    });
  switch (op.shape) {
    case 'diamond':
      return [
        [x, y - r],
        [x + r, y],
        [x, y + r],
        [x - r, y],
      ];
    case 'square':
      return [
        [x - r, y - r],
        [x + r, y - r],
        [x + r, y + r],
        [x - r, y + r],
      ];
    case 'hexagon':
      return ring(6);
    case 'pentagon':
      return ring(5);
    // The board painter's fallback: `'triangle'`, and the shape any id the catalog does not
    // know draws (`creepShapeFor` is total).
    default:
      return [
        [x, y - r],
        [x + r, y + r],
        [x - r, y + r],
      ];
  }
}

/** The airborne chevron above a silhouette of half-size `r` centred at (x, y): apex, then the
 *  two wingtips — the board's glyph at the icon's own standoff (see the header). */
export function chevronPoints(x: number, y: number, r: number): [Point, Point, Point] {
  const tipsY = y - r - CHEVRON_GAP * r;
  const apexY = tipsY - CHEVRON_DROP * r;
  return [
    [x - CHEVRON_HALF_SPAN * r, tipsY],
    [x, apexY],
    [x + CHEVRON_HALF_SPAN * r, tipsY],
  ];
}

/** What a creep icon depicts — the wave preview entry's catalog join, nothing per-tick. */
export interface CreepIconSpec {
  readonly creepId: string;
  readonly domain: 'ground' | 'air';
  readonly boss: boolean;
}

/** A creep icon: the board's silhouette for `creepId` (sized up for a boss, as the board does),
 *  plus the board's airborne chevron for an air entry, inked from `palette`. */
export function creepIcon(doc: Document, spec: CreepIconSpec, palette: Palette): SVGSVGElement {
  const svg = iconRoot(doc, 'wy-creep-icon');
  const r = CREEP_ICON_R * (spec.boss ? CREEP_ICON_BOSS_SCALE : 1);
  const op = creepSilhouettePaintOp(spec.creepId, 0, 0, r, palette.creep, 1);
  svg.dataset.wyShape = op.shape;
  svg.append(
    el(doc, 'polygon', { class: 'wy-creep-body', points: pointsAttr(silhouettePoints(op)) }),
  );
  if (spec.domain === 'air') {
    svg.append(
      el(doc, 'polyline', {
        class: 'wy-creep-chevron',
        points: pointsAttr(chevronPoints(0, 0, r)),
        fill: 'none',
        'stroke-width': '1.6',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
  }
  paintCreepIcon(svg, palette);
  return svg;
}

/** Re-ink a built creep icon for `palette` — the colour-mode repaint. Touches only the two
 *  paint attributes, so a repaint never rebuilds the strip under a reader. */
export function paintCreepIcon(svg: SVGSVGElement, palette: Palette): void {
  svg.querySelector('.wy-creep-body')?.setAttribute('fill', hexColour(palette.creep));
  svg.querySelector('.wy-creep-chevron')?.setAttribute('stroke', hexColour(palette.airborne));
}

// --- The countdown dial ------------------------------------------------------------------------
//
// A STOPWATCH FACE (#181 QC round 2): a ring with a crown on top, the remaining time a filled
// WEDGE that starts at twelve o'clock and shrinks back to it, over a dim disc — the track —
// for the time already spent. Its silhouette is the chip's clock with a crown, so at no value
// can it read as a glyph of the label beside it (the closed thin ring it replaced read as an
// "O": "O Start"). Geometry lives here as presentation attributes; inks are `ui.css`'s.

/** The dial draws in the icons' shared box. */
export const DIAL_VIEWBOX = ICON_VIEWBOX;
/** The face's centre sits below the box's centre, leaving the top band for the crown. */
export const DIAL_CY = 1.4;
/** The ring: radius and stroke width (its outer edge stays inside the box). */
export const DIAL_RING_R = 7.2;
export const DIAL_RING_STROKE = 1.8;
/** The crown: a short stem from the ring up to a cap bar. */
export const DIAL_CROWN_D = 'M-2.2 -9H2.2M0 -9V-6.7';
export const DIAL_CROWN_STROKE = 1.8;
/** The face inside the ring — the track disc and the wedge share its radius, clear of the
 *  ring's inner edge. */
export const DIAL_FACE_R = 5;
/** The wedge is a circle of half the face radius stroked the face radius wide: its dash then
 *  paints a pie sector of the face (`dialDash`). */
export const DIAL_WEDGE_R = DIAL_FACE_R / 2;
export const DIAL_WEDGE_CIRCUMFERENCE = 2 * Math.PI * DIAL_WEDGE_R;

/** The dial's parts, for `overlay.ts` to update in place. */
export interface CountdownDialParts {
  /** The positioned wrapper inside the primary Dock button — an HTML element, so the UA's
   *  `[hidden]` rule takes the dial out of the paint when there is no countdown to show. */
  readonly root: HTMLSpanElement;
  /** The remaining-time wedge, whose dash `overlay.ts` writes. */
  readonly progress: SVGCircleElement;
}

/** The countdown dial (#181 H1): the stopwatch face above, drawn INSIDE the primary Dock
 *  button. It carries no text — the wave chip's glance is the readable countdown, at every
 *  text size — and no animation of any kind: the wedge only takes a new value when the second
 *  changes. Its size, inset and room come from the Dock pass (`dock-reserve.ts`), which also
 *  withholds it wherever the label would not clear it. */
export function countdownDial(doc: Document): CountdownDialParts {
  const root = doc.createElement('span');
  root.className = 'wy-dial';
  root.setAttribute('aria-hidden', 'true');
  const svg = el(doc, 'svg', {
    class: 'wy-dial-svg',
    viewBox: DIAL_VIEWBOX,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const cy = String(DIAL_CY);
  const crown = el(doc, 'path', {
    class: 'wy-dial-crown',
    d: DIAL_CROWN_D,
    fill: 'none',
    'stroke-width': String(DIAL_CROWN_STROKE),
    'stroke-linecap': 'round',
  });
  const ring = el(doc, 'circle', {
    class: 'wy-dial-ring',
    cx: '0',
    cy,
    r: String(DIAL_RING_R),
    fill: 'none',
    'stroke-width': String(DIAL_RING_STROKE),
  });
  const track = el(doc, 'circle', { class: 'wy-dial-track', cx: '0', cy, r: String(DIAL_FACE_R) });
  const progress = el(doc, 'circle', {
    class: 'wy-dial-wedge',
    cx: '0',
    cy,
    r: String(DIAL_WEDGE_R),
    fill: 'none',
    'stroke-width': String(DIAL_FACE_R),
    transform: `rotate(-90 0 ${cy})`,
    'stroke-dasharray': dialDash(1),
  });
  svg.append(crown, ring, track, progress);
  root.append(svg);
  return { root, progress };
}

/** The wedge's dash for a remaining fraction, clamped to [0, 1]: the drawn length, then a gap
 *  of the whole circumference so the dash pattern never repeats onto the track. */
export function dialDash(fraction: number): string {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return `${fmt(DIAL_WEDGE_CIRCUMFERENCE * f)} ${fmt(DIAL_WEDGE_CIRCUMFERENCE)}`;
}
