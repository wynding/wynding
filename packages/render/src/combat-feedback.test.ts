// combat-feedback.test.ts — what the board shows when combat lands (visual pass C1, #181): which
// shot flashes which creep and when, the kills and the leak pulse the tracker keeps on the wall
// clock, the photosensitivity bounds on the hit flash and the leak pulse (ADR 0003, WCAG 2.3.1:
// no more than three flashes in any second), and what the kill burst, the bounty pop and the
// leak pulse look like at each moment, with and without Reduce motion.

import { describe, it, expect } from 'vitest';
import {
  BOUNTY_POP_HOLD,
  BOUNTY_POP_LIFT,
  BOUNTY_POP_MS,
  BOUNTY_POP_RISE,
  HIT_FLASH_ALPHA,
  HIT_FLASH_MS,
  KILL_BURST_MS,
  LEAK_PULSE_GAP_MS,
  LEAK_PULSE_MS,
  LEAK_PULSES,
  MIN_FLASH_GAP_MS,
  RING_GROWTH,
  SHARD_TRAVEL,
  bountyPopPlacements,
  createFeedbackTracker,
  hitFlashAlpha,
  killBurstStrokes,
  leakPulseStrokes,
  popAlpha,
  popChars,
  type FeedbackFrame,
  type FeedbackStroke,
} from './combat-feedback';
import { GEM_FRAME_KEY, atlasFrameSpecs, glyphFrameKey } from './art-frames';
import { ART_HIT_FLASH, ART_LIVES } from './art-ink';
import { CREEP_SIZE } from './creep-art';
import { snapToDevicePx } from './device-px';
import { fxUnit, KILL_BURST, LEAK_RINGS } from './effect-art';
import { creepColour, resolvePalette } from './palette';
import { MAX_FLASHES_PER_SECOND } from './tower-fire';
import type { KillVM, SparkPoint } from './types';

const PAL = resolvePalette('default');

/** A targeted impact on creep `targetId`, as the frame's drained points report it. */
const hit = (targetId: number): SparkPoint => ({ x: 0, y: 0, radiusFp: 0, targetId });

const kill = (opts: Partial<KillVM> = {}): KillVM => ({
  id: 7,
  x: 1000,
  y: 2000,
  creepId: 'normal',
  domain: 'ground',
  boss: false,
  bounty: 3,
  ...opts,
});

/** A frame for the tracker: nothing in it but what `opts` says. */
const frame = (opts: Partial<FeedbackFrame> = {}): FeedbackFrame => ({
  nowMs: 0,
  sparks: [],
  drawn: new Set<number>(),
  kills: [],
  leaks: 0,
  ...opts,
});

/** The most of `starts` (ms, ascending) that any one second holds — a CLOSED second, both ends
 *  counted, the stricter count: four starts a second apart end to end would be four. */
function mostInAnySecond(starts: readonly number[]): number {
  let most = 0;
  for (let i = 0; i < starts.length; i++) {
    let n = 0;
    for (
      let j = i;
      j < starts.length && (starts[j] as number) - (starts[i] as number) <= 1000;
      j++
    ) {
      n += 1;
    }
    most = Math.max(most, n);
  }
  return most;
}

describe('createFeedbackTracker — a hit flashes its creep', () => {
  it('flashes the creep a targeted impact struck in the frame that takes it in, fading over the flash’s span on the wall clock', () => {
    const fb = createFeedbackTracker();
    const drawn = new Set([7]);
    fb.update(frame({ nowMs: 1000, drawn }));
    expect(fb.flashOf(7)).toBe(0); // nothing has struck it
    fb.update(frame({ nowMs: 1100, sparks: [hit(7)], drawn })); // lands
    expect(fb.flashOf(7)).toBe(HIT_FLASH_ALPHA);
    fb.update(frame({ nowMs: 1140, drawn }));
    expect(fb.flashOf(7)).toBeCloseTo(HIT_FLASH_ALPHA / 2, 12);
    fb.update(frame({ nowMs: 1100 + HIT_FLASH_MS, drawn }));
    expect(fb.flashOf(7)).toBe(0); // over
    expect(fb.flashOf(8)).toBe(0); // never hit
  });

  it('flashes nothing for an impact whose creep is not drawn — its kill shows instead', () => {
    const fb = createFeedbackTracker();
    fb.update(frame({ nowMs: 50, sparks: [hit(7)], drawn: new Set() }));
    expect(fb.flashOf(7)).toBe(0);
    // Nor once the creep is drawn again: the impact has been taken in, and is forgotten.
    fb.update(frame({ nowMs: 60, drawn: new Set([7]) }));
    expect(fb.flashOf(7)).toBe(0);
  });

  it('flashes nothing for a blast — a lob or a mine lands on the ground, not on a creep', () => {
    const fb = createFeedbackTracker();
    const blast: SparkPoint = { x: 512, y: 512, radiusFp: 640, detonation: true };
    const drawn = new Set([0, 7]);
    fb.update(frame({ nowMs: 50, sparks: [blast, { x: 512, y: 512, radiusFp: 640 }], drawn }));
    expect(fb.flashOf(0)).toBe(0);
    expect(fb.flashOf(7)).toBe(0);
  });

  it('a frame drawn twice from the same overlay starts no second flash', () => {
    const fb = createFeedbackTracker();
    const drawn = new Set([7]);
    const sparks = [hit(7)];
    fb.update(frame({ nowMs: 400, sparks, drawn }));
    expect(fb.flashOf(7)).toBe(HIT_FLASH_ALPHA);
    // The same points again, a moment on (the scene draws the overlay it was handed twice): the
    // flash has begun once and plays on, not again.
    fb.update(frame({ nowMs: 440, sparks, drawn }));
    expect(fb.flashOf(7)).toBeCloseTo(HIT_FLASH_ALPHA / 2, 12);
    fb.update(frame({ nowMs: 400 + HIT_FLASH_MS, sparks, drawn }));
    expect(fb.flashOf(7)).toBe(0);
  });

  it('flashes once for several impacts on one creep in one frame', () => {
    const fb = createFeedbackTracker();
    const drawn = new Set([7]);
    fb.update(frame({ nowMs: 0, sparks: [hit(7), hit(7), hit(7)], drawn }));
    expect(fb.flashOf(7)).toBe(HIT_FLASH_ALPHA);
    fb.update(frame({ nowMs: 40, drawn }));
    expect(fb.flashOf(7)).toBeCloseTo(HIT_FLASH_ALPHA / 2, 12);
  });

  it('hitFlashAlpha: the flash’s opacity at its start, falling linearly to nothing over its span', () => {
    expect(hitFlashAlpha(0)).toBe(HIT_FLASH_ALPHA);
    expect(hitFlashAlpha(HIT_FLASH_MS / 4)).toBeCloseTo(HIT_FLASH_ALPHA * 0.75, 12);
    expect(hitFlashAlpha(HIT_FLASH_MS)).toBe(0);
    expect(hitFlashAlpha(-1)).toBe(0);
    expect(hitFlashAlpha(NaN)).toBe(0);
  });
});

describe('createFeedbackTracker — photosensitivity (ADR 0003, WCAG 2.3.1)', () => {
  it('no creep flashes more than three times in any second, though four towers hit it every tick', () => {
    expect(MAX_FLASHES_PER_SECOND).toBe(3);
    // The bound's arithmetic: four flashes' starts span three gaps, more than a second, so no
    // closed second holds four.
    expect(3 * MIN_FLASH_GAP_MS).toBeGreaterThan(1000);
    const fb = createFeedbackTracker();
    const drawn = new Set([7]);
    const starts: number[] = [];
    let landed = 0;
    // Five seconds at 60 frames a second, the sim at 20 ticks a second: every tick, four towers
    // each land a shot on one creep — 80 hits a second.
    for (let i = 0; i <= 300; i++) {
      const nowMs = (i * 1000) / 60;
      const sparks: SparkPoint[] = [];
      if (i % 3 === 0 && i > 0) {
        for (let tower = 0; tower < 4; tower++) sparks.push(hit(7));
        landed += 4;
      }
      fb.update(frame({ nowMs, sparks, drawn }));
      if (fb.flashOf(7) === HIT_FLASH_ALPHA) starts.push(nowMs);
    }
    expect(landed).toBeGreaterThan(50 * 4); // the hits are there to strobe with
    expect(starts.length).toBeGreaterThan(5); // and it does flash, as often as it may
    expect(mostInAnySecond(starts)).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(
        MIN_FLASH_GAP_MS,
      );
    }
  });

  it('bounds each creep on its own: two creeps hit together flash together', () => {
    const fb = createFeedbackTracker();
    const drawn = new Set([7, 8]);
    fb.update(frame({ nowMs: 50, sparks: [hit(7), hit(8)], drawn }));
    expect([fb.flashOf(7), fb.flashOf(8)]).toEqual([HIT_FLASH_ALPHA, HIT_FLASH_ALPHA]);
  });

  it('a hit inside the gap shows nothing new; the first after it flashes again', () => {
    const fb = createFeedbackTracker();
    const drawn = new Set([7]);
    fb.update(frame({ nowMs: 50, sparks: [hit(7)], drawn })); // flash at 50
    fb.update(frame({ nowMs: 100, sparks: [hit(7)], drawn }));
    fb.update(frame({ nowMs: 50 + MIN_FLASH_GAP_MS - 1, sparks: [hit(7)], drawn }));
    expect(fb.flashOf(7)).toBe(0); // inside the gap: the old flash is over, and no new one
    fb.update(frame({ nowMs: 50 + MIN_FLASH_GAP_MS, sparks: [hit(7)], drawn }));
    expect(fb.flashOf(7)).toBe(HIT_FLASH_ALPHA);
  });

  it('the exit pulses no more than three times in any second, though a creep leaks every frame', () => {
    // The bound's arithmetic: a pulse's two pulses, then nothing until a second from its start.
    expect(LEAK_PULSES).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
    expect(LEAK_PULSE_GAP_MS).toBeGreaterThanOrEqual(1000);
    expect(LEAK_PULSE_GAP_MS).toBeGreaterThanOrEqual(LEAK_PULSE_MS);
    const fb = createFeedbackTracker();
    const pulses: number[] = [];
    for (let i = 0; i <= 600; i++) {
      const nowMs = (i * 1000) / 60;
      fb.update(frame({ nowMs, leaks: 1 }));
      if (fb.pulseSinceMs() === 0) {
        // One pulse begins, and the rest of its pulses follow at their spacing.
        for (let p = 0; p < LEAK_PULSES; p++)
          pulses.push(nowMs + (p * LEAK_PULSE_MS) / LEAK_PULSES);
      }
    }
    expect(pulses.length).toBeGreaterThan(LEAK_PULSES * 5); // it does pulse, as often as it may
    expect(mostInAnySecond(pulses)).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
  });
});

describe('createFeedbackTracker — kills and leaks', () => {
  it('keeps each kill on the wall clock, oldest first, until its burst and pop have both played out', () => {
    const fb = createFeedbackTracker();
    const a = kill({ id: 1 });
    const b = kill({ id: 2 });
    fb.update(frame({ nowMs: 1000, kills: [a] }));
    expect(fb.kills()).toEqual([{ kill: a, sinceMs: 0 }]);
    fb.update(frame({ nowMs: 1300, kills: [b] }));
    expect(fb.kills()).toEqual([
      { kill: a, sinceMs: 300 },
      { kill: b, sinceMs: 0 },
    ]);
    // The pop outlasts the burst: a kill is kept for the pop's whole life.
    expect(BOUNTY_POP_MS).toBeGreaterThan(KILL_BURST_MS);
    fb.update(frame({ nowMs: 1000 + BOUNTY_POP_MS - 1 }));
    expect(fb.kills().map((k) => k.kill.id)).toEqual([1, 2]);
    fb.update(frame({ nowMs: 1000 + BOUNTY_POP_MS }));
    expect(fb.kills().map((k) => k.kill.id)).toEqual([2]);
    fb.update(frame({ nowMs: 1300 + BOUNTY_POP_MS }));
    expect(fb.kills()).toEqual([]);
  });

  it('a pause lets a kill play out: its clock is the wall clock, not render time', () => {
    const fb = createFeedbackTracker();
    fb.update(frame({ nowMs: 0, kills: [kill()] }));
    fb.update(frame({ nowMs: BOUNTY_POP_MS })); // paused
    expect(fb.kills()).toEqual([]);
  });

  it('pulses the exit on a leak, for the pulse’s span — and a leak inside its gap does not begin another', () => {
    const fb = createFeedbackTracker();
    fb.update(frame({ nowMs: 0 }));
    expect(fb.pulseSinceMs()).toBeNull();
    fb.update(frame({ nowMs: 100, leaks: 2 }));
    expect(fb.pulseSinceMs()).toBe(0);
    fb.update(frame({ nowMs: 400, leaks: 1 })); // inside the gap: the pulse plays on
    expect(fb.pulseSinceMs()).toBe(300);
    fb.update(frame({ nowMs: 100 + LEAK_PULSE_MS }));
    expect(fb.pulseSinceMs()).toBeNull(); // played out
    fb.update(frame({ nowMs: 100 + LEAK_PULSE_GAP_MS - 1, leaks: 1 }));
    expect(fb.pulseSinceMs()).toBeNull(); // still inside the gap: nothing
    fb.update(frame({ nowMs: 100 + LEAK_PULSE_GAP_MS, leaks: 1 }));
    expect(fb.pulseSinceMs()).toBe(0); // a second on: another
  });

  it('reset forgets everything: no flash, no kill, no pulse', () => {
    const fb = createFeedbackTracker();
    const drawn = new Set([7]);
    fb.update(frame({ nowMs: 50, sparks: [hit(7)], drawn, kills: [kill()], leaks: 1 }));
    expect(fb.flashOf(7)).toBe(HIT_FLASH_ALPHA);
    fb.reset();
    expect(fb.flashOf(7)).toBe(0);
    expect(fb.kills()).toEqual([]);
    expect(fb.pulseSinceMs()).toBeNull();
    // The new run's first hit flashes at once, though the clock starts over: no gap carries on.
    fb.update(frame({ nowMs: 0, sparks: [hit(7)], drawn }));
    expect(fb.flashOf(7)).toBe(HIT_FLASH_ALPHA);
  });
});

// ---- What each looks like ----

const rings = (s: readonly FeedbackStroke[]) => s.filter((x) => x.kind === 'ring');
const shards = (s: readonly FeedbackStroke[]) => s.filter((x) => x.kind === 'shard');

describe('killBurstStrokes — a kill’s burst', () => {
  const at = { x: 200, y: 100 };
  const cellPx = 30; // the frame's own cell: design units are pixels

  it('at the kill: a white ring and seven shards in the creep’s family hue, at the frame’s radii', () => {
    const s = killBurstStrokes(kill({ creepId: 'fast' }), at, 0, false, PAL, cellPx);
    const u = fxUnit(cellPx) * CREEP_SIZE.fast;
    expect(rings(s)).toEqual([
      {
        kind: 'ring',
        x: at.x,
        y: at.y,
        r: KILL_BURST.ring.r * u,
        width: KILL_BURST.ring.width * u,
        colour: ART_HIT_FLASH,
        alpha: KILL_BURST.ring.alpha,
      },
    ]);
    const out = shards(s);
    expect(out).toHaveLength(KILL_BURST.shards.count);
    for (const shard of out) {
      if (shard.kind !== 'shard') throw new Error('a shard');
      expect(shard.colour).toBe(creepColour(PAL, 'fast'));
      expect(shard.alpha).toBe(1);
      expect(Math.hypot(shard.x1 - at.x, shard.y1 - at.y)).toBeCloseTo(KILL_BURST.shards.r0 * u, 9);
      expect(Math.hypot(shard.x2 - at.x, shard.y2 - at.y)).toBeCloseTo(KILL_BURST.shards.r1 * u, 9);
    }
  });

  it('flies the shards out and swells the ring as both fade, and is gone at the burst’s end', () => {
    const half = killBurstStrokes(kill(), at, KILL_BURST_MS / 2, false, PAL, cellPx);
    const u = fxUnit(cellPx);
    const [ring] = rings(half);
    expect(ring!.kind === 'ring' && ring!.r).toBeCloseTo(
      KILL_BURST.ring.r * u * (1 + RING_GROWTH / 2),
      9,
    );
    expect(ring!.alpha).toBeCloseTo(KILL_BURST.ring.alpha / 2, 9);
    const [shard] = shards(half);
    if (shard?.kind !== 'shard') throw new Error('a shard');
    expect(Math.hypot(shard.x1 - at.x, shard.y1 - at.y)).toBeCloseTo(
      (KILL_BURST.shards.r0 + SHARD_TRAVEL / 2) * u,
      9,
    );
    expect(shard.alpha).toBeCloseTo(0.5, 9);
    expect(killBurstStrokes(kill(), at, KILL_BURST_MS, false, PAL, cellPx)).toEqual([]);
    expect(killBurstStrokes(kill(), at, -1, false, PAL, cellPx)).toEqual([]);
  });

  it('sizes the burst by the family’s size step: a boss’s is the largest, a swarm’s the smallest', () => {
    const r = (creepId: string, boss = false): number => {
      const [ring] = killBurstStrokes(kill({ creepId, boss }), at, 0, false, PAL, cellPx);
      return ring!.kind === 'ring' ? ring!.r : NaN;
    };
    expect(r('swarm')).toBeLessThan(r('normal'));
    expect(r('normal')).toBeLessThan(r('armored'));
    expect(r('armored')).toBeLessThan(r('normal', true));
  });

  it('under Reduce motion: the ring alone, at its own size, fading in place — no shard flies', () => {
    const u = fxUnit(cellPx);
    for (const since of [0, KILL_BURST_MS / 4, KILL_BURST_MS / 2, (KILL_BURST_MS * 3) / 4]) {
      const s = killBurstStrokes(kill(), at, since, true, PAL, cellPx);
      expect(shards(s)).toEqual([]);
      const [ring] = rings(s);
      expect(ring!.kind === 'ring' && ring!.r).toBe(KILL_BURST.ring.r * u); // never swells
      expect(ring!.alpha).toBeCloseTo(KILL_BURST.ring.alpha * (1 - since / KILL_BURST_MS), 9);
    }
    expect(killBurstStrokes(kill(), at, KILL_BURST_MS, true, PAL, cellPx)).toEqual([]);
  });

  it('never strokes thinner than a pixel at a phone’s cell', () => {
    for (const s of killBurstStrokes(kill({ creepId: 'swarm' }), at, 0, false, PAL, 10)) {
      expect(s.width).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('bountyPopPlacements — a kill’s "+N"', () => {
  const cellPx = 30;
  const frames = new Map(atlasFrameSpecs(cellPx, 1).map((f) => [f.key, f]));
  const at = { x: 300, y: 200 };

  it('shows the gem, a plus and the bounty’s digits, left to right in a row centred over the kill', () => {
    const p = bountyPopPlacements(12, at, 0, false, cellPx, 1, frames);
    expect(p.map((s) => s.frame)).toEqual([
      GEM_FRAME_KEY,
      glyphFrameKey('+'),
      glyphFrameKey('1'),
      glyphFrameKey('2'),
    ]);
    // Left to right, all on one row: their centres at one height.
    const centres = p.map((s) => ({
      x: s.x + frames.get(s.frame)!.anchorX,
      y: s.y + frames.get(s.frame)!.anchorY,
    }));
    for (let i = 1; i < centres.length; i++) {
      expect(centres[i]!.x).toBeGreaterThan(centres[i - 1]!.x);
      expect(centres[i]!.y).toBe(centres[0]!.y);
    }
    // Centred on the kill, give or take the snap, and the pop's lift above it.
    const left = p[0]!.x;
    const last = p.at(-1)!;
    const right = last.x + frames.get(last.frame)!.width;
    expect(Math.abs((left + right) / 2 - at.x)).toBeLessThan(cellPx / 4);
    expect(centres[0]!.y).toBe(snapToDevicePx(at.y - BOUNTY_POP_LIFT * fxUnit(cellPx), 1));
    for (const s of p) expect(s.alpha).toBe(1);
  });

  it('rises as it fades — easing out — and is gone at its end', () => {
    const y = (since: number): number =>
      bountyPopPlacements(5, at, since, false, cellPx, 1, frames)[0]!.y;
    const start = y(0);
    expect(y(BOUNTY_POP_MS / 2)).toBeLessThan(start);
    expect(y(BOUNTY_POP_MS - 1)).toBeLessThan(y(BOUNTY_POP_MS / 2));
    // Its whole rise, near its end, give or take the snap.
    expect(start - y(BOUNTY_POP_MS - 1)).toBeCloseTo(BOUNTY_POP_RISE * fxUnit(cellPx), 0);
    // Faster at first: more of the rise is in the first half than the second.
    expect(start - y(BOUNTY_POP_MS / 2)).toBeGreaterThan(
      y(BOUNTY_POP_MS / 2) - y(BOUNTY_POP_MS - 1),
    );
    const late = bountyPopPlacements(5, at, BOUNTY_POP_MS * 0.85, false, cellPx, 1, frames);
    expect(late[0]!.alpha).toBeCloseTo(popAlpha(BOUNTY_POP_MS * 0.85), 12);
    expect(bountyPopPlacements(5, at, BOUNTY_POP_MS, false, cellPx, 1, frames)).toEqual([]);
  });

  it('under Reduce motion fades where it appears, without rising', () => {
    const ys = [0, BOUNTY_POP_MS / 2, BOUNTY_POP_MS - 1].map(
      (since) => bountyPopPlacements(5, at, since, true, cellPx, 1, frames)[0]!.y,
    );
    expect(new Set(ys).size).toBe(1);
    expect(bountyPopPlacements(5, at, BOUNTY_POP_MS - 1, true, cellPx, 1, frames)[0]!.alpha).toBe(
      popAlpha(BOUNTY_POP_MS - 1),
    );
  });

  it('sits every sprite on whole device pixels, so the numerals stay crisp as they rise', () => {
    for (const dpr of [1, 1.5, 2]) {
      const fr = new Map(atlasFrameSpecs(cellPx, dpr).map((f) => [f.key, f]));
      for (const since of [0, 123, 456]) {
        for (const s of bountyPopPlacements(
          47,
          { x: 300.3, y: 200.7 },
          since,
          false,
          cellPx,
          dpr,
          fr,
        )) {
          const a = fr.get(s.frame)!;
          expect((s.x + a.anchorX) * dpr).toBeCloseTo(Math.round((s.x + a.anchorX) * dpr), 9);
          expect((s.y + a.anchorY) * dpr).toBeCloseTo(Math.round((s.y + a.anchorY) * dpr), 9);
        }
      }
    }
  });

  it('keeps every sprite of the row on the canvas over a kill at its top edge, the row still level', () => {
    for (const dpr of [1, 1.5]) {
      const fr = new Map(atlasFrameSpecs(cellPx, dpr).map((f) => [f.key, f]));
      for (const since of [0, BOUNTY_POP_MS / 2]) {
        const p = bountyPopPlacements(19, { x: 300, y: 2 }, since, false, cellPx, dpr, fr);
        expect(p).toHaveLength(4);
        for (const s of p) expect(s.y, `${dpr} ${since}`).toBeGreaterThanOrEqual(0);
        const centres = new Set(p.map((s) => (s.y + fr.get(s.frame)!.anchorY).toFixed(9)));
        expect(centres.size).toBe(1);
        // As high as it can be: one sprite's top is on the edge.
        expect(Math.min(...p.map((s) => s.y))).toBeCloseTo(0, 9);
      }
    }
  });

  it('shows no pop for a kill that paid nothing', () => {
    expect(bountyPopPlacements(0, at, 0, false, cellPx, 1, frames)).toEqual([]);
    expect(bountyPopPlacements(NaN, at, 0, false, cellPx, 1, frames)).toEqual([]);
  });

  it('throws on a glyph the atlas does not have, rather than drawing nothing silently', () => {
    expect(() => bountyPopPlacements(5, at, 0, false, cellPx, 1, new Map())).toThrow(/no frame/);
  });

  it('popChars: a plus, then the digits; popAlpha: full for its hold, then falling to nothing', () => {
    expect(popChars(7)).toEqual(['+', '7']);
    expect(popChars(120)).toEqual(['+', '1', '2', '0']);
    expect(popAlpha(0)).toBe(1);
    expect(popAlpha(BOUNTY_POP_MS * BOUNTY_POP_HOLD * 0.99)).toBe(1);
    expect(popAlpha((BOUNTY_POP_MS * (1 + BOUNTY_POP_HOLD)) / 2)).toBeCloseTo(0.5, 9);
    expect(popAlpha(BOUNTY_POP_MS)).toBe(0);
    expect(popAlpha(-1)).toBe(0);
  });
});

describe('leakPulseStrokes — the exit’s pulse on a leak', () => {
  const at = { x: 500, y: 300 };
  const cellPx = 30;
  const u = fxUnit(cellPx);
  const each = LEAK_PULSE_MS / LEAK_PULSES;

  it('draws the frame’s two rings in the lives colour about the exit’s centre', () => {
    expect(leakPulseStrokes(at, 0, false, cellPx)).toEqual(
      LEAK_RINGS.map((ring) => ({
        kind: 'ring',
        x: at.x,
        y: at.y,
        r: ring.r * u,
        width: ring.width * u,
        colour: ART_LIVES,
        alpha: ring.alpha,
      })),
    );
  });

  it('plays its pulses one after another, each swelling its rings as they fade, and is gone at its end', () => {
    const mid = leakPulseStrokes(at, each / 2, false, cellPx);
    expect(mid[0]!.alpha).toBeCloseTo(LEAK_RINGS[0].alpha / 2, 9);
    expect(mid[0]!.kind === 'ring' && mid[0]!.r).toBeGreaterThan(LEAK_RINGS[0].r * u);
    // The second pulse begins as the first ends: full and at its own size again.
    expect(leakPulseStrokes(at, each, false, cellPx)).toEqual(
      leakPulseStrokes(at, 0, false, cellPx),
    );
    expect(leakPulseStrokes(at, LEAK_PULSE_MS, false, cellPx)).toEqual([]);
    expect(leakPulseStrokes(at, -1, false, cellPx)).toEqual([]);
  });

  it('under Reduce motion: one fade of the rings at their own size, over the whole pulse', () => {
    for (const since of [0, each / 2, each, LEAK_PULSE_MS - 1]) {
      const s = leakPulseStrokes(at, since, true, cellPx);
      s.forEach((ring, i) => {
        expect(ring.kind === 'ring' && ring.r).toBe(LEAK_RINGS[i]!.r * u);
        expect(ring.alpha).toBeCloseTo(LEAK_RINGS[i]!.alpha * (1 - since / LEAK_PULSE_MS), 9);
      });
    }
  });
});
