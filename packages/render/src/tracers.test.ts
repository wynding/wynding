// tracers.test.ts — the two pure Tracer FX helpers (#32/P6), unit-tested independently
// so tracer drawing (and its reduced-motion a11y gate) is proven without Phaser.

import { describe, it, expect } from 'vitest';
import { renderTimeOf, positionTracers, tracerPaintOps } from './tracers';
import type { RenderVM, TracerVM } from './types';
import { resolvePalette } from './palette';

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

  it('at the origin fraction (renderTime === launchTick) sits exactly at the fp origin', () => {
    const [p] = positionTracers([flight()], targets, 10);
    expect(p).toEqual({ x: 0, y: 0 });
  });

  it('at the midpoint fraction lerps halfway to the target', () => {
    const [p] = positionTracers([flight()], targets, 12); // (12-10)/(14-10) = 0.5
    expect(p).toEqual({ x: 200, y: 0 });
  });

  it('at the impact fraction (renderTime === impactTick) sits exactly at the target', () => {
    const [p] = positionTracers([flight()], targets, 14);
    expect(p).toEqual({ x: 400, y: 0 });
  });

  it('a catch-up renderTime past impactTick clamps to the target, never overshoots', () => {
    const [p] = positionTracers([flight()], targets, 50);
    expect(p).toEqual({ x: 400, y: 0 });
  });

  it('drops a tracer whose target is no longer drawn (died/leaked mid-flight)', () => {
    const out = positionTracers([flight({ targetId: 999 })], targets, 12);
    expect(out).toEqual([]);
  });

  it('a degenerate zero-span flight (forged launch === impact) resolves to the target, not NaN', () => {
    const [p] = positionTracers([flight({ launchTick: 10, impactTick: 10 })], targets, 10);
    expect(p).toEqual({ x: 400, y: 0 });
  });

  it('preserves order and independently positions multiple in-flight tracers', () => {
    const twoTargets = new Map([
      [1, { x: 400, y: 0 }],
      [2, { x: 0, y: 400 }],
    ]);
    const out = positionTracers([flight({ targetId: 1 }), flight({ targetId: 2 })], twoTargets, 12);
    expect(out).toEqual([
      { x: 200, y: 0 },
      { x: 0, y: 200 },
    ]);
  });

  // M2-S4a step 12: a blast tracer's aim point is its OWN fixed `destX`/`destY`, never
  // `interpolatedTargets` — a blast lands at a fire-time predicted point whether or not
  // its original target survives the flight, so its tracer must fly there too.
  it('a blast tracer lerps toward its own fixed destX/destY, ignoring interpolatedTargets entirely', () => {
    const [p] = positionTracers([blastFlight()], targets, 12); // (12-10)/(14-10) = 0.5
    expect(p).toEqual({ x: 200, y: 0 });
  });

  it('a blast tracer is NEVER dropped, even with an empty interpolatedTargets map (the original target is long gone)', () => {
    const out = positionTracers([blastFlight()], new Map(), 12);
    expect(out).toEqual([{ x: 200, y: 0 }]);
  });

  it('a blast tracer at the impact fraction sits exactly at its destination', () => {
    const [p] = positionTracers([blastFlight()], new Map(), 14);
    expect(p).toEqual({ x: 400, y: 0 });
  });
});

describe('tracerPaintOps', () => {
  const pal = resolvePalette('default');

  it('emits one op per positioned tracer, in the tower cue colour', () => {
    const ops = tracerPaintOps(
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      false,
      pal,
    );
    expect(ops).toEqual([
      { x: 1, y: 2, colour: pal.tower },
      { x: 3, y: 4, colour: pal.tower },
    ]);
  });

  it('reduced motion omits tracers entirely — an empty plan', () => {
    expect(tracerPaintOps([{ x: 1, y: 2 }], true, pal)).toEqual([]);
  });

  it('an empty input yields an empty plan regardless of reduced motion', () => {
    expect(tracerPaintOps([], false, pal)).toEqual([]);
    expect(tracerPaintOps([], true, pal)).toEqual([]);
  });
});
