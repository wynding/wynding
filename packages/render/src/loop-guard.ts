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
// holds, each distinct error is logged once, and a failure that lasts stops the run (a paused run
// is only held). A step that failed once clears at Phaser's next good step, and the run carries
// on. Before READY, when Phaser's loop has not started, nothing is handed back until a READY
// that is overdue says it never will (below).
//
// A LOOP THAT HAS STOPPED. Each `check` is given Phaser's frame count (`Game#getFrame`). Phaser's
// `TimeStep` runs on animation frames and moves the count on every one, once the step (if any)
// has returned: an fps limit only skips steps, and only `forceSetTimeOut` would run the loop off
// timers instead; the renderer passes no `fps` config at all. So the count moves once per
// animation frame, the same frames the app's loop draws on, and the two stop together in a hidden
// tab: between two draws it moves once. It is first read at the first draw after READY, which can
// come before Phaser's first step (its loop starts on the next animation frame). After that, a
// count that stands still across a draw means a loop that has stopped, or never started;
// `LOOP_STALL_DRAWS` draws in a row is that, with a margin.
//
// A LOOP THAT NEVER STARTS. READY comes once Phaser has booted: its few built-in textures
// decoded, then its renderer's boot (`WebGLRenderer#boot`, on the textures' READY), then the game's
// READY listeners, Phaser's own (`SceneManager#bootQueue`, `ScaleManager#refresh`) ahead of ours. A
// throw in any of those is uncaught, ends the boot, and READY never reaches ours: Phaser's loop
// never starts and the board stays blank while the run plays on. So the draws before READY are
// counted, and `BOOT_STALL_DRAWS` of them is a READY that will not come. A READY that comes later
// all the same clears it, and the loop is watched from then on. That is the whole case: a loop
// that never started is reported, after about ten seconds of frames at 60 Hz, like one that stopped.
//
// AFTER `destroy`, Phaser's steps run bare: its next step is its teardown (`Game#destroy` only
// marks the game), and no draw is left to report a teardown that kept failing, frame after frame.

/** Draws in a row that may find Phaser's frame count where the draw before them left it before
 *  `check` reports its loop stopped. Between two draws the count moves once, so one such draw is
 *  already a stopped loop; three leave a margin and cost the player nothing: about 50 ms. */
export const LOOP_STALL_DRAWS = 3;

/** Draws before READY after which `check` reports that Phaser's loop never started. READY needs
 *  only Phaser's own boot, a few frames after mount; a boot that blocks the main thread (a cold
 *  software-WebGL shader compile on CI) holds the draws too, so only frames that came and went
 *  count. 600 are ten seconds of them at 60 Hz. */
export const BOOT_STALL_DRAWS = 600;

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
  /** The draws before READY, and the never-started failure once they pass `BOOT_STALL_DRAWS`. */
  let bootDraws = 0;
  let neverStarted: LoopFailure | null = null;

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
      if (!ready) {
        bootDraws += 1;
        if (bootDraws <= BOOT_STALL_DRAWS) return null;
        neverStarted ??= {
          error: new Error(
            `the board's renderer never started: Phaser's READY has not come in ` +
              `${String(BOOT_STALL_DRAWS)} frames, so nothing draws the board`,
          ),
        };
        return neverStarted;
      }
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
