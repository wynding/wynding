// art-frames.test.ts — the board atlas's frame catalogue: every key placement can ask for
// is baked, keys follow the look (a tower's head silhouette and role, a creep's shape) rather
// than the catalog id, frames are sized around their art and anchored on whole texels, every
// painter stays inside its own frame, and painters draw in the palette they are handed.

import { describe, it, expect } from 'vitest';
import { getBundledRuleset } from '@wynding/content';
import {
  atlasFrameSpecs,
  artUnit,
  creepFrameKey,
  creepFrameSpecs,
  groundFrameKey,
  headFrameKey,
  paintTowerArt,
  pendingFrameKey,
  scorchFrameSpec,
  towerArtFit,
  towerFrameSpecs,
  towerHasPlate,
  FRAME_PAD_TEXELS,
  PAD_FRAME_KEY,
  PLATE_FRAME_KEY,
  SCORCH_FRAME_KEY,
  type FrameSpec,
} from './art-frames';
import { artBounds } from './art-geometry';
import type { ArtColourResolver } from './art-paint';
import type { ArtShape } from './art-ir';
import { creepRadius } from './board-draw';
import { CREEP_SHAPE_VALUES } from './creep-paint';
import {
  ART_BOX,
  BOOST_ART,
  HEAD_ART,
  PAD_ART,
  PENDING_ALPHA,
  PENDING_PLATE_ALPHA,
  PENDING_PLATE_ART,
  PENDING_RIM_ART,
  PLATE_ART,
  SCORCH_ART,
} from './tower-art';
import { TOWER_FOOTPRINT_MARKS, TOWER_LOOKS, towerLookKey } from './tower-paint';
import { resolvePalette } from './palette';
import {
  recordingArtGraphics as recorder,
  type Call as Recorded,
} from './test-support/recording-graphics';

interface ArtCall {
  readonly shapes: readonly ArtShape[];
  readonly colour: ArtColourResolver;
  readonly x: number;
  readonly y: number;
  readonly unit: number;
}

type ArtOp = ({ readonly op: 'art' } & ArtCall) | { readonly op: 'fade'; readonly alpha: number };

/** The `art`/`fade` calls a painter made, in order. */
function artOps(calls: readonly Recorded[]): ArtOp[] {
  return calls.flatMap((c): ArtOp[] => {
    if (c.method === 'art') {
      const [shapes, colour, x, y, unit] = c.args as [
        readonly ArtShape[],
        ArtColourResolver,
        number,
        number,
        number,
      ];
      return [{ op: 'art', shapes, colour, x, y, unit }];
    }
    if (c.method === 'fade') return [{ op: 'fade', alpha: c.args[0] as number }];
    return [];
  });
}

function artCalls(calls: readonly Recorded[]): ArtCall[] {
  return artOps(calls).filter((o): o is { op: 'art' } & ArtCall => o.op === 'art');
}

function paint(spec: FrameSpec, mode: 'default' | 'protan' | 'tritan' = 'default'): Recorded[] {
  const g = recorder();
  spec.paint(g, resolvePalette(mode));
  return g.calls;
}

const PAL = resolvePalette('default');

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The axis-aligned extent of everything `spec` paints, frame-local CSS px: art by its own
 *  bounds (strokes grown by their half-width at the art's scale), graphics primitives by
 *  their geometry (strokes grown likewise). */
function paintedExtent(spec: FrameSpec): Box {
  const calls = paint(spec);
  let half = 0;
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (x: number, y: number, grow: number): void => {
    box.minX = Math.min(box.minX, x - grow);
    box.minY = Math.min(box.minY, y - grow);
    box.maxX = Math.max(box.maxX, x + grow);
    box.maxY = Math.max(box.maxY, y + grow);
  };
  for (const { method, args } of calls) {
    const a = args as number[];
    if (method === 'art') {
      const { shapes, x, y, unit } = artCalls([{ method, args }])[0]!;
      const b = artBounds(shapes, unit);
      add(x + b.minX * unit, y + b.minY * unit, 0);
      add(x + b.maxX * unit, y + b.maxY * unit, 0);
    } else if (method === 'lineStyle') half = (a[0] as number) / 2;
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

const CATALOG_IDS = getBundledRuleset().towerCatalog.map((t) => t.id);

describe('frame keys follow the look, not the catalog id', () => {
  it('keys a tower head by its look — mark and role — and its boost; a pending build by its look', () => {
    expect(headFrameKey('slow', false)).toBe('tower:head:ringed:control:committed');
    expect(headFrameKey('venom', true)).toBe('tower:head:droplet:poison:buffed');
    expect(pendingFrameKey('frost-splash')).toBe('tower:pending:ringed-crosshair:control');
    expect(headFrameKey('mine', false)).toBe('tower:head:charge:burst:committed');
    // An id the catalog has never heard of looks like `basic` — the SAME frames.
    expect(headFrameKey('no-such-tower', false)).toBe(headFrameKey('basic', false));
    expect(headFrameKey('no-such-tower', true)).toBe(headFrameKey('basic', true));
    expect(pendingFrameKey('__proto__')).toBe(pendingFrameKey('basic'));
  });

  it('stands every tower on the one shared plate but the mine, which stands on its pad — an unknown id included', () => {
    for (const id of CATALOG_IDS) {
      expect(towerHasPlate(id), id).toBe(id !== 'mine');
      expect(groundFrameKey(id), id).toBe(id === 'mine' ? PAD_FRAME_KEY : PLATE_FRAME_KEY);
    }
    expect(towerHasPlate('no-such-tower')).toBe(true);
    expect(groundFrameKey('no-such-tower')).toBe(PLATE_FRAME_KEY);
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

  it('bakes every key placement can produce: the plate, the pad, each look × state, the scorch, each creep', () => {
    expect(specs).toHaveLength(keys.size); // no duplicate keys
    expect(specs).toHaveLength(2 + TOWER_LOOKS.length * 3 + 1 + CREEP_SHAPE_VALUES.length * 4);
    expect(keys.has(PLATE_FRAME_KEY)).toBe(true);
    expect(keys.has(PAD_FRAME_KEY)).toBe(true);
    expect(keys.has(SCORCH_FRAME_KEY)).toBe(true);
    // Every catalog id, and ids the catalog has never heard of, resolve to baked frames.
    for (const id of [...CATALOG_IDS, 'no-such-tower', '__proto__', '']) {
      for (const key of [
        groundFrameKey(id),
        headFrameKey(id, false),
        headFrameKey(id, true),
        pendingFrameKey(id),
      ]) {
        expect(keys.has(key), `${id}: ${key}`).toBe(true);
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

  it('has one look per catalog tower — nine — the unknown id folded into basic’s', () => {
    expect(TOWER_LOOKS.map(towerLookKey)).toEqual([
      'plain:damage',
      'ringed:control',
      'crosshair:damage',
      'droplet:poison',
      'bolt:control',
      'arrow:air',
      'pylon:support',
      'charge:burst',
      'ringed-crosshair:control',
    ]);
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

const SIZES = [
  [10, 1], // the narrow compact floor
  [13, 2], // a phone's cell at dpr 2
  [32, 1],
  [21, 1.5],
  [17, 1.25],
  [33, 3],
] as const;

describe('frame sizes and anchors sit on whole texels', () => {
  for (const [cellPx, scale] of SIZES) {
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

  it('anchors every tower frame at its footprint corner — the art’s design origin — so a plate and its head line up', () => {
    for (const [cellPx, scale] of SIZES) {
      for (const spec of towerFrameSpecs(cellPx, scale)) {
        // No tower art reaches above or left of its footprint corner, so every tower frame's
        // anchor is the pad in from its corner: the plate's and a head's sprites, placed at
        // the same corner, land on the same pixels.
        expect(spec.anchorX, spec.key).toBe(FRAME_PAD_TEXELS / scale);
        expect(spec.anchorY, spec.key).toBe(FRAME_PAD_TEXELS / scale);
        for (const call of artCalls(paint(spec))) {
          expect(call.x, spec.key).toBeCloseTo(spec.anchorX, 9);
          expect(call.y, spec.key).toBeCloseTo(spec.anchorY, 9);
          expect(call.unit, spec.key).toBe(artUnit(cellPx));
        }
      }
    }
  });

  it('sizes every art frame to its art — shadow, glow and strokes included — plus the pad, and no more', () => {
    for (const [cellPx, scale] of SIZES) {
      for (const spec of [...towerFrameSpecs(cellPx, scale), scorchFrameSpec(cellPx, scale)]) {
        const box = paintedExtent(spec);
        const pad = FRAME_PAD_TEXELS / scale;
        // At least the pad on every side...
        expect(box.minX, spec.key).toBeGreaterThanOrEqual(pad - 1e-9);
        expect(box.minY, spec.key).toBeGreaterThanOrEqual(pad - 1e-9);
        expect(spec.width / scale - box.maxX, spec.key).toBeGreaterThanOrEqual(pad - 1e-9);
        expect(spec.height / scale - box.maxY, spec.key).toBeGreaterThanOrEqual(pad - 1e-9);
        // ...and no more than the pad and a texel's rounding beyond the art and the anchor.
        const left = Math.min(box.minX, spec.anchorX);
        const top = Math.min(box.minY, spec.anchorY);
        expect(left, spec.key).toBeLessThan(pad + 1 / scale + 1e-9);
        expect(top, spec.key).toBeLessThan(pad + 1 / scale + 1e-9);
        const right = Math.max(box.maxX, spec.anchorX);
        const bottom = Math.max(box.maxY, spec.anchorY);
        expect(spec.width / scale - right, spec.key).toBeLessThan(pad + 1 / scale + 1e-9);
        expect(spec.height / scale - bottom, spec.key).toBeLessThan(pad + 1 / scale + 1e-9);
      }
    }
  });

  it('gives the plate frame room past the footprint for its offset shadow', () => {
    const cellPx = 20;
    const spec = towerFrameSpecs(cellPx, 1).find((s) => s.key === PLATE_FRAME_KEY)!;
    // The shadow is offset down and right: it reaches 66/64 of the footprint down.
    expect(spec.height - spec.anchorY).toBeGreaterThanOrEqual(cellPx * 2 * (66 / 64));
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
  for (const [cellPx, scale] of SIZES) {
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

  it('the scorch is centred on its anchor — the mine’s footprint centre', () => {
    for (const [cellPx, scale] of SIZES) {
      const spec = scorchFrameSpec(cellPx, scale);
      const [call] = artCalls(paint(spec));
      expect(call!.shapes).toBe(SCORCH_ART);
      expect(call!.x + (ART_BOX / 2) * call!.unit).toBeCloseTo(spec.anchorX, 9);
      expect(call!.y + (ART_BOX / 2) * call!.unit).toBeCloseTo(spec.anchorY, 9);
    }
  });
});

describe('painters draw the art they own, in the palette they are handed', () => {
  const at20 = towerFrameSpecs(20, 1);
  const frame = (key: string): FrameSpec => at20.find((s) => s.key === key)!;

  it('fills a creep silhouette in creep, or creepLowHp for the low-health frame', () => {
    const fillOf = (key: string, mode: 'default' | 'tritan'): unknown =>
      paint(
        creepFrameSpecs(20, 1).find((s) => s.key === key)!,
        mode,
      ).find((c) => c.method === 'fillStyle')!.args[0];
    expect(fillOf('creep:square:normal:standard', 'default')).toBe(PAL.creep);
    expect(fillOf('creep:square:low:standard', 'default')).toBe(PAL.creepLowHp);
    // A colour-mode rebake repaints the same frame in the new palette.
    expect(fillOf('creep:square:normal:standard', 'tritan')).toBe(resolvePalette('tritan').creep);
  });

  it('paints the plate frame as the plate art, its colours from the palette', () => {
    const ops = artOps(paint(frame(PLATE_FRAME_KEY)));
    expect(ops).toHaveLength(1);
    const call = ops[0] as ArtCall;
    expect(call.shapes).toBe(PLATE_ART);
    for (const mode of ['default', 'protan', 'tritan'] as const) {
      const pal = resolvePalette(mode);
      const c = artCalls(paint(frame(PLATE_FRAME_KEY), mode))[0]!.colour;
      expect(c('plate')).toBe(pal.plate);
      expect(c('rim')).toBe(pal.tower);
    }
  });

  it('paints a committed head as its look’s head art in its role’s colour — every look, every mode', () => {
    for (const l of TOWER_LOOKS) {
      const key = `tower:head:${towerLookKey(l)}:committed`;
      for (const mode of ['default', 'protan', 'tritan'] as const) {
        const ops = artOps(paint(frame(key), mode));
        expect(ops, key).toHaveLength(1);
        const call = ops[0] as ArtCall;
        expect(call.shapes, key).toBe(HEAD_ART[l.mark].shapes);
        const pal = resolvePalette(mode);
        const expected = {
          damage: pal.roleDamage,
          control: pal.roleControl,
          poison: pal.rolePoison,
          air: pal.roleAir,
          support: pal.roleSupport,
          burst: pal.roleBurst,
        }[l.role];
        expect(call.colour('role'), `${key} ${mode}`).toBe(expected);
      }
    }
  });

  it('paints a boosted head as the glow first, then the head over it', () => {
    for (const l of TOWER_LOOKS) {
      const key = `tower:head:${towerLookKey(l)}:buffed`;
      const ops = artOps(paint(frame(key)));
      expect(ops, key).toHaveLength(1);
      expect((ops[0] as ArtCall).shapes, key).toEqual([...BOOST_ART, ...HEAD_ART[l.mark].shapes]);
      expect((ops[0] as ArtCall).colour('aura'), key).toBe(PAL.aura);
    }
  });

  it('paints a pending build as its plate faded further than its head, then the dashed rim at full opacity', () => {
    for (const l of TOWER_LOOKS) {
      const key = `tower:pending:${towerLookKey(l)}`;
      const ops = artOps(paint(frame(key)));
      // The plate, faded so the head's fade takes it the rest of the way to
      // `PENDING_PLATE_ALPHA`; the head over it, opaque; both faded as ONE picture to the
      // head's `PENDING_ALPHA` — so the head covers the plate as a built tower's does — and
      // the dashed rim on top at full opacity. The plateless mine skips the first step.
      const plate = HEAD_ART[l.mark].plate
        ? [
            { op: 'art', shapes: PENDING_PLATE_ART },
            { op: 'fade', alpha: PENDING_PLATE_ALPHA / PENDING_ALPHA },
          ]
        : [];
      expect(
        ops.map((o) => (o.op === 'art' ? { op: 'art', shapes: o.shapes } : o)),
        key,
      ).toEqual([
        ...plate,
        { op: 'art', shapes: HEAD_ART[l.mark].shapes },
        { op: 'fade', alpha: PENDING_ALPHA },
        { op: 'art', shapes: PENDING_RIM_ART },
      ]);
    }
  });

  it('paints the pad as the pad art, in the floor colour of the mode it is handed', () => {
    for (const mode of ['default', 'tritan'] as const) {
      const calls = artCalls(paint(frame(PAD_FRAME_KEY), mode));
      expect(calls.map((c) => c.shapes)).toEqual([PAD_ART]);
      expect(calls[0]!.colour('floor')).toBe(resolvePalette(mode).floor);
    }
  });
});

describe('paintTowerArt — the Card swatch’s picture, through the same art and painter', () => {
  it('paints the plate, then the committed head, footprint corner at (x, y), 64 units across', () => {
    const g = recorder();
    const pal = resolvePalette('tritan');
    paintTowerArt(g, pal, { mark: 'ringed', role: 'control' }, 3, 5, 48);
    const calls = artCalls(g.calls);
    expect(calls.map((c) => c.shapes)).toEqual([PLATE_ART, HEAD_ART.ringed.shapes]);
    for (const c of calls) {
      expect([c.x, c.y, c.unit]).toEqual([3, 5, 48 / ART_BOX]);
      expect(c.colour('role')).toBe(pal.roleControl);
      expect(c.colour('plate')).toBe(pal.plate);
    }
  });

  it('paints the mine without a plate — its head carries its own shadow', () => {
    const g = recorder();
    paintTowerArt(g, PAL, { mark: 'charge', role: 'burst' }, 0, 0, 40);
    expect(artCalls(g.calls).map((c) => c.shapes)).toEqual([HEAD_ART.charge.shapes]);
  });
});

describe('towerArtFit — a whole tower, shadow included, centred in a square', () => {
  const everyTower = [...PLATE_ART, ...TOWER_FOOTPRINT_MARKS.flatMap((m) => HEAD_ART[m].shapes)];
  for (const size of [24, 36, 48, 96]) {
    it(`fits every tower’s whole picture inside a ${size}px square, touching it on the longer axis`, () => {
      const fit = towerArtFit(size);
      const unit = fit.footprintPx / ART_BOX;
      const b = artBounds(everyTower, unit);
      const [x0, x1] = [fit.x + b.minX * unit, fit.x + b.maxX * unit];
      const [y0, y1] = [fit.y + b.minY * unit, fit.y + b.maxY * unit];
      for (const v of [x0, y0]) expect(v).toBeGreaterThanOrEqual(-1e-9);
      for (const v of [x1, y1]) expect(v).toBeLessThanOrEqual(size + 1e-9);
      // Centred both ways, and the shadow's longer (vertical) reach spans the square.
      expect(x0 + x1).toBeCloseTo(size, 9);
      expect(y0 + y1).toBeCloseTo(size, 9);
      expect(y1 - y0).toBeCloseTo(size, 6);
    });
  }

  it('holds every head — the mine’s included — inside that same fit', () => {
    const fit = towerArtFit(36);
    const unit = fit.footprintPx / ART_BOX;
    for (const mark of TOWER_FOOTPRINT_MARKS) {
      const b = artBounds(HEAD_ART[mark].shapes, unit);
      expect(fit.x + b.minX * unit, mark).toBeGreaterThanOrEqual(-1e-9);
      expect(fit.y + b.minY * unit, mark).toBeGreaterThanOrEqual(-1e-9);
      expect(fit.x + b.maxX * unit, mark).toBeLessThanOrEqual(36 + 1e-9);
      expect(fit.y + b.maxY * unit, mark).toBeLessThanOrEqual(36 + 1e-9);
    }
  });
});
