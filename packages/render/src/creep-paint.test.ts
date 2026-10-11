// creep-paint.test.ts — a creep's look (its shape, family and domain, M2-S3 onward and the
// visual pass's C3/C4, #181), its HP bar, and the telegraph paint plans, asserted at the REAL
// supported floor (568×320 → CELL_PX_MIN_NARROW = 10px cells, Codex R1-12) rather than the
// 12px the risk-of-record originally assumed. The art a look is drawn with — silhouettes,
// wings, shadows, size steps — is `creep-art.test.ts`'s.

import { describe, it, expect } from 'vitest';
import { getBundledRuleset, bundledRulesetIds } from '@wynding/content';
import {
  creepShapeFor,
  creepFamilyFor,
  creepLookFor,
  creepLookKey,
  CREEP_FAMILIES,
  CREEP_LOOKS,
  CREEP_SHAPE_VALUES,
  CREEP_LOW_HP_FRAC,
  isLowHp,
  hpBarPaintOp,
  HP_BAR_BACKING_PX,
  isCreepFamily,
  slowTelegraphPaintOps,
  dotTelegraphPaintOps,
  stunTelegraphPaintOps,
  wardPaintOps,
} from './creep-paint';
import { CUE_INK_PX } from './board-draw';
import { creepRadius } from './creep-art';
import { resolvePalette } from './palette';
import { ART_INK } from './tower-art';

// The narrow floor's cell size (apps/web/e2e/compact.spec.ts's CELL_PX_MIN_NARROW) — the
// base radius the scene actually draws at that floor (`max(3, cellPx * 0.35)`), the normal
// family's.
const CELL_PX_MIN_NARROW = 10;
const R = Math.max(3, CELL_PX_MIN_NARROW * 0.35);
/** Every family's radius at the narrow floor — the swarm's the smallest, under `R`. */
const FAMILY_R_AT_FLOOR = CREEP_FAMILIES.map(
  (f) => [f, creepRadius(CELL_PX_MIN_NARROW, f)] as const,
);

describe('creepShapeFor — id-keyed silhouette (total over any string)', () => {
  it('keeps the triangle for normal', () => {
    expect(creepShapeFor('normal')).toBe('triangle');
  });
  it('gives fast a visibly distinct diamond', () => {
    expect(creepShapeFor('fast')).toBe('diamond');
  });
  it('gives swarm a visibly distinct square (M2-S4a)', () => {
    expect(creepShapeFor('swarm')).toBe('square');
  });
  it('gives armored a visibly distinct hexagon (M2-S5a)', () => {
    expect(creepShapeFor('armored')).toBe('hexagon');
  });
  it('gives resolute a visibly distinct pentagon (M2-S6)', () => {
    expect(creepShapeFor('resolute')).toBe('pentagon');
  });
  it('falls back to the default triangle for an unknown id — never throws', () => {
    expect(creepShapeFor('__proto__')).toBe('triangle');
    expect(creepShapeFor('')).toBe('triangle');
  });
});

describe('creepFamilyFor — the hue and size step a creep wears (C3, #181)', () => {
  it('gives each catalog creep the style frame’s family; ids the frame gives one hue share one', () => {
    expect(creepFamilyFor('swarm', false)).toBe('swarm');
    expect(creepFamilyFor('normal', false)).toBe('normal');
    expect(creepFamilyFor('fast', false)).toBe('fast');
    expect(creepFamilyFor('resolute', false)).toBe('normal');
    expect(creepFamilyFor('armored', false)).toBe('armored');
    expect(creepFamilyFor('flying', false)).toBe('flying');
    expect(creepFamilyFor('armored-flyer', false)).toBe('armored');
    expect(creepFamilyFor('boss', true)).toBe('boss');
  });

  it('the boss ROLE puts any creep in the boss family — the size step was always keyed on the role, not the id', () => {
    for (const id of ['normal', 'armored', 'flying', 'not-a-catalog-creep']) {
      expect(creepFamilyFor(id, true), id).toBe('boss');
    }
    // …and the boss id without the role is an ordinary creep of no family of its own.
    expect(creepFamilyFor('boss', false)).toBe('normal');
  });

  it('falls back to the normal family for an unknown id — never throws, never escapes via the prototype', () => {
    expect(creepFamilyFor('', false)).toBe('normal');
    expect(creepFamilyFor('__proto__', false)).toBe('normal');
    expect(creepFamilyFor('constructor', false)).toBe('normal');
  });

  it('isCreepFamily knows every family, and nothing else — no near miss, no name on the prototype, no non-string', () => {
    for (const family of CREEP_FAMILIES) expect(isCreepFamily(family), family).toBe(true);
    for (const value of ['', 'Normal', 'boss ', 'flyer', 'resolute', '__proto__', 'constructor']) {
      expect(isCreepFamily(value), value).toBe(false);
    }
    for (const value of [undefined, null, 0, {}, ['normal']]) {
      expect(isCreepFamily(value), String(value)).toBe(false);
    }
  });
});

describe('creepLookFor — shape, family and domain, three independent axes', () => {
  it("composes: armored-flyer keeps the armored hexagon AND the armored hue, and flies (S10's requirement)", () => {
    expect(creepLookFor('armored-flyer', false, true)).toEqual({
      shape: 'hexagon',
      family: 'armored',
      airborne: true,
    });
    // The shape is keyed ONLY on the id — domain never changes it…
    expect(creepLookFor('armored', false, true).shape).toBe(
      creepLookFor('armored', false, false).shape,
    );
    // …and domain is the VM's own field, never inferred from the id: an id the catalog has
    // never heard of may fly, and a `flying` id the VM says is on the ground walks.
    expect(creepLookFor('not-a-catalog-creep', false, true).airborne).toBe(true);
    expect(creepLookFor('flying', false, false).airborne).toBe(false);
  });

  it('a boss and an armored creep share the hexagon, and differ in family — size step and hue', () => {
    const boss = creepLookFor('boss', true, false);
    const armored = creepLookFor('armored', false, false);
    expect(boss.shape).toBe(armored.shape);
    expect(boss.family).not.toBe(armored.family);
  });

  it('keys every look by all three axes', () => {
    expect(creepLookKey(creepLookFor('fast', false, false))).toBe('diamond:fast:ground');
    expect(creepLookKey(creepLookFor('armored-flyer', false, true))).toBe('hexagon:armored:air');
    expect(creepLookKey(creepLookFor('boss', true, false))).toBe('hexagon:boss:ground');
  });
});

describe('CREEP_LOOKS — every look the board can be asked for, baked by construction', () => {
  const keys = CREEP_LOOKS.map(creepLookKey);

  it('lists each look once', () => {
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('holds the look of every creep in every shipped ruleset, any id, in either domain, with or without the boss role', () => {
    const ids = new Set<string>(['', '__proto__', 'not-a-catalog-creep']);
    for (const rulesetId of bundledRulesetIds()) {
      for (const c of getBundledRuleset(rulesetId).creepCatalog) ids.add(c.id);
    }
    expect(ids.has('armored-flyer')).toBe(true); // the premise: the real catalog is in there
    for (const id of ids) {
      for (const boss of [false, true]) {
        for (const airborne of [false, true]) {
          expect(keys, `${id} boss=${boss} air=${airborne}`).toContain(
            creepLookKey(creepLookFor(id, boss, airborne)),
          );
        }
      }
    }
  });

  it('draws every shape and every family', () => {
    expect(new Set(CREEP_LOOKS.map((l) => l.shape))).toEqual(new Set(CREEP_SHAPE_VALUES));
    expect(new Set(CREEP_LOOKS.map((l) => l.family))).toEqual(new Set(CREEP_FAMILIES));
  });
});

describe('hpBarPaintOp — the HP bar: LENGTH and colour, two channels for one fact (C3)', () => {
  const HUE = 0x123456;
  const LOW = 0xabcdef;
  const centre = { x: 40, y: 30 };

  it('draws an opaque backing the bar’s full length, a pixel larger on every side, under a fill as long as the HP left', () => {
    const r = 7;
    const bar = hpBarPaintOp(centre, r, 0.5, HUE, LOW, ART_INK);
    const w = r * 2.1;
    const h = Math.max(3, r * 0.32);
    expect(bar.fill).toEqual({ x: 40 - w / 2, y: 30 - r * 1.75, w: w / 2, h, colour: HUE });
    expect(bar.backing).toEqual({
      x: 40 - w / 2 - HP_BAR_BACKING_PX,
      y: 30 - r * 1.75 - HP_BAR_BACKING_PX,
      w: w + 2 * HP_BAR_BACKING_PX,
      h: h + 2 * HP_BAR_BACKING_PX,
      colour: ART_INK,
    });
    // Centred on the body, above it.
    expect(bar.backing.x + bar.backing.w / 2).toBeCloseTo(centre.x, 10);
    expect(bar.backing.y + bar.backing.h).toBeLessThan(centre.y);
  });

  it('its LENGTH carries HP: the fill is the HP fraction of the bar, from full down to nothing', () => {
    const full = hpBarPaintOp(centre, 7, 1, HUE, LOW, ART_INK);
    for (const hp of [1, 0.75, 0.5, 0.34, 0.2, 0]) {
      const bar = hpBarPaintOp(centre, 7, hp, HUE, LOW, ART_INK);
      expect(bar.fill.w).toBeCloseTo(full.fill.w * hp, 10);
      expect(bar.fill.x).toBe(full.fill.x); // it shrinks toward its left end
      expect(bar.backing).toEqual(full.backing); // the backing shows what is lost
    }
  });

  // Retargeted from the body (C3): until C3 the silhouette's FRAME turned low-HP at this
  // threshold — `art-frames.test.ts` pinned `creepFrameKey` at 0.34, 0.3399 and 0. A body now
  // keeps its family's hue at any HP; the bar carries the turn, pinned at the same three
  // points and through the same one threshold test.
  it('its colour turns from the family hue to the low-HP colour below `isLowHp`’s threshold — and only there', () => {
    expect(CREEP_LOW_HP_FRAC).toBe(0.34);
    const colourAt = (hp: number): number =>
      hpBarPaintOp(centre, 7, hp, HUE, LOW, ART_INK).fill.colour;
    expect(colourAt(1)).toBe(HUE);
    expect(colourAt(0.34)).toBe(HUE); // exactly at the threshold: not low
    expect(isLowHp(0.34)).toBe(false);
    expect(colourAt(0.3399)).toBe(LOW);
    expect(isLowHp(0.3399)).toBe(true);
    expect(colourAt(0)).toBe(LOW);
  });

  it('keeps its height at the 3px floor where a proportional bar would be under three pixels', () => {
    for (const [family, r] of FAMILY_R_AT_FLOOR) {
      const bar = hpBarPaintOp(centre, r, 1, HUE, LOW, ART_INK);
      expect(bar.fill.h, family).toBe(Math.max(3, r * 0.32));
      expect(bar.fill.h, family).toBeGreaterThanOrEqual(3);
    }
    expect(hpBarPaintOp(centre, 20, 1, HUE, LOW, ART_INK).fill.h).toBeCloseTo(6.4, 10);
  });
});

describe('slowTelegraphPaintOps', () => {
  it('is empty when the creep is not slowed', () => {
    expect(slowTelegraphPaintOps({ x: 0, y: 0, slowed: false }, R, false, 0x56b4e9, 0)).toEqual([]);
  });

  it('draws an OPAQUE ring (the GUARANTEED shape cue) plus a pulse when motion is not reduced', () => {
    const ops = slowTelegraphPaintOps({ x: 5, y: 6, slowed: true }, R, false, 0x56b4e9, 0);
    expect(ops.map((o) => o.kind)).toEqual(['ring', 'pulse']);
    for (const op of ops) {
      expect(op.colour).toBe(0x56b4e9);
      expect(op.x).toBe(5);
      expect(op.y).toBe(6);
    }
    // The essential cue is fully opaque — the palette contrast gate treats `slowed` as an
    // opaque cue, and this is what keeps that treatment honest (QC round 1).
    expect(ops[0]!.alpha).toBe(1);
  });

  it('the pulse genuinely MOVES: its radius differs across render times and never dips inside the ring', () => {
    const at = (t: number) =>
      slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, false, 0x56b4e9, t)[1]!;
    const r0 = at(0).r; // wave trough
    const rMid = at(450).r; // wave crest (half the 900ms period)
    const rWrap = at(900).r; // full period — back to the trough
    expect(rMid).toBeGreaterThan(r0); // it moves
    expect(rWrap).toBeCloseTo(r0, 10); // and it is periodic, not drifting
    const [ring] = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, false, 0x56b4e9, 450);
    expect(rMid).toBeGreaterThanOrEqual(ring!.r); // the aura breathes OUTWARD from the ring
  });

  it('a non-finite render time is total: the telegraph still renders, un-animated', () => {
    const ops = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, false, 0x56b4e9, NaN);
    expect(ops.map((o) => o.kind)).toEqual(['ring', 'pulse']);
    expect(ops[1]!.r).toBe(
      slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, false, 0x56b4e9, 0)[1]!.r,
    );
  });

  it('keeps the ring but drops the pulse under reduced motion (WCAG 2.3.3 / GAG §2), and the ring is time-invariant', () => {
    const opsA = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, true, 0x56b4e9, 0);
    const opsB = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, true, 0x56b4e9, 450);
    expect(opsA.map((o) => o.kind)).toEqual(['ring']);
    expect(opsB).toEqual(opsA); // the remaining cue does not move
  });

  it('at the narrow 10px-cell floor, the ring radius is legibly distinct from the silhouette radius (≥ 1px)', () => {
    const [ring] = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, true, 0x56b4e9, 0);
    expect(ring).toBeDefined();
    expect(ring!.r - R).toBeGreaterThanOrEqual(1);
    // …for every family's size step (C3) — the swarm's, under the base radius, the tightest.
    for (const [family, r] of FAMILY_R_AT_FLOOR) {
      const [own] = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, r, true, 0x56b4e9, 0);
      expect(own!.r - r, family).toBeGreaterThanOrEqual(1);
    }
  });
});

// Driven from the REAL palette (not a hand-copied literal, QC round — a hand-copied
// constant is asserted right back out and never notices a palette change; `palette.ts`
// changed `poisoned` since this file was first written and nothing here caught it).
const POISONED = resolvePalette('default').poisoned;

// Distance from the creep centre to a pip's drawn point, for asserting the essential
// cue's ring radius (`Math.hypot`, since the ops are already resolved to x/y points).
function pipDistance(
  op: { readonly x: number; readonly y: number },
  cx: number,
  cy: number,
): number {
  return Math.hypot(op.x - cx, op.y - cy);
}

describe('dotTelegraphPaintOps (M2-S5a) — the DoT ("poisoned") telegraph, mirroring slowTelegraphPaintOps', () => {
  it('is empty when the creep is not poisoned', () => {
    expect(dotTelegraphPaintOps({ x: 0, y: 0, poisoned: false }, R, false, POISONED, 0)).toEqual(
      [],
    );
  });

  it('draws three OPAQUE pips (the GUARANTEED shape cue) plus three drift ops when motion is not reduced', () => {
    const ops = dotTelegraphPaintOps({ x: 5, y: 6, poisoned: true }, R, false, POISONED, 0);
    expect(ops.map((o) => o.kind)).toEqual(['pip', 'pip', 'pip', 'drift', 'drift', 'drift']);
    for (const op of ops) expect(op.colour).toBe(POISONED);
    // The essential cue is fully opaque — mirrors the slowed ring's alpha-1 posture,
    // which is what keeps the palette contrast gate's opaque treatment of `poisoned`
    // honest.
    for (const pip of ops.slice(0, 3)) expect(pip.alpha).toBe(1);
  });

  it('places the three guaranteed pips at r×1.8 from the creep centre — OUTSIDE the slowed ring at r×1.4, so both statuses stay legible together', () => {
    const [p1, p2, p3] = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 0);
    for (const p of [p1, p2, p3]) {
      expect(pipDistance(p!, 0, 0)).toBeCloseTo(R * 1.8, 6);
    }
    const [slowRing] = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, true, 0x56b4e9, 0);
    // The REAL returned pip distance vs the REAL returned ring radius — not a literal
    // the test itself computed on both sides (QC round: `R * 1.8 > slowRing.r` degenerates
    // to "is 6.3 > 4.9", true independent of what either function actually returns).
    expect(pipDistance(p1!, 0, 0)).toBeGreaterThan(slowRing!.r);
  });

  it('the drift cue genuinely MOVES outward and fades: distance grows and alpha shrinks across render times', () => {
    const at = (t: number) =>
      dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, false, POISONED, t)[3]!;
    const d0 = at(0);
    const dMid = at(450);
    expect(pipDistance(dMid, 0, 0)).toBeGreaterThan(pipDistance(d0, 0, 0)); // it drifts outward
    expect(dMid.alpha).toBeLessThan(d0.alpha); // and it fades
  });

  it('a non-finite render time is total: the telegraph still renders, un-animated', () => {
    const ops = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, false, POISONED, NaN);
    expect(ops.map((o) => o.kind)).toEqual(['pip', 'pip', 'pip', 'drift', 'drift', 'drift']);
    expect(ops[3]).toEqual(
      dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, false, POISONED, 0)[3],
    );
  });

  it('keeps the three pips but drops the drift cue under reduced motion (WCAG 2.3.3 / GAG §2), and the pips are time-invariant', () => {
    const opsA = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 0);
    const opsB = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 450);
    expect(opsA.map((o) => o.kind)).toEqual(['pip', 'pip', 'pip']);
    expect(opsB).toEqual(opsA); // the remaining cue does not move
  });

  it('at the narrow 10px-cell floor, a poisoned+slowed creep draws BOTH telegraphs legibly distinct (pip ring outside the slow ring by ≥ 1px)', () => {
    const [slowRing] = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, true, 0x56b4e9, 0);
    const [pip] = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 0);
    expect(pipDistance(pip!, 0, 0) - slowRing!.r).toBeGreaterThanOrEqual(1);
    // …for every family's size step (C3).
    for (const [family, r] of FAMILY_R_AT_FLOOR) {
      const [ring] = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, r, true, 0x56b4e9, 0);
      const [own] = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, r, true, POISONED, 0);
      expect(pipDistance(own!, 0, 0) - ring!.r, family).toBeGreaterThanOrEqual(1);
    }
  });

  // QC round 3 — the three assertions below pin fixes that landed in earlier rounds with
  // NO regression guard: reviewers reverted each one and the whole 116-test render suite
  // stayed green. Every pre-existing positional assertion measures DISTANCE from the
  // centre, which is rotation-invariant and so cannot see an orientation regression at
  // all; the narrow-floor test measures ring SEPARATION, never a pip's own drawn radius.

  it('puts the lone pip at the BOTTOM (apex-down) and the pair up and out to either side — clear of the HP bar across the top', () => {
    const pips = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 0);
    // Canvas y grows DOWNWARD, so "below the centre" is y > 0. Apex-up — this test's own
    // pin until C3 (#181), for symmetry with the triangle silhouette — inverts this exactly
    // and is indistinguishable from it by distance alone; it put the lone pip on the HP
    // bar's middle (the next test measures what that costs).
    const below = pips.filter((p) => p.y > 0);
    expect(below).toHaveLength(1);
    expect(below[0]!.x).toBeCloseTo(0, 6); // horizontally centred: straight down, not off-axis
    expect(below[0]!.y).toBeCloseTo(R * 1.8, 6);
    const pair = pips.filter((p) => p.y < 0);
    expect(pair).toHaveLength(2);
    for (const p of pair) expect(p.y).toBeCloseTo(-R * 0.9, 6); // 30° above the horizontal
    expect(pair.map((p) => Math.sign(p.x)).sort()).toEqual([-1, 1]); // one either side
  });

  /** How much of a full HP bar's FILL — the part whose length carries HP — the guaranteed
   *  pips cover, ink discs included, as the board draws them (`drawCreepCues`: each pip on
   *  an ink disc `CUE_INK_PX` larger, over the bar): the share of the bar's length at which
   *  some pip covers part of the fill's height, and how far in from the nearer end it
   *  reaches. Sampled at 1/4000 of the bar. */
  const pipCover = (r: number): { share: number; reach: number } => {
    const fill = hpBarPaintOp({ x: 0, y: 0 }, r, 1, 0, 0, 0).fill;
    const discs = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, r, true, POISONED, 0).map(
      (p) => ({ x: p.x, y: p.y, r: p.r + CUE_INK_PX }),
    );
    const steps = 4000;
    let hit = 0;
    let reach = 0;
    for (let i = 0; i <= steps; i++) {
      const x = fill.x + (fill.w * i) / steps;
      const covered = discs.some((d) => {
        const dx = Math.abs(x - d.x);
        if (dx >= d.r) return false;
        const dy = Math.sqrt(d.r * d.r - dx * dx);
        return d.y - dy < fill.y + fill.h && d.y + dy > fill.y;
      });
      if (!covered) continue;
      hit++;
      reach = Math.max(reach, Math.min(i, steps - i) / steps);
    }
    return { share: hit / (steps + 1), reach };
  };

  it('no guaranteed pip covers the HP bar’s fill at ordinary cells; at the narrow floor they reach only its ends (C3)', () => {
    // MEASURED, never hand-computed. Apex-up, the lone pip sat on the bar's middle: at the
    // narrow floor it covered 87% of a swarm's bar, and from a 20px cell up it still hid the
    // fill's END for every HP from about a third to two thirds.
    const report: string[] = [];
    for (const cellPx of [10, 12, 14, 16, 20, 28, 40, 64]) {
      for (const family of CREEP_FAMILIES) {
        const { share, reach } = pipCover(creepRadius(cellPx, family));
        report.push(
          `${cellPx}px ${family} ${(share * 100).toFixed(1)}%/${(reach * 100).toFixed(1)}%`,
        );
        // Never the middle three fifths of the bar, at any supported cell…
        expect(reach, `${family} at ${cellPx}px`).toBeLessThan(0.2);
        // …and nothing at all once the cell is ordinary.
        if (cellPx >= 20) expect(share, `${family} at ${cellPx}px`).toBe(0);
        if (cellPx >= 14 && family !== 'swarm') expect(share, `${family} at ${cellPx}px`).toBe(0);
      }
    }
    console.log(
      `[C3] DoT pips over the HP bar's fill (share / reach in from an end): ${report.join(', ')}`,
    );
  });

  it('holds a pip at the DOT_PIP_MIN_PX floor at the narrow cell, where the proportional radius alone would be sub-pixel', () => {
    const [pip] = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 0);
    // R here IS the narrow floor's silhouette radius (3.5). Proportionally the pip would
    // be 3.5 × 0.18 = 0.63 → a 1.26px dot, the essential shape cue effectively invisible
    // exactly where legibility is tightest. The floor is what makes it 1.5.
    expect(R * 0.18).toBeLessThan(1.5); // the floor is genuinely load-bearing at this size
    expect(pip!.r).toBeCloseTo(1.5, 6);
  });

  it('pins the drift cue MAGNITUDE — a period stretched far past 900ms would leave it imperceptible', () => {
    const drift = (t: number) =>
      dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, false, POISONED, t)[3]!;
    // Half a period: the sawtooth is at phase 0.5, so the pip sits half-way across its
    // 0.6r outward span and is half-faded. Asserting only "moved a bit / faded a bit"
    // (the pre-existing test above) survives a 100× period, which is the exact hazard
    // scene.ts warns about for the slow pulse.
    expect(pipDistance(drift(450), 0, 0)).toBeCloseTo(R * (1.8 + 0.6 * 0.5), 6);
    expect(drift(450).alpha).toBeCloseTo(0.25, 6);
    // The drift's alpha CEILING is what the palette contrast gate relies on when it
    // treats the drift as the non-essential motion cue and `poisoned` as opaque.
    expect(drift(0).alpha).toBe(0.5);
  });

  it('pins the drift cue REACH — centre crest at r×2.4, and a DRAWN extent that the pip floor pushes past it (#126)', () => {
    // The cue-radius ordering block used to enumerate only the ring-shaped cues, so the
    // drift — the outermost TIMED cue in the renderer — was absent from both the argument
    // and this suite. Centre alone is not the reach that collides: these are FILLED discs,
    // so the extent is centre + drawn radius, and `DOT_PIP_MIN_PX` holds that radius at
    // 1.5px while everything around it stays proportional.
    const crest = dotTelegraphPaintOps(
      { x: 0, y: 0, poisoned: true },
      R,
      false,
      POISONED,
      899.9999,
    ).filter((o) => o.kind === 'drift');
    expect(crest).toHaveLength(3);
    for (const d of crest) {
      expect(pipDistance(d, 0, 0)).toBeCloseTo(R * 2.4, 3); // the centre the block records
      // …and the drawn edge, which reaches further. At R = 3.5 the floored 1.5px disc is
      // 0.43r, so the extent is r×2.83 — past the ward, past the slow pulse, and past
      // where the airborne apex used to sit relative to it.
      expect((pipDistance(d, 0, 0) + d.r) / R).toBeCloseTo(2.4 + 1.5 / R, 3);
      expect((pipDistance(d, 0, 0) + d.r) / R).toBeGreaterThan(2.4);
    }
    // At an ordinary cell the floor is not engaged and the extent settles at r×2.58.
    const big = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, 20, false, POISONED, 899.9999)
      .filter((o) => o.kind === 'drift')
      .map((d) => (pipDistance(d, 0, 0) + d.r) / 20);
    for (const ext of big) expect(ext).toBeCloseTo(2.58, 3);
  });
});

// Driven from the REAL palette, like `POISONED` above.
const STUNNED = resolvePalette('default').stunned;
const WARDED = resolvePalette('default').warded;

describe('stunTelegraphPaintOps (M2-S6) — the stun telegraph', () => {
  it('is empty when the creep is not stunned', () => {
    expect(stunTelegraphPaintOps({ x: 0, y: 0, stunned: false }, R, false, STUNNED, 0)).toEqual([]);
  });

  it('pins the full op array for a representative creep — motion allowed and reduced', () => {
    const ops = stunTelegraphPaintOps({ x: 5, y: 6, stunned: true }, R, false, STUNNED, 0);
    expect(ops).toEqual([
      { kind: 'jolt', x: 5, y: 6, r: R * 1.15, colour: STUNNED, alpha: 1 },
      { kind: 'flicker', x: 5, y: 6, r: R * 0.85, colour: STUNNED, alpha: 0.15 },
    ]);
    const reduced = stunTelegraphPaintOps({ x: 5, y: 6, stunned: true }, R, true, STUNNED, 0);
    expect(reduced).toEqual([{ kind: 'jolt', x: 5, y: 6, r: R * 1.15, colour: STUNNED, alpha: 1 }]);
  });

  it('the jolt is a thick, ALWAYS-opaque ring outside the silhouette — the GUARANTEED shape cue', () => {
    const [jolt] = stunTelegraphPaintOps({ x: 0, y: 0, stunned: true }, R, true, STUNNED, 999);
    expect(jolt!.alpha).toBe(1); // opaque regardless of render time — keeps the palette
    // gate's opaque treatment of `stunned` honest, same posture as `slowed`/`poisoned`.
  });

  it('the jolt and flicker radii MUST differ — an alpha-animated ring at the same radius as an opaque one is invisible', () => {
    const [jolt, flicker] = stunTelegraphPaintOps(
      { x: 0, y: 0, stunned: true },
      R,
      false,
      STUNNED,
      0,
    );
    expect(jolt!.r).not.toBe(flicker!.r);
    // The GUARANTEED cue sits OUTSIDE the silhouette (r>1) so its contrast partner is the
    // board floor, never the creep fill — see the builder's comment. The flicker stays
    // inside as a redundant motion cue.
    expect(jolt!.r).toBeGreaterThan(flicker!.r);
    expect(jolt!.r).toBeGreaterThan(R);
    // AND it must stay INSIDE the slowed ring's radius (r×1.4). The band between the
    // silhouette and that ring is narrow, and the jolt is stroked at weight 4, so this is
    // the one direction the radius must never drift: past 1.4 it stops reading as its own
    // cue and starts reading as a thick slow ring. A slowed creep is also the commonest
    // thing for a stun to land on, so the two co-occur constantly.
    //
    // KNOWN, and deliberately not fixed here: at small cell sizes the two already touch.
    // With r = max(3, cellPx × 0.35), a 1000×700 viewport on `field-01` gives cellPx ≈ 29
    // and r ≈ 10.2, where the jolt's outer edge (13.7px) passes the slow ring's inner edge
    // (13.2px) and the pair reads as one band. Strokes are centred, so clearance needs
    // `jolt_r < 1.4 − 3/r` — a bound that TIGHTENS as cells shrink and reaches 0.4 at the
    // r = 3 clamp, below the 1.0 an outside ring must exceed. The band is empty at small
    // sizes, so no size-independent radius exists and the fix is a cue-radius layout pass
    // across all four telegraph families, which `warded`'s own note already defers. Pinned
    // here so the ordering cannot silently degrade further.
    expect(jolt!.r).toBeLessThan(1.4 * R);
  });

  it('the flicker genuinely animates on the SAME triangle wave slowTelegraphPaintOps uses', () => {
    const at = (t: number) =>
      stunTelegraphPaintOps({ x: 0, y: 0, stunned: true }, R, false, STUNNED, t)[1]!;
    const a0 = at(0).alpha; // wave trough: 0.15 + 0.7*0
    const aMid = at(450).alpha; // wave crest: 0.15 + 0.7*1
    const aWrap = at(900).alpha; // full period — back to the trough
    expect(a0).toBeCloseTo(0.15, 6);
    expect(aMid).toBeCloseTo(0.85, 6);
    expect(aWrap).toBeCloseTo(a0, 10); // periodic, not drifting
    expect(at(0).r).toBe(at(450).r); // the flicker's RADIUS never moves — only alpha does
  });

  it('a non-finite render time is total: the telegraph still renders, un-animated', () => {
    const ops = stunTelegraphPaintOps({ x: 0, y: 0, stunned: true }, R, false, STUNNED, NaN);
    expect(ops.map((o) => o.kind)).toEqual(['jolt', 'flicker']);
    expect(ops[1]!.alpha).toBe(
      stunTelegraphPaintOps({ x: 0, y: 0, stunned: true }, R, false, STUNNED, 0)[1]!.alpha,
    );
  });

  it('keeps the jolt but drops the flicker under reduced motion (WCAG 2.3.3 / GAG §2)', () => {
    const opsA = stunTelegraphPaintOps({ x: 0, y: 0, stunned: true }, R, true, STUNNED, 0);
    const opsB = stunTelegraphPaintOps({ x: 0, y: 0, stunned: true }, R, true, STUNNED, 450);
    expect(opsA.map((o) => o.kind)).toEqual(['jolt']);
    expect(opsB).toEqual(opsA); // the remaining cue does not move
  });
});

describe('wardPaintOps (M2-S6) — the ward cue', () => {
  it('is empty when the creep is not warded', () => {
    expect(wardPaintOps({ x: 0, y: 0, warded: false }, R, WARDED)).toEqual([]);
  });

  it('pins the full op array for a representative creep — a single opaque outer ring', () => {
    expect(wardPaintOps({ x: 5, y: 6, warded: true }, R, WARDED)).toEqual([
      { kind: 'ward', x: 5, y: 6, r: R * 2.2, colour: WARDED, alpha: 1 },
    ]);
  });

  it("sits OUTSIDE the slow pulse's r×2.0 ceiling, so it is never mistaken for an active slow", () => {
    const [ward] = wardPaintOps({ x: 0, y: 0, warded: true }, R, WARDED);
    const [, pulse] = slowTelegraphPaintOps({ x: 0, y: 0, slowed: true }, R, false, 0x56b4e9, 450); // wave crest: r×2.0
    expect(ward!.r).toBeGreaterThan(pulse!.r);
  });

  it('takes no renderTimeMs and has no reduced-motion branch — a ward is not a timed status', () => {
    // Calling the builder with only its documented 3 parameters (creep, r, colour) is
    // itself the assertion: a 4th (renderTimeMs) or 5th (reducedMotion) parameter would
    // fail to compile if this builder ever grew one by mistake.
    const a = wardPaintOps({ x: 1, y: 2, warded: true }, R, WARDED);
    const b = wardPaintOps({ x: 1, y: 2, warded: true }, R, WARDED);
    expect(a).toEqual(b); // deterministic, no hidden time dependency
  });
});
