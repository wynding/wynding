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
// THE CREEP ICONS DRAW THE BOARD'S OWN CREEP ART (#181 C3/C4). What a creep looks like — its
// silhouette, its family's hue and size step, a flyer's wings — is the render package's art,
// one master for the board's atlas and this strip: the icon asks for the look
// (`creepLookFor`), takes its art (`creepIconArt`) and has the package's SVG renderer
// (`artSvgNodes`) write it, so no geometry is restated here. Two things differ from the board,
// both because an icon has no floor under it: no ground shadow and no lift (depth cues for the
// board's floor), and one shared scale that fits every look on the ground in the icon's box —
// the boss the largest, so the strip keeps the board's size steps. A flyer's wings reach past
// the box's sides, as the icon lets them; in Compact the strip's margin keeps them inside the
// column's edge (`ui.css`).
//
// Colour comes from the ACTIVE palette (`creepArtColour`), so the icons follow the
// colour-vision mode: each element carries the colour token it paints in, and
// `paintCreepIcon` re-inks a built icon in place from those.

import {
  artSvgNodes,
  creepArtColour,
  creepIconArt,
  creepLookFor,
  type ArtColour,
  type CreepFamily,
  type Palette,
} from '@wynding/render';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The icons' shared coordinate box, the style frame's own (`viewBox="-10 -10 20 20"`) — the
 *  box `creepIconArt` scales the creep art to. */
export const ICON_VIEWBOX = '-10 -10 20 20';

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

/** What a creep icon depicts — the wave preview entry's catalog join, nothing per-tick. */
export interface CreepIconSpec {
  readonly creepId: string;
  readonly domain: 'ground' | 'air';
  readonly boss: boolean;
}

/** The class each part of a creep icon carries, by the colour it paints in: the silhouette in
 *  its family's hue is the body, anything else is a wing — the forced-colors rules (`ui.css`)
 *  repaint the two differently, so a flyer's wings stay apart from its body. */
const partClass = (fill: string | undefined): string =>
  fill === 'family' ? 'wy-creep-body' : 'wy-creep-wing';

/** A creep icon: the board's own art for `spec`'s look — its silhouette in its family's hue,
 *  outlined in ink, at its family's size step, a flyer's wings attached — written by the
 *  render package's SVG renderer, and inked from `palette`. */
export function creepIcon(doc: Document, spec: CreepIconSpec, palette: Palette): SVGSVGElement {
  const svg = iconRoot(doc, 'wy-creep-icon');
  const look = creepLookFor(spec.creepId, spec.boss, spec.domain === 'air');
  svg.dataset.wyShape = look.shape;
  svg.dataset.wyFamily = look.family;
  const { shapes, scale } = creepIconArt(look);
  // Design units to icon units: the art's own strokes scale with it, as the board's do.
  const art = el(doc, 'g', { transform: `scale(${Math.round(scale * 1e4) / 1e4})` });
  for (const node of artSvgNodes(shapes)) {
    art.append(el(doc, node.tag, { class: partClass(node.attrs['data-art-fill']), ...node.attrs }));
  }
  svg.append(art);
  paintCreepIcon(svg, palette);
  return svg;
}

/** Re-ink a built creep icon for `palette` — the colour-mode repaint. Touches only each part's
 *  `fill` and `stroke`, set from the colour token it carries, so a repaint never rebuilds the
 *  strip under a reader. */
export function paintCreepIcon(svg: SVGSVGElement, palette: Palette): void {
  const family = svg.dataset.wyFamily as CreepFamily;
  const ink = (token: string | null): string =>
    hexColour(creepArtColour(token as ArtColour, palette, family));
  for (const part of svg.querySelectorAll('[data-art-fill]')) {
    part.setAttribute('fill', ink(part.getAttribute('data-art-fill')));
  }
  for (const part of svg.querySelectorAll('[data-art-stroke]')) {
    part.setAttribute('stroke', ink(part.getAttribute('data-art-stroke')));
  }
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
