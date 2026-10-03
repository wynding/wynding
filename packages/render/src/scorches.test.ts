// scorches.test.ts — the scorch a mine leaves where it went off (visual pass T4, #181):
// detecting a detonation from what the renderer is handed (a blast tracer whose origin is
// its destination; or, when a frame stepped past the whole flight, the blast's landing on
// the centre of a burst tower that just vanished), scorching each detonation ONCE, and the
// fade — linear over `SCORCH_TICKS` of render time, holding while time holds.

import { describe, it, expect } from 'vitest';
import { FP_ONE } from '@wynding/engine';
import { createScorchTracker, isDetonation, SCORCH_TICKS, type ScorchFrame } from './scorches';
import type { SparkPoint, TowerVM, TracerVM } from './types';

/** A mine anchored at (col, row): its footprint centre is the anchor's far corner. */
const mine = (col: number, row: number, id = 1): TowerVM => ({
  id,
  col,
  row,
  towerId: 'mine',
  support: false,
  buffed: false,
});
const centreOf = (t: TowerVM): { x: number; y: number } => ({
  x: (t.col + 1) * FP_ONE,
  y: (t.row + 1) * FP_ONE,
});

/** The tracer a mine's detonation shows: a blast from its centre to its centre. */
const detonation = (t: TowerVM, launchTick: number): TracerVM => {
  const { x, y } = centreOf(t);
  return {
    kind: 'blast',
    originX: x,
    originY: y,
    destX: x,
    destY: y,
    launchTick,
    impactTick: launchTick + 1,
  };
};

/** The landing of a blast at `t`'s centre, as `RenderOverlay.sparks` carries it. */
const landing = (t: TowerVM): SparkPoint => ({ ...centreOf(t), radiusFp: 2.5 * FP_ONE });

const frame = (over: Partial<ScorchFrame>): ScorchFrame => ({
  tracers: [],
  sparks: [],
  towers: [],
  renderTick: 0,
  ...over,
});

describe('isDetonation — a blast whose origin is its destination', () => {
  const m = mine(4, 4);

  it('is true for a mine’s blast, which detonates in place', () => {
    expect(isDetonation(detonation(m, 10))).toBe(true);
  });

  it('is false for a splash blast, which leads its target, and for any targeted shot', () => {
    const { x, y } = centreOf(m);
    expect(isDetonation({ ...detonation(m, 10), destX: x + 3 * FP_ONE } as TracerVM)).toBe(false);
    expect(isDetonation({ ...detonation(m, 10), destY: y + 1 } as TracerVM)).toBe(false);
    expect(
      isDetonation({
        kind: 'targeted',
        originX: x,
        originY: y,
        targetId: 7,
        launchTick: 10,
        impactTick: 12,
      }),
    ).toBe(false);
  });
});

describe('createScorchTracker — detection', () => {
  it('scorches a mine’s centre when its detonation tracer appears', () => {
    const m = mine(4, 6);
    const t = createScorchTracker();
    t.update(frame({ towers: [m], renderTick: 9 }));
    expect(t.live(9)).toEqual([]);
    // The mine fires at tick 10 — its row is consumed at the fire tick, so it is gone
    // from the towers the same frame its tracer appears.
    t.update(frame({ tracers: [detonation(m, 10)], renderTick: 10.2 }));
    expect(t.live(10.2)).toEqual([{ ...centreOf(m), alpha: 1 }]);
  });

  it('scorches each detonation ONCE — not again while its tracer stays listed, nor when it lands', () => {
    const m = mine(4, 6);
    const t = createScorchTracker();
    t.update(frame({ towers: [m], renderTick: 9 }));
    t.update(frame({ tracers: [detonation(m, 10)], renderTick: 10.2 }));
    t.update(frame({ tracers: [detonation(m, 10)], renderTick: 10.6 }));
    // The landing arrives once the flight ends, and the tracer is pruned.
    t.update(frame({ sparks: [landing(m)], renderTick: 11.1 }));
    expect(t.live(11.1)).toHaveLength(1);
  });

  it('scorches a detonation whose WHOLE flight fell between two frames, from its landing', () => {
    // A slow frame stepped past launch and impact: the tracer was never listed. The burst
    // tower the last frame drew is gone, and a blast landed on its centre.
    const m = mine(10, 2);
    const t = createScorchTracker();
    t.update(frame({ towers: [m], renderTick: 20 }));
    t.update(frame({ sparks: [landing(m)], renderTick: 22.4 }));
    expect(t.live(22.4)).toEqual([{ ...centreOf(m), alpha: 1 }]);
  });

  it('does not scorch a landing on a burst tower that is still there, or on a point no burst tower held', () => {
    const m = mine(10, 2);
    const other = mine(20, 2, 2);
    const t = createScorchTracker();
    t.update(frame({ towers: [m, other], renderTick: 20 }));
    // A splash blast landing exactly on a STILL-STANDING mine's centre: not a detonation.
    t.update(frame({ towers: [m, other], sparks: [landing(m)], renderTick: 21 }));
    // A sold mine (gone without a blast) leaves nothing; a blast elsewhere neither.
    t.update(
      frame({
        towers: [m],
        sparks: [{ x: 3 * FP_ONE, y: 3 * FP_ONE, radiusFp: FP_ONE }],
        renderTick: 22,
      }),
    );
    expect(t.live(22)).toEqual([]);
  });

  it('ignores a targeted impact (radius 0) even on a vanished mine’s centre', () => {
    const m = mine(10, 2);
    const t = createScorchTracker();
    t.update(frame({ towers: [m], renderTick: 20 }));
    t.update(frame({ sparks: [{ ...centreOf(m), radiusFp: 0 }], renderTick: 21 }));
    expect(t.live(21)).toEqual([]);
  });

  it('scorches two mines that go off in one frame, each at its own centre', () => {
    const a = mine(4, 4, 1);
    const b = mine(12, 4, 2);
    const t = createScorchTracker();
    t.update(frame({ towers: [a, b], renderTick: 5 }));
    t.update(frame({ tracers: [detonation(a, 6)], sparks: [landing(b)], renderTick: 7.5 }));
    expect(t.live(7.5).map((s) => [s.x, s.y])).toEqual([
      [centreOf(a).x, centreOf(a).y],
      [centreOf(b).x, centreOf(b).y],
    ]);
  });

  it('matches landings to detonations one for one, even two at one centre still in flight', () => {
    // A mine goes off, is rebuilt on the spot and goes off again before the first blast's
    // landing has been drained: two tracers seen, two landings owed — each landing settles
    // one, and neither scorches a third time.
    const m = mine(4, 6);
    const t = createScorchTracker();
    t.update(frame({ towers: [m], renderTick: 9 }));
    t.update(frame({ tracers: [detonation(m, 10)], renderTick: 10.2 }));
    t.update(frame({ towers: [m], renderTick: 10.4 }));
    t.update(frame({ tracers: [detonation(m, 11)], renderTick: 11.2 }));
    expect(t.live(11.2)).toHaveLength(2);
    t.update(frame({ sparks: [landing(m)], renderTick: 11.6 }));
    t.update(frame({ sparks: [landing(m)], renderTick: 12.1 }));
    expect(t.live(12.1)).toHaveLength(2);
  });

  it('scorches a mine rebuilt on the same spot when it goes off again', () => {
    const m = mine(4, 6);
    const t = createScorchTracker();
    t.update(frame({ towers: [m], renderTick: 9 }));
    t.update(frame({ tracers: [detonation(m, 10)], renderTick: 10.2 }));
    t.update(frame({ sparks: [landing(m)], renderTick: 11.1 }));
    // Rebuilt, and fired again later — a NEW detonation (a later launch tick).
    t.update(frame({ towers: [m], renderTick: 40 }));
    t.update(frame({ tracers: [detonation(m, 41)], renderTick: 41.3 }));
    expect(t.live(41.3)).toHaveLength(2);
  });
});

describe('createScorchTracker — lifetime', () => {
  const m = mine(4, 6);
  const born = (): ReturnType<typeof createScorchTracker> => {
    const t = createScorchTracker();
    t.update(frame({ towers: [m], renderTick: 99 }));
    t.update(frame({ tracers: [detonation(m, 100)], renderTick: 100 }));
    return t;
  };

  it('lasts about four seconds of game time: SCORCH_TICKS is 80 ticks at the 20 Hz tick', () => {
    expect(SCORCH_TICKS).toBe(80);
  });

  it('fades linearly from 1 to 0 over SCORCH_TICKS of render time, then is gone', () => {
    const t = born();
    expect(t.live(100)[0]!.alpha).toBe(1);
    expect(t.live(120)[0]!.alpha).toBeCloseTo(0.75, 9);
    expect(t.live(140)[0]!.alpha).toBeCloseTo(0.5, 9);
    expect(t.live(179.9)[0]!.alpha).toBeCloseTo(0.1 / 80, 9);
    expect(t.live(180)).toEqual([]);
    // Gone for good: a later frame does not bring it back.
    expect(t.live(150)).toEqual([]);
  });

  it('holds while render time holds — a paused game keeps its scorch as it is', () => {
    const t = born();
    for (let i = 0; i < 5; i++) expect(t.live(130)[0]!.alpha).toBeCloseTo(0.625, 9);
  });

  it('drops a scorch the time being drawn is earlier than — a time base that is gone', () => {
    const t = born();
    expect(t.live(3)).toEqual([]);
  });

  it('forgets everything on reset — a new run starts with a clean floor', () => {
    const t = born();
    t.reset();
    expect(t.live(100)).toEqual([]);
    // ...and what it had seen: the same tracer, still listed, scorches afresh.
    t.update(frame({ tracers: [detonation(m, 100)], renderTick: 100.5 }));
    expect(t.live(100.5)).toHaveLength(1);
  });
});
