// loop-guard.test.ts — keeping watch on Phaser's own frame loop (#195), with the two loops modelled
// on shared animation frames: on each one the app draws (`check`, with Phaser's frame count), then
// Phaser steps (`runStep`), and its count moves once the step has returned, as its `TimeStep`
// counts it. A step that throws never escapes; what cannot be shown is handed to the draw: a
// one-off failure once, then cleared; a lasting one every draw; a READY listener's failure every
// draw, with Phaser's loop still started; and a loop that stops stepping, after its bound. Before
// READY, and across a hidden tab, nothing is.

import { describe, it, expect } from 'vitest';
import {
  BOOT_STALL_DRAWS,
  LOOP_STALL_DRAWS,
  createLoopGuard,
  type LoopFailure,
  type LoopGuard,
} from './loop-guard';

const ok = (): void => {};
const throwing =
  (error: unknown): (() => void) =>
  () => {
    throw error;
  };

/** Phaser's loop as `Game#start` runs it once its READY has fired: each step through the guard,
 *  then the frame count moves. A step that escaped the guard would throw out of `step()` here, as
 *  it would out of Phaser's animation-frame callback, which then never asks for another. */
function phaserLoop(guard: LoopGuard): {
  readonly frame: () => number;
  step: (body?: () => void) => void;
} {
  let frame = 0;
  return {
    frame: () => frame,
    step: (body = ok) => {
      guard.runStep(body);
      frame += 1;
    },
  };
}

/** A guard past READY whose listener completed, and Phaser's loop. */
function started(): { guard: LoopGuard; loop: ReturnType<typeof phaserLoop> } {
  const guard = createLoopGuard();
  guard.runReady(ok);
  return { guard, loop: phaserLoop(guard) };
}

/** One animation frame: the app's draw asks first, then Phaser steps `body`. What the draw was
 *  handed is returned. */
function animationFrame(
  guard: LoopGuard,
  loop: ReturnType<typeof phaserLoop>,
  body: () => void = ok,
): LoopFailure | null {
  const failure = guard.check(loop.frame());
  loop.step(body);
  return failure;
}

const stallMessage = (frame: number): string =>
  `the board's renderer has stopped: Phaser's frame count has stood at ${String(frame)} ` +
  `across ${String(LOOP_STALL_DRAWS)} frames, so nothing draws the board`;

describe('createLoopGuard — a step that throws', () => {
  it('is recorded, never rethrown: Phaser goes on to its next frame', () => {
    const { loop } = started();
    expect(() => loop.step(throwing(new Error('the render broke')))).not.toThrow();
    expect(loop.frame()).toBe(1);
  });

  it('once: the next draw is handed the original error, and the draw after a good step nothing', () => {
    const { guard, loop } = started();
    const broke = new TypeError("Cannot read properties of null (reading 'glTexture')");
    expect(animationFrame(guard, loop)).toBeNull();
    expect(animationFrame(guard, loop, throwing(broke))).toBeNull(); // the draw came first
    const handed = animationFrame(guard, loop); // Phaser's next step completes
    expect(handed?.error).toBe(broke); // the ORIGINAL error, not a wrapper
    for (let i = 0; i < 10; i++) expect(animationFrame(guard, loop)).toBeNull();
  });

  it('on every frame: every draw is handed the failure of the step before it', () => {
    const { guard, loop } = started();
    animationFrame(guard, loop, throwing(new Error('frame 0')));
    for (let i = 1; i <= 120; i++) {
      const handed = animationFrame(guard, loop, throwing(new Error(`frame ${String(i)}`)));
      expect((handed?.error as Error).message).toBe(`frame ${String(i - 1)}`);
    }
  });

  it('hands back a thrown value that is not an Error as itself, even undefined', () => {
    const { guard, loop } = started();
    loop.step(throwing(undefined));
    expect(guard.check(loop.frame())).toEqual({ error: undefined });
    loop.step(throwing('a string'));
    expect(guard.check(loop.frame())).toEqual({ error: 'a string' });
  });

  it('runs bare once destroyed: Phaser’s next step is its teardown, and nothing would report it', () => {
    const { guard, loop } = started();
    guard.destroy();
    const teardown = new Error('the teardown broke');
    expect(() => loop.step(throwing(teardown))).toThrow(teardown);
    let ran = false;
    guard.runStep(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('runs onFailure once for a step that threw, and not for one that completed', () => {
    const { guard } = started();
    let cleanups = 0;
    const onFailure = (): void => {
      cleanups += 1;
    };
    guard.runStep(ok, onFailure);
    expect(cleanups).toBe(0);
    guard.runStep(throwing(new Error('a step broke')), onFailure);
    expect(cleanups).toBe(1);
    guard.runStep(ok, onFailure);
    expect(cleanups).toBe(1);
  });

  it('contains a throw from onFailure: the step’s own error is still the one handed back', () => {
    const { guard } = started();
    const broke = new Error('a step broke');
    expect(() =>
      guard.runStep(throwing(broke), throwing(new Error('the clean-up broke'))),
    ).not.toThrow();
    expect(guard.check(0)).toEqual({ error: broke });
  });

  it('runs no onFailure once destroyed: the step runs bare', () => {
    const { guard } = started();
    guard.destroy();
    let cleanups = 0;
    expect(() =>
      guard.runStep(throwing(new Error('the teardown broke')), () => {
        cleanups += 1;
      }),
    ).toThrow();
    expect(cleanups).toBe(0);
  });
});

describe('createLoopGuard — a READY listener that throws', () => {
  it('is recorded, never rethrown, so Phaser still starts its loop; every draw is handed it', () => {
    const guard = createLoopGuard();
    const broke = new Error('the READY listener broke');
    // `Game#texturesReady`: READY's listeners, then `start`, which a throw would skip.
    let loopStarted = false;
    const texturesReady = (): void => {
      guard.runReady(throwing(broke));
      loopStarted = true;
    };
    expect(texturesReady).not.toThrow();
    expect(loopStarted).toBe(true);
    const loop = phaserLoop(guard);
    for (let i = 0; i < 120; i++) expect(animationFrame(guard, loop)?.error).toBe(broke);
  });

  it('is handed back before a stalled loop and a failed step', () => {
    const broke = new Error('the READY listener broke');
    const guard = createLoopGuard();
    guard.runReady(throwing(broke));
    guard.runStep(throwing(new Error('a step broke')));
    for (let i = 0; i <= LOOP_STALL_DRAWS + 2; i++) expect(guard.check(0)?.error).toBe(broke);
  });

  it('runs the listener, and a listener that completes leaves nothing to hand back', () => {
    const guard = createLoopGuard();
    let ran = false;
    guard.runReady(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    const loop = phaserLoop(guard);
    for (let i = 0; i < 10; i++) expect(animationFrame(guard, loop)).toBeNull();
  });
});

describe('createLoopGuard — a loop that has stopped', () => {
  it(`hands back the stopped error once the count stands still across ${String(LOOP_STALL_DRAWS)} draws, and not one draw before`, () => {
    const { guard, loop } = started();
    for (let i = 0; i < 5; i++) expect(animationFrame(guard, loop)).toBeNull();
    // Phaser's loop is gone: the draws go on, the count stands at 5.
    expect(guard.check(loop.frame())).toBeNull(); // Phaser stepped since the draw before
    for (let i = 1; i < LOOP_STALL_DRAWS; i++) expect(guard.check(loop.frame())).toBeNull();
    const handed = guard.check(loop.frame());
    expect(handed?.error).toBeInstanceOf(Error);
    expect((handed?.error as Error).message).toBe(stallMessage(5));
    // ...and on every draw while the stall lasts: the same failure, so it reads the same.
    for (let i = 0; i < 60; i++) expect(guard.check(loop.frame())).toBe(handed);
  });

  it('notices a loop that never started after READY', () => {
    const guard = createLoopGuard();
    guard.runReady(ok);
    for (let i = 0; i < LOOP_STALL_DRAWS; i++) expect(guard.check(0)).toBeNull();
    expect((guard.check(0)?.error as Error).message).toBe(stallMessage(0));
  });

  it('is handed back before a failed step: a loop that stopped after one is the news', () => {
    const { guard, loop } = started();
    animationFrame(guard, loop);
    loop.step(throwing(new Error('a step broke')));
    for (let i = 0; i < LOOP_STALL_DRAWS; i++) {
      expect((guard.check(loop.frame())?.error as Error).message).toBe('a step broke');
    }
    expect((guard.check(loop.frame())?.error as Error).message).toBe(stallMessage(2));
  });

  it('clears when the count moves again, and a later stall is a new one', () => {
    const { guard, loop } = started();
    animationFrame(guard, loop);
    for (let i = 0; i < LOOP_STALL_DRAWS; i++) guard.check(loop.frame());
    const first = guard.check(loop.frame());
    expect((first?.error as Error).message).toBe(stallMessage(1));
    loop.step(); // Phaser steps again
    for (let i = 0; i < 10; i++) expect(animationFrame(guard, loop)).toBeNull();
    const stoppedAt = loop.frame(); // and stops again
    for (let i = 0; i < LOOP_STALL_DRAWS; i++) guard.check(loop.frame());
    const second = guard.check(loop.frame());
    expect((second?.error as Error).message).toBe(stallMessage(stoppedAt));
    expect(second).not.toBe(first);
  });
});

describe('createLoopGuard — when nothing is handed back', () => {
  it('before READY, however long the count stands still, and READY then starts afresh', () => {
    const guard = createLoopGuard();
    for (let i = 0; i < 200; i++) expect(guard.check(0)).toBeNull();
    guard.runReady(ok);
    // The first draw after READY can come before Phaser's first step: it only reads the count.
    const loop = phaserLoop(guard);
    for (let i = 0; i < 200; i++) expect(animationFrame(guard, loop)).toBeNull();
  });

  // A hidden tab has no animation frames, so neither a draw nor a step, for as long as it lasts:
  // in this model, nothing is called. The draw that comes back finds the count the last step left.
  it('across a hidden tab: both loops stop together, and pick up together', () => {
    const { guard, loop } = started();
    for (let i = 0; i < 30; i++) expect(animationFrame(guard, loop)).toBeNull();
    // ...hidden...
    for (let i = 0; i < 30; i++) expect(animationFrame(guard, loop)).toBeNull();
  });

  it('across a hidden tab that falls between READY and Phaser’s first step', () => {
    const guard = createLoopGuard();
    guard.runReady(ok);
    const loop = phaserLoop(guard);
    // ...hidden before the first animation frame after READY; back, the draw comes first.
    for (let i = 0; i < 30; i++) expect(animationFrame(guard, loop)).toBeNull();
  });

  it('a step that failed just before the tab hid: the first draw back is handed it, the next nothing', () => {
    const { guard, loop } = started();
    animationFrame(guard, loop);
    const broke = new Error('the render broke');
    expect(animationFrame(guard, loop, throwing(broke))).toBeNull();
    // ...hidden...
    expect(animationFrame(guard, loop)?.error).toBe(broke);
    expect(animationFrame(guard, loop)).toBeNull();
  });
});

describe('createLoopGuard — a READY that never comes (#195 QC)', () => {
  // The kill test, written without the new constant so it runs unchanged against the PR's head:
  // a READY that never reaches the listener must reach a draw within ten seconds of frames.
  it('is handed to a draw within ten seconds of frames at 60 Hz', () => {
    const guard = createLoopGuard();
    let handed: LoopFailure | null = null;
    for (let i = 0; i <= 600 && handed === null; i++) handed = guard.check(0);
    expect(handed).not.toBeNull();
  });

  it(`is handed back after ${String(BOOT_STALL_DRAWS)} draws, not one before, and the same every draw`, () => {
    const guard = createLoopGuard();
    for (let i = 0; i < BOOT_STALL_DRAWS; i++) expect(guard.check(0)).toBeNull();
    const handed = guard.check(0);
    expect((handed?.error as Error).message).toBe(
      `the board's renderer never started: Phaser's READY has not come in ` +
        `${String(BOOT_STALL_DRAWS)} frames, so nothing draws the board`,
    );
    for (let i = 0; i < 60; i++) expect(guard.check(0)).toBe(handed);
  });

  it('holds the bounds the docs promise', () => {
    // "about 50 ms" for a stopped loop, "about 10 s at 60 Hz" for one that never started.
    expect(LOOP_STALL_DRAWS).toBe(3);
    expect(BOOT_STALL_DRAWS).toBe(600);
  });

  it('clears when READY comes late, and the loop is watched from then on', () => {
    const guard = createLoopGuard();
    for (let i = 0; i <= BOOT_STALL_DRAWS; i++) guard.check(0);
    guard.runReady(ok);
    const loop = phaserLoop(guard);
    for (let i = 0; i < 30; i++) expect(animationFrame(guard, loop)).toBeNull();
    // ...and a loop that then stops is still noticed.
    for (let i = 0; i < LOOP_STALL_DRAWS; i++) guard.check(loop.frame());
    expect((guard.check(loop.frame())?.error as Error).message).toMatch(/has stopped/);
  });
});

describe('createLoopGuard — whether only a new renderer can draw again (#195 Codex)', () => {
  it('not for a failing step, once or on every frame: Phaser’s loop goes on', () => {
    const { guard, loop } = started();
    animationFrame(guard, loop, throwing(new Error('once')));
    expect(guard.check(loop.frame())).not.toBeNull();
    expect(guard.needsRemount()).toBe(false);
    for (let i = 0; i < 60; i++) animationFrame(guard, loop, throwing(new Error('every frame')));
    expect(guard.check(loop.frame())).not.toBeNull();
    expect(guard.needsRemount()).toBe(false);
  });

  it(`once READY has not come in ${String(BOOT_STALL_DRAWS)} draws, not one before, until it comes late`, () => {
    const guard = createLoopGuard();
    for (let i = 0; i < BOOT_STALL_DRAWS; i++) {
      guard.check(0);
      expect(guard.needsRemount()).toBe(false);
    }
    guard.check(0);
    expect(guard.needsRemount()).toBe(true);
    guard.runReady(ok);
    expect(guard.needsRemount()).toBe(false);
  });

  it('once our READY listener failed, for good, however Phaser’s loop goes on', () => {
    const guard = createLoopGuard();
    guard.runReady(throwing(new Error('ready broke')));
    expect(guard.needsRemount()).toBe(true);
    const loop = phaserLoop(guard);
    for (let i = 0; i < 30; i++) animationFrame(guard, loop);
    expect(guard.needsRemount()).toBe(true);
  });

  it(`once the count stands still across ${String(LOOP_STALL_DRAWS)} draws, not one before, until it moves again`, () => {
    const { guard, loop } = started();
    for (let i = 0; i < 5; i++) animationFrame(guard, loop);
    guard.check(loop.frame()); // Phaser stepped since the draw before
    for (let i = 1; i < LOOP_STALL_DRAWS; i++) {
      guard.check(loop.frame());
      expect(guard.needsRemount()).toBe(false);
    }
    guard.check(loop.frame());
    expect(guard.needsRemount()).toBe(true);
    loop.step(); // Phaser steps again
    animationFrame(guard, loop);
    expect(guard.needsRemount()).toBe(false);
  });
});
