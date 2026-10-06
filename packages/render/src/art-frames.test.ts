// art-frames.test.ts — the board atlas's frame catalogue: every key placement can ask for
// is baked, keys follow the look (mark/shape/state) rather than the catalog id, frames are
// sized and anchored on whole texels, and every painter stays inside its own frame.

import { describe, it, expect } from 'vitest';
import {
  atlasFrameSpecs,
  creepFrameKey,
  creepFrameSpecs,
  towerFrameKey,
  towerFrameSpecs,
  FRAME_PAD_TEXELS,
  type FrameSpec,
} from './art-frames';
import { creepRadius, type GraphicsLike } from './board-draw';
import { CREEP_SHAPE_VALUES } from './creep-paint';
import { TOWER_FOOTPRINT_MARKS } from './tower-paint';
import { resolvePalette } from './palette';

type Call = { method: string; args: number[] | unknown[] };

function recorder(): GraphicsLike & { calls: Call[] } {
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

const PAL = resolvePalette('default');

/** The axis-aligned extent of everything `spec` paints, strokes grown by half their width. */
function paintedExtent(spec: FrameSpec): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const g = recorder();
  spec.paint(g, PAL);
  let half = 0;
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (x: number, y: number, grow: number): void => {
    box.minX = Math.min(box.minX, x - grow);
    box.minY = Math.min(box.minY, y - grow);
    box.maxX = Math.max(box.maxX, x + grow);
    box.maxY = Math.max(box.maxY, y + grow);
  };
  for (const { method, args } of g.calls) {
    const a = args as number[];
    if (method === 'lineStyle') half = (a[0] as number) / 2;
    else if (method === 'fillRect' || method === 'fillRoundedRect') {
      add(a[0]!, a[1]!, 0);
      add(a[0]! + a[2]!, a[1]! + a[3]!, 0);
    } else if (method === 'strokeRoundedRect') {
      add(a[0]!, a[1]!, half);
      add(a[0]! + a[2]!, a[1]! + a[3]!, half);
    } else if (method === 'fillCircle') add(a[0]!, a[1]!, a[2]!);
    else if (method === 'strokeCircle') add(a[0]!, a[1]!, a[2]! + half);
    else if (method === 'lineBetween') {
      add(a[0]!, a[1]!, half);
      add(a[2]!, a[3]!, half);
    } else if (method === 'fillTriangle') {
      add(a[0]!, a[1]!, 0);
      add(a[2]!, a[3]!, 0);
      add(a[4]!, a[5]!, 0);
    } else if (method === 'fillPoints') {
      for (const p of args[0] as { x: number; y: number }[]) add(p.x, p.y, 0);
    }
  }
  return box;
}

describe('frame keys follow the look, not the catalog id', () => {
  it('keys a tower frame by its footprint mark and state', () => {
    expect(towerFrameKey('slow', 'committed')).toBe('tower:ringed:committed');
    expect(towerFrameKey('venom', 'buffed')).toBe('tower:droplet:buffed');
    expect(towerFrameKey('frost-splash', 'pending')).toBe('tower:ringed-crosshair:pending');
    // An id the catalog has never heard of draws `basic`'s plain body — the SAME frame.
    expect(towerFrameKey('no-such-tower', 'committed')).toBe(towerFrameKey('basic', 'committed'));
  });

  it('keys a creep frame by its shape, its low-health tint and its boss size', () => {
    expect(creepFrameKey('armored', 1, false)).toBe('creep:hexagon:normal:standard');
    expect(creepFrameKey('boss', 1, true)).toBe('creep:hexagon:normal:boss');
    expect(creepFrameKey('fast', 0.1, false)).toBe('creep:diamond:low:standard');
    expect(creepFrameKey('no-such-creep', 1, false)).toBe(creepFrameKey('normal', 1, false));
  });

  it('turns low-health strictly BELOW a third of max HP (0.34), matching the live pip', () => {
    expect(creepFrameKey('normal', 0.34, false)).toBe('creep:triangle:normal:standard');
    expect(creepFrameKey('normal', 0.3399, false)).toBe('creep:triangle:low:standard');
    expect(creepFrameKey('normal', 0, false)).toBe('creep:triangle:low:standard');
  });
});

describe('atlasFrameSpecs — the whole catalogue', () => {
  const specs = atlasFrameSpecs(20, 1);
  const keys = new Set(specs.map((s) => s.key));

  it('bakes every key placement can produce: each mark × state, each shape × tint × size', () => {
    expect(specs).toHaveLength(keys.size); // no duplicate keys
    expect(specs).toHaveLength(TOWER_FOOTPRINT_MARKS.length * 3 + CREEP_SHAPE_VALUES.length * 4);
    for (const mark of TOWER_FOOTPRINT_MARKS) {
      for (const state of ['committed', 'buffed', 'pending']) {
        expect(keys.has(`tower:${mark}:${state}`)).toBe(true);
      }
    }
    for (const shape of CREEP_SHAPE_VALUES) {
      for (const tint of ['normal', 'low']) {
        for (const size of ['standard', 'boss']) {
          expect(keys.has(`creep:${shape}:${tint}:${size}`)).toBe(true);
        }
      }
    }
  });

  it('enumerates all nine footprint marks and all five creep shapes', () => {
    expect([...TOWER_FOOTPRINT_MARKS].sort()).toEqual([
      'arrow',
      'bolt',
      'charge',
      'crosshair',
      'droplet',
      'plain',
      'pylon',
      'ringed',
      'ringed-crosshair',
    ]);
    expect([...CREEP_SHAPE_VALUES].sort()).toEqual([
      'diamond',
      'hexagon',
      'pentagon',
      'square',
      'triangle',
    ]);
  });
});

describe('frame sizes and anchors sit on whole texels', () => {
  for (const [cellPx, scale] of [
    [10, 1],
    [32, 1],
    [13, 2],
    [21, 1.5],
    [17, 1.25],
  ] as const) {
    it(`at cellPx ${cellPx}, scale ${scale}`, () => {
      for (const spec of atlasFrameSpecs(cellPx, scale)) {
        expect(Number.isInteger(spec.width) && Number.isInteger(spec.height)).toBe(true);
        // The anchor is a whole number of texels from the frame's corner — which is what
        // lets a sprite snapped to a whole device pixel keep every texel on one.
        expect(Math.abs(spec.anchorX * scale - Math.round(spec.anchorX * scale))).toBeLessThan(
          1e-9,
        );
        expect(Math.abs(spec.anchorY * scale - Math.round(spec.anchorY * scale))).toBeLessThan(
          1e-9,
        );
      }
    });
  }

  it('sizes a tower frame to its 2×2 footprint plus the pad, anchored at the footprint corner', () => {
    for (const spec of towerFrameSpecs(21, 1.5)) {
      expect(spec.width).toBe(Math.ceil(21 * 2 * 1.5) + FRAME_PAD_TEXELS * 2);
      expect(spec.height).toBe(spec.width);
      expect(spec.anchorX).toBe(FRAME_PAD_TEXELS / 1.5);
      expect(spec.anchorY).toBe(FRAME_PAD_TEXELS / 1.5);
    }
  });

  it('sizes a creep frame around its radius — the boss at 1.5× — anchored at the centre', () => {
    for (const spec of creepFrameSpecs(20, 2)) {
      const boss = spec.key.endsWith(':boss');
      const half = Math.ceil(creepRadius(20, boss) * 2) + FRAME_PAD_TEXELS;
      expect(spec.width).toBe(half * 2);
      expect(spec.height).toBe(half * 2);
      expect(spec.anchorX).toBe(half / 2);
      expect(spec.anchorY).toBe(half / 2);
    }
    const [standard, boss] = [
      creepFrameSpecs(20, 1).find((s) => s.key === 'creep:hexagon:normal:standard')!,
      creepFrameSpecs(20, 1).find((s) => s.key === 'creep:hexagon:normal:boss')!,
    ];
    expect(boss.width).toBeGreaterThan(standard.width);
  });
});

describe('every painter stays inside its frame', () => {
  for (const [cellPx, scale] of [
    [10, 1], // the narrow compact floor
    [33, 2],
    [21, 1.5],
  ] as const) {
    it(`at cellPx ${cellPx}, scale ${scale}`, () => {
      for (const spec of atlasFrameSpecs(cellPx, scale)) {
        const box = paintedExtent(spec);
        expect(box.minX, spec.key).toBeGreaterThanOrEqual(0);
        expect(box.minY, spec.key).toBeGreaterThanOrEqual(0);
        expect(box.maxX, spec.key).toBeLessThanOrEqual(spec.width / scale);
        expect(box.maxY, spec.key).toBeLessThanOrEqual(spec.height / scale);
      }
    });
  }

  it('a creep silhouette is centred on its anchor', () => {
    for (const spec of creepFrameSpecs(20, 1)) {
      const box = paintedExtent(spec);
      const r = creepRadius(20, spec.key.endsWith(':boss'));
      // Every shape is symmetric about the centre's vertical, at most r out, apex at cy - r.
      expect((box.minX + box.maxX) / 2).toBeCloseTo(spec.anchorX, 9);
      expect(box.maxX - spec.anchorX).toBeLessThanOrEqual(r + 1e-9);
      expect(box.maxY - spec.anchorY).toBeLessThanOrEqual(r + 1e-9);
      expect(box.minY).toBeCloseTo(spec.anchorY - r, 9);
    }
  });

  it('a tower body fills its footprint at the 2px inset, measured from the anchor', () => {
    const spec = towerFrameSpecs(20, 1).find((s) => s.key === 'tower:plain:committed')!;
    const g = recorder();
    spec.paint(g, PAL);
    expect(g.calls.find((c) => c.method === 'fillRoundedRect')!.args).toEqual([
      spec.anchorX + 2,
      spec.anchorY + 2,
      36,
      36,
      6,
    ]);
  });
});

describe('painters draw in the palette they are handed', () => {
  it('fills a creep silhouette in creep, or creepLowHp for the low-health frame', () => {
    const fillOf = (key: string, mode: 'default' | 'tritan'): unknown => {
      const g = recorder();
      creepFrameSpecs(20, 1)
        .find((s) => s.key === key)!
        .paint(g, resolvePalette(mode));
      return g.calls.find((c) => c.method === 'fillStyle')!.args[0];
    };
    expect(fillOf('creep:square:normal:standard', 'default')).toBe(PAL.creep);
    expect(fillOf('creep:square:low:standard', 'default')).toBe(PAL.creepLowHp);
    // A colour-mode rebake repaints the same frame in the new palette.
    expect(fillOf('creep:square:normal:standard', 'tritan')).toBe(resolvePalette('tritan').creep);
  });

  it('paints a tower body in tower and its marks in floor; a pending frame in tower at 0.6', () => {
    const committed = recorder();
    towerFrameSpecs(20, 1)
      .find((s) => s.key === 'tower:ringed:committed')!
      .paint(committed, PAL);
    expect(committed.calls.find((c) => c.method === 'fillStyle')!.args).toEqual([PAL.tower, 1]);
    expect(committed.calls.find((c) => c.method === 'lineStyle')!.args).toEqual([2, PAL.floor, 1]);

    const pending = recorder();
    towerFrameSpecs(20, 1)
      .find((s) => s.key === 'tower:ringed:pending')!
      .paint(pending, PAL);
    expect(pending.calls.filter((c) => c.method === 'lineStyle').map((c) => c.args)).toEqual([
      [3, PAL.tower, 0.6], // the outline
      [1, PAL.tower, 0.6], // the mark — each primitive at its own alpha
    ]);
    expect(pending.calls.some((c) => c.method === 'fillRoundedRect')).toBe(false); // never filled
  });
});
