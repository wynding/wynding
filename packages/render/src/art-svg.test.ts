// art-svg.test.ts — the vector art kit's SVG renderer (visual pass, #181): IR shapes as SVG
// elements, geometry in design units, paint as SVG paints it, colours left as tokens.

import { describe, it, expect } from 'vitest';
import { artSvgNodes } from './art-svg';
import { strokeWidthAt, type ArtShape } from './art-ir';
import { CREEP_BODY, CREEP_WINGS, creepBodyArt } from './creep-art';

describe('artSvgNodes — one element per shape, in paint order', () => {
  it('writes each kind of shape as its SVG element, in design units', () => {
    const shapes: ArtShape[] = [
      { kind: 'path', d: 'M0 0L4 2', stroke: 'ink', width: 1 },
      { kind: 'circle', cx: 1.5, cy: -2, r: 3, fill: 'ink' },
      { kind: 'ellipse', cx: 1.8, cy: 6.2, rx: 10.5, ry: 4.8, fill: 'shadow' },
      { kind: 'rect', x: -8.2, y: -8.2, w: 16.4, h: 16.4, rx: 1.8, fill: 'family' },
      {
        kind: 'polygon',
        points: [
          [0, -9.4],
          [9.7, 7.4],
          [-9.7, 7.4],
        ],
        fill: 'family',
      },
    ];
    expect(artSvgNodes(shapes).map((n) => [n.tag, n.attrs])).toEqual([
      ['path', { d: 'M0 0L4 2', fill: 'none', 'data-art-stroke': 'ink', 'stroke-width': '1' }],
      ['circle', { cx: '1.5', cy: '-2', r: '3', 'data-art-fill': 'ink' }],
      ['ellipse', { cx: '1.8', cy: '6.2', rx: '10.5', ry: '4.8', 'data-art-fill': 'shadow' }],
      [
        'rect',
        {
          x: '-8.2',
          y: '-8.2',
          width: '16.4',
          height: '16.4',
          rx: '1.8',
          'data-art-fill': 'family',
        },
      ],
      ['polygon', { points: '0,-9.4 9.7,7.4 -9.7,7.4', 'data-art-fill': 'family' }],
    ]);
  });

  it('paints as the board’s painter does: a shape’s alpha on its fill and stroke, its join, cap and dash', () => {
    const [node] = artSvgNodes([
      {
        kind: 'circle',
        cx: 0,
        cy: 0,
        r: 4,
        fill: 'airborne',
        stroke: 'ink',
        width: 2,
        alpha: 0.5,
        join: 'round',
        cap: 'round',
        dash: [3, 1.5],
      },
    ]);
    expect(node!.attrs).toEqual({
      cx: '0',
      cy: '0',
      r: '4',
      'data-art-fill': 'airborne',
      'fill-opacity': '0.5',
      'data-art-stroke': 'ink',
      'stroke-width': '2',
      'stroke-opacity': '0.5',
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
      'stroke-dasharray': '3 1.5',
    });
  });

  it('raises a stroke to its CSS-px floor at the scale it is drawn at, and not without one', () => {
    const outline = CREEP_BODY.triangle; // 1.6 design units, floored at 1.4 CSS px
    // At 0.35 CSS px per unit (the narrow floor's radius) the floor binds: 1.4px is 4 units.
    const [floored] = artSvgNodes([outline], 0.35);
    expect(Number(floored!.attrs['stroke-width'])).toBeCloseTo(strokeWidthAt(outline, 0.35), 3);
    expect(Number(floored!.attrs['stroke-width'])).toBeCloseTo(4, 3);
    // At 2 CSS px per unit it does not, and without a scale no floor applies at all.
    expect(artSvgNodes([outline], 2)[0]!.attrs['stroke-width']).toBe('1.6');
    expect(artSvgNodes([outline])[0]!.attrs['stroke-width']).toBe('1.6');
  });

  it('writes numbers to a thousandth of a unit, never as -0', () => {
    const [node] = artSvgNodes([{ kind: 'circle', cx: -0, cy: 1 / 3, r: 2.00049, fill: 'ink' }]);
    expect(node!.attrs).toMatchObject({ cx: '0', cy: '0.333', r: '2' });
    // A negative radius would be an SVG error: clamped to zero, as the painter draws nothing.
    expect(artSvgNodes([{ kind: 'circle', cx: 0, cy: 0, r: -1, fill: 'ink' }])[0]!.attrs.r).toBe(
      '0',
    );
  });

  it('draws a flyer’s body art as three polygons: its two wings under its silhouette', () => {
    const nodes = artSvgNodes(creepBodyArt({ shape: 'hexagon', airborne: true }));
    expect(nodes.map((n) => n.tag)).toEqual(['polygon', 'polygon', 'polygon']);
    expect(nodes.map((n) => n.attrs['data-art-fill'])).toEqual(['airborne', 'airborne', 'family']);
    for (const n of nodes) expect(n.attrs['data-art-stroke']).toBe('ink');
    expect(nodes[0]!.attrs.points).toBe(
      (CREEP_WINGS[0] as Extract<ArtShape, { kind: 'polygon' }>).points
        .map(([x, y]) => `${x},${y}`)
        .join(' '),
    );
  });
});
