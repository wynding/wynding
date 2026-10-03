// tower-fire.test.ts — a tower's shots, as the board shows them (visual pass T3, #181): which
// tower fired (a tracer launched from its footprint centre, each shot once, a mine's
// detonation left to its scorch), the recoil, flash and pulse curves on render time, a head's
// pose (and Reduce motion's gate on it), the paint plan — the muzzle flash at the tip of an
// aiming head, the ring pulse of one that does not aim, nothing under Reduce motion — and
// the flash rate a cadence gives at a game speed.

import { describe, it, expect } from 'vitest';
import { FP_ONE } from '@wynding/engine';
import { MS_PER_TICK } from '@wynding/sim';
import { artUnit } from './art-frames';
import { snapToDevicePx } from './device-px';
import { COLOUR_MODES, resolvePalette, roleColour } from './palette';
import { HEAD_AT_REST } from './placement';
import { createProjection } from './projection';
import { ART_FLASH, FIRE_PULSE_RINGS, MUZZLE_FLASH, RECOIL_DEPTH } from './tower-art';
import {
  FIRE_FEEDBACK_TICKS,
  FLASH_TICKS,
  MAX_FLASHES_PER_SECOND,
  PULSE_TICKS,
  RECOIL_TICKS,
  createFireTracker,
  fireFeedbackPaintOps,
  flashAt,
  flashesPerSecond,
  headPose,
  pulseAt,
  recoilAt,
  type FireFrame,
  type FireTracker,
} from './tower-fire';
import { towerRoleFor } from './tower-paint';
import type { TowerVM, TracerVM } from './types';

const PAL = resolvePalette('default');

const tower = (id: number, towerId: string, col: number, row = 2): TowerVM => ({
  id,
  col,
  row,
  towerId,
  support: towerId === 'beacon',
  buffed: false,
  targetId: 0,
});

const centreOf = (t: TowerVM): { x: number; y: number } => ({
  x: (t.col + 1) * FP_ONE,
  y: (t.row + 1) * FP_ONE,
});

/** The tracer a tower's shot shows: from its footprint centre toward a creep. */
const shot = (t: TowerVM, launchTick: number, travel = 2): TracerVM => ({
  kind: 'targeted',
  ...{ originX: centreOf(t).x, originY: centreOf(t).y },
  targetId: 99,
  launchTick,
  impactTick: launchTick + travel,
});

/** A splash tower's shot: a blast leading its target, landing away from its centre. */
const lob = (t: TowerVM, launchTick: number): TracerVM => ({
  kind: 'blast',
  originX: centreOf(t).x,
  originY: centreOf(t).y,
  destX: centreOf(t).x + 3 * FP_ONE,
  destY: centreOf(t).y,
  launchTick,
  impactTick: launchTick + 8,
});

/** A mine going off: a blast from its centre to its centre. */
const detonation = (t: TowerVM, launchTick: number): TracerVM => ({
  kind: 'blast',
  originX: centreOf(t).x,
  originY: centreOf(t).y,
  destX: centreOf(t).x,
  destY: centreOf(t).y,
  launchTick,
  impactTick: launchTick + 1,
});

const frame = (over: Partial<FireFrame>): FireFrame => ({
  tracers: [],
  towers: [],
  renderTick: 0,
  ...over,
});

/** An aim tracker that reports the angles it is given. */
const aimAt = (angles: Record<number, number> = {}) => ({
  angleOf: (id: number): number => angles[id] ?? 0,
});

/** A fire tracker that reports the ticks-since-firing it is given. */
const firedAgo = (since: Record<number, number> = {}): Pick<FireTracker, 'sinceFired'> => ({
  sinceFired: (id: number): number | null => since[id] ?? null,
});

describe('the feedback curves — on render time, each a single rise and fade', () => {
  it('lasts 80–200 ms each, and a shot is remembered for the longest', () => {
    for (const ticks of [RECOIL_TICKS, FLASH_TICKS, PULSE_TICKS]) {
      expect(ticks * MS_PER_TICK).toBeGreaterThanOrEqual(80);
      expect(ticks * MS_PER_TICK).toBeLessThanOrEqual(200);
    }
    expect(FIRE_FEEDBACK_TICKS).toBe(Math.max(RECOIL_TICKS, FLASH_TICKS, PULSE_TICKS));
  });

  it('recoil: all the way back at the shot, easing home — quickly, then settling', () => {
    expect(recoilAt(0)).toBe(1);
    expect(recoilAt(RECOIL_TICKS / 2)).toBeCloseTo(0.25, 12);
    expect(recoilAt(RECOIL_TICKS)).toBe(0);
    expect(recoilAt(RECOIL_TICKS + 5)).toBe(0);
    expect(recoilAt(-0.5)).toBe(0); // a shot from the future shows nothing
    expect(recoilAt(Number.NaN)).toBe(0);
    // Monotone home: each moment sits no further back than the one before.
    let last = 1;
    for (let t = 0; t <= RECOIL_TICKS; t += 0.25) {
      expect(recoilAt(t)).toBeLessThanOrEqual(last);
      last = recoilAt(t);
    }
  });

  it('flash and pulse: full at the shot, fading linearly to nothing', () => {
    expect(flashAt(0)).toBe(1);
    expect(flashAt(FLASH_TICKS / 4)).toBeCloseTo(0.75, 12);
    expect(flashAt(FLASH_TICKS)).toBe(0);
    expect(pulseAt(0)).toBe(1);
    expect(pulseAt(PULSE_TICKS / 2)).toBeCloseTo(0.5, 12);
    expect(pulseAt(PULSE_TICKS)).toBe(0);
    expect(pulseAt(-1)).toBe(0);
  });

  it('flashesPerSecond: one flash per shot, sped up with the game', () => {
    // Antiair fires every 15 ticks: 0.75 s at 1× — 1⅓ a second — and twice that at 2×.
    expect(flashesPerSecond(15, 1)).toBeCloseTo(4 / 3, 12);
    expect(flashesPerSecond(15, 2)).toBeCloseTo(8 / 3, 12);
    expect(flashesPerSecond(20, 1)).toBe(1);
    expect(MAX_FLASHES_PER_SECOND).toBe(3); // ADR 0003 / WCAG 2.3.1
  });
});

describe('createFireTracker — which tower fired', () => {
  const basic = tower(1, 'basic', 2);
  const slow = tower(2, 'slow', 6);

  it('notes a tower whose shot appears from its footprint centre, at the render tick it is seen', () => {
    const fire = createFireTracker();
    fire.update(frame({ towers: [basic, slow], renderTick: 10 }));
    expect(fire.sinceFired(1)).toBeNull();
    fire.update(frame({ towers: [basic, slow], tracers: [shot(basic, 10)], renderTick: 10.25 }));
    expect(fire.sinceFired(1)).toBe(0);
    expect(fire.sinceFired(2)).toBeNull(); // the other tower did not fire
    fire.update(frame({ towers: [basic, slow], tracers: [shot(basic, 10)], renderTick: 11.75 }));
    expect(fire.sinceFired(1)).toBe(1.5);
  });

  it('takes each shot once, however many frames its tracer stays listed', () => {
    const fire = createFireTracker();
    const flight = [lob(slow, 20)]; // an eight-tick flight
    fire.update(frame({ towers: [slow], tracers: flight, renderTick: 20 }));
    fire.update(frame({ towers: [slow], tracers: flight, renderTick: 21 }));
    fire.update(frame({ towers: [slow], tracers: flight, renderTick: 22 }));
    expect(fire.sinceFired(2)).toBe(2); // still timed from the first sight
    fire.update(frame({ towers: [slow], tracers: flight, renderTick: 20 + FIRE_FEEDBACK_TICKS }));
    expect(fire.sinceFired(2)).toBeNull(); // over, though its tracer still flies
  });

  it('a tower’s next shot restarts its feedback', () => {
    const fire = createFireTracker();
    fire.update(frame({ towers: [basic], tracers: [shot(basic, 10)], renderTick: 10 }));
    fire.update(frame({ towers: [basic], tracers: [shot(basic, 10)], renderTick: 11.5 }));
    expect(fire.sinceFired(1)).toBe(1.5);
    fire.update(
      frame({ towers: [basic], tracers: [shot(basic, 10), shot(basic, 12)], renderTick: 12 }),
    );
    expect(fire.sinceFired(1)).toBe(0);
  });

  it('leaves a mine going off to its scorch — `isDetonation`, the scorches’ own rule', () => {
    const fire = createFireTracker();
    const mine = tower(3, 'mine', 10);
    fire.update(frame({ towers: [mine], tracers: [detonation(mine, 30)], renderTick: 30 }));
    expect(fire.sinceFired(3)).toBeNull();
    // A splash tower's blast, which leads its target, is a shot like any other.
    fire.update(frame({ towers: [mine, slow], tracers: [lob(slow, 30)], renderTick: 30.5 }));
    expect(fire.sinceFired(2)).toBe(0);
  });

  it('notes nothing for a tracer launched from no tower’s centre', () => {
    const fire = createFireTracker();
    const offCentre: TracerVM = { ...shot(basic, 10), originX: centreOf(basic).x + 1 };
    fire.update(frame({ towers: [basic], tracers: [offCentre], renderTick: 10 }));
    expect(fire.sinceFired(1)).toBeNull();
    // A shot from a tower already gone (sold right after it fired) is no tower's either.
    fire.update(frame({ towers: [], tracers: [shot(basic, 12)], renderTick: 12 }));
    expect(fire.sinceFired(1)).toBeNull();
  });

  it('shows nothing for a shot first seen after its feedback would be over', () => {
    const fire = createFireTracker();
    fire.update(
      frame({ towers: [slow], tracers: [lob(slow, 20)], renderTick: 20 + FIRE_FEEDBACK_TICKS }),
    );
    expect(fire.sinceFired(2)).toBeNull();
    // ... while one first seen a moment late — a frame that covered two ticks — still shows.
    fire.update(frame({ towers: [slow], tracers: [lob(slow, 30)], renderTick: 31.5 }));
    expect(fire.sinceFired(2)).toBe(0);
  });

  it('forgets a tower that is gone, and a shot "seen" after the time being drawn', () => {
    const fire = createFireTracker();
    fire.update(frame({ towers: [basic, slow], tracers: [shot(basic, 10)], renderTick: 10 }));
    fire.update(frame({ towers: [slow], tracers: [shot(basic, 10)], renderTick: 10.5 }));
    expect(fire.sinceFired(1)).toBeNull(); // sold
    fire.update(frame({ towers: [slow], tracers: [lob(slow, 40)], renderTick: 40 }));
    expect(fire.sinceFired(2)).toBe(0);
    fire.update(frame({ towers: [slow], tracers: [], renderTick: 7 })); // a new run, not reset
    expect(fire.sinceFired(2)).toBeNull();
  });

  it('a reset forgets every shot — and a tracer still listed after it is taken in afresh', () => {
    const fire = createFireTracker();
    const flight = [shot(basic, 10)];
    fire.update(frame({ towers: [basic], tracers: flight, renderTick: 10 }));
    fire.reset();
    expect(fire.sinceFired(1)).toBeNull();
    fire.update(frame({ towers: [basic], tracers: flight, renderTick: 11 }));
    expect(fire.sinceFired(1)).toBe(0);
  });
});

describe('headPose — the turn and the knock-back placement gives a head', () => {
  const cellPx = 32; // one design unit is one CSS px
  const basic = tower(1, 'basic', 2);

  it('turns an aiming head to its aim angle and knocks it back by the recoil, in CSS px', () => {
    expect(headPose(basic, aimAt({ 1: 0.7 }), firedAgo(), false, cellPx)).toEqual({
      angle: 0.7,
      recoilPx: 0,
    });
    const atShot = headPose(basic, aimAt({ 1: 0.7 }), firedAgo({ 1: 0 }), false, cellPx);
    expect(atShot).toEqual({ angle: 0.7, recoilPx: RECOIL_DEPTH * artUnit(cellPx) });
    const later = headPose(basic, aimAt({ 1: 0.7 }), firedAgo({ 1: 1.5 }), false, cellPx);
    expect(later.recoilPx).toBeCloseTo(RECOIL_DEPTH * recoilAt(1.5), 12);
    // The knock-back scales with the cell.
    expect(headPose(basic, aimAt(), firedAgo({ 1: 0 }), false, 10).recoilPx).toBeCloseTo(
      RECOIL_DEPTH * (20 / 64),
      12,
    );
  });

  it('is at rest — the very object — for a head pointing up that has not just fired', () => {
    expect(headPose(basic, aimAt(), firedAgo(), false, cellPx)).toBe(HEAD_AT_REST);
    expect(headPose(basic, aimAt(), firedAgo({ 1: RECOIL_TICKS }), false, cellPx)).toBe(
      HEAD_AT_REST,
    );
  });

  it('never poses a head that does not aim, even one that just fired', () => {
    for (const id of ['slow', 'splash', 'frost-splash', 'beacon', 'mine']) {
      const t = tower(1, id, 2);
      expect(headPose(t, aimAt({ 1: 1 }), firedAgo({ 1: 0 }), false, cellPx), id).toBe(
        HEAD_AT_REST,
      );
    }
  });

  it('under Reduce motion holds every head at rest: no turn, no recoil', () => {
    expect(headPose(basic, aimAt({ 1: 1 }), firedAgo({ 1: 0 }), true, cellPx)).toBe(HEAD_AT_REST);
  });
});

describe('fireFeedbackPaintOps — the muzzle flash and the ring pulse', () => {
  // 33px cells at dpr 1: the board's corner at (74, 6).
  const projection = createProjection({
    cols: 28,
    rows: 24,
    cssWidth: 1072,
    cssHeight: 804,
    dpr: 1,
  });
  const unit = artUnit(projection.cellPx);
  const centre = (t: TowerVM): { x: number; y: number } => {
    const c = projection.cellToPixel(t.col, t.row);
    return { x: c.x + projection.cellPx, y: c.y + projection.cellPx };
  };

  it('flashes an aiming tower at its muzzle, just past its tip, in warm white, fading', () => {
    const basic = tower(1, 'basic', 4);
    const c = centre(basic);
    const [op, ...rest] = fireFeedbackPaintOps(
      [basic],
      aimAt(),
      firedAgo({ 1: 0 }),
      false,
      PAL,
      projection,
    );
    expect(rest).toEqual([]);
    expect(op).toEqual({
      kind: 'flash',
      x: c.x,
      y: c.y - MUZZLE_FLASH.reach * unit, // pointing up: straight above the centre
      r: MUZZLE_FLASH.r * unit,
      colour: ART_FLASH,
      alpha: MUZZLE_FLASH.alpha,
    });
    const half = fireFeedbackPaintOps(
      [basic],
      aimAt(),
      firedAgo({ 1: FLASH_TICKS / 2 }),
      false,
      PAL,
      projection,
    );
    expect(half[0]!.alpha).toBeCloseTo(MUZZLE_FLASH.alpha / 2, 12);
  });

  it('puts the flash where the head faces — turned a quarter right, it is right of the centre', () => {
    const venom = tower(1, 'venom', 4);
    const c = centre(venom);
    const [op] = fireFeedbackPaintOps(
      [venom],
      aimAt({ 1: Math.PI / 2 }),
      firedAgo({ 1: 0 }),
      false,
      PAL,
      projection,
    );
    expect(op!.x).toBeCloseTo(c.x + MUZZLE_FLASH.reach * unit, 9);
    expect(op!.y).toBeCloseTo(c.y, 9);
  });

  it('is done flashing before its recoil settles: nothing after FLASH_TICKS', () => {
    const basic = tower(1, 'basic', 4);
    expect(
      fireFeedbackPaintOps([basic], aimAt(), firedAgo({ 1: FLASH_TICKS }), false, PAL, projection),
    ).toEqual([]);
  });

  it('pulses a head that does not aim: two rings about its centre in its role colour, fading', () => {
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      for (const id of ['slow', 'splash', 'frost-splash']) {
        const t = tower(1, id, 4);
        const c = centre(t);
        const ops = fireFeedbackPaintOps(
          [t],
          aimAt({ 1: 2 }),
          firedAgo({ 1: 0 }),
          false,
          pal,
          projection,
        );
        expect(ops, `${mode} ${id}`).toEqual(
          FIRE_PULSE_RINGS.map((ring) => ({
            kind: 'ring',
            x: c.x,
            y: c.y,
            r: ring.r * unit,
            width: ring.width * unit,
            colour: roleColour(pal, towerRoleFor(id)),
            alpha: ring.alpha,
          })),
        );
      }
    }
    const slow = tower(1, 'slow', 4);
    const late = fireFeedbackPaintOps(
      [slow],
      aimAt(),
      firedAgo({ 1: PULSE_TICKS / 2 }),
      false,
      PAL,
      projection,
    );
    expect(late.map((op) => op.alpha)).toEqual(FIRE_PULSE_RINGS.map((ring) => ring.alpha / 2));
  });

  it('draws nothing for a tower that has not just fired, and nothing at all under Reduce motion', () => {
    const towers = [tower(1, 'basic', 4), tower(2, 'slow', 8)];
    expect(fireFeedbackPaintOps(towers, aimAt(), firedAgo(), false, PAL, projection)).toEqual([]);
    expect(
      fireFeedbackPaintOps(towers, aimAt(), firedAgo({ 1: 0, 2: 0 }), true, PAL, projection),
    ).toEqual([]);
    expect(
      fireFeedbackPaintOps(towers, aimAt(), firedAgo({ 1: 0, 2: 0 }), false, PAL, projection),
    ).toHaveLength(3); // the flash and both rings
  });

  it('keeps the flash at least 2 CSS px across and every ring stroke at least 1 — on 10px cells too', () => {
    const small = createProjection({ cols: 28, rows: 24, cssWidth: 280, cssHeight: 240, dpr: 1 });
    expect(small.cellPx).toBe(10);
    const ops = fireFeedbackPaintOps(
      [tower(1, 'basic', 4), tower(2, 'slow', 8)],
      aimAt(),
      firedAgo({ 1: 0, 2: 0 }),
      false,
      PAL,
      small,
    );
    const flash = ops.find((op) => op.kind === 'flash')!;
    expect(flash.r).toBe(2); // the frame's 6 units would be 1.9 px
    const rings = ops.filter((op) => op.kind === 'ring');
    expect(rings.map((op) => (op.kind === 'ring' ? op.width : 0))).toEqual([1, 1]);
  });

  it('centres everything on the snapped footprint corner plus a cell, as the head turns about', () => {
    // 1074×802 at dpr 1.25: footprint (3, 5) lands between device pixels.
    const frac = createProjection({
      cols: 28,
      rows: 24,
      cssWidth: 1074,
      cssHeight: 802,
      dpr: 1.25,
    });
    const t = tower(1, 'splash', 3, 5);
    const raw = frac.cellToPixel(3, 5);
    expect(raw.x * 1.25).not.toBeCloseTo(Math.round(raw.x * 1.25), 3);
    const [ring] = fireFeedbackPaintOps([t], aimAt(), firedAgo({ 1: 0 }), false, PAL, frac);
    expect(ring!.x).toBe(snapToDevicePx(raw.x, 1.25) + frac.cellPx);
    expect(ring!.y).toBe(snapToDevicePx(raw.y, 1.25) + frac.cellPx);
  });
});
