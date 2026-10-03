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
import { artGraphics, type ArtColourResolver } from './art-paint';
import { cssColour } from './canvas-graphics';
import { fakeContext, fakePath, type CtxOp } from './test-support/fake-context';
import { alignArtToTexels, alignRectToTexels, strokeWidthAt, type ArtShape } from './art-ir';
import { creepRadius } from './board-draw';
import { CREEP_SHAPE_VALUES } from './creep-paint';
import {
  ART_BOX,
  ART_FOOTPRINT,
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
import { resolvePalette, roleColour } from './palette';
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

  it('paints the plate frame as the plate art — its rim moved onto whole texels — its colours from the palette', () => {
    const ops = artOps(paint(frame(PLATE_FRAME_KEY)));
    expect(ops).toHaveLength(1);
    const call = ops[0] as ArtCall;
    // The plate art itself, shape for shape, but for its one crisp shape — the rim — which is
    // moved onto the frame's texel grid (the raster test at the end measures the result).
    expect(PLATE_ART.filter((s) => s.kind === 'rect' && s.crisp === true)).toHaveLength(1);
    expect(call.shapes).toHaveLength(PLATE_ART.length);
    PLATE_ART.forEach((s, i) => {
      if (s.kind === 'rect' && s.crisp === true) {
        expect(call.shapes[i]).toEqual(alignRectToTexels(s, artUnit(20), 1, [0, 0], ART_FOOTPRINT));
        // At 20px cells the design rim's edges are off the grid, so it really moved.
        expect(call.shapes[i]).not.toEqual(s);
      } else {
        expect(call.shapes[i]).toBe(s);
      }
    });
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
    // The dashed rim is crisp, so it is painted on the frame's texel grid — which at 20px
    // cells moves it off its design position (the raster test at the end measures it).
    const rimOnGrid = alignArtToTexels(PENDING_RIM_ART, artUnit(20), 1, [0, 0], ART_FOOTPRINT);
    expect(rimOnGrid).not.toEqual(PENDING_RIM_ART);
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
        { op: 'art', shapes: rimOnGrid },
      ]);
      // The head is painted in its own role's colour, in every mode — the colour the
      // palette gates a pending head in against its faded plate (`palette.test.ts`).
      for (const mode of ['default', 'protan', 'tritan'] as const) {
        const head = artCalls(paint(frame(key), mode)).find(
          (c) => c.shapes === HEAD_ART[l.mark].shapes,
        );
        expect(head, `${key} ${mode}`).toBeDefined();
        expect(head!.colour('role'), `${key} ${mode}`).toBe(
          roleColour(resolvePalette(mode), l.role),
        );
      }
    }
  });

  it('paints the pad as the pad art, in the floor colour of the palette it is handed', () => {
    // A floor no mode has, so the colour can only have come from the palette handed in.
    const g = recorder();
    frame(PAD_FRAME_KEY).paint(g, { ...PAL, floor: 0x123456 });
    const calls = artCalls(g.calls);
    expect(calls.map((c) => c.shapes)).toEqual([PAD_ART]);
    expect(calls[0]!.colour('floor')).toBe(0x123456);
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

  it('given its surface’s pixel scale, draws the plate’s rim crisp on that surface’s pixels', () => {
    // A fitted swatch's corner is anywhere — here at (3.3, 5.7) CSS px on a dpr 1.5 canvas.
    const [x, y, footprintPx, scale] = [3.3, 5.7, 31.4, 1.5];
    const g = recorder();
    paintTowerArt(g, PAL, { mark: 'ringed', role: 'control' }, x, y, footprintPx, scale);
    const [plate, head] = artCalls(g.calls);
    const unit = footprintPx / ART_BOX;
    expect(plate!.shapes).toEqual(
      alignArtToTexels(PLATE_ART, unit, scale, [x * scale, y * scale], ART_FOOTPRINT),
    );
    expect(head!.shapes).toBe(HEAD_ART.ringed.shapes);
    const rim = plate!.shapes.find((s) => s.stroke === 'rim')!;
    if (rim.kind !== 'rect') throw new Error('the rim is a rect');
    const half = (strokeWidthAt(rim, unit) * unit * scale) / 2;
    for (const [corner, edge] of [
      [x, rim.x],
      [y, rim.y],
      [x, rim.x + rim.w],
      [y, rim.y + rim.h],
    ] as const) {
      // Device px: each edge's stroke starts on a whole pixel — and, whole pixels wide, it
      // ends on one.
      const start = (corner + edge * unit) * scale - half;
      expect(Math.abs(start - Math.round(start))).toBeLessThan(1e-9);
      expect(Math.abs(2 * half - Math.round(2 * half))).toBeLessThan(1e-9);
    }
  });

  it('keeps the plate’s rim inside the footprint on the surface’s pixels, where its floor would spill it', () => {
    // A 22px footprint (11px cells) on a dpr 1.25 canvas, its corner 0.3 device px into a
    // pixel: the rim's one-CSS-px floor makes it 2px, and placed freely it would start on
    // pixel 0, partly outside the footprint (which starts at 0.3), and end on pixel 28, past
    // the footprint's end at 27.8. Kept inside, it runs from pixel 1 to pixel 27.
    const [x, y, footprintPx, scale] = [0.24, 0.24, 22, 1.25];
    const g = recorder();
    paintTowerArt(g, PAL, { mark: 'ringed', role: 'control' }, x, y, footprintPx, scale);
    const [plate] = artCalls(g.calls);
    const rim = plate!.shapes.find((s) => s.stroke === 'rim')!;
    if (rim.kind !== 'rect') throw new Error('the rim is a rect');
    const unit = footprintPx / ART_BOX;
    const half = (strokeWidthAt(rim, unit) * unit * scale) / 2;
    expect(2 * half).toBeCloseTo(2, 9);
    expect((x + rim.x * unit) * scale - half).toBeCloseTo(1, 9);
    expect((x + (rim.x + rim.w) * unit) * scale + half).toBeCloseTo(27, 9);
    expect((y + rim.y * unit) * scale - half).toBeCloseTo(1, 9);
    expect((y + (rim.y + rim.h) * unit) * scale + half).toBeCloseTo(27, 9);
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

// ---- The rim reaches its full colour (QC round 2, A4) ----
//
// A 1px stroke whose centre line falls inside a texel straddles two, and is anti-aliased to
// partial cover in both: at 10px cells and dpr 1 the plate rim measured about 56% and 44%,
// so the footprint's edge read at 2.2:1 instead of the rim colour's 4.08:1. What this
// measures is what the frame actually PAINTS: the frame is painted into a recording context
// and its rim strokes rasterised from the recorded path, transform, width and dash.

type Mat = readonly [number, number, number, number, number, number];

/** `m` then `n`, as Canvas2D's `transform()` composes them. */
const compose = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Mat, [x, y]: readonly [number, number]): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/** A straight run of a stroked path, texel space, with the path length it starts at. */
interface Run {
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  /** Path length at `from`, texels — where the dash pattern stands there. */
  readonly s0: number;
}

/** Whether path length `s` (texels) falls in a dash of `dash` (texels) — always, undashed. */
function dashOn(s: number, dash: readonly number[]): boolean {
  if (dash.length === 0) return true;
  const period = dash.reduce((a, b) => a + b, 0);
  let t = ((s % period) + period) % period;
  for (let i = 0; i < dash.length; i++) {
    if (t < dash[i]!) return i % 2 === 0;
    t -= dash[i]!;
  }
  return false;
}

const SS = 8; // samples per texel side

/** The most any one texel along `run` is covered by a butt-capped stroke `width` texels
 *  wide, dashed by `dash` (texels): 1 when some texel lies wholly inside the stroke and
 *  inside a dash. */
function runPeak(run: Run, width: number, dash: readonly number[]): number {
  const [x0, y0] = run.from;
  const [x1, y1] = run.to;
  const horizontal = Math.abs(y1 - y0) < 1e-9;
  expect(horizontal || Math.abs(x1 - x0) < 1e-9, 'a rim edge is axis-aligned').toBe(true);
  const [u0, u1, v] = horizontal ? [x0, x1, y0] : [y0, y1, x0];
  const dir = Math.sign(u1 - u0);
  const lo = Math.min(u0, u1);
  const hi = Math.max(u0, u1);
  const half = width / 2;
  let peak = 0;
  for (let i = Math.floor(lo); i < Math.ceil(hi); i++) {
    for (let j = Math.floor(v - half); j < Math.ceil(v + half); j++) {
      let hits = 0;
      for (let a = 0; a < SS; a++) {
        const u = i + (a + 0.5) / SS;
        if (u < lo || u > hi || !dashOn(run.s0 + (u - u0) * dir, dash)) continue;
        for (let b = 0; b < SS; b++) {
          if (Math.abs(j + (b + 0.5) / SS - v) <= half) hits++;
        }
      }
      peak = Math.max(peak, hits / (SS * SS));
    }
  }
  return peak;
}

/** Each straight edge of every stroke `ops` drew in `strokeStyle`, as its peak texel
 *  coverage — replaying the recorded transform, path, width and dash as Canvas2D would. */
function strokeEdgePeaks(ops: readonly CtxOp[], strokeStyle: string): number[] {
  let m: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  let runs: Run[] = [];
  let cur: [number, number] | null = null;
  let start: [number, number] | null = null;
  let s = 0; // path length so far, texels (a uniform scale: one factor for both axes)
  let style = '';
  let lineWidth = 1;
  let dash: number[] = [];
  const peaks: number[] = [];
  const lineTo = (p: [number, number]): void => {
    const len = Math.hypot(p[0] - cur![0], p[1] - cur![1]);
    if (len > 1e-6) runs.push({ from: cur!, to: p, s0: s });
    s += len;
    cur = p;
  };
  for (const { op, args } of ops) {
    const n = args as number[];
    if (op === 'save') stack.push(m);
    else if (op === 'restore') m = stack.pop()!;
    else if (op === 'setTransform') m = n as unknown as Mat;
    else if (op === 'transform') m = compose(m, n as unknown as Mat);
    else if (op === 'set:strokeStyle') style = String(args[0]);
    else if (op === 'set:lineWidth') lineWidth = n[0]!;
    else if (op === 'setLineDash') dash = [...(args[0] as number[])];
    else if (op === 'beginPath') {
      runs = [];
      cur = start = null;
    } else if (op === 'moveTo') {
      cur = start = apply(m, [n[0]!, n[1]!]);
      s = 0; // the dash pattern restarts with every subpath
    } else if (op === 'lineTo') lineTo(apply(m, [n[0]!, n[1]!]));
    else if (op === 'arc') {
      const [cx, cy, r, a0, a1] = n as [number, number, number, number, number];
      if (cur !== null) lineTo(apply(m, [cx + r * Math.cos(a0), cy + r * Math.sin(a0)]));
      s += r * Math.abs(a1 - a0) * m[0];
      cur = apply(m, [cx + r * Math.cos(a1), cy + r * Math.sin(a1)]);
    } else if (op === 'closePath') {
      if (cur !== null && start !== null) lineTo(start);
    } else if (op === 'stroke' && style === strokeStyle) {
      expect([m[1], m[2]], 'no rotation or skew').toEqual([0, 0]);
      expect(m[0]).toBeCloseTo(m[3], 12);
      for (const run of runs) {
        peaks.push(
          runPeak(
            run,
            lineWidth * m[0],
            dash.map((d) => d * m[0]),
          ),
        );
      }
    }
  }
  return peaks;
}

describe('the rim reaches its full colour — a whole texel on every straight edge (QC round 2)', () => {
  const RIM = cssColour(PAL.tower, 1);
  /** What frame `spec` paints at `scale` texels per CSS px, as recorded context ops. */
  const painted = (spec: FrameSpec, scale: number): CtxOp[] => {
    const ctx = fakeContext({ recordStyles: true });
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const g = artGraphics(ctx, fakePath);
    spec.paint(g, PAL);
    g.flush();
    return ctx.ops;
  };

  for (const scale of [1, 1.25, 1.5]) {
    it(`at dpr ${scale}, cells of 10 to 24px: the plate's solid rim and a pending build's dashed one`, () => {
      const misses: string[] = [];
      for (let cellPx = 10; cellPx <= 24; cellPx++) {
        const specs = new Map(towerFrameSpecs(cellPx, scale).map((f) => [f.key, f]));
        for (const key of [PLATE_FRAME_KEY, pendingFrameKey('basic'), pendingFrameKey('mine')]) {
          const peaks = strokeEdgePeaks(painted(specs.get(key)!, scale), RIM);
          // Four straight edges, and each has a texel the rim colour fills.
          expect(peaks, `${key} at ${cellPx}px`).toHaveLength(4);
          const worst = Math.min(...peaks);
          if (worst < 1 - 1e-9) misses.push(`${key} ${cellPx}px: ${worst.toFixed(3)}`);
        }
      }
      expect(misses).toEqual([]);
    });
  }

  it('can fail: a 1px stroke centred inside a texel covers none of it whole', () => {
    const ops: CtxOp[] = [
      { op: 'set:strokeStyle', args: [RIM] },
      { op: 'set:lineWidth', args: [1] },
      { op: 'beginPath', args: [] },
      { op: 'moveTo', args: [0, 2.9375] },
      { op: 'lineTo', args: [10, 2.9375] },
      { op: 'stroke', args: [] },
    ];
    // (It covers 0.5625 of its nearer texel, and 0.4375 of the other.)
    const offGrid = strokeEdgePeaks(ops, RIM)[0]!;
    expect(offGrid).toBeGreaterThan(0.5);
    expect(offGrid).toBeLessThan(1);
    // ... and the same stroke on a half texel covers one whole.
    ops[3] = { op: 'moveTo', args: [0, 2.5] };
    ops[4] = { op: 'lineTo', args: [10, 2.5] };
    expect(strokeEdgePeaks(ops, RIM)[0]).toBe(1);
    // A dash pattern shorter than a texel never covers one whole along the edge.
    ops.splice(2, 0, { op: 'setLineDash', args: [[0.5, 0.5]] });
    expect(strokeEdgePeaks(ops, RIM)[0]).toBeLessThan(1);
  });
});

describe('the boost glow stays inside the rim as the frames draw them (QC round 2)', () => {
  it('the plate and boosted head frames draw the plate art on the texel grid and the glow as designed, from one corner', () => {
    // What the sweep below measures, pinned against the frames themselves at every size the
    // frame tests use: the plate frame draws `alignArtToTexels(PLATE_ART)` with design-unit
    // (0, 0) — the footprint corner — on a whole texel, and the boosted head draws the glow
    // unmoved, from that same corner at the same scale.
    for (const [cellPx, scale] of SIZES) {
      const specs = new Map(towerFrameSpecs(cellPx, scale).map((f) => [f.key, f]));
      const [plate] = artCalls(paint(specs.get(PLATE_FRAME_KEY)!));
      const [head] = artCalls(paint(specs.get(headFrameKey('basic', true))!));
      const at = `${cellPx}px at dpr ${scale}`;
      expect(plate!.shapes, at).toEqual(
        alignArtToTexels(PLATE_ART, artUnit(cellPx), scale, [0, 0], ART_FOOTPRINT),
      );
      expect(head!.shapes.slice(0, BOOST_ART.length), at).toEqual(BOOST_ART);
      expect([head!.x, head!.y, head!.unit], at).toEqual([plate!.x, plate!.y, plate!.unit]);
      expect(plate!.x * scale, at).toBeCloseTo(Math.round(plate!.x * scale), 9);
      expect(plate!.y * scale, at).toBeCloseTo(Math.round(plate!.y * scale), 9);
    }
  });

  it('keeps the plate frame’s rim inside the footprint where its floor would spill it — 11px cells at dpr 1.25', () => {
    // There the rim's one-CSS-px floor makes it 2 texels, grown outward: placed freely, its
    // far side would end on texel 28, half a texel past the footprint's end at 27.5 — in the
    // next tower's footprint. The frame draws it ending on texel 27.
    const [cellPx, scale] = [11, 1.25];
    const unit = artUnit(cellPx);
    const k = unit * scale;
    const specs = new Map(towerFrameSpecs(cellPx, scale).map((f) => [f.key, f]));
    const [plate] = artCalls(paint(specs.get(PLATE_FRAME_KEY)!));
    const rim = plate!.shapes.find((s) => s.stroke === 'rim')!;
    if (rim.kind !== 'rect') throw new Error('the rim is a rect');
    const half = (strokeWidthAt(rim, unit) * k) / 2;
    expect(ART_BOX * k).toBeCloseTo(27.5, 9);
    expect(2 * half).toBeCloseTo(2, 9);
    expect(rim.x * k - half).toBeCloseTo(0, 9); // the footprint's first texel
    expect((rim.x + rim.w) * k + half).toBeCloseTo(27, 9); // its last whole one
  });

  it('at every cell size from 10 to 64px and dpr from 1 to 3: the rim no thinner than its floor and inside the footprint, each glow ring inside the rim', () => {
    // The glow is `pal.aura`, gated against the PLATE (palette.test.ts) and not against the
    // rim, so it must stay inside the rim. Drawing the rim on whole device pixels moves it up
    // to half a pixel, a different way at each cell size and dpr — so this measures the rim
    // as the plate frame draws it (pinned above), everywhere, not the design's.
    const designRim = PLATE_ART.find((s) => s.stroke === 'rim')!;
    expect(BOOST_ART.filter((s) => s.stroke === 'aura')).toHaveLength(2);
    let worst = { margin: Infinity, at: '' };
    for (const scale of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
      for (let cellPx = 10; cellPx <= 64; cellPx++) {
        const unit = artUnit(cellPx);
        const rim = alignArtToTexels(PLATE_ART, unit, scale, [0, 0], ART_FOOTPRINT).find(
          (s) => s.stroke === 'rim',
        )!;
        if (rim.kind !== 'rect') throw new Error('the rim is a rect');
        const half = strokeWidthAt(rim, unit) / 2;
        const k = unit * scale;
        const at = `${cellPx}px at dpr ${scale}`;
        // Never thinner than its one-CSS-px floor — so two texels at a fractional dpr, where a
        // canvas shown a fraction of a pixel off the grid would smear a one-texel line ...
        expect(2 * half * k, at).toBeGreaterThanOrEqual(scale - 1e-9);
        // ... and inside the footprint, so two abutting plates never overlap.
        expect((rim.x - half) * k, at).toBeGreaterThanOrEqual(-1e-9);
        expect((rim.x + rim.w + half) * k, at).toBeLessThanOrEqual(ART_BOX * k + 1e-9);
        for (const ring of BOOST_ART) {
          if (ring.kind !== 'circle') throw new Error('the glow is rings');
          const outer = ring.r + strokeWidthAt(ring, unit) / 2;
          // The narrowest gap, texels, between the ring's outer edge and the rim's inner edge.
          const margin =
            Math.min(
              ring.cx - outer - (rim.x + half),
              rim.x + rim.w - half - (ring.cx + outer),
              ring.cy - outer - (rim.y + half),
              rim.y + rim.h - half - (ring.cy + outer),
            ) *
            unit *
            scale;
          if (margin < worst.margin) worst = { margin, at: `${cellPx}px at dpr ${scale}` };
        }
        // (The rim measured is the aligned one: at 10px cells and dpr 1 it moved.)
        if (cellPx === 10 && scale === 1) expect(rim).not.toEqual(designRim);
      }
    }
    expect(worst.margin, worst.at).toBeGreaterThan(0);
  });
});
