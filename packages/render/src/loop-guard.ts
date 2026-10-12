// loop-guard.ts — keeping watch on Phaser's own frame loop (#195): a step of it that throws, a
// READY listener that throws, and a loop that has stopped stepping. Phaser-free: `scene.ts` runs
// Phaser's step and its READY listener through the guard, and every `draw()` asks it what, if
// anything, keeps the board from being drawn. Every decision is made here, under unit test.
//
// WHY. The board is drawn by two loops. The app's (`apps/web`'s `rafScheduler`) steps the sim and
// calls `draw()`, which only records: the live layers' commands and where each sprite sits.
// Phaser's own loop makes the pixels: on each animation frame its `Game#step` updates the scene
// and renders what `draw()` recorded. Phaser's animation-frame callback runs that step BEFORE it
// asks for the next frame, and nothing on the way to the render catches (`RequestAnimationFrame
// #step`, `Game#step`, Phaser 3.90.0), so one throw anywhere in a step used to end Phaser's loop
// for good: the board went blank behind a run that played on, and only the console knew.
//
// A THROW COSTS PHASER A FRAME, NOT ITS LOOP. `runStep` runs one step and records what it threw,
// never rethrowing it, so Phaser asks for its next frame and tries the next step. `runReady` does
// the same for the READY listener: Phaser emits READY and only then starts its loop
// (`Game#texturesReady`), so a throw out of the listener would leave the loop never started.
//
// WHAT CANNOT BE SHOWN IS A FAILED FRAME. `check` hands each draw what keeps the board from being
// drawn: the READY listener's failure, a loop that has stopped, or the failure of Phaser's last
// step, in that order. `draw()` throws it into the app's frame-failure policy (#191): the sim
// holds, each distinct error is logged once, and a failure that lasts stops the run. A step that
// failed once clears at Phaser's next good step, and the run carries on. Nothing is handed back
// before READY, when Phaser's loop has not started.
//
// A LOOP THAT HAS STOPPED. Each `check` is given Phaser's frame count (`Game#getFrame`), which its
// `TimeStep` moves once a step has returned. The renderer sets no fps limit and no
// `forceSetTimeOut`, so Phaser steps once per animation frame, on the same animation frames as the
// app's loop, and the two stop together in a hidden tab: between two draws Phaser steps once. The
// count is first read at the first draw after READY, which can come before Phaser's first step
// (its loop starts on the next animation frame). After that, a count that stands still across a
// draw means a loop that has stopped, or never started; `LOOP_STALL_DRAWS` draws in a row is that,
// with a margin.
//
// AFTER `destroy`, Phaser's steps run bare: its next step is its teardown (`Game#destroy` only
// marks the game), and no draw is left to report a teardown that kept failing, frame after frame.

/** Draws in a row that may find Phaser's frame count where the draw before them left it before
 *  `check` reports its loop stopped. Between two draws Phaser steps once, so one such draw is
 *  already a stopped loop; three leave a margin and cost the player nothing: about 50 ms. */
export const LOOP_STALL_DRAWS = 3;

/** What keeps the board from being drawn: a thrown value, which can be anything. */
export interface LoopFailure {
  readonly error: unknown;
}

export interface LoopGuard {
  /** Run one of Phaser's steps. What it throws is recorded for `check` and never rethrown, so
   *  Phaser's loop goes on to its next frame (until `destroy`). */
  runStep(step: () => void): void;
  /** Run the READY listener: Phaser's loop starts after it, and is watched from the next
   *  `check`. What it throws is recorded for `check` and never rethrown, so Phaser still starts
   *  its loop. */
  runReady(listener: () => void): void;
  /** Asked once by every draw, with Phaser's frame count: what keeps the board from being drawn
   *  this frame, or null when nothing does. */
  check(frame: number): LoopFailure | null;
  /** The renderer is going away: Phaser's steps run bare from now on. */
  destroy(): void;
}

export function createLoopGuard(): LoopGuard {
  let ready = false;
  let readyFailure: LoopFailure | null = null;
  /** Phaser's last step's failure, or null when it completed. */
  let stepFailure: LoopFailure | null = null;
  /** Phaser's frame count at the last draw after READY, and the draws in a row that found it
   *  there since. */
  let lastFrame: number | null = null;
  let stillDraws = 0;
  /** The stopped loop's failure, made once a stall is found and kept while it lasts. */
  let stall: LoopFailure | null = null;
  let destroyed = false;

  return {
    runStep(step) {
      if (destroyed) {
        step();
        return;
      }
      try {
        step();
        stepFailure = null;
      } catch (error) {
        stepFailure = { error };
      }
    },
    runReady(listener) {
      ready = true;
      try {
        listener();
      } catch (error) {
        readyFailure = { error };
      }
    },
    check(frame) {
      if (!ready) return null;
      if (frame === lastFrame) {
        stillDraws += 1;
      } else {
        lastFrame = frame;
        stillDraws = 0;
        stall = null;
      }
      if (readyFailure !== null) return readyFailure;
      if (stillDraws >= LOOP_STALL_DRAWS) {
        stall ??= {
          error: new Error(
            `the board's renderer has stopped: Phaser's frame count has stood at ${String(frame)} ` +
              `across ${String(LOOP_STALL_DRAWS)} frames, so nothing draws the board`,
          ),
        };
        return stall;
      }
      return stepFailure;
    },
    destroy() {
      destroyed = true;
    },
  };
}
