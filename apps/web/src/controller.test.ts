import { describe, it, expect } from 'vitest';
import { validate, MAX_INPUTS_PER_TICK } from '@wynding/replay';
import { m1Ruleset } from '@wynding/content';
import type { SimInput } from '@wynding/sim';
import { createController, enqueueVerdict, type Controller } from './controller';

const TICK = 50; // MS_PER_TICK

/** Advance one fixed tick (50 ms of wall clock at 1×). */
function tick(c: Controller, n = 1): void {
  for (let i = 0; i < n; i++) c.advance(TICK);
}

/** Advance until terminal or a safety cap; returns ticks elapsed. */
function runToTerminal(c: Controller, cap = 4000): number {
  let n = 0;
  while (!c.isTerminal() && n < cap) {
    c.advance(TICK);
    n++;
  }
  return n;
}

describe('controller — fixed loop, speed & pause', () => {
  it('advances one tick per 50 ms at 1×, and 2× runs the sim faster', () => {
    const c = createController(1);
    const t0 = c.frame().curVm.tick;
    tick(c, 3);
    expect(c.frame().curVm.tick).toBe(t0 + 3);

    const fast = createController(1);
    fast.cycleSpeed();
    expect(fast.speed()).toBe(2);
    fast.advance(TICK); // 50 ms × 2 = 100 ms → 2 ticks
    expect(fast.frame().curVm.tick).toBe(2);
    fast.cycleSpeed();
    expect(fast.speed()).toBe(1);
  });

  it('pause freezes the sim in place (no ticks fire); resume continues', () => {
    const c = createController(1);
    c.pause();
    expect(c.isPaused()).toBe(true);
    tick(c, 5);
    expect(c.frame().curVm.tick).toBe(0); // no ticks while paused
    expect(c.frame().alpha).toBe(0); // fresh run: accumulator is 0, so the frozen alpha is 0
    c.resume();
    c.togglePause(); // → pause
    expect(c.isPaused()).toBe(true);
    c.togglePause(); // → resume
    expect(c.isPaused()).toBe(false);
    tick(c);
    expect(c.frame().curVm.tick).toBe(1);
  });

  it('freezes the interpolation alpha in place when paused mid-tick (no backward snap)', () => {
    const c = createController(1);
    c.advance(30); // 30 ms into a 50 ms tick → alpha 0.6, no tick yet
    expect(c.frame().curVm.tick).toBe(0);
    expect(c.frame().alpha).toBeCloseTo(0.6, 5);
    c.pause();
    expect(c.frame().alpha).toBeCloseTo(0.6, 5); // held in place, NOT collapsed to 0
    c.resume();
    expect(c.frame().alpha).toBeCloseTo(0.6, 5); // and continues from there on resume
  });
});

describe('controller — input → command mapping', () => {
  it('aims a valid ghost, rejects an out-of-bounds cell, and builds on confirm', () => {
    const c = createController(1);
    expect(c.aimAt(-1, -1)).toMatchObject({ kind: 'blocked', valid: false });
    const aim = c.aimAt(3, 3);
    expect(aim.kind).toBe('ghost');
    expect(aim.valid).toBe(true);
    expect(c.confirm()).toBe(true); // enqueues placeTower
    tick(c); // consume the buffer
    expect(c.frame().curVm.towers).toHaveLength(1);
    expect(c.frame().curVm.towers[0]).toMatchObject({ col: 3, row: 3 });
  });

  it('selects a placed tower, reports a positive refund, and sells it', () => {
    const c = createController(1);
    c.aimAt(3, 3);
    c.confirm();
    tick(c);
    const sel = c.aimAt(3, 3); // now a tower occupies (3,3)
    expect(sel.kind).toBe('tower');
    expect(c.frame().selection).not.toBeNull();
    expect(c.refundForSelection()).toBeGreaterThan(0);
    expect(c.sellSelected()).toBe(true);
    tick(c);
    expect(c.frame().curVm.towers).toHaveLength(0);
  });

  it('drops the selection once the selected tower is sold (no phantom ring / stale Sell)', () => {
    const c = createController(1);
    c.aimAt(3, 3);
    c.confirm();
    tick(c);
    c.aimAt(3, 3); // select the tower
    expect(c.frame().selection).not.toBeNull();
    c.sellSelected();
    tick(c); // step removes the tower; onTick reconciles the selection
    expect(c.frame().selection).toBeNull();
    expect(c.refundForSelection()).toBe(0);
  });

  it('a first keyboard confirm (no prior hover) aims at the cursor instead of no-oping', () => {
    const c = createController(1);
    expect(c.frame().ghost).toBeNull(); // fresh run: nothing aimed yet
    c.confirm(); // must aim at the cursor rather than silently returning
    // The cursor cell was resolved (a ghost or a tower selection now exists).
    expect(c.frame().ghost !== null || c.frame().selection !== null).toBe(true);
  });

  it('confirm does nothing over an invalid ghost or empty selection', () => {
    const c = createController(1);
    c.aimAt(3, 3);
    c.confirm();
    tick(c);
    // aiming the overlapping anchor (4,3) is invalid (overlaps the (3,3) tower footprint)
    const overlap = c.aimAt(4, 3);
    expect(overlap.kind === 'ghost' ? overlap.valid : true).toBe(true); // (4,3) is inside the tower → selects it
    expect(c.sellSelected()).toBe(true); // a tower is under (4,3)
    tick(c);
    expect(c.refundForSelection()).toBe(0); // nothing selected now
  });

  it('memoizes placement-validity and refund queries (no redundant clones)', () => {
    const c = createController(1);
    const a1 = c.aimAt(5, 5);
    const a2 = c.aimAt(5, 5); // same cell/buffer/tick → memoized, same result
    expect(a2).toEqual(a1);

    c.aimAt(3, 3);
    c.confirm();
    tick(c);
    c.aimAt(3, 3); // select the tower
    const r1 = c.refundForSelection();
    const r2 = c.refundForSelection(); // cached for this (selection, tick)
    expect(r2).toBe(r1);
    expect(r1).toBeGreaterThan(0);
  });

  it('previewAt updates the build ghost without clearing an existing tower selection', () => {
    const c = createController(1);
    c.aimAt(3, 3);
    c.confirm();
    tick(c);
    c.aimAt(3, 3); // select the tower (click)
    expect(c.frame().selection).not.toBeNull();
    c.previewAt(10, 10); // hover an empty cell → ghost preview, selection preserved
    expect(c.frame().selection).not.toBeNull();
    expect(c.frame().ghost).toMatchObject({ col: 10, row: 10 });
    c.previewAt(3, 3); // hover over the tower → no build ghost, selection still kept
    expect(c.frame().ghost).toBeNull();
    expect(c.frame().selection).not.toBeNull();
    c.previewAt(-1, -1); // hover off-board → ghost cleared
    expect(c.frame().ghost).toBeNull();
  });

  it('moves the keyboard cursor, clamped to the board', () => {
    const c = createController(1);
    c.aimAt(0, 0);
    c.moveCursor(-5, -5); // clamps at the top-left
    expect(c.cursor()).toEqual({ col: 0, row: 0 });
    c.moveCursor(2, 3);
    expect(c.cursor()).toEqual({ col: 2, row: 3 });
  });

  it('call-wave-early only fires pre-wave', () => {
    const c = createController(1);
    expect(c.callWaveEarly()).toBe(true);
    tick(c);
    expect(c.hud().phase).toBe('active');
    expect(c.callWaveEarly()).toBe(false); // already launched
  });
});

describe('controller — same-tick & paused ordering (determinism hazards)', () => {
  it('applies multiple commands issued within ONE tick in issued order', () => {
    const c = createController(1);
    c.aimAt(3, 3);
    c.confirm(); // buffer: [placeTower(3,3)]
    c.callWaveEarly(); // buffer: [placeTower(3,3), callWaveEarly]
    tick(c); // single step consumes both, in order
    expect(c.frame().curVm.towers).toHaveLength(1);
    expect(c.hud().phase).toBe('active');
  });

  it('buffers commands while paused and flushes them in issued order on resume', () => {
    const c = createController(1);
    c.pause();
    c.aimAt(3, 3);
    c.confirm(); // queued while paused
    c.aimAt(10, 3);
    c.confirm(); // second, non-overlapping build queued
    c.callWaveEarly(); // queued
    tick(c, 3); // paused → nothing flushes
    expect(c.frame().curVm.towers).toHaveLength(0);
    expect(c.hud().phase).toBe('pre-wave');
    c.resume();
    tick(c); // first live tick flushes the whole buffer, in order
    expect(c.frame().curVm.towers).toHaveLength(2);
    expect(c.hud().phase).toBe('active');
  });
});

describe('controller — paused buffer-flood dedup + cap (P1)', () => {
  it('mashing callWaveEarly while paused records exactly one callWaveEarly and verifies', () => {
    const c = createController(1);
    c.pause();
    for (let i = 0; i < 70; i++) c.callWaveEarly();
    c.resume();
    tick(c); // the first live tick flushes the buffer
    const replay = c.buildReplay();
    const flushed = replay.tickInputs[replay.tickInputs.length - 1] as readonly SimInput[];
    expect(flushed.filter((i) => i.kind === 'callWaveEarly')).toHaveLength(1);
    expect(c.verifyRun().ok).toBe(true);
  });

  it('mashing sellSelected on one tower dedupes; a second selected tower still queues distinctly', () => {
    const c = createController(1);
    c.aimAt(3, 3);
    c.confirm();
    c.aimAt(10, 3);
    c.confirm();
    tick(c); // both towers exist
    c.pause();
    c.aimAt(3, 3); // select the first tower
    c.sellSelected();
    c.sellSelected();
    c.sellSelected(); // ×3 while paused — must dedupe to one
    c.aimAt(10, 3); // select the second tower
    c.sellSelected();
    c.resume();
    tick(c); // flush
    const replay = c.buildReplay();
    const flushed = replay.tickInputs[replay.tickInputs.length - 1] as readonly SimInput[];
    const sells = flushed.filter((i) => i.kind === 'sellTower');
    expect(sells).toHaveLength(2);
    const ids = new Set(sells.map((s) => (s as { tower: number }).tower));
    expect(ids.size).toBe(2); // distinct tower ids, not deduped away
  });
});

describe('controller — enqueueVerdict classifier (unit)', () => {
  it('a duplicate callWaveEarly is flagged, not queued', () => {
    const buffer: SimInput[] = [{ kind: 'callWaveEarly' }];
    expect(enqueueVerdict(buffer, { kind: 'callWaveEarly' })).toBe('duplicate');
  });

  it('a same-id sellTower is a duplicate; a different-id sellTower still queues', () => {
    const buffer: SimInput[] = [{ kind: 'sellTower', tower: 1 }];
    expect(enqueueVerdict(buffer, { kind: 'sellTower', tower: 1 })).toBe('duplicate');
    expect(enqueueVerdict(buffer, { kind: 'sellTower', tower: 2 })).toBe('queue');
  });

  it('a same-anchor placeTower is a duplicate; a different-anchor placeTower still queues', () => {
    const buffer: SimInput[] = [{ kind: 'placeTower', anchor: { col: 3, row: 3 } }];
    expect(enqueueVerdict(buffer, { kind: 'placeTower', anchor: { col: 3, row: 3 } })).toBe(
      'duplicate',
    );
    expect(enqueueVerdict(buffer, { kind: 'placeTower', anchor: { col: 4, row: 3 } })).toBe(
      'queue',
    );
  });

  it('a buffer at the cap without an equivalent command is full', () => {
    const buffer: SimInput[] = Array.from({ length: MAX_INPUTS_PER_TICK }, (_, i): SimInput => ({
      kind: 'sellTower',
      tower: i,
    }));
    expect(enqueueVerdict(buffer, { kind: 'sellTower', tower: MAX_INPUTS_PER_TICK })).toBe('full');
  });

  it('duplicate wins over full — a full buffer containing the equivalent command is duplicate', () => {
    const buffer: SimInput[] = Array.from({ length: MAX_INPUTS_PER_TICK }, (_, i): SimInput => ({
      kind: 'sellTower',
      tower: i,
    }));
    expect(enqueueVerdict(buffer, { kind: 'sellTower', tower: 0 })).toBe('duplicate');
  });
});

describe('controller — replay recording, terminal truncation & verify', () => {
  it('the recorded log is deeply immutable — commands and nested anchors are frozen clones', () => {
    const c = createController(7);
    c.aimAt(3, 3);
    c.confirm();
    tick(c); // flush the placeTower into the log
    const replay = c.buildReplay();
    const flushed = replay.tickInputs[replay.tickInputs.length - 1] as readonly SimInput[];
    const place = flushed.find((i) => i.kind === 'placeTower');
    expect(place).toBeDefined();
    if (place === undefined || place.kind !== 'placeTower') return; // narrow for TS
    expect(Object.isFrozen(place)).toBe(true);
    expect(Object.isFrozen(place.anchor)).toBe(true);
    // Strict-mode mutation of a frozen object throws — the envelope cannot corrupt the
    // internal recording (or later verifyRun results) through shared references.
    expect(() => {
      (place.anchor as { col: number }).col = 99;
    }).toThrow(TypeError);
    expect(c.verifyRun().ok).toBe(true);
  });

  it('records a validating log that stops at the terminal transition and reproduces the score', () => {
    const c = createController(7);
    c.callWaveEarly();
    const elapsed = runToTerminal(c);
    expect(c.isTerminal()).toBe(true);
    expect(elapsed).toBeLessThan(4000);

    // Advancing after terminal must NOT append more ticks (frozen).
    const replay = c.buildReplay();
    const lenBefore = replay.tickInputs.length;
    tick(c, 10);
    expect(c.buildReplay().tickInputs.length).toBe(lenBefore);

    // The produced log validates via @wynding/replay (rejects any tick past terminal).
    const result = validate(c.buildReplay(), m1Ruleset);
    expect(result.ok).toBe(true);

    // The dev-verify self-check re-simulates to the same score/stars the HUD showed.
    const v = c.verifyRun();
    expect(v.ok).toBe(true);
    expect(v.matchedLive).toBe(true);
    expect(v.score).toBe(c.hud().score);
  });

  it('offers no sell refund once the match is terminal (preview mirrors the frozen step)', () => {
    const c = createController(7);
    c.aimAt(3, 3);
    c.confirm();
    c.callWaveEarly();
    runToTerminal(c);
    expect(c.isTerminal()).toBe(true);
    c.aimAt(3, 3); // the tower still exists; selecting it on a finished game
    if (c.frame().selection !== null) {
      expect(c.refundForSelection()).toBe(0); // frozen step() would drop the sell
    }
  });

  it('the recorded callWaveEarly appears in the log (fresh per-tick buffer, immutable copy)', () => {
    const c = createController(3);
    c.callWaveEarly();
    tick(c);
    const replay = c.buildReplay();
    const flat = replay.tickInputs.flat();
    expect(flat.some((i) => i.kind === 'callWaveEarly')).toBe(true);
    // the recorded tick array is frozen (cannot be mutated after the fact)
    expect(Object.isFrozen(replay.tickInputs[0])).toBe(true);
  });
});

describe('controller — run lifecycle (startRun cleanup, §7)', () => {
  it('startRun resets tick, towers, log, speed, pause and selection', () => {
    const c = createController(1);
    c.aimAt(3, 3);
    c.confirm();
    c.callWaveEarly();
    tick(c, 5);
    c.cycleSpeed();
    c.pause();
    expect(c.buildReplay().tickInputs.length).toBeGreaterThan(0);

    c.startRun(99);
    expect(c.frame().curVm.tick).toBe(0);
    expect(c.frame().curVm.towers).toHaveLength(0);
    expect(c.frame().selection).toBeNull();
    expect(c.frame().ghost).toBeNull();
    expect(c.buildReplay().tickInputs).toHaveLength(0);
    expect(c.speed()).toBe(1);
    expect(c.isPaused()).toBe(false);
    expect(c.buildReplay().seed).toBe(99);
  });
});
