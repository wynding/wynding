// creep-paint.test.ts — the silhouette/telegraph paint-plan (M2-S3), asserted at the REAL
// supported floor (568×320 → CELL_PX_MIN_NARROW = 10px cells, Codex R1-12) rather than the
// 12px the risk-of-record originally assumed.

import { describe, it, expect } from 'vitest';
import {
  creepShapeFor,
  creepSilhouettePaintOp,
  slowTelegraphPaintOps,
  dotTelegraphPaintOps,
  stunTelegraphPaintOps,
  wardPaintOps,
  airborneCuePaintOps,
} from './creep-paint';
import { resolvePalette } from './palette';

// The narrow floor's cell size (apps/web/e2e/compact.spec.ts's CELL_PX_MIN_NARROW) — the
// silhouette radius the scene actually draws at that floor (`max(3, cellPx * 0.35)`).
const CELL_PX_MIN_NARROW = 10;
const R = Math.max(3, CELL_PX_MIN_NARROW * 0.35);

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

describe('creepSilhouettePaintOp', () => {
  it('carries the id-keyed shape plus the passed-through geometry/colour/hpFrac', () => {
    const op = creepSilhouettePaintOp('fast', 10, 20, R, 0xf0e442, 0.5);
    expect(op).toEqual({ shape: 'diamond', x: 10, y: 20, r: R, colour: 0xf0e442, hpFrac: 0.5 });
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
  });

  // QC round 3 — the three assertions below pin fixes that landed in earlier rounds with
  // NO regression guard: reviewers reverted each one and the whole 116-test render suite
  // stayed green. Every pre-existing positional assertion measures DISTANCE from the
  // centre, which is rotation-invariant and so cannot see an orientation regression at
  // all; the narrow-floor test measures ring SEPARATION, never a pip's own drawn radius.

  it('puts the lone pip at the TOP (apex-up, matching the triangle silhouette and the hexagon) — not the bottom', () => {
    const pips = dotTelegraphPaintOps({ x: 0, y: 0, poisoned: true }, R, true, POISONED, 0);
    // Canvas y grows DOWNWARD, so "above the centre" is y < 0. The first draft's
    // [90, 210, 330] inverts this exactly — one pip BELOW and two above — and is
    // indistinguishable from the correct set by distance alone.
    const above = pips.filter((p) => p.y < 0);
    expect(above).toHaveLength(1);
    expect(above[0]!.x).toBeCloseTo(0, 6); // horizontally centred: straight up, not off-axis
    expect(above[0]!.y).toBeCloseTo(-R * 1.8, 6);
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
const AIRBORNE = resolvePalette('default').airborne;

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

describe('airborneCuePaintOps (M2-S7) — the airborne cue', () => {
  it('is empty for a ground creep (not emitted)', () => {
    expect(airborneCuePaintOps({ x: 0, y: 0, airborne: false }, R, AIRBORNE)).toEqual([]);
  });

  it('is emitted for an air creep — a single wingspan op', () => {
    expect(airborneCuePaintOps({ x: 5, y: 6, airborne: true }, R, AIRBORNE)).toEqual([
      {
        kind: 'wingspan',
        apexX: 5,
        apexY: 6 - R * 3.4,
        leftX: 5 - R * 0.9,
        leftY: 6 - R * 3.1,
        rightX: 5 + R * 0.9,
        rightY: 6 - R * 3.1,
        colour: AIRBORNE,
        alpha: 1,
      },
    ]);
  });

  it("composes over the base silhouette rather than replacing it — creepShapeFor is untouched by domain, and the cue is an independent, ADDITIONAL paint plan (armored-flyer's S10 requirement)", () => {
    // The shape a creep draws is keyed ONLY on `creepId` (`creepShapeFor`) — domain is
    // never consulted, so an armored id keeps its hexagon regardless of whether it is
    // also airborne.
    expect(creepShapeFor('armored')).toBe('hexagon');
    // The airborne cue is a SEPARATE paint plan (its own function, its own op list) —
    // both fire independently for a creep that is both armored (shape) and airborne
    // (this cue), so the scene draws both, never one instead of the other.
    const silhouette = creepSilhouettePaintOp('armored', 5, 6, R, 0xffffff, 1);
    const airborne = airborneCuePaintOps({ x: 5, y: 6, airborne: true }, R, AIRBORNE);
    expect(silhouette.shape).toBe('hexagon');
    expect(airborne).toHaveLength(1);
    expect(airborne[0]!.kind).toBe('wingspan');
  });

  it('clears the silhouette AND every timed telegraph ring AND the ward — every point at radius ≥ r×3.22', () => {
    // The original version of this test only checked the SILHOUETTE (|y| > r, |x| > r),
    // which the old r×1.393 wingtips satisfied while sitting exactly on the slow ring at
    // r×1.4 and crossing the stun jolt at r×1.15 (ship-review, M2-S7). Radius from the
    // creep centre is what decides collision — every other cue here is a circle centred
    // on it — so that is what this asserts now, mirroring the dot-pip and ward
    // clearance tests above.
    const [op] = airborneCuePaintOps({ x: 0, y: 0, airborne: true }, R, AIRBORNE);
    const radius = (x: number, y: number): number => Math.hypot(x, y) / R;
    const points: ReadonlyArray<readonly [number, number]> = [
      [op!.apexX, op!.apexY],
      [op!.leftX, op!.leftY],
      [op!.rightX, op!.rightY],
    ];
    for (const [x, y] of points) {
      expect(radius(x, y)).toBeGreaterThan(1.15); // stun jolt
      expect(radius(x, y)).toBeGreaterThan(1.4); // slow ring
      expect(radius(x, y)).toBeGreaterThan(1.8); // dot pips
      expect(radius(x, y)).toBeGreaterThan(2.0); // slow pulse ceiling
      expect(radius(x, y)).toBeGreaterThan(2.2); // ward
      // The drift's CENTRE crest (r×2.4) — the outermost timed cue, which the block this
      // ladder mirrors used to omit entirely (#126). Its DRAWN extent goes further still;
      // that is measured, not laddered, by the case below.
      expect(radius(x, y)).toBeGreaterThan(2.4);
      // …and the rung this title actually claims. Without it the whole body passes under
      // the PRE-#126 geometry (tips at r×2.751, apex r×2.9), so the title's radius was an
      // unpinned assertion — the same class of defect as the comment block this ladder
      // mirrors. The bound is r×3.22, NOT the r×3.23 the prose rounds to: the wingtips are
      // the minimum at √(0.9² + 3.1²) = 3.22800…, so "≥ 3.23" is false by 0.002 and would
      // fail here. Approximations may round; a pinned bound may not.
      expect(radius(x, y)).toBeGreaterThan(3.22);
      expect(y).toBeLessThan(0); // and it floats ABOVE the creep, not around it
    }
    expect(op!.leftX).toBeLessThan(0); // still a chevron: tips either side of the apex
    expect(op!.rightX).toBeGreaterThan(0);
  });

  // The lineWidth `board-draw.ts` strokes the wingspan with. Strokes are centred, so half
  // of it spills INSIDE the geometric radius — the same correction this file's stun note
  // makes for the jolt/slow pair, and the reason a radius ladder alone under-counts.
  const AIRBORNE_STROKE_PX = 2;

  /** Distance from a point to a line SEGMENT (not its infinite line — the chevron's
   *  strokes stop at the apex and the tips, and treating them as infinite would report a
   *  collision that is not drawn). */
  const distToSegment = (
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): number => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  /** The worst (smallest) gap, in px, between any drift pip's FILLED DISC and either
   *  drawn chevron stroke, over the whole 900ms sawtooth. Negative means they overlap. */
  const worstDriftGap = (r: number): { gap: number; atMs: number } => {
    const [wing] = airborneCuePaintOps({ x: 0, y: 0, airborne: true }, r, AIRBORNE);
    let gap = Infinity;
    let atMs = 0;
    // 1ms steps across the sawtooth's full period — the drift's radius is monotonic in
    // phase, so this brackets the crest without assuming where the crest is.
    for (let ms = 0; ms < 900; ms++) {
      for (const d of dotTelegraphPaintOps(
        { x: 0, y: 0, poisoned: true },
        r,
        false,
        POISONED,
        ms,
      )) {
        if (d.kind !== 'drift') continue;
        for (const [bx, by] of [
          [wing!.leftX, wing!.leftY],
          [wing!.rightX, wing!.rightY],
        ]) {
          const g =
            distToSegment(d.x, d.y, wing!.apexX, wing!.apexY, bx!, by!) -
            d.r -
            AIRBORNE_STROKE_PX / 2;
          if (g < gap) {
            gap = g;
            atMs = ms;
          }
        }
      }
    }
    return { gap, atMs };
  };

  it('clears the DoT drift — the outermost timed cue — at the narrow cell floor, where the pip floor makes it widest (#126)', () => {
    // THE CO-OCCURRENCE IS A VM CONTRACT, NOT A REACHABLE CONTENT STATE. `poisoned` and
    // `airborne` are independent booleans on the render VM, so the builders must compose
    // for a creep carrying both — that alone is what this asserts. In today's shipped
    // rulesets a poisoned flyer cannot occur: every `dot` effect belongs to a GROUND-domain
    // tower (`venom`, and `stress-venom` in the stress ruleset), and `combat.ts` rejects an
    // impact whose domain does not cover the target's. `slow` is the both-domain effect
    // since S7; an earlier version of this comment misattributed that to `venom`.
    //
    // Asserted anyway, and DELIBERATELY: the alternative — "safe, because shipped DoT
    // sources are ground-only" — would pin content domain assignments inside a render test,
    // the exact cross-layer coupling #126 exists to correct, and would go quietly wrong the
    // day a ruleset ships an air-capable DoT. The geometry is real either way.
    //
    // The drift's outward crest lands straight above the creep (the 270° pip) — the one
    // sector the chevron occupies — and its drawn disc is held at `DOT_PIP_MIN_PX` while
    // the chevron's radius stays proportional, so the narrow floor is where they meet.
    //
    // MEASURED, never hand-computed: the numbers below are printed by this test, and it
    // is the print that made #126 decidable. At the pre-#126 apex of r×2.9 both were
    // NEGATIVE (r=3.5: −0.838px, r=3: −1.075px) — a real overlap, not a tight fit.
    const supported = worstDriftGap(R); // R = 3.5, the CELL_PX_MIN_NARROW = 10 floor
    const clamped = worstDriftGap(3); // the defensive `max(3, cellPx × 0.35)` clamp
    console.log(
      `[#126] airborne-vs-drift clearance: r=${R} → ${supported.gap.toFixed(3)}px (worst at ${supported.atMs}ms); r=3 → ${clamped.gap.toFixed(3)}px (worst at ${clamped.atMs}ms)`,
    );
    expect(supported.gap).toBeGreaterThan(0);
    expect(clamped.gap).toBeGreaterThan(0);
    // And it only gets easier as cells grow — the drift's extent is a ratio plus a pixel
    // floor, so the floor's contribution shrinks relative to r.
    for (const r of [5, 10, 20, 40]) expect(worstDriftGap(r).gap).toBeGreaterThan(0);
  });

  it('flips BELOW the creep when the upward cue would leave the viewport (Codex P2, PR #87)', () => {
    // A flyer near the canvas top — the row-0-openings board, which P1's axis-alignment
    // gate admits because entrance and exit share a row. Without the flip the whole
    // wingspan draws at negative y and is never seen, and since `flying` shares
    // `normal`'s silhouette that removes the ONLY air-vs-ground channel.
    const nearTop = airborneCuePaintOps({ x: 100, y: R * 0.5, airborne: true }, R, AIRBORNE, 0);
    const [flipped] = nearTop;
    expect(flipped!.apexY).toBeGreaterThan(R * 0.5); // below the creep centre, not above
    expect(flipped!.leftY).toBeGreaterThan(R * 0.5);
    for (const y of [flipped!.apexY, flipped!.leftY, flipped!.rightY]) {
      expect(y).toBeGreaterThanOrEqual(0); // and on-canvas
    }

    // Mirroring only changes the SIGN — every radius, and so every clearance derived in
    // the CUE-RADIUS ORDERING block, is preserved.
    const centre = { x: 0, y: 0 };
    const up = airborneCuePaintOps({ ...centre, airborne: true }, R, AIRBORNE, -Infinity)[0]!;
    const down = airborneCuePaintOps({ ...centre, airborne: true }, R, AIRBORNE, 0)[0]!;
    expect(Math.abs(down.apexY)).toBeCloseTo(Math.abs(up.apexY), 10);
    expect(Math.abs(down.leftY)).toBeCloseTo(Math.abs(up.leftY), 10);
    expect(down.leftX).toBe(up.leftX); // horizontal span untouched
  });

  it('does NOT flip when there is room above — the default stays upward', () => {
    const [op] = airborneCuePaintOps({ x: 100, y: 500, airborne: true }, R, AIRBORNE, 0);
    expect(op!.apexY).toBeLessThan(500);
  });

  it('takes no renderTimeMs and has no reduced-motion branch — a domain is not a timed status', () => {
    // Same posture as `wardPaintOps`'s own test above: calling the builder with only
    // its documented 3 parameters (creep, r, colour) is itself the assertion.
    const a = airborneCuePaintOps({ x: 1, y: 2, airborne: true }, R, AIRBORNE);
    const b = airborneCuePaintOps({ x: 1, y: 2, airborne: true }, R, AIRBORNE);
    expect(a).toEqual(b); // deterministic, no hidden time dependency
  });
});
