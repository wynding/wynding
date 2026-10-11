// tracers.test.ts — where each shot in flight is (#32/P6): the render time a frame draws at, and
// each shot's lerped point, with the flight it lies on — its tower, where it is headed and how
// far along it is — which the shot plan draws it from (`shots.test.ts`, visual pass C2).

import { describe, it, expect } from 'vitest';
import { renderTimeOf, positionTracers } from './tracers';
import type { RenderVM, TracerVM } from './types';

function vm(tick: number): RenderVM {
  return { tick, phase: 'running', creeps: [], towers: [] };
}

function flight(overrides: Partial<Extract<TracerVM, { kind: 'targeted' }>> = {}): TracerVM {
  return {
    kind: 'targeted',
    originX: 0,
    originY: 0,
    targetId: 1,
    launchTick: 10,
    impactTick: 14,
    ...overrides,
  };
}

function blastFlight(overrides: Partial<Extract<TracerVM, { kind: 'blast' }>> = {}): TracerVM {
  return {
    kind: 'blast',
    originX: 0,
    originY: 0,
    destX: 400,
    destY: 0,
    launchTick: 10,
    impactTick: 14,
    ...overrides,
  };
}

describe('renderTimeOf', () => {
  it('origin frame: alpha 0 with a real prevVm is exactly prevVm.tick', () => {
    expect(renderTimeOf(vm(5), vm(6), 0)).toBe(5);
  });

  it('midpoint: alpha 0.5 lands halfway past prevVm.tick', () => {
    expect(renderTimeOf(vm(5), vm(6), 0.5)).toBe(5.5);
  });

  it('impact/full frame: alpha 1 lands exactly on curVm.tick when prev is one tick behind', () => {
    expect(renderTimeOf(vm(5), vm(6), 1)).toBe(6);
  });

  it('catch-up: a multi-tick jump still bases off prevVm.tick, not curVm.tick', () => {
    // prevVm is several ticks behind cur (a multi-step catch-up frame) — render time is
    // still prevVm.tick + alpha, never curVm.tick, so a tracer doesn't skip its first
    // frame of travel after a big jump.
    expect(renderTimeOf(vm(2), vm(9), 0.25)).toBe(2.25);
  });

  it('prevVm === null (the very first frame of a run) falls back to curVm.tick', () => {
    expect(renderTimeOf(null, vm(0), 0.7)).toBe(0.7);
  });

  it('clamps a malformed alpha to [0,1]', () => {
    expect(renderTimeOf(vm(3), vm(4), -5)).toBe(3);
    expect(renderTimeOf(vm(3), vm(4), 5)).toBe(4);
    expect(renderTimeOf(vm(3), vm(4), Number.NaN)).toBe(3);
  });
});

describe('positionTracers', () => {
  const targets = new Map([[1, { x: 400, y: 0 }]]);
  /** A targeted flight from the origin to (400, 0), positioned at `frac`. */
  const along = (f: TracerVM, x: number, y: number, frac: number) => ({
    x,
    y,
    fromX: 0,
    fromY: 0,
    toX: 400,
    toY: 0,
    frac,
    tracer: f,
  });

  it('at the origin fraction (renderTime === launchTick) sits exactly at the fp origin', () => {
    const f = flight();
    expect(positionTracers([f], targets, 10)).toEqual([along(f, 0, 0, 0)]);
  });

  it('at the midpoint fraction lerps halfway to the target', () => {
    const f = flight();
    expect(positionTracers([f], targets, 12)).toEqual([along(f, 200, 0, 0.5)]); // (12-10)/(14-10)
  });

  it('at the impact fraction (renderTime === impactTick) sits exactly at the target', () => {
    const f = flight();
    expect(positionTracers([f], targets, 14)).toEqual([along(f, 400, 0, 1)]);
  });

  it('an arrived shot sits EXACTLY on its aim point, even where the lerp’s arithmetic would land an ulp away', () => {
    // In floating point 0.7 + (0.1 − 0.7) × 1 is 0.09999999999999998, and 3 + (0.1 − 3) × 1 is
    // 0.10000000000000009: an arrived shot is placed on its target, not by the lerp.
    expect(0.7 + (0.1 - 0.7) * 1).not.toBe(0.1);
    expect(3 + (0.1 - 3) * 1).not.toBe(0.1);
    const odd = new Map([[1, { x: 0.1, y: 0.1 }]]);
    const f = flight({ originX: 0.7, originY: 3 });
    const [p] = positionTracers([f], odd, 14);
    expect([p!.x, p!.y]).toEqual([0.1, 0.1]);
    expect(p!.frac).toBe(1);
  });

  it('a catch-up renderTime past impactTick clamps to the target, never overshoots', () => {
    const f = flight();
    expect(positionTracers([f], targets, 50)).toEqual([along(f, 400, 0, 1)]);
  });

  it('drops a tracer whose target is no longer drawn (died/leaked mid-flight)', () => {
    const out = positionTracers([flight({ targetId: 999 })], targets, 12);
    expect(out).toEqual([]);
  });

  it('a degenerate zero-span flight (forged launch === impact) resolves to the target, not NaN', () => {
    const f = flight({ launchTick: 10, impactTick: 10 });
    expect(positionTracers([f], targets, 10)).toEqual([along(f, 400, 0, 1)]);
  });

  it('preserves order and independently positions multiple in-flight tracers, each with its own flight', () => {
    const twoTargets = new Map([
      [1, { x: 400, y: 0 }],
      [2, { x: 0, y: 400 }],
    ]);
    const a = flight({ targetId: 1 });
    const b = flight({ targetId: 2 });
    expect(positionTracers([a, b], twoTargets, 12)).toEqual([
      along(a, 200, 0, 0.5),
      { x: 0, y: 200, fromX: 0, fromY: 0, toX: 0, toY: 400, frac: 0.5, tracer: b },
    ]);
  });

  it('aims a targeted shot at its target’s point in the map it is given — where the creep is drawn — wherever that is this frame', () => {
    const f = flight();
    const moved = new Map([[1, { x: 400, y: -36.5 }]]); // a flyer's lifted body, say
    expect(positionTracers([f], moved, 12)).toEqual([
      { x: 200, y: -18.25, fromX: 0, fromY: 0, toX: 400, toY: -36.5, frac: 0.5, tracer: f },
    ]);
  });

  // M2-S4a step 12: a blast tracer's aim point is its OWN fixed `destX`/`destY`, never
  // `interpolatedTargets` — a blast lands at a fire-time predicted point whether or not
  // its original target survives the flight, so its tracer must fly there too.
  it('a blast tracer lerps toward its own fixed destX/destY, ignoring interpolatedTargets entirely', () => {
    const f = blastFlight();
    expect(positionTracers([f], targets, 12)).toEqual([along(f, 200, 0, 0.5)]);
  });

  it('a blast tracer is NEVER dropped, even with an empty interpolatedTargets map (the original target is long gone)', () => {
    const f = blastFlight();
    expect(positionTracers([f], new Map(), 12)).toEqual([along(f, 200, 0, 0.5)]);
  });

  it('a blast tracer at the impact fraction sits exactly at its destination', () => {
    const f = blastFlight();
    expect(positionTracers([f], new Map(), 14)).toEqual([along(f, 400, 0, 1)]);
  });
});
