import { describe, it, expect } from 'vitest';
import { validate, MAX_INPUTS_PER_TICK } from '@wynding/replay';
import { m1Ruleset } from '@wynding/content';
import type { SimInput } from '@wynding/sim';
import { createController, enqueueVerdict, outcomesMatch, type Controller } from './controller';

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

  it('confirm over an invalid ghost is a no-op (#47)', () => {
    const c = createController(1);
    c.aimAt(3, 3);
    c.confirm();
    tick(c); // the (3,3) tower is committed
    // (2,2) is itself empty — towerAt(2,2) is null, so this resolves to a GHOST — but its
    // footprint (cols 2-3, rows 2-3) overlaps the committed tower's cell (3,3), so it must
    // be invalid.
    const aim = c.aimAt(2, 2);
    expect(aim).toEqual({ kind: 'ghost', col: 2, row: 2, valid: false });
    expect(c.confirm()).toBe(false);
    tick(c); // pending commands are invisible pre-tick — this is the real proof
    expect(c.frame().curVm.towers).toHaveLength(1); // still just the one committed tower
  });

  it('sellSelected() and refundForSelection() are no-ops with no selection', () => {
    const c = createController(1);
    expect(c.sellSelected()).toBe(false);
    expect(c.refundForSelection()).toBe(0);
  });

  it('confirm() re-queries ghost validity at the CURRENT tick — a stale-valid cell a creep has since occupied is rejected, not built (#40)', () => {
    const c = createController(1);
    c.callWaveEarly();
    tick(c, 14); // the wave-early creep has not yet reached (2,11)
    const aim = c.aimAt(2, 11);
    expect(aim).toMatchObject({ kind: 'ghost', valid: true }); // valid one tick before it arrives
    tick(c); // advance WITHOUT re-aiming — the creep now occupies (2,11); `ghost` is stale
    expect(c.confirm()).toBe(false); // must re-derive at the current tick, not trust the cache
    tick(c);
    expect(c.frame().curVm.towers).toHaveLength(0); // never actually built
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

describe('controller — pending-aware paused-planning presentation (#37+#27)', () => {
  it('a build accepted while paused surfaces a pending tower without committing it; presented bounty reflects the spend', () => {
    const c = createController(1);
    c.pause();
    const bountyBefore = c.hud().bounty;
    c.aimAt(3, 3);
    expect(c.confirm()).toBe(true);
    const f = c.frame();
    expect(f.pendingAdds).toEqual([{ col: 3, row: 3 }]);
    expect(f.curVm.towers).toHaveLength(0); // not committed — pending only
    expect(c.hud().bounty).toBeLessThan(bountyBefore); // presented spend, not the stale figure
  });

  it("confirm()'s post-queue re-aim on the pending-build cell selects, not an invalid ghost", () => {
    const c = createController(1);
    c.pause();
    c.aimAt(3, 3);
    c.confirm();
    const aim = c.aimAt(3, 3);
    expect(aim.kind).toBe('tower');
    expect(aim.valid).toBe(true);
  });

  it('a pending build clears (and commits) after resuming for one tick', () => {
    const c = createController(1);
    c.pause();
    c.aimAt(3, 3);
    c.confirm();
    expect(c.frame().pendingAdds).toHaveLength(1);
    c.resume();
    tick(c);
    expect(c.frame().pendingAdds).toHaveLength(0);
    expect(c.frame().curVm.towers).toHaveLength(1);
    expect(c.frame().curVm.towers[0]).toMatchObject({ col: 3, row: 3 });
  });

  it('sell-then-rebuild works from EACH of the four footprint cells (sold anchor re-aims buildable)', () => {
    const footprint: ReadonlyArray<[number, number]> = [
      [3, 3],
      [4, 3],
      [3, 4],
      [4, 4],
    ];
    for (const [col, row] of footprint) {
      const c = createController(1);
      c.aimAt(3, 3);
      c.confirm();
      tick(c); // commit the build
      expect(c.frame().curVm.towers).toHaveLength(1);

      c.pause();
      const aim = c.aimAt(col, row); // select via one of the four footprint cells
      expect(aim.kind).toBe('tower');
      expect(c.sellSelected()).toBe(true);
      expect(c.frame().pendingSells).toEqual([{ col: 3, row: 3 }]);
      // sellSelected() re-aims at the sold anchor — now resolves as a buildable ghost.
      expect(c.frame().ghost).toMatchObject({ col: 3, row: 3, valid: true });
      expect(c.confirm()).toBe(true); // rebuild at the same anchor
      expect(c.frame().pendingAdds).toEqual([{ col: 3, row: 3 }]);
    }
  });

  it('a pending sell hides the committed tower immediately (presentation, not just "about to sell")', () => {
    const c = createController(1);
    c.aimAt(3, 3);
    c.confirm();
    tick(c);
    expect(c.frame().curVm.towers).toHaveLength(1);

    c.pause();
    c.aimAt(3, 3);
    c.sellSelected();
    const f = c.frame();
    expect(f.pendingSells).toEqual([{ col: 3, row: 3 }]);
    // curVm.towers (committed) still lists it — the SCENE hides it via pendingSells, not
    // by the committed view-model itself. The presentation authority is `pendingSells`.
    expect(f.curVm.towers).toHaveLength(1);
  });

  it('duplicate/no-op queued commands create no false pending visuals', () => {
    const c = createController(1);
    c.aimAt(3, 3);
    c.confirm();
    tick(c); // commit one tower
    c.pause();
    c.aimAt(3, 3); // select it
    expect(c.sellSelected()).toBe(true); // queues the sell — a pending sell
    // Mashing sellSelected again is a no-op (`enqueueVerdict` dedupes; the selection is
    // already gone by the first call's re-aim) — never a second (false) pending visual.
    expect(c.sellSelected()).toBe(false);
    expect(c.frame().pendingSells).toEqual([{ col: 3, row: 3 }]);
  });

  it('build → select → sell within one pause shows the correct (projected) refund', () => {
    const c = createController(1);
    c.pause();
    c.aimAt(3, 3);
    c.confirm(); // pending build, not committed
    const aim = c.aimAt(3, 3); // select the pending tower
    expect(aim.kind).toBe('tower');
    // The refund must be computed against the SHARED projection (the pending tower
    // exists there), not committed state (where it doesn't exist at all — zero refund).
    expect(c.refundForSelection()).toBeGreaterThan(0);
  });

  it('sell-then-rebuild works even when the sold tower is STILL PENDING (not yet committed) in this same pause (ship-review fix)', () => {
    const c = createController(1);
    c.pause();
    c.aimAt(3, 3);
    expect(c.confirm()).toBe(true); // pending build, not committed
    c.aimAt(3, 3); // select the pending tower
    expect(c.sellSelected()).toBe(true); // cancels the pending build — nets to empty
    expect(c.frame().pendingAdds).toEqual([]);
    expect(c.frame().pendingSells).toEqual([]); // never committed, so nothing to "hide" either
    const reaim = c.aimAt(3, 3);
    expect(reaim).toMatchObject({ kind: 'ghost', valid: true }); // buildable again
    expect(c.confirm()).toBe(true); // the rebuild must actually queue, not silently no-op
    expect(c.frame().pendingAdds).toEqual([{ col: 3, row: 3 }]);
    c.resume();
    tick(c);
    expect(c.frame().curVm.towers).toHaveLength(1); // the rebuild actually committed
    expect(c.frame().curVm.towers[0]).toMatchObject({ col: 3, row: 3 });
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
    expect(validate(replay, m1Ruleset).ok).toBe(true);
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

  it('placeTower is never anchor-deduped here — a same-anchor command still queues (ship-review fix)', () => {
    // A raw anchor scan can't distinguish a still-live pending build from one an
    // intervening sellTower in this same buffer already cancelled — deduping would
    // silently drop a legitimate sell-then-rebuild-while-still-pending. Real duplicate
    // prevention is `towerAt`'s job (reads the shared projection) — see
    // controller.test.ts's "sell-then-rebuild ... while still pending" test below.
    const buffer: SimInput[] = [{ kind: 'placeTower', anchor: { col: 3, row: 3 } }];
    expect(enqueueVerdict(buffer, { kind: 'placeTower', anchor: { col: 3, row: 3 } })).toBe(
      'queue',
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

describe('controller — outcomesMatch classifier (unit, #41)', () => {
  it('matches when score, stars, AND finalHash all agree', () => {
    const result = { score: 100, stars: 3, finalHash: 'abc' };
    expect(outcomesMatch(result, 100, 3, 'abc')).toBe(true);
  });

  it('does not match when finalHash differs even though score and stars agree', () => {
    const result = { score: 100, stars: 3, finalHash: 'abc' };
    expect(outcomesMatch(result, 100, 3, 'different')).toBe(false);
  });

  it('does not match when score or stars differ', () => {
    const result = { score: 100, stars: 3, finalHash: 'abc' };
    expect(outcomesMatch(result, 99, 3, 'abc')).toBe(false);
    expect(outcomesMatch(result, 100, 2, 'abc')).toBe(false);
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
    c.callWaveEarly();
    runToTerminal(c);
    expect(c.verifyRun().ok).toBe(true);
  });

  it('verifyRun() mid-run (non-terminal) reports a distinct not-terminal outcome, never a mismatch (#41)', () => {
    const c = createController(7);
    c.aimAt(3, 3);
    c.confirm();
    tick(c);
    const v = c.verifyRun();
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('not-terminal');
    expect(v.matchedLive).toBeUndefined(); // never a mismatch claim for a live match
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

describe('controller — impact-spark plumbing via StepEvents (#31)', () => {
  it('a run with no towers ever leaks creeps without ever producing a spark', () => {
    const c = createController(1);
    c.callWaveEarly();
    let sawSpark = false;
    let n = 0;
    while (!c.isTerminal() && n < 4000) {
      c.advance(TICK);
      if (c.drainSparks().length > 0) sawSpark = true;
      n++;
    }
    expect(c.isTerminal()).toBe(true);
    expect(sawSpark).toBe(false); // no tower ever fired — every leak is a non-event for sparks
  });

  it('a tower straddling the lane produces a well-formed spark once a shot lands, then clears', () => {
    const c = createController(1);
    // Mirrors @wynding/render's own combat-carrying fixture: a 2×2 tower straddling the
    // entrance row so the wave must pass through its range.
    c.aimAt(2, 10);
    c.confirm();
    c.callWaveEarly();
    let sparks: { x: number; y: number }[] = [];
    let n = 0;
    while (sparks.length === 0 && !c.isTerminal() && n < 300) {
      c.advance(TICK);
      sparks = c.drainSparks();
      n++;
    }
    expect(sparks.length).toBeGreaterThan(0);
    for (const pt of sparks) {
      expect(Number.isFinite(pt.x)).toBe(true);
      expect(Number.isFinite(pt.y)).toBe(true);
    }
    expect(c.drainSparks()).toEqual([]); // drained sparks are cleared, not re-reported
  });
});
