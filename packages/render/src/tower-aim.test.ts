// tower-aim.test.ts — where each tower's head points (visual pass T3, #181): the angle maths
// (clockwise from straight up, wrapped), the shorter-arc step at a bounded rate, and the
// tracker — new heads point up, aiming heads sweep toward where their target is drawn and
// track it, idle heads hold, the rest never turn, render time drives it (a pause freezes it),
// Reduce motion holds every head at 0, and gone towers are forgotten.

import { describe, it, expect } from 'vitest';
import { FP_ONE } from '@wynding/engine';
import {
  AIM_TURN_PER_TICK,
  aimAngle,
  createAimTracker,
  stepToward,
  wrapAngle,
  type AimFrame,
} from './tower-aim';
import type { TowerVM } from './types';

const PI = Math.PI;

/** A tower anchored at (col, row): its footprint centre is the anchor's far corner. */
const tower = (id: number, towerId: string, opts: Partial<TowerVM> = {}): TowerVM => ({
  id,
  col: 4,
  row: 4,
  towerId,
  support: towerId === 'beacon',
  buffed: false,
  targetId: 0,
  ...opts,
});

/** The footprint centre of a tower at (4, 4): (5, 5) cells, in fixed-point units. */
const CX = 5 * FP_ONE;
const CY = 5 * FP_ONE;

/** A creep drawn `cells` away from the (4, 4) tower's centre in direction `(ux, uy)`. */
const at = (ux: number, uy: number, cells = 2): { x: number; y: number } => ({
  x: CX + ux * cells * FP_ONE,
  y: CY + uy * cells * FP_ONE,
});

const frame = (over: Partial<AimFrame>): AimFrame => ({
  towers: [],
  creeps: new Map(),
  renderTick: 0,
  reducedMotion: false,
  ...over,
});

describe('wrapAngle — the same direction in (−π, π]', () => {
  it('leaves an angle already in range as it is, and keeps π (not −π)', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(1)).toBe(1);
    expect(wrapAngle(-1)).toBe(-1);
    expect(wrapAngle(PI)).toBe(PI);
    expect(wrapAngle(-PI)).toBe(PI);
  });

  it('brings any other angle into range by whole turns', () => {
    expect(wrapAngle(1.5 * PI)).toBeCloseTo(-0.5 * PI, 12);
    expect(wrapAngle(-1.5 * PI)).toBeCloseTo(0.5 * PI, 12);
    expect(wrapAngle(4 * PI + 0.25)).toBeCloseTo(0.25, 12);
    expect(wrapAngle(-6 * PI - 0.25)).toBeCloseTo(-0.25, 12);
  });
});

describe('aimAngle — clockwise from straight up, as a head drawn pointing up turns', () => {
  it('is 0 straight up, a quarter turn right, a half turn down and a quarter turn back left', () => {
    // y grows DOWNWARD on the board, so "up" is −y.
    expect(aimAngle(0, 0, 0, -10)).toBe(0);
    expect(aimAngle(0, 0, 10, 0)).toBeCloseTo(PI / 2, 12);
    expect(aimAngle(0, 0, 0, 10)).toBeCloseTo(PI, 12);
    expect(aimAngle(0, 0, -10, 0)).toBeCloseTo(-PI / 2, 12);
    expect(aimAngle(0, 0, 10, -10)).toBeCloseTo(PI / 4, 12);
    expect(aimAngle(0, 0, -10, 10)).toBeCloseTo((-3 * PI) / 4, 12);
  });

  it('is measured from the first point to the second, at any scale', () => {
    expect(aimAngle(CX, CY, CX + 3, CY + 3)).toBeCloseTo((3 * PI) / 4, 12);
    expect(aimAngle(CX, CY, CX + 3 * FP_ONE, CY + 3 * FP_ONE)).toBeCloseTo((3 * PI) / 4, 12);
  });

  it('is null where the two points coincide — there is no way to face', () => {
    expect(aimAngle(CX, CY, CX, CY)).toBeNull();
  });
});

describe('stepToward — the shorter arc, at most maxStep', () => {
  it('reaches a target within reach exactly', () => {
    expect(stepToward(0, 0.2, 0.3)).toBe(0.2);
    expect(stepToward(0, -0.3, 0.3)).toBe(-0.3);
    expect(stepToward(1, 1, 0)).toBe(1); // already there, even with no time to turn
  });

  it('turns at most maxStep toward a target out of reach, either way', () => {
    expect(stepToward(0, 1, 0.25)).toBe(0.25);
    expect(stepToward(0, -1, 0.25)).toBe(-0.25);
    expect(stepToward(0.5, 2, 0)).toBe(0.5); // no time, no turn
  });

  it('goes the short way round across ±π, never the long way', () => {
    // From just short of a half turn clockwise to just past it the other way: 0.2 apart
    // through π, not 2π − 0.2 back through 0.
    const next = stepToward(PI - 0.1, -PI + 0.1, 0.05);
    expect(next).toBeCloseTo(PI - 0.05, 12);
    const across = stepToward(PI - 0.1, -PI + 0.1, 0.15);
    expect(across).toBeCloseTo(-PI + 0.05, 12); // and wraps when it crosses
  });

  it('turns clockwise toward a target dead opposite', () => {
    expect(stepToward(0, PI, 0.1)).toBeCloseTo(0.1, 12);
    expect(stepToward(PI / 2, -PI / 2, 0.1)).toBeCloseTo(PI / 2 + 0.1, 12);
  });
});

describe('createAimTracker', () => {
  it('turns at a bounded rate: half a turn in ten ticks', () => {
    expect(AIM_TURN_PER_TICK * 10).toBeCloseTo(PI, 12);
  });

  it('starts a tower it has not seen pointing up, and turns it on the frames after', () => {
    const aim = createAimTracker();
    const creep = at(1, 0); // due right: a quarter turn
    const t = tower(1, 'basic', { targetId: 9 });
    expect(aim.angleOf(1)).toBe(0); // never seen
    aim.update(frame({ towers: [t], creeps: new Map([[9, creep]]), renderTick: 10 }));
    expect(aim.angleOf(1)).toBe(0); // the first frame has no time behind it
    aim.update(frame({ towers: [t], creeps: new Map([[9, creep]]), renderTick: 11 }));
    expect(aim.angleOf(1)).toBeCloseTo(AIM_TURN_PER_TICK, 12); // one tick's turn
    aim.update(frame({ towers: [t], creeps: new Map([[9, creep]]), renderTick: 11.5 }));
    expect(aim.angleOf(1)).toBeCloseTo(1.5 * AIM_TURN_PER_TICK, 12); // half a tick's more
    // ... and lands on the target, exactly, once it is within a frame's reach.
    aim.update(frame({ towers: [t], creeps: new Map([[9, creep]]), renderTick: 20 }));
    expect(aim.angleOf(1)).toBeCloseTo(PI / 2, 12);
  });

  it('faces where its target is DRAWN — the frame’s interpolated point — and tracks it', () => {
    const aim = createAimTracker();
    const t = tower(1, 'venom', { targetId: 9 });
    const seen = (renderTick: number, p: { x: number; y: number }): number => {
      aim.update(frame({ towers: [t], creeps: new Map([[9, p]]), renderTick }));
      return aim.angleOf(1);
    };
    seen(0, at(0, -1));
    expect(seen(1, at(0, -1))).toBe(0); // straight up already
    // The creep moves a little each frame; within the turn rate, the head stays on it.
    for (let i = 1; i <= 10; i++) {
      const p = { x: CX + i * 20, y: CY - 2 * FP_ONE };
      expect(seen(1 + i * 0.25, p)).toBeCloseTo(aimAngle(CX, CY, p.x, p.y)!, 12);
    }
  });

  it('sweeps the shorter way to a new target rather than snapping', () => {
    const aim = createAimTracker();
    const t = tower(1, 'stun', { targetId: 9 });
    const creeps = new Map([
      [9, at(1, 0)], // right
      [10, at(-1, -1)], // up and left
    ]);
    aim.update(frame({ towers: [t], creeps, renderTick: 0 }));
    aim.update(frame({ towers: [t], creeps, renderTick: 100 })); // long enough to face it
    expect(aim.angleOf(1)).toBeCloseTo(PI / 2, 12);
    // Retarget up-left (−π/4): 3π/4 anticlockwise is shorter than 5π/4 clockwise.
    const retargeted = { ...t, targetId: 10 };
    aim.update(frame({ towers: [retargeted], creeps, renderTick: 101 }));
    expect(aim.angleOf(1)).toBeCloseTo(PI / 2 - AIM_TURN_PER_TICK, 12);
    aim.update(frame({ towers: [retargeted], creeps, renderTick: 200 }));
    expect(aim.angleOf(1)).toBeCloseTo(-PI / 4, 12);
  });

  it('idles — holds its angle — with no target, and when its target is no longer drawn', () => {
    const aim = createAimTracker();
    const t = tower(1, 'antiair', { targetId: 9 });
    const creeps = new Map([[9, at(-1, 0)]]);
    aim.update(frame({ towers: [t], creeps, renderTick: 0 }));
    aim.update(frame({ towers: [t], creeps, renderTick: 50 }));
    expect(aim.angleOf(1)).toBeCloseTo(-PI / 2, 12);
    // Its target died: the sim still names it this tick, but it is not drawn.
    aim.update(frame({ towers: [t], creeps: new Map(), renderTick: 60 }));
    expect(aim.angleOf(1)).toBeCloseTo(-PI / 2, 12);
    // No lock at all.
    aim.update(frame({ towers: [{ ...t, targetId: 0 }], creeps, renderTick: 70 }));
    expect(aim.angleOf(1)).toBeCloseTo(-PI / 2, 12);
  });

  it('holds still while render time does — a paused game — and runs on it, not on frames', () => {
    const aim = createAimTracker();
    const t = tower(1, 'basic', { targetId: 9 });
    const creeps = new Map([[9, at(0, 1)]]); // straight down: a half turn
    aim.update(frame({ towers: [t], creeps, renderTick: 5 }));
    aim.update(frame({ towers: [t], creeps, renderTick: 6 }));
    const turned = aim.angleOf(1);
    for (let i = 0; i < 30; i++) aim.update(frame({ towers: [t], creeps, renderTick: 6 }));
    expect(aim.angleOf(1)).toBe(turned); // thirty frames, no time: no turn
    // Two frames a half tick apart turn it as far as one frame a whole tick on.
    const a = createAimTracker();
    const b = createAimTracker();
    for (const tr of [a, b]) tr.update(frame({ towers: [t], creeps, renderTick: 0 }));
    a.update(frame({ towers: [t], creeps, renderTick: 0.5 }));
    a.update(frame({ towers: [t], creeps, renderTick: 1 }));
    b.update(frame({ towers: [t], creeps, renderTick: 1 }));
    expect(a.angleOf(1)).toBeCloseTo(b.angleOf(1), 12);
  });

  it('never turns a head that does not aim — slow, splash, frost-splash, beacon, mine', () => {
    const aim = createAimTracker();
    const ids = ['slow', 'splash', 'frost-splash', 'beacon', 'mine'];
    const towers = ids.map((id, i) => tower(i + 1, id, { targetId: 9 }));
    const creeps = new Map([[9, at(1, 1)]]);
    aim.update(frame({ towers, creeps, renderTick: 0 }));
    aim.update(frame({ towers, creeps, renderTick: 50 }));
    expect(towers.map((t) => aim.angleOf(t.id))).toEqual([0, 0, 0, 0, 0]);
  });

  it('turns basic, venom, stun and antiair — and a tower the catalog has never heard of, which looks like basic', () => {
    const aim = createAimTracker();
    const ids = ['basic', 'venom', 'stun', 'antiair', 'no-such-tower'];
    const towers = ids.map((id, i) => tower(i + 1, id, { targetId: 9 }));
    const creeps = new Map([[9, at(1, 0)]]);
    aim.update(frame({ towers, creeps, renderTick: 0 }));
    aim.update(frame({ towers, creeps, renderTick: 50 }));
    for (const t of towers) expect(aim.angleOf(t.id), t.towerId).toBeCloseTo(PI / 2, 12);
  });

  it('holds a head facing a creep right on its centre (a flyer overhead) where it was', () => {
    const aim = createAimTracker();
    const t = tower(1, 'antiair', { targetId: 9 });
    aim.update(frame({ towers: [t], creeps: new Map([[9, at(1, 0)]]), renderTick: 0 }));
    aim.update(frame({ towers: [t], creeps: new Map([[9, at(1, 0)]]), renderTick: 50 }));
    aim.update(frame({ towers: [t], creeps: new Map([[9, { x: CX, y: CY }]]), renderTick: 51 }));
    expect(aim.angleOf(1)).toBeCloseTo(PI / 2, 12);
  });

  it('under Reduce motion holds every head at 0, and released, a head sweeps from 0', () => {
    const aim = createAimTracker();
    const t = tower(1, 'basic', { targetId: 9 });
    const creeps = new Map([[9, at(1, 0)]]);
    aim.update(frame({ towers: [t], creeps, renderTick: 0 }));
    aim.update(frame({ towers: [t], creeps, renderTick: 50 }));
    expect(aim.angleOf(1)).toBeCloseTo(PI / 2, 12);
    aim.update(frame({ towers: [t], creeps, renderTick: 51, reducedMotion: true }));
    expect(aim.angleOf(1)).toBe(0); // static, as drawn
    aim.update(frame({ towers: [t], creeps, renderTick: 80, reducedMotion: true }));
    expect(aim.angleOf(1)).toBe(0);
    aim.update(frame({ towers: [t], creeps, renderTick: 81 }));
    expect(aim.angleOf(1)).toBeCloseTo(AIM_TURN_PER_TICK, 12); // one tick's sweep from 0
  });

  it('forgets a tower that is gone: one built later starts pointing up', () => {
    const aim = createAimTracker();
    const t = tower(1, 'basic', { targetId: 9 });
    const creeps = new Map([[9, at(1, 0)]]);
    aim.update(frame({ towers: [t], creeps, renderTick: 0 }));
    aim.update(frame({ towers: [t], creeps, renderTick: 50 }));
    expect(aim.angleOf(1)).toBeCloseTo(PI / 2, 12);
    aim.update(frame({ towers: [], creeps, renderTick: 51 })); // sold
    expect(aim.angleOf(1)).toBe(0);
    aim.update(frame({ towers: [{ ...t, targetId: 0 }], creeps, renderTick: 52 }));
    expect(aim.angleOf(1)).toBe(0);
  });

  it('turns nothing on a frame whose render time runs backwards, and a reset starts every head over', () => {
    const aim = createAimTracker();
    const t = tower(1, 'basic', { targetId: 9 });
    const creeps = new Map([[9, at(1, 0)]]);
    aim.update(frame({ towers: [t], creeps, renderTick: 40 }));
    aim.update(frame({ towers: [t], creeps, renderTick: 41 }));
    const turned = aim.angleOf(1);
    aim.update(frame({ towers: [t], creeps, renderTick: 3 })); // a run the scene was not reset for
    expect(aim.angleOf(1)).toBe(turned);
    aim.reset();
    expect(aim.angleOf(1)).toBe(0);
    // After a reset the first frame has no time behind it, whatever the clock reads.
    aim.update(frame({ towers: [t], creeps, renderTick: 900 }));
    expect(aim.angleOf(1)).toBe(0);
  });
});
