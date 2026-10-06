// art-frames.test.ts — the board atlas's frame catalogue: every key placement can ask for
// is baked, keys follow the look (a tower's head silhouette and role, a creep's shape) rather
// than the catalog id, frames are sized around their art and anchored on whole texels, every
// painter stays inside its own frame, and painters draw in the palette they are handed.

import { describe, it, expect } from 'vitest';
import { getBundledRuleset } from '@wynding/content';
import {
  atlasFrameSpecs,
  artUnit,
  boostArtAt,
  creepFrameKey,
  creepFrameSpecs,
  groundFrameKey,
  headFrameKey,
  paintTowerArt,
  pendingFrameKey,
  scorchFrameSpec,
  towerAims,
  towerArtFit,
  towerFrameSpecs,
  towerHasPlate,
  FRAME_PAD_TEXELS,
  PAD_FRAME_KEY,
  PLATE_FRAME_KEY,
  SCORCH_FRAME_KEY,
  type FrameSpec,
} from './art-frames';
import { artBounds, flattenPath } from './art-geometry';
import { artGraphics, type ArtColourResolver } from './art-paint';
import { cssColour } from './canvas-graphics';
import { fakeContext, fakePath, type CtxOp } from './test-support/fake-context';
import { drawnRim, rimScales } from './test-support/rim-scales';
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

  it('turns the heads of exactly the towers the style frame aims — basic, venom, stun, antiair — and an unknown id, which looks like basic (T3)', () => {
    const aiming = new Set(['basic', 'venom', 'stun', 'antiair']);
    for (const id of CATALOG_IDS) expect(towerAims(id), id).toBe(aiming.has(id));
    expect(towerAims('no-such-tower')).toBe(true);
    expect(towerAims('__proto__')).toBe(true);
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

/** `spec`, at `scale` texels per CSS px, holds everything it paints — art by its bounds as
 *  painted, strokes grown — with the pad on every side, and no more than the pad and a
 *  texel's rounding beyond the art and its anchor. */
function expectSizedToArt(spec: FrameSpec, scale: number): void {
  const box = paintedExtent(spec);
  const pad = FRAME_PAD_TEXELS / scale;
  const at = `${spec.key} at scale ${scale}`;
  // At least the pad on every side...
  expect(box.minX, at).toBeGreaterThanOrEqual(pad - 1e-9);
  expect(box.minY, at).toBeGreaterThanOrEqual(pad - 1e-9);
  expect(spec.width / scale - box.maxX, at).toBeGreaterThanOrEqual(pad - 1e-9);
  expect(spec.height / scale - box.maxY, at).toBeGreaterThanOrEqual(pad - 1e-9);
  // ...and no more than the pad and a texel's rounding beyond the art and the anchor.
  const left = Math.min(box.minX, spec.anchorX);
  const top = Math.min(box.minY, spec.anchorY);
  expect(left, at).toBeLessThan(pad + 1 / scale + 1e-9);
  expect(top, at).toBeLessThan(pad + 1 / scale + 1e-9);
  const right = Math.max(box.maxX, spec.anchorX);
  const bottom = Math.max(box.maxY, spec.anchorY);
  expect(spec.width / scale - right, at).toBeLessThan(pad + 1 / scale + 1e-9);
  expect(spec.height / scale - bottom, at).toBeLessThan(pad + 1 / scale + 1e-9);
}

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
        expectSizedToArt(spec, scale);
      }
    }
  });

  it('pivots every frame on its art’s centre: a tower frame’s footprint centre, a cell right of and below its anchor (T3)', () => {
    for (const [cellPx, scale] of SIZES) {
      // The pivot is a fraction of the frame; in CSS px from its corner it is that fraction of
      // the frame's texels over the scale.
      const at = (spec: FrameSpec) => ({
        x: (spec.pivotX * spec.width) / scale,
        y: (spec.pivotY * spec.height) / scale,
      });
      for (const spec of towerFrameSpecs(cellPx, scale)) {
        expect(at(spec).x, spec.key).toBeCloseTo(spec.anchorX + cellPx, 9);
        expect(at(spec).y, spec.key).toBeCloseTo(spec.anchorY + cellPx, 9);
        // ... which is where the frame's art is painted centred: design (32, 32).
        for (const call of artCalls(paint(spec))) {
          expect(call.x + (ART_BOX / 2) * call.unit, spec.key).toBeCloseTo(at(spec).x, 9);
          expect(call.y + (ART_BOX / 2) * call.unit, spec.key).toBeCloseTo(at(spec).y, 9);
        }
      }
      // A scorch and a creep are anchored at their centres already.
      for (const spec of [scorchFrameSpec(cellPx, scale), ...creepFrameSpecs(cellPx, scale)]) {
        expect(at(spec).x, spec.key).toBeCloseTo(spec.anchorX, 9);
        expect(at(spec).y, spec.key).toBeCloseTo(spec.anchorY, 9);
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
    // (At 20px the design's glow fits inside the drawn rim: `boostArtAt` hands it back.)
    expect(boostArtAt(artUnit(20), 1)).toBe(BOOST_ART);
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

  it('measures the footprint’s far end from where its corner sits on the surface’s pixels', () => {
    // The same footprint with its corner 0.7 device px into a pixel ends at 28.2, so the 2px
    // rim, which placed freely ends on pixel 28, fits there: it runs from pixel 1 to 28. (A
    // bound measured from pixel 0 instead would end at 27.5, and push the rim in to 27.)
    const [x, y, footprintPx, scale] = [0.56, 0.56, 22, 1.25];
    const g = recorder();
    paintTowerArt(g, PAL, { mark: 'ringed', role: 'control' }, x, y, footprintPx, scale);
    const [plate] = artCalls(g.calls);
    const rim = plate!.shapes.find((s) => s.stroke === 'rim')!;
    if (rim.kind !== 'rect') throw new Error('the rim is a rect');
    const unit = footprintPx / ART_BOX;
    const half = (strokeWidthAt(rim, unit) * unit * scale) / 2;
    expect(2 * half).toBeCloseTo(2, 9);
    for (const [start, edge, end] of [
      [x, rim.x, rim.x + rim.w],
      [y, rim.y, rim.y + rim.h],
    ] as const) {
      expect((start + edge * unit) * scale - half).toBeCloseTo(1, 9);
      expect((start + end * unit) * scale + half).toBeCloseTo(28, 9);
    }
  });

  it('keeps a fitted rim on its surface, whole, at every dpr — wherever its footprint reaches past an edge', () => {
    const size = 36;
    const fit = towerArtFit(size);
    // The fitted footprint starts above and left of the surface; mirrored across the
    // surface's centre, it reaches as far past the right and bottom edges.
    expect(fit.x).toBeLessThan(0);
    expect(fit.y).toBeLessThan(0);
    const corners = {
      fitted: { x: fit.x, y: fit.y },
      mirrored: { x: size - fit.footprintPx - fit.x, y: size - fit.footprintPx - fit.y },
    };
    const unit = fit.footprintPx / ART_BOX;
    const design = PLATE_ART.find((s) => s.stroke === 'rim')!;
    if (design.kind !== 'rect') throw new Error('the rim is a rect');
    for (const [where, corner] of Object.entries(corners)) {
      for (const scale of [1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
        const g = recorder();
        paintTowerArt(
          g,
          PAL,
          { mark: 'ringed', role: 'control' },
          corner.x,
          corner.y,
          fit.footprintPx,
          scale,
          {
            width: size,
            height: size,
          },
        );
        const [plate] = artCalls(g.calls);
        const rim = plate!.shapes.find((s) => s.stroke === 'rim')!;
        if (rim.kind !== 'rect') throw new Error('the rim is a rect');
        const half = (strokeWidthAt(rim, unit) * unit * scale) / 2;
        const px = (origin: number, v: number): number => (origin + v * unit) * scale;
        const at = `${where}, dpr ${scale}`;
        expect(2 * half, at).toBeGreaterThanOrEqual(scale - 1e-9); // its floor, in full
        // On the surface, from its first pixel to its last whole one ...
        expect(px(corner.x, rim.x) - half, at).toBeGreaterThanOrEqual(-1e-9);
        expect(px(corner.y, rim.y) - half, at).toBeGreaterThanOrEqual(-1e-9);
        expect(px(corner.x, rim.x + rim.w) + half, at).toBeLessThanOrEqual(
          Math.floor(size * scale) + 1e-9,
        );
        expect(px(corner.y, rim.y + rim.h) + half, at).toBeLessThanOrEqual(
          Math.floor(size * scale) + 1e-9,
        );
        // ... and over the plate fill's edge, which stays where the design puts it.
        for (const [drawn, edge] of [
          [rim.x, design.x],
          [rim.y, design.y],
          [rim.x + rim.w, design.x + design.w],
          [rim.y + rim.h, design.y + design.h],
        ] as const) {
          expect(Math.abs(drawn - edge) * unit * scale, at).toBeLessThanOrEqual(half + 1e-9);
        }
      }
    }
  });

  it('keeps the rim inside the footprint and the surface both, for footprints inside, across and past a 36px surface, at dpr 0.8 to 2', () => {
    // QC round 4's kill test (U1-U3: the clamp's near sides, far sides, or axes dropped or
    // swapped): over a grid of corners that put the footprint wholly on the surface, across
    // its edges, and past them on either side, the stroke never leaves where both overlap.
    const W = 36;
    const bad: string[] = [];
    for (const s of [0.8, 1, 1.25, 2]) {
      for (const fp of [20, 26.5, 35.925]) {
        for (let x = -3; x <= 6; x += 0.29) {
          for (const dy of [-0.61, 0.61]) {
            const y = x + dy;
            const g = recorder();
            paintTowerArt(g, PAL, { mark: 'ringed', role: 'control' }, x, y, fp, s, {
              width: W,
              height: W,
            });
            const [plate] = artCalls(g.calls);
            const rim = plate!.shapes.find((sh) => sh.stroke === 'rim')!;
            if (rim.kind !== 'rect') throw new Error('the rim is a rect');
            const unit = fp / ART_BOX;
            const half = (strokeWidthAt(rim, unit) * unit * s) / 2;
            const px = (o: number, v: number): number => (o + v * unit) * s;
            const box = [
              Math.max(x, 0) * s,
              Math.max(y, 0) * s,
              Math.min(x + fp, W) * s,
              Math.min(y + fp, W) * s,
            ];
            const e = [
              px(x, rim.x) - half,
              px(y, rim.y) - half,
              px(x, rim.x + rim.w) + half,
              px(y, rim.y + rim.h) + half,
            ];
            if (
              e[0]! < box[0]! - 1e-9 ||
              e[1]! < box[1]! - 1e-9 ||
              e[2]! > box[2]! + 1e-9 ||
              e[3]! > box[3]! + 1e-9
            ) {
              bad.push(`s ${s} fp ${fp} x ${x.toFixed(2)} y ${y.toFixed(2)}`);
            }
          }
        }
      }
    }
    expect(bad, bad.slice(0, 3).join('; ')).toEqual([]);
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

/** A box in texels: [left, top, right, bottom]. */
type TexelBox = readonly [number, number, number, number];

/** The most any one texel along `run` is covered by a butt-capped stroke `width` texels
 *  wide, dashed by `dash` (texels), among texels no box in `over` touches: 1 when some
 *  texel lies wholly inside the stroke and inside a dash, and nothing drawn later reaches
 *  it. */
function runPeak(
  run: Run,
  width: number,
  dash: readonly number[],
  over: readonly TexelBox[],
): number {
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
      const [tx, ty] = horizontal ? [i, j] : [j, i];
      const touched = over.some(
        ([l, t, r, b]) => l < tx + 1 - 1e-9 && r > tx + 1e-9 && t < ty + 1 - 1e-9 && b > ty + 1e-9,
      );
      if (touched) continue;
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

/**
 * Each straight edge of every stroke `ops` drew in `strokeStyle`, as the most any one texel
 * along it ends up wholly in that colour: covered by the stroke — its recorded transform,
 * path, width and dash replayed as Canvas2D would — under the plain `source-over`
 * composite, and touched by nothing drawn after it. What a later draw touches is bounded by
 * its geometry's box, a stroke's grown by five line widths (the furthest a miter join
 * reaches at Canvas2D's default limit of 10); anti-aliasing paints no texel the geometry
 * does not reach.
 */
function strokeEdgePeaks(ops: readonly CtxOp[], strokeStyle: string): number[] {
  let m: Mat = [1, 0, 0, 1, 0, 0];
  let composite = 'source-over';
  const stack: { m: Mat; composite: string }[] = [];
  let runs: Run[] = [];
  let cur: [number, number] | null = null;
  let start: [number, number] | null = null;
  let s = 0; // path length so far, texels (a uniform scale: one factor for both axes)
  let style = '';
  let lineWidth = 1;
  let dash: number[] = [];
  /** The current path's box, texels. */
  let box: [number, number, number, number] | null = null;
  const include = (b: [number, number, number, number] | null, p: [number, number]) =>
    b === null
      ? ([p[0], p[1], p[0], p[1]] as [number, number, number, number])
      : ([
          Math.min(b[0], p[0]),
          Math.min(b[1], p[1]),
          Math.max(b[2], p[0]),
          Math.max(b[3], p[1]),
        ] as [number, number, number, number]);
  /** Every rim edge stroked, and how many later draws there were when it was. */
  const rims: { run: Run; width: number; dash: number[]; shown: boolean; after: number }[] = [];
  const later: TexelBox[] = [];
  const lineTo = (p: [number, number]): void => {
    const len = Math.hypot(p[0] - cur![0], p[1] - cur![1]);
    if (len > 1e-6) runs.push({ from: cur!, to: p, s0: s });
    s += len;
    cur = p;
  };
  for (const { op, args } of ops) {
    const n = args as number[];
    if (op === 'save') stack.push({ m, composite });
    else if (op === 'restore') ({ m, composite } = stack.pop()!);
    else if (op === 'setTransform') m = n as unknown as Mat;
    else if (op === 'transform') m = compose(m, n as unknown as Mat);
    else if (op === 'set:strokeStyle') style = String(args[0]);
    else if (op === 'set:lineWidth') lineWidth = n[0]!;
    else if (op === 'set:globalCompositeOperation') composite = String(args[0]);
    else if (op === 'setLineDash') dash = [...(args[0] as number[])];
    else if (op === 'beginPath') {
      runs = [];
      cur = start = null;
      box = null;
    } else if (op === 'moveTo') {
      cur = start = apply(m, [n[0]!, n[1]!]);
      s = 0; // the dash pattern restarts with every subpath
      box = include(box, cur);
    } else if (op === 'lineTo') {
      const p = apply(m, [n[0]!, n[1]!]);
      lineTo(p);
      box = include(box, p);
    } else if (op === 'arc') {
      const [cx, cy, r, a0, a1] = n as [number, number, number, number, number];
      if (cur !== null) lineTo(apply(m, [cx + r * Math.cos(a0), cy + r * Math.sin(a0)]));
      s += r * Math.abs(a1 - a0) * m[0];
      cur = apply(m, [cx + r * Math.cos(a1), cy + r * Math.sin(a1)]);
      box = include(include(box, apply(m, [cx - r, cy - r])), apply(m, [cx + r, cy + r]));
    } else if (op === 'ellipse') {
      const [cx, cy, rx, ry] = n as [number, number, number, number];
      box = include(include(box, apply(m, [cx - rx, cy - ry])), apply(m, [cx + rx, cy + ry]));
    } else if (op === 'rect') {
      const [x, y, w, h] = n as [number, number, number, number];
      box = include(include(box, apply(m, [x, y])), apply(m, [x + w, y + h]));
    } else if (op === 'closePath') {
      if (cur !== null && start !== null) lineTo(start);
    } else if (op === 'stroke' && args.length === 0 && style === strokeStyle) {
      expect([m[1], m[2]], 'no rotation or skew').toEqual([0, 0]);
      expect(m[0]).toBeCloseTo(m[3], 12);
      for (const run of runs) {
        rims.push({
          run,
          width: lineWidth * m[0],
          dash: dash.map((d) => d * m[0]),
          shown: composite === 'source-over',
          after: later.length,
        });
      }
    } else if (op === 'fill' || op === 'stroke' || op === 'fillRect') {
      let drawn: [number, number, number, number] | null = box;
      if (op === 'fillRect') {
        const [x, y, w, h] = n as [number, number, number, number];
        drawn = include(include(null, apply(m, [x, y])), apply(m, [x + w, y + h]));
      } else if (args[0] !== undefined) {
        drawn = null; // a Path2D: its own path, not the current one
        for (const line of flattenPath((args[0] as { d: string }).d)) {
          for (const p of line.points) drawn = include(drawn, apply(m, p));
        }
      }
      if (drawn !== null) {
        const g = op === 'stroke' ? 5 * lineWidth * m[0] : 0;
        later.push([drawn[0] - g, drawn[1] - g, drawn[2] + g, drawn[3] + g]);
      }
    }
  }
  return rims.map((r) => (r.shown ? runPeak(r.run, r.width, r.dash, later.slice(r.after)) : 0));
}

describe('the rim ends in its full colour — a whole texel on every straight edge, nothing drawn over it (QC rounds 2–3)', () => {
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
          // Each frame is sized to the art it paints — the rim as moved onto the texel grid.
          expectSizedToArt(specs.get(key)!, scale);
          const peaks = strokeEdgePeaks(painted(specs.get(key)!, scale), RIM);
          // Four straight edges, and each has a texel the rim colour fills, which nothing
          // drawn afterwards — the plate's bevel included — reaches.
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

  it('can fail: a whole texel of the rim that something is drawn over afterwards is not in its colour', () => {
    // A 1px rim on a half texel covers row 2 whole ...
    const rim: CtxOp[] = [
      { op: 'set:strokeStyle', args: [RIM] },
      { op: 'set:lineWidth', args: [1] },
      { op: 'beginPath', args: [] },
      { op: 'moveTo', args: [0, 2.5] },
      { op: 'lineTo', args: [10, 2.5] },
      { op: 'stroke', args: [] },
    ];
    const then = (...after: CtxOp[]): number => strokeEdgePeaks([...rim, ...after], RIM)[0]!;
    expect(then()).toBe(1);
    // ... until a later fill or stroke reaches it, as the plate's bevel once did, stroked
    // after the rim along its top edge — a path string here, as the bevel is.
    expect(then({ op: 'fillRect', args: [0, 2.4, 10, 0.2] })).toBe(0);
    expect(then({ op: 'stroke', args: [fakePath('M0 4.5H10')] })).toBe(0);
    // A later draw that reaches no rim texel leaves it be (a fill's box is its own; a
    // stroke's is grown by five line widths) ...
    expect(then({ op: 'fillRect', args: [0, 3, 10, 2] })).toBe(1);
    expect(then({ op: 'stroke', args: [fakePath('M0 9H10')] })).toBe(1);
    // ... and draws before it lie under it.
    expect(strokeEdgePeaks([{ op: 'fillRect', args: [0, 0, 10, 10] }, ...rim], RIM)[0]).toBe(1);
    // A rim stroked under another composite than source-over does not show its own colour.
    expect(
      strokeEdgePeaks(
        [{ op: 'set:globalCompositeOperation', args: ['destination-in'] }, ...rim],
        RIM,
      )[0],
    ).toBe(0);
  });
});

describe('the boost glow stays inside the rim as the frames draw them (QC round 2)', () => {
  it('the plate and boosted head frames draw the plate art on the texel grid and the glow as fitted, from one corner', () => {
    // What the sweep below measures, pinned against the frames themselves at every size the
    // frame tests use: the plate frame draws `alignArtToTexels(PLATE_ART)` with design-unit
    // (0, 0) — the footprint corner — on a whole texel, and the boosted head draws the glow
    // as `boostArtAt` fits it inside that rim (the design's own at every size here), from
    // that same corner at the same scale.
    for (const [cellPx, scale] of SIZES) {
      const specs = new Map(towerFrameSpecs(cellPx, scale).map((f) => [f.key, f]));
      const [plate] = artCalls(paint(specs.get(PLATE_FRAME_KEY)!));
      const [head] = artCalls(paint(specs.get(headFrameKey('basic', true))!));
      const at = `${cellPx}px at dpr ${scale}`;
      expect(plate!.shapes, at).toEqual(
        alignArtToTexels(PLATE_ART, artUnit(cellPx), scale, [0, 0], ART_FOOTPRINT),
      );
      const glow = boostArtAt(artUnit(cellPx), scale);
      expect(head!.shapes.slice(0, glow.length), at).toEqual(glow);
      expect([head!.x, head!.y, head!.unit], at).toEqual([plate!.x, plate!.y, plate!.unit]);
      expect(plate!.x * scale, at).toBeCloseTo(Math.round(plate!.x * scale), 9);
      expect(plate!.y * scale, at).toBeCloseTo(Math.round(plate!.y * scale), 9);
    }
  });

  it('draws the glow boostArtAt fits where it is fitted — 9px cells at dpr 1.25 (the halo left out) and 0.8 (the halo shrunk)', () => {
    for (const scale of [1.25, 0.8]) {
      const glow = boostArtAt(artUnit(9), scale);
      expect(glow, `fitted at ${scale}`).not.toBe(BOOST_ART);
      const spec = towerFrameSpecs(9, scale).find((f) => f.key === headFrameKey('basic', true))!;
      const g = recorder();
      spec.paint(g, resolvePalette('default'));
      const drawn = g.calls
        .filter((c) => c.method === 'art')
        .flatMap((c) => c.args[0] as readonly ArtShape[])
        .filter((s) => s.stroke === 'aura');
      expect(drawn, `at ${scale}`).toEqual(glow);
    }
  });

  it(
    'reaches the walk’s worst cases, pinned from both sides — the sweep’s own bounds are one-sided, so a walk that misses the jumps where they lie would pass them',
    { timeout: 60_000 },
    () => {
      const designRim = PLATE_ART.find((s) => s.stroke === 'rim')!;
      const [designCue] = BOOST_ART;
      if (designRim.kind !== 'rect' || designCue?.kind !== 'circle') throw new Error('shapes');
      const worst = { plateFromOne: 0, plateBelowOne: 0, floorBelowOne: 0, cue: 1 };
      for (let cellPx = 9; cellPx <= 64; cellPx++) {
        const unit = artUnit(cellPx);
        for (const scale of rimScales(cellPx)) {
          const rim = drawnRim(cellPx, scale);
          const half = strokeWidthAt(rim, unit) / 2;
          const k = unit * scale;
          for (const out of [
            rim.x - designRim.x,
            rim.y - designRim.y,
            designRim.x + designRim.w - (rim.x + rim.w),
            designRim.y + designRim.h - (rim.y + rim.h),
          ]) {
            if (scale >= 1) worst.plateFromOne = Math.max(worst.plateFromOne, (out - half) * k);
            else {
              worst.plateBelowOne = Math.max(worst.plateBelowOne, (out - half) * k);
              worst.floorBelowOne = Math.max(worst.floorBelowOne, (-out - half) * k);
            }
          }
          const [cue] = boostArtAt(unit, scale);
          if (cue?.kind === 'circle') worst.cue = Math.min(worst.cue, cue.r / designCue.r);
        }
      }
      expect(worst.plateFromOne, '9px, just under dpr 19/18').toBeCloseTo(7 / 64, 6);
      expect(worst.plateBelowOne, '9px, just under dpr 5/6').toBeCloseTo(19 / 64, 6);
      expect(worst.floorBelowOne, '15px, near dpr 0.8009').toBeCloseTo(0.0995551, 6);
      expect(worst.cue, '9px, just under dpr 19/18').toBeCloseTo(0.9144072, 6);
    },
  );

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

  it(
    'at every cell size from 9 to 64px and every dpr from 0.8 to 3, each change of the rim’s texels walked: the rim no thinner than its floor and inside the footprint, each glow ring inside it, and the plate fill’s edge under it but by a fraction of a pixel at the smallest cells',
    { timeout: 60_000 },
    () => {
      // The glow is `pal.aura`, gated against the PLATE (palette.test.ts) and not against the
      // rim, so it must stay inside the rim. Drawing the rim on whole device pixels moves it —
      // up to half a pixel, and further inward where the footprint's edge stops it — a
      // different way at each cell size and dpr, so this measures the rim as the plate frame
      // draws it (pinned above), not the design's: at every 0.005 of dpr, and on both sides of
      // each scale where its texels change (`rimScales`), where each measure here is at its
      // worst — sampled scales hide what the ones between them do (QC round 4).
      const designRim = PLATE_ART.find((s) => s.stroke === 'rim')!;
      if (designRim.kind !== 'rect') throw new Error('the rim is a rect');
      const [designCue] = BOOST_ART;
      if (designCue?.kind !== 'circle') throw new Error('the glow is rings');
      // The two sides of a change are a hair apart, and one can fall inside the alignment's own
      // allowance for floating-point noise (a billionth of a texel), where an edge sits that
      // hair past where it is bound: so the checks here allow a millionth of a pixel, which no
      // pixel can show.
      const HAIR = 1e-6;
      const bad: string[] = [];
      /** Where the fill's edge lies off the drawn rim — the plate showing past its outer side,
       *  or the floor inside its inner side — below dpr 1 and from 1 up: the most, px, and the
       *  cells where it does at all. */
      const most = (): { by: number; at: string; cells: Set<number> } => ({
        by: 0,
        at: '',
        cells: new Set(),
      });
      const off = {
        plate: { belowOne: most(), fromOne: most() },
        floor: { belowOne: most(), fromOne: most() },
      };
      const glowAt = {
        fitted: new Set<number>(),
        cueShrunk: new Set<number>(),
        haloOut: new Set<number>(),
      };
      let leastCue = { ratio: 1, at: '' };
      for (let cellPx = 9; cellPx <= 64; cellPx++) {
        const unit = artUnit(cellPx);
        for (const scale of rimScales(cellPx)) {
          const rim = drawnRim(cellPx, scale);
          const half = strokeWidthAt(rim, unit) / 2;
          const k = unit * scale;
          const at = `${cellPx}px at dpr ${scale}`;
          // Never thinner than its one-CSS-px floor (so two texels at dpr 1.25 or 1.5) ...
          if (2 * half * k < scale - HAIR) bad.push(`${at}: thinner than its floor`);
          // ... inside the footprint, so two abutting plates never overlap ...
          if ((rim.x - half) * k < -HAIR || (rim.x + rim.w + half) * k > ART_BOX * k + HAIR) {
            bad.push(`${at}: outside the footprint`);
          }
          // ... each ring of the glow, as the boosted head's frame draws it, inside it: meeting
          // its inner edge at most, a texel's, never crossing it ...
          const glow = boostArtAt(unit, scale);
          if (glow !== BOOST_ART) glowAt.fitted.add(cellPx);
          if (glow.length < BOOST_ART.length) glowAt.haloOut.add(cellPx);
          for (const ring of glow) {
            if (ring.kind !== 'circle') throw new Error('the glow is rings');
            const outer = ring.r + strokeWidthAt(ring, unit) / 2;
            const margin =
              Math.min(
                ring.cx - outer - (rim.x + half),
                rim.x + rim.w - half - (ring.cx + outer),
                ring.cy - outer - (rim.y + half),
                rim.y + rim.h - half - (ring.cy + outer),
              ) * k;
            if (margin < -HAIR) bad.push(`${at}: a glow ring ${-margin}px into the rim`);
          }
          const [cue] = glow;
          if (cue?.kind === 'circle' && cue.r < designCue.r) {
            glowAt.cueShrunk.add(cellPx);
            if (cue.r / designCue.r < leastCue.ratio) leastCue = { ratio: cue.r / designCue.r, at };
          }
          // ... and the plate fill's edge, which stays on the design's centre line, side by
          // side: how far it lies outward of the drawn rim's centre line (near sides, then far).
          const band = scale >= 1 ? 'fromOne' : 'belowOne';
          for (const out of [
            rim.x - designRim.x,
            rim.y - designRim.y,
            designRim.x + designRim.w - (rim.x + rim.w),
            designRim.y + designRim.h - (rim.y + rim.h),
          ]) {
            for (const [what, by] of [
              ['plate', (out - half) * k],
              ['floor', (-out - half) * k],
            ] as const) {
              if (by <= HAIR) continue;
              const m = off[what][band];
              m.cells.add(cellPx);
              if (by > m.by) Object.assign(m, { by, at });
            }
          }
        }
      }
      expect(bad.slice(0, 5), `${bad.length} failures`).toEqual([]);
      // Where the footprint ends inside a pixel, the rim's far side stops on the whole pixel
      // before it, short of its place, and the fill's edge lies past it: a blend of plate into
      // the footprint's last pixel. From dpr 1 up only at 9 and 10 px cells, 0.11 px at most
      // (9 px, just under dpr 19/18), and the floor never shows inside the rim; below dpr 1,
      // at 9 to 13 px, 0.30 px at most (9 px, just under 5/6), and the floor shows inside the
      // rim at 11 to 19 px, 0.10 px at most.
      expect([...off.plate.fromOne.cells], off.plate.fromOne.at).toEqual([9, 10]);
      expect(off.plate.fromOne.by, off.plate.fromOne.at).toBeLessThanOrEqual(0.11);
      expect([...off.floor.fromOne.cells], off.floor.fromOne.at).toEqual([]);
      expect([...off.plate.belowOne.cells]).toEqual([9, 10, 11, 12, 13]);
      expect(off.plate.belowOne.by, off.plate.belowOne.at).toBeLessThanOrEqual(0.3);
      expect([...off.floor.belowOne.cells]).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19]);
      expect(off.floor.belowOne.by, off.floor.belowOne.at).toBeLessThanOrEqual(0.1);
      // The glow is fitted at 9 to 15 px only (`boostArtAt`): the cue shrinks at 9 and 10 px,
      // to 0.91 of its radius at the least, and the halo is left out at 9 to 12.
      expect([...glowAt.fitted]).toEqual([9, 10, 11, 12, 13, 14, 15]);
      expect([...glowAt.cueShrunk]).toEqual([9, 10]);
      expect([...glowAt.haloOut]).toEqual([9, 10, 11, 12]);
      expect(leastCue.ratio, leastCue.at).toBeGreaterThan(0.91);
    },
  );

  it('fits the glow inside the rim only where the drawn rim comes in past it — 9px cells just under dpr 19/18, at its worst', () => {
    // There the footprint ends a hair short of 19 texels, so the rim's far side, two texels
    // wide, stops at 18: its inner edge 1.25px inside where the design's halo reaches, and
    // 0.56px inside the cue's. (From 19/18 itself the footprint ends on texel 19, and the
    // rim's far side moves out with it.)
    const unit = artUnit(9);
    const [cue, halo] = BOOST_ART;
    if (cue?.kind !== 'circle' || halo?.kind !== 'circle') throw new Error('the glow is rings');
    const scale = 19 / 18 - 1e-9;
    expect(ART_BOX * unit * scale).toBeLessThan(19);
    const glow = boostArtAt(unit, scale);
    // The halo cannot stay clear of the cue inside it, so it is left out; the cue shrinks
    // about the head's centre — to 0.914 of its radius, the least any frame needs.
    expect(glow).toHaveLength(1);
    const [fit] = glow;
    if (fit?.kind !== 'circle') throw new Error('the glow is rings');
    expect([fit.cx, fit.cy, fit.width, fit.minWidthPx, fit.alpha]).toEqual([
      cue.cx,
      cue.cy,
      cue.width,
      cue.minWidthPx,
      cue.alpha,
    ]);
    expect(fit.r / cue.r).toBeCloseTo(0.9144, 4);
    // From 16px up it is the design's own glow, at every dpr.
    for (const cellPx of [16, 20, 32, 64]) {
      for (const at of rimScales(cellPx)) {
        expect(boostArtAt(artUnit(cellPx), at), `${cellPx}px at dpr ${at}`).toBe(BOOST_ART);
      }
    }
  });
});
