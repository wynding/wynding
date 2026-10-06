// scorches.test.ts — the scorch a mine leaves where it went off (visual pass T4, #181):
// detecting a detonation from what the renderer is handed (a blast tracer whose origin is
// its destination; or, when a frame stepped past the whole flight, the blast's landing
// marked `detonation` by the controller), scorching each detonation ONCE, and the
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
const landing = (t: TowerVM): SparkPoint => ({
  ...centreOf(t),
  radiusFp: 2.5 * FP_ONE,
  detonation: true,
});

const frame = (over: Partial<ScorchFrame>): ScorchFrame => ({
  tracers: [],
  sparks: [],
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
    expect(t.live(9)).toEqual([]);
    // The mine fires at tick 10 — its row is consumed at the fire tick, so it is gone
    // from the towers the same frame its tracer appears.
    t.update(frame({ tracers: [detonation(m, 10)], renderTick: 10.2 }));
    expect(t.live(10.2)).toEqual([{ ...centreOf(m), alpha: 1 }]);
  });

  it('scorches nothing for any other shot — a targeted tracer, or a splash blast that leads its target', () => {
    // Every shot is a tracer; only a detonation (origin === destination) may scorch, or
    // every shot would leave an 80-tick scorch under the tower that fired it.
    const basic: TowerVM = { ...mine(4, 6, 2), towerId: 'basic' };
    const splash: TowerVM = { ...mine(8, 6, 3), towerId: 'splash' };
    const from = centreOf(basic);
    const at = centreOf(splash);
    const t = createScorchTracker();
    t.update(
      frame({
        tracers: [
          {
            kind: 'targeted',
            originX: from.x,
            originY: from.y,
            targetId: 7,
            launchTick: 10,
            impactTick: 12,
          },
          {
            kind: 'blast',
            originX: at.x,
            originY: at.y,
            destX: at.x + 3 * FP_ONE,
            destY: at.y,
            launchTick: 10,
            impactTick: 13,
          },
        ],
        renderTick: 10.5,
      }),
    );
    // ... and their landings, a targeted spark and a blast ring, with both towers standing.
    t.update(
      frame({
        sparks: [
          { x: from.x + FP_ONE, y: from.y, radiusFp: 0 },
          { x: at.x + 3 * FP_ONE, y: at.y, radiusFp: 1.5 * FP_ONE },
        ],
        renderTick: 13,
      }),
    );
    expect(t.live(13)).toEqual([]);
  });

  it('scorches a detonation ONCE when its tracer and its landing arrive in the frame the mine vanishes in', () => {
    // Both detection paths see this detonation at once — the tracer, and a blast landing on
    // the centre of a burst tower the last frame drew — and only the first may scorch: the
    // landing is the tracer's own, consumed rather than read as a second detonation.
    const m = mine(4, 6);
    const t = createScorchTracker();
    t.update(frame({ tracers: [detonation(m, 10)], sparks: [landing(m)], renderTick: 11 }));
    expect(t.live(11)).toHaveLength(1);
  });

  it('scorches each detonation ONCE — not again while its tracer stays listed, nor when it lands', () => {
    const m = mine(4, 6);
    const t = createScorchTracker();
    t.update(frame({ tracers: [detonation(m, 10)], renderTick: 10.2 }));
    t.update(frame({ tracers: [detonation(m, 10)], renderTick: 10.6 }));
    // The landing arrives once the flight ends, and the tracer is pruned.
    t.update(frame({ sparks: [landing(m)], renderTick: 11.1 }));
    expect(t.live(11.1)).toHaveLength(1);
  });

  it('scorches a detonation whose WHOLE flight fell between two frames, from its marked landing', () => {
    // A slow frame stepped past launch and impact: the tracer was never listed, and no
    // frame ever drew the mine (it was built and fired between two frames). Only the landing,
    // marked a detonation, remains.
    const m = mine(10, 2);
    const t = createScorchTracker();
    t.update(frame({ sparks: [landing(m)], renderTick: 22.4 }));
    expect(t.live(22.4)).toEqual([{ ...centreOf(m), alpha: 1 }]);
  });

  it('does not scorch a blast landing that is not marked a detonation, even on a mine’s centre', () => {
    // A splash blast landing exactly on a mine's footprint centre: not a detonation.
    const m = mine(10, 2);
    const t = createScorchTracker();
    t.update(frame({ sparks: [{ ...centreOf(m), radiusFp: 2.5 * FP_ONE }], renderTick: 21 }));
    t.update(
      frame({ sparks: [{ x: 3 * FP_ONE, y: 3 * FP_ONE, radiusFp: FP_ONE }], renderTick: 22 }),
    );
    expect(t.live(22)).toEqual([]);
  });

  it('ignores a targeted impact (radius 0) even if marked a detonation', () => {
    const m = mine(10, 2);
    const t = createScorchTracker();
    t.update(
      frame({ sparks: [{ ...centreOf(m), radiusFp: 0, detonation: true }], renderTick: 21 }),
    );
    expect(t.live(21)).toEqual([]);
  });

  it('scorches two mines that go off in one frame, each at its own centre', () => {
    const a = mine(4, 4, 1);
    const b = mine(12, 4, 2);
    const t = createScorchTracker();
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
    t.update(frame({ tracers: [detonation(m, 10)], renderTick: 10.2 }));
    t.update(frame({ renderTick: 10.4 }));
    t.update(frame({ tracers: [detonation(m, 11)], renderTick: 11.2 }));
    expect(t.live(11.2)).toHaveLength(2);
    t.update(frame({ sparks: [landing(m)], renderTick: 11.6 }));
    t.update(frame({ sparks: [landing(m)], renderTick: 12.1 }));
    expect(t.live(12.1)).toHaveLength(2);
    // Both owed landings were settled, the first of them out of two: so when the mine is
    // rebuilt and goes off seen only by its landing, that scorches a third time.
    t.update(frame({ sparks: [landing(m)], renderTick: 42.5 }));
    expect(t.live(42.5)).toHaveLength(3);
  });

  it('scorches a mine rebuilt on the same spot when it goes off again', () => {
    const m = mine(4, 6);
    const t = createScorchTracker();
    t.update(frame({ tracers: [detonation(m, 10)], renderTick: 10.2 }));
    t.update(frame({ sparks: [landing(m)], renderTick: 11.1 }));
    // Rebuilt, and fired again later — a NEW detonation (a later launch tick).
    t.update(frame({ tracers: [detonation(m, 41)], renderTick: 41.3 }));
    expect(t.live(41.3)).toHaveLength(2);
  });

  it('settles a landing once it has arrived — so the next mine on that spot is scorched from its landing alone', () => {
    // The first detonation is scorched from its tracer and its landing settles it. The mine
    // is rebuilt, and its next detonation's whole flight falls between two frames: only the
    // landing shows. Had the first landing stayed owed, this one would be taken for it.
    const m = mine(4, 6);
    const t = createScorchTracker();
    t.update(frame({ tracers: [detonation(m, 10)], renderTick: 10.2 }));
    t.update(frame({ sparks: [landing(m)], renderTick: 11.1 }));
    t.update(frame({ sparks: [landing(m)], renderTick: 42.5 }));
    expect(t.live(42.5)).toHaveLength(2);
  });
});

describe('createScorchTracker — lifetime', () => {
  const m = mine(4, 6);
  const born = (): ReturnType<typeof createScorchTracker> => {
    const t = createScorchTracker();
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
