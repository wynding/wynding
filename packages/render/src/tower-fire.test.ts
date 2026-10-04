// tower-fire.test.ts — a tower's shots, as the board shows them (visual pass T3, #181): which
// tower fired (a tracer launched from its footprint centre, each shot once, a mine's
// detonation left to its scorch) and the shots handed back for their heads to turn, the
// recoil, flash and pulse curves on render time and the durations the checklist documents, a
// head's pose (and Reduce motion's gate on it), the paint plan — the muzzle flash at the tip
// of an aiming head, the ring pulse of one that does not aim, nothing under Reduce motion —
// and the flash rate a cadence gives at a game speed, with the least time four flashes take.

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
  shortestFourFlashMs,
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

/** Where creep 99, every `shot`'s target, is drawn: a frame draws it unless it says not. */
const DRAWN = new Map([[99, { x: 0, y: 0 }]]);
const NONE_DRAWN = new Map<number, { x: number; y: number }>();

const frame = (over: Partial<FireFrame>): FireFrame => ({
  tracers: [],
  towers: [],
  creeps: DRAWN,
  renderTick: 0,
  reducedMotion: false,
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

  it('shortestFourFlashMs: three cadences less the latest a shot still shows, sped up with the game', () => {
    // Antiair, every 15 ticks, at 2×: (45 − 4) ticks of 25 ms, 1025 ms. A tower firing every
    // 14 ticks averages under three flashes a second at 2× (2.86), and still fits four in 950 ms.
    expect(FIRE_FEEDBACK_TICKS).toBe(4);
    expect(shortestFourFlashMs(15, 2)).toBe(1025);
    expect(shortestFourFlashMs(15, 1)).toBe(2050);
    expect(shortestFourFlashMs(14, 2)).toBe(950);
    expect(flashesPerSecond(14, 2)).toBeLessThan(MAX_FLASHES_PER_SECOND);
  });
});

describe('the feedback lasts what docs/accessibility-checklist.md documents', () => {
  it('recoil eases home over 150 ms, a muzzle flash fades over 100 ms, a ring pulse over 200 ms', () => {
    expect(RECOIL_TICKS * MS_PER_TICK).toBe(150);
    expect(FLASH_TICKS * MS_PER_TICK).toBe(100);
    expect(PULSE_TICKS * MS_PER_TICK).toBe(200);
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

  it('hands back the shots first seen this frame, each with its tower and tracer, for the aim tracker to turn their heads', () => {
    const fire = createFireTracker();
    const mine = tower(3, 'mine', 10);
    const a = shot(basic, 10);
    const b = lob(slow, 10);
    expect(
      fire.update(
        frame({
          towers: [basic, slow, mine],
          tracers: [a, detonation(mine, 10), b],
          renderTick: 10.5,
        }),
      ),
    ).toEqual([
      { tower: basic, tracer: a },
      { tower: slow, tracer: b },
    ]);
    // Taken in already: none again, however long the tracers stay listed.
    expect(fire.update(frame({ towers: [basic, slow], tracers: [a, b], renderTick: 11 }))).toEqual(
      [],
    );
    // A shot from no tower's centre, or first seen too late to show, is handed back by no one.
    const offCentre: TracerVM = { ...shot(basic, 12), originX: centreOf(basic).x + 1 };
    expect(
      fire.update(frame({ towers: [basic, slow], tracers: [offCentre], renderTick: 12 })),
    ).toEqual([]);
    expect(
      fire.update(frame({ towers: [basic, slow], tracers: [shot(basic, 13)], renderTick: 17 })),
    ).toEqual([]);
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

  it('four of a tower’s flashes take no less than shortestFourFlashMs: the first seen as late as a shot still shows, the fourth the moment it launches', () => {
    const fire = createFireTracker();
    const cadence = 15;
    const late = FIRE_FEEDBACK_TICKS - 1 / 64; // the last moment a shot still shows
    const onsets: number[] = [];
    // How long after its launch each of four shots is first seen: frames that late are hitches.
    [late, 1, 2, 0].forEach((after, k) => {
      const launch = 100 + k * cadence;
      fire.update(
        frame({ towers: [basic], tracers: [shot(basic, launch)], renderTick: launch + after }),
      );
      if (fire.sinceFired(1) === 0) onsets.push(launch + after);
    });
    expect(onsets).toHaveLength(4);
    const spanMs = (onsets[3]! - onsets[0]!) * MS_PER_TICK;
    expect(spanMs).toBeGreaterThan(shortestFourFlashMs(cadence, 1));
    expect(spanMs - shortestFourFlashMs(cadence, 1)).toBeCloseTo(MS_PER_TICK / 64, 9);
    // Seen any later, the first would not show at all.
    const hitch = createFireTracker();
    hitch.update(
      frame({
        towers: [basic],
        tracers: [shot(basic, 100)],
        renderTick: 100 + FIRE_FEEDBACK_TICKS,
      }),
    );
    expect(hitch.sinceFired(1)).toBeNull();
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

  it('under Reduce motion takes a shot in without showing it: released inside its feedback, it still shows nothing', () => {
    const fire = createFireTracker();
    const flight = [shot(basic, 10)];
    expect(
      fire.update(frame({ towers: [basic], tracers: flight, renderTick: 10, reducedMotion: true })),
    ).toEqual([]);
    expect(fire.sinceFired(1)).toBeNull();
    // Released half a tick later, while the shot's recoil and flash would still be playing.
    expect(fire.update(frame({ towers: [basic], tracers: flight, renderTick: 10.5 }))).toEqual([]);
    expect(fire.sinceFired(1)).toBeNull();
  });

  it('under Reduce motion takes in every shot a frame first sees, the later launched too: none shows on release', () => {
    const fire = createFireTracker();
    const flight = [shot(basic, 10), shot(slow, 11)]; // first seen together, by a frame that caught up on two ticks
    expect(
      fire.update(
        frame({ towers: [basic, slow], tracers: flight, renderTick: 11, reducedMotion: true }),
      ),
    ).toEqual([]);
    expect(
      fire.update(frame({ towers: [basic, slow], tracers: flight, renderTick: 11.5 })),
    ).toEqual([]); // released inside both shots' feedback
    expect(fire.sinceFired(1)).toBeNull();
    expect(fire.sinceFired(2)).toBeNull();
  });

  it('Reduce motion switched on part-way through a shot forgets it: nothing stale shows on release', () => {
    const fire = createFireTracker();
    const flight = [shot(basic, 10)];
    fire.update(frame({ towers: [basic], tracers: flight, renderTick: 10 }));
    expect(fire.sinceFired(1)).toBe(0);
    fire.update(frame({ towers: [basic], tracers: flight, renderTick: 10.5, reducedMotion: true }));
    expect(fire.sinceFired(1)).toBeNull();
    // Released inside the shot's feedback: no recoil or flash along a head just reset to 0.
    fire.update(frame({ towers: [basic], tracers: flight, renderTick: 11 }));
    expect(fire.sinceFired(1)).toBeNull();
  });

  it('an aiming head’s shot at a creep no longer drawn shows nothing — no tracer, no flash, no recoil — while a pulse and a blast still show', () => {
    const fire = createFireTracker();
    const lost = shot(basic, 10); // at creep 99, not drawn when the shot is first seen
    expect(
      fire.update(
        frame({ towers: [basic, slow], tracers: [lost], creeps: NONE_DRAWN, renderTick: 10 }),
      ),
    ).toEqual([]);
    expect(fire.sinceFired(1)).toBeNull();
    // Taken in all the same: drawn again a frame later, the creep brings no late flash.
    expect(
      fire.update(frame({ towers: [basic, slow], tracers: [lost], renderTick: 10.5 })),
    ).toEqual([]);
    expect(fire.sinceFired(1)).toBeNull();
    // A head that does not aim pulses about its centre, whatever its shot was at.
    const pulse = shot(slow, 12);
    expect(
      fire.update(
        frame({ towers: [basic, slow], tracers: [pulse], creeps: NONE_DRAWN, renderTick: 12 }),
      ),
    ).toEqual([{ tower: slow, tracer: pulse }]);
    // And an aiming head's blast faces where it will land: no creep needs to be drawn.
    const blast = lob(basic, 13);
    expect(
      fire.update(
        frame({ towers: [basic, slow], tracers: [blast], creeps: NONE_DRAWN, renderTick: 13 }),
      ),
    ).toEqual([{ tower: basic, tracer: blast }]);
  });

  it('an aiming head’s shot at its own creep, no longer drawn, shows nothing though other creeps still are', () => {
    const fire = createFireTracker();
    const othersOnly = new Map([[98, { x: 0, y: 0 }]]); // creep 99 gone; creep 98 still drawn
    expect(
      fire.update(
        frame({ towers: [basic], tracers: [shot(basic, 10)], creeps: othersOnly, renderTick: 10 }),
      ),
    ).toEqual([]);
    expect(fire.sinceFired(1)).toBeNull();
  });

  it('a pause that catches a shot part-way holds it there: a repeated render time neither restarts it nor hands it back', () => {
    const fire = createFireTracker();
    const flight = [shot(basic, 10, 6)];
    expect(fire.update(frame({ towers: [basic], tracers: flight, renderTick: 10 }))).toHaveLength(
      1,
    );
    fire.update(frame({ towers: [basic], tracers: flight, renderTick: 11 }));
    for (let i = 0; i < 3; i++) {
      expect(fire.update(frame({ towers: [basic], tracers: flight, renderTick: 11 }))).toEqual([]);
      expect(fire.sinceFired(1)).toBe(1);
    }
  });

  it('render time running backwards starts over: the next run’s shots show, though launched no later than the last run’s', () => {
    const fire = createFireTracker();
    fire.update(frame({ towers: [basic], tracers: [shot(basic, 40)], renderTick: 40 }));
    const again = shot(basic, 7);
    expect(fire.update(frame({ towers: [basic], tracers: [again], renderTick: 7.5 }))).toEqual([
      { tower: basic, tracer: again },
    ]);
    expect(fire.sinceFired(1)).toBe(0);
  });

  it('tells apart two towers in one column: a shot is its own tower’s, matched on both axes', () => {
    const fire = createFireTracker();
    const upper = tower(1, 'basic', 2, 2);
    const lower = tower(2, 'basic', 2, 6);
    const s = shot(lower, 10);
    expect(fire.update(frame({ towers: [upper, lower], tracers: [s], renderTick: 10 }))).toEqual([
      { tower: lower, tracer: s },
    ]);
    expect(fire.sinceFired(1)).toBeNull();
    expect(fire.sinceFired(2)).toBe(0);
  });

  it('a shot first listed with no tower at its origin is still taken in: a tower built there while it flies did not fire it', () => {
    const fire = createFireTracker();
    const flight = [shot(basic, 10, 8)];
    expect(fire.update(frame({ towers: [], tracers: flight, renderTick: 10.5 }))).toEqual([]);
    const rebuilt = { ...basic, id: 5 };
    expect(fire.update(frame({ towers: [rebuilt], tracers: flight, renderTick: 11 }))).toEqual([]);
    expect(fire.sinceFired(5)).toBeNull();
  });

  it('forgets a tower sold inside its feedback, and keeps the one still standing', () => {
    const fire = createFireTracker();
    fire.update(
      frame({
        towers: [basic, slow],
        tracers: [shot(basic, 10), shot(slow, 10)],
        renderTick: 10,
      }),
    );
    fire.update(frame({ towers: [slow], renderTick: 10.5 }));
    expect(fire.sinceFired(1)).toBeNull();
    expect(fire.sinceFired(2)).toBe(0.5);
  });

  it('takes in the latest launch tick of a frame’s shots, whatever order they are listed in', () => {
    const fire = createFireTracker();
    const listed = [shot(basic, 12), shot(slow, 11, 6)];
    fire.update(frame({ towers: [basic, slow], tracers: listed, renderTick: 12.25 }));
    expect(fire.update(frame({ towers: [basic, slow], tracers: listed, renderTick: 13 }))).toEqual(
      [],
    );
    expect(fire.sinceFired(1)).toBe(0.75);
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

  it('flashes an aiming tower at its muzzle, just past its tip, in warm white, shrinking as it fades', () => {
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
    expect(half[0]!.r).toBeCloseTo(((MUZZLE_FLASH.r + MUZZLE_FLASH.fadeR) / 2) * unit, 12);
    expect(MUZZLE_FLASH.fadeR).toBeLessThan(MUZZLE_FLASH.r);
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
